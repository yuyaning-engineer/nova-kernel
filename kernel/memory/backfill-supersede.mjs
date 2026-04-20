#!/usr/bin/env node
/**
 * 一次性回填: 对 4 个 jsonl 文件, 按 type+name 分组,
 * 保留每组最新 1 条 active, 其余 active 都标记 superseded.
 *
 * 实证当前死数据率 96%, nova-architecture-current 一个 name 占 3323 条.
 *
 * 用法: node kernel/memory/backfill-supersede.mjs
 *       (kernel 启动后改一次即生效, 后续新写入自动 supersede)
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT     = process.env.NOVA_KERNEL_ROOT || process.cwd();
const AUTH_DIR = join(ROOT, 'kernel', 'memory', 'authoritative');
const TYPES    = ['user', 'feedback', 'project', 'reference'];
const NOW      = new Date().toISOString();

let totalIn = 0, totalActive = 0, totalSuperseded = 0;

for (const t of TYPES) {
  const path = join(AUTH_DIR, `${t}.jsonl`);
  if (!existsSync(path)) continue;

  // 备份
  copyFileSync(path, `${path}.bak-${NOW.slice(0,10)}`);

  const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  totalIn += entries.length;

  // 按 name 分组, 记录每组最新一条的 (created_at, line index)
  // 用 line index 而非 id 去重: 同 name+body (相同 id) 多次写入是真的重复, 也得只留 1 条
  const latestByName = new Map(); // name -> { createdAt, idx }
  entries.forEach((e, idx) => {
    if (e.status !== 'active') return;
    const cur = latestByName.get(e.name);
    if (!cur || new Date(e.created_at) > new Date(cur.createdAt) ||
        (new Date(e.created_at).getTime() === new Date(cur.createdAt).getTime() && idx > cur.idx)) {
      latestByName.set(e.name, { createdAt: e.created_at, idx, supersededBy: e.id });
    }
  });
  const keepIdx = new Set([...latestByName.values()].map(v => v.idx));

  // 改写: 所有 active 中, 不在 keepIdx 里的都标 superseded
  const out = entries.map((e, idx) => {
    if (e.status === 'active' && !keepIdx.has(idx)) {
      totalSuperseded++;
      return {
        ...e,
        status: 'superseded',
        superseded_at: NOW,
        superseded_by: latestByName.get(e.name)?.supersededBy || null,
        superseded_reason: 'backfill: 同 name 多版本去重 (按 line idx)',
      };
    }
    if (e.status === 'active') totalActive++;
    return e;
  });

  writeFileSync(path, out.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  console.log(`  ${t}.jsonl: ${entries.length} → active ${keepIdx.size}, superseded +${entries.length - entries.filter(e=>e.status!=='active').length - keepIdx.size}`);
}

console.log(`\n总计: ${totalIn} 条输入 → ${totalActive} 活 + ${totalSuperseded} 新废弃`);
console.log(`备份后缀: .bak-${NOW.slice(0,10)}`);
