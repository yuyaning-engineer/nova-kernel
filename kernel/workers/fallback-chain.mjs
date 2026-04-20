import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { auditLog } from '../audit/audit.js';
import { writeMemory } from '../memory/memory-writer.mjs';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const FEEDBACK_JSONL = join(ROOT, 'kernel', 'memory', 'authoritative', 'feedback.jsonl');

export const FALLBACK_CHAIN = {
  'antigravity-claude-opus-4-6-thinking': ['antigravity-claude-sonnet-4-6', 'antigravity-gemini-3.1-pro-high', 'gemini-pro-latest', 'ollama-qwen2.5:7b'],
  'antigravity-claude-sonnet-4-6':        ['antigravity-gemini-3.1-pro-high', 'gemini-flash-latest', 'ollama-qwen2.5:7b'],
  'antigravity-gemini-3.1-pro-high':      ['gemini-pro-latest', 'antigravity-claude-sonnet-4-6', 'ollama-qwen2.5:7b'],
  'antigravity-gemini-3.1-pro-low':       ['gemini-flash-latest', 'ollama-qwen2.5:7b'],
  'antigravity-gemini-3-flash':           ['gemini-flash-latest', 'ollama-llama3.2:3b'],
  'gemini-pro-latest':                    ['gemini-flash-latest', 'ollama-qwen2.5:7b'],
  'gemini-flash-latest':                  ['ollama-qwen2.5:7b', 'ollama-llama3.2:3b'],
  'claude-sonnet-4-6':                    ['antigravity-claude-sonnet-4-6', 'gemini-pro-latest'],
  'claude-opus-4-7':                      ['antigravity-claude-opus-4-6-thinking', 'gemini-pro-latest'],
  'claude-haiku-4-5':                     ['gemini-flash-latest', 'ollama-llama3.2:3b'],
};

export function getNextInChain(failedModel, attemptedModels = []) {
  const chain = FALLBACK_CHAIN[failedModel];
  if (!Array.isArray(chain) || chain.length === 0) return null;

  const attempted = attemptedModels instanceof Set
    ? attemptedModels
    : new Set(Array.isArray(attemptedModels) ? attemptedModels : [attemptedModels]);

  for (const candidate of chain) {
    if (!attempted.has(candidate)) return candidate;
  }

  return null;
}

function _alreadyRecordedToday(name, toModel, todayDate) {
  if (!existsSync(FEEDBACK_JSONL)) return false;

  for (const line of readFileSync(FEEDBACK_JSONL, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || entry.type !== 'feedback') continue;
      if (entry.name !== name) continue;
      if (!String(entry.created_at || '').startsWith(todayDate)) continue;
      if (String(entry.body || '').includes(`自动降级到 ${toModel}`)) return true;
    } catch {}
  }

  return false;
}

export function recordFallback(fromModel, toModel, reason) {
  const cleanReason = String(reason || 'unknown error').slice(0, 80);
  const todayDate = new Date().toISOString().slice(0, 10);
  const name = `fallback-${fromModel}-${todayDate}`;

  try {
    auditLog({
      event: 'provider.fallback',
      operator: 'ai-executor',
      target: `${fromModel}->${toModel}`,
      detail: { reason: cleanReason },
    });
  } catch {}

  try {
    if (_alreadyRecordedToday(name, toModel, todayDate)) return;
    writeMemory({
      type: 'feedback',
      name,
      description: `Provider fallback ${fromModel} -> ${toModel}`,
      body: `Provider ${fromModel} 失败 (${cleanReason}) 自动降级到 ${toModel}`,
      source: 'ai-executor',
      confidence: 0.9,
    });
  } catch {}
}
