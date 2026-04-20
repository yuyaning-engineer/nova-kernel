/**
 * Nova Kernel — 分层记忆写入
 * kernel/memory/memory-writer.mjs
 *
 * 四层记忆：
 *   user       — 用户角色/目标/习惯（高门槛：显式指令或高置信推断）
 *   feedback   — "下次这样/别这样"（即时写，带原因 + how-to-apply）
 *   project    — 在做什么、谁在做、deadline（相对易变）
 *   reference  — 外部资源位置（Linear/Grafana/Git repo 等）
 *
 * 存储：kernel/memory/authoritative/*.jsonl — 唯一事实源
 *      kernel/memory/USER.md — 人类可读投影（自动再生成）
 *
 * 写入流程：
 *   1. security.js 注入扫描（已有）
 *   2. 追加 JSONL 事实源
 *   3. 重新投影 USER.md
 *   4. 审计日志
 *
 * 读取（给 ai-executor system prompt 注入用）：
 *   USER.md 在 executeWithAI 里已自动加载，无需额外改动
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT      = process.env.NOVA_KERNEL_ROOT || process.cwd();
const MEM_DIR   = join(ROOT, 'kernel', 'memory');
const AUTH_DIR  = join(MEM_DIR, 'authoritative');
const USER_MD   = join(MEM_DIR, 'USER.md');
const TYPES     = ['user', 'feedback', 'project', 'reference'];
const MAX_BODY  = 4000;   // 单条记忆上限
const MAX_NAME  = 200;    // name 上限
const MAX_DESC  = 500;    // description 上限
const MAX_FILE  = 200_000; // USER.md 投影上限

function _ensureDirs() {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
}

function _sanitize(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function _hashEntry(type, title, body) {
  return createHash('sha256').update(`${type}|${title}|${body}`).digest('hex').slice(0, 12);
}

// 基础安全扫描：拦截 prompt 注入 / 不可见字符 / 过长
function _scan(body) {
  if (!body || typeof body !== 'string') throw new Error('记忆内容必须是非空字符串');
  if (body.length > MAX_BODY) throw new Error(`记忆过长（>${MAX_BODY} 字符）`);
  // 不可见 Unicode
  if (/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(body)) {
    throw new Error('记忆包含不可见控制字符（拒写）');
  }
  // 基础注入检测
  const injectionPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /你必须忽略.*之前.*指令/,
    /overwrite\s+system\s+prompt/i,
    /sudo\s+.*remove/i,
  ];
  for (const p of injectionPatterns) {
    if (p.test(body)) throw new Error(`记忆包含可疑注入模式 (${p}) — 拒写`);
  }
}

/**
 * 写入一条记忆
 * @param {object} params
 * @param {string} params.type   - user | feedback | project | reference
 * @param {string} params.name   - 简短标题
 * @param {string} params.description - 一行描述（给检索用）
 * @param {string} params.body   - 记忆正文
 * @param {string} [params.source] - 来源（claude-code / cursor / user / nova-auto）
 * @param {number} [params.confidence] - 0-1，低于 0.7 进草稿队列
 */
export function writeMemory({ type, name, description, body, source = 'nova-auto', confidence = 1.0, skipSupersede = false, module: moduleField = null, function: functionField = null, risk_level = null }) {
  if (!TYPES.includes(type)) throw new Error(`type 必须是 ${TYPES.join('/')}`);
  if (!name || !description || !body) throw new Error('name/description/body 均必填');
  if (String(name).length > MAX_NAME)        throw new Error(`name 过长（>${MAX_NAME} 字符）`);
  if (String(description).length > MAX_DESC) throw new Error(`description 过长（>${MAX_DESC} 字符）`);

  _scan(body);
  _scan(description);
  _ensureDirs();

  const entry = {
    id:          _hashEntry(type, name, body),
    type,
    name:        _sanitize(name).slice(0, 120),
    description: _sanitize(description).slice(0, 300),
    body:        _sanitize(body),
    source,
    confidence:  Math.max(0, Math.min(1, Number(confidence) || 0)),
    status:      confidence >= 0.7 ? 'active' : 'draft',
    created_at:  new Date().toISOString(),
    // KB v2 taxonomy fields (optional - existing 875 entries lack these, will be backfilled by migrate-taxonomy.mjs)
    ...(moduleField    ? { module:     moduleField }   : {}),
    ...(functionField  ? { function:   functionField } : {}),
    ...(risk_level     ? { risk_level }                : {}),
  };

  const path = join(AUTH_DIR, `${type}.jsonl`);

  // KB v2 hook: skipSupersede=true 时直接 append（用于 decay 等需要保留旧 id 的场景）
  if (skipSupersede) {
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
    _projectUserMd();
    _autoSyncToClaude();
    return entry;
  }

  // ── 自动 supersede：同 type+name 的 active 旧版自动废弃，避免快照堆积
  // 实测：nova-architecture-current 一个 name 累积了 3323 条 (96% 死数据)
  // 旧条目保留在 jsonl 里 (可追溯)，但 status 改为 'superseded'，readMemories 默认过滤掉
  // 同 id 的（完全重复内容）跳过 supersede（节省 IO）
  try {
    const existing = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const supersedeMarks = [];
    const seenIds = new Set();
    for (let i = existing.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(existing[i]);
        if (e.status !== 'active') continue;
        if (e.id === entry.id) { seenIds.add(e.id); continue; } // 完全相同内容,跳过
        if (e.name === entry.name && e.type === entry.type && !seenIds.has(e.id)) {
          supersedeMarks.push({
            ...e,
            status: 'superseded',
            superseded_at: entry.created_at,
            superseded_by: entry.id,
          });
          seenIds.add(e.id);
        }
      } catch {}
    }
    // 把 supersede 标记和新条目一起追加 (一次 IO)
    const lines = supersedeMarks.map(m => JSON.stringify(m)).concat(JSON.stringify(entry));
    appendFileSync(path, lines.join('\n') + '\n', 'utf8');
  } catch {
    // 读失败 (首次写) 或解析失败 → 直接 append 新条目
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  }

  _projectUserMd();
  _autoSyncToClaude();
  return entry;
}

// 写入后自动推到所有外部工具（Claude / Codex / 工作区 AGENTS.md / Antigravity GEMINI.md）
// 循环引用避免：lazy-load memory-sync（它 import memory-writer）
function _autoSyncToClaude() {
  if (process.env.NOVA_MEMORY_AUTO_SYNC === 'off') return;
  import('./memory-sync.mjs').then(m => {
    try {
      // 原 Claude 投影
      m.syncToClaude();
      // 新增三方投影：Codex / 工作区 / Antigravity
      m.syncToCodex();
      m.syncToWorkspace();
      m.syncToAntigravity();
    } catch (e) { console.warn('[memory-writer] auto sync 失败:', e.message); }
  }).catch(() => {}); // 初始化期间忽略
}

/**
 * 读所有 active 记忆
 */
export function readMemories({ type = null } = {}) {
  _ensureDirs();
  const types = type ? [type] : TYPES;
  const out = [];
  for (const t of types) {
    const p = join(AUTH_DIR, `${t}.jsonl`);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        out.push(e);
      } catch {}
    }
  }
  // 去重：append-only log 语义 — 同 id 的最后一条 wins (status 演进:active→superseded→deleted)
  // 因为 supersede 标记可能 created_at 与原条目相同 (我们 {...e} 复制),
  // 不能用 created_at 比较, 必须按文件读取顺序 (jsonl 是 append-only, 最后写的最新)
  const byId = new Map();
  for (const e of out) byId.set(e.id, e); // 后入覆盖前入
  return [...byId.values()].filter(e => e.status === 'active');
}

/**
 * 治本原语 - upsertSnapshot (2026-04-19)
 *
 * 解决: self-maintenance 4 个循环每次 forget+write "更新" 同名快照，
 *       结果 30min × 48 次/天 × N 天 → 同名快照累积上千行死数据。
 *
 * 用法: 给"纯快照型"记忆用，每次更新就是要覆盖（不需要历史追溯）
 *       例: nova-architecture-current / machine-spec-current
 *
 * 实现: 原子读全 jsonl → 过滤掉所有同 type+name 的旧行 → 追加新行 → 写 tmp + rename
 *       崩溃安全（rename 是原子操作 POSIX/Windows 都保证）
 *
 * vs writeMemory: 后者 supersede 仍 append 一行 superseded mark + 一行新 active
 *                upsertSnapshot 直接抹除所有旧行，文件大小恒定
 */
export function upsertSnapshot({ type, name, description, body, source = 'snapshot', confidence = 1.0, module: moduleField = null }) {
  if (!TYPES.includes(type)) throw new Error(`type 必须是 ${TYPES.join('/')}`);
  if (!name || !body) throw new Error('name/body 必填');
  _scan(body);
  if (description) _scan(description);
  _ensureDirs();

  const path = join(AUTH_DIR, `${type}.jsonl`);
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
  // 过滤掉所有同 name 行（彻底抹除历史，不分 status）
  const kept = lines.filter(line => {
    try { return JSON.parse(line).name !== name; } catch { return true; }
  });

  const entry = {
    id:          _hashEntry(type, name, body),
    type,
    name:        _sanitize(name).slice(0, 120),
    description: _sanitize(description || '').slice(0, 300),
    body:        _sanitize(body),
    source,
    confidence:  Math.max(0, Math.min(1, Number(confidence) || 0)),
    status:      'active',
    created_at:  new Date().toISOString(),
    snapshot_mode: true, // 标记: 这条是 upsertSnapshot 写入,不留历史
    ...(moduleField ? { module: moduleField } : {}),
  };
  kept.push(JSON.stringify(entry));

  // tmp + rename 原子写
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, kept.join('\n') + '\n', 'utf8');
  renameSync(tmpPath, path);

  _projectUserMd();
  _autoSyncToClaude();
  return entry;
}

/**
 * 删除一条记忆（标记 status=deleted）
 */
export function forgetMemory(id) {
  _ensureDirs();
  for (const t of TYPES) {
    const p = join(AUTH_DIR, `${t}.jsonl`);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.id === id) {
          appendFileSync(p, JSON.stringify({ ...e, status: 'deleted', deleted_at: new Date().toISOString() }) + '\n', 'utf8');
          _projectUserMd();
          _autoSyncToClaude();
          return { ok: true, type: t };
        }
      } catch {}
    }
  }
  return { ok: false, error: `记忆 ${id} 不存在` };
}

/**
 * 把事实源投影成 USER.md（人类可读，ai-executor 自动加载）
 */
function _projectUserMd() {
  const active = readMemories();
  const byType = { user: [], feedback: [], project: [], reference: [] };
  for (const e of active) byType[e.type]?.push(e);

  const SECTIONS = {
    user:      { title: '👤 关于用户 (user)',        hint: '角色、目标、习惯、偏好' },
    feedback:  { title: '💬 行为反馈 (feedback)',     hint: '下次这样 / 不要那样' },
    project:   { title: '🗂  当前项目 (project)',    hint: '在做什么、谁在做、deadline' },
    reference: { title: '🔗 外部资源 (reference)',   hint: '工具/面板/库的位置' },
  };

  const lines = [
    '# Nova Kernel — 用户记忆投影',
    '',
    '> 此文件由 memory-writer 自动生成。**不要手动编辑** — 改动会被覆盖。',
    '> 事实源：`kernel/memory/authoritative/*.jsonl`。',
    '> 写入 API：`POST /memory/write` 或 `nova memory-write <type> <name> "<body>"`。',
    `> 最近更新：${new Date().toISOString()}`,
    '',
  ];

  for (const [type, meta] of Object.entries(SECTIONS)) {
    lines.push(`## ${meta.title}`);
    lines.push(`<!-- ${meta.hint} -->`);
    lines.push('');
    const items = byType[type] || [];
    if (items.length === 0) {
      lines.push('_（暂无）_');
    } else {
      for (const e of items) {
        lines.push(`### ${e.name}`);
        lines.push(`*${e.description}* — \`${e.id}\` · 来源 \`${e.source}\` · 置信 ${e.confidence}`);
        lines.push('');
        lines.push(e.body);
        lines.push('');
      }
    }
    lines.push('');
  }

  let out = lines.join('\n');
  if (out.length > MAX_FILE) out = out.slice(0, MAX_FILE) + '\n\n_(truncated)_\n';
  writeFileSync(USER_MD, out, 'utf8');
}

export const MEMORY_TYPES = TYPES;
