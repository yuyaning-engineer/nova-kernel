/**
 * kb/search.mjs — 语义检索 + rerank + 引用计数 (S2)
 *
 * 流程：query → embed(query mode) → vector-store.search(topK=20) → rerank → top-5
 * 查到的每条记 citation（用于 S3 的引用晋级）
 */

import { embed, rerank } from './embed-client.mjs';
import { search as vecSearch, recordCitation } from './vector-store.mjs';
import { readMemories } from '../memory/memory-writer.mjs';

const DEFAULT_TOP_K = 20;
const DEFAULT_FINAL = 5;

export async function kbSearch(query, { topK = DEFAULT_TOP_K, finalK = DEFAULT_FINAL, filterType = null, session_id = null, record = true, rerank: doRerank = true } = {}) {
  if (!query || !query.trim()) return { ok: false, reason: 'query 为空' };

  // 1. embed query
  const emb = await embed([query], 'query');
  if (!emb.ok) return { ok: false, reason: `embed 失败: ${emb.reason}`, stage: 'embed' };

  // 2. 粗筛 topK
  const coarse = vecSearch(emb.vectors[0], { topK, filterType });
  if (coarse.length === 0) return { ok: true, hits: [], reason: 'no vectors indexed yet' };

  // 3. rerank 精排
  let final = coarse.slice(0, finalK);
  if (doRerank && coarse.length > finalK) {
    const texts = coarse.map(c => c.text);
    const rr = await rerank(query, texts, { top_k: finalK });
    if (rr.ok) {
      // rr.scores 或 rr.results — 兼容多种返回
      const scores = rr.scores || rr.results?.map(x => x.score);
      if (scores && Array.isArray(scores)) {
        const reranked = coarse.map((c, i) => ({ ...c, rerank_score: scores[i] ?? 0 }));
        reranked.sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0));
        final = reranked.slice(0, finalK);
      }
    }
  }

  // 4. 记 citation（让被命中的记忆分 +0.05）
  if (record) {
    for (const h of final) {
      try { recordCitation({ entry_id: h.id, memory_id: h.memory_id, session_id, query }); } catch {}
    }
  }

  return { ok: true, query, hits: final, coarse_count: coarse.length, rerank: doRerank };
}

/**
 * 全量索引：把所有 active memories 向量化（或增量补缺失的）
 */
export async function reindexAll({ force = false } = {}) {
  const { upsert, getVectorCount } = await import('./vector-store.mjs');
  const all = readMemories();
  const existing = new Set();
  if (!force) {
    const db = (await import('./vector-store.mjs'))._db;
    // 用 search with empty filter; simpler: query getVectorCount - but need id list
    // 直接读 citations 不合适，读 vectors 表
    const Database = (await import('better-sqlite3')).default;
    try {
      const path = process.env.KB_VECTORS_DB || 'kernel/kb/vectors.db';
      const { existsSync } = await import('node:fs');
      if (existsSync(path)) {
        const tmp = new Database(path, { readonly: true });
        for (const r of tmp.prepare('SELECT memory_id FROM vectors').all()) existing.add(r.memory_id);
        tmp.close();
      }
    } catch {}
  }

  const todo = all.filter(e => !existing.has(e.id));
  if (todo.length === 0) return { ok: true, total: all.length, indexed: existing.size, added: 0 };

  // 批量 embed
  const CHUNK = 4;
  let added = 0;
  const errors = [];
  for (let i = 0; i < todo.length; i += CHUNK) {
    const batch = todo.slice(i, i + CHUNK);
    const texts = batch.map(e => `${e.name}: ${e.description}\n${e.body}`.slice(0, 3800));
    const emb = await embed(texts, 'document');
    if (!emb.ok) { errors.push(emb.reason); break; }
    for (let j = 0; j < batch.length; j++) {
      const e = batch[j];
      upsert({
        id: `mem-${e.id}`,
        memory_id: e.id,
        type: e.type,
        name: e.name,
        text: texts[j],
        embedding: emb.vectors[j],
        model: emb.model,
        metadata: { description: e.description, source: e.source, confidence: e.confidence },
      });
      added++;
    }
  }
  return { ok: true, total: all.length, previously_indexed: existing.size, added, errors };
}
