#!/usr/bin/env node
/**
 * Nova MCP Server — 把 Nova Kernel 的能力暴露为 MCP 工具
 *
 * 用途：让 Claude Code / 任何 MCP client 能：
 *   - 在对话中直接查/写 Nova 记忆（累积跨会话知识）
 *   - 调用 commerce-ops / media-forge / enterprise-ai 的产品方法
 *   - 走意图路由、看内核健康
 *
 * 协议：stdio（标准输入输出）— Claude Code 默认支持
 *
 * 注册方式（在 Claude Code 里）：
 *   claude mcp add nova -- node D:/claude/nova-commerce-edition/bin/nova-mcp.mjs
 *
 * 或在项目 .mcp.json：
 *   {
 *     "mcpServers": {
 *       "nova": { "command": "node", "args": ["D:/claude/nova-commerce-edition/bin/nova-mcp.mjs"] }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT     = resolve(SELF_DIR, '..');
const ENV_PATH = join(ROOT, '.env');

function loadEnv() {
  const env = {};
  if (!existsSync(ENV_PATH)) return env;
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const fileEnv = loadEnv();
const BASE  = process.env.NOVA_BASE_URL       || `http://127.0.0.1:${fileEnv.NOVA_KERNEL_PORT || '3700'}`;
const TOKEN = process.env.NOVA_INTERNAL_TOKEN || fileEnv.NOVA_INTERNAL_TOKEN || '';

async function nova(method, path, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Nova-Source': 'mcp' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const opt = { method, headers };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opt);
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!r.ok) {
    const msg = typeof parsed === 'object' ? (parsed.error?.message || parsed.error || JSON.stringify(parsed)) : parsed;
    throw new Error(`Nova HTTP ${r.status}: ${msg}`);
  }
  return parsed;
}

// ─── 工具定义 ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'nova_health',
    description: '查 Nova Kernel 内核健康状态（log_integrity / kernel_root / version）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nova_ask',
    description: '通过 Nova 调 Gemini 做一次问答（走 /v1/chat/completions，会被审计+记忆注入）。用于你需要一个带上下文的回答时。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '提问内容' },
        model: { type: 'string', description: '可选：gemini-flash / gemini-pro', default: 'gemini-flash' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'nova_intent',
    description: '把一句自然语言打给意图路由器，看它识别成哪个产品域+动作。用于模糊需求澄清。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '自然语言需求' } },
      required: ['text'],
    },
  },
  {
    name: 'nova_invoke',
    description: '调用某个产品的某个方法（commerce-ops / media-forge / enterprise-ai）。走 L0-L3 风险门控+审计。',
    inputSchema: {
      type: 'object',
      properties: {
        product: { type: 'string', enum: ['commerce-ops', 'media-forge', 'enterprise-ai'] },
        method:  { type: 'string', description: '方法名（如 generateSeoTitle、generateProductCopy）' },
        payload: { type: 'object', description: '方法入参' },
      },
      required: ['product', 'method'],
    },
  },
  {
    name: 'nova_memory_list',
    description: '列出 Nova 中的所有（或某一类）记忆。记忆分 user/feedback/project/reference 四类。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: '可选过滤' },
      },
    },
  },
  {
    name: 'nova_memory_write',
    description: '向 Nova 写入一条记忆（user/feedback/project/reference 四类之一）。写入后自动投影到 Nova USER.md 和 Claude Code 的记忆目录。',
    inputSchema: {
      type: 'object',
      properties: {
        type:        { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
        name:        { type: 'string', description: '简短标题' },
        description: { type: 'string', description: '一行描述（给检索用）' },
        body:        { type: 'string', description: '记忆正文' },
      },
      required: ['type', 'name', 'description', 'body'],
    },
  },
  {
    name: 'nova_memory_sync',
    description: 'Claude Code 记忆目录 ↔ Nova 记忆双向同步。direction 可选 from-claude / to-claude / bidirectional（默认）。',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['from-claude', 'to-claude', 'bidirectional'], default: 'bidirectional' },
      },
    },
  },
  {
    name: 'nova_gaps',
    description: '跑一次 Gap Detector — 让 Nova 自检最近的日志发现系统自身的 gap（重复失败/未命中 skill/性能瓶颈）',
    inputSchema: { type: 'object', properties: {} },
  },
  // ─── 驾驶员视角工具（Driver Claude 用来管理整个 AI OS）────────────────
  {
    name: 'nova_pending_approvals',
    description: '列出所有等待用户批准/否决的 L3 提案（异步议会已投完票、等你裁决的 ticket）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nova_council_submit',
    description: '把一个 L3 风险提案交给异步议会，立即返回 ticket_id。三方 AI 后台投票，用户最终裁决。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:  { type: 'string', description: '关联的任务 ID（任意字符串）' },
        prompt:   { type: 'string', description: '要执行的动作描述' },
        project:  { type: 'string', description: '所属产品域，如 commerce-ops' },
        payload:  { type: 'object', description: '可选的执行参数' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'nova_council_resolve',
    description: '用户对一个 ticket 做出最终裁决：approve 或 veto',
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id:  { type: 'string' },
        resolution: { type: 'string', enum: ['approve', 'veto'] },
      },
      required: ['ticket_id', 'resolution'],
    },
  },
  {
    name: 'nova_workers',
    description: '查所有 AI worker（Gemini/Claude/OpenAI/Codex）的健康状态、延迟、失败次数',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nova_models',
    description: '列出当前所有可用模型（含配置版本）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nova_dashboard',
    description: '一页式总览：内核健康 + 当前任务数 + AI 服务状态 + 熔断器 + 最近 gap',
    inputSchema: { type: 'object', properties: {} },
  },
  // ─── 分工协作流水线（Driver 派任务给 Opus/Gemini/Codex，最后自己审）────
  {
    name: 'nova_pipeline_debate',
    description: '双模型辩论：同一个问题让 Claude Opus Thinking 和 Gemini 3.1 Pro High 各自独立回答，返回两方意见，由你（Driver）做最终仲裁。适合架构/决策类咨询。',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
  {
    name: 'nova_pipeline_code',
    description: '代码任务流水线：Opus 规划 → Gemini 实现 → (可选)Codex 验证 → Driver 终审。',
    inputSchema: {
      type: 'object',
      properties: {
        requirement:  { type: 'string', description: '需求描述' },
        cwd:          { type: 'string', description: '工作目录（接入 Codex 验证时必填）' },
        test_command: { type: 'array', items: { type: 'string' }, description: '测试命令，如 ["python","test.py"]' },
        expect_exit:  { type: 'number', description: '预期 exit code（默认 0）' },
      },
      required: ['requirement'],
    },
  },
  {
    name: 'nova_pipeline_run',
    description: '执行自定义流水线：传 stages 数组，每段指定 kind=llm|codex|driver + 参数。高级用法，需要明确知道阶段契约。',
    inputSchema: {
      type: 'object',
      properties: {
        title:  { type: 'string' },
        stages: { type: 'array', items: { type: 'object' } },
      },
      required: ['stages'],
    },
  },
  {
    name: 'nova_codex_run',
    description: '受控调用 Codex CLI：告诉它跑什么命令（不让它自主规划）。Opus 建议用这种模式避免熔断瘫痪 QA 链路。返回 exit/stdout/stderr。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd:         { type: 'string', description: '工作目录（必填）' },
        command:     { type: 'array',  items: { type: 'string' }, description: '命令 + 参数，如 ["python","test.py"]' },
        expect_exit: { type: 'number', description: '预期 exit code（默认 0）' },
        timeout_ms:  { type: 'number' },
      },
      required: ['cwd', 'command'],
    },
  },
  {
    name: 'nova_codex_fix',
    description: 'Codex 自主修 bug 流水线：Opus 规划 → Codex 在 cwd 里自主读代码/修/跑测试 → Driver 审 diff。适合明确的 bug 问题。',
    inputSchema: {
      type: 'object',
      properties: {
        issue:        { type: 'string', description: 'bug 描述（必填）' },
        cwd:          { type: 'string', description: '工作目录（必填，Codex 需在此仓库内操作）' },
        test_command: { type: 'string', description: '可选：修完后让 Codex 跑的验证命令' },
      },
      required: ['issue', 'cwd'],
    },
  },
  // ─── 进化通道（受约束的自由）────────────────────────────────────────
  {
    name: 'nova_propose_change',
    description: '当你想改 L0 禁区（constitutional.json / audit.db / l3-gate.mjs 等）或 L2 灰区时，不要硬碰。写一个提案到 evolution/proposals/，Nova 会自动提交议会（Opus + Gemini 评审）+ 等用户批准。这是"受约束的自由" —— 你有合法路径表达诉求而不撞墙。',
    inputSchema: {
      type: 'object',
      properties: {
        title:             { type: 'string', description: '简短描述，会成为提案文件名的一部分' },
        target_path:       { type: 'string', description: '你想改的文件完整路径' },
        change_type:       { type: 'string', enum: ['patch', 'replace', 'append'], description: '改动类型' },
        proposed_content:  { type: 'string', description: 'diff 或完整新内容（<8000 字符）' },
        rationale:         { type: 'string', description: '为什么需要改（必填，议会会看）' },
        risk_level:        { type: 'string', enum: ['L1', 'L2', 'L3'] },
        risks:             { type: 'string', description: '潜在风险描述' },
        rollback:          { type: 'string', description: '回滚方案' },
      },
      required: ['title', 'target_path', 'proposed_content', 'rationale'],
    },
  },
  {
    name: 'nova_proposals_list',
    description: '列出所有 AI 提案（可按 status 过滤：pending_review / approved / rejected）',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
    },
  },
  {
    name: 'nova_proposal_approve',
    description: '用户（通过 Driver）批准一个提案。批准后 Driver 负责实际应用改动（读 proposal 内容 → 写目标文件 → 记审计）',
    inputSchema: {
      type: 'object',
      properties: { proposal_id: { type: 'string' } },
      required: ['proposal_id'],
    },
  },
  {
    name: 'nova_codex_review',
    description: 'Codex 代码审查：先用 `codex exec review` 扫 git diff，再由 Opus 做 meta-review 指出可能漏掉的角度。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd:   { type: 'string', description: '工作目录（需是 git 仓库）' },
        focus: { type: 'string', description: '可选：审查重点（如"安全"、"性能"）' },
      },
      required: ['cwd'],
    },
  },
  // ── KB v2 嫁接 (2026-04-19): 11 个新 MCP 工具 ──────────────────────────────
  {
    name: 'nova_context_snapshot',
    description: 'Bootstrap 画像注入：新 session 第一件事，<4KB 客户画像（硬件/项目/偏好/状态/KB）。scope=full|hardware|projects|feedback|digest|kb',
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['full', 'hardware', 'projects', 'feedback', 'digest', 'kb'], default: 'full' } } },
  },
  {
    name: 'nova_kb_search',
    description: '语义检索 KB（Ollama nomic-embed-text 768d）。返 top-K 相关记忆 + 引用自动记录。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, topK: { type: 'number', default: 20 }, finalK: { type: 'number', default: 5 }, type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] }, rerank: { type: 'boolean', default: true } }, required: ['query'] },
  },
  {
    name: 'nova_kb_remember',
    description: 'AI 反哺 KB：把工作中获得的知识写回。risk_level=L1 自动 active；L2 进 draft；L3 走 propose_change。',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, description: { type: 'string' }, type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], default: 'reference' }, risk_level: { type: 'string', enum: ['L1', 'L2', 'L3'], default: 'L1' }, module: { type: 'string', description: '必填：taxonomy module 之一' }, function: { type: 'string' } }, required: ['title', 'body', 'module'] },
  },
  {
    name: 'nova_kb_reindex',
    description: '增量向量化 active 记忆（force=true 全量重跑）。VRAM 不够会自动拒绝。',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean', default: false } } },
  },
  {
    name: 'nova_kb_health',
    description: 'KB 子系统健康：embedding 服务 / 向量条数 / intel 池 / VRAM / 磁盘。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nova_kb_maintenance',
    description: '一次自维护：衰减 + 引用晋级 + 增量向量化 + intel refine + 紧急简报。dry=true 仅预演。',
    inputSchema: { type: 'object', properties: { dry: { type: 'boolean', default: false }, skip: { type: 'array', items: { type: 'string', enum: ['decay', 'reindex', 'intel-refine', 'intel-urgent'] } } } },
  },
  {
    name: 'nova_intel_ingest',
    description: 'IM 入站（飞书/微信资料）。原始 text + urls，写入 intel 池（隔离不进主 embedding）。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } }, sender: { type: 'string', default: 'unknown' }, source_channel: { type: 'string', default: 'feishu' }, metadata: { type: 'object' } }, required: ['text'] },
  },
  {
    name: 'nova_intel_brief',
    description: 'Intel 简报（近 N 天 KOL/品牌/品类/关键词 top-N）。reason=weekly|urgent|manual',
    inputSchema: { type: 'object', properties: { reason: { type: 'string', enum: ['weekly', 'urgent', 'manual'], default: 'manual' }, days: { type: 'number', default: 7 } } },
  },
  {
    name: 'nova_intel_entities',
    description: 'Intel 池实体 top-N（kol/brand/category/keyword）。',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['kol', 'brand', 'category', 'keyword'] }, limit: { type: 'number', default: 20 } } },
  },
  {
    name: 'nova_vault_sync',
    description: 'Nova 记忆 + intel 全量投影到 D:/claude/Vault/ 四区 markdown 树（Obsidian 可打开）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nova_librarian_now',
    description: '图书管理员：triage（整理 inbox）+ audit（衰减/归档/晋级 + 合并建议）+ daily report（存量/新增/索引/intel 池）。which=all|triage|audit|report|machine-spec',
    inputSchema: { type: 'object', properties: { which: { type: 'string', enum: ['all', 'triage', 'audit', 'report', 'machine-spec'], default: 'all' } } },
  },
  {
    name: 'nova_meta_extract',
    description: 'Meta-Memory 抽取：从当前 transcript 提取用户长期习惯/规则。T3 Opus → 结构化 → 自动入库 → 四方同步。',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['on_demand', 'periodic', 'session_end'], default: 'on_demand' }, turns: { type: 'number' } } },
  },
  // ── Agent 注册表 (2026-04-19) ──────────────────────────────────────────
  {
    name: 'nova_agents_list',
    description: '列出所有注册的 Python agent (jushuitan/dingtalk/vision-agent/qianniu_mtop/...). 不再让 Driver 现场写 spawn',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nova_agent_invoke',
    description: '统一调用某个 Python agent. method_payload 模式 (jushuitan/dingtalk): 传 {name, args:{method, payload}}; raw_args 模式 (vision/qianniu_mtop/etc): 传 {name, args:{args:[arg1,arg2]}}',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'agent 注册名，参考 nova_agents_list' },
        args: { type: 'object', description: 'method_payload: {method,payload}; raw_args: {args:[]}' },
        timeout_ms: { type: 'number', description: '可选覆盖默认 timeout' },
      },
      required: ['name'],
    },
  },
  {
    name: 'nova_mine_skills',
    description: '从 feedback 记忆里聚类提取可复用 skill, 写到 evolution/proposals/ 走 Council 审。dry=true 仅预演不写文件。每 6h 自动跑.',
    inputSchema: { type: 'object', properties: { dry: { type: 'boolean', default: false } } },
  },
  {
    name: 'nova_task_plan',
    description: '【任务起手必调】给任务意图, 自动搜匹配的 skill / agent / 历史 feedback 警示 / pending 提案. 避免闭门造车 + 复用既有能力.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: '任务意图描述 (中英文都可, ≥3 字)' },
        max: { type: 'number', description: '每类返回最多 N 项, 默认 5', default: 5 },
        includeProposals: { type: 'boolean', description: '是否返回 pending 提案, 默认 true', default: true },
      },
      required: ['intent'],
    },
  },
  {
    name: 'nova_scout_external',
    description: '【时用时新】扫外部世界看有没有更新更好的方案: A. connector npm 版本对比 (mechanical) B. skill 新鲜度 LLM 判断. 输出 upgrade 提案到 evolution/proposals/, 走 Council. 24h 自动跑.',
    inputSchema: {
      type: 'object',
      properties: {
        skipConnectors: { type: 'boolean', default: false },
        skipSkills: { type: 'boolean', default: false },
        skillLimit: { type: 'number', default: 3, description: '一次扫多少 skill (LLM call 限流)' },
        dry: { type: 'boolean', default: false, description: 'true 仅返报告不写提案' },
      },
    },
  },
  {
    name: 'nova_memory_hygiene',
    description: '记忆库扫描/清理. apply=false (默认) 仅报告 4 类病; apply=true 删测试残留 + 启发式回填 module 字段. 12h 自动 dry-scan.',
    inputSchema: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', description: 'true 才执行修复, 默认 dry-run', default: false },
        types: { type: 'array', items: { type: 'string' }, description: '要扫的 type, 默认 [reference,project,feedback]' },
        useLlm: { type: 'boolean', description: 'apply 时, 启发式 miss 用 LLM 推断', default: false },
      },
    },
  },
];

// ─── Handler ──────────────────────────────────────────────────────────────
async function callTool(name, args = {}) {
  switch (name) {
    case 'nova_health':       return await nova('GET', '/health');
    case 'nova_ask': {
      const r = await nova('POST', '/v1/chat/completions', {
        model: args.model || 'gemini-flash',
        messages: [{ role: 'user', content: args.prompt }],
      });
      return { text: r?.choices?.[0]?.message?.content || '', raw: r };
    }
    case 'nova_intent':       return await nova('POST', '/intent', { text: args.text });
    case 'nova_invoke':       return await nova('POST', `/products/${args.product}/${args.method}`, { payload: args.payload || {} });
    case 'nova_memory_list': {
      const q = args.type ? `?type=${encodeURIComponent(args.type)}` : '';
      return await nova('GET', `/memory/list${q}`);
    }
    case 'nova_memory_write': return await nova('POST', '/memory/write', args);
    case 'nova_memory_sync':  return await nova('POST', '/memory/sync', { direction: args.direction || 'bidirectional' });
    case 'nova_gaps':         return await nova('GET', '/evolution/gaps');
    case 'nova_pending_approvals': return await nova('GET', '/council/pending');
    case 'nova_council_submit':    return await nova('POST', '/council/submit', args);
    case 'nova_council_resolve':   return await nova('POST', '/council/resolve', args);
    case 'nova_workers':      return await nova('GET', '/api/worker-health');
    case 'nova_models':       return await nova('GET', '/api/model-versions');
    case 'nova_dashboard':    return await nova('GET', '/dashboard');
    case 'nova_pipeline_debate': return await nova('POST', '/pipeline/debate', args);
    case 'nova_pipeline_code':   return await nova('POST', '/pipeline/code-task', args);
    case 'nova_pipeline_run':    return await nova('POST', '/pipeline/run', args);
    case 'nova_codex_run':       return await nova('POST', '/codex/run', args);
    case 'nova_codex_fix':       return await nova('POST', '/pipeline/codex-fix', args);
    case 'nova_codex_review':    return await nova('POST', '/pipeline/codex-review', args);
    case 'nova_propose_change':  return await nova('POST', '/proposals/submit', args);
    case 'nova_proposals_list':  return await nova('GET', '/proposals/list' + (args?.status ? `?status=${encodeURIComponent(args.status)}` : ''));
    case 'nova_proposal_approve':return await nova('POST', '/proposals/approve', args);
    // ── KB v2 嫁接 ──────────────────────────────────────────────────
    case 'nova_context_snapshot':return await nova('GET', '/kb/context' + (args?.scope ? `?scope=${encodeURIComponent(args.scope)}` : ''));
    case 'nova_kb_search':       return await nova('POST', '/kb/search', args);
    case 'nova_kb_remember':     return await nova('POST', '/kb/remember', args);
    case 'nova_kb_reindex':      return await nova('POST', '/kb/reindex', args);
    case 'nova_kb_health':       return await nova('GET', '/kb/health');
    case 'nova_kb_maintenance':  return await nova('POST', '/kb/maintenance', args);
    case 'nova_intel_ingest':    return await nova('POST', '/intel/ingest', args);
    case 'nova_intel_brief':     return await nova('POST', '/intel/brief', args);
    case 'nova_intel_entities': {
      const params = new URLSearchParams();
      if (args?.kind)  params.set('kind', args.kind);
      if (args?.limit) params.set('limit', args.limit);
      const q = params.toString();
      return await nova('GET', '/intel/entities' + (q ? `?${q}` : ''));
    }
    case 'nova_vault_sync':      return await nova('POST', '/kb/vault-sync', {});
    case 'nova_librarian_now':   return await nova('POST', '/librarian/run', { which: args.which || 'all' });
    case 'nova_meta_extract':    return await nova('POST', '/kb/meta-extract', args);
    // ── Agent 注册表 ──────────────────────────────────────────────────
    case 'nova_agents_list':     return await nova('GET', '/agents/list');
    case 'nova_agent_invoke':    return await nova('POST', '/agents/invoke', args);
    case 'nova_mine_skills':     return await nova('POST', '/evolution/mine-skills', args);
    case 'nova_task_plan':       return await nova('POST', '/task/plan', args);
    case 'nova_memory_hygiene':  return await nova('POST', '/memory/hygiene', args);
    case 'nova_scout_external':  return await nova('POST', '/evolution/scout', args);
    default: throw new Error(`未知工具: ${name}`);
  }
}

// ─── 启动 MCP server ──────────────────────────────────────────────────────
const server = new Server(
  { name: 'nova-kernel', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await callTool(name, args || {});
    return {
      content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `[nova-mcp] 错误: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// 不要 console.log — stdio MCP 禁止在 stdout 输出非协议内容
process.stderr.write(`[nova-mcp] Server ready. BASE=${BASE}\n`);
