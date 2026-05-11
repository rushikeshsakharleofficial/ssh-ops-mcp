$ErrorActionPreference = "Stop"

$Repo           = "https://github.com/rushikeshsakharleofficial/ssh-ops-mcp.git"
$InstallDir     = if ($env:SSH_OPS_DIR)       { $env:SSH_OPS_DIR }       else { "$env:LOCALAPPDATA\ssh-ops-mcp" }
$CodexPluginsDir = if ($env:CODEX_PLUGINS_DIR) { $env:CODEX_PLUGINS_DIR } else { "$env:USERPROFILE\.codex\plugins" }

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  v  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  !  $msg" -ForegroundColor Yellow }

# Prerequisites
foreach ($bin in @("git", "node")) {
    if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
        Write-Error "$bin not found. Install it and retry."
        exit 1
    }
}

# Clone or update
Step "Installing SSH Ops to $InstallDir"
if (Test-Path "$InstallDir\.git") {
    git -C $InstallDir pull --ff-only --quiet
    Ok "Updated existing installation"
} else {
    git clone --quiet $Repo $InstallDir
    Ok "Cloned repository"
}

# Claude Code
Step "Setting up Claude Code"
if (Get-Command claude -ErrorAction SilentlyContinue) {
    $result = claude mcp add ssh-ops node "$InstallDir\scripts\ssh-mcp-server.mjs" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Ok "MCP server registered with Claude Code"
    } else {
        Warn "Already registered or failed. Register manually:"
        Write-Host "     claude mcp add ssh-ops node `"$InstallDir\scripts\ssh-mcp-server.mjs`""
    }
} else {
    Warn "claude CLI not found — skipping. Register manually after installing Claude Code:"
    Write-Host "     claude mcp add ssh-ops node `"$InstallDir\scripts\ssh-mcp-server.mjs`""
}

# Codex
Step "Setting up Codex"
if ((Get-Command codex -ErrorAction SilentlyContinue) -or (Test-Path $CodexPluginsDir)) {
    New-Item -ItemType Directory -Force -Path $CodexPluginsDir | Out-Null
    $symlink = "$CodexPluginsDir\ssh-ops"
    if (Test-Path $symlink) { Remove-Item $symlink -Force -Recurse }
    New-Item -ItemType Junction -Path $symlink -Target $InstallDir | Out-Null
    Ok "Plugin junction created at $symlink"
} else {
    Warn "Codex plugins directory not found — skipping. Create junction manually:"
    Write-Host "     New-Item -ItemType Junction -Path `"$CodexPluginsDir\ssh-ops`" -Target `"$InstallDir`""
}

# Config
Step "Creating config"
$ConfigPath = "$InstallDir\ssh-ops.config.yaml"
if (-not (Test-Path $ConfigPath)) {
    Copy-Item "$InstallDir\ssh-ops.config.example.yaml" $ConfigPath
    Ok "Created $ConfigPath"
    Write-Host "     Edit it to add your server profiles."
} else {
    Ok "Config already exists at $ConfigPath"
}

Write-Host ""
Write-Host "Done. Restart Claude Code or Codex to activate the ssh-ops tools." -ForegroundColor Cyan
