/**
 * kb/remember.mjs — 双向循环写入接口 (S3)
 *
 * n.kb.remember({ title, body, risk_level, module, ... }) → 写 memory + 向量化
 *
 * L1 软知识：直接 writeMemory(type=reference, conf=0.6) + 异步向量化 + 引用计数晋级
 * L2 硬知识：写 draft（conf=0.65，status=draft）→ Librarian 策展 → 24h Veto 窗口 → 晋级
 * L3 L0 禁区：拒绝；调用方应走 nova_propose_change
 */

import { writeMemory } from '../memory/memory-writer.mjs';
import { validateTags, inferFunction } from './taxonomy-guard.mjs';

export async function remember({
  title,
  body,
  description = null,
  type = 'reference',
  risk_level = 'L1',
  module = null,
  function: func = null,
  source = 'kb-remember',
  metadata = {},
} = {}) {
  if (!title || !body) throw new Error('title + body 必填');

  const val = validateTags({ module, function: func || inferFunction({ name: title }), risk_level });
  if (!val.ok) return { ok: false, errors: val.errors };

  // L3 走 propose_change，不直接写
  if (val.normalized.risk_level === 'L3') {
    return {
      ok: false,
      reason: 'L3 禁区必须走 nova_propose_change，不能 remember',
      hint: '把这条意图填成 proposals/submit',
    };
  }

  // L1 直接 active；L2 先 draft，由 Librarian 策展
  const confidence = val.normalized.risk_level === 'L2' ? 0.65 : (metadata.confidence || 0.8);

  const enrichedBody = [
    body,
    '',
    `<!-- kb-meta: module=${val.normalized.module} function=${val.normalized.function} risk=${val.normalized.risk_level} -->`,
  ].join('\n');

  const entry = writeMemory({
    type,
    name: title.slice(0, 110),
    description: (description || body.split('\n')[0]).slice(0, 290),
    body: enrichedBody,
    source,
    confidence,
  });

  // 异步向量化（不阻塞调用方）
  setImmediate(async () => {
    try {
      const { embed } = await import('./embed-client.mjs');
      const { upsert } = await import('./vector-store.mjs');
      const emb = await embed([`${entry.name}: ${entry.description}\n${body}`.slice(0, 3800)], 'document');
      if (emb.ok) {
        upsert({
          id: `mem-${entry.id}`,
          memory_id: entry.id,
          type: entry.type,
          name: entry.name,
          text: body,
          embedding: emb.vectors[0],
          model: emb.model,
          metadata: { ...val.normalized, ...metadata },
        });
      }
    } catch (e) { /* 向量化失败不影响主写入 */ }
  });

  return { ok: true, entry, tags: val.normalized };
}
