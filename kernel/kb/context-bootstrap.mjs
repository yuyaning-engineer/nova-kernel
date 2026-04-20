/**
 * kb/context-bootstrap.mjs — Context Bootstrap (S1)
 *
 * 目的：任何新 session 的 AI 调一次 nova_context_snapshot，得到 <4KB 的客户画像：
 *   - 机器硬件一行（从 machine-spec-current 提取，若无则实时探测）
 *   - 活跃项目 top-N（按 created_at 降序）
 *   - 最近 feedback top-5（用户偏好）
 *   - 最近 7 天 daily digest 简报
 *   - KB 可用性（embedding 服务 / intel 池状态）
 *
 * scope 参数：'full' | 'hardware' | 'projects' | 'feedback' | 'digest' | 'kb'
 */

import { readMemories } from '../memory/memory-writer.mjs';

const MAX_BYTES = 4096;
const TOP_PROJECTS = 5;
const TOP_FEEDBACK = 5;

async function _hardwareLine() {
  const all = readMemories({ type: 'reference' });
  const spec = all.find(e => e.name === 'machine-spec-current');
  if (spec) {
    // 从 body 里抽第一行硬件摘要
    const m = spec.body.match(/CPU.*?(?:\n|$)[^\n]*?GPU[^\n]*/s);
    if (m) return m[0].replace(/\n/g, ' ').slice(0, 200);
    return spec.body.slice(0, 200);
  }
  // 兜底：实时探测
  try {
    const { buildMachineSpec } = await import('../librarian/machine-spec.mjs');
    const s = buildMachineSpec();
    const cpu = s.hardware?.cpu?.Name || '?';
    const gpuArr = Array.isArray(s.hardware?.gpu) ? s.hardware.gpu : [];
    const gpu = gpuArr[0] ? `${gpuArr[0].name} ${gpuArr[0].memTotal}` : '?';
    const ram = s.hardware?.memory_gb ? `${s.hardware.memory_gb}GB RAM` : '';
    return `${cpu} | ${gpu} | ${ram}`.slice(0, 200);
  } catch (e) {
    return '(机器画像未初始化 — 调用 nova_librarian_now({which:"machine-spec"}) 生成)';
  }
}

function _topProjects(n = TOP_PROJECTS) {
  const all = readMemories({ type: 'project' });
  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return all.slice(0, n).map(e => ({ name: e.name, desc: e.description }));
}

function _topFeedback(n = TOP_FEEDBACK) {
  const all = readMemories({ type: 'feedback' });
  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return all.slice(0, n).map(e => ({ name: e.name, desc: e.description }));
}

function _recentDigest() {
  const all = readMemories({ type: 'project' });
  const digest = all.find(e => e.name === 'nova-daily-digest');
  if (!digest) return null;
  // 取 body 前 500 字
  return digest.body.slice(0, 500);
}

async function _kbStatus() {
  const status = { embedding_service: 'unknown', vector_count: 0, intel_count: 0 };
  try {
    const res = await fetch('http://127.0.0.1:8899/health', { signal: AbortSignal.timeout(800) });
    status.embedding_service = res.ok ? 'up' : 'down';
  } catch { status.embedding_service = 'down'; }
  try {
    const { getVectorCount } = await import('./vector-store.mjs');
    status.vector_count = getVectorCount();
  } catch {}
  try {
    const { getIntelCount } = await import('./intel/ingest.mjs');
    status.intel_count = getIntelCount();
  } catch {}
  return status;
}

export async function buildContextSnapshot({ scope = 'full' } = {}) {
  const out = { scope, generated_at: new Date().toISOString() };

  if (scope === 'full' || scope === 'hardware') {
    out.hardware = await _hardwareLine();
  }
  if (scope === 'full' || scope === 'projects') {
    out.active_projects = _topProjects();
  }
  if (scope === 'full' || scope === 'feedback') {
    out.user_preferences = _topFeedback();
  }
  if (scope === 'full' || scope === 'digest') {
    const d = _recentDigest();
    if (d) out.recent_digest = d;
  }
  if (scope === 'full' || scope === 'kb') {
    out.kb = await _kbStatus();
  }

  const json = JSON.stringify(out, null, 2);
  if (json.length > MAX_BYTES) {
    out._truncated = true;
    if (out.active_projects) out.active_projects = out.active_projects.slice(0, 3);
    if (out.user_preferences) out.user_preferences = out.user_preferences.slice(0, 3);
    if (out.recent_digest) out.recent_digest = out.recent_digest.slice(0, 200);
  }

  return out;
}

export function renderContextMarkdown(snapshot) {
  const lines = ['# Nova Context Snapshot', `_生成于 ${snapshot.generated_at}_`, ''];
  if (snapshot.hardware) lines.push(`**机器**: ${snapshot.hardware}`, '');
  if (snapshot.active_projects?.length) {
    lines.push('**活跃项目 (按时间降序)**:');
    for (const p of snapshot.active_projects) lines.push(`- \`${p.name}\` — ${p.desc}`);
    lines.push('');
  }
  if (snapshot.user_preferences?.length) {
    lines.push('**用户偏好 (feedback)**:');
    for (const f of snapshot.user_preferences) lines.push(`- \`${f.name}\` — ${f.desc}`);
    lines.push('');
  }
  if (snapshot.recent_digest) {
    lines.push('**最近状态**:', snapshot.recent_digest, '');
  }
  if (snapshot.kb) {
    const k = snapshot.kb;
    lines.push(`**KB 状态**: embedding=${k.embedding_service}, 向量=${k.vector_count}, intel=${k.intel_count}`);
  }
  return lines.join('\n');
}
