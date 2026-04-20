/**
 * Nova Kernel — Unified Task ABI
 *
 * 所有产品（TriForge/RedOps/Anime-Generator/...）与 Worker Pool 之间的统一通信契约。
 * 修改此文件属于 L3 操作，需要人类审批（见 constitutional.json）。
 */

import { classify } from '../utils/l3-gate.mjs';
import { randomUUID } from 'crypto';
import { resolveModel } from '../config/models.js';

// ---------------------------------------------------------------------------
// Task Input Schema
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TaskInput
 * @property {string}   task_id       - 唯一 ID，格式：<project>-<ulid>
 * @property {string}   project       - 所属产品命名空间（commerce-ops / media-forge / enterprise-ai）
 * @property {string}   session_id    - 父会话 ID
 * @property {string}   worker        - 目标 worker（gemini / codex / claude）
 * @property {number}   complexity    - 任务复杂度 1-5（影响模型路由）
 * @property {string}   prompt        - 任务描述（自然语言）
 * @property {Object}   [context]     - 可选上下文（从 Memory API 注入）
 * @property {string[]} [depends_on]  - 依赖的 task_id 列表（必须先完成）
 * @property {number}   [timeout_ms]  - 超时，默认 120000
 * @property {string}   [risk_level]  - 'L1' | 'L2' | 'L3'，未指定时由 risk-classifier 自动判断
 * @property {Object}   [permissions] - 允许的操作（read_paths / write_paths / allowed_domains）
 */

// ---------------------------------------------------------------------------
// Task Result Schema
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TaskResult
 * @property {string}   task_id
 * @property {string}   status        - 'pass' | 'fail' | 'partial' | 'timeout' | 'blocked'
 * @property {string}   worker        - 实际执行的 worker
 * @property {string}   [actual_model]- 实际使用的模型（CLI 可能与 planned 不同）
 * @property {string}   output        - 主要输出内容（文本）
 * @property {string[]} [written_files]- 写入的文件路径列表
 * @property {number}   time_ms       - 实际耗时
 * @property {boolean}  [retried]     - 是否经历重试
 * @property {string}   [error]       - 失败原因
 */

// ---------------------------------------------------------------------------
// Risk Classifier（根据 task 内容自动判断风险等级）
// ---------------------------------------------------------------------------

const L3_PATTERNS = [
  /orchestrator\.m?js/i,
  /worker.registry/i,
  /task.schema/i,
  /constitutional/i,
  /audit\.db/i,
  /kernel\/memory\/security/i,
];

const L2_PATTERNS = [
  /SKILL\.md/i,
  /config\//i,
  /adapter\.(py|mjs|js)/i,
  /外部\s*API/,
  /external.*api/i,
  /products\//i,
];

/**
 * 自动判断任务风险等级
 * @param {string} prompt
 * @param {string[]} [writePaths]
 * @returns {'L1' | 'L2' | 'L3'}
 */
export function classifyRisk(prompt = '', writePaths = []) {
  return classify({ prompt, writePaths }).level;
}

// ---------------------------------------------------------------------------
// Task Validator
// ---------------------------------------------------------------------------

const VALID_WORKERS = new Set(['gemini', 'codex', 'claude']);
const VALID_STATUSES = new Set(['pass', 'fail', 'partial', 'timeout', 'blocked']);

/**
 * 验证 TaskInput 是否符合 ABI 规范
 * @param {TaskInput} task
 * @throws {Error}
 */
export function validateTaskInput(task) {
  if (!task.task_id) throw new Error('[TaskABI] task_id 必填');
  if (!task.project) throw new Error('[TaskABI] project 必填');
  if (!task.session_id) throw new Error('[TaskABI] session_id 必填');
  if (!VALID_WORKERS.has(task.worker)) throw new Error(`[TaskABI] 未知 worker: ${task.worker}`);
  if (!task.prompt) throw new Error('[TaskABI] prompt 必填');
  if (task.complexity && (task.complexity < 1 || task.complexity > 5)) {
    throw new Error('[TaskABI] complexity 必须在 1-5 之间');
  }
}

/**
 * 验证 TaskResult 是否符合 ABI 规范
 * @param {TaskResult} result
 * @throws {Error}
 */
export function validateTaskResult(result) {
  if (!result.task_id) throw new Error('[TaskABI] result.task_id 必填');
  if (!VALID_STATUSES.has(result.status)) throw new Error(`[TaskABI] 未知 status: ${result.status}`);
  if (typeof result.time_ms !== 'number') throw new Error('[TaskABI] result.time_ms 必须为数字');
}

// ---------------------------------------------------------------------------
// Task ID 生成
// ---------------------------------------------------------------------------

let _counter = 0;

/**
 * 生成唯一 task_id
 * @param {string} project
 * @returns {string}
 */
export function generateTaskId(project) {
  const ts = Date.now().toString(36);
  const rand = randomUUID().replace(/-/g, '').slice(0, 4);
  const seq = (++_counter).toString(36).padStart(3, '0');
  return `${project}-${ts}-${rand}-${seq}`;
}

// ---------------------------------------------------------------------------
// Worker 自动路由（资源分配策略）
// ---------------------------------------------------------------------------

/**
 * Worker → 模型映射（实际版本由 kernel/config/models.js 管理）:
 *   gemini  — gemini-3-flash-preview（c≤3）/ gemini-3.1-pro-preview（c>3），成本低
 *   codex   — gpt-5.4-mini（c≤3，编码/子agent）/ gpt-5.4（c>3，复杂推理），成本中
 *   claude  — claude-sonnet-4-6（日常）/ claude-opus-4-6（L3 Council），成本高
 *
 * 升级模型：修改 .env 中的 GEMINI_PRO_MODEL / CODEX_MINI_MODEL 等，无需改代码。
 */
const WORKER_ROUTING_TABLE = [
  // { complexity_max, risk_levels, worker }  — 按优先级从高到低匹配
  { complexity_max: 5, risk_levels: ['L3'],       worker: 'claude'  }, // L3 必须 claude council
  { complexity_max: 2, risk_levels: ['L1', 'L2'], worker: 'gemini'  }, // 简单任务 → Gemini Flash
  { complexity_max: 3, risk_levels: ['L1', 'L2'], worker: 'gemini'  }, // 中量任务 → Gemini Pro
  { complexity_max: 5, risk_levels: ['L1', 'L2'], worker: 'codex'   }, // 复杂工程 → Codex o3
];

/**
 * 根据复杂度和风险等级自动选择最优 Worker
 * 若调用方已指定 worker_hint 且合法，则尊重其选择。
 *
 * @param {number} complexity   1-5
 * @param {string} risk_level   'L1' | 'L2' | 'L3'
 * @param {string} [worker_hint] 调用方偏好（可选）
 * @returns {string}  最终选定的 worker 名
 */
// C014 fix: 合法 risk_level 白名单，防止非法值静默降级绕过 L3 约束
const VALID_RISK_LEVELS = new Set(['L1', 'L2', 'L3']);

export function resolveWorker(complexity = 2, risk_level = 'L1', worker_hint = '') {
  // C014: 非法 risk_level 快速失败，不允许静默降级
  if (!VALID_RISK_LEVELS.has(risk_level)) {
    throw new Error(`[resolveWorker] 非法 risk_level: "${risk_level}"，必须是 L1/L2/L3`);
  }

  // 调用方显式指定且合法 → 尊重选择（但 L3 强制 claude）
  if (worker_hint && VALID_WORKERS.has(worker_hint) && risk_level !== 'L3') {
    return worker_hint;
  }

  const c = Math.max(1, Math.min(5, complexity));
  for (const rule of WORKER_ROUTING_TABLE) {
    if (rule.risk_levels.includes(risk_level) && c <= rule.complexity_max) {
      return rule.worker;
    }
  }
  // 兜底：路由表配置缺口，快速失败而非静默降级
  throw new Error(`[resolveWorker] 路由表无规则覆盖 complexity=${complexity} risk=${risk_level}`);
}
