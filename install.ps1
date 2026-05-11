$ErrorActionPreference = "Stop"

$Base         = "https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main"
$Dir          = if ($env:SSH_OPS_DIR)       { $env:SSH_OPS_DIR }       else { "$env:USERPROFILE\.ssh-ops" }
$CodexPlugins = if ($env:CODEX_PLUGINS_DIR) { $env:CODEX_PLUGINS_DIR } else { "$env:USERPROFILE\.codex\plugins" }

# ── Color helpers ─────────────────────────────────────────────────────────────
function Step($m) { Write-Host; Write-Host "▶  $m" -ForegroundColor Cyan -NoNewline; Write-Host "" }
function Ok($m)   { Write-Host "  ✓  $m" -ForegroundColor Green }
function Skip($m) { Write-Host "  ·  $m" -ForegroundColor DarkGray }
function Warn($m) { Write-Host "  ⚠  $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "  ✗  $m" -ForegroundColor Red }
function Info($m) { Write-Host "  →  $m" -ForegroundColor Blue }
function Has($c)  { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

Write-Host
Write-Host "  SSH Ops Installer" -ForegroundColor Cyan
Write-Host "  Installing to: $Dir" -ForegroundColor DarkGray

# ── Dependencies ──────────────────────────────────────────────────────────────

Step "Checking dependencies"

if (-not (Has "node")) {
    Warn "node not found — installing"
    if     (Has "winget") { winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements }
    elseif (Has "choco")  { choco install nodejs-lts -y --no-progress }
    elseif (Has "scoop")  { scoop install nodejs-lts }
    else   { Err "Cannot auto-install Node.js. Install from https://nodejs.org and retry."; exit 1 }
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH","User")
    if (-not (Has "node")) { Err "Node.js installed but not on PATH — restart terminal and re-run."; exit 1 }
    Ok "Node.js $(node --version) installed"
} else { Ok "node $(node --version)" }

if (-not (Has "claude")) {
    Warn "claude CLI not found — installing"
    npm install -g @anthropic-ai/claude-code --silent
    Ok "claude CLI installed"
} else { Ok "claude CLI found" }

# ── Download files ─────────────────────────────────────────────────────────────

Step "Installing SSH Ops to $Dir"

$files = @(
    "VERSION",
    "scripts/ssh-mcp-server.mjs", "scripts/ssh-core.mjs",
    "scripts/ssh-ops.mjs", "scripts/ssh-cli-options.mjs",
    "ssh-ops.config.example.yaml",
    ".codex-plugin/plugin.json", "skills/ssh-ops/SKILL.md"
)
foreach ($f in $files) {
    $dest = Join-Path $Dir ($f -replace "/","\\")
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Invoke-WebRequest -Uri "$Base/$f" -OutFile $dest -UseBasicParsing
}
Ok "Files downloaded"

# ── Encryption key ─────────────────────────────────────────────────────────────

Step "Encryption key"
$KeyFile = "$Dir\.encryption-key"
if (Test-Path $KeyFile) {
    Skip "Key already exists — preserved"
} else {
    $env:KEY_FILE = $KeyFile
    node -e @"
const { randomBytes } = require('crypto');
const { writeFileSync } = require('fs');
const key = randomBytes(32).toString('hex') + '\n';
writeFileSync(process.env.KEY_FILE, key, { encoding: 'utf8' });
"@
    Remove-Item Env:\KEY_FILE -ErrorAction SilentlyContinue
    & icacls $KeyFile /inheritance:r /grant:r "${env:USERNAME}:F" 2>&1 | Out-Null
    Ok "Device-specific AES-256-GCM key generated at $KeyFile"
}

# ── Helper: merge MCP server into a JSON config file ──────────────────────────
function AddMcp {
    param([string]$File, [string]$Mode = "standard")
    New-Item -ItemType Directory -Force -Path (Split-Path $File) | Out-Null
    if (-not (Test-Path $File)) { '{}' | Set-Content $File -Encoding UTF8 }
    $env:MCP_FILE = $File
    $env:MCP_NAME = "ssh-ops"
    $env:MCP_CMD  = "node"
    $env:MCP_ARG  = "$Dir\scripts\ssh-mcp-server.mjs"
    $env:MCP_MODE = $Mode
    node -e @"
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
"@
    Remove-Item Env:\MCP_FILE, Env:\MCP_NAME, Env:\MCP_CMD, Env:\MCP_ARG, Env:\MCP_MODE -ErrorAction SilentlyContinue
}

# ── Claude Code ────────────────────────────────────────────────────────────────

Step "Claude Code"
& claude mcp remove ssh-ops 2>&1 | Out-Null
& claude mcp add ssh-ops node "$Dir\scripts\ssh-mcp-server.mjs" 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Ok "Registered" }
else { Err "Registration failed — run manually: claude mcp add ssh-ops node `"$Dir\scripts\ssh-mcp-server.mjs`"" }

# ── Codex ──────────────────────────────────────────────────────────────────────

Step "Codex"
if ((Has "codex") -or (Test-Path $CodexPlugins)) {
    New-Item -ItemType Directory -Force -Path $CodexPlugins | Out-Null
    $link = Join-Path $CodexPlugins "ssh-ops"
    if (Test-Path $link) { Remove-Item $link -Force -Recurse }
    New-Item -ItemType Junction -Path $link -Target $Dir | Out-Null
    Ok "Linked at $link"
} else { Skip "Not detected — skipping" }

# ── Cursor ─────────────────────────────────────────────────────────────────────

Step "Cursor"
$cursorDir = "$env:USERPROFILE\.cursor"
if ((Has "cursor") -or (Test-Path $cursorDir)) {
    AddMcp "$cursorDir\mcp.json"
    Ok "Registered in $cursorDir\mcp.json"
} else { Skip "Not detected — skipping" }

# ── VS Code Copilot ────────────────────────────────────────────────────────────

Step "VS Code Copilot"
$vscodeCfg = "$env:APPDATA\Code\User\settings.json"
if ((Has "code") -or (Test-Path "$env:APPDATA\Code")) {
    AddMcp $vscodeCfg "vscode"
    Ok "Registered in $vscodeCfg"
} else { Skip "Not detected — skipping" }

# ── Gemini CLI ─────────────────────────────────────────────────────────────────

Step "Gemini CLI"
if (Has "gemini") {
    & gemini mcp remove ssh-ops --scope user 2>&1 | Out-Null
    $r = & gemini mcp add ssh-ops node "$Dir\scripts\ssh-mcp-server.mjs" --scope user 2>&1
    if ($LASTEXITCODE -eq 0) { Ok "Registered (user scope)" }
    else { Err "gemini mcp add failed: $r" }
} else { Skip "Not detected — skipping" }

# ── Antigravity IDE ────────────────────────────────────────────────────────────

Step "Antigravity IDE"
$antigravityCfg = "$env:USERPROFILE\.gemini\antigravity\mcp_config.json"
if ((Has "antigravity") -or (Test-Path "$env:USERPROFILE\.gemini\antigravity")) {
    AddMcp $antigravityCfg
    Ok "Registered in $antigravityCfg"
} else { Skip "Not detected — skipping" }

# ── Config ─────────────────────────────────────────────────────────────────────

Step "Config"
$cfg = Join-Path $Dir "ssh-ops.config.yaml"
if (-not (Test-Path $cfg)) {
    Copy-Item (Join-Path $Dir "ssh-ops.config.example.yaml") $cfg
    Ok "Created $cfg"
    Info "Edit it to add your server profiles"
} else { Info "Preserved existing $cfg" }

# ── Done ───────────────────────────────────────────────────────────────────────

Write-Host
Write-Host "  ✓  SSH Ops installed successfully." -ForegroundColor Green
Write-Host "  Restart Claude Code, Codex, Cursor, VS Code, or Gemini to activate." -ForegroundColor DarkGray
Write-Host
