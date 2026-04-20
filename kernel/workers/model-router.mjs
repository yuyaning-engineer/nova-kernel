/**
 * model-router.mjs — Smart Multi-Model Router
 *
 * 根据任务复杂度 (complexity 1-5) 路由到成本最优模型，
 * 并在模型不可用时自动降级（fallback）。
 *
 * 核心能力：
 *   1. 复杂度驱动路由 — 简单任务走 Flash，复杂任务走 Pro/Claude
 *   2. 成本追踪 — 每次调用记录 {model, tokens_in, tokens_out, cost_usd, latency_ms}
 *   3. 可用性降级 — 429/503 时自动切换备选模型
 *   4. 统计暴露 — getModelStats() 供 GET /api/model-stats 使用
 *
 * 定价数据来源：各厂商 2026-Q2 公开 API 价格页（per 1M tokens）
 */

import {
  GEMINI_FLASH, GEMINI_PRO,
  GEMINI_FLASH_STABLE, GEMINI_PRO_STABLE,
  CLAUDE_SONNET, CLAUDE_OPUS,
  CODEX_MINI, CODEX_FULL,
} from '../config/models.js';

// ---------------------------------------------------------------------------
// 定价表（USD per 1M tokens）— 可通过环境变量覆盖
// ---------------------------------------------------------------------------

const PRICING = {
  // Gemini Flash (preview & stable): $0.10 input / $0.40 output
  [GEMINI_FLASH]:        { input: 0.10, output: 0.40 },
  [GEMINI_FLASH_STABLE]: { input: 0.10, output: 0.40 },
  // Gemini Pro (preview & stable): $1.25 input / $5.00 output
  [GEMINI_PRO]:          { input: 1.25, output: 5.00 },
  [GEMINI_PRO_STABLE]:   { input: 1.25, output: 5.00 },
  // Claude Sonnet: $3.00 input / $15.00 output
  [CLAUDE_SONNET]:       { input: 3.00, output: 15.00 },
  // Claude Opus: $15.00 input / $75.00 output
  [CLAUDE_OPUS]:         { input: 15.00, output: 75.00 },
  // GPT-5.4 Mini: $1.50 input / $6.00 output (estimated)
  [CODEX_MINI]:          { input: 1.50, output: 6.00 },
  // GPT-5.4 Full: $5.00 input / $15.00 output (estimated)
  [CODEX_FULL]:          { input: 5.00, output: 15.00 },
};

// 允许环境变量覆盖定价：MODEL_PRICING_<model_sanitized>_INPUT / _OUTPUT
for (const [model, price] of Object.entries(PRICING)) {
  const key = model.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  const envIn  = process.env[`MODEL_PRICING_${key}_INPUT`];
  const envOut = process.env[`MODEL_PRICING_${key}_OUTPUT`];
  if (envIn)  price.input  = parseFloat(envIn);
  if (envOut) price.output = parseFloat(envOut);
}

// ---------------------------------------------------------------------------
// 路由规则：complexity → [primary, fallback1, fallback2, ...]
// ---------------------------------------------------------------------------

/**
 * 路由表：根据 worker 类型和 complexity，返回模型优先级链。
 * 每个 entry 包含 worker（执行层）和 model（模型 ID）。
 *
 * 设计原则：
 *   - complexity 1:   纯 Flash，最低成本
 *   - complexity 2-3: Flash 优先，Pro 备选
 *   - complexity 4:   Pro 优先，Flash stable 备选（不降级到 Flash preview 避免质量问题）
 *   - complexity 5:   Pro 或 Claude Sonnet（最强推理）
 */
function getRoutingChain(worker, complexity) {
  const c = Math.max(1, Math.min(5, complexity));

  // Claude worker — 始终走 Claude CLI，不做跨 worker 路由
  if (worker === 'claude') {
    return c >= 5
      ? [{ worker: 'claude', model: CLAUDE_OPUS }, { worker: 'claude', model: CLAUDE_SONNET }]
      : [{ worker: 'claude', model: CLAUDE_SONNET }];
  }

  // Codex worker — 走 OpenAI/Codex CLI
  if (worker === 'codex') {
    return c <= 3
      ? [{ worker: 'codex', model: CODEX_MINI }, { worker: 'codex', model: CODEX_FULL }]
      : [{ worker: 'codex', model: CODEX_FULL }, { worker: 'codex', model: CODEX_MINI }];
  }

  // Gemini worker — 主路由（成本优化核心）
  switch (c) {
    case 1:
      return [
        { worker: 'gemini', model: GEMINI_FLASH },
        { worker: 'gemini', model: GEMINI_FLASH_STABLE },
      ];
    case 2:
    case 3:
      return [
        { worker: 'gemini', model: GEMINI_FLASH },
        { worker: 'gemini', model: GEMINI_PRO },
        { worker: 'gemini', model: GEMINI_FLASH_STABLE },
      ];
    case 4:
      return [
        { worker: 'gemini', model: GEMINI_PRO },
        { worker: 'gemini', model: GEMINI_PRO_STABLE },
        { worker: 'gemini', model: GEMINI_FLASH_STABLE },
      ];
    case 5:
      return [
        { worker: 'gemini', model: GEMINI_PRO },
        { worker: 'gemini', model: GEMINI_PRO_STABLE },
      ];
    default:
      return [{ worker: 'gemini', model: GEMINI_FLASH }];
  }
}

// ---------------------------------------------------------------------------
// 模型可用性追踪 — 429/503 时标记模型暂时不可用
// ---------------------------------------------------------------------------

/** @type {Map<string, number>} model → unix timestamp when it becomes available again */
const _unavailable = new Map();

/** 标记模型不可用（cooldown 默认 60 秒，可配置） */
const COOLDOWN_MS = parseInt(process.env.MODEL_COOLDOWN_MS || '60000', 10);

export function markUnavailable(model, cooldownMs = COOLDOWN_MS) {
  _unavailable.set(model, Date.now() + cooldownMs);
  console.warn(`[model-router] ${model} marked unavailable for ${cooldownMs}ms`);
}

/** 检查模型是否可用 */
function isAvailable(model) {
  const until = _unavailable.get(model);
  if (!until) return true;
  if (Date.now() >= until) {
    _unavailable.delete(model);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 路由决策
// ---------------------------------------------------------------------------

/**
 * 选择最优模型。返回路由链中第一个可用的 {worker, model}。
 *
 * @param {string} worker      原始 worker（gemini/codex/claude）
 * @param {number} complexity  1-5
 * @returns {{ worker: string, model: string }}
 */
export function selectModel(worker, complexity) {
  const chain = getRoutingChain(worker, complexity);

  for (const candidate of chain) {
    if (isAvailable(candidate.model)) {
      return candidate;
    }
  }

  // 所有候选都不可用 — 返回链首（让上层 retry 机制处理）
  console.warn(`[model-router] 所有候选模型不可用，fallback to chain[0]: ${chain[0].model}`);
  return chain[0];
}

// ---------------------------------------------------------------------------
// 成本追踪
// ---------------------------------------------------------------------------

/** @type {{ total_calls: number, total_cost_usd: number, total_input_tokens: number, total_output_tokens: number, by_model: Record<string, ModelStats> }} */
const _stats = {
  total_calls: 0,
  total_cost_usd: 0,
  total_input_tokens: 0,
  total_output_tokens: 0,
  started_at: new Date().toISOString(),
  by_model: {},
};

/**
 * @typedef {Object} ModelStats
 * @property {number} calls
 * @property {number} input_tokens
 * @property {number} output_tokens
 * @property {number} cost_usd
 * @property {number} total_latency_ms
 * @property {number} avg_latency_ms
 * @property {number} errors
 * @property {number} fallbacks_triggered  — 作为 fallback 被选中的次数
 */

function _ensureModelStats(model) {
  if (!_stats.by_model[model]) {
    _stats.by_model[model] = {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      total_latency_ms: 0,
      avg_latency_ms: 0,
      errors: 0,
      fallbacks_triggered: 0,
    };
  }
  return _stats.by_model[model];
}

/**
 * 估算 token 数（简单近似：英文 ~4 chars/token，中文 ~2 chars/token）。
 * 实际 token 数应从 API 响应的 usage 字段提取，此处仅作兜底估算。
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  // 粗略估算：混合中英文场景，按 3 chars/token 折中
  return Math.ceil(text.length / 3);
}

/**
 * 计算单次调用成本。
 *
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} cost in USD
 */
export function calculateCost(model, inputTokens, outputTokens) {
  const price = PRICING[model];
  if (!price) return 0; // 未知模型不计费（CLI 模型等）
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * 记录一次 AI 调用的成本和延迟。
 * 应在每次 AI 调用完成后调用。
 *
 * @param {{
 *   model: string,
 *   input_tokens: number,
 *   output_tokens: number,
 *   latency_ms: number,
 *   ok: boolean,
 *   was_fallback?: boolean,
 * }} record
 */
export function recordCall(record) {
  const { model, input_tokens, output_tokens, latency_ms, ok, was_fallback } = record;
  const cost = calculateCost(model, input_tokens, output_tokens);

  // 全局统计
  _stats.total_calls++;
  _stats.total_cost_usd += cost;
  _stats.total_input_tokens += input_tokens;
  _stats.total_output_tokens += output_tokens;

  // 模型维度统计
  const ms = _ensureModelStats(model);
  ms.calls++;
  ms.input_tokens += input_tokens;
  ms.output_tokens += output_tokens;
  ms.cost_usd += cost;
  ms.total_latency_ms += latency_ms;
  ms.avg_latency_ms = Math.round(ms.total_latency_ms / ms.calls);
  if (!ok) ms.errors++;
  if (was_fallback) ms.fallbacks_triggered++;

  // 日志（仅在 DEBUG 模式输出详细信息）
  if (process.env.MODEL_ROUTER_DEBUG) {
    console.log(`[model-router] ${model} | ${input_tokens}in/${output_tokens}out | $${cost.toFixed(6)} | ${latency_ms}ms | ${ok ? 'OK' : 'ERR'}`);
  }
}

/**
 * 记录一次错误，并在 429/503 时标记模型不可用。
 *
 * @param {string} model
 * @param {number|null} statusCode
 */
export function recordError(model, statusCode) {
  const ms = _ensureModelStats(model);
  ms.errors++;

  if (statusCode === 429 || statusCode === 503) {
    markUnavailable(model);
  }
}

// ---------------------------------------------------------------------------
// 统计暴露（供 GET /api/model-stats）
// ---------------------------------------------------------------------------

/**
 * 返回全量统计快照。
 *
 * @returns {object}
 */
export function getModelStats() {
  const uptime_s = Math.floor((Date.now() - new Date(_stats.started_at).getTime()) / 1000);

  // 计算节约估算：如果所有调用都走最贵模型(Claude Sonnet)的成本 vs 实际成本
  const hypothetical_max_cost = (_stats.total_input_tokens * 3.00 + _stats.total_output_tokens * 15.00) / 1_000_000;
  const savings_usd = hypothetical_max_cost - _stats.total_cost_usd;
  const savings_pct = hypothetical_max_cost > 0
    ? Math.round((savings_usd / hypothetical_max_cost) * 100)
    : 0;

  return {
    ..._stats,
    total_cost_usd: Math.round(_stats.total_cost_usd * 1_000_000) / 1_000_000, // 精度到微美分
    uptime_s,
    savings_estimate: {
      vs_all_sonnet_usd: Math.round(savings_usd * 1_000_000) / 1_000_000,
      savings_pct,
    },
    unavailable_models: Object.fromEntries(_unavailable),
  };
}

/**
 * 重置统计（用于测试或手动清零）。
 */
export function resetStats() {
  _stats.total_calls = 0;
  _stats.total_cost_usd = 0;
  _stats.total_input_tokens = 0;
  _stats.total_output_tokens = 0;
  _stats.started_at = new Date().toISOString();
  _stats.by_model = {};
  _unavailable.clear();
}
