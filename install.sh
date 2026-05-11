#!/usr/bin/env bash
set -euo pipefail

BASE="https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main"
DIR="${SSH_OPS_DIR:-$HOME/.ssh-ops}"
CODEX_PLUGINS="${CODEX_PLUGINS_DIR:-$HOME/.codex/plugins}"

bold=$(tput bold 2>/dev/null || true)
green=$(tput setaf 2 2>/dev/null || true)
yellow=$(tput setaf 3 2>/dev/null || true)
reset=$(tput sgr0 2>/dev/null || true)

step() { echo "${bold}==> $*${reset}"; }
ok()   { echo "${green}✓  $*${reset}"; }
warn() { echo "${yellow}-  $*${reset}"; }
has()  { command -v "$1" >/dev/null 2>&1; }

# ── Dependencies ──────────────────────────────────────────────────────────────

step "Checking dependencies"

if ! has curl; then
  echo "Error: curl not found. Install it and retry." >&2; exit 1
fi

if ! has node; then
  warn "node not found — installing via nvm"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
  nvm install --lts --no-progress
  ok "Node.js $(node --version) installed"
else
  ok "node $(node --version)"
fi

if ! has claude; then
  warn "claude CLI not found — installing"
  npm install -g @anthropic-ai/claude-code --quiet
  ok "claude CLI installed"
else
  ok "claude $(claude --version 2>/dev/null | head -1 || true)"
fi

# ── Download files ─────────────────────────────────────────────────────────────

step "Installing SSH Ops to $DIR"
mkdir -p "$DIR/scripts" "$DIR/.codex-plugin" "$DIR/skills/ssh-ops"

fetch() { curl -fsSL "$BASE/$1" -o "$DIR/$1"; }
fetch VERSION
fetch scripts/ssh-mcp-server.mjs
fetch scripts/ssh-core.mjs
fetch scripts/ssh-ops.mjs
fetch scripts/ssh-cli-options.mjs
fetch ssh-ops.config.example.yaml
fetch .codex-plugin/plugin.json
fetch skills/ssh-ops/SKILL.md
ok "Files downloaded"

# ── Helper: merge MCP server into a JSON config file ──────────────────────────
# Usage: add_mcp <file> [vscode]
# vscode flag uses { mcp.servers } structure instead of { mcpServers }
add_mcp() {
  local file="$1" mode="${2:-standard}"
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || echo '{}' > "$file"
  MCP_FILE="$file" MCP_NAME="ssh-ops" MCP_CMD="node" \
  MCP_ARG="$DIR/scripts/ssh-mcp-server.mjs" MCP_MODE="$mode" \
  node -e "
    const fs = require('fs');
    const { MCP_FILE: f, MCP_NAME: n, MCP_CMD: c, MCP_ARG: a, MCP_MODE: m } = process.env;
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) {}
    if (m === 'vscode') {
      cfg.mcp = cfg.mcp || {};
      cfg.mcp.servers = cfg.mcp.servers || {};
      cfg.mcp.servers[n] = { type: 'stdio', command: c, args: [a] };
    } else {
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers[n] = { command: c, args: [a] };
    }
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  "
}

# ── Claude Code ────────────────────────────────────────────────────────────────

step "Claude Code"
if claude mcp add ssh-ops node "$DIR/scripts/ssh-mcp-server.mjs" 2>/dev/null; then
  ok "Registered"
else
  warn "Already registered — re-registering"
  claude mcp remove ssh-ops 2>/dev/null || true
  claude mcp add ssh-ops node "$DIR/scripts/ssh-mcp-server.mjs" 2>/dev/null && ok "Re-registered" || warn "Failed"
fi

# ── Codex ──────────────────────────────────────────────────────────────────────

step "Codex"
if has codex || [ -d "$CODEX_PLUGINS" ]; then
  mkdir -p "$CODEX_PLUGINS"
  ln -sfn "$DIR" "$CODEX_PLUGINS/ssh-ops"
  ok "Linked at $CODEX_PLUGINS/ssh-ops"
else
  warn "Not detected — skipping"
fi

# ── Cursor ─────────────────────────────────────────────────────────────────────

step "Cursor"
if has cursor || [ -d "$HOME/.cursor" ]; then
  add_mcp "$HOME/.cursor/mcp.json"
  ok "Registered in ~/.cursor/mcp.json"
else
  warn "Not detected — skipping"
fi

# ── VS Code Copilot ────────────────────────────────────────────────────────────

step "VS Code Copilot"
if has code || [ -d "$HOME/.config/Code" ] || [ -d "$HOME/Library/Application Support/Code" ]; then
  if [ -d "$HOME/Library/Application Support/Code/User" ]; then
    VSCODE_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
  else
    VSCODE_SETTINGS="$HOME/.config/Code/User/settings.json"
  fi
  add_mcp "$VSCODE_SETTINGS" "vscode"
  ok "Registered in $VSCODE_SETTINGS"
else
  warn "Not detected — skipping"
fi

# ── Gemini CLI ─────────────────────────────────────────────────────────────────

step "Gemini CLI"
if has gemini; then
  gemini mcp remove ssh-ops --scope user 2>/dev/null || true
  gemini mcp add ssh-ops node "$DIR/scripts/ssh-mcp-server.mjs" --scope user 2>/dev/null && \
    ok "Registered (user scope)" || warn "gemini mcp add failed"
else
  warn "Not detected — skipping"
fi

# ── Antigravity IDE ────────────────────────────────────────────────────────────

step "Antigravity IDE"
if [ -d "$HOME/.gemini/antigravity" ] || has antigravity; then
  add_mcp "$HOME/.gemini/antigravity/mcp_config.json"
  ok "Registered in ~/.gemini/antigravity/mcp_config.json"
else
  warn "Not detected — skipping"
fi

# ── Config ─────────────────────────────────────────────────────────────────────

step "Config"
if [ ! -f "$DIR/ssh-ops.config.yaml" ]; then
  cp "$DIR/ssh-ops.config.example.yaml" "$DIR/ssh-ops.config.yaml"
  ok "Created $DIR/ssh-ops.config.yaml — edit it to add your server profiles"
else
  ok "Preserved existing $DIR/ssh-ops.config.yaml"
fi

echo ""
echo "${bold}Done.${reset} Restart Claude Code, Codex, Cursor, or VS Code to activate ssh-ops."
