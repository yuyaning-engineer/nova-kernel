/**
 * kb/vault-sync.mjs — Obsidian Vault 投影层 (P0-2)
 *
 * 把 Nova 记忆 + intel 池投影成 Obsidian 可用的 markdown 树：
 *
 *   D:/claude/Vault/
 *   ├── _Inbox/            # 新内容暂存（同事发的 intel 默认落这，等策展）
 *   ├── Public/            # 全公司可见
 *   │   ├── Identity/      # user 类型（谁是老板）
 *   │   ├── Playbooks/     # feedback 类型（偏好/规则/教训）
 *   │   ├── Decisions/     # project 类型（每轮迭代 + 重大决议）
 *   │   ├── References/    # reference 类型（外部资源/文档位置）
 *   │   ├── System/        # machine-spec / nova-arch 等自动快照
 *   │   └── Intel/         # intel 池 refined 条目（KOL/品牌/趋势）
 *   ├── Team/              # 未来部门分区（现在空）
 *   ├── Private/<user>/    # 未来员工私人区
 *   └── _Archived/         # confidence 被衰减归档的
 *
 * 用 YAML frontmatter + Obsidian [[wikilinks]] 让图谱视图可看。
 *
 * 调用：syncVault() — 全量重写（覆盖 Nova 管辖的文件；_Inbox 里人手工写的保留）
 * 集成：self-maintenance 每 30 分钟跑一次 + 手动 /kb/vault-sync
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const VAULT_ROOT = process.env.NOVA_VAULT_ROOT || 'D:/claude/Vault';
const NOVA_MARK = '<!-- nova-managed: 本文件由 Nova 自动生成，人工修改会被覆盖。若想永久保留请移到 _Inbox/ 外。 -->';

const TYPE_TO_ZONE = {
  user:      { dir: 'Public/Identity',   label: '👤' },
  feedback:  { dir: 'Public/Playbooks',  label: '💬' },
  project:   { dir: 'Public/Decisions',  label: '🗂' },
  reference: { dir: 'Public/References', label: '🔗' },
};

// 自动快照类的记忆单独放 System/
const SYSTEM_NAMES = new Set(['machine-spec-current', 'nova-architecture-current', 'nova-daily-digest', 'kb-maintenance-latest']);

function _ensureDirs() {
  const dirs = [
    VAULT_ROOT,
    `${VAULT_ROOT}/_Inbox`,
    `${VAULT_ROOT}/_Archived`,
    `${VAULT_ROOT}/Public`,
    `${VAULT_ROOT}/Public/Identity`,
    `${VAULT_ROOT}/Public/Playbooks`,
    `${VAULT_ROOT}/Public/Decisions`,
    `${VAULT_ROOT}/Public/References`,
    `${VAULT_ROOT}/Public/System`,
    `${VAULT_ROOT}/Public/Intel`,
    `${VAULT_ROOT}/Team`,
    `${VAULT_ROOT}/Private`,
  ];
  for (const d of dirs) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function _safeFile(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

function _renderMemoryMd(e) {
  const module = _extractKbMeta(e.body, 'module');
  const func = _extractKbMeta(e.body, 'function');
  const risk = _extractKbMeta(e.body, 'risk');
  const tags = [`nova/${e.type}`];
  if (module) tags.push(`module/${module}`);
  if (func && func !== 'other') tags.push(`fn/${func}`);
  if (risk) tags.push(`risk/${risk}`);

  const links = _detectWikilinks(e.body);
  const linkLine = links.length ? '\n\n**相关**：' + links.map(l => `[[${l}]]`).join(' · ') : '';

  const fm = [
    '---',
    `nova_id: ${e.id}`,
    `nova_type: ${e.type}`,
    `nova_source: ${e.source || 'unknown'}`,
    `confidence: ${e.confidence ?? 1.0}`,
    `created_at: ${e.created_at || ''}`,
    `tags: [${tags.join(', ')}]`,
    '---',
    '',
    NOVA_MARK,
    '',
    `> ${e.description || ''}`,
    '',
    e.body.replace(/<!-- kb-meta:[^>]*-->/g, '').trim(),
    linkLine,
  ].join('\n');
  return fm;
}

function _extractKbMeta(body, key) {
  const m = String(body || '').match(new RegExp(`${key}=([a-zA-Z0-9_\\-\\.]+)`));
  return m ? m[1] : null;
}

function _detectWikilinks(body) {
  const matches = new Set();
  const re = /\b(round-\d+-[a-z0-9\-]+|kb-v2-[a-z0-9\-]+|nova-[a-z0-9\-]+|intel-briefing-\w+|machine-spec-current|ai-studio-[a-z0-9\-]+|studio-watch-[a-z0-9\.\-]+)\b/g;
  let m;
  while ((m = re.exec(body || ''))) matches.add(m[1]);
  return [...matches].slice(0, 12);
}

function _renderIntelMd(item) {
  const refined = typeof item.refined === 'string' ? (() => { try { return JSON.parse(item.refined); } catch { return null; } })() : item.refined;
  const tags = ['nova/intel', `channel/${item.source_channel || 'unknown'}`];
  if (refined?.category) tags.push(`cat/${refined.category}`);
  if (refined?.decision_value) tags.push(`value/${refined.decision_value}`);

  const lines = [
    '---',
    `nova_id: ${item.id}`,
    `nova_type: intel`,
    `sender: ${item.sender || 'unknown'}`,
    `received_at: ${item.received_at || ''}`,
    `status: ${item.status}`,
    `tags: [${tags.join(', ')}]`,
    '---',
    '',
    NOVA_MARK,
    '',
    `> ${refined?.summary || (item.raw_text || '').slice(0, 80)}`,
    '',
    `## 📨 原文`,
    item.raw_text || '(无)',
    '',
  ];
  if (item.urls?.length) {
    lines.push('## 🔗 链接');
    for (const u of item.urls) lines.push(`- ${u}`);
    lines.push('');
  }
  if (refined) {
    lines.push('## 🏷 提炼');
    if (refined.category) lines.push(`- 类别：${refined.category}`);
    if (refined.decision_value) lines.push(`- 决策价值：**${refined.decision_value}**`);
    if (refined.reason) lines.push(`- 原因：${refined.reason}`);
    if (refined.entities) {
      for (const [k, arr] of Object.entries(refined.entities)) {
        if (arr?.length) lines.push(`- ${k}：${arr.map(x => `[[${x}]]`).join(', ')}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function _deleteManagedIn(dir) {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    try {
      const st = statSync(full);
      if (!st.isFile() || !f.endsWith('.md')) continue;
      const content = readFileSync(full, 'utf8');
      if (content.includes('nova-managed: 本文件由 Nova')) {
        unlinkSync(full);
        removed++;
      }
    } catch {}
  }
  return removed;
}

export async function syncVault() {
  _ensureDirs();
  const { readMemories } = await import('../memory/memory-writer.mjs');
  const all = readMemories();

  // 清旧（只删 Nova 管辖的，_Inbox 保留；人工写的保留）
  const zonesToClean = [
    'Public/Identity', 'Public/Playbooks', 'Public/Decisions', 'Public/References', 'Public/System', 'Public/Intel',
  ];
  let removed = 0;
  for (const z of zonesToClean) {
    removed += _deleteManagedIn(join(VAULT_ROOT, z));
  }

  // 写记忆
  let written = 0;
  for (const e of all) {
    const isSystem = SYSTEM_NAMES.has(e.name) || (e.source === 'machine-spec-auto') || (e.source === 'arch-snapshot-auto');
    const zone = isSystem ? { dir: 'Public/System', label: '⚙️' } : TYPE_TO_ZONE[e.type];
    if (!zone) continue;
    const dir = join(VAULT_ROOT, zone.dir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const fname = `${zone.label} ${_safeFile(e.name)}.md`;
    writeFileSync(join(dir, fname), _renderMemoryMd(e), 'utf8');
    written++;
  }

  // 写 intel
  try {
    const { listIntel } = await import('./intel/ingest.mjs');
    const items = listIntel({ limit: 500 });
    for (const it of items) {
      const dir = join(VAULT_ROOT, 'Public/Intel');
      const fname = `📥 ${_safeFile(it.id)}_${(it.received_at || '').slice(0, 10)}.md`;
      writeFileSync(join(dir, fname), _renderIntelMd(it), 'utf8');
      written++;
    }
  } catch {}

  // 写总索引
  _writeVaultIndex(all, written);
  return { ok: true, vault_root: VAULT_ROOT, written, removed, ts: new Date().toISOString() };
}

function _writeVaultIndex(all, totalWritten) {
  const byType = { user: [], feedback: [], project: [], reference: [] };
  for (const e of all) (byType[e.type] || []).push(e);
  const lines = [
    '---',
    'nova_type: vault_index',
    'tags: [nova/index]',
    '---',
    '',
    NOVA_MARK,
    '',
    '# Nova Vault 图谱',
    '',
    `_最近更新：${new Date().toISOString()}_`,
    '',
    `**四区结构**：`,
    '- `_Inbox/` — 新内容暂存（你人工扔的 / 未来飞书推送 / 未策展）',
    '- `Public/` — Nova 管辖，全公司可见（Identity / Playbooks / Decisions / References / System / Intel）',
    '- `Team/` — 未来部门分区（现在空）',
    '- `Private/<user>/` — 未来员工私人区',
    '- `_Archived/` — 被衰减归档',
    '',
    `**当前资产**：${all.length} 条记忆 + 写了 ${totalWritten} 个 markdown 文件到 Public/*`,
    '',
    '## 📚 按类型',
    '',
    `- 👤 Identity (${byType.user.length})：见 [[Public/Identity]]`,
    `- 💬 Playbooks (${byType.feedback.length})：见 [[Public/Playbooks]]`,
    `- 🗂 Decisions (${byType.project.length})：见 [[Public/Decisions]]`,
    `- 🔗 References (${byType.reference.length})：见 [[Public/References]]`,
    '',
    '## 🧭 入口',
    '',
    '- **开始了解 Nova** → [[🗂 kb-v2-round-complete]] + [[🗂 nova-architecture-current]]',
    '- **机器配置** → [[⚙️ machine-spec-current]]',
    '- **用户偏好** → [[💬 brief-responses]]',
    '- **最近 intel** → 看 `Public/Intel/` 目录',
    '',
    '## ✏️ 怎么用',
    '',
    '1. **读**：任何 AI 写记忆后 30 分钟内自动投到 Public/ 对应区',
    '2. **写**：你自己要记的东西，扔到 `_Inbox/` 下（任意 markdown 文件名）',
    '   - Nova 的 inbox-watcher 每 1.5 秒扫一次，自动吸收成正式记忆',
    '3. **搜**：Obsidian 全文搜 + [[wikilink]] 跳转；或问我走 `nova_kb_search`',
    '4. **人工保留**：不想被 Nova 覆盖的文件，**删掉 `nova-managed` 标记**那行即可',
    '',
  ];
  writeFileSync(join(VAULT_ROOT, '_README.md'), lines.join('\n'), 'utf8');
}
