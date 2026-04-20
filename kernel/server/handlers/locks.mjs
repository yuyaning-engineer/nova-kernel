/**
 * Locks Handlers (并发防护)
 * kernel/server/handlers/locks.mjs
 *
 *   POST /locks/claim        申请文件租约（走 policy 白名单 + 冲突检测）
 *   POST /locks/release      释放
 *   POST /locks/renew        续约
 *   GET  /locks/list         列所有 active
 *   POST /locks/check-policy 不申请，只查某路径的写策略
 */

import { claimFiles, releaseLease, renewLease, listActiveLeases, isPathLocked, sweepExpired } from '../../locks/file-lease.mjs';
import { checkWritePolicyBatch } from '../../locks/write-policy.mjs';
import { readBody, send, sendError, assertInternalAuth, resolveSource } from '../utils.mjs';
import { auditLog } from '../../audit/audit.js';

export async function handleLocksClaim(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!Array.isArray(body.paths)) return sendError(res, 400, 'paths 必填（数组）');
    const holder = body.holder || `source:${resolveSource(req)}`;
    const result = claimFiles({
      paths: body.paths,
      holder,
      ttl_ms: body.ttl_ms,
      meta: body.meta || {},
    });
    auditLog({
      event: result.ok ? 'locks.claimed' : 'locks.claim_denied',
      operator: holder,
      target: result.lease_id || 'n/a',
      detail: { paths: body.paths, ...(result.conflicts ? { conflicts: result.conflicts } : {}), ...(result.policy_denied ? { policy_denied: result.policy_denied } : {}) },
    });
    send(res, result.ok ? 200 : 409, result);
  } catch (err) { sendError(res, 500, err.message); }
}

export async function handleLocksRelease(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.lease_id) return sendError(res, 400, 'lease_id 必填');
    const r = releaseLease(body.lease_id, body.reason);
    auditLog({ event: 'locks.released', operator: `source:${resolveSource(req)}`, target: body.lease_id, detail: r });
    send(res, 200, r);
  } catch (err) { sendError(res, 500, err.message); }
}

export async function handleLocksRenew(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.lease_id) return sendError(res, 400, 'lease_id 必填');
    const r = renewLease(body.lease_id, body.extra_ms);
    send(res, r.ok ? 200 : 404, r);
  } catch (err) { sendError(res, 500, err.message); }
}

export async function handleLocksList(req, res) {
  if (!assertInternalAuth(req, res)) return;
  sweepExpired();
  send(res, 200, { ok: true, leases: listActiveLeases() });
}

export async function handleLocksCheckPolicy(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!Array.isArray(body.paths)) return sendError(res, 400, 'paths 必填（数组）');
    const holder = body.holder || `source:${resolveSource(req)}`;
    const result = checkWritePolicyBatch(body.paths, { holder });
    send(res, 200, { ok: true, ...result });
  } catch (err) { sendError(res, 500, err.message); }
}
