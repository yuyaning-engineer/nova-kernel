/**
 * Nova Kernel — Claude Code ↔ Nova 记忆双向桥
 * kernel/memory/memory-sync.mjs
 *
 * 位置映射：
 *   Claude 端: C:\Users\<user>\.claude\projects\<proj>\memory\
 *     ├── MEMORY.md (索引)
 *     └── <name>.md (frontmatter: name/description/type + body)
 *
 *   Nova 端:  kernel/memory/authoritative/*.jsonl
 *             kernel/memory/USER.md (投影)
 *
 * 语义：
 *   Nova 是唯一事实源（authoritative/）。Claude 目录和 USER.md 都是投影。
 *   双向同步 = "拉 Claude 进来" + "把 Nova 推回 Claude"。
 *
 * 使用：
 *   syncFromClaude()   — Claude → Nova: 解析 Claude md 文件，写入 authoritative/
 *   syncToClaude()     — Nova   → Claude: 从 authoritative/ 重建 Claude md 文件
 *   syncBidirectional()— 双向并调，默认行为
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
  statSync, rmSync, watch, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { writeMemory, readMemories, MEMORY_TYPES } from './memory-writer.mjs';

const ROOT        = process.env.NOVA_KERNEL_ROOT || process.cwd();
// Claude Code 的记忆目录约定：每个 cwd 对应一个 projects/<cwd-slug>/memory/
// cwd-slug：盘符:\path\to\dir 变换为 D--path-to-dir（Windows）
function _claudeMemDirFor(cwd) {
  const slug = cwd.replace(/:/g, '-').replace(/[\\/]/g, '-').replace(/^-+/, '');
  return join(homedir(), '.claude', 'projects', slug, 'memory');
}

// 默认映射：Nova 在 D:\claude\nova-commerce-edition，所以其对应的
// Claude 记忆目录是 ~\.claude\projects\D--claude\memory（D:\claude 的 slug）
// 支持通过 NOVA_CLAUDE_MEMORY_DIR 环境变量覆盖
const DEFAULT_CLAUDE_MEM = process.env.NOVA_CLAUDE_MEMORY_DIR || _claudeMemDirFor('D:\\claude');

// 三方闭环：其他 AI 工具读什么文件？
//   - Codex CLI 全局：~/.codex/AGENTS.md （Codex 启动时读作 system instructions）
//   - 工作区 AGENTS.md：D:/claude/AGENTS.md （AGENTS.md 已是 AI 工具业界约定，Codex/Cursor/Continue 等都读）
//   - Antigravity 工作区 GEMINI.md：D:/claude/GEMINI.md （Antigravity 的 Gemini agent 读）
const CODEX_GLOBAL_AGENTS = process.env.NOVA_CODEX_AGENTS_PATH ||
  join(homedir(), '.codex', 'AGENTS.md');
const WORKSPACE_ROOT = process.env.NOVA_WORKSPACE_ROOT ||
  (ROOT.endsWith('nova-commerce-edition') ? ROOT.slice(0, ROOT.length - 'nova-commerce-edition'.length - 1) : ROOT);
const WORKSPACE_AGENTS = join(WORKSPACE_ROOT, 'AGENTS.md');
const WORKSPACE_GEMINI = join(WORKSPACE_ROOT, 'GEMINI.md');

// ─── Claude md frontmatter 解析 ───────────────────────────────────────────

function _parseFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const fmBlock = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const meta = {};
  for (const line of fmBlock.split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) meta[k] = v;
  }
  return { meta, body };
}

function _writeFrontmatter({ name, description, type, body }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `type: ${type}`,
    'managed_by: nova-memory-sync',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

/**
 * 安全检查: 投影文件是否带 managed_by: nova-memory-sync 标记.
 * 用于 syncToClaude 孤儿清理 — 没标记的不删 (用户手写笔记/外部工具写入).
 */
function _isManagedProjection(fullPath) {
  try {
    const raw = readFileSync(fullPath, 'utf8');
    const { meta } = _parseFrontmatter(raw);
    return meta.managed_by === 'nova-memory-sync';
  } catch { return false; }
}

function _safeFileName(name) {
  return String(name || 'memory')
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'memory';
}

// ─── Claude → Nova ────────────────────────────────────────────────────────

/**
 * 从 Claude 记忆目录拉取所有 md 文件，写入 Nova authoritative/
 * @param {string} [claudeDir]
 * @returns {{ imported: number, skipped: number, errors: string[] }}
 */
export function syncFromClaude(claudeDir = DEFAULT_CLAUDE_MEM) {
  if (!existsSync(claudeDir)) {
    return { imported: 0, skipped: 0, errors: [`Claude 记忆目录不存在：${claudeDir}（尚未建立，无需同步）`] };
  }
  // 互斥：如果已有同步在跑，直接返回空结果避免递归
  if (_syncInProgress) {
    return { imported: 0, skipped: 0, errors: ['已有同步在跑，跳过'], skipped_due_to_lock: true };
  }
  _syncInProgress = true;
  try {
  const files = readdirSync(claudeDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  let imported = 0, skipped = 0;
  const errors = [];
  for (const f of files) {
    try {
      const full = join(claudeDir, f);
      if (!statSync(full).isFile()) continue;
      const raw = readFileSync(full, 'utf8');
      const { meta, body } = _parseFrontmatter(raw);
      // 防回灌: managed_by 标记的是 Nova 自己投影出的, 不要再读回去 (会无限膨胀)
      if (meta.managed_by === 'nova-memory-sync') {
        skipped++;
        continue;
      }
      if (!meta.type || !MEMORY_TYPES.includes(meta.type)) {
        errors.push(`${f}: 缺少 type 或 type 非法（${meta.type}）`);
        skipped++;
        continue;
      }
      if (!body.trim()) { skipped++; continue; }
      writeMemory({
        type:        meta.type,
        name:        meta.name || f.replace(/\.md$/, ''),
        description: meta.description || f,
        body:        body.trim(),
        source:      'claude-code',
        confidence:  1.0,
      });
      imported++;
    } catch (e) {
      errors.push(`${f}: ${e.message}`);
      skipped++;
    }
  }
  return { imported, skipped, errors, claudeDir };
  } finally {
    _syncInProgress = false;
  }
}

// ─── Nova → Claude ────────────────────────────────────────────────────────

/**
 * 把 Nova 所有 active 记忆推到 Claude 记忆目录，重建 MEMORY.md 索引
 * @param {string} [claudeDir]
 * @returns {{ written: number, dir: string }}
 */
export function syncToClaude(claudeDir = DEFAULT_CLAUDE_MEM) {
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  _lastLocalWriteAt = Date.now(); // 打点防回声

  const all = readMemories();
  // 只推送 nova 端非 claude-code 来源的（避免回声：claude-code 来的不回写）
  const toWrite = all.filter(e => e.source !== 'claude-code');

  const indexLines = ['# Claude Code 记忆索引', '', '> 由 Nova memory-sync 投影。Nova 是事实源。', ''];
  const typeTitle = {
    user: '👤 User', feedback: '💬 Feedback', project: '🗂 Project', reference: '🔗 Reference',
  };
  const byType = {};
  for (const e of toWrite) (byType[e.type] ||= []).push(e);

  // 治本 (2026-04-19): 收集本次应存在的文件名集合, 之后清理孤儿
  // 之前 bug: forgetMemory 删 jsonl 但孤儿 .md 留下 → watcher 重新吸收回 active.
  // 注意: validFiles 包含所有 active 条目 (含 claude-code 来源), 避免把 Claude 端
  //       自己写的文件误删. 只 WRITE 非 claude-code 来源以防回声.
  const validFiles = new Set(['MEMORY.md']);
  for (const e of all) {
    validFiles.add(`${e.type}_${_safeFileName(e.name)}.md`);
  }

  let written = 0;
  for (const [type, entries] of Object.entries(byType)) {
    indexLines.push(`## ${typeTitle[type] || type}`);
    for (const e of entries) {
      const fname = `${type}_${_safeFileName(e.name)}.md`;
      const full = join(claudeDir, fname);
      writeFileSync(full, _writeFrontmatter({
        name:        e.name,
        description: e.description,
        type:        e.type,
        body:        e.body,
      }), 'utf8');
      indexLines.push(`- [${e.name}](${fname}) — ${e.description}`);
      written++;
    }
    indexLines.push('');
  }

  writeFileSync(join(claudeDir, 'MEMORY.md'), indexLines.join('\n'), 'utf8');

  // 清理孤儿 .md 文件 (jsonl 已删但投影还在的)
  // 安全约束: 只删带 managed_by: nova-memory-sync 标记的, 用户手写笔记不动.
  let orphaned = 0;
  try {
    for (const f of readdirSync(claudeDir)) {
      if (!f.endsWith('.md')) continue;
      if (f === 'MEMORY.md') continue;
      if (validFiles.has(f)) continue;
      const full = join(claudeDir, f);
      try {
        if (!statSync(full).isFile()) continue;
        if (!_isManagedProjection(full)) continue;  // 用户手写不删
        unlinkSync(full);
        orphaned++;
      } catch {}
    }
  } catch {}

  return { ok: true, written, orphaned, dir: claudeDir };
}

// ─── 三方闭环：Codex / 工作区 AGENTS / Antigravity GEMINI ──────────────────

// 把 Nova 记忆渲染成一个 Markdown 文件（供 AGENTS.md / GEMINI.md / CODEX AGENTS 共用格式）
function _renderAsUnifiedContext(active, { audience = 'agent' } = {}) {
  const byType = { user: [], feedback: [], project: [], reference: [] };
  for (const e of active) byType[e.type]?.push(e);

  const who = audience === 'codex'
    ? '你是 Codex CLI，被 Nova Kernel 派来执行代码任务。'
    : audience === 'antigravity'
    ? '你是 Antigravity IDE 里的 Gemini Agent。在 D:\\claude 工作区工作时，Nova Kernel 是事实源。'
    : '你是在 D:\\claude 工作区工作的 AI agent（Claude Code / Cursor / Codex / Antigravity 之一）。';

  const lines = [
    '# 跨 AI 共享上下文（Nova Kernel 自动生成，请勿手动编辑）',
    '',
    `> ${who}`,
    '> 本文件由 Nova Kernel 的 memory-sync 定期刷新。事实源：`kernel/memory/authoritative/*.jsonl`。',
    `> 最近更新：${new Date().toISOString()}`,
    '',
    '## 👤 关于用户 (user)',
    ...(byType.user.length ? byType.user.map(e => `- **${e.name}**：${e.body}`) : ['_（暂无）_']),
    '',
    '## 💬 用户偏好 · 必须遵守 (feedback)',
    ...(byType.feedback.length ? byType.feedback.map(e => `- **${e.name}**：${e.body}`) : ['_（暂无）_']),
    '',
    '## 🗂  当前项目 (project)',
    ...(byType.project.length ? byType.project.map(e => `- **${e.name}**：${e.body.slice(0, 300)}${e.body.length > 300 ? '…' : ''}`) : ['_（暂无）_']),
    '',
    '## 🔗 外部资源 (reference)',
    ...(byType.reference.length ? byType.reference.map(e => `- **${e.name}**：${e.body}`) : ['_（暂无）_']),
    '',
    '## 🧭 Nova Kernel 本身',
    '- HTTP API：http://127.0.0.1:3700（Authorization: Bearer <token>，见 .env NOVA_INTERNAL_TOKEN）',
    '- 你可以通过 Nova MCP 工具主动查/写记忆（`nova_memory_list` / `nova_memory_write`）',
    '- Driver 总负责人是 Claude Code 会话',
    '',
    '## 🔁 反向同步：你学到了新东西，请贡献回 Nova',
    '',
    '当你（任何 AI）在任务中学到值得沉淀的事实时，**请把它写回 Nova**，这样其他 AI 下次都能看到：',
    '',
    audience === 'codex'
      ? '- **推荐**：通过 MCP 直接调 `nova_memory_write({type, name, description, body})`（已注册给你）'
      : '- **推荐**：通过 Nova MCP 工具 `nova_memory_write` 写入',
    `- **备选**：在 \`${WORKSPACE_ROOT}/nova-inbox/\` 目录创建 .md 文件（带 frontmatter type/name/description），Nova watcher 会在 1.5 秒内自动吸收`,
    '',
    '值得写回的场景：',
    '- **user**：用户透露的新身份/目标/能力（仅确认过的）',
    '- **feedback**：用户明确说"以后这样/别这样"（带 Why + How to apply）',
    '- **project**：项目新进展、deadline、关键决策',
    '- **reference**：外部资源位置（新文档、面板、仓库）',
    '',
    '**不要**写：每次对话的记录（记忆是事实源不是日志）、未确认的猜测、PII。',
    '',
  ];
  return lines.join('\n');
}

/**
 * 把 Nova 记忆投影到 Codex 全局 AGENTS.md (~/.codex/AGENTS.md)
 * Codex CLI 启动时会读这个文件作为 system instructions。
 */
export function syncToCodex() {
  _lastLocalWriteAt = Date.now();
  const dir = join(homedir(), '.codex');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const active = readMemories();
  const content = _renderAsUnifiedContext(active, { audience: 'codex' });
  writeFileSync(CODEX_GLOBAL_AGENTS, content, 'utf8');
  return { ok: true, path: CODEX_GLOBAL_AGENTS, size: content.length, entries: active.length };
}

/**
 * 把 Nova 记忆投影到工作区级 AGENTS.md（跨工具通用约定）
 * 路径：D:/claude/AGENTS.md（工作区根，被 Codex/Cursor/Continue/等 AI 工具识别）
 */
export function syncToWorkspace() {
  _lastLocalWriteAt = Date.now();
  const active = readMemories();
  const content = _renderAsUnifiedContext(active, { audience: 'workspace' });
  writeFileSync(WORKSPACE_AGENTS, content, 'utf8');
  return { ok: true, path: WORKSPACE_AGENTS, size: content.length, entries: active.length };
}

/**
 * 把 Nova 记忆投影到工作区 GEMINI.md（Antigravity 读）
 */
export function syncToAntigravity() {
  _lastLocalWriteAt = Date.now();
  const active = readMemories();
  const content = _renderAsUnifiedContext(active, { audience: 'antigravity' });
  writeFileSync(WORKSPACE_GEMINI, content, 'utf8');
  return { ok: true, path: WORKSPACE_GEMINI, size: content.length, entries: active.length };
}

/**
 * 一次性投影到所有外部工具
 */
export function syncToAll() {
  const results = {};
  for (const [name, fn] of [
    ['claude',      () => syncToClaude()],
    ['codex',       () => syncToCodex()],
    ['workspace',   () => syncToWorkspace()],
    ['antigravity', () => syncToAntigravity()],
  ]) {
    try { results[name] = fn(); }
    catch (e) { results[name] = { ok: false, error: e.message }; }
  }
  return { ok: true, results, ts: new Date().toISOString() };
}

// ─── 双向 ─────────────────────────────────────────────────────────────────

export function syncBidirectional(claudeDir = DEFAULT_CLAUDE_MEM) {
  const fromResult = syncFromClaude(claudeDir);
  const toResult   = syncToClaude(claudeDir);
  // 三方闭环：顺手投影到其他工具
  const allResult = syncToAll();
  return {
    ok: true,
    claude_to_nova: fromResult,
    nova_to_claude: toResult,
    nova_to_all:    allResult,
    ts: new Date().toISOString(),
  };
}

// ─── 自动同步：启动时拉一次 + 监听 Claude 目录变化 ────────────────────────

let _watcher = null;
let _debounceTimer = null;
const DEBOUNCE_MS = 1500;
// 避免自己触发自己：最近一次 syncToClaude 写入后的短窗口内忽略 Claude 目录变化
let _lastLocalWriteAt = 0;
const LOCAL_WRITE_ECHO_MS = 3000;
// 全局同步互斥锁：防止多路径（watcher / auto-sync / manual / HTTP）同时同步导致数据分叉
let _syncInProgress = false;

/**
 * 启动时调用：一次性拉取 Claude 现有记忆 + 启动文件监听
 * @param {string} [claudeDir]
 */
export function startAutoSync(claudeDir = DEFAULT_CLAUDE_MEM) {
  if (process.env.NOVA_MEMORY_AUTO_SYNC === 'off') {
    console.log('[memory-sync] 自动同步已禁用 (NOVA_MEMORY_AUTO_SYNC=off)');
    return;
  }

  // 1. 启动时拉一次
  try {
    const r = syncFromClaude(claudeDir);
    if (r.imported > 0) {
      console.log(`[memory-sync] 启动时从 Claude 拉取 ${r.imported} 条记忆`);
    } else if (r.errors.length > 0 && !r.errors[0].includes('不存在')) {
      console.warn(`[memory-sync] 启动同步告警: ${r.errors[0]}`);
    }
  } catch (e) {
    console.warn('[memory-sync] 启动拉取失败:', e.message);
  }

  // 1.5. 启动时把最新记忆投影到所有外部工具（Codex/工作区 AGENTS.md/Antigravity GEMINI.md）
  try {
    const r = syncToAll();
    const summary = Object.entries(r.results).map(([k, v]) => `${k}=${v.ok ? 'ok' : 'fail'}`).join(' ');
    console.log(`[memory-sync] 启动时投影到所有工具：${summary}`);
  } catch (e) {
    console.warn('[memory-sync] 启动投影失败:', e.message);
  }

  // 2. 监听 Claude 目录变化
  // 如果目录不存在，先创建（Claude Code 下次写入就会命中）
  if (!existsSync(claudeDir)) {
    try { mkdirSync(claudeDir, { recursive: true }); } catch {}
  }

  try {
    _watcher = watch(claudeDir, { persistent: false }, (event, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      if (filename === 'MEMORY.md') return; // 索引文件不是记忆
      // Nova 自己刚写过，忽略回声
      if (Date.now() - _lastLocalWriteAt < LOCAL_WRITE_ECHO_MS) return;

      clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        try {
          const r = syncFromClaude(claudeDir);
          if (r.imported > 0) {
            console.log(`[memory-sync] 检测到 Claude 目录变化，已吸收 ${r.imported} 条记忆`);
          }
        } catch (e) {
          console.warn('[memory-sync] 增量拉取失败:', e.message);
        }
      }, DEBOUNCE_MS);
    });
    console.log(`[memory-sync] 监听已启动: ${claudeDir}`);
  } catch (e) {
    console.warn('[memory-sync] 启动 watcher 失败:', e.message);
  }
}

export function stopAutoSync() {
  if (_watcher) { try { _watcher.close(); } catch {} _watcher = null; }
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
}

export { DEFAULT_CLAUDE_MEM };
