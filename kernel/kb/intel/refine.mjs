/**
 * kb/intel/refine.mjs — Intel 入库前 LLM 提炼 + 实体抽取 (S5)
 *
 * Gemini/Opus 共识：碎片入库前必须过 LLM 提炼（staging area）。
 * 用 Gemini Flash（便宜快）做提炼，只出结构化 JSON：
 *   { summary, category, entities:{kol,brand,category,keyword}, decision_value }
 */

import { listIntel, updateIntelItem, addEntity } from './ingest.mjs';
import { callLlmJson } from '../../utils/llm.mjs';

// 从 curator-tiers.json 解析 intel_refine 的模型（T2 = Sonnet）
// 用环境变量 KB_REFINER_MODEL 强制覆盖
async function _resolveModel() {
  if (process.env.KB_REFINER_MODEL) return process.env.KB_REFINER_MODEL;
  try {
    const { modelForUseCase } = await import('../providers/tier-router.mjs');
    return modelForUseCase('intel_refine')?.model || 'antigravity-claude-sonnet-4-6';
  } catch { return 'antigravity-claude-sonnet-4-6'; }
}

function _buildPrompt(item) {
  return `你是电商运营洞察提炼助手。对下面这条同事通过 IM 转发的信息做结构化提炼。

# 原文
${item.raw_text?.slice(0, 2000) || '(无文字，仅链接)'}

# 链接
${(item.urls || []).join('\n') || '(无)'}

# 来源
${item.source_channel} / ${item.sender}

# 输出要求
只输出一个 JSON 对象，字段：
- summary: string，≤50 字，中文，浓缩主旨
- category: "竞品" | "KOL" | "趋势" | "面料" | "版型" | "营销" | "其他"
- decision_value: "high" | "medium" | "low"，对老板做决策的价值
- entities: { kol: [], brand: [], category: [], keyword: [] }
  - kol：提到的达人/博主名（如"大喜"、"张颂文"）
  - brand：提到的品牌（如"蕉内"、"内外"）
  - category：品类（如"碎花连衣裙"、"针织衫"）
  - keyword：关键卖点/元素（如"法式"、"小个子"）
- reason: 一句话解释为什么给这个 decision_value

只返回 JSON，别加其它文字。`;
}

export async function refineOne(item) {
  const prompt = _buildPrompt(item);
  const model = await _resolveModel();
  const r = await callLlmJson(prompt, {
    model,
    task_type: 'structured-extract',
    worker: 'intel-refine',
    task_id: `intel-refine-${item.id}`,
    timeout_ms: 30_000,
  });
  if (!r.ok) return { ok: false, reason: r.error, raw: r.raw?.slice(0, 200) };
  const parsed = r.json;

  // 写回 refined 字段 + 实体
  updateIntelItem(item.id, {
    refined: parsed,
    tags: { category: parsed.category, decision_value: parsed.decision_value },
    status: 'refined',
  });
  for (const kind of ['kol', 'brand', 'category', 'keyword']) {
    const arr = parsed.entities?.[kind] || [];
    for (const v of arr) { if (v && v.length < 80) addEntity(item.id, kind, v); }
  }
  return { ok: true, id: item.id, refined: parsed };
}

/**
 * 批量 refine：扫所有 pending_refine 状态的 item
 */
export async function refinePending({ limit = 20 } = {}) {
  const pending = listIntel({ status: 'pending_refine', limit });
  const results = [];
  for (const it of pending) {
    const r = await refineOne(it);
    results.push({ id: it.id, ok: r.ok, reason: r.reason });
    if (!r.ok) break; // LLM 挂了不继续
  }
  return { ok: true, processed: results.length, pending_before: pending.length, results };
}
