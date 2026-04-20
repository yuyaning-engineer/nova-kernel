#!/usr/bin/env node
/**
 * 一次性迁移：给 875 条存量 active 记忆补 module 字段（默认 'legacy'）
 * 不动 status / id / created_at — 只在原 jsonl 上 append 升级版本
 * 更精确的分类后续可由 librarian/triage 判定升级
 *
 * 用法: node kernel/memory/migrate-taxonomy.mjs [--dry]
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const AUTH = join(ROOT, 'kernel/memory/authoritative');
const TYPES = ['user', 'feedback', 'project', 'reference'];
const DRY = process.argv.includes('--dry');

// 简单关键字推断 module（粗分，librarian 之后细化）
function inferModule(e) {
  const txt = `${e.name} ${e.description} ${e.body}`.toLowerCase();
  if (/\b(commerce-ops|seo|jst|聚水潭|店铺|sku|改价|商品|文案|订单|补货|发布)\b/i.test(txt)) return 'commerce-ops';
  if (/\b(media-forge|video|视频|图像|去背|模特图|切片)\b/i.test(txt)) return 'media-forge';
  if (/\b(enterprise-ai|设计趋势|采购|qc|wms|客服)\b/i.test(txt)) return 'enterprise-ai';
  if (/\b(antigravity|ag-bridge|ag-local-bridge|cascade)\b/i.test(txt)) return 'antigravity';
  if (/\b(codex|codex-cli)\b/i.test(txt)) return 'nova-kernel';
  if (/\b(kernel|connector|router|provider|memory-writer|memory-sync|self-maintenance|fallback)\b/i.test(txt)) return 'nova-kernel';
  if (/\b(kb|vector|embed|librarian|taxonomy|decay|meta-memory)\b/i.test(txt)) return 'kb-v2';
  if (/\b(jimeng|即梦)\b/i.test(txt)) return 'media-forge';
  if (/\b(ai-studio|comfyui|lora|flux)\b/i.test(txt)) return 'ai-studio';
  if (/\b(tiktok|tiktok-agent)\b/i.test(txt)) return 'tiktok-agent';
  return 'meta';
}

let total = 0, updated = 0;
const summary = {};
for (const t of TYPES) {
  const path = join(AUTH, `${t}.jsonl`);
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  total += lines.length;

  const out = [];
  let typeUpdated = 0;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { out.push(line); continue; }
    if (e.status !== 'active') { out.push(line); continue; }
    if (e.module) { out.push(line); continue; } // 已有 module
    e.module = inferModule(e);
    out.push(JSON.stringify(e));
    typeUpdated++;
    summary[e.module] = (summary[e.module] || 0) + 1;
  }
  updated += typeUpdated;
  console.log(`  ${t}.jsonl: ${typeUpdated} 条 active 补 module`);

  if (!DRY) {
    copyFileSync(path, `${path}.bak-pre-migrate-${new Date().toISOString().slice(0,10)}`);
    writeFileSync(path, out.join('\n') + '\n', 'utf8');
  }
}

console.log(`\n总: ${updated}/${total} 条更新${DRY?' (dry-run)':''}`);
console.log(`分布:`);
for (const [m, c] of Object.entries(summary).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${m.padEnd(15)} ${c}`);
}
