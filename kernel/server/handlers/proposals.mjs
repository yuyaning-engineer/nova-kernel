/**
 * Proposals Handlers — AI 提案通道（让 AI 合法请求改禁区）
 * kernel/server/handlers/proposals.mjs
 *
 *   POST /proposals/submit    提交提案（自动转给议会）
 *   GET  /proposals/list      列所有（可 ?status= 过滤）
 *   GET  /proposals/get       读单个
 *   POST /proposals/approve   用户批准（Driver 或直接用户）
 *   POST /proposals/reject    用户否决
 */

import { submitProposal, listProposals, getProposal, markApproved, markRejected } from '../../evolution/proposal-engine.mjs';
import { readBody, send, sendError, assertInternalAuth, resolveSource } from '../utils.mjs';

export async function handleProposalSubmit(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    const r = await submitProposal({
      ...body,
      proposed_by: body.proposed_by || `source:${resolveSource(req)}`,
    });
    send(res, 200, r);
  } catch (err) { sendError(res, 400, err.message); }
}

export async function handleProposalList(req, res) {
  if (!assertInternalAuth(req, res)) return;
  const url = new URL(req.url, 'http://x');
  const status = url.searchParams.get('status');
  send(res, 200, { ok: true, proposals: listProposals(status ? { status } : {}) });
}

export async function handleProposalGet(req, res) {
  if (!assertInternalAuth(req, res)) return;
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if (!id) return sendError(res, 400, 'id 参数必填');
  const r = getProposal(id);
  if (!r.ok) return sendError(res, 404, r.error);
  send(res, 200, r);
}

export async function handleProposalApprove(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.proposal_id) return sendError(res, 400, 'proposal_id 必填');
    const operator = body.operator || `source:${resolveSource(req)}`;
    const r = markApproved(body.proposal_id, operator);
    send(res, r.ok ? 200 : 404, r);
  } catch (err) { sendError(res, 500, err.message); }
}

export async function handleProposalReject(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.proposal_id) return sendError(res, 400, 'proposal_id 必填');
    const operator = body.operator || `source:${resolveSource(req)}`;
    const r = markRejected(body.proposal_id, operator, body.reason);
    send(res, r.ok ? 200 : 404, r);
  } catch (err) { sendError(res, 500, err.message); }
}
