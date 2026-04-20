/**
 * Nova Kernel — Codex CLI 受控执行器
 * kernel/workers/codex-verify.mjs
 *
 * 【Opus 建议】Codex 是"受控执行器"，不是"自主 QA agent"。
 * Driver 告诉它跑什么命令，它只返回 stdout/stderr/exit_code。
 * 判断"测试是否通过"这件事留给 Driver 或 Opus。
 *
 * 两种调用模式：
 *   1. runCommand({cwd, command, expectExit})    — 跑一个具体命令
 *   2. runCodexExec({cwd, prompt, timeoutMs})    — 让 codex CLI 自由跑（适合"让它修个 bug"场景，用于非验证路径）
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CODEX_BIN = process.env.CODEX_BIN || 'codex';

// 递归熔断：同 (cwd, issue_hash) 5 分钟内不重复接单
// 防止 Codex 修完触发 watcher → 生成新 gap → 再派 Codex 的无限循环
const _recentFixSignatures = new Map(); // signature → timestamp
const FIX_COOLDOWN_MS = 5 * 60 * 1000;

function _hashSignature(cwd, issue) {
  return createHash('sha256').update(`${cwd}|${issue.slice(0, 2000)}`).digest('hex').slice(0, 16);
}

function _checkRecursion(cwd, issue) {
  const sig = _hashSignature(cwd, issue);
  const prev = _recentFixSignatures.get(sig);
  if (prev && Date.now() - prev < FIX_COOLDOWN_MS) {
    return { blocked: true, signature: sig, ago_ms: Date.now() - prev };
  }
  _recentFixSignatures.set(sig, Date.now());
  // 顺手清理过期
  if (_recentFixSignatures.size > 100) {
    const cutoff = Date.now() - FIX_COOLDOWN_MS;
    for (const [s, t] of _recentFixSignatures) if (t < cutoff) _recentFixSignatures.delete(s);
  }
  return { blocked: false, signature: sig };
}

function _spawn(cmd, args, { cwd, input, timeoutMs = 120_000, env }) {
  return new Promise(resolve => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      shell: false,
      windowsHide: true,
    });
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    }, timeoutMs);
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(t);
      resolve({ ok: false, exit_code: -1, stdout, stderr: stderr + '\n[spawn error] ' + err.message, elapsed_ms: Date.now() - started, timed_out: timedOut });
    });
    child.on('close', code => {
      clearTimeout(t);
      resolve({ ok: !timedOut && code === 0, exit_code: code, stdout, stderr, elapsed_ms: Date.now() - started, timed_out: timedOut });
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/**
 * 模式 1：跑一个受控命令，返回结构化结果。Driver 对照 expectExit 判断成败。
 * @param {object} p
 * @param {string} p.cwd      工作目录（必填，防止在别处乱跑）
 * @param {string[]} p.command   ['python', 'test.py'] 形式
 * @param {number} [p.expectExit=0]
 * @param {number} [p.timeoutMs=60000]
 * @returns {Promise<{ok, exit_code, stdout, stderr, elapsed_ms, timed_out, passed}>}
 */
export async function runCommand({ cwd, command, expectExit = 0, timeoutMs = 60_000 }) {
  if (!cwd || !existsSync(cwd)) throw new Error(`cwd 不存在: ${cwd}`);
  if (!Array.isArray(command) || command.length === 0) throw new Error('command 必须是非空数组');
  const [bin, ...args] = command;
  const r = await _spawn(bin, args, { cwd, timeoutMs });
  return { ...r, passed: !r.timed_out && r.exit_code === expectExit };
}

/**
 * 模式 2：让 codex CLI 自主跑一个 prompt（`codex exec --full-auto`）。
 * 注意：这会给 Codex 完整工作区权限，自主规划执行。适合"修 bug/写单测"场景。
 * Driver 需要对 cwd 做沙箱隔离（建议用临时目录）。
 *
 * @param {object} p
 * @param {string} p.cwd
 * @param {string} p.prompt
 * @param {string} [p.model='gpt-5.4']
 * @param {number} [p.timeoutMs=180000]
 */
export async function runCodexExec({ cwd, prompt, model, timeoutMs = 180_000 }) {
  if (!cwd || !existsSync(cwd)) throw new Error(`cwd 不存在: ${cwd}`);
  if (!prompt) throw new Error('prompt 必填');
  const args = ['exec', '--full-auto', '--skip-git-repo-check', '-'];
  if (model) args.push('-m', model);
  return _spawn(CODEX_BIN, args, { cwd, input: prompt, timeoutMs });
}

/**
 * 探测 codex CLI 是否可用（给 doctor / pipeline 前置检查用）
 */
export async function probeCodex() {
  try {
    const r = await _spawn(CODEX_BIN, ['--version'], { cwd: process.cwd(), timeoutMs: 3000 });
    return { ok: r.ok, version: r.stdout.trim(), exit_code: r.exit_code };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 模式 3：让 Codex 做代码审查（使用 `codex review` 专用子命令）
 * 适合：拿到一份 diff 或一批文件，让 Codex 找 bug/风险/建议
 *
 * @param {object} p
 * @param {string} p.cwd              工作目录（需要是 git 仓库以获取 diff）
 * @param {string} [p.focusInstruction] 额外指令（如"重点看安全"）
 * @param {number} [p.timeoutMs=180000]
 */
export async function runCodexReview({ cwd, focusInstruction = '', timeoutMs = 180_000 }) {
  if (!cwd || !existsSync(cwd)) throw new Error(`cwd 不存在: ${cwd}`);
  const args = ['exec', 'review', '--skip-git-repo-check'];
  // `codex exec review` 默认审本仓库的未提交 diff
  const input = focusInstruction || '执行代码审查：列出潜在 bug、逻辑问题、安全风险、性能隐患。每个问题给文件:行号 + 风险等级（high/med/low）+ 建议。';
  return _spawn(CODEX_BIN, args, { cwd, input, timeoutMs });
}

/**
 * 模式 4：让 Codex 自主修一个 bug（完整 agent 模式）
 * 给 Codex 一个问题描述 + 工作区，让它自己读代码、修、跑测试。
 * Driver 最后审它的 diff（用 `codex apply` 落地前先人工看）。
 *
 * @param {object} p
 * @param {string} p.cwd
 * @param {string} p.issue             问题描述
 * @param {string} [p.testCommand]     可选：修完后让 Codex 跑的验证命令
 * @param {string} [p.model]
 * @param {number} [p.timeoutMs=300000]
 */
export async function runCodexFix({ cwd, issue, testCommand, model, timeoutMs = 300_000 }) {
  if (!cwd || !existsSync(cwd)) throw new Error(`cwd 不存在: ${cwd}`);
  if (!issue) throw new Error('issue 必填');

  // 递归熔断：同 issue 不在 5 分钟内重复修
  const rec = _checkRecursion(cwd, issue);
  if (rec.blocked) {
    return {
      ok: false,
      exit_code: -1,
      stdout: '',
      stderr: `[recursion-limit] 同一 issue 在 ${Math.floor(rec.ago_ms/1000)}s 前已派过 codex-fix，cooldown 中（避免无限修循环）。signature=${rec.signature}`,
      elapsed_ms: 0,
      timed_out: false,
      blocked_by: 'recursion-limit',
    };
  }

  // Sandbox / 实验区任务免 claim（给 AI 进化空间）
  const isSandbox = /sandbox|_experiments|evolution[\/\\]/i.test(cwd);

  // 申请文件租约（但 sandbox 区跳过 — 那是 AI 自由后院）
  const { claimFiles, releaseLease } = await import('../locks/file-lease.mjs');
  let lease = null;
  if (!isSandbox) {
    lease = claimFiles({
      paths: [cwd],
      holder: `codex-fix:${rec.signature}`,
      ttl_ms: timeoutMs + 10_000,
      meta: { issue: issue.slice(0, 200) },
    });
    if (!lease.ok) {
      return {
        ok: false,
        exit_code: -1,
        stdout: '',
        stderr: `[file-lease] 无法获取 cwd 租约：${lease.error}${lease.conflicts ? ' ' + JSON.stringify(lease.conflicts) : ''}${lease.policy_denied ? '\n💡 如果这是实验性任务，改到 D:/claude/sandbox/ 下跑即可免所有检查' : ''}`,
        elapsed_ms: 0,
        timed_out: false,
        blocked_by: 'file-lease',
      };
    }
  }

  try {
    const prompt = [
    `【任务】修复以下问题：`,
    issue,
    '',
    '【要求】',
    '- 先读相关代码理解现状',
    '- 修最小改动（不重构无关代码）',
    testCommand ? `- 修完后跑 \`${testCommand}\` 验证通过` : '- 修完后用现有测试框架验证',
    '- 遵守工作区 AGENTS.md 里的约定（若存在）',
    '- 完成后简短说明改了什么、为什么',
  ].join('\n');
  const args = ['exec', '--full-auto', '--skip-git-repo-check', '-'];
  if (model) args.push('-m', model);
  const result = await _spawn(CODEX_BIN, args, { cwd, input: prompt, timeoutMs });
  return result;
  } finally {
    // sandbox 区没拿租约，跳过释放
    if (lease && lease.ok) releaseLease(lease.lease_id, 'codex-fix-done');
  }
}
