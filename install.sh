#!/usr/bin/env bash
set -euo pipefail

BASE="https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main"
DIR="${SSH_OPS_DIR:-$HOME/.ssh-ops}"
CODEX_PLUGINS="${CODEX_PLUGINS_DIR:-$HOME/.codex/plugins}"

# ── Colors ────────────────────────────────────────────────────────────────────
bold=$(tput bold   2>/dev/null || true)
cyan=$(tput setaf 6 2>/dev/null || true)
green=$(tput setaf 2 2>/dev/null || true)
yellow=$(tput setaf 3 2>/dev/null || true)
red=$(tput setaf 1  2>/dev/null || true)
blue=$(tput setaf 4 2>/dev/null || true)
dim=$(tput dim      2>/dev/null || true)
reset=$(tput sgr0   2>/dev/null || true)

step() { echo; echo "${bold}${cyan}▶  $*${reset}"; }
ok()   { echo "${green}  ✓  $*${reset}"; }
skip() { echo "${dim}  ·  $*${reset}"; }
warn() { echo "${yellow}  ⚠  $*${reset}"; }
err()  { echo "${red}  ✗  $*${reset}"; }
info() { echo "${blue}  →  $*${reset}"; }
has()  { command -v "$1" >/dev/null 2>&1; }

echo
echo "${bold}${cyan}  SSH Ops Installer${reset}"
echo "${dim}  Installing to: $DIR${reset}"

# ── Dependencies ──────────────────────────────────────────────────────────────

step "Checking dependencies"

if ! has curl; then
  err "curl not found — install it and retry." >&2; exit 1
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

# ── Encryption key ─────────────────────────────────────────────────────────────

step "Encryption key"
KEY_FILE="$DIR/.encryption-key"
if [ -f "$KEY_FILE" ]; then
  skip "Key already exists — preserved"
else
  node -e "
    const { randomBytes } = require('crypto');
    const { writeFileSync, chmodSync } = require('fs');
    const key = randomBytes(32).toString('hex') + '\n';
    writeFileSync('$KEY_FILE', key, { mode: 0o600 });
    try { chmodSync('$KEY_FILE', 0o600); } catch {}
  "
  chmod 600 "$KEY_FILE" 2>/dev/null || true
  ok "Device-specific AES-256-GCM key generated at $KEY_FILE"
fi

# ── Helper: merge MCP server into a JSON config file ──────────────────────────
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
_mcp_target="$DIR/scripts/ssh-mcp-server.mjs"
if claude mcp get ssh-ops 2>/dev/null | grep -qF "$_mcp_target"; then
  ok "Already registered (up-to-date)"
else
  # Remove from all scopes before re-adding to avoid "already exists" errors
  claude mcp remove ssh-ops              2>/dev/null || true
  claude mcp remove ssh-ops -s local    2>/dev/null || true
  claude mcp remove ssh-ops -s user     2>/dev/null || true
  claude mcp remove ssh-ops -s project  2>/dev/null || true
  if claude mcp add ssh-ops node "$_mcp_target" 2>/dev/null; then
    ok "Registered"
  else
    err "Registration failed — run manually: claude mcp add ssh-ops node \"$_mcp_target\""
  fi
fi

# ── Codex ──────────────────────────────────────────────────────────────────────

step "Codex"
if has codex || [ -d "$CODEX_PLUGINS" ]; then
  mkdir -p "$CODEX_PLUGINS"
  _codex_link="$CODEX_PLUGINS/ssh-ops"
  if [ -L "$_codex_link" ] && [ "$(readlink -f "$_codex_link" 2>/dev/null)" = "$(readlink -f "$DIR")" ]; then
    ok "Already linked (up-to-date)"
  else
    ln -sfn "$DIR" "$_codex_link"
    ok "Linked at $_codex_link"
  fi
else
  skip "Not detected — skipping"
fi

# ── Cursor ─────────────────────────────────────────────────────────────────────

step "Cursor"
if has cursor || [ -d "$HOME/.cursor" ]; then
  _cursor_cfg="$HOME/.cursor/mcp.json"
  if [ -f "$_cursor_cfg" ] && grep -qF "$DIR/scripts/ssh-mcp-server.mjs" "$_cursor_cfg" 2>/dev/null; then
    ok "Already registered (up-to-date)"
  else
    add_mcp "$_cursor_cfg"
    ok "Registered in ~/.cursor/mcp.json"
  fi
else
  skip "Not detected — skipping"
fi

# ── VS Code Copilot ────────────────────────────────────────────────────────────

step "VS Code Copilot"
if has code || [ -d "$HOME/.config/Code" ] || [ -d "$HOME/Library/Application Support/Code" ]; then
  if [ -d "$HOME/Library/Application Support/Code/User" ]; then
    VSCODE_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
  else
    VSCODE_SETTINGS="$HOME/.config/Code/User/settings.json"
  fi
  if [ -f "$VSCODE_SETTINGS" ] && grep -qF "$DIR/scripts/ssh-mcp-server.mjs" "$VSCODE_SETTINGS" 2>/dev/null; then
    ok "Already registered (up-to-date)"
  else
    add_mcp "$VSCODE_SETTINGS" "vscode"
    ok "Registered in $VSCODE_SETTINGS"
  fi
else
  skip "Not detected — skipping"
fi

# ── Gemini CLI ─────────────────────────────────────────────────────────────────

step "Gemini CLI"
if has gemini; then
  if gemini mcp list 2>&1 | grep -qF "$DIR/scripts/ssh-mcp-server.mjs"; then
    ok "Already registered (up-to-date)"
  else
    gemini mcp remove ssh-ops --scope user 2>/dev/null || true
    if gemini mcp add ssh-ops node "$DIR/scripts/ssh-mcp-server.mjs" --scope user 2>/dev/null; then
      ok "Registered (user scope)"
    else
      err "gemini mcp add failed"
    fi
  fi
else
  skip "Not detected — skipping"
fi

# ── Antigravity IDE ────────────────────────────────────────────────────────────

step "Antigravity IDE"
if [ -d "$HOME/.gemini/antigravity" ] || has antigravity; then
  _anti_cfg="$HOME/.gemini/antigravity/mcp_config.json"
  if [ -f "$_anti_cfg" ] && grep -qF "$DIR/scripts/ssh-mcp-server.mjs" "$_anti_cfg" 2>/dev/null; then
    ok "Already registered (up-to-date)"
  else
    add_mcp "$_anti_cfg"
    ok "Registered in ~/.gemini/antigravity/mcp_config.json"
  fi
else
  skip "Not detected — skipping"
fi

# ── Config ─────────────────────────────────────────────────────────────────────

step "Config"
if [ ! -f "$DIR/ssh-ops.config.yaml" ]; then
  cp "$DIR/ssh-ops.config.example.yaml" "$DIR/ssh-ops.config.yaml"
  ok "Created $DIR/ssh-ops.config.yaml"
  info "Edit it to add your server profiles"
else
  info "Preserved existing $DIR/ssh-ops.config.yaml"
fi

# ── Done ───────────────────────────────────────────────────────────────────────

echo
echo "${bold}${green}  ✓  SSH Ops installed successfully.${reset}"
echo "${dim}  Restart Claude Code, Codex, Cursor, VS Code, or Gemini to activate.${reset}"
echo
