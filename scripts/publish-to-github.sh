#!/usr/bin/env bash
# scripts/publish-to-github.sh
# 一键把 nova-kernel/ 推到你的 GitHub 仓库.
#
# 用法:
#   bash scripts/publish-to-github.sh <github-username> <repo-name> [--public|--private]
# 例:
#   bash scripts/publish-to-github.sh yourname nova-kernel --public
#
# 需要先安装 + 登录 gh:
#   winget install GitHub.cli  (Windows)
#   brew install gh             (macOS)
#   sudo apt install gh         (Ubuntu)
#   gh auth login

set -e

USERNAME="${1:?用法: bash $0 <github-username> <repo-name> [--public|--private]}"
REPO="${2:?用法: bash $0 <github-username> <repo-name> [--public|--private]}"
VISIBILITY="${3:---public}"

echo "==> 检查 git + gh 安装"
command -v git >/dev/null || { echo "需要 git. winget install Git.Git"; exit 1; }
command -v gh  >/dev/null || { echo "需要 gh.  winget install GitHub.cli"; exit 1; }

echo "==> 检查 gh 登录状态"
gh auth status >/dev/null 2>&1 || { echo "请先运行: gh auth login"; exit 1; }

echo "==> 检查 git config"
if [[ -z "$(git config --global user.name)" ]]; then
  read -p "Git user.name: " NAME
  git config --global user.name "$NAME"
fi
if [[ -z "$(git config --global user.email)" ]]; then
  read -p "Git user.email: " EMAIL
  git config --global user.email "$EMAIL"
fi

echo "==> 初始化 git 仓库"
if [[ ! -d .git ]]; then
  git init
  git branch -M main
fi

echo "==> 安全审计 — 确认没有 jsonl/db/secret"
PROBLEMS=$(find . -type f \( -name "*.jsonl" -o -name "*.db" -o -name ".env" \) -not -path "./node_modules/*" -not -path "./.git/*" 2>/dev/null | head)
if [[ -n "$PROBLEMS" ]]; then
  echo "❌ 发现敏感文件 — .gitignore 应该已经排除, 但还是确认下:"
  echo "$PROBLEMS"
  read -p "继续? (y/N) " ANS
  [[ "$ANS" != "y" && "$ANS" != "Y" ]] && exit 1
fi

echo "==> 写入 package.json 仓库 URL"
sed -i.bak "s|CHANGEME/nova-kernel|$USERNAME/$REPO|g" package.json && rm package.json.bak

echo "==> 创建 GitHub 仓库: $USERNAME/$REPO ($VISIBILITY)"
gh repo create "$USERNAME/$REPO" $VISIBILITY \
  --description "The Constitutional AI Operating System — one memory, one skill library, one agent registry, shared across Claude / Codex / Gemini / Cursor / Antigravity." \
  --homepage "https://github.com/$USERNAME/$REPO" \
  --source=. \
  --remote=origin \
  --push=false

echo "==> 暂存所有文件"
git add -A

echo "==> 提交"
git commit -m "Initial commit: Nova Kernel v0.1.0

The Constitutional AI Operating System.

- Append-only memory + 4-way projection (Claude/Codex/Cursor/Antigravity)
- Skill lifecycle: feedback → miner → council → promotion
- 7 agents (1 internal example + extensible registry)
- 8 self-maintenance crons (snapshot, gap-detect, hygiene, scout...)
- Constitutional risk gate (L0-L3) on every mutation
- 41 MCP tools for any AI client
- Cross-model uniform LLM call layer (utils/llm.mjs)

🤖 Bootstrapped with Driver Claude (Sonnet 4.6)"

echo "==> 推送"
git push -u origin main

echo ""
echo "✅ 完成! 仓库地址:"
echo "   https://github.com/$USERNAME/$REPO"
echo ""
echo "下一步:"
echo "  · 加 Topics: ai, agent, memory, mcp, claude, gemini, codex, cursor"
echo "  · 启用 Issues / Discussions"
echo "  · 写一篇博客/Twitter介绍"
