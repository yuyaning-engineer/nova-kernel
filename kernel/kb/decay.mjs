/**
 * kb/decay.mjs — 置信度衰减 + 引用晋级 (S3)
 *
 * 修复 Opus review 指出的 P0/P1/P2 bug (2026-04-19):
 *   - P0-1: boost/decay 后 conf 从未持久化 → 新增 _persistConfChange，write-new-then-forget-old
 *   - P1-3: promote 非原子 → 同样 write-first
 *   - P1-4: boost 和 archive 双重计数 → action 变量化，summary 按终态计数
 *   - P2-11: _daysSince(undefined) → NaN → fallback Infinity
 *   - P2-12: writeMemory({...e}) 携带旧 id → 显式解构剔除
 *
 * 每日夜间跑：
 *   - 对每条 active 记忆：查 30 天内 citation 次数
 *   - 有引用：conf += 0.05 * count（≤1.0）
 *   - 无引用且距今 > 30 天：conf -= 0.1
 *   - conf < 0.3 → forgetMemory（归档）
 *   - conf ≥ 0.85 且被 ≥2 个不同 session 引用 → 晋级（reference → feedback）
 */

import { readMemories, forgetMemory, writeMemory } from '../memory/memory-writer.mjs';
import { getCitationCount } from './vector-store.mjs';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const LOG_DIR = join(ROOT, 'logs');
const ARCHIVE_THRESHOLD = 0.3;
const PROMOTE_THRESHOLD = 0.85;
const DECAY_DAYS = 30;
const DECAY_AMOUNT = 0.1;
const CITE_BOOST = 0.05;

function _daysSince(iso) {
  if (!iso) return Infinity; // P2-11: 缺日期 = 最老（保守），不要 NaN 导致永不衰减
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return Infinity;
  return (Date.now() - t) / (1000 * 86400);
}

function _log(line) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const f = join(LOG_DIR, `kb-decay-${new Date().toISOString().slice(0, 10)}.log`);
  appendFileSync(f, `${new Date().toISOString()} ${line}\n`);
}

/**
 * 安全地更新一条记忆的 confidence：先写新，再删老（失败也只是重复，不丢数据）。
 * 返回新 entry id 或 null（如果写失败）。
 */
function _persistConfChange(e, newConf, { newType = null, newSource = null } = {}) {
  const { id: _oldId, created_at: _oldCreated, ...rest } = e; // P2-12: 剔除旧 id
  try {
    const newEntry = writeMemory({
      type: newType || rest.type,
      name: rest.name,
      description: rest.description,
      body: rest.body,
      source: newSource || rest.source || 'kb-decay',
      confidence: Math.max(0, Math.min(1.0, newConf)),
    });
    // 写成功后才删老的（P1-3 原子性）
    try { forgetMemory(_oldId); } catch {}
    return newEntry.id;
  } catch (err) {
    _log(`_persistConfChange FAIL ${e.type}/${e.name}: ${err.message}`);
    return null;
  }
}

export async function runDecay({ dry = false } = {}) {
  const all = readMemories();
  const summary = { total: all.length, archived: 0, promoted: 0, boosted: 0, decayed: 0, errors: 0 };

  for (const e of all) {
    // 不动关键系统记忆
    if (['nova-architecture-current', 'machine-spec-current', 'nova-daily-digest'].includes(e.name)) continue;
    if (e.source === 'machine-spec-auto' || e.source === 'arch-snapshot-auto') continue;

    const since = new Date(Date.now() - DECAY_DAYS * 86400 * 1000).toISOString();
    // P0 fallback (KB v2 嫁接): vector store 无数据时 getCitationCount 返 0,会全部归档
    // 改成: 若 vector store 未启用或返回 0,默认按 1 处理 (不衰减,等 vector 就绪再启实际计数)
    let cites = 0;
    try { cites = getCitationCount(e.id, since); } catch { cites = 1; }
    if (cites === 0 && (process.env.KB_DECAY_FALLBACK_CITE !== 'off')) cites = 1;
    const age = _daysSince(e.created_at);
    let conf = e.confidence || 1.0;
    let didBoost = false, didDecay = false;

    if (cites > 0) {
      conf = Math.min(1.0, conf + CITE_BOOST * cites);
      didBoost = true;
    } else if (age > DECAY_DAYS) {
      conf = Math.max(0, conf - DECAY_AMOUNT);
      didDecay = true;
    }

    // P1-4：终态分派；只增一类计数
    if (conf < ARCHIVE_THRESHOLD) {
      if (!dry) {
        try { forgetMemory(e.id); } catch { summary.errors++; }
      }
      _log(`archive ${e.type}/${e.name} conf=${conf.toFixed(2)} cites=${cites} age=${age.toFixed(0)}d`);
      summary.archived++;
      continue;
    }

    if (conf >= PROMOTE_THRESHOLD && cites >= 2 && e.type === 'reference') {
      if (!dry) {
        const newId = _persistConfChange(e, conf, { newType: 'feedback', newSource: 'kb-promoted' });
        if (!newId) summary.errors++;
      }
      _log(`promote ${e.name} reference→feedback conf=${conf.toFixed(2)} cites=${cites}`);
      summary.promoted++;
      continue;
    }

    // P0-1: boost/decay 的新 conf 必须持久化
    if ((didBoost || didDecay) && !dry && Math.abs(conf - (e.confidence || 1.0)) >= 0.01) {
      const newId = _persistConfChange(e, conf, { newSource: didBoost ? 'kb-boosted' : 'kb-decayed' });
      if (!newId) { summary.errors++; continue; }
      _log(`${didBoost ? 'boost' : 'decay'} ${e.type}/${e.name} ${e.confidence?.toFixed(2)}→${conf.toFixed(2)} cites=${cites}`);
    }
    if (didBoost) summary.boosted++;
    else if (didDecay) summary.decayed++;
  }

  return { ok: true, dry, ...summary, ts: new Date().toISOString() };
}
