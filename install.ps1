$ErrorActionPreference = "Stop"

$Base         = "https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main"
$Dir          = if ($env:SSH_OPS_DIR)       { $env:SSH_OPS_DIR }       else { "$env:USERPROFILE\.ssh-ops" }
$CodexPlugins = if ($env:CODEX_PLUGINS_DIR) { $env:CODEX_PLUGINS_DIR } else { "$env:USERPROFILE\.codex\plugins" }

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  v  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  -  $m" -ForegroundColor Yellow }
function Has($c)  { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

# ── Dependencies ──────────────────────────────────────────────────────────────

Step "Checking dependencies"

if (-not (Has "node")) {
    Warn "node not found — installing"
    if     (Has "winget") { winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements }
    elseif (Has "choco")  { choco install nodejs-lts -y --no-progress }
    elseif (Has "scoop")  { scoop install nodejs-lts }
    else   { Write-Error "Cannot auto-install Node.js. Install from https://nodejs.org and retry."; exit 1 }
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH","User")
    if (-not (Has "node")) { Write-Error "Node.js installed but not on PATH — restart terminal and re-run."; exit 1 }
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
$r = & claude mcp add ssh-ops node "$Dir\scripts\ssh-mcp-server.mjs" 2>&1
if ($LASTEXITCODE -eq 0) { Ok "Registered" }
else {
    Warn "Already registered — re-registering"
    & claude mcp remove ssh-ops 2>&1 | Out-Null
    & claude mcp add ssh-ops node "$Dir\scripts\ssh-mcp-server.mjs" 2>&1 | Out-Null
    Ok "Re-registered"
}

# ── Codex ──────────────────────────────────────────────────────────────────────

Step "Codex"
if ((Has "codex") -or (Test-Path $CodexPlugins)) {
    New-Item -ItemType Directory -Force -Path $CodexPlugins | Out-Null
    $link = Join-Path $CodexPlugins "ssh-ops"
    if (Test-Path $link) { Remove-Item $link -Force -Recurse }
    New-Item -ItemType Junction -Path $link -Target $Dir | Out-Null
    Ok "Linked at $link"
} else { Warn "Not detected — skipping" }

# ── Cursor ─────────────────────────────────────────────────────────────────────

Step "Cursor"
$cursorDir = "$env:USERPROFILE\.cursor"
if ((Has "cursor") -or (Test-Path $cursorDir)) {
    AddMcp "$cursorDir\mcp.json"
    Ok "Registered in $cursorDir\mcp.json"
} else { Warn "Not detected — skipping" }

# ── VS Code Copilot ────────────────────────────────────────────────────────────

Step "VS Code Copilot"
$vscodeCfg = "$env:APPDATA\Code\User\settings.json"
if ((Has "code") -or (Test-Path "$env:APPDATA\Code")) {
    AddMcp $vscodeCfg "vscode"
    Ok "Registered in $vscodeCfg"
} else { Warn "Not detected — skipping" }

# ── Gemini CLI ─────────────────────────────────────────────────────────────────

Step "Gemini CLI"
$geminiCfg = "$env:USERPROFILE\.gemini\settings.json"
if ((Has "gemini") -or (Test-Path "$env:USERPROFILE\.gemini")) {
    AddMcp $geminiCfg
    Ok "Registered in $geminiCfg"
} else { Warn "Not detected — skipping" }

# ── Antigravity IDE ────────────────────────────────────────────────────────────

Step "Antigravity IDE"
$antigravityCfg = "$env:USERPROFILE\.gemini\antigravity\mcp_config.json"
if ((Has "antigravity") -or (Test-Path "$env:USERPROFILE\.gemini\antigravity")) {
    AddMcp $antigravityCfg
    Ok "Registered in $antigravityCfg"
} else { Warn "Not detected — skipping" }

# ── Config ─────────────────────────────────────────────────────────────────────

Step "Config"
$cfg = Join-Path $Dir "ssh-ops.config.yaml"
if (-not (Test-Path $cfg)) {
    Copy-Item (Join-Path $Dir "ssh-ops.config.example.yaml") $cfg
    Ok "Created $cfg — edit it to add your server profiles"
} else { Ok "Preserved existing $cfg" }

# ── Auto-update (weekly scheduled task) ───────────────────────────────────────

Step "Auto-update"
$taskName = "ssh-ops-weekly-update"
$installUrl = "https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main/install.ps1"
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
           -Argument "-NoProfile -NonInteractive -Command `"irm '$installUrl' | iex`" >> '$Dir\update.log' 2>&1"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "09:00AM"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -StartWhenAvailable

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
Ok "Weekly auto-update scheduled (Mondays 9am)"

Write-Host ""
Write-Host "Done. Restart Claude Code, Codex, Cursor, or VS Code to activate ssh-ops." -ForegroundColor Cyan
