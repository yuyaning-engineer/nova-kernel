/**
 * kb/intel/ingest.mjs — IM 入站通道 (S5)
 *
 * Opus + Gemini 共识：物理隔离到 intel 池，**不进主 embedding 索引**。
 *
 * 存储：kernel/kb/intel.db
 *   items(id TEXT PK, source_channel, sender, received_at, raw_text, urls JSON,
 *         extracted JSON, refined JSON, tags JSON, status TEXT)
 *   status: pending_refine | refined | briefed | archived
 *
 * 入口：
 *   POST /intel/ingest   — 同事通过 IM bot / 手贴 / webhook 推进来
 *   GET  /intel/list     — 看池
 *   POST /intel/refine   — 手动触发 refine
 *   POST /intel/brief    — 手动触发简报
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const DB_PATH = process.env.KB_INTEL_DB || join(ROOT, 'kernel', 'kb', 'intel.db');

let _db = null;
function _ensure() {
  if (_db) return _db;
  const d = dirname(DB_PATH);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      source_channel TEXT,
      sender TEXT,
      received_at TEXT,
      raw_text TEXT,
      urls TEXT,
      extracted TEXT,
      refined TEXT,
      tags TEXT,
      status TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_intel_status ON items(status);
    CREATE INDEX IF NOT EXISTS idx_intel_recv ON items(received_at);
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT,
      kind TEXT,   -- kol | brand | category | keyword
      value TEXT,
      UNIQUE(item_id, kind, value)
    );
    CREATE INDEX IF NOT EXISTS idx_ent_kind_val ON entities(kind, value);
  `);
  return _db;
}

function _hashId(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function _extractUrls(text) {
  const re = /(https?:\/\/[^\s，。！？"'）)\]]+)/g;
  const urls = [];
  let m;
  while ((m = re.exec(text || ''))) urls.push(m[1]);
  return urls;
}

function _classifySource(url) {
  if (!url) return 'text';
  if (/xiaohongshu\.com|xhslink\.com/.test(url)) return 'xiaohongshu';
  if (/douyin\.com|iesdouyin\.com|tiktok\.com/.test(url)) return 'douyin';
  if (/weibo\.com/.test(url)) return 'weibo';
  if (/bilibili\.com/.test(url)) return 'bilibili';
  if (/zhihu\.com/.test(url)) return 'zhihu';
  return 'other';
}

/**
 * 摄入一条原始 IM 消息。立即写盘，异步 refine。
 */
export function ingestIntel({
  source_channel = 'feishu',
  sender = 'unknown',
  text = '',
  urls = null,
  metadata = {},
} = {}) {
  const db = _ensure();
  const receivedAt = new Date().toISOString();
  const allUrls = urls || _extractUrls(text);
  const id = _hashId([source_channel, sender, text.slice(0, 100), allUrls.join(',')]);

  // URL 级去重：同 URL 已在（无论谁发的）则标记
  const dupe = db.prepare('SELECT id FROM items WHERE urls = ? LIMIT 1').get(JSON.stringify(allUrls));
  const status = dupe ? 'duplicate' : 'pending_refine';

  const extracted = {
    sources: allUrls.map(u => ({ url: u, platform: _classifySource(u) })),
    has_text: !!(text && text.trim()),
    metadata,
  };

  db.prepare(`
    INSERT OR REPLACE INTO items(id, source_channel, sender, received_at, raw_text, urls, extracted, status)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(id, source_channel, sender, receivedAt, text, JSON.stringify(allUrls), JSON.stringify(extracted), status);

  return { ok: true, id, status, urls: allUrls, duplicate: !!dupe };
}

export function listIntel({ status = null, limit = 50 } = {}) {
  const db = _ensure();
  let sql = 'SELECT id, source_channel, sender, received_at, raw_text, urls, tags, status FROM items';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY received_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).map(r => ({
    ...r,
    urls: r.urls ? JSON.parse(r.urls) : [],
    tags: r.tags ? JSON.parse(r.tags) : {},
  }));
}

export function getIntelCount(filter = {}) {
  const db = _ensure();
  let sql = 'SELECT COUNT(*) as n FROM items';
  const params = [];
  if (filter.status) { sql += ' WHERE status = ?'; params.push(filter.status); }
  return db.prepare(sql).get(...params).n;
}

export function getIntelItem(id) {
  const db = _ensure();
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    urls: row.urls ? JSON.parse(row.urls) : [],
    extracted: row.extracted ? JSON.parse(row.extracted) : {},
    refined: row.refined ? JSON.parse(row.refined) : null,
    tags: row.tags ? JSON.parse(row.tags) : {},
  };
}

export function updateIntelItem(id, patch) {
  const db = _ensure();
  const cur = getIntelItem(id);
  if (!cur) return { ok: false, reason: 'not found' };
  const updates = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (['extracted', 'refined', 'tags'].includes(k)) {
      updates.push(`${k} = ?`); params.push(JSON.stringify(v));
    } else if (['status', 'raw_text'].includes(k)) {
      updates.push(`${k} = ?`); params.push(v);
    }
  }
  if (updates.length === 0) return { ok: true, unchanged: true };
  params.push(id);
  db.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return { ok: true, id };
}

export function addEntity(item_id, kind, value) {
  const db = _ensure();
  try {
    db.prepare('INSERT OR IGNORE INTO entities(item_id, kind, value) VALUES(?,?,?)').run(item_id, kind, value);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

export function topEntities({ kind = null, since = null, limit = 20 } = {}) {
  const db = _ensure();
  let sql = `SELECT kind, value, COUNT(DISTINCT item_id) as mentions FROM entities`;
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (since) {
    where.push('item_id IN (SELECT id FROM items WHERE received_at >= ?)');
    params.push(since);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' GROUP BY kind, value ORDER BY mentions DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}
