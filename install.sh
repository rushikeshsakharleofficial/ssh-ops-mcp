#!/usr/bin/env bash
set -euo pipefail

BASE="https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main"
DIR="${SSH_OPS_DIR:-$HOME/.ssh-ops}"
CODEX_PLUGINS="${CODEX_PLUGINS_DIR:-$HOME/.codex/plugins}"
FORCE_SETUP=false
for _arg in "$@"; do [ "$_arg" = "--setup" ] && FORCE_SETUP=true; done

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

if ! has sshpass; then
  warn "sshpass not found — password-based SSH profiles will not work"
  info "Install: apt install sshpass  /  brew install sshpass  /  yum install sshpass"
else
  ok "sshpass $(sshpass -V 2>&1 | head -1 || true)"
fi

# ── Download files ─────────────────────────────────────────────────────────────

step "Installing SSH Ops to $DIR"
mkdir -p "$DIR/scripts" "$DIR/.codex-plugin" "$DIR/skills/ssh-ops/agents"

fetch() { curl -fsSL "$BASE/$1" -o "$DIR/$1"; }
fetch VERSION
fetch scripts/ssh-mcp-server.mjs
fetch scripts/ssh-core.mjs
fetch scripts/ssh-ops.mjs
fetch scripts/ssh-cli-options.mjs
fetch ssh-ops.config.example.yaml
fetch .codex-plugin/plugin.json
fetch skills/ssh-ops/SKILL.md
fetch skills/ssh-ops/agents/openai.yaml
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

# ── Claude Code skill plugin ───────────────────────────────────────────────────

step "Claude Code skill plugin"
CLAUDE_PLUGINS="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}"
PLUGIN_CACHE="$CLAUDE_PLUGINS/cache/rushikeshsakharleofficial/ssh-ops/latest"
INSTALLED_JSON="$CLAUDE_PLUGINS/installed_plugins.json"

if [ -d "$CLAUDE_PLUGINS" ]; then
  mkdir -p "$PLUGIN_CACHE/skills/ssh-ops"

  # CLAUDE.md — skill instructions loaded by Claude Code
  cat > "$PLUGIN_CACHE/CLAUDE.md" << 'CLAUDEMD'
# SSH Ops Skill

Use the `ssh-ops` skill when the user wants to connect to remote SSH servers, run commands, manage files, check health/disk/logs, assign IPs, or manage server profiles and jump chains.

## Available Skills
- `ssh-ops:ssh-ops` — full SSH Ops tool reference and usage guidance
CLAUDEMD

  # gemini-extension.json — loaded by Gemini CLI
  VERSION_TAG=$(cat "$DIR/VERSION" 2>/dev/null || echo "latest")
  cat > "$PLUGIN_CACHE/gemini-extension.json" << GEMEXT
{
  "name": "ssh-ops",
  "description": "24 SSH tools for remote Linux server ops — inventory, health, disk, files, services, packages, cron, IP assignment, jump chains, and dynamic profile management.",
  "version": "$VERSION_TAG",
  "contextFileName": "GEMINI.md"
}
GEMEXT

  # GEMINI.md — loaded by Gemini CLI
  cat > "$PLUGIN_CACHE/GEMINI.md" << 'GEMINIMD'
@./skills/ssh-ops/SKILL.md
GEMINIMD

  # Copy SKILL.md into plugin
  cp "$DIR/skills/ssh-ops/SKILL.md" "$PLUGIN_CACHE/skills/ssh-ops/SKILL.md"

  # Register in installed_plugins.json
  if [ -f "$INSTALLED_JSON" ]; then
    node -e "
      const fs = require('fs');
      const f = '$INSTALLED_JSON';
      let d = {};
      try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) {}
      d.version = d.version || 2;
      d.plugins = d.plugins || {};
      const key = 'ssh-ops@rushikeshsakharleofficial';
      const entry = {
        scope: 'user',
        installPath: '$PLUGIN_CACHE',
        version: '$(cat "$DIR/VERSION" 2>/dev/null || echo latest)',
        installedAt: d.plugins[key]?.[0]?.installedAt || new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      };
      d.plugins[key] = [entry];
      fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
    " 2>/dev/null && ok "Registered skill plugin (Claude Code + Gemini)" \
      || warn "Could not update installed_plugins.json — restart Claude to load skill"
  else
    ok "Skill files installed at $PLUGIN_CACHE"
    info "Restart Claude Code to activate the ssh-ops skill"
  fi
else
  skip "~/.claude not found — skipping skill plugin"
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
CFG="$DIR/ssh-ops.config.yaml"

# Determine whether to run the setup wizard:
# 1. --setup flag passed explicitly
# 2. No config exists yet
# 3. Config still contains demo placeholder data
_run_setup=false
if $FORCE_SETUP; then
  _run_setup=true
elif [ ! -f "$CFG" ]; then
  cp "$DIR/ssh-ops.config.example.yaml" "$CFG"
  _run_setup=true
elif grep -q "server\.example\.com" "$CFG" 2>/dev/null; then
  warn "Config still contains demo data — running setup"
  _run_setup=true
fi

# ── Connection test helper ─────────────────────────────────────────────────────
_test_conn() {
  # Usage: _test_conn host user port [password] [identityFile] [jumpHost] [jumpUserLogin]
  local _h="$1" _u="$2" _p="$3" _pw="${4:-}" _id="${5:-}" _jh="${6:-}" _ju="${7:-}"
  local _opts="-o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
  [ "$_p" != "22" ] && _opts="$_opts -p $_p"
  [ -n "$_id" ]     && _opts="$_opts -i $_id"
  [ -n "$_jh" ]     && _opts="$_opts -J ${_ju:+${_ju}@}$_jh"
  if [ -n "$_pw" ] && has sshpass; then
    SSHPASS="$_pw" sshpass -e ssh $_opts "$_u@$_h" exit 2>/dev/null
  else
    ssh $_opts "$_u@$_h" exit 2>/dev/null
  fi
}

# ── Setup wizard ───────────────────────────────────────────────────────────────
if $_run_setup; then
  if [ ! -t 0 ]; then
    info "Non-interactive install — edit $CFG to add your server profiles"
  else
    echo
    info "Server setup (Enter to skip any field, Ctrl+C to cancel)"
    echo

    printf "  Server host or IP: "; read -r _host
    if [ -z "$_host" ]; then
      info "Skipped — edit $CFG to add your server profiles"
    else
      printf "  SSH user [root]: "; read -r _user; _user="${_user:-root}"
      printf "  SSH port [22]: "; read -r _port; _port="${_port:-22}"
      printf "  Profile name [server1]: "; read -r _pname; _pname="${_pname:-server1}"
      printf "  SSH identity file (leave blank for default key): "; read -r _idfile
      printf "  SSH password (leave blank for key auth): "; read -rs _password; echo

      # Jump server
      printf "  Route through jump/bastion server? [y/N]: "; read -r _usejump
      _jump_block="" _jump_ref="" _jhost="" _jpname="" _juser="" _jumpuser="" _jtest_host=""
      if echo "$_usejump" | grep -qi "^y"; then
        printf "  Jump host or IP: "; read -r _jhost
        printf "  Jump SSH user [$USER]: "; read -r _juser; _juser="${_juser:-$USER}"
        printf "  Switch to user on jump server (blank = no switch): "; read -r _jumpuser
        printf "  Jump profile name [bastion]: "; read -r _jpname; _jpname="${_jpname:-bastion}"
        _jump_block="
  $_jpname:
    host: $_jhost
    user: $_juser"
        _jump_ref="
    jumpProfile: $_jpname"
        [ -n "$_jumpuser" ] && _jump_ref="${_jump_ref}
    jumpUser: $_jumpuser"
        _jtest_host="$_jhost"
      fi

      # ── Test connection ──────────────────────────────────────────────────────
      echo
      info "Testing connection..."
      _conn_ok=false
      _retry=true
      while $_retry; do
        _retry=false
        if [ -n "$_jtest_host" ]; then
          printf "  Connecting to jump server %s... " "$_jhost"
          if _test_conn "$_jhost" "$_juser" "22" "" "$_idfile"; then
            echo "${green}OK${reset}"
            printf "  Connecting to target %s via jump... " "$_host"
            if _test_conn "$_host" "$_user" "$_port" "$_password" "$_idfile" "$_jhost" "$_juser"; then
              echo "${green}OK${reset}"
              _conn_ok=true
            else
              echo "${red}FAILED${reset}"
            fi
          else
            echo "${red}FAILED${reset}"
          fi
        else
          printf "  Connecting to %s... " "$_host"
          if _test_conn "$_host" "$_user" "$_port" "$_password" "$_idfile"; then
            echo "${green}OK${reset}"
            _conn_ok=true
          else
            echo "${red}FAILED${reset}"
          fi
        fi

        if ! $_conn_ok; then
          echo
          warn "Connection failed. Options:"
          echo "  1) Retry (check firewall / VPN / key permissions)"
          echo "  2) Try a different identity file"
          echo "  3) Save config anyway (fix later)"
          echo "  4) Abort setup"
          printf "  Choice [1-4]: "; read -r _choice
          case "$_choice" in
            2)
              printf "  Identity file path: "; read -r _idfile
              _retry=true ;;
            3)
              _conn_ok=true ;;  # save regardless
            4)
              info "Setup aborted — edit $CFG manually"
              _host="" ;;
            *)
              _retry=true ;;
          esac
        fi
      done

      # ── Write config (only if we have a host) ───────────────────────────────
      if [ -n "$_host" ]; then
        _default_line=""
        echo "${_default:-}" | grep -qi "^n" || _default_line="defaultTarget: $_pname"
        _id_line=""; [ -n "$_idfile" ] && _id_line="
    identityFile: $_idfile"
        cat > "$CFG" << YMLEOF
${_default_line}
defaults:
  connectTimeoutSec: 12
  strictHostKeyChecking: accept-new
  timeoutMs: 120000
  maxOutputBytes: 2000000
profiles:
  $_pname:
    host: $_host
    user: $_user
    port: $_port${_id_line}${_jump_ref:-}
${_jump_block:-}
YMLEOF
        if $_conn_ok && [ "$_choice" != "3" ] 2>/dev/null; then
          ok "Config saved and connection verified: $_pname → $_user@$_host${_jhost:+ via $_jpname}"
        else
          ok "Config saved (connection not verified): $_pname → $_user@$_host"
          info "Test manually: ssh $_user@$_host"
        fi
      fi
    fi
  fi
else
  info "Preserved existing $CFG"
fi

# ── Done ───────────────────────────────────────────────────────────────────────

echo
echo "${bold}${green}  ✓  SSH Ops installed successfully.${reset}"
echo "${dim}  Restart Claude Code, Codex, Cursor, VS Code, Gemini, or Antigravity to activate.${reset}"
echo
