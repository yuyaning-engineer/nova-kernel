/**
 * Council Handlers
 * kernel/server/handlers/council.mjs
 *
 * 异步议会 4 个端点：
 *   POST /council/submit   — 提交 L3 提案（立即返 ticket_id，后台三方投票）
 *   GET  /council/pending  — 列所有待批 ticket
 *   GET  /council/ticket   — 查指定 ticket 详情
 *   POST /council/resolve  — 用户裁决（approve/veto）
 */

import { submitForAsyncVote, getCouncilTicket, listPendingCouncil, resolveTicket, retryVoting } from '../../council/async-council.mjs';
import { readBody, send, sendError, assertInternalAuth, resolveSource } from '../utils.mjs';

export async function handleCouncilSubmit(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.prompt) return sendError(res, 400, 'prompt 必填');
    const result = submitForAsyncVote({
      task_id:  body.task_id || `manual-${Date.now()}`,
      operator: body.operator || `source:${resolveSource(req)}`,
      prompt:   body.prompt,
      project:  body.project || 'unknown',
      payload:  body.payload || {},
    });
    send(res, 200, result);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

export async function handleCouncilPending(req, res) {
  if (!assertInternalAuth(req, res)) return;
  const tickets = listPendingCouncil();
  send(res, 200, { ok: true, count: tickets.length, tickets });
}

export async function handleCouncilGet(req, res) {
  if (!assertInternalAuth(req, res)) return;
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if (!id) return sendError(res, 400, 'id 参数必填');
  const r = getCouncilTicket(id);
  if (!r.ok) return sendError(res, 404, r.error);
  send(res, 200, r);
}

export async function handleCouncilRetry(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.ticket_id) return sendError(res, 400, 'ticket_id 必填');
    const r = retryVoting(body.ticket_id);
    send(res, 200, r);
  } catch (err) { sendError(res, 500, err.message); }
}

export async function handleCouncilResolve(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.ticket_id) return sendError(res, 400, 'ticket_id 必填');
    if (!['approve', 'veto'].includes(body.resolution)) {
      return sendError(res, 400, 'resolution 必须是 approve 或 veto');
    }
    const r = resolveTicket(body.ticket_id, body.resolution, body.operator || `source:${resolveSource(req)}`);
    if (!r.ok) return sendError(res, 404, r.error);
    send(res, 200, r);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}
