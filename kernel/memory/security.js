/**
 * Nova Kernel — Memory Security Scanner
 * 移植自 Hermes Agent tools/memory_tool.py
 *
 * 所有写入 MEMORY.md / USER.md 的内容必须先经过此模块扫描。
 * 此文件是 immutable_paths 之一，禁止 AI 修改。
 */

const THREAT_PATTERNS = [
  // Prompt 注入
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: 'prompt_injection' },
  { pattern: /you\s+are\s+now\s+/i, id: 'role_hijack' },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: 'deception_hide' },
  { pattern: /system\s+prompt\s+override/i, id: 'sys_prompt_override' },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: 'disregard_rules' },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i, id: 'bypass_restrictions' },

  // 凭证外泄
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'exfil_curl' },
  { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'exfil_wget' },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, id: 'read_secrets' },

  // 宪法篡改尝试
  { pattern: /constitutional\.json/i, id: 'constitutional_reference' },
  { pattern: /audit\.db/i, id: 'audit_reference' },
];

// 不可见字符注入检测
const INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
]);

/**
 * 扫描内容是否包含威胁模式
 * @param {string} content
 * @returns {{ safe: boolean, reason?: string }}
 */
export function scanMemoryContent(content) {
  // 不可见字符检测
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      return {
        safe: false,
        reason: `Blocked: 内容包含不可见 Unicode 字符 U+${char.codePointAt(0).toString(16).toUpperCase()}（疑似注入攻击）`,
      };
    }
  }

  // 威胁模式检测
  for (const { pattern, id } of THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return {
        safe: false,
        reason: `Blocked: 内容匹配威胁模式 '${id}'。记忆内容会注入系统提示，禁止包含注入或外泄载荷。`,
      };
    }
  }

  return { safe: true };
}

/**
 * 安全写入记忆条目（带扫描）
 * @param {string} content
 * @param {'MEMORY' | 'USER'} target
 * @throws {Error} 内容不安全时抛出
 */
export function assertSafeMemoryContent(content, target = 'MEMORY') {
  const result = scanMemoryContent(content);
  if (!result.safe) {
    throw new Error(`[Nova Kernel Security] ${target}.md 写入被拒绝: ${result.reason}`);
  }
}
