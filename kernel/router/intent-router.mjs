/**
 * Nova Kernel — 意图路由器 (Intent Router)
 * kernel/router/intent-router.mjs
 *
 * 职责：将自然语言指令解析为结构化路由决策
 *   输入:  "帮我安排明天的工作"
 *   输出:  { domain: 'commerce-ops', action: 'generateSeoTitle', params: {...}, confidence: 0.82 }
 *
 * 当 confidence < CLARIFY_THRESHOLD (0.60) 时：
 *   返回:  { needsClarification: true, question: "..." }
 *
 * 域 (Domain) 列表 — Commerce Edition：
 *   commerce-ops   — 运营自动化（商品/SEO/文案/报表/改价/广告/评论）
 *   media-forge    — 图像视频流水线（去背/模特图/切片/搜图）
 *   enterprise-ai  — 全公司 AI（设计/版型/采购/QC/WMS/客服/VIP）
 *   kernel         — Kernel 自身管理（Gap/记忆/审计/否决/健康）
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const KERNEL_ROOT        = process.env.NOVA_KERNEL_ROOT        || 'D:/nova-kernel';
const CLARIFY_THRESHOLD  = parseFloat(process.env.ROUTER_CLARIFY_THRESHOLD  || '0.60');
const CONFIDENCE_BOOST   = parseFloat(process.env.ROUTER_CONFIDENCE_BOOST   || '0.15');
// 命中数达到 HIT_SATURATION 时 score = 1.0（避免被大词表稀释）
const HIT_SATURATION     = parseInt(process.env.ROUTER_HIT_SATURATION       || '3', 10);

// ---------------------------------------------------------------------------
// 域描述符 (Domain Map)
// ---------------------------------------------------------------------------

/**
 * 每个域包含：
 *   keywords   — 触发该域的关键词（中/英）
 *   actions    — 支持的动作 map { 动作名: [触发词] }
 *   description — 对用户展示的描述
 */
const DOMAIN_MAP = {
  'commerce-ops': {
    description: '运营自动化（商品/SEO/文案/报表/改价/广告/评论）',
    keywords: [
      // 商品 / 上架 / 运营通用
      '商品', '上架', '下架', 'sku', '运营', '店铺', '天猫', '淘宝', '京东', '拼多多',
      '抖音', '快手', '小红书', '多平台', '发布', 'publish',
      // SEO / 文案 / 脚本
      'seo', '标题', '关键词', '文案', '描述', '详情', '脚本', 'script',
      '直播', '话术', '推广', '带货',
      // 报表 / 预测 / 销售
      '报表', '日报', '周报', '月报', '销量', '销售', '库存', '补货', '预测',
      'forecast', 'restock', 'report',
      // 广告 / 投放
      '广告', '投放', '竞价', '出价', '计划', 'ads', '直通车', '钻展',
      // 改价 / 活动 / 预售
      '改价', '调价', '价格', 'price', '促销', '活动', '预售', 'presale', '折扣',
      // 评论 / 客服回复
      '评论', '评价', '回复', '差评', 'review', 'comment',
    ],
    actions: {
      generateTitle: ['标题', 'title', 'seo', '起个名', '取个名', '命名'],
      generateCopy:  ['文案', '描述', '详情', 'copy', 'description'],
      generateScript:['脚本', '话术', '直播', 'script'],
      buildReport:   ['报表', '日报', '周报', '月报', 'report', '汇总', '统计'],
      forecast:      ['预测', 'forecast', '预估', '预判'],
      restock:       ['补货', 'restock', '采购建议'],
      publish:       ['发布', '上架', 'publish', '上线'],
      updatePrice:   ['改价', '调价', '定价', 'price', '价格'],
      adjustAd:      ['广告', '投放', '调广告', 'ads', '出价'],
      replyComment:  ['回复', '差评', 'reply', '评论'],
    },
  },
  'media-forge': {
    description: '图像视频流水线（去背/模特图/切片/搜图）',
    keywords: [
      // 图像
      '图片', '图像', '照片', '模特图', '白底图', '去背', '抠图', '主图', '详情图',
      '换背景', '场景图', 'image', 'photo', 'background', 'remove',
      // 视频
      '视频', '短视频', '切片', '剪辑', '混剪', '字幕', 'video', 'clip', 'edit',
      '直播切片', '高光', 'highlight',
      // 格式 / 搜索
      '尺寸', '比例', '导出', '格式', '压缩', 'resize', 'adapt', 'format',
      '以图搜图', '相似图', 'searchbyimage', 'similar',
    ],
    actions: {
      removeBackground: ['去背', '抠图', '白底', 'remove', 'cutout'],
      generateScene:    ['场景图', '换背景', '模特图', 'scene'],
      adaptFormat:      ['尺寸', '比例', '导出', '格式', 'resize', 'adapt'],
      clipVideo:        ['切片', '剪辑', '混剪', 'clip'],
      detectHighlight:  ['高光', '直播', 'highlight'],
      searchByImage:    ['搜图', '相似', 'search'],
    },
  },
  'enterprise-ai': {
    description: '全公司 AI（设计趋势/版型/采购/QC/WMS/客服/VIP）',
    keywords: [
      // 设计 / 版型
      '设计', '趋势', '爆款', '款式', '版型', '打版', 'design', 'trend',
      '面料', '工艺', '色卡',
      // 采购 / 供应链 / QC
      '采购', '供应商', '下单', '到货', 'qc', '质检', '品控', '瑕疵',
      'wms', '仓储', '出库', '入库',
      // 客服 / VIP
      '客服', '工单', 'faq', 'vip', '会员', '私域', '复购', '触达',
    ],
    actions: {
      analyzeTrend:  ['趋势', '爆款', 'trend'],
      suggestPattern:['版型', '打版', 'pattern'],
      qcInspect:     ['质检', '品控', 'qc', '瑕疵'],
      wmsReport:     ['仓储', 'wms', '库存', '出入库'],
      cs:            ['客服', '工单', 'faq'],
      vip:           ['vip', '会员', '私域', '复购'],
    },
  },
  kernel: {
    description: 'Nova Kernel 自身管理（Gap、记忆、审计、否决、健康）',
    keywords: ['kernel', 'gap', '记忆', '审计', '否决', '日志', '健康', 'health',
               '系统', '内核', '配置', 'config', '状态', 'status', 'veto',
               '扫描', '初始化', 'audit', 'memory', 'constitutional', '宪法'],
    actions: {
      health:  ['健康', 'health', '状态', 'status'],
      scan:    ['扫描', 'scan', '检测', 'detect', 'gap'],
      memory:  ['记忆', 'memory'],
      audit:   ['审计', 'audit', '日志'],
      repair:  ['修复', 'repair'],
      veto:    ['否决', 'veto', '撤销'],
    },
  },
};

// ---------------------------------------------------------------------------
// 文本预处理
// ---------------------------------------------------------------------------

function _normalize(text) {
  return text.toLowerCase()
    .replace(/[，。？！、；：]/g, ' ')   // 中文标点 → 空格
    .replace(/[^\w\u4e00-\u9fa5 ]/g, ' ')  // 保留汉字+ASCII
    .replace(/\s+/g, ' ')
    .trim();
}

function _tokenize(text) {
  // 简单分词：汉字单字 + 英文 token
  const tokens = [];
  for (const part of text.split(' ')) {
    if (/[\u4e00-\u9fa5]/.test(part)) {
      // 滑动窗口 2-gram + 1-gram
      for (let i = 0; i < part.length; i++) {
        tokens.push(part[i]);
        if (i < part.length - 1) tokens.push(part[i] + part[i + 1]);
        if (i < part.length - 2) tokens.push(part[i] + part[i + 1] + part[i + 2]);
      }
    } else if (part.length > 0) {
      tokens.push(part);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 域匹配
// ---------------------------------------------------------------------------

/**
 * 命中数 → [0,1] 分数（饱和归一化，避免大词表稀释）
 * 3 次命中即饱和为 1.0，1 次命中 ≈ 0.33
 */
function _saturate(hits) {
  return Math.min(hits / HIT_SATURATION, 1.0);
}

// C005 fix: 短 token 污染防护
// 极短 token（单汉字/单英文字母）只做精确匹配，不做模糊 includes
const MIN_CJK_LEN   = 2;
const MIN_ASCII_LEN = 3;

function _tokenMatchesKw(t, kw) {
  const isCJK = /[\u4e00-\u9fa5]/.test(t);
  const minLen = isCJK ? MIN_CJK_LEN : MIN_ASCII_LEN;
  if (t.length < minLen) return t === kw;        // 极短 token → 精确匹配
  return kw.includes(t);                          // 正向：关键词包含 token（方向单一）
}

function _scoreDomain(tokens, domainDef) {
  let hits = 0;
  for (const kw of domainDef.keywords) {
    if (tokens.some(t => _tokenMatchesKw(t, kw))) hits++;
  }
  return _saturate(hits);
}

function _scoreAction(tokens, actionMap) {
  let bestAction = 'default';
  let bestScore  = 0;
  for (const [action, triggers] of Object.entries(actionMap)) {
    let hits = 0;
    for (const trig of triggers) {
      if (tokens.some(t => _tokenMatchesKw(t, trig))) hits++;
    }
    const score = _saturate(hits);
    if (score > bestScore) { bestScore = score; bestAction = action; }
  }
  return { action: bestAction, score: bestScore };
}

// C006 fix: Markdown 转义，防止用户输入破坏卡片格式
function _escapeMd(s) {
  return String(s).replace(/[*_`[\]()]/g, c => '\\' + c).slice(0, 100);
}

// ---------------------------------------------------------------------------
// 闲聊/问候检测（路由前拦截，避免触发模块选择提示）
// ---------------------------------------------------------------------------

const GREETING_PATTERNS = [
  /^(你好|hello|hi|hey|哈喽|嗨|早|晚上好|下午好|早上好|你好哇|好哇|在吗|在不)\b/i,
  /^(聊天|聊聊|聊|随便聊|闲聊|唠嗑|说话)\b/i,
  /^(怎么了|没事|好的|好|嗯|哦|啊|哈哈|哈|呵呵|233|lol)\b/i,
  /^(谢谢|感谢|thx|thanks|thank you)\b/i,
  /^(再见|拜|拜拜|bye|下次见|晚安|good night)\b/i,
];

/**
 * 判断是否为闲聊/问候，无需路由到任何模块
 * @param {string} text
 * @returns {boolean}
 */
function _isGeneralChat(text) {
  const t = text.trim();
  if (t.length === 0) return false;
  // 极短消息（≤6字）且不含任何域关键词 → 视为闲聊
  if (t.length <= 6) return true;
  return GREETING_PATTERNS.some(p => p.test(t));
}

// ---------------------------------------------------------------------------
// parseIntent() — 核心解析
// ---------------------------------------------------------------------------

/**
 * @param {string} text  用户自然语言输入
 * @returns {{ domain, domainScore, action, actionScore, tokens }}
 */
export function parseIntent(text) {
  const norm   = _normalize(text);
  const tokens = _tokenize(norm);

  let bestDomain = null;
  let bestDScore = 0;

  const allScores = {};
  for (const [domain, def] of Object.entries(DOMAIN_MAP)) {
    const score = _scoreDomain(tokens, def);
    allScores[domain] = score;
    if (score > bestDScore) { bestDScore = score; bestDomain = domain; }
  }

  // 无法确定域
  if (!bestDomain || bestDScore === 0) {
    return { domain: null, domainScore: 0, action: null, actionScore: 0, tokens, allScores };
  }

  const { action, score: aScore } = _scoreAction(tokens, DOMAIN_MAP[bestDomain].actions);
  return { domain: bestDomain, domainScore: bestDScore, action, actionScore: aScore, tokens, allScores };
}

// ---------------------------------------------------------------------------
// _loadNegativeConstraints() — 注入 negative-memory 约束
// ---------------------------------------------------------------------------

// C017 fix: 60s TTL 缓存，避免每次请求都读磁盘
let _negMemCache = null;
let _negMemCacheTime = 0;
const NEG_MEM_TTL_MS = 60_000;

function _loadNegativeConstraints(domain) {
  const now = Date.now();
  if (!_negMemCache || (now - _negMemCacheTime) > NEG_MEM_TTL_MS) {
    const p = join(KERNEL_ROOT, 'kernel/memory/negative-memory.json');
    try {
      _negMemCache = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
    } catch {
      _negMemCache = [];
    }
    _negMemCacheTime = now;
  }
  return _negMemCache.filter(r => r.status === 'active' && (!r.project || r.project === domain));
}

// ---------------------------------------------------------------------------
// routeIntent() — 公开路由接口
// ---------------------------------------------------------------------------

/**
 * @param {string} text     用户输入
 * @param {object} context  可选上下文 { session_id, user, project }
 * @returns {RouteResult}
 *
 * RouteResult (成功):
 *   { ok: true, domain, action, params, confidence,
 *     constraints, description }
 *
 * RouteResult (需澄清):
 *   { ok: false, needsClarification: true, question, candidates, raw }
 */
// ─── LLM 辅助澄清 ─────────────────────────────────────────────────────────
// 关键词匹配置信度不足时，调用轻量 LLM（Gemini Flash via ag-bridge 或直连）做二次分类
// 30s 响应缓存，避免同一句话反复调 LLM

const _llmRouteCache = new Map();
const LLM_CACHE_TTL_MS = 30_000;

async function _resolveWithLLM(text, partialScores) {
  if (process.env.NOVA_INTENT_LLM_FALLBACK === 'off') return null;
  const cached = _llmRouteCache.get(text);
  if (cached && Date.now() - cached.at < LLM_CACHE_TTL_MS) return cached.result;

  const domainList = Object.entries(DOMAIN_MAP)
    .map(([k, v]) => `  - ${k}: ${v.description}`)
    .join('\n');
  const actionList = Object.entries(DOMAIN_MAP)
    .map(([k, v]) => `  ${k}: [${Object.keys(v.actions).join(', ')}]`)
    .join('\n');

  const prompt = [
    '用户输入一句自然语言，需要你判断它最匹配 Nova Kernel 的哪个产品域+动作。',
    '',
    '可选域（domain）：',
    domainList,
    '',
    '每个域的可选动作（action）：',
    actionList,
    '',
    '严格输出以下 JSON（不要 markdown 代码块，不要解释）：',
    '{"domain": "<域名>", "action": "<动作名>", "confidence": 0.0-1.0}',
    '',
    'domain 必须是上面列出的某一个。action 必须是对应域里的某个。',
    'confidence 表示你有多确定，低于 0.5 表示确实不清楚（此时仍要给出最可能的值）。',
    '',
    `用户输入："${text}"`,
  ].join('\n');

  try {
    // 动态 import 避免循环依赖（ai-executor 也 import intent-router 过吗？不会）
    const { executeWithAI } = await import('../workers/ai-executor.mjs');
    const result = await executeWithAI({
      task_id:         `intent-llm-${Date.now().toString(36)}`,
      prompt,
      worker:          'google',
      suggested_model: 'antigravity-gemini-3-flash', // 优先免费快速；不可用会 fallback 到 Gemini API
      task_type:       'chat',
      complexity:      1,
      timeout_ms:      8000,
      mode:            'worker',
    });

    if (!result.ok || !result.output) { _llmRouteCache.set(text, { at: Date.now(), result: null }); return null; }

    // 宽松解析
    let clean = result.output.replace(/^```(?:json)?\s*/gm, '').replace(/\s*```$/gm, '').trim();
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) { _llmRouteCache.set(text, { at: Date.now(), result: null }); return null; }
    const parsed = JSON.parse(m[0]);
    if (!parsed.domain || !DOMAIN_MAP[parsed.domain]) {
      _llmRouteCache.set(text, { at: Date.now(), result: null });
      return null;
    }
    const action = parsed.action && DOMAIN_MAP[parsed.domain].actions[parsed.action]
      ? parsed.action : 'default';
    const out = {
      domain: parsed.domain,
      action,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      source: 'llm',
    };
    _llmRouteCache.set(text, { at: Date.now(), result: out });
    return out;
  } catch (e) {
    console.warn('[intent-router] LLM fallback 失败:', e.message);
    _llmRouteCache.set(text, { at: Date.now(), result: null });
    return null;
  }
}

// async 版本（routeIntent 现在主 export 是 sync，这个给需要 LLM 的调用者用）
export async function routeIntentAsync(text, context = {}) {
  const result = routeIntent(text, context);
  // 已经 OK 或纯闲聊/无意图 → 直接返回
  if (result.ok || result.isGeneralChat || !result.needsClarification) return result;
  // 低置信度或歧义 → 调 LLM 再试一次
  const parsed = result.raw || {};
  const llm = await _resolveWithLLM(text, parsed.allScores || {});
  if (llm && llm.confidence >= 0.7) {
    return {
      ok:          true,
      domain:      llm.domain,
      action:      llm.action,
      params:      { original_text: text, session_id: context.session_id || null, user: context.user || null, project: context.project || llm.domain },
      confidence:  llm.confidence,
      constraints: [],
      description: DOMAIN_MAP[llm.domain].description,
      debug:       { llm_resolved: true, keyword_raw: parsed },
    };
  }
  // LLM 也拿不准 → 保留原 needsClarification，但附带 LLM 的候选
  if (llm) result.llm_suggestion = llm;
  return result;
}

export function routeIntent(text, context = {}) {
  if (!text || typeof text !== 'string') {
    return { ok: false, needsClarification: true, question: '请输入你想做的事情。', candidates: [] };
  }

  // 闲聊/问候拦截：不进入模块路由，返回专用标记供调用方友好回复
  if (_isGeneralChat(text)) {
    return { ok: false, isGeneralChat: true };
  }

  const parsed = parseIntent(text);

  // ── 完全无法解析 ────────────────────────────────────────────────────────
  if (!parsed.domain) {
    return {
      ok: false,
      needsClarification: true,
      question: `无法识别意图，请告诉我你想用哪个模块？\n可选：${Object.entries(DOMAIN_MAP).map(([k, v]) => `**${k}** (${v.description})`).join('、')}`,
      candidates: [],
      raw: parsed,
    };
  }

  // ── 计算综合置信度 ──────────────────────────────────────────────────────
  // base = domainScore(权重0.6) + actionScore(权重0.4)
  let confidence = parsed.domainScore * 0.6 + parsed.actionScore * 0.4;

  // 如果 context.project 与解析域一致，置信度 +BOOST
  if (context.project && context.project.toLowerCase() === parsed.domain) {
    confidence = Math.min(1.0, confidence + CONFIDENCE_BOOST);
  }

  // ── F-007 fix: 域间歧义检测 — top-2 域分差 < 15% 时强制澄清 ────────────
  const AMBIGUITY_GAP = parseFloat(process.env.ROUTER_AMBIGUITY_GAP || '0.15');
  const sortedDomains = Object.entries(parsed.allScores).sort((a, b) => b[1] - a[1]);
  if (sortedDomains.length >= 2 && sortedDomains[0][1] > 0 && sortedDomains[1][1] > 0) {
    const gap = sortedDomains[0][1] - sortedDomains[1][1];
    if (gap < AMBIGUITY_GAP) {
      const top2 = sortedDomains.slice(0, 2).map(([d]) => `**${d}** (${DOMAIN_MAP[d].description})`);
      return {
        ok: false,
        needsClarification: true,
        question: `「${_escapeMd(text)}」同时匹配多个模块（分差仅 ${(gap * 100).toFixed(0)}%）。\n你想用：${top2.join(' 还是 ')}？`,
        candidates: top2,
        confidence,
        raw: parsed,
      };
    }
  }

  // ── 置信度不足 → 请求澄清 ───────────────────────────────────────────────
  if (confidence < CLARIFY_THRESHOLD) {
    // 找前2候选域
    const sorted = Object.entries(parsed.allScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([d]) => `**${d}** (${DOMAIN_MAP[d].description})`);

    return {
      ok: false,
      needsClarification: true,
      question: `我理解你想做「${_escapeMd(text)}」，但不确定应该路由到哪个模块（置信度 ${(confidence * 100).toFixed(0)}%）。\n最可能的选项：${sorted.join(' 还是 ')}？`,
      candidates: sorted,
      confidence,
      raw: parsed,
    };
  }

  // ── 加载负向记忆约束 ────────────────────────────────────────────────────
  const constraints = _loadNegativeConstraints(parsed.domain);

  // ── 构建 params ─────────────────────────────────────────────────────────
  const params = {
    original_text: text,
    session_id:    context.session_id || null,
    user:          context.user       || null,
    project:       context.project    || parsed.domain,
  };

  return {
    ok:          true,
    domain:      parsed.domain,
    action:      parsed.action,
    params,
    confidence:  parseFloat(confidence.toFixed(3)),
    constraints: constraints.map(c => ({ id: c.id, rule: c.rule })),
    description: DOMAIN_MAP[parsed.domain].description,
    debug: {
      domain_score: parsed.domainScore,
      action_score: parsed.actionScore,
      all_scores:   parsed.allScores,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP handler helper — 供 server.js 直接使用
// ---------------------------------------------------------------------------

/**
 * 处理 POST /intent 请求体
 * body: { text, context?, llm_fallback? }
 * llm_fallback=true（默认）时，置信度不足会调 LLM 二次分类
 */
export async function handleIntentRoute(body) {
  const { text, context = {}, llm_fallback = true } = body;
  if (!text) return { ok: false, error: 'text 字段必填' };
  return llm_fallback === false ? routeIntent(text, context) : routeIntentAsync(text, context);
}
