# Nova Kernel · Launch Promo Pack

> 5 个平台的发帖文案 + 头像/banner + 步骤说明，预估**总手动时间 8-10 分钟**。

---

## 1️⃣ Dev.to 长文（5 分钟，最高 SEO 价值）

### 步骤
1. 浏览器打开 https://dev.to/enter
2. 点 **"Continue with GitHub"** → 浏览器弹 GitHub 授权页 → 点绿色 **Authorize thepracticaldev**
3. 进 onboarding：填 username (建议 `yaning`)、个人简介（用下面 BIO）→ 跳过 follow 推荐
4. 右上角点 **Create Post** (✏️ 图标)
5. 复制下面 **Article Title** 到标题栏
6. 复制下面 **Cover Image** 路径上传
7. 复制下面 **Article Body** 到正文
8. 点 **Publish**

### Article Title
```
Nova Kernel: An Open-Source AI Operating System That Runs at $0/mo by Routing Through Your IDE Subscriptions
```

### Cover Image
`D:\claude\nova-kernel\assets\banner.png`

### Tags (4 tags max)
`opensource` `ai` `mcp` `productivity`

### Article Body (paste below)

```markdown
**TL;DR:** I open-sourced [Nova Kernel](https://github.com/yuyaning-engineer/nova-kernel) — a constitutional AI operating system that orchestrates Claude, GPT, Gemini and Codex as one team. Shared memory, shared skills, shared agents. Routes every task through your existing IDE subscriptions (Antigravity, ChatGPT) so multi-model collaboration costs **$0 in API spend**.

---

## The problem nobody talks about

Today's AI tools — Claude Code, Codex CLI, Cursor, Continue, Antigravity, raw API calls — each live in their own silo. Same machine, same project, **but every tool starts from zero each session**:

- The preference you taught Claude doesn't carry to Codex
- The skill you wrote in Cursor isn't visible to Antigravity
- The bug Codex fixed yesterday gets hit again by Claude tomorrow

You pay 4 different subscriptions. You re-explain the project 4 times a week. You're losing knowledge nobody chose to lose.

## What if your AIs shared one OS?

That's Nova Kernel. A single source of truth for memory + skills + agents, with automatic <10ms projection to all the AI tools you use:

```
Write to memory once
        │
        ├──▶ ~/.claude/                — Claude Code reads
        ├──▶ ~/.codex/AGENTS.md        — Codex CLI reads
        ├──▶ ./AGENTS.md               — Cursor / Continue read
        └──▶ ./GEMINI.md               — Antigravity reads
```

## The unfair advantage: $0 marginal cost

Most agent frameworks assume per-token API spend. Nova flips that — it routes every task through whichever IDE subscription you already pay for:

| Worker | Best at | Routed via | Your cost |
|---|---|---|---|
| Claude Sonnet 4.6 | Code reasoning | ag-bridge :11435 | $0 (Antigravity sub) |
| Claude Opus 4.6 Thinking | Deep planning | ag-bridge | $0 (Antigravity sub) |
| Gemini 3.1 Pro High | Long-context | direct API | $0 (free tier) |
| Gemini 3 Flash | Classification | direct API | $0 (free tier) |
| GPT-5 / Codex | Code review | Codex CLI | $0 (ChatGPT sub) |
| Local bge-m3 | Embeddings | Ollama | $0 (local) |

When you don't have a subscription tier, Nova gracefully falls back. Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` if you want it as last resort.

## Driver Claude orchestrates the team

```
You: "fix the auth bug, then verify with tests"
                       │
                       ▼
Driver Claude (the one you're talking to)
   ├─ writes the patch        →  Sonnet 4.6 (free, via ag-bridge)
   ├─ deep-thinks edge cases  →  Opus 4.6 Thinking (free)
   ├─ runs npm test           →  Codex CLI (free, via ChatGPT sub)
   ├─ summarizes outcome      →  Gemini Flash (free tier)
   └─ writes lesson learned   →  memory (local)
                       │
                       ▼
              Net cost: $0
```

## 6 closed loops that run automatically

1. **Task Identification** — `nova_task_plan(intent)` returns matching skills/agents/warnings before you even start
2. **Execution Telemetry** — every agent call writes feedback memory (failure 100% / success 12.5% sampled)
3. **Skill Distillation** — 6h cron clusters recent feedback → LLM extracts as skill proposal
4. **External Discovery** — 24h cron checks npm versions + LLM rates skill freshness
5. **Constitutional Council** — 3-vote async council (Opus + Gemini Pro + Sonnet) → user approval
6. **4-Way Projection** — <10ms sync to all your AI tools

Plus 8 self-maintenance crons running in the background: arch-snapshot, gap-detector, daily-digest, connector probes, kernel-watch, skill-miner, memory-hygiene, external-scout.

## "Constitutional"?

The system enforces **AI cannot rewrite its own rules**. `kernel/constitutional.json` and `kernel/utils/l3-gate.mjs` are L0 hard-locked — any AI write attempt is rejected at the kernel level. To change them, an AI must submit a `proposal` → 3-vote council → human final approval.

This isn't theater. The same gate that prevents AI from "deciding it doesn't need the gate anymore" is the foundation of trust. **Self-evolving, but not self-emancipating.**

## Try it

```bash
git clone https://github.com/yuyaning-engineer/nova-kernel.git
cd nova-kernel
npm install
cp .env.example .env       # set GEMINI_API_KEY (free tier works)
npm start
# kernel listening on http://127.0.0.1:3700
```

Add to your MCP client config (Claude Desktop, Codex, etc.):

```json
{
  "mcpServers": {
    "nova": {
      "command": "node",
      "args": ["/path/to/nova-kernel/bin/nova-mcp.mjs"]
    }
  }
}
```

41 MCP tools become available: `nova_health`, `nova_task_plan`, `nova_memory_write`, `nova_council_submit`, `nova_scout_external`, ...

## What's next

- v0.2: Web UI for memory browsing + council voting
- Postgres backend (alternative to JSONL for >100k entries)
- More connector manifests (community-driven)
- Multi-user / team mode

## Acknowledgments

Bootstrapped end-to-end with Driver Claude (Sonnet 4.6) on a 2× RTX 5080 + 64GB Win11 workstation. Built and reviewed in collaboration with Claude Opus 4.6 Thinking, Gemini 3.1 Pro High, and Codex CLI — **the same team Nova orchestrates**.

⭐ if you want a self-evolving AI OS that doesn't lock you in: https://github.com/yuyaning-engineer/nova-kernel

Apache 2.0. Node 20+. Works on Windows / Linux / macOS.
```

---

## 2️⃣ Hacker News (3 分钟)

### 步骤
1. 打开 https://news.ycombinator.com/login
2. 已登录的话直接 → https://news.ycombinator.com/submit
3. 复制下面 **Title** 到 title 栏
4. 复制下面 **URL** 到 url 栏（**留 text 栏空**，HN 偏好 link 类提交）
5. 点 Submit
6. **重要**：发完立刻去 https://news.ycombinator.com/newest 找你的帖子，用 alt account / 朋友账号 给个 upvote 进入排序池

### Title
```
Show HN: Nova Kernel – Multi-AI orchestration at $0 marginal cost via IDE subs
```

### URL
```
https://github.com/yuyaning-engineer/nova-kernel
```

### 注意（HN 新账号）
- 新账号 HN 直接 Show HN 通常 OK
- 帖子被埋 → 帖子页底部加一条**评论**自我介绍：
  ```
  Author here. Nova came from frustration that Claude/Codex/Cursor/Antigravity all live in silos
  on the same machine. The big surprise was realizing my Antigravity sub already pays for
  Claude Sonnet/Opus/Gemini — I just needed routing.
  
  Routes via:
  - ag-bridge :11435 (Antigravity sub) → Claude Sonnet/Opus, Gemini Pro
  - Codex CLI (ChatGPT sub) → GPT-5
  - Local Ollama → bge-m3 embeddings
  
  Constitutional layer: AI can propose changes to itself but must go through 3-vote council
  + human approval. Self-evolving but not self-emancipating.
  
  Happy to answer questions.
  ```

---

## 3️⃣ Reddit 套餐（5 分钟，3 个 sub）

### 步骤
1. 打开 https://reddit.com/login，用 Google 登录（最快）
2. 完成 account 设置后，**按下面顺序**发到 3 个 sub（**间隔 30 分钟**避免反 spam）

### r/LocalLLaMA（530k，最匹配）
**URL**: https://www.reddit.com/r/LocalLLaMA/submit
**Title**:
```
[Project] Nova Kernel — share memory/skills/agents across Claude, Codex, Cursor, Antigravity. $0 marginal LLM cost via existing IDE subs.
```
**Type**: Link
**URL**: `https://github.com/yuyaning-engineer/nova-kernel`

发完去帖子底部加评论：
```
Hey r/LocalLLaMA — author here. The "$0 cost" claim assumes you already have:
- Antigravity IDE sub (gets you Claude Sonnet/Opus + Gemini Pro via ag-bridge :11435)
- ChatGPT sub (gets you GPT-5 via Codex CLI)
- Local Ollama (free embeddings via bge-m3)

If you don't, Nova falls back to whatever API keys you set. The novel part is the
**routing layer + shared memory** — your AIs stop starting from zero each session.

13 promoted skills out of the box, 7 agents, 8 self-maintenance crons. Apache 2.0.
Built end-to-end on 2x RTX 5080 + Win11.

Roast it.
```

### r/MachineLearning（3M，更严格的 mod）
**URL**: https://www.reddit.com/r/MachineLearning/submit
**Title**:
```
[P] Nova Kernel: A constitutional AI OS for cross-model memory, skills, and agents
```
**Note**: r/ML 必须用 `[P]` 标签开头才不被 mod 删
**URL**: same

### r/selfhosted（300k，自托管粉丝喜欢）
**URL**: https://www.reddit.com/r/selfhosted/submit
**Title**:
```
Nova Kernel: self-hosted "AI OS" that orchestrates your local + sub-based LLMs as one team
```
**URL**: same

---

## 4️⃣ X / Twitter — ✅ 已自动完成

- ✅ Bio + Display name + Website
- ✅ 3-tweet thread published (核心 hook + cost + memory)
- ✅ Tweet 1 pinned

### 还需要你手动 (30 秒)
1. 打开 https://x.com/settings/profile
2. 点头像旁的 + → 上传 `D:\claude\nova-kernel\assets\avatar.png`
3. 点 banner 区域 → 上传 `D:\claude\nova-kernel\assets\banner.png`
4. 点 Save

### 后续 thread 加推（这周慢慢发，避免新号限流）
- Tweet 4 (skills): "Skills auto-distill from feedback. Every 6h..."
- Tweet 5 (telemetry): "Agent telemetry feeds back automatically..."
- Tweet 6 (CTA + thanks): "Built with the same team it orchestrates..."

完整 6 条文案见 `D:\claude\nova-kernel\docs\twitter-thread.md`（如果你想我现在写也可以）

---

## 5️⃣ GitHub 头像（2 分钟）— ✅ 已完成

✅ 已通过 Chrome 上传到 https://github.com/settings/profile
（avatar 已在 GitHub profile 显示）

---

## 6️⃣ Awesome List PRs（10 分钟，被动长尾流量）

这些 awesome list 加你的项目，长尾流量很稳。每个一行 PR：

| List | 加在 |
|------|-----|
| https://github.com/punkpeye/awesome-mcp-servers | "Frameworks" 节 |
| https://github.com/hesreallyhim/awesome-claude-code | "Tools / Frameworks" 节 |
| https://github.com/e2b-dev/awesome-ai-agents | "Frameworks" 节 |
| https://github.com/Hannibal046/Awesome-LLM | "Tools" 节 |

PR description 模板：
```
Add Nova Kernel — constitutional AI OS that orchestrates Claude/GPT/Gemini/Codex
through shared memory + skills + agents. Routes via existing IDE subs ($0 API cost).
13 skills, 7 agents, 8 crons, MCP-native, Apache 2.0.
```

需要我帮你跑这 4 个 PR 吗？只需要你说"跑 awesome PR"。

---

## 监控（我自动做的，你不用管）

我每天爬：
- ⭐ star 增量
- 💬 HN/Reddit 评论 → 草拟回复 → 排队等你审
- 📊 traffic 来源
- 🐛 issue + discussions

每周一早上 9 点你会收到一份运营周报记忆。

---

## ⏱ 总时间预算

| 任务 | 你的时间 | 我的时间 |
|------|---------|---------|
| Dev.to login + 发文 | 5 min | 文案已写好 |
| HN submit | 2 min | 文案已写好 |
| Reddit ×3 sub | 5 min | 文案已写好 |
| X 头像/banner 上传 | 30 sec | 已生成 |
| Awesome lists ×4 | 0 min | 我可全自动 |
| **合计** | **~12 min 一次性** | 之后我每天监控 |

**Ready when you are.**
