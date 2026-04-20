/**
 * Nova Kernel — HTTP handler 共享工具
 * kernel/server/utils.mjs
 *
 * 从 server.js 抽出的共享函数，给各个 handler 模块复用。
 */

import { resolve, normalize, sep } from 'node:path';

// ── HTTP body 读取（与 server.js 同一份逻辑）────────────────────────────
const MAX_BODY_BYTES = 1024 * 512; // 512KB 硬上限防 DoS

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ── JSON 响应 ────────────────────────────────────────────────────────────
export function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res, status, message) {
  send(res, status, { ok: false, error: message });
}

// ── 路径穿越防护 ─────────────────────────────────────────────────────────
export function assertSafePath(inputPath, allowedDir) {
  const normalized = normalize(resolve(inputPath));
  const base = normalize(resolve(allowedDir));
  if (!normalized.startsWith(base + sep) && normalized !== base) {
    throw new Error(`Path traversal blocked: ${inputPath}`);
  }
  return normalized;
}

// ── 内部鉴权（Bearer Token）─────────────────────────────────────────────
const INTERNAL_TOKEN = process.env.NOVA_INTERNAL_TOKEN || '';

export function assertInternalAuth(req, res) {
  if (!INTERNAL_TOKEN) return true; // 未配置时放行（开发模式）
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${INTERNAL_TOKEN}`) {
    sendError(res, 401, '未授权：缺少或错误的 NOVA_INTERNAL_TOKEN');
    return false;
  }
  return true;
}

// ── 调用方来源识别（X-Nova-Source / UA 启发）────────────────────────────
const KNOWN_SOURCES = new Set(['cursor', 'claude-code', 'cli', 'web', 'api', 'vscode', 'jetbrains', 'mcp']);

export function resolveSource(req) {
  const raw = (req.headers['x-nova-source'] || '').toLowerCase().trim();
  if (KNOWN_SOURCES.has(raw)) return raw;
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('cursor'))             return 'cursor';
  if (ua.includes('claude-code'))        return 'claude-code';
  if (ua.includes('vscode'))             return 'vscode';
  if (ua.includes('anthropic') || ua.includes('mcp')) return 'mcp';
  if (ua.startsWith('curl') || ua.includes('node'))   return 'cli';
  return raw || 'unknown';
}
