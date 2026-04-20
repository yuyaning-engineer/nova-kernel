/**
 * Nova Kernel — HTTP Server
 * kernel/server.js
 *
 * 让 Python 产品（RedOps / Anime-Generator）无需文件系统直接访问，
 * 通过 HTTP JSON API 调用 Kernel 功能。
 *
 * 启动: node kernel/server.js
 * 默认端口: 3700
 *
 * API 端点:
 *   POST /task/dispatch       提交任务（ValidateInput + 风险分类 + 路由）
 *   GET  /memory              读取 L1 系统记忆上下文
 *   POST /audit/log           写入审计事件
 *   POST /devlog              写入不可篡改开发日志
 *   GET  /evolution/gaps      运行 Gap Detector
 *   GET  /evolution/prs       列出待审批 AI-PR
 *   GET  /health              健康检查
 *   POST /intent              自然语言意图路由
 *   POST /initiative/scan     手动触发主动引擎扫描
 *   POST /feishu/event        飞书事件订阅（入站消息 → 意图路由 → 回复）
 */

import { createServer } from 'http';
import https from 'https';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, normalize, sep } from 'path';
import { execSync } from 'child_process';

import { validateTaskInput, classifyRisk, generateTaskId, resolveWorker } from './workers/task-schema.js';
import { resolveModel, logModelConfig } from './config/models.js';
import { getLatestModel, startModelDiscovery, getDiscoveryReport, runDiscovery } from './config/model-discovery.mjs';
import { auditLog, writeDevLog, verifyAllLogs } from './audit/audit.js';
import { detectGaps, formatGapReport, runAutoRepair, getCircuitBreakerState } from '../evolution/gap-detector.js';
import { listProposals, gapsToProposals, sweepExpiredVetoWindows } from '../evolution/proposal-writer.js';
import { blockL3 } from './utils/l3-gate.mjs';
import { getAllBreakerStates } from './utils/circuit-breaker.mjs';
import { executeRollback } from './rollback/executor.mjs';
import { getActiveVetoWindows, markVetoed } from './audit/audit.js';
import { runInitiativeScan, listPendingConfirms, resolveConfirm } from './initiative/engine.mjs';
import { handleIntentRoute } from './router/intent-router.mjs';
import { verifyInboundEvent, extractMessageText, extractSender, sendText, sendCard } from './notify/feishu.mjs';
import { executeWithAI } from './workers/ai-executor.mjs';
import { inferTaskType } from './workers/task-router.mjs';
import { getModelStats } from './workers/model-router.mjs';
import { installGlobalRedaction } from './utils/redact.mjs';
import { startHealthMonitor, getWorkerHealthStatus, pingAllNow } from './workers/worker-health.mjs';
import { startModelChecker, getModelVersionReport } from './config/model-version-checker.mjs';
import { queryKnowledge, archiveTaskResult, archiveFeishuChat, isAvailable as isKnowledgeAvailable } from './services/knowledge-bridge.mjs';
import { startAutoSync } from './memory/memory-sync.mjs';
import { startInboxWatcher, scanInboxNow } from './memory/inbox-watcher.mjs';
// Handler 模块（从 server.js 抽出，解耦上帝文件）
import { handleMemoryWrite, handleMemoryList, handleMemoryForget, handleMemorySync, handleMemoryInboxScan } from './server/handlers/memory.mjs';
import { handleCouncilSubmit, handleCouncilPending, handleCouncilGet, handleCouncilResolve, handleCouncilRetry } from './server/handlers/council.mjs';
import { handleProductInvoke } from './server/handlers/products.mjs';
import { handlePipelineRun, handlePipelineCodeTask, handlePipelineDebate, handleCodexRun, handleCodexProbe, handlePipelineCodexFix, handlePipelineCodexReview } from './server/handlers/pipeline.mjs';
import { handleOpenAICompat, handleOpenAIModels } from './server/handlers/openai-compat.mjs';
import { handleLocksClaim, handleLocksRelease, handleLocksRenew, handleLocksList, handleLocksCheckPolicy } from './server/handlers/locks.mjs';
import { handleProposalSubmit, handleProposalList, handleProposalGet, handleProposalApprove, handleProposalReject } from './server/handlers/proposals.mjs';
// KB v2 + Librarian 嫁接 (2026-04-19)
import { handleLibrarianTriage, handleLibrarianAudit, handleLibrarianReport, handleLibrarianMachineSpec, handleLibrarianMachineSpecGet, handleLibrarianRun } from './server/handlers/librarian.mjs';
// Agent 注册表 (2026-04-19): nova_agent_invoke 统一调 6 个 Python agent
import { handleAgentsList, handleAgentsInvoke } from './server/handlers/agents.mjs';
// Skill Miner (2026-04-19): 自动从 feedback 蒸馏 skill proposal
import { mineSkills } from './evolution/skill-miner.mjs';
import {
  handleKbContext, handleKbSearch, handleKbReindex, handleKbRemember, handleKbDecay, handleKbTaxonomy,
  handleIntelIngest, handleIntelList, handleIntelRefine, handleIntelBrief, handleIntelEntities,
  handleKbMaintenance, handleKbTiers, handleKbBackup, handleKbHealth, handleKbVaultSync,
  handleKbMetaExtract,
} from './server/handlers/kb.mjs';

// Install log redaction before any output — all console.log/warn/error
// calls will auto-strip API keys, tokens, and connection strings.
installGlobalRedaction();

const PORT = parseInt(process.env.NOVA_KERNEL_PORT || '3700', 10);
const KERNEL_ROOT = process.env.NOVA_KERNEL_ROOT || 'D:/nova-kernel';

// ---------------------------------------------------------------------------
// 任务结果缓存（内存 LRU，最多 100 条）
// ---------------------------------------------------------------------------

const _taskResults   = new Map(); // task_id → TaskResult ABI { task_id, status, worker, actual_model, output, error, time_ms, completed_at }
const MAX_CACHED_RESULTS = 100;
let _lastGapScanTime = null; // ISO string, updated by gap-repair scheduler

function _cacheTaskResult(taskId, result) {
  if (_taskResults.size >= MAX_CACHED_RESULTS) {
    // 删除插入最早的 key（Map 保持插入顺序）
    const firstKey = _taskResults.keys().next().value;
    _taskResults.delete(firstKey);
  }
  _taskResults.set(taskId, { ...result });
}

// C015: 内部 API 鉴权（Bearer Token），未配置时仅 warn，不强制（开发友好）
const INTERNAL_TOKEN = process.env.NOVA_INTERNAL_TOKEN || '';
if (!INTERNAL_TOKEN) {
  console.warn('[Nova Kernel] ⚠️  NOVA_INTERNAL_TOKEN 未配置，/intent 和 /initiative/scan 端点无鉴权保护');
}

function _assertInternalAuth(req, res) {
  if (!INTERNAL_TOKEN) return true; // 未配置时放行（开发模式）
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${INTERNAL_TOKEN}`) {
    sendError(res, 401, '未授权：缺少或错误的 NOVA_INTERNAL_TOKEN');
    return false;
  }
  return true;
}

// ── X-Nova-Source 识别：记录调用方（cursor / claude-code / cli / web / api） ──
// 让 Nova 知道自己正在为谁服务，供记忆写入、审计、个性化用。
const KNOWN_SOURCES = new Set(['cursor', 'claude-code', 'cli', 'web', 'api', 'vscode', 'jetbrains', 'mcp']);
function _resolveSource(req) {
  const raw = (req.headers['x-nova-source'] || '').toLowerCase().trim();
  if (KNOWN_SOURCES.has(raw)) return raw;
  // User-Agent fallback 启发式
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('cursor'))             return 'cursor';
  if (ua.includes('claude-code'))        return 'claude-code';
  if (ua.includes('vscode'))             return 'vscode';
  if (ua.includes('anthropic') || ua.includes('mcp')) return 'mcp';
  if (ua.startsWith('curl') || ua.includes('node'))   return 'cli';
  return raw || 'unknown';
}

// C019: nonce 去重（TTL 5 分钟，防重放攻击）
const _usedNonces = new Map(); // nonce → expireAt
const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_NONCES = 10000; // F-005 fix: 防止内存泄漏

function _checkAndMarkNonce(nonce) {
  const now = Date.now();
  // 惰性清理过期条目
  for (const [k, exp] of _usedNonces) { if (now > exp) _usedNonces.delete(k); }
  // F-005 fix: 超出上限时强制淘汰最早的条目
  if (_usedNonces.size >= MAX_NONCES) {
    const firstKey = _usedNonces.keys().next().value;
    _usedNonces.delete(firstKey);
  }
  if (_usedNonces.has(nonce)) return false;
  _usedNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const ROUTES = {
  'GET /health': handleHealth,
  'GET /dashboard': handleDashboard,
  'POST /task/dispatch': handleTaskDispatch,
  'GET /memory': handleMemoryRead,
  'POST /audit/log': handleAuditLog,
  'POST /devlog': handleDevLog,
  'GET /evolution/gaps': handleGapDetect,
  'POST /evolution/gaps/repair': handleGapRepair,
  'POST /evolution/veto-sweep': handleVetoSweep,
  'POST /veto': handleVeto,
  'GET /evolution/prs': handleListPRs,
  'GET /evolution/prs/pending': handleListPendingPRs,
  'GET /evolution/veto-windows': handleListVetoWindows,
  'POST /intent':               handleIntent,
  'POST /initiative/scan':      handleInitiativeScan,
  'POST /chat':                 handleChat,
  'GET /initiative/confirms':   handleListConfirms,
  'POST /initiative/confirms/resolve': handleResolveConfirm,
  'POST /feishu/event':         handleFeishuEvent,
  'GET /task/result':           handleTaskResult,
  'GET /api/model-stats':       handleModelStats,
  'GET /api/worker-health':     handleWorkerHealth,
  'POST /api/worker-health/ping': handleWorkerHealthPing,
  'GET /api/model-versions':           handleModelVersions,
  'GET /api/model-discovery':          handleModelDiscovery,
  'POST /api/model-discovery/refresh': handleModelDiscoveryRefresh,

  // ── 分层记忆 ─────────────────────────────────────────────────────────────
  'POST /memory/write':                handleMemoryWrite,
  'GET /memory/list':                  handleMemoryList,
  'POST /memory/forget':               handleMemoryForget,
  'POST /memory/sync':                 handleMemorySync,
  'POST /memory/inbox-scan':           handleMemoryInboxScan,

  // ── 异步议会（L3 非阻塞）────────────────────────────────────────────────
  'POST /council/submit':              handleCouncilSubmit,
  'GET /council/pending':              handleCouncilPending,
  'GET /council/ticket':               handleCouncilGet,
  'POST /council/resolve':             handleCouncilResolve,
  'POST /council/retry':               handleCouncilRetry,

  // ── 分工协作流水线 ──────────────────────────────────────────────────────
  'POST /pipeline/run':                handlePipelineRun,
  'POST /pipeline/code-task':          handlePipelineCodeTask,
  'POST /pipeline/debate':             handlePipelineDebate,
  'POST /pipeline/codex-fix':          handlePipelineCodexFix,
  'POST /pipeline/codex-review':       handlePipelineCodexReview,

  // ── Codex CLI 受控执行（Driver 派命令，Codex 只跑）────────────────────
  'POST /codex/run':                   handleCodexRun,
  'GET /codex/probe':                  handleCodexProbe,

  // ── 并发防护：文件租约 + 写入策略网关 ──────────────────────────────────
  'POST /locks/claim':                 handleLocksClaim,
  'POST /locks/release':               handleLocksRelease,
  'POST /locks/renew':                 handleLocksRenew,
  'GET /locks/list':                   handleLocksList,
  'POST /locks/check-policy':          handleLocksCheckPolicy,

  // ── AI 提案通道：想改禁区，走这里（L0 不可改，但可以请愿）──────────
  'POST /proposals/submit':            handleProposalSubmit,
  'GET /proposals/list':               handleProposalList,
  'GET /proposals/get':                handleProposalGet,
  'POST /proposals/approve':           handleProposalApprove,
  'POST /proposals/reject':            handleProposalReject,

  // ── OpenAI-compatible endpoint (for AnythingLLM / other tools) ──────────
  'POST /v1/chat/completions':         handleOpenAICompat,
  'GET /v1/models':                    handleOpenAIModels,

  // ── Librarian（图书管理员：triage / audit / digest）── 嫁接 KB v2 ────────
  'POST /librarian/triage':            handleLibrarianTriage,
  'POST /librarian/audit':             handleLibrarianAudit,
  'POST /librarian/report':            handleLibrarianReport,
  'POST /librarian/machine-spec':      handleLibrarianMachineSpec,
  'GET /librarian/machine-spec':       handleLibrarianMachineSpecGet,
  'POST /librarian/run':               handleLibrarianRun,

  // ── KB v2（向量检索 + 衰减 + 分类 + intel + vault-sync）────────────────────
  'GET /kb/context':                   handleKbContext,
  'POST /kb/search':                   handleKbSearch,
  'POST /kb/reindex':                  handleKbReindex,
  'POST /kb/remember':                 handleKbRemember,
  'POST /kb/decay':                    handleKbDecay,
  'GET /kb/taxonomy':                  handleKbTaxonomy,
  'POST /kb/maintenance':              handleKbMaintenance,
  'GET /kb/tiers':                     handleKbTiers,
  'POST /kb/backup':                   handleKbBackup,
  'POST /kb/vault-sync':               handleKbVaultSync,
  'POST /kb/meta-extract':             handleKbMetaExtract,
  'GET /kb/health':                    handleKbHealth,
  'POST /intel/ingest':                handleIntelIngest,
  'GET /intel/list':                   handleIntelList,
  'POST /intel/refine':                handleIntelRefine,
  'POST /intel/brief':                 handleIntelBrief,
  'GET /intel/entities':               handleIntelEntities,

  // ── Agent 注册表 (2026-04-19): 统一调 6 个 Python agent ────────────────
  'GET /agents/list':                  handleAgentsList,
  'POST /agents/invoke':               handleAgentsInvoke,

  // ── Skill Miner (2026-04-19): 自动从 feedback 蒸馏 skill proposal ──────
  'POST /evolution/mine-skills':       async (req, res) => {
    try {
      const body = await readBody(req).catch(() => ({}));
      const r = await mineSkills({ dry: body.dry || false });
      send(res, 200, r);
    } catch (err) { sendError(res, 500, err.message); }
  },

  // ── Memory Hygiene Agent (2026-04-19): 清理 + 修复 + 总结 ───────────────
  'POST /memory/hygiene':             async (req, res) => {
    try {
      const body = await readBody(req).catch(() => ({}));
      const { scanHygiene, applyHygiene } = await import('./memory/hygiene.mjs');
      const r = body.apply
        ? await applyHygiene({ types: body.types, useLlm: body.useLlm !== false })
        : await scanHygiene({ types: body.types });
      send(res, 200, r);
    } catch (err) { sendError(res, 500, err.message); }
  },

  // ── Connectors API (2026-04-19): 列出 connector 状态 + 强制 rediscover ──
  'GET /connectors/list':             async (req, res) => {
    try {
      const { getState } = await import('./connectors/discovery.mjs');
      const state = getState();
      const connectors = [...(state?.values?.() || [])].map(c => ({
        id: c.id, type: c.type, status: c.status, version: c.version,
        path: c.path, error: c.lastError, last_check: c.lastCheck,
      }));
      send(res, 200, { ok: true, count: connectors.length, connectors });
    } catch (err) { sendError(res, 500, err.message); }
  },
  'POST /connectors/rediscover':      async (req, res) => {
    try {
      const { discoverAll } = await import('./connectors/discovery.mjs');
      const state = await discoverAll();
      send(res, 200, { ok: true, count: state.size });
    } catch (err) { sendError(res, 500, err.message); }
  },

  // ── External Scout (2026-04-19): 周期检查外部更优 → 提议升级 ──────────
  'POST /evolution/scout':            async (req, res) => {
    try {
      const body = await readBody(req).catch(() => ({}));
      const { scoutExternal } = await import('./evolution/external-scout.mjs');
      const r = await scoutExternal(body);
      send(res, 200, r);
    } catch (err) { sendError(res, 500, err.message); }
  },

  // ── Task Planner (2026-04-19): 任务来 → 自动搜 skill+agent+warning ─────
  'POST /task/plan':                  async (req, res) => {
    try {
      const body = await readBody(req).catch(() => ({}));
      const { planTask, logTaskPlan } = await import('./task/task-planner.mjs');
      const r = await planTask(body);
      // 反哺: 异步记录此次规划 (skill-miner 学 intent→capability 映射)
      if (r.ok && body.skipLog !== true) { try { logTaskPlan(r); } catch {} }
      send(res, r.ok ? 200 : 400, r);
    } catch (err) { sendError(res, 500, err.message); }
  },
};

// ── 动态前缀路由（pattern-based） ────────────────────────────────────────
// /products/:product/:method — 调用产品 adapter，走 L0-L3 门控 + 审计
const PREFIX_ROUTES = [
  { method: 'POST', prefix: '/products/', handler: handleProductInvoke },
];

// ---------------------------------------------------------------------------
// 请求处理工具
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1024 * 512; // 512KB 硬上限，防止 DoS

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      // Buffer.concat 后统一 UTF-8 decode，避免多字节字符跨 chunk 被截断乱码
      const body = Buffer.concat(chunks).toString('utf8');
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const AI_PRS_DIR_ABS = resolve(KERNEL_ROOT, 'evolution/ai-prs');

/**
 * 验证路径在允许目录内，防止路径穿越攻击
 */
function assertSafePath(inputPath, allowedDir) {
  const normalized = normalize(resolve(inputPath));
  const base = normalize(resolve(allowedDir));
  // C018 fix: 使用 path.sep 而非硬编码 '/'，Windows 下路径分隔符为 '\'
  if (!normalized.startsWith(base + sep) && normalized !== base) {
    throw new Error(`Path traversal blocked: ${inputPath}`);
  }
  return normalized;
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  send(res, status, { ok: false, error: message });
}

// ---------------------------------------------------------------------------
// 处理函数
// ---------------------------------------------------------------------------

function handleHealth(req, res) {
  const integrity = verifyAllLogs();
  const tampered = integrity.filter(r => !r.ok && r.reason === 'hash_mismatch');
  send(res, 200, {
    ok: true,
    version: '1.0',
    kernel_root: KERNEL_ROOT,
    log_integrity: tampered.length === 0 ? 'clean' : 'TAMPERED',
    tampered_files: tampered.map(r => r.path),
  });
}

// ---------------------------------------------------------------------------
// Dashboard — 综合健康面板
// ---------------------------------------------------------------------------

/**
 * Gemini ping: POST a minimal prompt with 3s timeout.
 * Returns { status, model, latency_ms } or { status: 'error', error }.
 */
function _pingGemini() {
  const apiKey = process.env.GEMINI_API_KEY || '';
  const model = getLatestModel('gemini_flash');
  if (!apiKey) {
    return Promise.resolve({ status: 'no_api_key', model, latency_ms: null });
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const payload = JSON.stringify({
    contents: [{ parts: [{ text: 'hi' }] }],
    generationConfig: { maxOutputTokens: 4 },
  });
  const start = Date.now();
  const request = new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: 'healthy', model, latency_ms: Date.now() - start });
        } else {
          resolve({ status: 'error', model, latency_ms: Date.now() - start, error: `HTTP ${res.statusCode}` });
        }
      });
    });
    req.on('error', (err) => resolve({ status: 'error', model, latency_ms: Date.now() - start, error: err.message }));
    req.write(payload);
    req.end();
  });
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ status: 'timeout', model, latency_ms: 3000 }), 3000)
  );
  return Promise.race([request, timeout]);
}

/**
 * 检测各 product adapter 是否存在且可加载。
 */
function _checkProducts() {
  const productsDir = join(KERNEL_ROOT, 'products');
  const result = {};
  try {
    const dirs = readdirSync(productsDir).filter(d => {
      try { return statSync(join(productsDir, d)).isDirectory(); }
      catch { return false; }
    });
    for (const d of dirs) {
      const mjsPath = join(productsDir, d, 'adapter.mjs');
      const pyPath  = join(productsDir, d, 'adapter.py');
      if (existsSync(mjsPath) || existsSync(pyPath)) {
        result[d] = 'ok';
      } else {
        result[d] = 'missing_adapter';
      }
    }
  } catch (err) {
    result._error = err.message;
  }
  return result;
}

/**
 * 获取 D: 盘可用空间（Windows wmic / PowerShell），失败返回 null。
 */
function _getDiskFreeGB() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-PSDrive D).Free"',
      { timeout: 3000, encoding: 'utf8', windowsHide: true }
    ).trim();
    const bytes = parseInt(out, 10);
    return isNaN(bytes) ? null : Math.round(bytes / (1024 ** 3));
  } catch {
    return null;
  }
}

async function handleDashboard(req, res) {
  const mem = process.memoryUsage();
  const integrity = verifyAllLogs();
  const tampered = integrity.filter(r => !r.ok && r.reason === 'hash_mismatch');

  // Gemini ping (non-blocking, 3s cap)
  const geminiPromise = _pingGemini();

  // Products
  const products = _checkProducts();

  // Disk (sync but fast via powershell, cached inline)
  const diskFreeGB = _getDiskFreeGB();

  // Await Gemini
  const gemini = await geminiPromise;

  const uptimeSec = Math.floor(process.uptime());

  const payload = {
    ok: true,
    timestamp: new Date().toISOString(),
    uptime_seconds: uptimeSec,
    services: {
      nova_kernel: {
        status: tampered.length === 0 ? 'healthy' : 'log_tampered',
        memory_mb: Math.round(mem.rss / (1024 * 1024)),
        heap_used_mb: Math.round(mem.heapUsed / (1024 * 1024)),
        tasks_cached: _taskResults.size,
        log_integrity: tampered.length === 0 ? 'clean' : 'TAMPERED',
        tampered_files: tampered.map(r => r.path),
        last_gap_scan: _lastGapScanTime,
      },
      gemini_api: gemini,
      feishu_bridge: { status: 'unknown' },
      products,
    },
    system: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      disk_free_gb: diskFreeGB,
    },
  };

  // Feishu bridge: best-effort check on localhost:3700 sibling process
  // (bridge typically runs on a different port; mark as unknown for now)

  // Circuit breaker states for all external service calls
  payload.services.circuit_breakers = getAllBreakerStates();

  // AI worker health status (per-provider availability)
  payload.services.worker_health = getWorkerHealthStatus();

  // Model version checker status (configured vs available, deprecation alerts)
  payload.model_versions = getModelVersionReport();

  // Model auto-discovery status (live registry from API queries)
  payload.model_discovery = getDiscoveryReport();

  send(res, 200, payload);
}

/**
 * 内部任务派发核心逻辑（不依赖 HTTP req/res，供 handleTaskDispatch 和 handleChat 复用）
 * @param {object} body — 任务体，字段同 POST /task/dispatch
 * @returns {{ ok: boolean, task_id: string, risk_level: string, status: string, routing: object }}
 */
async function _dispatchTaskInternal(body) {
  if (!body.task_id)   body.task_id   = generateTaskId(body.project || 'unknown');
  if (!body.risk_level) body.risk_level = classifyRisk(body.prompt || '', body.write_paths || []);
  body.worker = resolveWorker(body.complexity || 2, body.risk_level, body.worker || '');

  validateTaskInput(body);

  auditLog({
    event: 'task.received',
    operator: `product:${body.project}`,
    target: body.task_id,
    detail: { worker: body.worker, risk_level: body.risk_level, complexity: body.complexity },
    session: body.session_id,
  });

  if (body.risk_level === 'L3') {
    return blockL3({
      taskId:    body.task_id,
      project:   body.project || 'unknown',
      prompt:    body.prompt || '',
      operator:  `product:${body.project || 'unknown'}`,
      sessionId: body.session_id,
      writePaths: body.write_paths || [],
      worker:    body.worker,
    });
  }

  const complexity = body.complexity || 2;
  // 当有 task_type 时，让 task-router 决定模型；没有时走旧的 resolveModel
  const hasTaskType = !!body.task_type;
  const routing = {
    worker:          body.worker,
    suggested_model: hasTaskType ? null : resolveModel(body.worker, complexity),
    complexity,
    timeout_ms:      body.timeout_ms || 120000,
  };

  setImmediate(async () => {
    try {
      const execResult = await executeWithAI({
        task_id:         body.task_id,
        prompt:          body.prompt,
        worker:          body.worker,
        suggested_model: routing.suggested_model,  // null when task_type present → task-router decides
        task_type:       body.task_type || null,
        complexity,
        context:         body.context || {},
        timeout_ms:      routing.timeout_ms,
      });

      const taskResult = {
        task_id:      body.task_id,
        status:       execResult.ok
                        ? 'pass'
                        : (execResult.error?.includes('timeout') ? 'timeout' : 'fail'),
        worker:       body.worker,
        actual_model: execResult.model || routing.suggested_model,
        provider:     execResult.provider || null,
        taskType:     execResult.taskType || null,
        output:       execResult.output || null,
        error:        execResult.error  || null,
        time_ms:      execResult.time_ms,
        completed_at: new Date().toISOString(),
      };
      _cacheTaskResult(body.task_id, taskResult);

      auditLog({
        event:    execResult.ok ? 'task.completed' : 'task.failed',
        operator: `worker:${body.worker}`,
        target:   body.task_id,
        detail:   {
          model:      execResult.model,
          time_ms:    execResult.time_ms,
          ok:         execResult.ok,
          output_len: execResult.output?.length || 0,
          error:      execResult.error,
        },
      });

      if (execResult.ok) {
        console.log(`[Nova Kernel][exec] task=${body.task_id} model=${execResult.model} time=${execResult.time_ms}ms`);
      } else {
        console.error(`[Nova Kernel][exec] task=${body.task_id} FAILED: ${execResult.error}`);
      }

      // ── 知识库自动归档（异步，不阻塞任务返回）──────────────
      archiveTaskResult(taskResult).catch(err =>
        console.error('[knowledge-bridge] 归档失败（不影响任务）:', err.message)
      );

      if (process.env.FEISHU_WEBHOOK_URL) {
        try {
          await sendCard('task_result', {
            task_id:    body.task_id,
            project:    body.project || 'unknown',
            status:     execResult.ok ? 'ok' : 'fail',
            summary:    execResult.ok
              ? (execResult.output || '').slice(0, 500)
              : `错误: ${execResult.error || '未知'}`,
            risk_level: body.risk_level,
          });
        } catch (e) { console.error('[Nova Kernel][exec] 飞书结果通知失败:', e.message); }
      }
    } catch (err) {
      console.error(`[Nova Kernel][exec] task=${body.task_id} unhandled:`, err.message);
    }
  });

  return { ok: true, task_id: body.task_id, risk_level: body.risk_level, status: 'accepted', routing };
}

async function handleTaskDispatch(req, res) {
  if (!_assertInternalAuth(req, res)) return;
  try {
    const body   = await readBody(req);
    const result = await _dispatchTaskInternal(body);
    // L3 阻塞返回 202，其余 200
    send(res, result.status === 'blocked' ? 202 : 200, result);
  } catch (err) {
    sendError(res, 400, err.message);
  }
}

/**
 * GET /task/result?task_id=xxx
 * 轮询任务执行结果（异步执行完成后写入 _taskResults 缓存）。
 * 若任务尚未完成或不存在，返回 { ok: false, status: 'pending' }。
 */
function handleTaskResult(req, res) {
  try {
    const url    = new URL(req.url, `http://127.0.0.1`);
    const taskId = url.searchParams.get('task_id');
    if (!taskId) return sendError(res, 400, 'task_id query 参数必填');

    const cached = _taskResults.get(taskId);
    if (!cached) {
      return send(res, 200, { ok: false, status: 'pending', task_id: taskId });
    }
    return send(res, 200, { ok: true, status: 'completed', task_id: taskId, result: cached });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * GET /api/model-stats
 * 返回模型路由统计：调用次数、成本、延迟、节约估算。
 */
function handleModelStats(_req, res) {
  try {
    const stats = getModelStats();
    return send(res, 200, { ok: true, stats });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * GET /api/worker-health
 * Returns per-provider health status, latency, consecutive failures, and recent history.
 */
function handleWorkerHealth(_req, res) {
  try {
    const health = getWorkerHealthStatus();
    return send(res, 200, { ok: true, providers: health });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * POST /api/worker-health/ping
 * Force an immediate health check of all providers. Returns updated status.
 */
async function handleWorkerHealthPing(_req, res) {
  try {
    const health = await pingAllNow();
    return send(res, 200, { ok: true, providers: health });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * GET /api/model-versions
 * Returns model version report: configured models, available models, issues, upgrade suggestions.
 */
function handleModelVersions(_req, res) {
  try {
    const report = getModelVersionReport();
    return send(res, 200, { ok: true, ...report });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * GET /api/model-discovery
 * Returns the live model discovery report: discovered models, errors, source.
 */
function handleModelDiscovery(_req, res) {
  try {
    const report = getDiscoveryReport();
    return send(res, 200, { ok: true, ...report });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * POST /api/model-discovery/refresh
 * Force-triggers a model discovery run across all providers.
 * Returns the updated discovery report.
 */
async function handleModelDiscoveryRefresh(req, res) {
  try {
    const report = await runDiscovery();
    return send(res, 200, { ok: true, refreshed: true, ...report });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

function handleMemoryRead(req, res) {
  try {
    const memoryPath = join(KERNEL_ROOT, 'kernel/memory/MEMORY.md');
    const userPath = join(KERNEL_ROOT, 'kernel/memory/USER.md');
    send(res, 200, {
      ok: true,
      system_memory: readFileSync(memoryPath, 'utf8'),
      user_model: readFileSync(userPath, 'utf8'),
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleAuditLog(req, res) {
  if (!_assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.event || !body.operator) return sendError(res, 400, 'event 和 operator 必填');
    auditLog(body);
    send(res, 200, { ok: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleDevLog(req, res) {
  if (!_assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    const required = ['project', 'session_id', 'operator', 'phase', 'action', 'result'];
    const missing = required.filter(f => !body[f]);
    if (missing.length > 0) return sendError(res, 400, `缺少必填字段: ${missing.join(', ')}`);

    const logPath = writeDevLog(body);
    send(res, 200, { ok: true, log_path: logPath });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

function handleGapDetect(req, res) {
  try {
    const gaps = detectGaps();
    // 高严重性 gap 自动生成 AI-PR
    const prPaths = gapsToProposals(gaps);
    send(res, 200, {
      ok: true,
      gaps_found: gaps.length,
      gaps,
      report: formatGapReport(gaps),
      ai_prs_generated: prPaths.length,
      ai_pr_paths: prPaths,
      circuit_breaker: getCircuitBreakerState(),
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleGapRepair(req, res) {
  if (!_assertInternalAuth(req, res)) return;
  try {
    const gaps = detectGaps();
    const repairResults = await runAutoRepair(gaps);
    send(res, 200, {
      ok: true,
      gaps_found: gaps.length,
      repairs_attempted: repairResults.length,
      repairs_succeeded: repairResults.filter(r => r.repair.ok).length,
      results: repairResults.map(r => ({ gap_type: r.gap.type, project: r.gap.project, ...r.repair })),
      circuit_breaker: getCircuitBreakerState(),
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

async function handleVetoSweep(req, res) {
  if (!_assertInternalAuth(req, res)) return;
  try {
    const result = await sweepExpiredVetoWindows();
    send(res, 200, {
      ok: true,
      expired_count: result.expired.length,
      vetoed_count: result.vetoed.length,
      expired_paths: result.expired,
      vetoed_paths: result.vetoed,
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * POST /veto
 * Body: { ai_pr_path, veto_actor, veto_reason }
 * 接受人类通过 API 提交的否决请求。
 */
async function handleVeto(req, res) {
  if (!_assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    const { ai_pr_path, veto_actor, veto_reason, pr_id } = body;
    if (!ai_pr_path) return sendError(res, 400, 'ai_pr_path 必填');

    // 路径安全验证：必须在 evolution/ai-prs/ 目录内
    let safePath;
    try {
      safePath = assertSafePath(ai_pr_path, AI_PRS_DIR_ABS);
    } catch {
      return sendError(res, 400, 'ai_pr_path 必须在 evolution/ai-prs/ 目录内');
    }

    if (!existsSync(safePath)) return sendError(res, 404, `AI-PR not found: ${safePath}`);

    const content = readFileSync(safePath, 'utf8');
    const prId = pr_id || content.match(/^pr_id:\s*(.+)$/m)?.[1]?.trim();
    const opType = content.match(/^type:\s*(.+)$/m)?.[1]?.trim() || 'arch_change';
    const skillName = content.match(/^skill_name:\s*(.+)$/m)?.[1]?.trim();

    // 标记 DB 状态
    if (prId) markVetoed({ prId, vetoActor: veto_actor || 'api', vetoReason: veto_reason || '' });

    // 执行回滚
    const result = await executeRollback({
      prId: prId || safePath,
      aiPrPath: safePath,
      operationType: opType,
      vetoActor: veto_actor || 'api',
      vetoReason: veto_reason || '',
      skillName,
    });

    send(res, 200, { ok: true, pr_id: prId, rollback: result });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

function handleListVetoWindows(req, res) {
  try {
    const windows = getActiveVetoWindows();
    send(res, 200, {
      ok: true,
      count: windows.length,
      windows: windows.map(w => ({
        ...w,
        deadline_iso: new Date(w.deadline_at * 1000).toISOString(),
        remaining_hours: ((w.deadline_at - Date.now() / 1000) / 3600).toFixed(1),
      })),
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

function handleListPRs(req, res) {
  try {
    send(res, 200, { ok: true, proposals: listProposals() });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

function handleListPendingPRs(req, res) {
  try {
    send(res, 200, { ok: true, proposals: listProposals('pending') });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * POST /intent
 * Body: { text: "自然语言指令", context?: { session_id, user, project } }
 * 解析意图并路由到对应域（commerce-ops/media-forge/enterprise-ai）。
 */
async function handleIntent(req, res) {
  if (!_assertInternalAuth(req, res)) return; // C015
  try {
    const body   = await readBody(req);
    const result = await handleIntentRoute(body);
    send(res, result.ok || result.needsClarification ? 200 : 400, result);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * POST /initiative/scan
 * Body: { briefing?: boolean }  briefing=true 时额外生成日报并写 audit-human/
 * 手动触发主动引擎扫描，等同于定时调度一次。
 */
async function handleInitiativeScan(req, res) {
  if (!_assertInternalAuth(req, res)) return; // C015
  try {
    const body   = await readBody(req);
    const result = await runInitiativeScan({ briefing: !!body.briefing });
    send(res, 200, {
      ok:              true,
      findings_count:  result.findings.length,
      findings:        result.findings.map(f => ({ type: f.type, severity: f.severity, message: f.message, action: f.action })),
      decisions:       result.decisions.map(d => ({ type: d.finding.type, decided_action: d.decided_action, result: d.result })),
      log_path:        result.log_path || null,
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * POST /chat
 * Body: { text, user? }
 * 纯闲聊模式：Gemini Flash + 人设 prompt，同步返回 AI 回复。
 * 模型：GEMINI_FLASH_MODEL（轻量，成本最低）
 * 人设：NOVA_CHAT_NAME + NOVA_CHAT_PERSONA（.env 可配置）
 */
const CHAT_NAME    = process.env.NOVA_CHAT_NAME    || '胡桃';
const CHAT_PERSONA = process.env.NOVA_CHAT_PERSONA ||
  `你是${CHAT_NAME}，Nova Kernel 的 AI 助手。`;

// 可用模块说明（供 AI 理解派发目标）
const CHAT_MODULES_DESC = `
可用模块（domain）：
- commerce-ops：商品上架、SEO/文案、报表、改价、广告、评论
- media-forge：去背、模特图、视频切片、直播切片、以图搜图
- enterprise-ai：设计趋势、采购、QC、WMS、客服、VIP`.trim();

// complexity 参考：1=问答, 2=普通任务, 3=复杂分析, 4=大型工程, 5=深度推理
const CHAT_SYSTEM_PROMPT = `${CHAT_PERSONA}

你可以和用户自然对话，也可以帮用户执行任务。

## 核心判断规则（严格遵守）

**默认是聊天。** 以下情况都是聊天，绝对不加 [TASK] 标记：
- 问候（你好、嗨、早上好）
- 闲聊（天气、心情、日常、"聊聊"、"随便说说"）
- 提问但不需要执行（"什么是X"、"你觉得呢"、"怎么看"）
- 任何没有明确要求你**执行操作**的消息

**只有明确要求你做具体工作时才是任务：**
- 「帮我写…」「给我生成…」「做一下…」「执行…」「分析一下这个数据…」「部署…」
- 关键词：帮我、给我、替我、做一个、写一个、生成、创建、分析、执行、部署、修复

## 回复格式

聊天 → 简短自然回复，不超过 80 字，不加任何标记。
任务 → 第一行必须是：[TASK domain=<模块> complexity=<数字>]
      然后接你对用户说的话。

${CHAT_MODULES_DESC}

complexity：1=问答, 2=普通, 3=复杂, 4=大型, 5=深度推理`;

/**
 * 解析 AI 回复首行的 [TASK domain=xxx complexity=N] 标记。
 * @returns {{ domain: string, complexity: number } | null}
 */
function _parseChatTaskDirective(text) {
  // 匹配多种格式：[TASK domain=xxx complexity=N] 或 [TASK xxx complexity=N] 或 [TASK domain=xxx N]
  const m = text.match(/^\[TASK\s+(?:domain=)?(\w+)(?:\s+(?:complexity=)?(\d+))?\]/);
  if (!m) return null;
  return { domain: m[1], complexity: parseInt(m[2] || '2', 10) };
}

// ─── handleOpenAICompat / handleOpenAIModels 已抽到 server/handlers/openai-compat.mjs
// ─── handleProductInvoke / handleMemory* / handleCouncil* 已抽到 server/handlers/{products,memory,council}.mjs

/**
 * POST /chat
 * Body: { text, user? }
 * AI 对话模式：理解意图后自然回复，或自动派发任务（带 [TASK] 标记时）。
 * 模型：GEMINI_FLASH_MODEL（轻量，延迟低）
 */
async function handleChat(req, res) {
  try {
    const body = await readBody(req);
    if (!body.text) return sendError(res, 400, 'text 必填');

    const userText = body.text;

    // ── 知识库 RAG 注入：检测知识查询类问题，自动检索上下文 ──────
    let ragContext = '';
    const isKnowledgeQuery = /之前|上次|怎么.*修|怎么.*设计|为什么.*选|历史|记录|决策|教训|架构.*怎么/.test(userText);

    if (isKnowledgeQuery && await isKnowledgeAvailable()) {
      try {
        const rag = await queryKnowledge(userText, 'query');
        if (rag.ok && rag.confidence === 'high' && rag.answer) {
          ragContext = `\n\n[以下是从知识库检索到的相关背景，供你参考回答用户]\n${rag.answer}\n[知识库引用完毕，来源: ${rag.sources.join(', ')}]\n`;
        }
      } catch (e) {
        // RAG 失败不影响正常聊天
      }
    }

    const prompt = `${CHAT_SYSTEM_PROMPT}${ragContext}\n\n用户说：${userText}`;
    const aiResult = await executeWithAI({
      task_id:         `chat-${Date.now()}`,
      prompt,
      worker:          'gemini',
      task_type:       'chat',
      complexity:      1,
      context:         {},
      timeout_ms:      40000,
    });

    if (!aiResult.ok) {
      return send(res, 200, { ok: true, reply: `${CHAT_NAME}开小差了，稍后再聊～`, dispatched: false });
    }

    const output    = aiResult.output || '';
    const directive = _parseChatTaskDirective(output);

    if (directive) {
      const reply = output.replace(/^\[TASK[^\]]*\]\n?/, '').trim();
      const dispatchedTaskType = inferTaskType(userText, null, directive.complexity);

      _dispatchTaskInternal({
        project:    directive.domain,
        prompt:     userText,
        complexity: directive.complexity,
        task_type:  dispatchedTaskType,
        worker:     '',
        task_id:    '',
        session_id: `chat-${(body.user || 'feishu').slice(0, 12)}-${Date.now()}`,
        context:    {},
      }).catch(e => console.error('[chat] dispatch error:', e.message));

      return send(res, 200, { ok: true, reply, dispatched: true, domain: directive.domain, taskType: dispatchedTaskType });
    }

    // ── 飞书对话自动归档（异步，不阻塞响应）──────────────
    archiveFeishuChat(userText, output, body.user || 'unknown').catch(() => {});

    send(res, 200, { ok: true, reply: output, dispatched: false, ragEnhanced: !!ragContext });
  } catch (err) {
    send(res, 200, { ok: true, reply: `${CHAT_NAME}开小差了，稍后再聊～`, dispatched: false });
  }
}

/**
 * GET /initiative/confirms — F-008: 列出待确认的高危操作
 */
function handleListConfirms(req, res) {
  if (!_assertInternalAuth(req, res)) return;
  try {
    const confirms = listPendingConfirms();
    send(res, 200, { ok: true, count: confirms.length, confirms });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * POST /initiative/confirms/resolve — F-008: 确认或否决高危操作
 * Body: { confirm_id, approved: boolean }
 */
async function handleResolveConfirm(req, res) {
  if (!_assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.confirm_id) return sendError(res, 400, 'confirm_id 必填');
    if (typeof body.approved !== 'boolean') return sendError(res, 400, 'approved 必须为 boolean');
    const result = await resolveConfirm(body.confirm_id, body.approved);
    send(res, 200, result);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

/**
 * POST /feishu/event
 * 接收飞书事件订阅推送（机器人收到消息 → 意图路由 → 回复）。
 * Header: X-Lark-Request-Timestamp / X-Lark-Request-Nonce / X-Lark-Signature
 */
async function handleFeishuEvent(req, res) {
  try {
    const body      = await readBody(req);
    const timestamp = req.headers['x-lark-request-timestamp'] || '';
    const nonce     = req.headers['x-lark-request-nonce']     || '';
    const signature = req.headers['x-lark-signature']         || '';

    const verified = verifyInboundEvent(body, { timestamp, nonce, signature });

    // URL 验证挑战（飞书首次配置时）
    if (verified.challenge) {
      return send(res, 200, { challenge: verified.challenge });
    }

    if (!verified.ok) {
      return sendError(res, 401, verified.error || '签名验证失败');
    }

    // C019: nonce 去重，防重放
    if (nonce && !_checkAndMarkNonce(nonce)) {
      return sendError(res, 401, 'nonce 重放，请求已拒绝');
    }

    // 先应答 200（飞书要求 3s 内响应）
    send(res, 200, { ok: true });

    // C016: 异步处理，各步骤独立错误隔离
    setImmediate(async () => {
      const event  = verified.event;
      if (event?.header?.event_type !== 'im.message.receive_v1') return;

      const text   = extractMessageText(event);
      const sender = extractSender(event);
      if (!text) return;

      // Step 1: 审计入站（独立保护）
      try {
        auditLog({
          event:    'feishu.message.received',
          operator: `feishu:${sender.openId || 'unknown'}`,
          target:   sender.chatId || 'unknown',
          detail:   { text: text.slice(0, 200) },
        });
      } catch (e) { console.error('[feishu] auditLog(received) 失败:', e.message); }

      // Step 1.5a: 博主蒸馏指令检测（"蒸馏 URL"）
      const personaMatch = text.match(/蒸馏\s+(https?:\/\/[^\s]+)/);
      if (personaMatch) {
        // P1-2 fix: single video URLs (e.g. /watch?v=, /video/BV) are not channel/space pages
        const personaUrl = personaMatch[1];
        const isSingleVideo = /youtube\.com\/watch\?|youtu\.be\/[a-zA-Z0-9_-]{11}|bilibili\.com\/video\/BV/i.test(personaUrl);
        if (isSingleVideo) {
          await sendText(`请提供博主主页链接，而非单个视频链接。\nB站示例: https://space.bilibili.com/UID\nYouTube示例: https://www.youtube.com/@频道名`);
          return;
        }
        try {
          const { buildPersona } = await import('./services/persona-builder.mjs');
          await sendText('🧠 开始蒸馏博主 AI 分身，这需要较长时间，完成后通知你...');
          // P2-4 fix: sendText(text) takes one arg — webhook bot, no per-user routing
          const result = await buildPersona({
            url: personaUrl,
            onProgress: (msg) => sendText(msg).catch(() => {}),
          });
          if (result.ok) {
            await sendText(`✅ ${result.creator} 的 AI 分身已生成！\n分析了 ${result.stats.analyzed}/${result.stats.total_videos} 个视频\n保存到: personas/${result.creator}`);
          } else {
            await sendText(`⚠️ 蒸馏失败: ${result.reason}`);
          }
        } catch (e) { console.error('[feishu] persona build error:', e.message); }
        return;
      }

      // Step 1.5b: URL 检测 → 自动知识提取（不阻塞聊天）
      // P1-1 fix: strip trailing CJK/ASCII punctuation that regex greedily captures
      const detectedUrls = (text.match(/(https?:\/\/[^\s<>"'）】。，、：！？…]+)/g) || [])
        .map(u => u.replace(/[.,;:!?)。，、：！？…]+$/, ''));
      const maxUrls = parseInt(process.env.CONTENT_EXTRACTOR_MAX_URLS_PER_MSG) || 3;
      if (detectedUrls && detectedUrls.length > 0) {
        try {
          const { extractAndIngest } = await import('./services/content-extractor.mjs');
          const results = [];
          for (const url of detectedUrls.slice(0, maxUrls)) {
            results.push(await extractAndIngest(url));
          }
          const summary = results.map(r => {
            if (r.skipped) return `⏭️ ${r.reason}`;
            if (!r.ok) return `⚠️ ${r.reason || '提取失败'}`;
            return `✅ ${r.title} → [${r.category}]`;
          }).join('\n');
          // P2-4 fix: sendText(text) — webhook bot takes text only
          try { await sendText(`📚 知识提取完成：\n${summary}`); } catch {}
          // 如果消息纯链接，不再走聊天
          if (text.replace(/(https?:\/\/[^\s<>"'）】]+)/g, '').trim().length < 5) return;
        } catch (e) {
          console.error('[feishu] URL 提取失败:', e.message);
        }
      }

      // Step 2: 通过 /chat 逻辑处理（AI 自行判断聊天还是任务）
      let replyText;
      let dispatched = false;
      let domain = '';
      try {
        // RAG 注入（和 handleChat 一致）
        let ragContext = '';
        const isKnowledgeQuery = /之前|上次|怎么.*修|怎么.*设计|为什么.*选|历史|记录|决策|教训|架构.*怎么/.test(text);
        if (isKnowledgeQuery && await isKnowledgeAvailable()) {
          try {
            const rag = await queryKnowledge(text, 'query');
            if (rag.ok && rag.confidence === 'high' && rag.answer) {
              ragContext = `\n\n[知识库背景]\n${rag.answer}\n[引用: ${rag.sources.join(', ')}]\n`;
            }
          } catch {}
        }

        const chatPrompt = `${CHAT_SYSTEM_PROMPT}${ragContext}\n\n用户说：${text}`;
        const aiResult = await executeWithAI({
          task_id:         `feishu-chat-${Date.now()}`,
          prompt:          chatPrompt,
          worker:          'gemini',
          task_type:       'chat',
          complexity:      1,
          context:         {},
          timeout_ms:      40000,
        });

        if (aiResult.ok) {
          const output    = aiResult.output || '';
          const directive = _parseChatTaskDirective(output);
          if (directive) {
            replyText  = output.replace(/^\[TASK[^\]]*\]\n?/, '').trim();
            dispatched = true;
            domain     = directive.domain;
            const feishuTaskType = inferTaskType(text, null, directive.complexity);
            _dispatchTaskInternal({
              project:    directive.domain,
              prompt:     text,
              complexity: directive.complexity,
              task_type:  feishuTaskType,
              worker:     '',
              task_id:    '',
              session_id: `feishu-${(sender.openId || '').slice(0, 12)}-${Date.now()}`,
              context:    {},
            }).catch(e => console.error('[feishu] dispatch error:', e.message));
          } else {
            replyText = output;
          }
        } else {
          replyText = `${CHAT_NAME}开小差了，稍后再聊～`;
        }
      } catch (e) {
        console.error('[feishu] chat 处理失败:', e.message);
        replyText = `${CHAT_NAME}开小差了，稍后再聊～`;
      }

      // Step 3: 回复用户（独立保护）
      if (process.env.FEISHU_WEBHOOK_URL) {
        try {
          await sendText(`[@${sender.openId || '你'}] ${replyText}`);
        } catch (e) { console.error('[feishu] sendText 失败:', e.message); }
      }

      // Step 4: 审计出站（独立保护）
      try {
        auditLog({
          event:    dispatched ? 'feishu.task.dispatched' : 'feishu.message.replied',
          operator: 'nova-kernel',
          target:   sender.chatId || 'unknown',
          detail:   { domain, dispatched, replyLen: replyText?.length || 0 },
        });
      } catch (e) { console.error('[feishu] auditLog(replied) 失败:', e.message); }
    });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

// 全局请求超时（防止 worker 卡住整个 HTTP 层）
// 议会后台投票 / AI 调用走专有超时，这里是 HTTP 请求处理的兜底
const REQUEST_TIMEOUT_MS = parseInt(process.env.NOVA_REQUEST_TIMEOUT_MS || '60000', 10);
// 长任务端点超时（多模型串联的 pipeline / council 提交等，默认 5 分钟）
// 原因：/pipeline/debate 等需要同时跑两个 thinking 模型，常规 60s 经常打不住
const LONG_REQUEST_TIMEOUT_MS = parseInt(process.env.NOVA_LONG_REQUEST_TIMEOUT_MS || '300000', 10);

// 需要使用长超时的端点前缀（调重活儿的 LLM 流水线 / 议会投票 / 产品 adapter）
const LONG_RUNNING_PATH_PREFIXES = [
  '/pipeline/',       // debate / code-task / run / codex-fix / codex-review
  '/council/submit',  // 议会提交触发三方模型投票（投票本身是后台，这里防止同步阻塞）
  '/products/',       // 产品 adapter：commerce-ops LLM 调用 30-60s、claude-design Playwright 几分钟
];

function pickRequestTimeoutMs(path) {
  if (LONG_RUNNING_PATH_PREFIXES.some(p => path.startsWith(p))) return LONG_REQUEST_TIMEOUT_MS;
  return REQUEST_TIMEOUT_MS;
}

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  const key = `${req.method} ${path}`;
  let handler = ROUTES[key];

  // 前缀路由兜底
  if (!handler) {
    const prefixMatch = PREFIX_ROUTES.find(
      r => r.method === req.method && path.startsWith(r.prefix)
    );
    if (prefixMatch) handler = prefixMatch.handler;
  }

  if (!handler) {
    return sendError(res, 404, `Unknown endpoint: ${key}`);
  }

  // 请求超时兜底：超过 N 秒强制返回 504
  // 长流水线端点使用更长的超时（LONG_REQUEST_TIMEOUT_MS），其他保持 REQUEST_TIMEOUT_MS
  const chosenTimeoutMs = pickRequestTimeoutMs(path);
  const timeoutTimer = setTimeout(() => {
    if (!res.headersSent) {
      try { sendError(res, 504, `Gateway timeout: ${key} 超过 ${chosenTimeoutMs}ms`); } catch {}
    }
  }, chosenTimeoutMs);

  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[Nova Kernel] Unhandled error on ${key}:`, err);
    if (!res.headersSent) sendError(res, 500, 'Internal kernel error');
  } finally {
    clearTimeout(timeoutTimer);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Nova Kernel] HTTP server running on http://127.0.0.1:${PORT}`);
  console.log(`[Nova Kernel] Kernel root: ${KERNEL_ROOT}`);
  console.log(`[Nova Kernel] Endpoints: ${Object.keys(ROUTES).join(', ')}`);
  logModelConfig();

  // ── Model Auto-Discovery (queries provider APIs for latest models) ───
  startModelDiscovery();

  // ── AI Worker Health Monitor ───────────────────────────────────────────
  startHealthMonitor();

  // ── Model Version Checker (startup validation + daily refresh) ────────
  startModelChecker();

  // ── Claude Code 记忆自动同步（启动时拉 + 文件 watcher）────────────────
  startAutoSync();

  // ── 反向同步：nova-inbox/ 目录 watcher（Antigravity/Codex 写文件回 Nova）
  startInboxWatcher();

  // ── 零信任：未授权写入检测（Opus 建议 — 防君子协议被绕过）
  import('./locks/unauthorized-write-detector.mjs').then(({ startUnauthorizedWriteDetector }) =>
    startUnauthorizedWriteDetector()
  );

  // ── 自我维护循环：定时刷新架构快照 / gap 扫描 / 健康日报
  import('./self-maintenance.mjs').then(({ startSelfMaintenance }) => startSelfMaintenance());

  // ── 架构自动快照（每次启动更新 nova-architecture-current 记忆）──────────
  // 这样 Codex/Antigravity 下次读 AGENTS.md/GEMINI.md 就能看到 Nova 当前架构
  (async () => {
    try {
      const { updateArchitectureSnapshot } = await import('./memory/architecture-snapshot.mjs');
      const entry = await updateArchitectureSnapshot();
      if (entry) console.log(`[arch-snapshot] 架构快照已更新（id=${entry.id.slice(0,8)}，${entry.body.length} 字符）`);
    } catch (e) { console.warn('[arch-snapshot] 失败:', e.message); }
  })();

  // ── 定时调度器（带并发锁，防止重叠执行）────────────────────────────────
  let _sweepRunning = false;
  let _gapRunning = false;

  // 每 5 分钟：扫描过期否决窗口 + 检测人工 VETO 标记
  setInterval(async () => {
    if (_sweepRunning) return; // 上次未完成，跳过本次
    _sweepRunning = true;
    try {
      const result = await sweepExpiredVetoWindows();
      if (result.expired.length > 0 || result.vetoed.length > 0) {
        console.log(`[Nova Kernel][sweep] expired=${result.expired.length} vetoed=${result.vetoed.length}`);
      }
    } catch (err) {
      console.error('[Nova Kernel][sweep] error:', err.message);
    } finally {
      _sweepRunning = false;
    }
  }, 5 * 60 * 1000);

  // 每 30 分钟：运行 gap 检测 + 自主修复
  setInterval(async () => {
    if (_gapRunning) return;
    _gapRunning = true;
    try {
      _lastGapScanTime = new Date().toISOString();
      const gaps = detectGaps();
      if (gaps.length > 0) {
        const repairs = await runAutoRepair(gaps);
        const ok = repairs.filter(r => r.repair.ok).length;
        console.log(`[Nova Kernel][gap-repair] gaps=${gaps.length} repaired=${ok}`);
      }
    } catch (err) {
      console.error('[Nova Kernel][gap-repair] error:', err.message);
    } finally {
      _gapRunning = false;
    }
  }, 30 * 60 * 1000);

  // 每天 08:00：主动引擎日报 + 系统状态扫描
  let _initiativeRunning = false;
  const DAILY_BRIEFING_HOUR = parseInt(process.env.INITIATIVE_BRIEFING_HOUR || '8', 10);
  let _lastBriefingDay = '';
  setInterval(async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() !== DAILY_BRIEFING_HOUR) return;
    if (_lastBriefingDay === today) return; // 当天已生成
    if (_initiativeRunning) return;
    _initiativeRunning = true;
    _lastBriefingDay = today;
    try {
      const result = await runInitiativeScan({ briefing: true });
      console.log(`[Nova Kernel][initiative] 日报生成完成 findings=${result.findings.length} log=${result.log_path}`);
    } catch (err) {
      console.error('[Nova Kernel][initiative] error:', err.message);
    } finally {
      _initiativeRunning = false;
    }
  }, 60 * 1000); // 每分钟检查一次是否到达 08:00
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Nova Kernel] Port ${PORT} already in use. Kill the existing process or set NOVA_KERNEL_PORT to a different port.`);
  } else {
    console.error('[Nova Kernel] Server error:', err);
  }
  process.exit(1);
});

// 全局异常兜底 — 防止 setImmediate 内未捕获的 rejection 在 Node 20+ 终止进程
process.on('unhandledRejection', (err) => {
  console.error('[Nova Kernel] Unhandled promise rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[Nova Kernel] Uncaught exception — shutting down:', err);
  process.exit(1);
});
