/**
 * redact.mjs
 * Regex-based secret redaction for logs — ported from hermes-agent/agent/redact.py.
 *
 * Masks API keys, tokens, credentials, and connection strings before
 * they reach log files or stdout.
 *
 * Exports:
 *   redactSecrets(text)           → redacted string
 *   createRedactingLogger()       → { log, warn, error, info } wrappers
 */

// ── Known API key prefix patterns ───────────────────────────────────────

const PREFIX_PATTERNS = [
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,           // OpenAI / Anthropic
  /(?<![A-Za-z0-9_-])ghp_[A-Za-z0-9]{10,}(?![A-Za-z0-9_-])/g,            // GitHub PAT (classic)
  /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{10,}(?![A-Za-z0-9_-])/g,    // GitHub PAT (fine-grained)
  /(?<![A-Za-z0-9_-])gho_[A-Za-z0-9]{10,}(?![A-Za-z0-9_-])/g,            // GitHub OAuth
  /(?<![A-Za-z0-9_-])ghs_[A-Za-z0-9]{10,}(?![A-Za-z0-9_-])/g,            // GitHub server-to-server
  /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/g,          // Google API keys
  /(?<![A-Za-z0-9_-])AKIA[A-Z0-9]{16}(?![A-Za-z0-9_-])/g,                // AWS Access Key ID
  /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_-])/g,    // Slack tokens
  /(?<![A-Za-z0-9_-])sk_live_[A-Za-z0-9]{10,}(?![A-Za-z0-9_-])/g,        // Stripe live
  /(?<![A-Za-z0-9_-])sk_test_[A-Za-z0-9]{10,}(?![A-Za-z0-9_-])/g,        // Stripe test
  /(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{10,}(?![A-Za-z0-9_-])/g,             // HuggingFace
  /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,          // SendGrid
  /(?<![A-Za-z0-9_-])pplx-[A-Za-z0-9]{10,}(?![A-Za-z0-9_-])/g,           // Perplexity
  /(?<![A-Za-z0-9_-])gsk_[A-Za-z0-9]{10,}(?![A-Za-z0-9_-])/g,            // Groq
];

// Bearer tokens in Authorization headers
const AUTH_HEADER_RE = /(Authorization:\s*Bearer\s+)(\S+)/gi;

// JWT tokens (eyJ... base64 segments)
const JWT_RE = /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})(?![A-Za-z0-9_-])/g;

// Database connection strings: protocol://user:PASSWORD@host
const DB_CONNSTR_RE = /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:]+:)([^@]+)(@)/gi;

// Webhook URLs with secrets (slack, discord, etc.)
const WEBHOOK_SECRET_RE = /(https:\/\/hooks\.\S+?\/)[A-Za-z0-9_/-]{20,}/gi;

// JSON field patterns: "apiKey": "value", "token": "value"
const JSON_FIELD_RE = /("(?:api_?[Kk]ey|token|secret|password|access_token|refresh_token|auth_token|bearer|secret_value)")\s*:\s*"([^"]+)"/gi;

// Private key blocks
const PRIVATE_KEY_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g;

// ── Mask helper ─────────────────────────────────────────────────────────

function _mask(token) {
  if (typeof token !== 'string') return '[REDACTED]';
  if (token.length < 18) return '[REDACTED]';
  return `${token.slice(0, 6)}...[REDACTED]...${token.slice(-4)}`;
}

// ── Main redaction function ─────────────────────────────────────────────

/**
 * Apply all redaction patterns to a text string.
 * Safe to call on any string — non-matching text passes through unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  if (text == null) return text;
  if (typeof text !== 'string') text = String(text);
  if (!text) return text;

  // Known API key prefixes
  for (const re of PREFIX_PATTERNS) {
    re.lastIndex = 0;
    text = text.replace(re, m => _mask(m));
  }

  // Authorization headers
  text = text.replace(AUTH_HEADER_RE, (_, prefix, token) => prefix + _mask(token));

  // JWT tokens
  text = text.replace(JWT_RE, (_, jwt) => _mask(jwt));

  // Database connection strings (mask password only)
  text = text.replace(DB_CONNSTR_RE, (_, pre, pwd, post) => `${pre}[REDACTED]${post}`);

  // Webhook URLs with secrets
  text = text.replace(WEBHOOK_SECRET_RE, (_, base) => `${base}[REDACTED]`);

  // JSON secret fields
  text = text.replace(JSON_FIELD_RE, (_, key, val) => `${key}: "[REDACTED]"`);

  // Private key blocks
  text = text.replace(PRIVATE_KEY_RE, '[REDACTED PRIVATE KEY]');

  return text;
}

// ── Redacting logger wrapper ────────────────────────────────────────────

/**
 * Create a logger that auto-redacts secrets from all output.
 * Returns an object with log/warn/error/info methods that mirror console.
 *
 * @returns {{ log: Function, warn: Function, error: Function, info: Function }}
 */
export function createRedactingLogger() {
  const _orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    info:  console.info.bind(console),
  };

  function _redactArgs(args) {
    return args.map(arg => {
      if (typeof arg === 'string') return redactSecrets(arg);
      if (arg instanceof Error) {
        // Redact error message without mutating the original
        const redacted = new Error(redactSecrets(arg.message));
        redacted.stack = arg.stack ? redactSecrets(arg.stack) : undefined;
        return redacted;
      }
      // Objects: stringify → redact → parse back (only for log output)
      if (arg && typeof arg === 'object') {
        try {
          return JSON.parse(redactSecrets(JSON.stringify(arg)));
        } catch {
          return arg;
        }
      }
      return arg;
    });
  }

  return {
    log:   (...args) => _orig.log(..._redactArgs(args)),
    warn:  (...args) => _orig.warn(..._redactArgs(args)),
    error: (...args) => _orig.error(..._redactArgs(args)),
    info:  (...args) => _orig.info(..._redactArgs(args)),
  };
}

/**
 * Install redaction globally by replacing console.log/warn/error/info.
 * Call once at process startup. Idempotent — repeated calls are no-ops.
 */
let _installed = false;
export function installGlobalRedaction() {
  if (_installed) return;
  _installed = true;

  const logger = createRedactingLogger();
  console.log   = logger.log;
  console.warn  = logger.warn;
  console.error = logger.error;
  console.info  = logger.info;
}
