/**
 * Librarian Handlers
 * kernel/server/handlers/librarian.mjs
 *
 *   POST /librarian/triage       整理 nova-inbox 待处理文件
 *   POST /librarian/audit        审查现有记忆冗余/过期
 *   POST /librarian/report       生成日报
 *   POST /librarian/machine-spec 刷新机器配置快照
 *   POST /librarian/run          全部跑一遍（或指定 which=triage|audit|report|machine-spec）
 *   GET  /librarian/machine-spec 快速查看当前机器配置（不重新采集）
 */

import { readBody, send, sendError, assertInternalAuth } from '../utils.mjs';

export async function handleLibrarianTriage(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const { triageInbox } = await import('../../librarian/librarian.mjs');
    const r = await triageInbox();
    send(res, 200, r);
  } catch (err) { sendError(res, 500, err.message); }
}

export async function handleLibrarianAudit(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const { auditMemory } = await import('../../librarian/librarian.mjs');
    const r = await auditMemory();
    send(res, 200, r);
  } catch (err) { sendError(res, 500, err.message); }
}

export async function handleLibrarianReport(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const { dailyReport } = await import('../../librarian/librarian.mjs');
    const r = await dailyReport();
    send(res, 200, r);
  } catch (err) { sendError(res, 500, err.message); }
}

export async function handleLibrarianMachineSpec(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const { updateMachineSpec } = await import('../../librarian/machine-spec.mjs');
    const r = await updateMachineSpec();
    send(res, 200, r);
  } catch (err) { sendError(res, 500, err.message); }
}

export async function handleLibrarianMachineSpecGet(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    // 从记忆读当前快照（不重新采集，秒返）
    const { readMemories } = await import('../../memory/memory-writer.mjs');
    const spec = readMemories({ type: 'reference' }).find(e => e.name === 'machine-spec-current');
    if (!spec) return send(res, 200, { ok: false, hint: '尚未采集，调 POST /librarian/machine-spec' });
    send(res, 200, { ok: true, id: spec.id, created_at: spec.created_at, body: spec.body });
  } catch (err) { sendError(res, 500, err.message); }
}

export async function handleLibrarianRun(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req).catch(() => ({}));
    const { runLibrarian } = await import('../../librarian/librarian.mjs');
    const r = await runLibrarian(body.which || 'all');
    send(res, 200, r);
  } catch (err) { sendError(res, 500, err.message); }
}
