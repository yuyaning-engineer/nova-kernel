/**
 * KB v2 HTTP Handlers
 * kernel/server/handlers/kb.mjs
 *
 *   GET  /kb/context          Bootstrap snapshot（S1）
 *   POST /kb/search           语义检索（S2）
 *   POST /kb/reindex          批量向量化 / 增量补（S2）
 *   POST /kb/remember         SDK 写接口（S3）
 *   POST /kb/decay            跑一次衰减/晋级（S3）
 *   GET  /kb/taxonomy         读枚举（S4）
 *   POST /intel/ingest        IM 入站（S5）
 *   GET  /intel/list          看池
 *   POST /intel/refine        批量 refine
 *   POST /intel/brief         生成简报
 *   GET  /intel/entities      实体 top-N
 *   POST /kb/maintenance      跑一次自维护（S6）
 *   GET  /kb/tiers            列模型 tier（S6）
 *   POST /kb/backup           手动备份（S7）
 *   GET  /kb/health           KB 子系统健康检查（S7）
 */

import { readBody, send, sendError, assertInternalAuth } from '../utils.mjs';

export async function handleKbContext(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const url = new URL(req.url, `http://x`);
    const scope = url.searchParams.get('scope') || 'full';
    const { buildContextSnapshot } = await import('../../kb/context-bootstrap.mjs');
    const snap = await buildContextSnapshot({ scope });
    send(res, 200, { ok: true, snapshot: snap });
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleKbSearch(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    const { kbSearch } = await import('../../kb/search.mjs');
    const r = await kbSearch(body.query, {
      topK: body.topK || 20, finalK: body.finalK || 5,
      filterType: body.type || null, session_id: body.session_id || null,
      record: body.record !== false, rerank: body.rerank !== false,
    });
    send(res, 200, r);
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleKbReindex(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req).catch(() => ({}));
    const { reindexAll } = await import('../../kb/search.mjs');
    const r = await reindexAll({ force: !!body.force });
    send(res, 200, r);
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleKbRemember(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    const { remember } = await import('../../kb/remember.mjs');
    const r = await remember(body);
    send(res, 200, r);
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleKbDecay(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req).catch(() => ({}));
    const { runDecay } = await import('../../kb/decay.mjs');
    const r = await runDecay({ dry: !!body.dry });
    send(res, 200, r);
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleKbTaxonomy(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const { loadTaxonomy } = await import('../../kb/taxonomy-guard.mjs');
    send(res, 200, { ok: true, taxonomy: loadTaxonomy() });
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleIntelIngest(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    const { ingestIntel } = await import('../../kb/intel/ingest.mjs');
    send(res, 200, ingestIntel(body));
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleIntelList(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const url = new URL(req.url, 'http://x');
    const { listIntel } = await import('../../kb/intel/ingest.mjs');
    const items = listIntel({
      status: url.searchParams.get('status') || null,
      limit: parseInt(url.searchParams.get('limit') || '50', 10),
    });
    send(res, 200, { ok: true, items, count: items.length });
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleIntelRefine(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req).catch(() => ({}));
    const { refinePending } = await import('../../kb/intel/refine.mjs');
    send(res, 200, await refinePending({ limit: body.limit || 20 }));
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleIntelBrief(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req).catch(() => ({}));
    const { publishBriefing } = await import('../../kb/intel/briefing.mjs');
    send(res, 200, await publishBriefing({ reason: body.reason || 'manual', days: body.days || 7 }));
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleIntelEntities(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const url = new URL(req.url, 'http://x');
    const { topEntities } = await import('../../kb/intel/ingest.mjs');
    const items = topEntities({
      kind: url.searchParams.get('kind') || null,
      limit: parseInt(url.searchParams.get('limit') || '20', 10),
    });
    send(res, 200, { ok: true, entities: items });
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleKbMaintenance(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req).catch(() => ({}));
    const { runMaintenance } = await import('../../kb/self-maintenance.mjs');
    send(res, 200, await runMaintenance({ skip: body.skip || [], dry: !!body.dry }));
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleKbTiers(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const { listTiers, getEmbeddingConfig } = await import('../../kb/providers/tier-router.mjs');
    send(res, 200, { ok: true, tiers: listTiers(), embedding: getEmbeddingConfig() });
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleKbBackup(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const { runBackupJob } = await import('../../kb/backup.mjs');
    send(res, 200, runBackupJob());
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleKbVaultSync(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const { syncVault } = await import('../../kb/vault-sync.mjs');
    send(res, 200, await syncVault());
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleKbMetaExtract(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req).catch(() => ({}));
    const { extractLearnings } = await import('../../kb/meta-memory.mjs');
    send(res, 200, await extractLearnings({
      mode: body.mode || 'on_demand',
      session_path: body.session_path || null,
      turns: body.turns || null,
    }));
  } catch (e) { sendError(res, 500, e.message); }
}

export async function handleKbHealth(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const { probe } = await import('../../kb/embed-client.mjs');
    const { getVectorCount } = await import('../../kb/vector-store.mjs');
    const { getIntelCount } = await import('../../kb/intel/ingest.mjs');
    const { checkDiskHealth } = await import('../../kb/backup.mjs');
    const { getVramUsage } = await import('../../kb/vram-lock.mjs');
    const p = await probe();
    send(res, 200, {
      ok: true,
      embedding_service: p.ok ? 'up' : 'down',
      embedding_reason: p.ok ? null : p.reason,
      vectors: getVectorCount(),
      intel_total: getIntelCount(),
      intel_pending: getIntelCount({ status: 'pending_refine' }),
      intel_refined: getIntelCount({ status: 'refined' }),
      vram: getVramUsage(),
      disk: checkDiskHealth(),
    });
  } catch (e) { sendError(res, 500, e.message); }
}
