/**
 * AI Worker Health Monitor -- continuously checks provider availability
 * and automatically reroutes tasks when a provider goes down.
 *
 * Features:
 *   1. Periodic health ping to each provider (lightweight "hi" prompt)
 *   2. Provider status tracking (healthy / degraded / down)
 *   3. Automatic routing override when provider is down
 *   4. Recovery detection (when downed provider comes back)
 *   5. Health history for dashboard display
 *
 * Status levels:
 *   healthy  -- last ping succeeded, latency < threshold
 *   degraded -- last ping succeeded but latency > threshold, or recent errors > 30%
 *   down     -- last 3+ pings failed, or circuit breaker OPEN
 *   unknown  -- never pinged yet
 *
 * Env vars:
 *   WORKER_HEALTH_INTERVAL_MS  -- ping interval (default 120000 = 2 min)
 *   WORKER_HEALTH_LATENCY_MS   -- degraded-latency threshold (default 10000)
 */

import { callGeminiAPI } from './ai-executor.mjs';
import { callProvider }  from './providers.mjs';
import { geminiBreaker, anthropicSDKBreaker, openaiSDKBreaker } from '../utils/circuit-breaker.mjs';
import { getLatestModel } from '../config/model-discovery.mjs';

// ---------------------------------------------------------------------------
// Configuration (all from env, no hard-coded values)
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS   = parseInt(process.env.WORKER_HEALTH_INTERVAL_MS || '120000', 10);
const PING_TIMEOUT_MS    = 8_000;
const LATENCY_THRESHOLD  = parseInt(process.env.WORKER_HEALTH_LATENCY_MS  || '10000', 10);
const DOWN_THRESHOLD     = 3;   // consecutive failures before marking DOWN
const MAX_HISTORY        = 50;  // history entries per provider

// ---------------------------------------------------------------------------
// Provider status tracking
// ---------------------------------------------------------------------------

/** @typedef {'healthy'|'degraded'|'down'|'unknown'} ProviderStatus */

/**
 * @typedef {Object} ProviderState
 * @property {ProviderStatus} status
 * @property {string|null}  lastPing           ISO timestamp
 * @property {string|null}  lastSuccess        ISO timestamp
 * @property {number|null}  latencyMs
 * @property {number}       consecutiveFailures
 * @property {Array<{time:string, ok:boolean, latency?:number, error?:string, reason?:string}>} history
 */

/** @type {Record<string, ProviderState>} */
const _providerStatus = {
  google:    { status: 'unknown', lastPing: null, lastSuccess: null, latencyMs: null, consecutiveFailures: 0, history: [] },
  anthropic: { status: 'unknown', lastPing: null, lastSuccess: null, latencyMs: null, consecutiveFailures: 0, history: [] },
  openai:    { status: 'unknown', lastPing: null, lastSuccess: null, latencyMs: null, consecutiveFailures: 0, history: [] },
  // CLI providers — 标记为 healthy（CLI 工具已安装，无需 API Key ping）
  // 如果 CLI 调用失败，断路器会标记它们为 down
  claude:    { status: 'healthy', lastPing: null, lastSuccess: null, latencyMs: null, consecutiveFailures: 0, history: [] },
  codex:     { status: 'healthy', lastPing: null, lastSuccess: null, latencyMs: null, consecutiveFailures: 0, history: [] },
};

// ---------------------------------------------------------------------------
// Emergency fallback model map -- cheapest viable model per provider
// Used only when both primary + fallback are down and we need ANY alive provider.
// ---------------------------------------------------------------------------

// Dynamic model resolution -- always gets latest via model-discovery
function _getEmergencyModel(provider) {
  const map = { google: 'gemini_flash', anthropic: 'claude_sonnet', openai: 'openai_mini', claude: 'claude_sonnet', codex: 'codex_full' };
  return getLatestModel(map[provider] || 'gemini_flash');
}

function _getPingModel(provider) {
  const map = { google: 'gemini_flash_lite', anthropic: 'claude_haiku', openai: 'openai_nano' };
  return getLatestModel(map[provider] || 'gemini_flash_lite');
}

// ---------------------------------------------------------------------------
// Circuit-breaker awareness -- also treat OPEN breaker as "down"
// ---------------------------------------------------------------------------

const _breakerMap = {
  google:    geminiBreaker,
  anthropic: anthropicSDKBreaker,
  openai:    openaiSDKBreaker,
};

function _isBreakerOpen(provider) {
  const breaker = _breakerMap[provider];
  if (!breaker) return false;
  const st = breaker.getState();
  return st.state === 'OPEN';
}

// ---------------------------------------------------------------------------
// Ping implementation
// ---------------------------------------------------------------------------

/**
 * Send a lightweight "Reply with OK" ping to a single provider.
 * Updates _providerStatus in-place.
 */
async function _pingProvider(provider) {
  const start  = Date.now();
  const status = _providerStatus[provider];
  status.lastPing = new Date().toISOString();

  // Fast-path: if circuit breaker is OPEN, skip actual network call
  if (_isBreakerOpen(provider)) {
    status.consecutiveFailures = Math.max(status.consecutiveFailures, DOWN_THRESHOLD);
    status.status = 'down';
    status.latencyMs = 0;
    _pushHistory(status, { time: status.lastPing, ok: false, latency: 0, reason: 'circuit_breaker_open' });
    return;
  }

  try {
    let ok = false;

    switch (provider) {
      case 'google': {
        const result = await callGeminiAPI(_getPingModel('google'), 'Reply with OK', PING_TIMEOUT_MS);
        ok = result && result.length > 0;
        break;
      }
      case 'anthropic': {
        if (!process.env.ANTHROPIC_API_KEY) {
          _markMissingKey(status, 'ANTHROPIC_API_KEY');
          return;
        }
        const result = await callProvider('anthropic', _getPingModel('anthropic'), 'Reply with OK', '', {
          timeoutMs: PING_TIMEOUT_MS,
          maxTokens: 10,
        });
        ok = result.ok;
        break;
      }
      case 'openai': {
        if (!process.env.OPENAI_API_KEY) {
          _markMissingKey(status, 'OPENAI_API_KEY');
          return;
        }
        const result = await callProvider('openai', _getPingModel('openai'), 'Reply with OK', '', {
          timeoutMs: PING_TIMEOUT_MS,
          maxTokens: 10,
        });
        ok = result.ok;
        break;
      }
      default:
        return; // unknown provider, skip
    }

    const latency = Date.now() - start;
    status.latencyMs = latency;

    if (ok) {
      status.consecutiveFailures = 0;
      status.lastSuccess = status.lastPing;

      // Recovery detection: log when a previously-down provider comes back
      if (status.status === 'down') {
        console.log(`[worker-health] Provider ${provider} RECOVERED (was down, now responding)`);
      }

      status.status = latency > LATENCY_THRESHOLD ? 'degraded' : 'healthy';
    } else {
      status.consecutiveFailures++;
      status.status = status.consecutiveFailures >= DOWN_THRESHOLD ? 'down' : 'degraded';
    }

    _pushHistory(status, { time: status.lastPing, ok, latency });

  } catch (err) {
    const latency = Date.now() - start;
    status.consecutiveFailures++;
    status.latencyMs = latency;
    status.status = status.consecutiveFailures >= DOWN_THRESHOLD ? 'down' : 'degraded';

    _pushHistory(status, { time: status.lastPing, ok: false, error: (err.message || '').slice(0, 120), latency });

    if (status.consecutiveFailures === DOWN_THRESHOLD) {
      console.error(`[worker-health] Provider ${provider} is DOWN (${DOWN_THRESHOLD} consecutive failures)`);
    }
  }
}

/** Mark provider as down due to missing API key. */
function _markMissingKey(status, keyName) {
  status.status = 'down';
  status.consecutiveFailures = Math.max(status.consecutiveFailures, DOWN_THRESHOLD);
  _pushHistory(status, { time: status.lastPing, ok: false, reason: `${keyName} not configured` });
}

/** Append to history with bounded length. */
function _pushHistory(status, entry) {
  status.history.push(entry);
  if (status.history.length > MAX_HISTORY) {
    status.history.splice(0, status.history.length - MAX_HISTORY);
  }
}

// ---------------------------------------------------------------------------
// Public API: provider availability
// ---------------------------------------------------------------------------

/**
 * Check if a provider is available for routing.
 * Returns false if status is 'down' OR circuit breaker is OPEN.
 */
export function isProviderAvailable(provider) {
  const status = _providerStatus[provider];
  if (!status) return false;
  if (status.status === 'down') return false;
  if (_isBreakerOpen(provider)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public API: health-aware routing
// ---------------------------------------------------------------------------

/**
 * Get the best available provider for a task type, respecting health status.
 *
 * Decision order:
 *   1. Primary provider healthy -> use it (source='primary')
 *   2. Primary down, fallback healthy -> use fallback (source='fallback')
 *   3. Both down -> find ANY healthy provider (source='emergency')
 *   4. All down -> return primary anyway, let circuit breaker handle (source='all_down')
 *
 * @param {string} taskType      Key from ROUTING_TABLE
 * @param {object} routingTable  The ROUTING_TABLE from task-router.mjs
 * @returns {{ provider: string, model: string, source: string }|null}
 */
export function getHealthyRoute(taskType, routingTable) {
  const route = routingTable[taskType];
  if (!route) return null;

  // Resolve modelRole -> actual model ID dynamically
  const primaryModel  = route.model || (route.modelRole ? getLatestModel(route.modelRole) : null);
  const fallbackModel = route.fallbackModel || (route.fallbackModelRole ? getLatestModel(route.fallbackModelRole) : null);

  // 1. Primary healthy -> use it
  if (isProviderAvailable(route.provider)) {
    return { provider: route.provider, model: primaryModel, source: 'primary' };
  }

  // 2. Primary down -> try fallback
  if (route.fallbackProvider && isProviderAvailable(route.fallbackProvider)) {
    console.warn(
      `[worker-health] ${route.provider} is down, routing ${taskType} to fallback: ${route.fallbackProvider}/${fallbackModel}`,
    );
    return { provider: route.fallbackProvider, model: fallbackModel, source: 'fallback' };
  }

  // 3. Both down -> find ANY healthy provider
  for (const [prov, st] of Object.entries(_providerStatus)) {
    if (st.status !== 'down' && !_isBreakerOpen(prov)) {
      console.warn(
        `[worker-health] Both primary+fallback down for ${taskType}, emergency routing to ${prov}`,
      );
      return { provider: prov, model: _getEmergencyModel(prov), source: 'emergency' };
    }
  }

  // 4. All providers down -- return primary anyway (circuit breaker / retry will handle)
  console.error(`[worker-health] ALL providers down! Attempting ${route.provider} anyway.`);
  return { provider: route.provider, model: primaryModel, source: 'all_down' };
}

// ---------------------------------------------------------------------------
// Public API: dashboard / status
// ---------------------------------------------------------------------------

/**
 * Get all provider health statuses (for dashboard / HTTP endpoint).
 * Returns a snapshot -- safe to serialize as JSON.
 */
export function getWorkerHealthStatus() {
  const result = {};
  for (const [provider, status] of Object.entries(_providerStatus)) {
    result[provider] = {
      status:              status.status,
      lastPing:            status.lastPing,
      lastSuccess:         status.lastSuccess,
      latencyMs:           status.latencyMs,
      consecutiveFailures: status.consecutiveFailures,
      recentHistory:       status.history.slice(-10),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Monitor lifecycle
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof setInterval>|null} */
let _healthInterval = null;

/**
 * Start periodic health checks. Idempotent -- calling twice is a no-op.
 * Initial pings are staggered by 5s each to avoid thundering-herd on startup.
 */
export function startHealthMonitor() {
  if (_healthInterval) return; // already running

  console.log(`[worker-health] Health monitor started (interval: ${PING_INTERVAL_MS}ms, latency threshold: ${LATENCY_THRESHOLD}ms)`);

  // Staggered initial pings
  setTimeout(() => _pingProvider('google'),    5_000);
  setTimeout(() => _pingProvider('anthropic'), 10_000);
  setTimeout(() => _pingProvider('openai'),    15_000);

  // Periodic pings -- sequential to avoid simultaneous load spikes
  _healthInterval = setInterval(async () => {
    await _pingProvider('google');
    await _pingProvider('anthropic');
    await _pingProvider('openai');
  }, PING_INTERVAL_MS);

  // Don't keep the process alive just for health checks
  if (_healthInterval.unref) _healthInterval.unref();
}

/**
 * Stop periodic health checks. Idempotent.
 */
export function stopHealthMonitor() {
  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
    console.log('[worker-health] Health monitor stopped');
  }
}

/**
 * Force an immediate ping of all providers (for testing / manual trigger).
 * Returns the updated status snapshot.
 */
export async function pingAllNow() {
  await _pingProvider('google');
  await _pingProvider('anthropic');
  await _pingProvider('openai');
  return getWorkerHealthStatus();
}
