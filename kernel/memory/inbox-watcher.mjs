/**
 * Nova Kernel — Inbox Watcher（反向同步收件箱）
 * kernel/memory/inbox-watcher.mjs
 *
 * 场景：Antigravity IDE Agent / Codex CLI / 其他工具在 D:/claude/nova-inbox/ 下
 *       创建 .md 文件（带 frontmatter 声明 type/name/description），
 *       Nova 自动吸收为记忆，并把原文件归档到 _consumed/。
 *
 * 这是"反向同步"的关键通道 —— 让外部 AI 的学习能流回 Nova 事实源。
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync, statSync, watch } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
// inbox 位置：默认在工作区根（D:/claude/nova-inbox），可被环境变量覆盖
const WORKSPACE_ROOT = process.env.NOVA_WORKSPACE_ROOT || resolve(ROOT, '..');
const DEFAULT_INBOX = process.env.NOVA_INBOX_DIR || join(WORKSPACE_ROOT, 'nova-inbox');
const CONSUMED_SUBDIR = '_consumed';

let _watcher = null;
// per-file debounce（修 Codex bug #1：全局 timer 会丢并发事件）
const _fileDebounceTimers = new Map(); // filename → setTimeout handle
const DEBOUNCE_MS = 1500;
// 处理中的文件集合（防止 rename 时又触发）
const _processing = new Set();

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

// Partial-write 防护（Gemini 指出）：大文件分块刷盘时 watcher 可能读到一半
// 策略：文件 size 连续 500ms 没变才算写入完成
async function _waitForStableSize(filepath, { checks = 3, intervalMs = 250, maxWaitMs = 5000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let last = -1, stable = 0;
  while (Date.now() < deadline) {
    try {
      const cur = statSync(filepath).size;
      if (cur === last) stable++;
      else { stable = 1; last = cur; }
      if (stable >= checks) return { ok: true, size: cur };
    } catch { return { ok: false, reason: 'stat_failed' }; }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ok: false, reason: 'timeout_unstable', last_size: last };
}

async function _ingestOne(inboxDir, filename) {
  const full = join(inboxDir, filename);
  if (_processing.has(full)) return { skipped: true, reason: 'processing' };
  _processing.add(full);
  try {
    if (!existsSync(full) || !statSync(full).isFile()) return { skipped: true };
    if (!filename.endsWith('.md') || filename === 'README.md') return { skipped: true };

    // 等写入稳定（防 partial-write 污染）
    const stable = await _waitForStableSize(full);
    if (!stable.ok) {
      console.warn(`[inbox] ${filename}: 写入不稳定（${stable.reason}），跳过本次，等下次 watcher 事件`);
      return { skipped: true, reason: stable.reason };
    }

    const raw = readFileSync(full, 'utf8');
    const { meta, body } = _parseFrontmatter(raw);
    if (!meta.type || !['user', 'feedback', 'project', 'reference'].includes(meta.type)) {
      console.warn(`[inbox] ${filename}: type 非法或缺失（要 user/feedback/project/reference），跳过`);
      return { skipped: true, reason: 'bad_type' };
    }
    if (!body.trim()) {
      console.warn(`[inbox] ${filename}: body 为空，跳过`);
      return { skipped: true, reason: 'empty_body' };
    }

    const { writeMemory } = await import('./memory-writer.mjs');
    const entry = writeMemory({
      type:        meta.type,
      name:        meta.name || filename.replace(/\.md$/, ''),
      description: meta.description || `来自 inbox: ${filename}`,
      body:        body.trim(),
      source:      meta.source || 'inbox',
      confidence:  meta.confidence ? parseFloat(meta.confidence) : 0.85,
    });

    // 归档：移到 _consumed/<timestamp>_<filename>
    // 修 Codex bug #2：归档失败不能静默，否则下次重复吸收
    const consumedDir = join(inboxDir, CONSUMED_SUBDIR);
    if (!existsSync(consumedDir)) mkdirSync(consumedDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = join(consumedDir, `${stamp}_${filename}`);
    let archived = false;
    try { renameSync(full, archivePath); archived = true; }
    catch (renameErr) {
      console.error(`[inbox] ⚠️ ${filename} 已吸收但归档失败（${renameErr.message}）— 源文件仍在 inbox，可能重复吸收！请手动处理`);
      // 即使归档失败记忆已落地，不 rollback；但标记不 ok 让调用方知情
      return { ok: true, entry, archived: false, warn: 'archive_failed', archivePath, renameErr: renameErr.message };
    }

    console.log(`[inbox] ✅ 吸收 ${filename} → ${meta.type}/${entry.name} (id=${entry.id.slice(0,8)})`);
    return { ok: true, entry, archived: archivePath };
  } catch (e) {
    console.warn(`[inbox] ${filename} 吸收失败:`, e.message);
    return { ok: false, error: e.message };
  } finally {
    _processing.delete(full);
  }
}

async function _scanInbox(inboxDir) {
  if (!existsSync(inboxDir)) return { scanned: 0 };
  try {
    const files = readdirSync(inboxDir).filter(f => f.endsWith('.md') && f !== 'README.md');
    let ingested = 0;
    for (const f of files) {
      const r = await _ingestOne(inboxDir, f);
      if (r.ok) ingested++;
    }
    return { scanned: files.length, ingested };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 启动 inbox 监听（内核启动时调用）
 */
export function startInboxWatcher(inboxDir = DEFAULT_INBOX) {
  if (process.env.NOVA_INBOX_WATCHER === 'off') {
    console.log('[inbox] 禁用（NOVA_INBOX_WATCHER=off）');
    return;
  }
  // 确保目录存在
  if (!existsSync(inboxDir)) {
    try { mkdirSync(inboxDir, { recursive: true }); }
    catch (e) { console.warn('[inbox] 无法创建目录:', e.message); return; }
  }

  // 启动时扫一遍（吸收已有文件）
  _scanInbox(inboxDir).then(r => {
    if (r.ingested > 0) console.log(`[inbox] 启动时吸收 ${r.ingested} 条记忆 from ${inboxDir}`);
  });

  try {
    _watcher = watch(inboxDir, { persistent: false }, (event, filename) => {
      if (!filename || !filename.endsWith('.md') || filename === 'README.md') return;
      // 修 Codex bug #1：per-file debounce（每个文件独立 timer，不会互相干掉）
      const prev = _fileDebounceTimers.get(filename);
      if (prev) clearTimeout(prev);
      const handle = setTimeout(() => {
        _fileDebounceTimers.delete(filename);
        _ingestOne(inboxDir, filename).catch(e => console.warn('[inbox] 处理失败:', e.message));
      }, DEBOUNCE_MS);
      _fileDebounceTimers.set(filename, handle);
    });
    console.log(`[inbox] 监听启动: ${inboxDir}（Antigravity/Codex 可在此写记忆回 Nova）`);
  } catch (e) {
    console.warn('[inbox] watcher 启动失败:', e.message);
  }
}

export function stopInboxWatcher() {
  if (_watcher) { try { _watcher.close(); } catch {} _watcher = null; }
  for (const t of _fileDebounceTimers.values()) clearTimeout(t);
  _fileDebounceTimers.clear();
}

// 手动触发（HTTP endpoint 用）
export async function scanInboxNow(inboxDir = DEFAULT_INBOX) {
  return _scanInbox(inboxDir);
}

export { DEFAULT_INBOX };
