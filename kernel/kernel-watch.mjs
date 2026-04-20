/**
 * Kernel Self-Smoke-Test
 * 监听 kernel/ 下 .mjs / .js 改动 → debounce 5s → 跑 node --check
 * 失败 → 写 feedback 记忆 + audit 告警 (不回滚, 但下次 Driver 进 session 时 feedback 注入会看到)
 *
 * 历史背景: 2026-04-19 Codex 改 ai-executor.mjs 时引入 4 处 bug
 *   (中文注释吞换行 + 函数重复声明), kernel 一周后才发现.
 *   有这个机制就能 5s 内告警.
 */
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const KERNEL_DIR = join(ROOT, 'kernel');
const WATCH_EXTS = new Set(['.mjs', '.js']);
const DEBOUNCE_MS = 5000;
const NODE_BIN = process.execPath;

let _watcher = null;
let _pending = new Map(); // file -> timer
let _enabled = false;

function _checkSyntax(file) {
  return new Promise(resolve => {
    const p = spawn(NODE_BIN, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString('utf8'); });
    p.on('close', code => resolve({ ok: code === 0, stderr: stderr.trim() }));
    p.on('error', err => resolve({ ok: false, stderr: err.message }));
  });
}

async function _onChange(filename) {
  if (!filename) return;
  if (!WATCH_EXTS.has(filename.slice(filename.lastIndexOf('.')))) return;
  if (filename.includes('node_modules') || filename.includes('.bak')) return;

  // debounce per-file
  const existing = _pending.get(filename);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    _pending.delete(filename);
    const fullPath = join(KERNEL_DIR, filename);
    const result = await _checkSyntax(fullPath);

    if (result.ok) {
      console.log(`[kernel-watch] ✅ ${filename} syntax OK`);
      return;
    }

    // 失败 → 写 feedback 记忆 + audit
    console.warn(`[kernel-watch] ❌ ${filename} syntax FAIL:\n${result.stderr.slice(0, 400)}`);
    try {
      const { writeMemory } = await import('./memory/memory-writer.mjs');
      writeMemory({
        type: 'feedback',
        name: `kernel-syntax-fail-${filename.replace(/[\\/]/g, '-')}`,
        description: `kernel 文件 ${filename} 语法错误`,
        body: `语法检查失败: ${filename}\n${result.stderr.slice(0, 1500)}\n\n如何修复: 用 node --check 在本地验证, 找到行号修正; 通常是中文注释吞换行 / 括号不匹配 / 函数重复声明.`,
        source: 'kernel-watch',
        confidence: 0.95,
      });
    } catch (e) {
      console.warn('[kernel-watch] memory write failed:', e.message);
    }
    try {
      const { auditLog } = await import('./audit/audit.js');
      auditLog({
        event: 'kernel.syntax.failed',
        operator: 'kernel-watch',
        target: filename,
        detail: { stderr: result.stderr.slice(0, 500) },
      });
    } catch {}
  }, DEBOUNCE_MS);

  _pending.set(filename, timer);
}

export function startKernelWatch() {
  if (_enabled) return;
  if (process.env.NOVA_KERNEL_WATCH === 'off') {
    console.log('[kernel-watch] disabled by env');
    return;
  }
  try {
    _watcher = watch(KERNEL_DIR, { recursive: true }, (eventType, filename) => {
      if (eventType === 'change') _onChange(filename);
    });
    _enabled = true;
    console.log(`[kernel-watch] watching ${KERNEL_DIR} (debounce ${DEBOUNCE_MS}ms, ext: .mjs/.js)`);
  } catch (e) {
    console.warn('[kernel-watch] failed to start:', e.message);
  }
}

export function stopKernelWatch() {
  if (_watcher) { _watcher.close(); _watcher = null; }
  for (const t of _pending.values()) clearTimeout(t);
  _pending.clear();
  _enabled = false;
}
