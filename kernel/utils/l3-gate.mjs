/**
 * Nova Kernel — Autonomy Gate (Commerce Edition · Conservative Mode)
 * kernel/utils/l3-gate.mjs
 *
 * 「执行+否决窗口」模型 — 客户版默认更保守。
 *
 *   L0  IMMUTABLE     — 宪法级硬锁，不可绕过（audit/security/constitutional 路径）
 *   L1  AUTO          — AI 全自主立即执行，写审计日志，无窗口（仅限内容生成、报表等无副作用类）
 *   L2  VETO_WINDOW   — AI 执行，开否决窗口（24h 高置信 / 48h 低置信）
 *   L3  PRE_APPROVAL  — 涉及公开发布 / 动钱 / 公开发言 / 资金流动的操作
 *
 * 分级决策：
 *   1. L0 路径 → 强制拒绝
 *   2. 命中 TRUE_L3_PATTERNS（含电商场景）→ L3 预批准
 *   3. confidence >= 0.85 + local  → L1（全自主）
 *      confidence >= 0.95 + 任意   → L1（全自主）
 *      confidence >= 0.60 + service → L2（24h 窗口）
 *      其他 / 首次                  → L2（48h 窗口，内置 0.50 基线）
 *
 * 设计哲学（客户版）：
 *   面向商用电商场景，默认保守。L1 仅用于完全无副作用的纯生成类任务，
 *   一切对外公开 / 影响营收 / 涉及客户沟通的动作都要经过 L2 否决窗口或 L3 预批准。
 */

import { writeProposal, EXEC_MODEL } from '../../evolution/proposal-writer.js';
import { auditLog, getConfidence, recordOutcome } from '../audit/audit.js';

// ---------------------------------------------------------------------------
// L0 绝对保护路径（任何写操作均拒绝，不可配置）
// ---------------------------------------------------------------------------

const L0_PROTECTED = [
  /constitutional\.json/i,
  /security\.js/i,
  /audit\.db/i,
  /audit\.js/i,
  /l3-gate\.mjs/i,
];

// ---------------------------------------------------------------------------
// L3：客户版扩展 — 通用外部不可逆 + 电商高风险动作
// 任何对外公开 / 动钱 / 公开发言 / 资金流动的操作都进 L3
// ---------------------------------------------------------------------------

const TRUE_L3_PATTERNS = [
  // ── 通用外部不可逆 ──
  /charge.*user|payment.*process/i,  // 用户付款（不可逆资金流动）
  /send.*email|send.*sms/i,          // 发送通信（已送达无法撤回）
  /post.*twitter|post.*weibo|post.*instagram/i, // 社交媒体公开发布
  /delete.*account|destroy.*account/i,          // 账户删除（数据永久丢失）

  // ── 电商场景：公开发布类 ──
  /publishProduct|publish.*product|listProduct|list.*product/i,  // 商品上架/发布
  /post.*comment|reply.*comment|replyComment/i,                  // 公开评论回复
  /publishContent|publish.*content|post.*content/i,              // 公开内容发布
  /go.*live|start.*livestream/i,                                 // 开播

  // ── 电商场景：动钱类 ──
  /updatePrice|update.*price|changePrice|change.*price|setPrice/i, // 改价
  /adjustAdPlan|adjust.*ad|launch.*ad|launch.*campaign/i,           // 广告计划调整/投放
  /createPurchaseOrder|create.*purchase.*order|place.*order/i,      // 采购订单
  /issueRefund|issue.*refund|refund.*customer/i,                    // 退款

  // ── 电商场景：客户沟通类 ──
  /sendVipMessage|send.*vip.*message|send.*customer.*message/i,     // 给客户发消息
  /customerServiceReply|customer.*service.*reply|cs.*reply/i,        // 客服正式回复
];

// ---------------------------------------------------------------------------
// 置信度基线（客户版更保守 — 首次操作只给 50% 信任）
// ---------------------------------------------------------------------------

export const CONFIDENCE_BASELINE = 0.50; // 客户版首次操作 50% 置信度，更保守

// ---------------------------------------------------------------------------
// 操作类别 → 置信度 category 名称映射
// ---------------------------------------------------------------------------

const CATEGORY_PATTERNS = [
  // 内核类
  { pattern: /skill.*promot/i,           category: 'skill_promote' },
  { pattern: /gap.*fix/i,                category: 'gap_fix' },
  { pattern: /worker.*add|add.*worker/i, category: 'worker_add' },
  { pattern: /adapter.*update/i,         category: 'adapter_update' },
  { pattern: /config.*change/i,          category: 'config_change' },
  { pattern: /memory.*write/i,           category: 'memory_write' },
  { pattern: /skill.*use|run.*skill/i,   category: 'skill_use' },
  { pattern: /deploy/i,                  category: 'deploy' },
  { pattern: /refactor/i,                category: 'refactor' },

  // 电商类
  { pattern: /generateSeoTitle|seo.*title/i,      category: 'seo_generate' },
  { pattern: /generateProductCopy|product.*copy/i, category: 'copy_generate' },
  { pattern: /generateScript|script.*generate/i,  category: 'script_generate' },
  { pattern: /buildDailyReport|daily.*report/i,   category: 'report_build' },
  { pattern: /forecastSales|sales.*forecast/i,    category: 'sales_forecast' },
  { pattern: /restock|restockSuggestion/i,        category: 'restock_advise' },
  { pattern: /removeBackground|background.*remove/i, category: 'image_bg_remove' },
  { pattern: /generateSceneImage|scene.*image/i,  category: 'image_scene_gen' },
  { pattern: /clipLongVideo|video.*clip/i,        category: 'video_clip' },
  { pattern: /detectLiveHighlights|live.*highlight/i, category: 'live_highlight' },
  { pattern: /searchByImage|image.*search/i,      category: 'image_search' },
  { pattern: /scoutDesignTrends|design.*trend/i,  category: 'design_trend' },
  { pattern: /recommendPattern|pattern.*recommend/i, category: 'pattern_recommend' },
  { pattern: /trackPurchaseOrder|po.*track/i,     category: 'po_track' },
  { pattern: /runVisualQc|visual.*qc/i,           category: 'visual_qc' },
  { pattern: /optimizeDispatch|dispatch.*optim/i, category: 'wms_dispatch' },
  { pattern: /manageVipLifecycle|vip.*lifecycle/i, category: 'vip_lifecycle' },
];

function inferCategory(prompt = '') {
  for (const { pattern, category } of CATEGORY_PATTERNS) {
    if (pattern.test(prompt)) return category;
  }
  return 'general_operation';
}

// ---------------------------------------------------------------------------
// 主分级函数
// ---------------------------------------------------------------------------

/**
 * @param {Object} opts
 * @param {string}   opts.prompt
 * @param {string[]} [opts.writePaths]
 * @param {string}   [opts.blastRadius]  - 'local' | 'service' | 'cross-service' | 'global'
 * @param {string}   [opts.category]
 * @returns {{ level: 'L1'|'L2'|'L3', execModel: string, confidence: number, category: string, vetoHours: number }}
 */
export function classify({ prompt = '', writePaths = [], blastRadius = 'local', category = null }) {
  const text = `${prompt} ${(writePaths || []).join(' ')}`;

  // 1. L0 硬锁
  if (L0_PROTECTED.some(p => p.test(text))) {
    return { level: 'L0', execModel: null, confidence: null, category: 'l0_protected', vetoHours: 0 };
  }

  // 2. 极少数真正 L3
  if (TRUE_L3_PATTERNS.some(p => p.test(text))) {
    return { level: 'L3', execModel: EXEC_MODEL.PRE_APPROVAL, confidence: null, category: 'external_irreversible', vetoHours: null };
  }

  // 3. 置信度分级（首次操作使用 CONFIDENCE_BASELINE 而非 null）
  const cat = category || inferCategory(prompt);
  const rawConfidence = getConfidence(cat);
  const confidence = rawConfidence ?? CONFIDENCE_BASELINE;

  // L1：高置信 + 本地操作，或极高置信任意范围（客户版收紧到 0.85）
  if (
    (confidence >= 0.85 && blastRadius === 'local') ||
    (confidence >= 0.95)
  ) {
    return { level: 'L1', execModel: EXEC_MODEL.AUTO, confidence, category: cat, vetoHours: 0 };
  }

  // L2：高置信 + 服务级 → 24h 窗口（客户版从 6h 拉长，给业务方更多反应时间）
  if (confidence >= 0.60 && (blastRadius === 'service' || blastRadius === 'local')) {
    return { level: 'L2', execModel: EXEC_MODEL.VETO_WINDOW, confidence, category: cat, vetoHours: 24 };
  }

  // L2：低置信或跨服务 → 48h 窗口（客户版从 12h 拉长）
  return { level: 'L2', execModel: EXEC_MODEL.VETO_WINDOW, confidence, category: cat, vetoHours: 48 };
}

// ---------------------------------------------------------------------------
// L0 拦截
// ---------------------------------------------------------------------------

export function blockL0({ taskId, project, prompt }) {
  auditLog({
    event: 'task.blocked_l0',
    operator: `product:${project}`,
    target: taskId,
    detail: { prompt: prompt.slice(0, 200), reason: 'L0 protected path' },
  });
  return {
    ok: false,
    status: 'blocked_l0',
    task_id: taskId,
    level: 'L0',
    message: 'L0 宪法级路径受保护，任何修改均不被允许。',
  };
}

// ---------------------------------------------------------------------------
// L3 拦截（生成 pre_approval AI-PR）
// ---------------------------------------------------------------------------

export function blockL3({ taskId, project, prompt, operator, sessionId, writePaths = [], worker }) {
  const impact = [
    `产品: ${project}`,
    worker ? `目标 Worker: ${worker}` : null,
    writePaths.length > 0 ? `写入路径: ${writePaths.join(', ')}` : null,
  ].filter(Boolean);

  let aiPrPath = null;
  try {
    aiPrPath = writeProposal({
      type: 'l3_operation',
      execution_model: EXEC_MODEL.PRE_APPROVAL,
      title: `[${project}] 外部操作请求: ${prompt.slice(0, 50)}`,
      motivation: `产品 ${project} 发起了需要人工批准的外部操作。\n\n**任务 ID:** ${taskId}\n**描述:** ${prompt}`,
      proposal: `授权以下操作:\n- 产品: ${project}\n- 任务: ${prompt}\n${worker ? `- Worker: ${worker}` : ''}`,
      impact,
      risks: ['外部不可逆操作，执行前需确认'],
      blast_radius: 'global',
      reversible: false,
      operator: operator || `product:${project}`,
      session_id: sessionId,
    });
  } catch (err) {
    console.error('[autonomy-gate] writeProposal failed:', err.message);
  }

  auditLog({
    event: 'task.blocked_l3',
    operator: operator || `product:${project}`,
    target: taskId,
    detail: { project, prompt: prompt.slice(0, 200), worker, ai_pr_path: aiPrPath, write_paths: writePaths },
    session: sessionId,
  });

  return {
    ok: false,
    status: 'requires_approval',
    task_id: taskId,
    level: 'L3',
    ai_pr_path: aiPrPath,
    message: `外部操作需要人工批准。AI-PR 已生成。${aiPrPath ? `\n文件: ${aiPrPath}` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// L2 记录（生成 veto_window AI-PR，AI 同时执行操作）
// ---------------------------------------------------------------------------

export function recordL2({ taskId, project, prompt, operator, sessionId, blastRadius = 'local', vetoHours = 6, category = 'general_operation', confidence = null }) {
  let aiPrPath = null;
  try {
    aiPrPath = writeProposal({
      type: 'arch_change',
      execution_model: EXEC_MODEL.VETO_WINDOW,
      title: `[${project}] ${prompt.slice(0, 55)}`,
      motivation: prompt,
      proposal: `任务 ${taskId} 已自动执行。否决截止前可撤销。`,
      impact: [`产品: ${project}`],
      risks: ['操作已执行，否决将触发回滚'],
      blast_radius: blastRadius,
      reversible: true,
      confidence,
      veto_hours: vetoHours,
      operator: operator || `product:${project}`,
      session_id: sessionId,
    });
  } catch (err) {
    console.error('[autonomy-gate] recordL2 writeProposal failed:', err.message);
  }

  auditLog({
    event: 'task.executed_l2',
    operator: operator || `product:${project}`,
    target: taskId,
    detail: { project, category, veto_hours: vetoHours, ai_pr_path: aiPrPath, confidence },
    session: sessionId,
  });

  return { ai_pr_path: aiPrPath, veto_hours: vetoHours };
}

// ---------------------------------------------------------------------------
// 操作结果回报（更新置信度）
// ---------------------------------------------------------------------------

export function reportOutcome({ prId = null, category, level, result, blastRadius = 'local', durationMs = null, errorCode = null, session = null }) {
  recordOutcome({ prId, category, operation: category, level, result, blastRadius, durationMs, errorCode, session });
}

// ---------------------------------------------------------------------------
// 向后兼容
// ---------------------------------------------------------------------------

export function classifyRisk(prompt = '', writePaths = []) {
  const { level } = classify({ prompt, writePaths });
  return level === 'L0' ? 'L3' : level;
}
