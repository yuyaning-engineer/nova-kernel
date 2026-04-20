/**
 * kb/vram-lock.mjs — VRAM 互斥锁 (S7)
 *
 * 两位同事都警告：Qwen3-8B embedding (~16GB) 跟 ComfyUI 冲突会 OOM。
 * 策略：embedding 服务拉起前先检查 GPU 占用，>THRESHOLD 就拒绝。
 */

import { execSync } from 'node:child_process';

const THRESHOLD_MB = parseInt(process.env.KB_VRAM_THRESHOLD_MB || '8000', 10);
const QUERY_TIMEOUT = 2000;

function _safeExec(cmd) {
  try { return execSync(cmd, { timeout: QUERY_TIMEOUT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

export function getVramUsage() {
  const out = _safeExec('nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits');
  if (!out) return { available: false };
  const [used, total, util] = out.split(',').map(x => parseInt(x.trim(), 10));
  return { available: true, used_mb: used, total_mb: total, free_mb: total - used, util_pct: util };
}

/**
 * 是否可以启动 embedding 服务 / 调用 embedding。
 * 返回 { ok, reason }
 */
export function canUseVram({ need_mb = 16000 } = {}) {
  const v = getVramUsage();
  if (!v.available) return { ok: true, reason: 'no nvidia-smi, skip check', vram: null };
  if (v.free_mb < need_mb) {
    return {
      ok: false,
      reason: `VRAM 不足：free=${v.free_mb}MB < need=${need_mb}MB（总 ${v.total_mb}，已用 ${v.used_mb}）。可能 ComfyUI 或其他重任务在跑。`,
      vram: v,
    };
  }
  return { ok: true, reason: 'vram ok', vram: v };
}
