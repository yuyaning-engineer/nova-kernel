/**
 * kb/context-watcher.mjs — 配置/模型变更 on-change hook (S1)
 *
 * 监听本机关键目录，有变更时防抖触发 updateMachineSpec() 刷新画像。
 * 不用 periodic probe（浪费）；watcher 1.5s 内生效（复用 round-6 经验）。
 */

import { watch, existsSync } from 'node:fs';

const DEBOUNCE_MS = 1500;
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 冷却：机器快照刷新不能比 5 分钟更频繁（machine-spec 采集自身耗时且写 USER.md）
const WATCH_PATHS = [
  'D:/AI/Models',
  'D:/AI/ComfyUI/ComfyUI_Windows_portable/ComfyUI/custom_nodes',
  // D:/claude 被移除：太噪（daemon 日志/node_modules/工具脚本持续写），且自身写 USER.md 会反触发
];

let _timer = null;
let _handles = [];
let _lastTrigger = 0;

function _schedule(reason) {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(async () => {
    _timer = null;
    // 冷却窗：频繁 fs 事件不重复 probe（防止 USER.md 反复 rewrite）
    const since = Date.now() - _lastTrigger;
    if (since < MIN_INTERVAL_MS) {
      return;
    }
    _lastTrigger = Date.now();
    try {
      const { updateMachineSpec } = await import('../librarian/machine-spec.mjs');
      const r = await updateMachineSpec();
      console.log(`[context-watcher] snapshot refreshed (${reason}): ok=${r.ok} bytes=${r.body_length || 0}`);
    } catch (e) {
      console.warn('[context-watcher] refresh failed:', e.message);
    }
  }, DEBOUNCE_MS);
}

export function startContextWatcher() {
  stopContextWatcher();
  for (const p of WATCH_PATHS) {
    if (!existsSync(p)) continue;
    try {
      const h = watch(p, { persistent: false, recursive: false }, (event, fn) => {
        if (fn && (fn.startsWith('.') || fn.startsWith('_tmp') || fn.endsWith('.tmp'))) return;
        _schedule(`${p}/${fn || '?'} ${event}`);
      });
      _handles.push({ path: p, handle: h });
    } catch (e) {
      console.warn(`[context-watcher] 无法监听 ${p}:`, e.message);
    }
  }
  console.log(`[context-watcher] 启动，监听 ${_handles.length}/${WATCH_PATHS.length} 个路径`);
  return { watching: _handles.map(h => h.path) };
}

export function stopContextWatcher() {
  for (const h of _handles) { try { h.handle.close(); } catch {} }
  _handles = [];
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

export function getWatcherStatus() {
  return {
    watching: _handles.map(h => h.path),
    last_trigger: _lastTrigger ? new Date(_lastTrigger).toISOString() : null,
  };
}
