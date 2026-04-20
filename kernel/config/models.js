/**
 * Nova Kernel -- Central Model Registry (Model Registry)
 * kernel/config/models.js
 *
 * All AI model names are read from this file.
 * Modules override via process.env without code changes for model upgrades.
 *
 * ARCHITECTURE NOTE (model-discovery integration):
 *   Static constants below are evaluated once at module load time.
 *   They serve as fallback defaults for the first ~5 seconds before
 *   model-discovery.mjs completes its initial API queries.
 *
 *   For DYNAMIC resolution (always-latest), use:
 *     import { getLatestModel } from './model-discovery.mjs';
 *     getLatestModel('gemini_flash')  // returns API-discovered or fallback
 *
 *   The getModel(role) export below is a convenience wrapper.
 *
 * Last updated: 2026-04-13
 *
 * -- Gemini (Google AI / Vertex AI) -------------------------------------------
 *   Production stable: gemini-2.5-flash / gemini-2.5-pro
 *   Latest preview:    gemini-3-flash-preview / gemini-3.1-pro-preview
 *
 * -- OpenAI -------------------------------------------------------------------
 *   Flagship: gpt-5.4
 *   Light:    gpt-5.4-mini
 *   Ultra:    gpt-5.4-nano
 *
 * -- Claude (Anthropic) -------------------------------------------------------
 *   Daily:    claude-sonnet-4-6
 *   Flagship: claude-opus-4-6
 *   Economy:  claude-haiku-4-5
 */

import { getLatestModel } from './model-discovery.mjs';

// -- Gemini -------------------------------------------------------------------
export const GEMINI_FLASH        = process.env.GEMINI_FLASH_MODEL         || 'gemini-3-flash-preview';
export const GEMINI_PRO          = process.env.GEMINI_PRO_MODEL           || 'gemini-3.1-pro-preview';
export const GEMINI_FLASH_STABLE = process.env.GEMINI_FLASH_STABLE_MODEL  || 'gemini-2.5-flash';
export const GEMINI_PRO_STABLE   = process.env.GEMINI_PRO_STABLE_MODEL    || 'gemini-2.5-pro';
export const GEMINI_FLASH_LITE   = process.env.GEMINI_FLASH_LITE_MODEL    || 'gemini-2.5-flash-lite';

// Council voter
export const GEMINI_VOTER        = process.env.GEMINI_VOTER_MODEL         || GEMINI_PRO;

// -- OpenAI / GPT-5 ----------------------------------------------------------
export const GPT_FULL            = process.env.GPT_FULL_MODEL             || 'gpt-5.4';
export const GPT_MINI            = process.env.GPT_MINI_MODEL             || 'gpt-5.4-mini';
export const GPT_NANO            = process.env.GPT_NANO_MODEL             || 'gpt-5.4-nano';
export const O3                  = process.env.O3_MODEL                   || 'o3';
export const O4_MINI             = process.env.O4_MINI_MODEL              || 'gpt-5.4-mini';

export const CODEX_VOTER         = process.env.CODEX_VOTER_MODEL          || GPT_MINI;
export const CODEX_MINI          = process.env.CODEX_MINI_MODEL           || GPT_MINI;
export const CODEX_FULL          = process.env.CODEX_FULL_MODEL           || GPT_FULL;

// -- Claude (Anthropic) -------------------------------------------------------
export const CLAUDE_SONNET       = process.env.CLAUDE_SONNET_MODEL        || 'claude-sonnet-4-6';
export const CLAUDE_OPUS         = process.env.CLAUDE_OPUS_MODEL          || 'claude-opus-4-6';
export const CLAUDE_HAIKU        = process.env.CLAUDE_HAIKU_MODEL         || 'claude-haiku-4-5';

// ---------------------------------------------------------------------------
// getModel(role) -- DYNAMIC model resolution via model-discovery live registry
// ---------------------------------------------------------------------------

/**
 * Resolve a model role to its current best model ID.
 * Reads from the model-discovery live registry (populated by API queries).
 * Falls back to static constants above if discovery hasn't run yet.
 *
 * @param {string} role  e.g. 'gemini_flash', 'claude_sonnet', 'openai_full'
 * @returns {string}     Actual model ID
 */
export function getModel(role) {
  return getLatestModel(role);
}

// ---------------------------------------------------------------------------
// resolveModel(worker, complexity) -- model ID string
// ---------------------------------------------------------------------------

/**
 * For Workers at runtime, returns the recommended model ID.
 * Now uses dynamic resolution via model-discovery.
 *
 * Routing logic:
 *   gemini  c<=3  -> flash (latest discovered)
 *   gemini  c>3   -> pro   (latest discovered)
 *   codex   c<=3  -> gpt-mini
 *   codex   c>3   -> gpt-full
 *   claude  any   -> claude-sonnet
 */
export function resolveModel(worker, complexity = 2) {
  const c = Math.max(1, Math.min(5, complexity));
  switch (worker) {
    case 'gemini':
      return c <= 3 ? getLatestModel('gemini_flash') : getLatestModel('gemini_pro');
    case 'codex':
      return c <= 3 ? getLatestModel('codex_mini') : getLatestModel('codex_full');
    case 'claude':
      return getLatestModel('claude_sonnet');
    default:
      return getLatestModel('gemini_flash');
  }
}

// ---------------------------------------------------------------------------
// logModelConfig() -- server startup log
// ---------------------------------------------------------------------------

export function logModelConfig() {
  console.log('[Nova Kernel][models] Current model configuration (dynamic via model-discovery):');
  console.log(`  Gemini Flash    : ${getLatestModel('gemini_flash')}  (stable: ${getLatestModel('gemini_flash_stable')}, lite: ${getLatestModel('gemini_flash_lite')})`);
  console.log(`  Gemini Pro      : ${getLatestModel('gemini_pro')}    (stable: ${getLatestModel('gemini_pro_stable')})`);
  console.log(`  OpenAI Full     : ${getLatestModel('openai_full')}`);
  console.log(`  OpenAI Mini     : ${getLatestModel('openai_mini')}`);
  console.log(`  OpenAI Nano     : ${getLatestModel('openai_nano')}`);
  console.log(`  Claude Sonnet   : ${getLatestModel('claude_sonnet')}`);
  console.log(`  Claude Opus     : ${getLatestModel('claude_opus')}`);
  console.log(`  Claude Haiku    : ${getLatestModel('claude_haiku')}`);
  console.log(`  Council Voters  : Gemini=${getLatestModel('gemini_voter')} / OpenAI=${getLatestModel('codex_voter')} / nova-self`);
}
