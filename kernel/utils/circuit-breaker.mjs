/**
 * Generic Circuit Breaker — protects external service calls.
 * States: CLOSED (normal) → OPEN (failing, reject all) → HALF_OPEN (testing recovery)
 *
 * Usage:
 *   const cb = createCircuitBreaker('gemini-api', { threshold: 5, resetTimeout: 60000 });
 *   const result = await cb.call(() => callGeminiAPI(...));
 */

const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

/**
 * @param {string} name   Human-readable breaker name (for logs / dashboard)
 * @param {object} options
 * @param {number} [options.threshold=5]        Failures within monitorWindow before opening
 * @param {number} [options.resetTimeout=60000] ms before trying half-open
 * @param {number} [options.halfOpenMax=2]      Consecutive successes to close from half-open
 * @param {number} [options.monitorWindow=120000] ms window for failure counting
 * @returns {{ call: (fn: () => Promise<T>) => Promise<T>, getState: () => object, reset: () => void }}
 */
export function createCircuitBreaker(name, options = {}) {
  const {
    threshold     = 5,       // failures before opening
    resetTimeout  = 60000,   // ms before trying half-open
    halfOpenMax   = 2,       // successful calls to close from half-open
    monitorWindow = 120000,  // ms window for failure counting
  } = options;

  let state     = STATES.CLOSED;
  let failures  = [];  // timestamps of recent failures
  let successes = 0;   // consecutive successes in HALF_OPEN
  let openedAt  = 0;
  let stats     = {
    totalCalls:    0,
    totalFailures: 0,
    totalSuccesses: 0,
    lastFailure:   null,
    lastSuccess:   null,
  };

  function _cleanOldFailures() {
    const cutoff = Date.now() - monitorWindow;
    failures = failures.filter(t => t > cutoff);
  }

  /**
   * Execute `fn` through the circuit breaker.
   * Throws if the breaker is OPEN and resetTimeout has not elapsed.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function call(fn) {
    stats.totalCalls++;

    if (state === STATES.OPEN) {
      if (Date.now() - openedAt >= resetTimeout) {
        state     = STATES.HALF_OPEN;
        successes = 0;
        console.log(`[circuit-breaker:${name}] HALF_OPEN — testing recovery`);
      } else {
        const remainSec = Math.ceil((resetTimeout - (Date.now() - openedAt)) / 1000);
        const err = new Error(
          `Circuit breaker [${name}] is OPEN — rejecting call (resets in ${remainSec}s)`,
        );
        err.circuitBreakerOpen = true;
        throw err;
      }
    }

    try {
      const result = await fn();
      stats.totalSuccesses++;
      stats.lastSuccess = Date.now();

      if (state === STATES.HALF_OPEN) {
        successes++;
        if (successes >= halfOpenMax) {
          state    = STATES.CLOSED;
          failures = [];
          console.log(`[circuit-breaker:${name}] CLOSED — recovered`);
        }
      }

      return result;
    } catch (err) {
      stats.totalFailures++;
      stats.lastFailure = Date.now();
      failures.push(Date.now());

      if (state === STATES.HALF_OPEN) {
        state    = STATES.OPEN;
        openedAt = Date.now();
        console.log(`[circuit-breaker:${name}] OPEN — recovery failed`);
        throw err;
      }

      _cleanOldFailures();
      if (failures.length >= threshold) {
        state    = STATES.OPEN;
        openedAt = Date.now();
        console.log(`[circuit-breaker:${name}] OPEN — ${failures.length} failures in ${monitorWindow}ms`);
      }

      throw err;
    }
  }

  /** Return current breaker state + stats (for dashboard / monitoring). */
  function getState() {
    // Refresh: if OPEN and timeout elapsed, reflect HALF_OPEN in snapshot
    if (state === STATES.OPEN && Date.now() - openedAt >= resetTimeout) {
      state     = STATES.HALF_OPEN;
      successes = 0;
    }
    return {
      name,
      state,
      recentFailures: failures.length,
      openedAt: openedAt || null,
      config: { threshold, resetTimeout, halfOpenMax, monitorWindow },
      stats: { ...stats },
    };
  }

  /** Force-reset to CLOSED (manual recovery / testing). */
  function reset() {
    state     = STATES.CLOSED;
    failures  = [];
    successes = 0;
    openedAt  = 0;
  }

  return { call, getState, reset };
}

// ---------------------------------------------------------------------------
// Pre-built circuit breakers for nova-kernel services
// ---------------------------------------------------------------------------

export const geminiBreaker = createCircuitBreaker('gemini-api', {
  threshold:     5,
  resetTimeout:  60_000,   // 1 min
  monitorWindow: 120_000,  // 2 min sliding window
});

export const codexBreaker = createCircuitBreaker('codex-cli', {
  threshold:     3,
  resetTimeout:  120_000,  // 2 min — CLI failures are more expensive
  monitorWindow: 180_000,
});

export const claudeBreaker = createCircuitBreaker('claude-cli', {
  threshold:     3,
  resetTimeout:  120_000,
  monitorWindow: 180_000,
});

// SDK-based providers (task-router path)
export const anthropicSDKBreaker = createCircuitBreaker('anthropic-sdk', {
  threshold:     5,
  resetTimeout:  60_000,
  monitorWindow: 120_000,
});

export const openaiSDKBreaker = createCircuitBreaker('openai-sdk', {
  threshold:     5,
  resetTimeout:  60_000,
  monitorWindow: 120_000,
});

// Antigravity Local Bridge (:11435) — 本机 IDE 进程，失败往往是 IDE 关了或扩展未激活
export const antigravityBreaker = createCircuitBreaker('antigravity-bridge', {
  threshold:     3,
  resetTimeout:  30_000,
  monitorWindow: 120_000,
});

export const ollamaBreaker = createCircuitBreaker('ollama-local', {
  threshold:     5,
  resetTimeout:  60_000,
  monitorWindow: 120_000,
});

// Feishu webhook / event push
export const feishuBreaker = createCircuitBreaker('feishu-api', {
  threshold:     5,
  resetTimeout:  60_000,
  monitorWindow: 120_000,
});

// ---------------------------------------------------------------------------
// Aggregate helpers
// ---------------------------------------------------------------------------

const _ALL_BREAKERS = [geminiBreaker, codexBreaker, claudeBreaker, anthropicSDKBreaker, openaiSDKBreaker, antigravityBreaker, ollamaBreaker, feishuBreaker];

/** Get all breaker states — for /dashboard endpoint. */
export function getAllBreakerStates() {
  return _ALL_BREAKERS.map(b => b.getState());
}

/** Reset all breakers (testing / manual recovery). */
export function resetAllBreakers() {
  _ALL_BREAKERS.forEach(b => b.reset());
}
