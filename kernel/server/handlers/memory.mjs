/**
 * Memory Handlers
 * kernel/server/handlers/memory.mjs
 *
 * 4 个记忆相关 HTTP 端点，从 server.js 抽离：
 *   POST /memory/write  — 写入一条分层记忆
 *   GET  /memory/list   — 列出所有（或按 type 过滤）记忆
 *   POST /memory/forget — 忘记一条
 *   POST /memory/sync   — Claude ↔ Nova 手动同步
 */

import { writeMemory, readMemories, forgetMemory } from '../../memory/memory-writer.mjs';
import { syncFromClaude, syncToClaude, syncBidirectional } from '../../memory/memory-sync.mjs';
import { auditLog } from '../../audit/audit.js';
import { readBody, send, sendError, assertInternalAuth, resolveSource } from '../utils.mjs';

export async function handleMemoryWrite(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    const source = body.source || resolveSource(req);
    const entry = writeMemory({
      type:        body.type,
      name:        body.name,
      description: body.description,
      body:        body.body,
      source,
      confidence:  body.confidence,
    });
    auditLog({
      event: 'memory.write',
      operator: `source:${source}`,
      target: entry.id,
      detail: { type: entry.type, name: entry.name },
    });
    send(res, 200, { ok: true, entry });
  } catch (err) {
    sendError(res, 400, err.message);
  }
}

export async function handleMemoryList(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const url = new URL(req.url, 'http://x');
    const type = url.searchParams.get('type');
    const entries = readMemories(type ? { type } : {});
    send(res, 200, { ok: true, count: entries.length, entries });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

export async function handleMemoryForget(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.id) return sendError(res, 400, 'id 必填');
    const r = forgetMemory(body.id);
    if (!r.ok) return sendError(res, 404, r.error);
    auditLog({
      event: 'memory.forget',
      operator: `source:${resolveSource(req)}`,
      target: body.id,
      detail: { type: r.type },
    });
    send(res, 200, { ok: true, ...r });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

export async function handleMemorySync(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req).catch(() => ({}));
    const direction = body.direction || 'bidirectional';
    const claudeDir = body.claude_dir;
    let result;
    if (direction === 'from-claude')    result = syncFromClaude(claudeDir);
    else if (direction === 'to-claude') result = syncToClaude(claudeDir);
    else                                 result = syncBidirectional(claudeDir);
    auditLog({
      event: 'memory.sync',
      operator: `source:${resolveSource(req)}`,
      target: direction,
      detail: result,
    });
    send(res, 200, { ok: true, direction, result });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

// 手动扫 nova-inbox/ 目录吸收（watcher 平时自动，这个是补救用）
export async function handleMemoryInboxScan(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const { scanInboxNow } = await import('../../memory/inbox-watcher.mjs');
    const result = await scanInboxNow();
    send(res, 200, { ok: true, result });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}
