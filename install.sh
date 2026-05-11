#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/rushikeshsakharleofficial/ssh-ops-mcp.git"

# Default install dir: macOS uses ~/Library/Application Support, Linux uses ~/.local/share
if [ -z "${SSH_OPS_DIR:-}" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    INSTALL_DIR="$HOME/Library/Application Support/ssh-ops-mcp"
  else
    INSTALL_DIR="$HOME/.local/share/ssh-ops-mcp"
  fi
else
  INSTALL_DIR="$SSH_OPS_DIR"
fi

CODEX_PLUGINS_DIR="${CODEX_PLUGINS_DIR:-$HOME/.codex/plugins}"

bold=$(tput bold 2>/dev/null || true)
green=$(tput setaf 2 2>/dev/null || true)
yellow=$(tput setaf 3 2>/dev/null || true)
reset=$(tput sgr0 2>/dev/null || true)

step() { echo "${bold}==> $*${reset}"; }
ok()   { echo "${green}✓  $*${reset}"; }
warn() { echo "${yellow}!  $*${reset}"; }

# Prerequisites
for bin in git node; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Error: $bin not found. Install it and retry." >&2
    exit 1
  fi
done

# Clone or update
step "Installing SSH Ops to $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only --quiet
  ok "Updated existing installation"
else
  git clone --quiet "$REPO" "$INSTALL_DIR"
  ok "Cloned repository"
fi

# Claude Code
step "Setting up Claude Code"
if command -v claude >/dev/null 2>&1; then
  if claude mcp add ssh-ops node "$INSTALL_DIR/scripts/ssh-mcp-server.mjs" 2>/dev/null; then
    ok "MCP server registered with Claude Code"
  else
    warn "Already registered or failed. Re-run manually:"
    echo "     claude mcp add ssh-ops node $INSTALL_DIR/scripts/ssh-mcp-server.mjs"
  fi
else
  warn "claude CLI not found — skipping. Register manually after installing Claude Code:"
  echo "     claude mcp add ssh-ops node $INSTALL_DIR/scripts/ssh-mcp-server.mjs"
fi

# Codex
step "Setting up Codex"
if command -v codex >/dev/null 2>&1 || [ -d "$CODEX_PLUGINS_DIR" ]; then
  mkdir -p "$CODEX_PLUGINS_DIR"
  ln -sfn "$INSTALL_DIR" "$CODEX_PLUGINS_DIR/ssh-ops"
  ok "Plugin symlinked at $CODEX_PLUGINS_DIR/ssh-ops"
else
  warn "Codex plugins directory not found — skipping. Symlink manually:"
  echo "     ln -sfn $INSTALL_DIR <your-codex-plugins-dir>/ssh-ops"
fi

# Config
step "Creating config"
if [ ! -f "$INSTALL_DIR/ssh-ops.config.yaml" ]; then
  cp "$INSTALL_DIR/ssh-ops.config.example.yaml" "$INSTALL_DIR/ssh-ops.config.yaml"
  ok "Created $INSTALL_DIR/ssh-ops.config.yaml — edit it to add your server profiles"
else
  ok "Config already exists at $INSTALL_DIR/ssh-ops.config.yaml"
fi

echo ""
echo "${bold}Done.${reset} Restart Claude Code or Codex to activate the ssh-ops tools."
