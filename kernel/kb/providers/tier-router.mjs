/**
 * kb/providers/tier-router.mjs — Tier → Model 绑定 (S6)
 *
 * 根据 use_case 查 curator-tiers.json，返回该 tier 的模型名。
 * 换模型只改 curator-tiers.json。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname(fileURLToPath(import.meta.url));
const TIER_PATH = join(SELF, '..', 'curator-tiers.json');

let _cached = null;
let _mtime = 0;
function _load() {
  if (!existsSync(TIER_PATH)) return null;
  try {
    const s = readFileSync(TIER_PATH, 'utf8');
    _cached = JSON.parse(s);
    return _cached;
  } catch { return _cached; }
}

export function modelForUseCase(use_case) {
  const cfg = _load();
  if (!cfg) return null;
  for (const [tier, spec] of Object.entries(cfg.tiers)) {
    if (spec.use_cases?.includes(use_case)) {
      return { tier, model: spec.default_model, fallback: spec.fallback || [], route_to: spec.route_to };
    }
  }
  return null;
}

/**
 * 返回 [default_model, ...fallback] 有序列表，供带 fallback 的调用链用。
 * 没匹配到 use_case 时返回 null。
 */
export function modelChainForUseCase(use_case, opts = {}) {
  const spec = modelForUseCase(use_case);
  if (!spec) return null;
  const chain = [spec.model, ...(spec.fallback || [])];
  // 去重保持顺序
  return { tier: spec.tier, chain: [...new Set(chain)], route_to: spec.route_to };
}

export function listTiers() {
  return _load()?.tiers || {};
}

export function getEmbeddingConfig() {
  return _load()?.embedding || {};
}
