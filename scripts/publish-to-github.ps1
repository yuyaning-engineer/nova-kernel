# scripts/publish-to-github.ps1
# Windows PowerShell version of the GitHub publish helper.
#
# Usage:
#   .\scripts\publish-to-github.ps1 -Username yourname -Repo nova-kernel -Public
#
# Prereqs:
#   winget install Git.Git
#   winget install GitHub.cli
#   gh auth login

param(
  [Parameter(Mandatory=$true)][string]$Username,
  [Parameter(Mandatory=$true)][string]$Repo,
  [switch]$Public,
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "Missing $cmd. $hint" -ForegroundColor Red
    exit 1
  }
}

Write-Host "==> Checking prerequisites" -ForegroundColor Cyan
Need 'git' 'winget install Git.Git'
Need 'gh'  'winget install GitHub.cli'

Write-Host "==> Checking gh auth status"
gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "Run: gh auth login" -ForegroundColor Red; exit 1 }

Write-Host "==> Checking git config"
$gitName  = git config --global user.name
$gitEmail = git config --global user.email
if (-not $gitName)  { $name  = Read-Host "Git user.name";  git config --global user.name $name }
if (-not $gitEmail) { $email = Read-Host "Git user.email"; git config --global user.email $email }

Write-Host "==> Initializing repo (if needed)"
if (-not (Test-Path .git)) {
  git init
  git branch -M main
}

Write-Host "==> Safety audit — sensitive files"
$bad = Get-ChildItem -Recurse -Force -ErrorAction SilentlyContinue -Include "*.jsonl","*.db",".env" |
       Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.git\\' } |
       Select-Object -First 5
if ($bad) {
  Write-Host "❌ Sensitive files found (.gitignore should exclude these):" -ForegroundColor Yellow
  $bad | ForEach-Object { Write-Host "  $_" }
  $ans = Read-Host "Continue anyway? (y/N)"
  if ($ans -ne 'y') { exit 1 }
}

Write-Host "==> Patching package.json with your repo URL"
$pkg = Get-Content package.json -Raw
$pkg = $pkg -replace 'CHANGEME/nova-kernel',"$Username/$Repo"
Set-Content -Path package.json -Value $pkg -Encoding UTF8

$visibility = if ($Private) { '--private' } else { '--public' }
Write-Host "==> Creating GitHub repo: $Username/$Repo ($visibility)" -ForegroundColor Green
gh repo create "$Username/$Repo" $visibility `
  --description "The Constitutional AI Operating System — one memory, one skill library, one agent registry, shared across Claude / Codex / Gemini / Cursor / Antigravity." `
  --homepage "https://github.com/$Username/$Repo" `
  --source=. `
  --remote=origin `
  --push=$false

Write-Host "==> Staging files"
git add -A

Write-Host "==> Commit"
$msg = @"
Initial commit: Nova Kernel v0.1.0

The Constitutional AI Operating System.

- Append-only memory + 4-way projection (Claude/Codex/Cursor/Antigravity)
- Skill lifecycle: feedback -> miner -> council -> promotion
- 7 agents (1 internal example + extensible registry)
- 8 self-maintenance crons
- Constitutional risk gate (L0-L3) on every mutation
- 41 MCP tools for any AI client
- Cross-model uniform LLM call layer

Bootstrapped with Driver Claude (Sonnet 4.6).
"@
git commit -m $msg

Write-Host "==> Pushing"
git push -u origin main

Write-Host ""
Write-Host "✅ Done! Repository:" -ForegroundColor Green
Write-Host "   https://github.com/$Username/$Repo"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  - Add topics: ai, agent, memory, mcp, claude, gemini, codex, cursor"
Write-Host "  - Enable Issues / Discussions"
Write-Host "  - Write a launch blog / Twitter post"
