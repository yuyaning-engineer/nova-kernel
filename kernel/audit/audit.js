/**
 * Nova Kernel — Audit & Immutable Log System
 *
 * 两个职责：
 * 1. audit.db：所有重要操作的不可篡改审计记录（SQLite WAL）
 * 2. 日志文件 hash 锚定：logs/**\/*.md 写入后 hash 入库，
 *    后续读取时自动校验，篡改立即告警并锁定 evolution 引擎
 */

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const KERNEL_ROOT   = resolve(process.env.NOVA_KERNEL_ROOT || 'D:/nova-kernel');
const DB_PATH       = join(KERNEL_ROOT, 'kernel/audit/audit.db');
const HUMAN_LOG_DIR = join(KERNEL_ROOT, 'audit-human');

// ---------------------------------------------------------------------------
// 人类可读审计日志（中文 MD 镜像，每天一个文件）
// ---------------------------------------------------------------------------

// 重要事件 → 中文描述映射（未列出的事件不写 MD，减少噪音）
const HUMAN_EVENT_MAP = {
  // 任务
  'task.dispatched':              (t, d) => `📋 任务派发　　产品: ${t} | 风险: ${d?.riskLevel || '-'} | Worker: ${d?.worker || '-'}`,
  'task.blocked_l3':              (t, d) => `🚫 L3 拦截　　 任务: ${t} | 原因: 需要人类预批准`,
  // Gap 修复
  'gap_repair.applied':           (t, d) => `🔧 自动修复　　类型: ${d?.gap_type} | 项目: ${d?.project} | 等级: ${d?.level}`,
  'gap_repair.failed':            (t, d) => `❌ 修复失败　　类型: ${d?.gap_type} | 项目: ${d?.project} | 错误: ${d?.error}`,
  'gap_repair.circuit_opened':    (t, d) => `⚡ 熔断器触发　连续失败 ${d?.failure_count} 次，${d?.recovery_in_ms / 60000} 分钟后恢复`,
  'gap_repair.circuit_closed':    (t, d) => `✅ 熔断器恢复　自动修复引擎已重新启用`,
  'gap_repair.batch_halted':      (t, d) => `⏸  批量修复中止 熔断器OPEN，剩余 ${d?.remaining} 个 Gap 未处理`,
  // Skill 晋级
  'skill_vote.started':           (t, d) => `🗳  投票开始　　Skill: ${d?.skill}`,
  'skill_vote.approved':          (t, d) => `✅ 投票通过　　Skill: ${d?.skill} | 得分: ${d?.score?.toFixed(3)}`,
  'skill_vote.rejected':          (t, d) => `❌ 投票拒绝　　得分不足: ${d?.score?.toFixed(3)}`,
  'skill_vote.rejected_safety':   (t, d) => `🛑 安全门槛未过 safety: ${d?.safety_score?.toFixed(3)} < 0.80`,
  'skill_vote.self_approved':     (t, d) => `🤖 nova-self 独立批准 得分: ${d?.score?.toFixed(3)} | 原因: ${d?.reason}`,
  'skill.promoted':               (t, d) => `🎉 Skill 晋级　${d?.skill} → SKILL.md | 来源: ${d?.from}`,
  // 否决
  'veto_window.registered':       (t, d) => `⏳ 否决窗口开启 PR: ${t} | 截止: ${d?.deadline}`,
  'veto_window.expired':          (t, d) => `✅ 否决窗口关闭 PR: ${t}（无人否决，已自动晋级）`,
  'veto_window.vetoed':           (t, d) => `🚫 收到否决　　PR: ${t} | 否决人: ${d?.actor} | 原因: ${d?.reason}`,
  'veto_window.db_register_failed': (t, d) => `⚠️  DB注册失败　PR: ${t} | 错误: ${d?.error}`,
  // 回滚
  'rollback.skill_promotion':     (t, d) => `↩️  回滚Skill晋级 ${t}`,
  'rollback.gap_fix':             (t, d) => `↩️  回滚Gap修复 ${t} | 动作: ${d?.action}`,
  'rollback.arch_change':         (t, d) => `⚠️  架构变更需手动回滚 ${t}`,
  // 安全
  'log.tampered':                 (t, d) => `🔴 日志篡改告警 文件: ${t} | 预期hash: ${d?.expected?.slice(0,8)}... 实际: ${d?.actual?.slice(0,8)}...`,
  // 程序性记忆
  'procedural_memory.drafted':    (t, d) => `📝 Skill草稿生成 ${t} | 提取步骤: ${d?.steps_extracted}`,
  'procedural_memory.blocked':    (t, d) => `🛑 草稿安全扫描拦截 ${d?.reason}`,
};

/**
 * 写入人类可读的中文审计日志（仅重要事件，噪音事件自动跳过）
 */
function _writeHumanLog(event, operator, target, detail) {
  const formatter = HUMAN_EVENT_MAP[event];
  if (!formatter) return; // 不在映射表中的事件跳过

  try {
    mkdirSync(HUMAN_LOG_DIR, { recursive: true });
    const date   = new Date().toISOString().slice(0, 10);
    const time   = new Date().toISOString().slice(11, 19);
    const detail_obj = typeof detail === 'string' ? JSON.parse(detail || '{}') : (detail || {});
    const desc   = formatter(target || '', detail_obj);
    const line   = `| ${time} | ${operator.replace('ai:', '').replace('product:', '')} | ${desc} |\n`;
    const mdPath = join(HUMAN_LOG_DIR, `${date}.md`);

    // 文件不存在时写表头
    if (!existsSync(mdPath)) {
      writeFileSync(mdPath,
        `# Nova Kernel 审计日志 — ${date}\n\n` +
        `| 时间 | 操作者 | 事件 |\n` +
        `|------|--------|------|\n`,
        'utf8'
      );
    }
    appendFileSync(mdPath, line, 'utf8');
  } catch {} // 人类日志写失败不影响主流程
}

// ---------------------------------------------------------------------------
// DB 初始化
// ---------------------------------------------------------------------------

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS audit_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        REAL    NOT NULL,
      event     TEXT    NOT NULL,
      operator  TEXT    NOT NULL,
      target    TEXT,
      detail    TEXT,
      session   TEXT
    );

    CREATE TABLE IF NOT EXISTS log_hashes (
      path        TEXT PRIMARY KEY,
      sha256      TEXT NOT NULL,
      anchored_at REAL NOT NULL,
      session     TEXT
    );

    -- 每次操作结果的原始记录（驱动置信度计算）
    CREATE TABLE IF NOT EXISTS operation_outcomes (
      outcome_id   TEXT PRIMARY KEY,
      pr_id        TEXT,
      category     TEXT NOT NULL,
      operation    TEXT NOT NULL,
      level        TEXT NOT NULL,
      result       TEXT NOT NULL,    -- 'success' | 'failure' | 'vetoed' | 'rolled_back'
      blast_radius TEXT,
      executed_at  TEXT NOT NULL,
      duration_ms  INTEGER,
      error_code   TEXT,
      session      TEXT
    );

    -- 滚动窗口置信度聚合（定时更新）
    CREATE TABLE IF NOT EXISTS confidence_scores (
      category      TEXT NOT NULL,
      window        TEXT NOT NULL,   -- '7d' | '30d' | 'all_time'
      success_count INTEGER NOT NULL DEFAULT 0,
      total_count   INTEGER NOT NULL DEFAULT 0,
      success_rate  REAL    NOT NULL DEFAULT 0.0,
      last_updated  TEXT    NOT NULL,
      PRIMARY KEY (category, window)
    );

    -- Skill 晋级投票记录（unique 约束防止并发重复投票）
    CREATE TABLE IF NOT EXISTS skill_votes (
      vote_id      TEXT PRIMARY KEY,
      skill_draft  TEXT NOT NULL,
      voter        TEXT NOT NULL,    -- 'gemini-2.5-pro' | 'codex-o3' | 'nova-self'
      score        REAL NOT NULL,
      dimension    TEXT NOT NULL,    -- 'correctness' | 'safety' | 'utility' | 'novelty'
      rationale    TEXT,
      voted_at     TEXT NOT NULL,
      session_id   TEXT,
      UNIQUE(skill_draft, voter, dimension)   -- 每个投票者对每个维度只能投一次
    );

    -- 否决窗口持久化（进程重启后可恢复）
    CREATE TABLE IF NOT EXISTS veto_windows (
      pr_id          TEXT PRIMARY KEY,
      ai_pr_path     TEXT NOT NULL,
      draft_path     TEXT,           -- skill promotion 专用
      skill_name     TEXT,           -- skill promotion 专用
      operation_type TEXT NOT NULL,  -- 'skill_promotion' | 'gap_fix' | 'arch_change'
      deadline_at    REAL NOT NULL,  -- Unix timestamp
      status         TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'expired' | 'vetoed' | 'rolled_back'
      veto_actor     TEXT,
      veto_reason    TEXT,
      created_at     REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_ts        ON audit_events(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_event     ON audit_events(event);
    CREATE INDEX IF NOT EXISTS idx_outcomes_cat    ON operation_outcomes(category);
    CREATE INDEX IF NOT EXISTS idx_outcomes_ts     ON operation_outcomes(executed_at);
    CREATE INDEX IF NOT EXISTS idx_skill_votes     ON skill_votes(skill_draft);
    CREATE INDEX IF NOT EXISTS idx_veto_status     ON veto_windows(status);
    CREATE INDEX IF NOT EXISTS idx_veto_deadline   ON veto_windows(deadline_at);

    -- 内容提取去重表（knowledge-bridge / content-extractor 使用）
    CREATE TABLE IF NOT EXISTS url_seen (
      url_hash     TEXT PRIMARY KEY,
      url          TEXT NOT NULL,
      content_hash TEXT,
      vault_path   TEXT,
      platform     TEXT,
      extracted_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_url_seen_ts ON url_seen(extracted_at);
  `);

  return db;
}

let _db = null;
function getDb() {
  if (!_db) _db = openDb();
  return _db;
}

// ---------------------------------------------------------------------------
// 审计事件写入
// ---------------------------------------------------------------------------

/**
 * 写入审计事件（只追加，不可修改）
 */
export function auditLog({ event, operator, target = null, detail = null, session = null }) {
  const db = getDb();
  const detailJson = detail ? JSON.stringify(detail) : null;
  db.prepare(`
    INSERT INTO audit_events (ts, event, operator, target, detail, session)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(Date.now() / 1000, event, operator, target, detailJson, session);

  // 同步写人类可读 MD（重要事件才写，噪音自动过滤）
  _writeHumanLog(event, operator, target, detail ?? detailJson);
}

// ---------------------------------------------------------------------------
// 日志文件 hash 锚定
// ---------------------------------------------------------------------------

/**
 * 计算文件 SHA256
 */
export async function recordConnectorChange(id, oldStatus, newStatus, version = null) {
  auditLog({
    event: 'connector.status_changed',
    operator: 'system',
    target: id,
    detail: {
      old_status: oldStatus,
      new_status: newStatus,
      version,
    },
  });

  const dedupeKey = createHash('sha256')
    .update(`${id}:${version || 'n/a'}:${newStatus}`)
    .digest('hex')
    .slice(0, 12);
  const feedbackName = `connector-status-${dedupeKey}`;
  const feedbackPath = join(KERNEL_ROOT, 'kernel', 'memory', 'authoritative', 'feedback.jsonl');

  if (existsSync(feedbackPath)) {
    for (const line of readFileSync(feedbackPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.name === feedbackName) return { ok: true, deduped: true };
      } catch {}
    }
  }

  const { writeMemory } = await import('../memory/memory-writer.mjs');
  writeMemory({
    type: 'feedback',
    name: feedbackName,
    description: `Connector ${id} changed to ${newStatus}${version ? ` (${version})` : ''}`,
    body: [
      `Connector \`${id}\` status changed.`,
      `Previous: \`${oldStatus || 'unknown'}\``,
      `Current: \`${newStatus}\``,
      version ? `Version: \`${version}\`` : 'Version: n/a',
    ].join('\n'),
    source: 'connector-discovery',
    confidence: 0.9,
  });

  return { ok: true, deduped: false };
}

function hashFile(absPath) {
  const content = readFileSync(absPath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 锚定日志文件 hash（写入后立即调用）
 * @param {string} relPath - 相对于 KERNEL_ROOT 的路径，如 'logs/2026-04-10-commerce-ops-abc.md'
 * @param {string} session
 */
export function anchorLogHash(relPath, session = null) {
  const absPath = join(KERNEL_ROOT, relPath);
  if (!existsSync(absPath)) throw new Error(`[Audit] 文件不存在，无法锚定 hash: ${relPath}`);

  const sha256 = hashFile(absPath);
  const db = getDb();

  // append-only：不覆盖已有 hash。文件被追加内容后应写新记录（改表用 id 主键）。
  // 此处简单策略：若 path 已存在则忽略（文件内容追加后 hash 校验由 verifyLogHash 负责告警）
  db.prepare(`
    INSERT INTO log_hashes (path, sha256, anchored_at, session)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO NOTHING
  `).run(relPath, sha256, Date.now() / 1000, session);

  auditLog({ event: 'log.anchored', operator: 'system', target: relPath, detail: { sha256 }, session });
  return sha256;
}

/**
 * 校验日志文件完整性
 * @returns {{ ok: boolean, expected?: string, actual?: string }}
 */
export function verifyLogHash(relPath) {
  const db = getDb();
  const row = db.prepare('SELECT sha256 FROM log_hashes WHERE path = ?').get(relPath);

  if (!row) return { ok: false, reason: 'no_anchor' };

  const absPath = join(KERNEL_ROOT, relPath);
  if (!existsSync(absPath)) return { ok: false, reason: 'file_missing' };

  const actual = hashFile(absPath);
  if (actual !== row.sha256) {
    // 立即写入告警事件
    auditLog({
      event: 'log.tampered',
      operator: 'system',
      target: relPath,
      detail: { expected: row.sha256, actual },
    });
    return { ok: false, reason: 'hash_mismatch', expected: row.sha256, actual };
  }

  return { ok: true };
}

/**
 * 校验所有已锚定的日志文件
 * @returns {{ path: string, ok: boolean, reason?: string }[]}
 */
export function verifyAllLogs() {
  const db = getDb();
  const rows = db.prepare('SELECT path FROM log_hashes').all();
  return rows.map(({ path }) => ({ path, ...verifyLogHash(path) }));
}

// ---------------------------------------------------------------------------
// 开发日志写入（自动锚定）
// ---------------------------------------------------------------------------

/**
 * 写入一条不可篡改的开发日志
 * @param {Object} entry
 */
export function writeDevLog({ project, session_id, operator, phase, action, result, next_steps = [] }) {
  const ts = new Date().toISOString();
  const date = ts.slice(0, 10);
  const shortSession = (session_id || 'unknown').slice(0, 8);
  const filename = `${date}-${project}-${shortSession}.md`;
  const relPath = `logs/${filename}`;
  const absPath = join(KERNEL_ROOT, relPath);

  // 如果文件已存在，追加；否则新建（带 header）
  const entryBlock = `
## ${ts}

| 字段 | 内容 |
|------|------|
| session_id | ${session_id} |
| operator | ${operator} |
| phase | ${phase} |
| action | ${action} |
| result | ${result} |

**Next Steps:**
${next_steps.map(s => `- ${s}`).join('\n') || '- (none)'}

---
`;

  if (!existsSync(absPath)) {
    writeFileSync(absPath, `# 开发日志 — ${project}\n\n> 此文件由 Nova Kernel 自动生成，禁止手动修改。\n` + entryBlock, 'utf8');
  } else {
    appendFileSync(absPath, entryBlock, 'utf8');
  }

  // 锚定 hash
  anchorLogHash(relPath, session_id);

  auditLog({ event: 'devlog.written', operator, target: relPath, detail: { phase, action }, session: session_id });

  return relPath;
}

// ---------------------------------------------------------------------------
// 置信度 & 操作结果追踪
// ---------------------------------------------------------------------------

// 防抖：聚合同一 event-loop 轮次内对相同 category 的多次 refresh 请求
const _pendingRefresh = new Set();
let _refreshScheduled = false;

function _scheduleRefresh(category) {
  _pendingRefresh.add(category);
  if (!_refreshScheduled) {
    _refreshScheduled = true;
    setImmediate(() => {
      _refreshScheduled = false;
      const cats = [..._pendingRefresh];
      _pendingRefresh.clear();
      for (const cat of cats) refreshConfidence(cat);
    });
  }
}

/**
 * 记录一次操作结果（驱动置信度计算）
 */
export function recordOutcome({ prId = null, category, operation, level, result, blastRadius = 'local', durationMs = null, errorCode = null, session = null }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO operation_outcomes
      (outcome_id, pr_id, category, operation, level, result, blast_radius, executed_at, duration_ms, error_code, session)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), prId, category, operation, level, result,
    blastRadius, new Date().toISOString(), durationMs, errorCode, session
  );

  // 异步更新置信度（防抖：同一批次对相同 category 的多次调用合并为一次 DB 写入）
  _scheduleRefresh(category);
}

/**
 * 重新聚合某个 category 的置信度分数
 */
export function refreshConfidence(category) {
  const db = getDb();
  const now = new Date().toISOString();

  for (const window of ['7d', '30d', 'all_time']) {
    const cutoff = window === 'all_time'
      ? '1970-01-01T00:00:00Z'
      : new Date(Date.now() - (window === '7d' ? 7 : 30) * 86400_000).toISOString();

    const row = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) as success
      FROM operation_outcomes
      WHERE category = ? AND executed_at >= ?
    `).get(category, cutoff);

    const total = row.total || 0;
    const success = row.success || 0;
    const rate = total > 0 ? success / total : 0;

    db.prepare(`
      INSERT INTO confidence_scores (category, window, success_count, total_count, success_rate, last_updated)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(category, window) DO UPDATE SET
        success_count = excluded.success_count,
        total_count   = excluded.total_count,
        success_rate  = excluded.success_rate,
        last_updated  = excluded.last_updated
    `).run(category, window, success, total, rate, now);
  }
}

/**
 * 查询某 category 的置信度（优先 7d，其次 30d，最后 all_time）
 * @returns {number} 0~1，若无数据返回 null（表示首次操作）
 */
export function getConfidence(category) {
  const db = getDb();
  for (const window of ['7d', '30d', 'all_time']) {
    const row = db.prepare(
      'SELECT success_rate, total_count FROM confidence_scores WHERE category = ? AND window = ?'
    ).get(category, window);
    if (row && row.total_count >= 3) return row.success_rate;
  }
  return null; // 数据不足，视为首次
}

// ---------------------------------------------------------------------------
// Skill 投票
// ---------------------------------------------------------------------------

/**
 * 写入一条 Skill 投票
 */
export function recordSkillVote({ skillDraft, voter, score, dimension, rationale = null, sessionId = null }) {
  const db = getDb();
  // INSERT OR REPLACE 利用 UNIQUE(skill_draft, voter, dimension) 约束防止并发重复投票
  db.prepare(`
    INSERT OR REPLACE INTO skill_votes (vote_id, skill_draft, voter, score, dimension, rationale, voted_at, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), skillDraft, voter, score, dimension, rationale, new Date().toISOString(), sessionId);
}

/**
 * 获取某 Skill 草稿的所有投票
 */
export function getSkillVotes(skillDraft) {
  const db = getDb();
  return db.prepare('SELECT * FROM skill_votes WHERE skill_draft = ?').all(skillDraft);
}

// ---------------------------------------------------------------------------
// 否决窗口持久化（进程重启后可恢复）
// ---------------------------------------------------------------------------

/**
 * 注册否决窗口到数据库
 */
export function registerVetoWindow({ prId, aiPrPath, draftPath = null, skillName = null, operationType, deadlineAt, }) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO veto_windows (pr_id, ai_pr_path, draft_path, skill_name, operation_type, deadline_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(prId, aiPrPath, draftPath, skillName, operationType, deadlineAt / 1000, Date.now() / 1000);
}

/**
 * 标记否决窗口为已否决
 */
export function markVetoed({ prId, vetoActor, vetoReason }) {
  const db = getDb();
  db.prepare(`
    UPDATE veto_windows SET status = 'vetoed', veto_actor = ?, veto_reason = ? WHERE pr_id = ?
  `).run(vetoActor, vetoReason, prId);
}

/**
 * 标记否决窗口为已回滚
 */
export function markRolledBack({ prId }) {
  const db = getDb();
  db.prepare(`UPDATE veto_windows SET status = 'rolled_back' WHERE pr_id = ?`).run(prId);
}

/**
 * 查询所有活跃（未过期、未否决）的否决窗口
 */
export function getActiveVetoWindows() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM veto_windows WHERE status = 'active' ORDER BY deadline_at ASC
  `).all();
}

/**
 * 查询已过期（deadline 到期且仍 active）的否决窗口
 */
export function getExpiredVetoWindows() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM veto_windows WHERE status = 'active' AND deadline_at < ?
  `).all(Date.now() / 1000);
}

/**
 * 标记否决窗口为已归档（过期无否决）
 */
export function markExpired({ prId }) {
  const db = getDb();
  db.prepare(`UPDATE veto_windows SET status = 'expired' WHERE pr_id = ?`).run(prId);
}

// ── 内容提取去重 ─────────────────────────────────────────────────
export function isUrlSeen(urlHash) {
  const db = getDb();
  const row = db.prepare('SELECT url_hash FROM url_seen WHERE url_hash = ?').get(urlHash);
  return !!row;
}

export function recordUrlSeen({ urlHash, url, contentHash = null, vaultPath = null, platform = null }) {
  const db = getDb();
  // P1-3 fix: extracted_at stored in seconds (Unix epoch), not milliseconds
  db.prepare(`INSERT OR IGNORE INTO url_seen (url_hash, url, content_hash, vault_path, platform, extracted_at) VALUES (?, ?, ?, ?, ?, ?)`).run(urlHash, url, contentHash, vaultPath, platform, Math.floor(Date.now() / 1000));
}
