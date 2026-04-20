/**
 * task-router.mjs -- Task-Type Router
 *
 * Routes tasks to the optimal AI provider + model based on WHAT the task is,
 * not just complexity. Replaces the old complexity-only routing in model-router.mjs
 * for the primary dispatch path.
 *
 * Routing tiers:
 *   Ultra-low cost  (< $0.50/M tokens) -- classify/extract/summarize/translate/chat
 *   Medium cost     ($1-3/M tokens)    -- code_generate/code_review/analysis
 *   High cost       ($2-8/M tokens)    -- deep_reasoning
 *   Premium         ($15+/M tokens)    -- architecture/creative
 *   Large context   (1M+ tokens)       -- codebase_scan
 *
 * Falls back gracefully when primary model unavailable (429/503).
 *
 * Dynamic model resolution:
 *   ROUTING_TABLE stores modelRole strings (e.g. 'claude_sonnet', 'gemini_flash').
 *   getRoute() resolves roles to actual model IDs via model-discovery.mjs,
 *   which queries provider APIs at startup and daily.
 *   If discovery hasn't run yet, static fallbacks from models.js/env vars are used.
 */

import { getLatestModel } from '../config/model-discovery.mjs';

// ---------------------------------------------------------------------------
// Routing table: task_type -> { provider, modelRole, fallbackProvider, fallbackModelRole }
//
// modelRole / fallbackModelRole are keys understood by getLatestModel().
// Actual model IDs are resolved lazily in getRoute().
// ---------------------------------------------------------------------------

/**
 * ROUTING_TABLE — 基于用户实际可用的 3 个 AI 能力:
 *
 *   ✅ Gemini HTTP API    — 有 Key，便宜快速，1M context
 *   ✅ Claude CLI          — `claude --print`，用 Claude Code 订阅鉴权，无需 API Key
 *   ✅ Codex CLI           — `codex exec --full-auto`，CLI 自带鉴权，自治 Agent 模式
 *
 * 三个 provider 各有所长:
 *   claude — 代码质量最高，指令遵循最强，适合代码/审查/创意/架构
 *   google — 最便宜最快，1M context，适合聊天/分析/批量处理
 *   codex  — 能读写文件+执行命令，适合自治工程任务
 *
 * 如果将来配置了 ANTHROPIC_API_KEY / OPENAI_API_KEY，
 * providers.mjs 的 SDK 路径会自动激活（延迟更低）。
 */
const ROUTING_TABLE = {
  // ── Claude CLI — 代码质量+创意+架构（指令遵循最强）─────────────────
  creative:      { provider: 'claude', modelRole: 'claude_sonnet',  fallbackProvider: 'google', fallbackModelRole: 'gemini_pro' },
  architecture:  { provider: 'claude', modelRole: 'claude_opus',    fallbackProvider: 'claude', fallbackModelRole: 'claude_sonnet' },
  code_review:   { provider: 'claude', modelRole: 'claude_sonnet',  fallbackProvider: 'google', fallbackModelRole: 'gemini_pro' },
  code_generate: { provider: 'claude', modelRole: 'claude_sonnet',  fallbackProvider: 'codex',  fallbackModelRole: 'codex_full' },

  // ── Codex CLI — 自治工程（能读写文件+执行命令+自我验证）────────────
  // Codex 的独特能力是文件系统操作+命令执行，适合需要"写完跑一下"的场景
  code_fix:      { provider: 'codex',  modelRole: 'codex_full',     fallbackProvider: 'claude', fallbackModelRole: 'claude_sonnet' },
  code_exec:     { provider: 'codex',  modelRole: 'codex_full',     fallbackProvider: 'claude', fallbackModelRole: 'claude_sonnet' },

  // ── Gemini Flash — 高频、低成本、快速 ──────────────────────────────
  chat:          { provider: 'google', modelRole: 'gemini_flash',   fallbackProvider: 'claude', fallbackModelRole: 'claude_sonnet' },
  classify:      { provider: 'google', modelRole: 'gemini_flash',   fallbackProvider: 'google', fallbackModelRole: 'gemini_flash_stable' },
  extract_data:  { provider: 'google', modelRole: 'gemini_flash',   fallbackProvider: 'google', fallbackModelRole: 'gemini_flash_stable' },
  summarize:     { provider: 'google', modelRole: 'gemini_flash',   fallbackProvider: 'google', fallbackModelRole: 'gemini_flash_stable' },
  translate:     { provider: 'google', modelRole: 'gemini_flash',   fallbackProvider: 'google', fallbackModelRole: 'gemini_flash_stable' },

  // ── Gemini Pro — 分析、大上下文 ────────────────────────────────────
  analysis:      { provider: 'google', modelRole: 'gemini_pro',     fallbackProvider: 'claude', fallbackModelRole: 'claude_sonnet' },
  codebase_scan: { provider: 'google', modelRole: 'gemini_pro',     fallbackProvider: 'google', fallbackModelRole: 'gemini_flash' },
  deep_reasoning:{ provider: 'google', modelRole: 'gemini_pro',     fallbackProvider: 'claude', fallbackModelRole: 'claude_sonnet' },
};

// ---------------------------------------------------------------------------
// Task type inference -- keyword + explicit type + complexity fallback
// ---------------------------------------------------------------------------

/**
 * Infer task type from prompt keywords, explicit task_type field, and complexity.
 *
 * Priority:
 *   1. explicitType (if valid key in ROUTING_TABLE)
 *   2. Keyword matching against prompt text
 *   3. Complexity-based fallback
 *
 * @param {string} prompt        The task prompt text
 * @param {string} explicitType  Optional explicit task_type from caller
 * @param {number} complexity    Task complexity (1-5)
 * @returns {string}             A key in ROUTING_TABLE
 */
function inferTaskType(prompt, explicitType, complexity) {
  // 1. Explicit type takes priority
  if (explicitType && ROUTING_TABLE[explicitType]) return explicitType;

  const lower = (prompt || '').toLowerCase();

  // 2. Keyword-based inference (ordered by specificity -- more specific first)
  if (/架构|architecture|设计方案|system design/.test(lower)) return 'architecture';
  if (/推理|reasoning|数学|math|prove|证明/.test(lower)) return 'deep_reasoning';
  // 代码修复/执行（Codex 独有能力：能操作文件系统+执行命令）
  if (/修复|fix\s+.*bug|debug|修bug|repair|调试|运行|execute|run this|跑一下|fix this|fix the/.test(lower)) return 'code_fix';
  // 代码生成（Codex 首选）
  if (/写代码|write\s+.*(?:code|script|function|program|parser|scraper|crawler|server|api)|implement|code gen|编写|实现|编程|build\s+.*(?:script|function|app|tool)|coding|程序|脚本|函数|function|帮我写/.test(lower)) return 'code_generate';
  // 代码审查（Claude 首选 — 审查需要最强的理解力）
  if (/审查|review|检查代码|code review|代码检查/.test(lower)) return 'code_review';
  if (/扫描代码|scan code|codebase|全量扫描/.test(lower)) return 'codebase_scan';
  if (/分析|analyze|调研|research/.test(lower)) return 'analysis';
  if (/翻译|translate/.test(lower)) return 'translate';
  if (/摘要|summarize|总结/.test(lower)) return 'summarize';
  if (/分类|classify|判断/.test(lower)) return 'classify';
  if (/提取|extract/.test(lower)) return 'extract_data';
  if (/创作|creative|写作|故事|小说/.test(lower)) return 'creative';

  // 3. Greeting/chat detection (before complexity fallback)
  if (/^(hello|hi|hey|你好|嗨|哈哈|早|晚安|good morning|how are you)/i.test(lower.trim())) return 'chat';

  // 4. Complexity-based fallback
  if (complexity <= 1) return 'chat';
  if (complexity <= 3) return 'analysis';
  if (complexity >= 5) return 'deep_reasoning';
  return 'code_generate'; // complexity 4
}

/**
 * Get the resolved route for a task type.
 * Dynamically resolves modelRole -> actual model ID via model-discovery.
 *
 * @param {string} taskType  Key from ROUTING_TABLE
 * @returns {{ provider: string, model: string, fallbackProvider: string, fallbackModel: string, modelRole: string, fallbackModelRole: string }}
 */
function getRoute(taskType) {
  const template = ROUTING_TABLE[taskType] || ROUTING_TABLE['chat'];
  return {
    provider:          template.provider,
    model:             getLatestModel(template.modelRole),
    modelRole:         template.modelRole,
    fallbackProvider:  template.fallbackProvider,
    fallbackModel:     getLatestModel(template.fallbackModelRole),
    fallbackModelRole: template.fallbackModelRole,
  };
}

/**
 * List all valid task types.
 * @returns {string[]}
 */
function listTaskTypes() {
  return Object.keys(ROUTING_TABLE);
}

export { ROUTING_TABLE, inferTaskType, getRoute, listTaskTypes };
