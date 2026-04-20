/**
 * kernel/utils/llm.mjs — 跨 AI 调用 + 结构化输出统一层 (2026-04-19)
 *
 * 治本意图: 把 6 个 caller (skill-miner / intel-refine / librarian / curator /
 * gap-detector / 未来 connector) 的 "调 LLM + 解析 JSON" 逻辑收敛到 1 处。
 *
 * 调用方零差异 — 不管底层是 Anthropic / Gemini / OpenAI / Antigravity, 行为统一:
 *   - 超时 / 重试策略一致
 *   - JSON 围栏 / 裸 JSON / JSON5 容错解析
 *   - 失败返回 {error}, 不抛异常
 *   - 自动选 model (基于 task_type) 或显式指定
 */
import { executeWithAI } from '../workers/ai-executor.mjs';

const DEFAULT_TIMEOUT = 60_000;

/**
 * 调用 LLM 拿原始文本.
 *
 * @param {string} prompt
 * @param {object} opts
 * @param {string} [opts.model] - 显式指定 model (如 'antigravity-claude-sonnet-4-6')
 * @param {string} [opts.task_type] - 任务类型 (如 'structured-extract' / 'analysis'), 让 ai-executor 自动选 model
 * @param {number} [opts.complexity=2]
 * @param {number} [opts.timeout_ms=60000]
 * @param {string} [opts.task_id] - 审计追踪 id
 * @param {string} [opts.worker='util-llm'] - worker 名 (用于审计/日志)
 * @returns {Promise<{ok:boolean, output?:string, error?:string, model?:string, latency_ms?:number}>}
 */
export async function callLlm(prompt, opts = {}) {
  if (!prompt || typeof prompt !== 'string') {
    return { ok: false, error: 'prompt empty or not string' };
  }
  const {
    model,
    task_type = 'analysis',
    complexity = 2,
    timeout_ms = DEFAULT_TIMEOUT,
    task_id = `util-llm-${Date.now()}`,
    worker = 'util-llm',
  } = opts;

  const start = Date.now();
  try {
    const r = await executeWithAI({
      task_id,
      prompt,
      worker,
      suggested_model: model,
      task_type,
      complexity,
      timeout_ms,
    });
    if (!r?.ok || !r?.output) {
      return { ok: false, error: r?.error || 'no output', latency_ms: Date.now() - start };
    }
    return {
      ok: true,
      output: String(r.output),
      model: r.model || model || null,
      latency_ms: Date.now() - start,
    };
  } catch (e) {
    return { ok: false, error: e.message, latency_ms: Date.now() - start };
  }
}

/**
 * 从 LLM 文本输出里挖 JSON. 兼容:
 *   1. ```json\n{...}\n``` markdown 围栏
 *   2. ``` ... ``` 无 lang 围栏
 *   3. 裸 {...}, 取首个 { 到末 }
 *   4. 行间杂文字 (LLM 经常前后加解释)
 *
 * @param {string} text
 * @returns {object|null} 解析失败返 null
 */
export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  let candidate = text.trim();

  // 1. 优先匹配 markdown 围栏 (json / 无 lang)
  const fence = candidate.match(/```(?:json|JSON)?\s*([\s\S]+?)\s*```/);
  if (fence) candidate = fence[1].trim();

  // 2. 兜底: 找首个 { 到末 } 切片
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const slice = candidate.slice(first, last + 1);

  try {
    return JSON.parse(slice);
  } catch {
    // 3. 容错: 删尾随逗号再试 (JSON5 子集)
    try {
      return JSON.parse(slice.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/**
 * 一步到位: 调 LLM + 解析 JSON.
 *
 * @returns {Promise<{ok:boolean, json?:object, error?:string, raw?:string, model?:string, latency_ms?:number}>}
 */
export async function callLlmJson(prompt, opts = {}) {
  const r = await callLlm(prompt, opts);
  if (!r.ok) return { ok: false, error: r.error, latency_ms: r.latency_ms };
  const json = extractJson(r.output);
  if (!json) {
    return {
      ok: false,
      error: 'json parse failed',
      raw: r.output.slice(0, 500),
      model: r.model,
      latency_ms: r.latency_ms,
    };
  }
  return { ok: true, json, model: r.model, latency_ms: r.latency_ms };
}
