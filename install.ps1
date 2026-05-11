$ErrorActionPreference = "Stop"

$Base         = "https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main"
$Dir          = if ($env:SSH_OPS_DIR)       { $env:SSH_OPS_DIR }       else { "$env:USERPROFILE\.ssh-ops" }
$CodexPlugins = if ($env:CODEX_PLUGINS_DIR) { $env:CODEX_PLUGINS_DIR } else { "$env:USERPROFILE\.codex\plugins" }

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  v  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !  $m" -ForegroundColor Yellow }
function Has($c)  { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

# ── Dependencies ──────────────────────────────────────────────────────────────

Step "Checking dependencies"

# Node.js
if (-not (Has "node")) {
    Warn "node not found — installing"
    if (Has "winget") {
        winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    } elseif (Has "choco") {
        choco install nodejs-lts -y --no-progress
    } elseif (Has "scoop") {
        scoop install nodejs-lts
    } else {
        Write-Error "Cannot auto-install Node.js. Install it from https://nodejs.org and retry."
        exit 1
    }
    # Refresh PATH so node is available immediately
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH","User")
    if (-not (Has "node")) {
        Write-Error "Node.js installed but not on PATH. Restart your terminal and re-run."
        exit 1
    }
    Ok "Node.js $(node --version) installed"
} else {
    Ok "node $(node --version)"
}

# Claude Code CLI
if (-not (Has "claude")) {
    Warn "claude CLI not found — installing via npm"
    npm install -g @anthropic-ai/claude-code --silent
    Ok "claude CLI installed"
} else {
    Ok "claude CLI found"
}

# ── Download files ─────────────────────────────────────────────────────────────

Step "Installing SSH Ops to $Dir"

$files = @(
    "scripts/ssh-mcp-server.mjs",
    "scripts/ssh-core.mjs",
    "scripts/ssh-ops.mjs",
    "scripts/ssh-cli-options.mjs",
    "ssh-ops.config.example.yaml",
    ".codex-plugin/plugin.json",
    "skills/ssh-ops/SKILL.md"
)

foreach ($f in $files) {
    $dest = Join-Path $Dir ($f -replace "/","\\")
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Invoke-WebRequest -Uri "$Base/$f" -OutFile $dest -UseBasicParsing
}

Ok "Files downloaded"

# ── Claude Code ────────────────────────────────────────────────────────────────

Step "Registering MCP server with Claude Code"
$r = & claude mcp add ssh-ops node "$Dir\scripts\ssh-mcp-server.mjs" 2>&1
if ($LASTEXITCODE -eq 0) {
    Ok "Registered ssh-ops"
} else {
    Warn "Already registered. Re-register manually:"
    Write-Host "     claude mcp remove ssh-ops; claude mcp add ssh-ops node `"$Dir\scripts\ssh-mcp-server.mjs`""
}

# ── Codex ──────────────────────────────────────────────────────────────────────

Step "Setting up Codex"
if ((Has "codex") -or (Test-Path $CodexPlugins)) {
    New-Item -ItemType Directory -Force -Path $CodexPlugins | Out-Null
    $link = Join-Path $CodexPlugins "ssh-ops"
    if (Test-Path $link) { Remove-Item $link -Force -Recurse }
    New-Item -ItemType Junction -Path $link -Target $Dir | Out-Null
    Ok "Plugin junction at $link"
} else {
    Warn "Codex not detected — skipping. Create junction manually:"
    Write-Host "     New-Item -ItemType Junction -Path `"$CodexPlugins\ssh-ops`" -Target `"$Dir`""
}

# ── Config ─────────────────────────────────────────────────────────────────────

Step "Creating config"
$cfg = Join-Path $Dir "ssh-ops.config.yaml"
if (-not (Test-Path $cfg)) {
    Copy-Item (Join-Path $Dir "ssh-ops.config.example.yaml") $cfg
    Ok "Created $cfg — edit it to add your server profiles"
} else {
    Ok "Config unchanged at $cfg"
}

Write-Host ""
Write-Host "Done. Restart Claude Code or Codex to activate ssh-ops." -ForegroundColor Cyan
