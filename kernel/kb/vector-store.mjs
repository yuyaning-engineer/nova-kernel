/**
 * kb/vector-store.mjs — 向量索引 (S2)
 *
 * 用 better-sqlite3 存 float32 blob。小规模（<100K 条）JS 端算余弦足够快。
 * 多模型并存（version-aware），换模型时可后台 re-embed（S6 路线）。
 *
 * Schema:
 *   vectors(id TEXT PK, memory_id TEXT, type TEXT, name TEXT,
 *           text TEXT, embedding BLOB, model TEXT, dim INT,
 *           created_at TEXT, metadata JSON)
 *   citations(entry_id TEXT, session_id TEXT, ts TEXT, query TEXT)
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const DB_PATH = process.env.KB_VECTORS_DB || join(ROOT, 'kernel', 'kb', 'vectors.db');

let _db = null;

function _ensureDb() {
  if (_db) return _db;
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      id TEXT PRIMARY KEY,
      memory_id TEXT,
      type TEXT,
      name TEXT,
      text TEXT,
      embedding BLOB,
      model TEXT,
      dim INTEGER,
      created_at TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_vectors_memory ON vectors(memory_id);
    CREATE INDEX IF NOT EXISTS idx_vectors_type ON vectors(type);
    CREATE INDEX IF NOT EXISTS idx_vectors_model ON vectors(model);

    CREATE TABLE IF NOT EXISTS citations (
      entry_id TEXT,
      memory_id TEXT,
      session_id TEXT,
      ts TEXT,
      query TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cite_entry ON citations(entry_id);
    CREATE INDEX IF NOT EXISTS idx_cite_mem ON citations(memory_id);
  `);
  return _db;
}

function _toBlob(vec) {
  const arr = new Float32Array(vec);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

// P0-2 (Opus review): better-sqlite3 返回的 Buffer 的 byteOffset 不保证 4 字节对齐，
// 直接 new Float32Array(buf.buffer, buf.byteOffset, ...) 会偶发 RangeError。
// 解法：Buffer.from(buf) 复制出对齐副本，或用 slice 拷贝 underlying buffer 的精确段。
function _fromBlob(buf) {
  if (!buf || !buf.length) return [];
  const aligned = (buf.byteOffset % 4 === 0 && buf.byteLength % 4 === 0)
    ? buf
    : Buffer.from(buf); // 复制 → byteOffset === 0
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
  // 返回 Float32Array 而非 JS Array，_cosine 里接受 typed array，省去 P1-7 里每条 240 字节 * N 的 JS number 膨胀
}

// Cosine similarity — 接受 Float32Array 或普通数组，两者 index-access 接口一致
function _cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { const x = a[i], y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function upsert({ id, memory_id, type, name, text, embedding, model, metadata = {} }) {
  const db = _ensureDb();
  const blob = _toBlob(embedding);
  db.prepare(`
    INSERT INTO vectors(id, memory_id, type, name, text, embedding, model, dim, created_at, metadata)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      text=excluded.text, embedding=excluded.embedding, model=excluded.model,
      dim=excluded.dim, metadata=excluded.metadata
  `).run(
    id, memory_id || null, type || null, name || null, text || '',
    blob, model || '?', embedding.length || 0,
    new Date().toISOString(), JSON.stringify(metadata)
  );
  return { ok: true, id };
}

export function removeByMemoryId(memory_id) {
  const db = _ensureDb();
  const r = db.prepare('DELETE FROM vectors WHERE memory_id = ?').run(memory_id);
  return { ok: true, removed: r.changes };
}

// P2-9: 默认按当前 embedding 模型过滤，避免跨模型余弦（向量空间不可比）。
// filterModel=null 显式传入时才混合。
function _defaultEmbeddingModel() {
  // 2026-04-19 嫁接修: 默认走 bge-m3 (中文最强多语 embedding)
  // KB_EMBED_MODEL env 可覆盖；db 里实际 model 字段必须匹配
  return process.env.KB_EMBED_MODEL || 'bge-m3';
}

// P1-7: 流式 top-K 而不是全表分配 + sort。用最小堆思路：维护一个 K 容量的数组，
// 每行 cosine 后判断是否进入 topK。对 N=10K+1536d 内存占用从 O(N) 降到 O(K)。
export function search(queryVec, { topK = 10, filterType = null, filterModel = undefined } = {}) {
  const db = _ensureDb();
  let sql = 'SELECT id, memory_id, type, name, text, embedding, model, metadata, created_at FROM vectors';
  const where = [], params = [];
  if (filterType) { where.push('type = ?'); params.push(filterType); }
  // undefined = 默认过滤；null = 显式要求混合
  const effectiveModel = filterModel === undefined ? _defaultEmbeddingModel() : filterModel;
  if (effectiveModel) { where.push('model = ?'); params.push(effectiveModel); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');

  // 流式迭代：不在内存里攒全部行
  const stmt = db.prepare(sql);
  const top = []; // 保持 size ≤ topK 的已排序数组（升序 by score）
  let minScore = -Infinity;
  for (const r of stmt.iterate(...params)) {
    const score = _cosine(queryVec, _fromBlob(r.embedding));
    if (top.length < topK) {
      top.push({ r, score });
      top.sort((a, b) => a.score - b.score);
      minScore = top[0].score;
    } else if (score > minScore) {
      top[0] = { r, score };
      top.sort((a, b) => a.score - b.score);
      minScore = top[0].score;
    }
  }
  return top.reverse().map(({ r, score }) => ({
    id: r.id, memory_id: r.memory_id, type: r.type, name: r.name, text: r.text,
    model: r.model, created_at: r.created_at,
    metadata: r.metadata ? JSON.parse(r.metadata) : {},
    score,
  }));
}

export function getVectorCount(filter = {}) {
  const db = _ensureDb();
  let sql = 'SELECT COUNT(*) as n FROM vectors';
  const where = [], params = [];
  if (filter.type) { where.push('type = ?'); params.push(filter.type); }
  if (filter.model) { where.push('model = ?'); params.push(filter.model); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  return db.prepare(sql).get(...params).n;
}

export function recordCitation({ entry_id, memory_id, session_id = null, query = null }) {
  const db = _ensureDb();
  db.prepare('INSERT INTO citations(entry_id, memory_id, session_id, ts, query) VALUES(?,?,?,?,?)').run(
    entry_id, memory_id || null, session_id, new Date().toISOString(), query
  );
}

export function getCitationCount(memory_id, since = null) {
  const db = _ensureDb();
  if (since) {
    return db.prepare('SELECT COUNT(*) as n FROM citations WHERE memory_id = ? AND ts >= ?').get(memory_id, since).n;
  }
  return db.prepare('SELECT COUNT(*) as n FROM citations WHERE memory_id = ?').get(memory_id).n;
}

export function closeDb() { if (_db) { _db.close(); _db = null; } }
