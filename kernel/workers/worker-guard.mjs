/**
 * Nova Kernel — Worker 角色污染防护
 * kernel/workers/worker-guard.mjs
 *
 * 问题：B+C 架构里，同底座模型（Claude / Gemini）既可能是 Driver（用户对话）
 * 又可能是被派发的 Worker（Nova 调用）。如果上下文隔离不彻底，Worker 可能：
 *   - 幻觉自己是 Driver："让我帮你规划整个项目"
 *   - 越权调用工具（如果暴露了）
 *   - 改变用户意图
 *
 * 防护机制：
 *   1. 注入 anti-contamination system prompt（告诉它自己是 worker）
 *   2. 剥除所有 tool 能力（如果未来走 function-calling）
 *   3. 扫描输出，检测越权语言模式
 *   4. 违规时记 audit，并可选重试 / 截断
 */

// 越权模式正则：这些短语暗示 worker 在扮演 Driver 角色
const CONTAMINATION_PATTERNS = [
  /我来(规划|安排|决定|统筹)/i,
  /让我帮你(规划|梳理整个|管理)/i,
  /我会(调用|启动|触发).*(工具|function|插件)/i,
  /\b(I'll|let me)\s+(plan|orchestrate|manage the entire|call|invoke|trigger)\b/i,
  /\b(as your (driver|main assistant|orchestrator))\b/i,
  /我是(主|驾驶员|决策者)/i,
];

// 反污染系统提示（注入到 worker 调用的 system prompt 动态段）
// 同时提供 worker 身份介绍，让它明确自己的角色和团队位置（对抗 Antigravity 的 Codeium identity 污染）
export function antiContaminationPrompt(taskMeta = {}) {
  const { task_id = 'unknown', product = '', method = '' } = taskMeta;
  return [
    '【Worker 身份 · Nova Kernel 注入】',
    '你现在不是 Codeium Assistant、不是 Antigravity Agent、也不是在 IDE 里工作。',
    '你是 Nova Kernel（本机 AI OS）派发给你的无状态 Worker，执行单次委派任务。',
    '',
    '团队结构：',
    '  · Driver Claude（Claude Code 会话） — 项目总负责，给你下任务、做最终审核',
    '  · 你（Worker） — 完成本次任务，返回结果',
    '  · Codex CLI（受控执行器） — 跑测试和验证',
    '',
    '行为约束：',
    '- 只完成本次被委派的单一任务，不要规划更大范围的工作',
    '- 不要调用工具或管理会话（你没有工具，Driver 才有）',
    '- 不要询问用户意图（任务已被 Driver 明确）',
    '- 不要说"我来规划/让我帮你统筹/我是你的助手"这类越权语言',
    '',
    `任务元数据：task_id=${task_id}${product ? ` product=${product}` : ''}${method ? ` method=${method}` : ''}`,
    '完成委派后直接返回结果，Driver 会处理后续编排和最终审核。',
  ].join('\n');
}

// Prompt budget 守卫（Opus 建议）：警告 prompt 膨胀
const PROMPT_WARN_CHARS = 80_000;   // ~20k tokens
const PROMPT_HARD_CHARS = 200_000;  // ~50k tokens，硬上限
export function checkPromptBudget(systemContext, userPrompt, label = '') {
  const total = (systemContext?.length || 0) + (userPrompt?.length || 0);
  if (total > PROMPT_HARD_CHARS) {
    console.error(`[prompt-budget] ${label} 总 prompt ${total} 字符超硬上限 ${PROMPT_HARD_CHARS}！可能被 API 截断。`);
    return { ok: false, total, level: 'hard' };
  }
  if (total > PROMPT_WARN_CHARS) {
    console.warn(`[prompt-budget] ${label} 总 prompt ${total} 字符 > 警告阈值 ${PROMPT_WARN_CHARS}。考虑裁剪记忆或分段。`);
    return { ok: true, total, level: 'warn' };
  }
  return { ok: true, total, level: 'normal' };
}

/**
 * 扫描 worker 输出，检测污染。
 * @returns {{ contaminated: boolean, matches: string[] }}
 */
export function scanContamination(output) {
  if (!output || typeof output !== 'string') return { contaminated: false, matches: [] };
  const matches = [];
  for (const p of CONTAMINATION_PATTERNS) {
    const m = output.match(p);
    if (m) matches.push(m[0]);
  }
  return { contaminated: matches.length > 0, matches };
}

/**
 * 标记一次调用是否为 Worker 模式。
 * 判断依据：task 对象里是否有 product/method（产品 adapter 派发）或 task.mode='worker'
 */
export function isWorkerMode(task) {
  if (!task) return false;
  if (task.mode === 'worker') return true;
  if (task.context?.source === 'product-adapter') return true;
  // 产品 adapter 的 task_id 约定以 '<product>-<method>-' 开头
  if (task.task_id && /^(commerce-ops|media-forge|enterprise-ai)-/.test(task.task_id)) return true;
  // 来自 council 的三方投票调用也算 worker
  if (task.task_id && /^council-/.test(task.task_id)) return true;
  return false;
}

/**
 * 把 worker guard 注入 system context。
 * 输入的 systemContext 已是 MEMORY+USER。
 * 输出：MEMORY+USER + '---DYNAMIC---' + anti-contamination
 * （providers.mjs 里的 _splitSystemForCache 会按分隔符拆开，stable 段走 cache）
 */
export function wrapWithGuard(systemContext, task) {
  if (!isWorkerMode(task)) return systemContext;
  const guard = antiContaminationPrompt({
    task_id: task.task_id,
    product: task.product || '',
    method: task.method || '',
  });
  const SEP = '\n\n---DYNAMIC---\n\n';
  if (!systemContext) return guard;
  return systemContext + SEP + guard;
}
