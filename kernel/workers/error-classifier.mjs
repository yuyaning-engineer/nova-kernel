/**
 * error-classifier.mjs
 * Structured API error classification — ported from hermes-agent/agent/error_classifier.py.
 *
 * Centralizes error taxonomy so retry loops consult a single classifier
 * instead of scattering string-matching across every HTTP call site.
 *
 * Exports:
 *   classifyError(error, responseStatus, responseBody) → ClassifiedError
 *   ERROR_CATEGORIES   — enum-like object of all category strings
 */

// ── Error categories ────────────────────────────────────────────────────

export const ERROR_CATEGORIES = Object.freeze({
  RATE_LIMITED:     'RATE_LIMITED',
  QUOTA_EXHAUSTED:  'QUOTA_EXHAUSTED',
  OVERLOADED:       'OVERLOADED',
  BAD_REQUEST:      'BAD_REQUEST',
  AUTH_FAILED:      'AUTH_FAILED',
  TIMEOUT:          'TIMEOUT',
  NETWORK_ERROR:    'NETWORK_ERROR',
  UNKNOWN:          'UNKNOWN',
});

// ── Backoff strategies per category ─────────────────────────────────────

const BACKOFF_TABLE = {
  [ERROR_CATEGORIES.RATE_LIMITED]:     { retryable: true,  backoffMs: 2000,  strategy: 'exponential' },
  [ERROR_CATEGORIES.QUOTA_EXHAUSTED]:  { retryable: false, backoffMs: 0,     strategy: 'none'        },
  [ERROR_CATEGORIES.OVERLOADED]:       { retryable: true,  backoffMs: 30000, strategy: 'fixed'       },
  [ERROR_CATEGORIES.BAD_REQUEST]:      { retryable: false, backoffMs: 0,     strategy: 'none'        },
  [ERROR_CATEGORIES.AUTH_FAILED]:      { retryable: false, backoffMs: 0,     strategy: 'none'        },
  [ERROR_CATEGORIES.TIMEOUT]:          { retryable: true,  backoffMs: 5000,  strategy: 'linear'      },
  [ERROR_CATEGORIES.NETWORK_ERROR]:    { retryable: true,  backoffMs: 3000,  strategy: 'exponential' },
  [ERROR_CATEGORIES.UNKNOWN]:          { retryable: true,  backoffMs: 5000,  strategy: 'exponential' },
};

// ── Pattern tables (lowercased message matching) ────────────────────────

const RATE_LIMIT_PATTERNS = [
  'rate limit', 'rate_limit', 'too many requests', 'throttled',
  'requests per minute', 'tokens per minute', 'requests per day',
  'try again in', 'please retry after', 'resource_exhausted',
];

const BILLING_PATTERNS = [
  'insufficient credits', 'insufficient_quota', 'credit balance',
  'credits have been exhausted', 'payment required', 'billing hard limit',
  'exceeded your current quota', 'account is deactivated',
];

const USAGE_LIMIT_PATTERNS = [
  'usage limit', 'quota', 'limit exceeded', 'key limit exceeded',
];

const USAGE_LIMIT_TRANSIENT_SIGNALS = [
  'try again', 'retry', 'resets at', 'reset in', 'wait',
  'requests remaining', 'window',
];

const AUTH_PATTERNS = [
  'invalid api key', 'invalid_api_key', 'authentication',
  'unauthorized', 'forbidden', 'invalid token', 'token expired',
  'access denied',
];

const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
]);

// ── Helpers ─────────────────────────────────────────────────────────────

function _extractMessage(error, responseBody) {
  // Structured body first
  if (responseBody && typeof responseBody === 'object') {
    const errObj = responseBody.error;
    if (errObj && typeof errObj === 'object' && errObj.message) {
      return String(errObj.message).slice(0, 500);
    }
    if (responseBody.message) {
      return String(responseBody.message).slice(0, 500);
    }
  }
  if (error && error.message) return String(error.message).slice(0, 500);
  return String(error || 'Unknown error').slice(0, 500);
}

function _matchesAny(text, patterns) {
  return patterns.some(p => text.includes(p));
}

// ── Main classifier ─────────────────────────────────────────────────────

/**
 * Classify an API error into a structured recovery recommendation.
 *
 * @param {Error|null}  error           The caught exception (may be null)
 * @param {number|null} responseStatus  HTTP status code (may be null for network errors)
 * @param {object|null} responseBody    Parsed JSON body (may be null)
 * @returns {{ category: string, retryable: boolean, backoffMs: number, strategy: string, message: string }}
 */
export function classifyError(error, responseStatus, responseBody) {
  const msg = _extractMessage(error, responseBody);
  const msgLower = msg.toLowerCase();
  const errCode = error?.code || '';

  function _result(category) {
    const info = BACKOFF_TABLE[category];
    return {
      category,
      retryable: info.retryable,
      backoffMs: info.backoffMs,
      strategy:  info.strategy,
      message:   msg,
    };
  }

  // ── 1. Node.js error codes (ETIMEDOUT, ECONNREFUSED, etc.) ──────────
  if (errCode) {
    if (TIMEOUT_ERROR_CODES.has(errCode))  return _result(ERROR_CATEGORIES.TIMEOUT);
    if (NETWORK_ERROR_CODES.has(errCode))  return _result(ERROR_CATEGORIES.NETWORK_ERROR);
  }

  // ── 2. Timeout heuristics from message ──────────────────────────────
  if (!responseStatus && (
    msgLower.includes('timeout') ||
    msgLower.includes('etimedout') ||
    msgLower.includes('econnreset')
  )) {
    return _result(ERROR_CATEGORIES.TIMEOUT);
  }

  // ── 3. Network error heuristics from message ────────────────────────
  if (!responseStatus && (
    msgLower.includes('econnrefused') ||
    msgLower.includes('enotfound') ||
    msgLower.includes('network')
  )) {
    return _result(ERROR_CATEGORIES.NETWORK_ERROR);
  }

  // ── 4. HTTP status code classification ──────────────────────────────
  if (responseStatus) {
    // Auth
    if (responseStatus === 401 || responseStatus === 403) {
      return _result(ERROR_CATEGORIES.AUTH_FAILED);
    }

    // Rate limited
    if (responseStatus === 429) {
      return _result(ERROR_CATEGORIES.RATE_LIMITED);
    }

    // Quota exhausted vs transient rate limit on 402
    if (responseStatus === 402) {
      const hasUsageLimit    = _matchesAny(msgLower, USAGE_LIMIT_PATTERNS);
      const hasTransient     = _matchesAny(msgLower, USAGE_LIMIT_TRANSIENT_SIGNALS);
      if (hasUsageLimit && hasTransient) {
        return _result(ERROR_CATEGORIES.RATE_LIMITED);
      }
      return _result(ERROR_CATEGORIES.QUOTA_EXHAUSTED);
    }

    // Overloaded
    if (responseStatus === 503 || responseStatus === 529) {
      return _result(ERROR_CATEGORIES.OVERLOADED);
    }

    // Bad request
    if (responseStatus === 400) {
      return _result(ERROR_CATEGORIES.BAD_REQUEST);
    }

    // Server errors (500, 502) — retryable as overloaded
    if (responseStatus >= 500 && responseStatus < 600) {
      return _result(ERROR_CATEGORIES.OVERLOADED);
    }
  }

  // ── 5. Message pattern matching (no status code) ────────────────────

  if (_matchesAny(msgLower, BILLING_PATTERNS)) {
    return _result(ERROR_CATEGORIES.QUOTA_EXHAUSTED);
  }

  if (_matchesAny(msgLower, RATE_LIMIT_PATTERNS)) {
    return _result(ERROR_CATEGORIES.RATE_LIMITED);
  }

  if (_matchesAny(msgLower, AUTH_PATTERNS)) {
    return _result(ERROR_CATEGORIES.AUTH_FAILED);
  }

  // ── 6. Fallback ─────────────────────────────────────────────────────
  return _result(ERROR_CATEGORIES.UNKNOWN);
}

/**
 * Compute actual backoff with jitter for a given attempt.
 *
 * @param {{ backoffMs: number, strategy: string }} classified
 * @param {number} attempt  0-based attempt index
 * @returns {number} milliseconds to wait
 */
export function computeBackoff(classified, attempt) {
  const { backoffMs, strategy } = classified;
  if (!backoffMs || strategy === 'none') return 0;

  let base;
  switch (strategy) {
    case 'exponential':
      base = backoffMs * Math.pow(2, attempt);
      break;
    case 'linear':
      base = backoffMs * (attempt + 1);
      break;
    case 'fixed':
    default:
      base = backoffMs;
      break;
  }

  // Cap at 120s, add ±20% jitter
  const capped = Math.min(base, 120_000);
  const jitter = capped * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}
