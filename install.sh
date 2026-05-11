#!/usr/bin/env bash
set -euo pipefail

BASE="https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main"
DIR="${SSH_OPS_DIR:-$HOME/.ssh-ops}"
CODEX_PLUGINS="${CODEX_PLUGINS_DIR:-$HOME/.codex/plugins}"
OS="$(uname -s)"

bold=$(tput bold 2>/dev/null || true)
green=$(tput setaf 2 2>/dev/null || true)
yellow=$(tput setaf 3 2>/dev/null || true)
reset=$(tput sgr0 2>/dev/null || true)

step() { echo "${bold}==> $*${reset}"; }
ok()   { echo "${green}✓  $*${reset}"; }
warn() { echo "${yellow}!  $*${reset}"; }
has()  { command -v "$1" >/dev/null 2>&1; }

# ── Dependencies ──────────────────────────────────────────────────────────────

step "Checking dependencies"

# curl (bootstrap dep — if missing we can't do anything)
if ! has curl; then
  echo "Error: curl not found. Install it and retry." >&2; exit 1
fi

# Node.js
if ! has node; then
  warn "node not found — installing via nvm"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # shellcheck disable=SC1090
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
  nvm install --lts --no-progress
  ok "Node.js $(node --version) installed via nvm"
else
  ok "node $(node --version)"
fi

# Claude Code CLI
if ! has claude; then
  warn "claude CLI not found — installing via npm"
  npm install -g @anthropic-ai/claude-code --quiet
  ok "claude CLI installed"
else
  ok "claude $(claude --version 2>/dev/null | head -1 || echo '')"
fi

# ── Download files ─────────────────────────────────────────────────────────────

step "Installing SSH Ops to $DIR"
mkdir -p "$DIR/scripts" "$DIR/.codex-plugin" "$DIR/skills/ssh-ops"

fetch() { curl -fsSL "$BASE/$1" -o "$DIR/$1"; }

fetch scripts/ssh-mcp-server.mjs
fetch scripts/ssh-core.mjs
fetch scripts/ssh-ops.mjs
fetch scripts/ssh-cli-options.mjs
fetch ssh-ops.config.example.yaml
fetch .codex-plugin/plugin.json
fetch skills/ssh-ops/SKILL.md

ok "Files downloaded"

# ── Claude Code ────────────────────────────────────────────────────────────────

step "Registering MCP server with Claude Code"
if claude mcp add ssh-ops node "$DIR/scripts/ssh-mcp-server.mjs" 2>/dev/null; then
  ok "Registered ssh-ops"
else
  warn "Already registered. Re-register manually:"
  echo "     claude mcp remove ssh-ops && claude mcp add ssh-ops node \"$DIR/scripts/ssh-mcp-server.mjs\""
fi

# ── Codex ──────────────────────────────────────────────────────────────────────

step "Setting up Codex"
if has codex || [ -d "$CODEX_PLUGINS" ]; then
  mkdir -p "$CODEX_PLUGINS"
  ln -sfn "$DIR" "$CODEX_PLUGINS/ssh-ops"
  ok "Plugin linked at $CODEX_PLUGINS/ssh-ops"
else
  warn "Codex not detected — skipping. Link manually:"
  echo "     ln -sfn \"$DIR\" <codex-plugins-dir>/ssh-ops"
fi

# ── Config ─────────────────────────────────────────────────────────────────────

step "Creating config"
if [ ! -f "$DIR/ssh-ops.config.yaml" ]; then
  cp "$DIR/ssh-ops.config.example.yaml" "$DIR/ssh-ops.config.yaml"
  ok "Created $DIR/ssh-ops.config.yaml — edit it to add your server profiles"
else
  ok "Config unchanged at $DIR/ssh-ops.config.yaml"
fi

echo ""
echo "${bold}Done.${reset} Restart Claude Code or Codex to activate ssh-ops."
