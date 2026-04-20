/**
 * Nova Kernel — 飞书通知模块
 * kernel/notify/feishu.mjs
 *
 * 职责：
 *   1. 出站通知 — 向飞书自定义机器人 Webhook 发送消息（日报/告警/任务结果）
 *   2. 入站解析 — 验证飞书事件签名，解析用户消息，返回结构化 payload
 *
 * 所需环境变量（在 .env 中配置）：
 *   FEISHU_WEBHOOK_URL      自定义机器人 Webhook 地址（必填，出站）
 *   FEISHU_WEBHOOK_SECRET   Webhook 签名密钥（可选，出站加签）
 *   FEISHU_APP_ID           应用 App ID（可选，入站事件验证）
 *   FEISHU_APP_SECRET       应用 App Secret（可选，入站）
 *   FEISHU_VERIFY_TOKEN     事件订阅验证 Token（可选，入站）
 *
 * 消息类型（出站）：
 *   text        — 纯文本
 *   markdown    — 富文本 Markdown（post 类型）
 *   alert       — 红色高亮告警卡片
 *   briefing    — 日报卡片（分块展示 findings）
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { request } from 'https';

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

const WEBHOOK_URL    = process.env.FEISHU_WEBHOOK_URL    || '';
const WEBHOOK_SECRET = process.env.FEISHU_WEBHOOK_SECRET || '';
const VERIFY_TOKEN   = process.env.FEISHU_VERIFY_TOKEN   || '';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** HTTPS POST JSON，不依赖第三方库 */
function _httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data    = JSON.stringify(body);
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    };
    const req = request(options, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    // C008 fix: 用 _settled 防止 destroy() 触发 error 事件导致二次 reject
    let _settled = false;
    function _settle(fn, val) { if (!_settled) { _settled = true; fn(val); } }
    req.on('error', err => _settle(reject, err));
    req.setTimeout(8000, () => { req.destroy(); _settle(reject, new Error('Feishu request timeout')); });
    req.write(data);
    req.end();
  });
}

/**
 * 生成飞书自定义机器人签名
 * timestamp 单位：秒；sign = base64(hmac-sha256("timestamp\n" + secret))
 */
function _sign(timestamp) {
  if (!WEBHOOK_SECRET) return null;
  const str  = `${timestamp}\n${WEBHOOK_SECRET}`;
  const hmac = createHmac('sha256', str);
  return hmac.digest('base64');
}

// ---------------------------------------------------------------------------
// 出站：发送消息到飞书 Webhook
// ---------------------------------------------------------------------------

/**
 * 发送文本消息
 * @param {string} text
 */
export async function sendText(text) {
  if (!WEBHOOK_URL) throw new Error('FEISHU_WEBHOOK_URL 未配置');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign      = _sign(timestamp);

  const body = { msg_type: 'text', content: { text } };
  if (sign) { body.timestamp = timestamp; body.sign = sign; }

  const resp = await _httpsPost(WEBHOOK_URL, body);
  if (resp.body?.code && resp.body.code !== 0) {
    throw new Error(`飞书 API 错误: ${resp.body.msg} (code=${resp.body.code})`);
  }
  return resp;
}

/**
 * 发送富文本消息（飞书 post 类型）
 * @param {string} title
 * @param {Array<Array<{tag, text?, href?, user_id?}>>} content  按段落/行组织
 */
export async function sendRichText(title, content) {
  if (!WEBHOOK_URL) throw new Error('FEISHU_WEBHOOK_URL 未配置');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign      = _sign(timestamp);

  const body = {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: { title, content },
      },
    },
  };
  if (sign) { body.timestamp = timestamp; body.sign = sign; }

  const resp = await _httpsPost(WEBHOOK_URL, body);
  if (resp.body?.code && resp.body.code !== 0) {
    throw new Error(`飞书 API 错误: ${resp.body.msg} (code=${resp.body.code})`);
  }
  return resp;
}

/**
 * 发送交互卡片消息（告警/日报/任务结果）
 * @param {'alert'|'briefing'|'task_result'} type
 * @param {object} payload
 */
export async function sendCard(type, payload) {
  if (!WEBHOOK_URL) throw new Error('FEISHU_WEBHOOK_URL 未配置');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign      = _sign(timestamp);

  let card;
  if (type === 'alert') {
    card = _buildAlertCard(payload);
  } else if (type === 'briefing') {
    card = _buildBriefingCard(payload);
  } else {
    card = _buildTaskResultCard(payload);
  }

  const body = { msg_type: 'interactive', card };
  if (sign) { body.timestamp = timestamp; body.sign = sign; }

  const resp = await _httpsPost(WEBHOOK_URL, body);
  if (resp.body?.code && resp.body.code !== 0) {
    throw new Error(`飞书 API 错误: ${resp.body.msg} (code=${resp.body.code})`);
  }
  return resp;
}

// ---------------------------------------------------------------------------
// 卡片模板构建
// ---------------------------------------------------------------------------

function _buildAlertCard({ title, message, severity = 'HIGH', details = [] }) {
  const colorMap = { HIGH: 'red', MEDIUM: 'orange', LOW: 'green' };
  const color    = colorMap[severity] || 'orange';
  const icon     = severity === 'HIGH' ? '🔴' : severity === 'MEDIUM' ? '🟡' : '🟢';

  const elements = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**${icon} ${message}**` },
    },
  ];

  if (details.length > 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: details.map(d => `• ${d}`).join('\n') },
    });
  }

  elements.push({
    tag: 'action',
    actions: [
      // C009 fix: 使用可配置的外部 URL，避免暴露内网地址；未配置则不显示按钮
      ...(process.env.NOVA_KERNEL_EXTERNAL_URL ? [{
        tag: 'button', text: { tag: 'plain_text', content: '查看详情' }, type: 'primary',
        url: `${process.env.NOVA_KERNEL_EXTERNAL_URL}/evolution/gaps`,
      }] : []),
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `⚡ Nova Kernel — ${title}` }, template: color },
    elements,
  };
}

function _buildBriefingCard({ date, findings = [], actionsOk = 0 }) {
  const rows = findings.map(f => {
    const icon = f.severity === 'HIGH' ? '🔴' : f.severity === 'MEDIUM' ? '🟡' : '🟢';
    return `**${icon} ${f.type}**：${f.message}`;
  });

  const content = rows.length > 0
    ? rows.join('\n\n')
    : '✅ 系统健康，无待处理事项';

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `📋 Nova 日报 · ${date}` }, template: 'blue' },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `> 扫描完成：发现 **${findings.length}** 项，已处理 **${actionsOk}** 项` },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: content.slice(0, 2000) }, // 卡片字数限制
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `自动生成 · ${new Date().toISOString().replace('T', ' ').slice(0, 19)}` }],
      },
    ],
  };
}

function _buildTaskResultCard({ task_id, project, status, summary, risk_level }) {
  const icon   = status === 'ok' ? '✅' : '❌';
  const color  = status === 'ok' ? 'green' : 'red';

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `${icon} 任务结果 · ${project}` }, template: color },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**任务 ID**\n${task_id || '-'}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**风险等级**\n${risk_level || '-'}` } },
        ],
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: summary || '(无摘要)' },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 入站：验证飞书事件签名
// ---------------------------------------------------------------------------

/**
 * 验证飞书事件订阅请求
 * 支持两种模式：
 *   1. URL 验证挑战（challenge）
 *   2. 事件推送（签名验证）
 *
 * @param {object} body     解析后的请求体
 * @param {string} timestamp  X-Lark-Request-Timestamp header
 * @param {string} nonce      X-Lark-Request-Nonce header
 * @param {string} signature  X-Lark-Signature header
 * @returns {{ ok: boolean, challenge?: string, event?: object, error?: string }}
 */
// C007 fix: 完整签名验证，无 VERIFY_TOKEN 时拒绝所有请求，防重放（5min 窗口）
export function verifyInboundEvent(body, { timestamp, nonce, signature } = {}) {
  // ── Challenge 验证（必须配置了 VERIFY_TOKEN 才响应）──────────────────
  if (body.challenge) {
    if (!VERIFY_TOKEN) {
      return { ok: false, error: 'FEISHU_VERIFY_TOKEN 未配置，拒绝 challenge 请求' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (!timestamp || Math.abs(now - parseInt(timestamp, 10)) > 300) {
      return { ok: false, error: 'challenge timestamp 超出 5 分钟窗口' };
    }
    return { ok: true, challenge: body.challenge };
  }

  // ── 正式事件：签名必须通过 ────────────────────────────────────────────
  if (!VERIFY_TOKEN) {
    return { ok: false, error: 'FEISHU_VERIFY_TOKEN 未配置，无法验证签名' };
  }
  if (!timestamp || !nonce || !signature) {
    return { ok: false, error: '缺少签名 header（需要 X-Lark-Request-Timestamp/Nonce/Signature）' };
  }

  // timestamp 5 分钟时效，防重放
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    return { ok: false, error: '请求 timestamp 过期（超过 5 分钟）' };
  }

  const rawBody  = typeof body === 'string' ? body : JSON.stringify(body);
  const expected = createHmac('sha256', VERIFY_TOKEN)
    .update(`${timestamp}${nonce}${rawBody}`)
    .digest('hex');

  let match = false;
  try {
    match = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch { match = false; }

  if (!match) {
    return { ok: false, error: '飞书签名验证失败' };
  }

  const event = body.event || body;
  return { ok: true, event };
}

/**
 * 从飞书消息事件中提取用户输入文本
 * @param {object} event  飞书 message.receive 事件体
 * @returns {string|null}
 */
export function extractMessageText(event) {
  try {
    const content = event?.message?.content;
    if (!content) return null;
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    return parsed.text?.trim() || null;
  } catch { return null; }
}

/**
 * 获取发送者信息
 * @param {object} event
 * @returns {{ userId, chatId, chatType }}
 */
export function extractSender(event) {
  return {
    userId:   event?.sender?.sender_id?.user_id   || null,
    openId:   event?.sender?.sender_id?.open_id   || null,
    chatId:   event?.message?.chat_id             || null,
    chatType: event?.message?.chat_type           || 'private',
  };
}

// ---------------------------------------------------------------------------
// 便捷函数：主动引擎专用
// ---------------------------------------------------------------------------

/**
 * 发送日报卡片（由 initiative engine 调用）
 * @param {{ findings, decisions, date }} report
 */
export async function sendBriefingCard(report) {
  const actionsOk = report.decisions?.filter(d => d.result?.ok && d.decided_action !== 'briefing_only').length || 0;
  await sendCard('briefing', {
    date:     report.date || new Date().toISOString().slice(0, 10),
    findings: report.findings || [],
    actionsOk,
  });
}

/**
 * 发送紧急告警（否决窗口即将到期等）
 * @param {string} title
 * @param {string} message
 * @param {string[]} details
 * @param {'HIGH'|'MEDIUM'|'LOW'} severity
 */
export async function sendAlert(title, message, details = [], severity = 'HIGH') {
  await sendCard('alert', { title, message, severity, details });
}
