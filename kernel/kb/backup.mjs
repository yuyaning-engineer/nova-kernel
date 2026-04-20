/**
 * kb/backup.mjs — 备份轮转 + 磁盘 watchdog (S7)
 *
 * 每日快照 authoritative/*.jsonl + kb/*.db → _backups/YYYY-MM-DD/
 * 保留 30 天，>30 天的自动清。
 * 检查 jsonl 尺寸，>50MB 触发 compact 建议（写告警记忆）。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const BACKUP_ROOT = join(ROOT, '_backups');
const KEEP_DAYS = parseInt(process.env.KB_BACKUP_KEEP_DAYS || '30', 10);
const COMPACT_THRESHOLD_MB = parseInt(process.env.KB_COMPACT_MB || '50', 10);

const SOURCES = [
  'kernel/memory/authoritative/user.jsonl',
  'kernel/memory/authoritative/feedback.jsonl',
  'kernel/memory/authoritative/project.jsonl',
  'kernel/memory/authoritative/reference.jsonl',
  'kernel/kb/vectors.db',
  'kernel/kb/intel.db',
];

export function snapshotBackup() {
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(BACKUP_ROOT, date);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const rel of SOURCES) {
    const full = join(ROOT, rel);
    if (!existsSync(full)) continue;
    const dest = join(dir, rel.replace(/[\\/]/g, '_'));
    try {
      copyFileSync(full, dest);
      copied.push({ src: rel, bytes: statSync(full).size });
    } catch (e) { copied.push({ src: rel, error: e.message }); }
  }
  return { ok: true, date, dir, copied };
}

export function pruneOldBackups() {
  if (!existsSync(BACKUP_ROOT)) return { ok: true, removed: [] };
  const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
  const removed = [];
  for (const d of readdirSync(BACKUP_ROOT)) {
    const full = join(BACKUP_ROOT, d);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      if (st.mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
        removed.push(d);
      }
    } catch {}
  }
  return { ok: true, removed, keep_days: KEEP_DAYS };
}

export function checkDiskHealth() {
  const warnings = [];
  const info = [];
  for (const rel of SOURCES) {
    const full = join(ROOT, rel);
    if (!existsSync(full)) continue;
    const mb = statSync(full).size / 1024 / 1024;
    info.push({ path: rel, size_mb: +mb.toFixed(2) });
    if (mb > COMPACT_THRESHOLD_MB) {
      warnings.push(`${rel} size=${mb.toFixed(1)}MB > ${COMPACT_THRESHOLD_MB}MB，建议 compact`);
    }
  }
  return { ok: warnings.length === 0, warnings, info };
}

/**
 * 一键跑：snapshot + prune + check
 */
export function runBackupJob() {
  return {
    snapshot: snapshotBackup(),
    prune:    pruneOldBackups(),
    disk:     checkDiskHealth(),
    ts:       new Date().toISOString(),
  };
}
