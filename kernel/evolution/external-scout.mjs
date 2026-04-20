/**
 * kernel/evolution/external-scout.mjs — 外部更优方案探测器 (2026-04-19)
 *
 * 用户痛点: Nova 现在闭环演化, 从 feedback 蒸馏 skill, 但不知道外面世界:
 *   - npm 上 codex-cli 已经升 v0.130, 我们还在 v0.121
 *   - 某 skill 写的"用 X 实现 atomic write"在 2026 已经被 Y 取代
 *   - 某 agent 依赖的 Python 库已经废弃
 *
 * 解法: 周期性扫两个池子, 提议升级 (走 Council 不自动改):
 *
 *   A. Connector 升级 (mechanical, 无 LLM): npm view <pkg> version 对比本地
 *   B. Skill 新鲜度 (LLM 判断): 给 Sonnet 看 skill 内容, 问"2026 还是最佳实践吗?"
 *      新鲜度 < 0.6 → 提议 update / replace
 *
 * 输出: evolution/proposals/upgrade-connector-*.md / upgrade-skill-*.md
 * 触发: 24h cron (慢节奏, 节省外部调用) + 手动 POST /evolution/scout
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { callLlmJson } from '../utils/llm.mjs';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const PROPOSALS_DIR = join(ROOT, 'evolution', 'proposals');

/**
 * 安全 spawn (Windows shell injection 防护).
 * shell:true 把 manifest 字段直接交 cmd.exe 解析, 风险面.
 * 这里强制 shell:false; .cmd/.bat 走 cmd.exe /c 显式包装 + 引号转义.
 */
function _quoteCmdArg(value) {
  const text = String(value ?? '');
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}
function _spawnSafe(command, args = [], timeout = 10_000) {
  const cmd = String(command ?? '');
  const argv = Array.isArray(args) ? args.map(a => String(a)) : [];
  const isCmdWrapper = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  if (isCmdWrapper) {
    return spawnSync(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', [_quoteCmdArg(cmd), ...argv.map(_quoteCmdArg)].join(' ')],
      { encoding: 'utf8', timeout, windowsHide: true, shell: false },
    );
  }
  return spawnSync(cmd, argv, { encoding: 'utf8', timeout, windowsHide: true, shell: false });
}

/**
 * A. Connector 升级扫描 (无 LLM)
 *   manifest 增加可选字段 npm_package 或 pypi_package, scout 自动比较版本
 */
function _scoutConnectors() {
  const dir = join(ROOT, 'kernel', 'connectors', 'manifests');
  if (!existsSync(dir)) return { ok: false, error: 'manifests dir missing' };

  const upgrades = [];
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(dir, f), 'utf8')); }
    catch { continue; }

    if (!manifest.npm_package) continue;  // 没声明 npm 来源, 跳过

    // 拿本地 installed version (safe spawn)
    let installed = null;
    try {
      const args = manifest.versionArgs || ['--version'];
      const cmd = manifest.execNames?.[0] || manifest.id;
      const r = _spawnSafe(cmd, args, 10_000);
      const text = (r.stdout || '') + (r.stderr || '');
      const re = manifest.versionRegex ? new RegExp(manifest.versionRegex) : /(\d+\.\d+\.\d+)/;
      installed = text.match(re)?.[1] || null;
    } catch {}

    // 拿 npm latest (safe spawn, Windows 用 npm.cmd)
    let latest = null;
    try {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const r = _spawnSafe(npmCmd, ['view', manifest.npm_package, 'version'], 15_000);
      latest = (r.stdout || '').trim();
    } catch {}

    if (!installed || !latest) {
      upgrades.push({ id: manifest.id, npm_package: manifest.npm_package, installed, latest, status: 'unknown' });
      continue;
    }

    const cmp = _semverCompare(installed, latest);
    if (cmp < 0) {
      upgrades.push({ id: manifest.id, npm_package: manifest.npm_package, installed, latest, status: 'OUTDATED' });
    } else {
      upgrades.push({ id: manifest.id, npm_package: manifest.npm_package, installed, latest, status: 'current' });
    }
  }
  return { ok: true, scanned: upgrades.length, upgrades };
}

/**
 * 严肃 semver 比较 (含 prerelease):
 *   1.0.0 < 1.0.0-rc1 == false (prerelease 比正式版"小"按 SemVer spec)
 *   实际比较: 主.次.补丁 → prerelease 段 → 数字段比数字, 字母段比字典序
 */
function _parseSemver(value) {
  const m = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}
function _comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;   // 正式版 > prerelease
  if (b.length === 0) return -1;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] == null) return -1;
    if (b[i] == null) return 1;
    const ai = a[i], bi = b[i];
    const an = /^\d+$/.test(ai), bn = /^\d+$/.test(bi);
    if (an && bn) { const d = Number(ai) - Number(bi); if (d !== 0) return d; continue; }
    if (an !== bn) return an ? -1 : 1;
    const d = ai.localeCompare(bi);
    if (d !== 0) return d;
  }
  return 0;
}
function _semverCompare(a, b) {
  const la = _parseSemver(a), lb = _parseSemver(b);
  if (!la || !lb) return String(a ?? '').localeCompare(String(b ?? ''));
  for (let i = 0; i < 3; i++) {
    const d = la.core[i] - lb.core[i];
    if (d !== 0) return d;
  }
  return _comparePre(la.pre, lb.pre);
}

/**
 * B. Skill 新鲜度扫描 (LLM)
 *   给已晋级 skill 喂 Sonnet, 让它判断"2026 还是不是最佳实践"
 *   freshness < 0.6 → 写 upgrade-skill-*.md 提案 (Council 投, 用户终批)
 */
async function _scoutSkillsFreshness({ limit = 5 } = {}) {
  const dir = join(ROOT, 'evolution', 'skills');
  if (!existsSync(dir)) return { ok: false, error: 'skills dir missing' };

  const findings = [];
  const skills = readdirSync(dir).filter(x => x.endsWith('.md')).slice(0, limit);
  for (const f of skills) {
    let md;
    try { md = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    const skillName = f.replace(/\.md$/, '');

    const prompt = [
      `你是技术雷达分析师. 下面是 Nova 系统沉淀的一个 skill (在 2025 年某天被议会通过, 写入 evolution/skills/).`,
      `判断 2026 年它是否还是最佳实践, 还是有更优替代方案.`,
      ``,
      `# Skill: ${skillName}`,
      md.slice(0, 1500),
      ``,
      `# 输出 JSON:`,
      `{`,
      `  "freshness": 0-1 (1=完全最佳实践, 0=已过时),`,
      `  "verdict": "current" | "minor_update" | "major_replace",`,
      `  "reason": "<60 字>",`,
      `  "suggested_alternative": "如果 verdict 不是 current, 给出更优方案的关键词 (e.g. 包名/技术名)"`,
      `}`,
    ].join('\n');

    const r = await callLlmJson(prompt, {
      model: 'antigravity-claude-sonnet-4-6',
      task_type: 'analysis',
      worker: 'external-scout',
      task_id: `scout-skill-${skillName}-${Date.now()}`,
      timeout_ms: 30_000,
    });
    if (!r.ok) {
      findings.push({ skill: skillName, error: r.error });
      continue;
    }
    findings.push({
      skill: skillName,
      freshness: r.json.freshness,
      verdict: r.json.verdict,
      reason: r.json.reason,
      suggested_alternative: r.json.suggested_alternative,
    });
  }
  return { ok: true, scanned: findings.length, findings };
}

/**
 * 写 upgrade proposal (Council 投票, 用户终批)
 */
function _writeUpgradeProposal({ kind, target, current, suggested, reason }) {
  if (!existsSync(PROPOSALS_DIR)) mkdirSync(PROPOSALS_DIR, { recursive: true });
  const name = `upgrade-${kind}-${target}`;
  const path = join(PROPOSALS_DIR, `${name}.md`);
  if (existsSync(path)) return null;  // 幂等

  const md = [
    `---`,
    `type: upgrade_proposal`,
    `kind: ${kind}`,
    `target: ${target}`,
    `current_version: ${current}`,
    `suggested_version: ${suggested}`,
    `created_at: ${new Date().toISOString()}`,
    `status: pending`,
    `---`,
    ``,
    `# Upgrade: ${kind} ${target}`,
    ``,
    `## Current`,
    current,
    ``,
    `## Suggested`,
    suggested,
    ``,
    `## Reason`,
    reason,
    ``,
    `## Action`,
    kind === 'connector'
      ? `1. 跑 \`npm install -g ${target}@${suggested}\``
      : `1. 评审 skill 是否需要重写 / 弃用`,
    `2. 验证升级后 connector probe / skill 用例都通过`,
    `3. 议会投票 → 用户批准`,
  ].join('\n');
  writeFileSync(path, md, 'utf8');
  return { name, path };
}

/**
 * 主入口: scout 扫两个池子, 写 proposal.
 *
 * @param {object} opts
 * @param {boolean} [opts.skipConnectors=false]
 * @param {boolean} [opts.skipSkills=false]
 * @param {number}  [opts.skillLimit=3]
 * @param {boolean} [opts.dry=false] — 仅返报告不写提案
 */
export async function scoutExternal({ skipConnectors = false, skipSkills = false, skillLimit = 3, dry = false } = {}) {
  const report = { ts: new Date().toISOString(), connectors: null, skills: null, proposals_written: [] };

  if (!skipConnectors) {
    report.connectors = _scoutConnectors();
    if (!dry && report.connectors.ok) {
      for (const u of report.connectors.upgrades.filter(x => x.status === 'OUTDATED')) {
        const r = _writeUpgradeProposal({
          kind: 'connector',
          target: u.npm_package.replace(/[@/]/g, '-'),
          current: u.installed,
          suggested: u.latest,
          reason: `npm 上 ${u.npm_package} 最新 ${u.latest}, 本地 ${u.installed}`,
        });
        if (r) report.proposals_written.push(r.name);
      }
    }
  }

  if (!skipSkills) {
    report.skills = await _scoutSkillsFreshness({ limit: skillLimit });
    if (!dry && report.skills.ok) {
      for (const f of report.skills.findings.filter(x => x.freshness != null && x.freshness < 0.6)) {
        const r = _writeUpgradeProposal({
          kind: 'skill',
          target: f.skill,
          current: '(see evolution/skills/' + f.skill + '.md)',
          suggested: f.suggested_alternative || '(LLM 未给具体方案, 需人审)',
          reason: `${f.verdict}: ${f.reason}`,
        });
        if (r) report.proposals_written.push(r.name);
      }
    }
  }

  return { ok: true, ...report };
}
