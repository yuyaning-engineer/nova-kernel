/**
 * kb/taxonomy-guard.mjs — 分类层约束 (S4)
 *
 * 读 taxonomy.json，校验 kb.remember(...) 的 module/risk_level 字段。
 * 给 SDK 用：在写入前过一道 validate，不合法就抛错。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const TAXONOMY_PATH = join(SELF_DIR, 'taxonomy.json');

let _cached = null;
let _loadTime = 0;
const CACHE_TTL = 30_000;

export function loadTaxonomy() {
  if (_cached && Date.now() - _loadTime < CACHE_TTL) return _cached;
  if (!existsSync(TAXONOMY_PATH)) throw new Error(`taxonomy.json not found at ${TAXONOMY_PATH}`);
  _cached = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8'));
  _loadTime = Date.now();
  return _cached;
}

export function validateTags({ module, function: func, risk_level }) {
  const tax = loadTaxonomy();
  const errors = [];

  if (tax.module.required && !module) errors.push('module 必填');
  if (module && !tax.module.enum.includes(module)) errors.push(`module=${module} 不在枚举中（${tax.module.enum.join(',')}）`);
  if (func && !tax.function.enum.includes(func)) errors.push(`function=${func} 不在枚举中（${tax.function.enum.join(',')}）`);
  if (risk_level && !tax.risk_level.enum.includes(risk_level)) errors.push(`risk_level=${risk_level} 不在枚举中`);

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      module: module || tax.module.default,
      function: func || tax.function.default,
      risk_level: risk_level || tax.risk_level.default,
    },
  };
}

export function inferFunction({ file_path, name } = {}) {
  const hints = `${file_path || ''} ${name || ''}`.toLowerCase();
  if (/generat|create|write|compose/.test(hints)) return 'generate';
  if (/analy|report|digest|audit/.test(hints)) return 'analyze';
  if (/execut|run|invoke/.test(hints)) return 'execute';
  if (/config|setup|install|env/.test(hints)) return 'configure';
  if (/diagno|health|doctor|check/.test(hints)) return 'diagnose';
  if (/search|retriev|query|find/.test(hints)) return 'retrieve';
  if (/curat|triage|clean|dedup/.test(hints)) return 'curate';
  return 'other';
}
