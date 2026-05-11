$ErrorActionPreference = "Stop"

$Base         = "https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main"
$Dir          = if ($env:SSH_OPS_DIR)       { $env:SSH_OPS_DIR }       else { "$env:USERPROFILE\.ssh-ops" }
$CodexPlugins = if ($env:CODEX_PLUGINS_DIR) { $env:CODEX_PLUGINS_DIR } else { "$env:USERPROFILE\.codex\plugins" }
$ForceSetup   = $args -contains "--setup"

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

# ── Helper: install a package via available manager ───────────────────────────
function InstallPkg {
    param([string]$Choco, [string]$Scoop = $Choco, [string]$Winget = "")
    if     (Has "choco")  { choco install $Choco -y --no-progress 2>&1 | Out-Null }
    elseif (Has "scoop")  { scoop install $Scoop 2>&1 | Out-Null }
    elseif ($Winget -and (Has "winget")) { winget install --id $Winget --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null }
}

function RefreshPath {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH","User")
}

# ── Dependencies ──────────────────────────────────────────────────────────────

Step "Checking dependencies"

# ssh client — required for all SSH operations
if (-not (Has "ssh")) {
    Warn "ssh not found — enabling Windows OpenSSH client"
    Add-WindowsCapability -Online -Name OpenSSH.Client* 2>&1 | Out-Null
    if (Has "ssh") { Ok "ssh installed (Windows OpenSSH)" }
    else { Warn "Could not auto-install ssh — install OpenSSH client manually" }
} else { Ok "ssh $(ssh -V 2>&1 | Select-String 'OpenSSH' | Select-Object -First 1)" }

# node — required for MCP server
if (-not (Has "node")) {
    Warn "node not found — installing"
    if     (Has "winget") { winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null }
    elseif (Has "choco")  { choco install nodejs-lts -y --no-progress 2>&1 | Out-Null }
    elseif (Has "scoop")  { scoop install nodejs-lts 2>&1 | Out-Null }
    else   { Err "Cannot auto-install Node.js. Install from https://nodejs.org and retry."; exit 1 }
    RefreshPath
    if (-not (Has "node")) { Err "Node.js installed but not on PATH — restart terminal and re-run."; exit 1 }
    Ok "Node.js $(node --version) installed"
} else { Ok "node $(node --version)" }

# claude CLI — required for Claude Code MCP registration
if (-not (Has "claude")) {
    Warn "claude CLI not found — installing"
    npm install -g @anthropic-ai/claude-code --silent 2>&1 | Out-Null
    if (Has "claude") { Ok "claude CLI installed" } else { Warn "claude CLI install failed — Claude Code registration may fail" }
} else { Ok "claude CLI found" }

# sshpass — optional, needed for password-based SSH profiles
if (-not (Has "sshpass")) {
    Warn "sshpass not found — installing (needed for password-based SSH profiles)"
    InstallPkg "sshpass" "sshpass"
    RefreshPath
    if (Has "sshpass") { Ok "sshpass installed" }
    else { Warn "sshpass could not be auto-installed — install manually: choco install sshpass" }
} else { Ok "sshpass found" }

# git — optional
if (Has "git") { Ok "git $(git --version)" } else { Skip "git not found — optional" }

# ── Download files ─────────────────────────────────────────────────────────────

Step "Installing SSH Ops to $Dir"

$files = @(
    "VERSION",
    "scripts/ssh-mcp-server.mjs", "scripts/ssh-core.mjs",
    "scripts/ssh-ops.mjs", "scripts/ssh-cli-options.mjs",
    "ssh-ops.config.example.yaml",
    ".codex-plugin/plugin.json",
    "skills/ssh-ops/SKILL.md",
    "skills/ssh-ops/agents/openai.yaml"
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

# ── Claude Code skill plugin ──────────────────────────────────────────────────

Step "Claude Code skill plugin"
$ClaudePlugins = if ($env:CLAUDE_PLUGINS_DIR) { $env:CLAUDE_PLUGINS_DIR } else { "$env:USERPROFILE\.claude\plugins" }
$PluginCache   = "$ClaudePlugins\cache\rushikeshsakharleofficial\ssh-ops\latest"
$InstalledJson = "$ClaudePlugins\installed_plugins.json"

if (Test-Path "$env:USERPROFILE\.claude") {
    New-Item -ItemType Directory -Force -Path "$PluginCache\skills\ssh-ops" | Out-Null

    # CLAUDE.md — auto-loads skill content into context when plugin is active
    @'
# SSH Ops Skill

Use the `ssh-ops` skill when the user wants to connect to remote SSH servers, run commands, manage files, check health/disk/logs, assign IPs, or manage server profiles and jump chains.

@./skills/ssh-ops/SKILL.md
'@ | Set-Content "$PluginCache\CLAUDE.md" -Encoding UTF8

    # Copy SKILL.md
    Copy-Item "$Dir\skills\ssh-ops\SKILL.md" "$PluginCache\skills\ssh-ops\SKILL.md" -Force

    # Build ssh-ops.skill ZIP (required by Claude Code skill discovery)
    $tmpSkillDir = Join-Path $env:TEMP "ssh-ops-skill-$PID"
    New-Item -ItemType Directory -Force -Path "$tmpSkillDir\ssh-ops" | Out-Null
    Copy-Item "$Dir\skills\ssh-ops\SKILL.md" "$tmpSkillDir\ssh-ops\SKILL.md"
    $skillZip = "$PluginCache\ssh-ops.skill"
    if (Test-Path $skillZip) { Remove-Item $skillZip -Force }
    Compress-Archive -Path "$tmpSkillDir\ssh-ops" -DestinationPath $skillZip -Force
    Remove-Item $tmpSkillDir -Recurse -Force

    # Register in installed_plugins.json
    if (Test-Path $InstalledJson) {
        $env:INSTALLED_JSON  = $InstalledJson
        $env:PLUGIN_CACHE    = $PluginCache
        $env:PLUGIN_VERSION  = (Get-Content "$Dir\VERSION" -Raw -ErrorAction SilentlyContinue).Trim().TrimStart('v')
        node -e @"
const fs = require('fs');
const f = process.env.INSTALLED_JSON;
let d = {};
try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) {}
d.version = d.version || 2;
d.plugins = d.plugins || {};
const key = 'ssh-ops@rushikeshsakharleofficial';
const prev = d.plugins[key] && d.plugins[key][0];
const entry = {
  scope: 'user',
  installPath: process.env.PLUGIN_CACHE,
  version: process.env.PLUGIN_VERSION,
  installedAt: (prev && prev.installedAt) || new Date().toISOString(),
  lastUpdated: new Date().toISOString()
};
d.plugins[key] = [entry];
fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
"@ 2>&1 | Out-Null
        Remove-Item Env:\INSTALLED_JSON, Env:\PLUGIN_CACHE, Env:\PLUGIN_VERSION -ErrorAction SilentlyContinue
        Ok "Registered skill plugin (Claude Code)"
    } else {
        Ok "Skill files installed at $PluginCache"
        Info "Restart Claude Code to activate the ssh-ops skill"
    }
} else { Skip "~\.claude not found — skipping skill plugin" }

# ── Gemini CLI skill extension ─────────────────────────────────────────────────

Step "Gemini CLI skill extension"
$GeminiExtDir = if ($env:GEMINI_EXTENSIONS_DIR) { $env:GEMINI_EXTENSIONS_DIR } else { "$env:USERPROFILE\.gemini\extensions" }
$GeminiExt    = "$GeminiExtDir\ssh-ops"
$GeminiEnable = "$GeminiExtDir\extension-enablement.json"

if (Test-Path $GeminiExtDir) {
    New-Item -ItemType Directory -Force -Path "$GeminiExt\skills\ssh-ops" | Out-Null

    $versionTag = if (Test-Path "$Dir\VERSION") { (Get-Content "$Dir\VERSION" -Raw).Trim() } else { "latest" }

    # gemini-extension.json
    @"
{
  "name": "ssh-ops",
  "version": "$versionTag",
  "description": "SSH Ops: 27 tools for remote Linux server ops — run commands, manage users/permissions/sudo, assign IPs, health/disk/logs, service control, package management, cron, jump chains, and dynamic profile management.",
  "publisher": "rushikeshsakharleofficial",
  "engines": { "gemini": ">=1.0.0" }
}
"@ | Set-Content "$GeminiExt\gemini-extension.json" -Encoding UTF8

    # GEMINI.md
    "@./skills/ssh-ops/SKILL.md" | Set-Content "$GeminiExt\GEMINI.md" -Encoding UTF8

    # Copy SKILL.md
    Copy-Item "$Dir\skills\ssh-ops\SKILL.md" "$GeminiExt\skills\ssh-ops\SKILL.md" -Force

    # Enable extension
    $env:GEMINI_ENABLE = $GeminiEnable
    $env:HOME_DIR      = $env:USERPROFILE
    node -e @"
const fs = require('fs');
const f = process.env.GEMINI_ENABLE;
let d = {};
try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) {}
if (!d['ssh-ops']) {
  d['ssh-ops'] = { overrides: [process.env.HOME_DIR + '\\\\*'] };
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
}
"@ 2>&1 | Out-Null
    Remove-Item Env:\GEMINI_ENABLE, Env:\HOME_DIR -ErrorAction SilentlyContinue
    Ok "Gemini extension installed and enabled"
} else { Skip "~\.gemini\extensions not found — skipping Gemini extension" }

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
$McpTarget = "$Dir\scripts\ssh-mcp-server.mjs"
$mcpInfo = & claude mcp get ssh-ops 2>&1
if ($mcpInfo -match [regex]::Escape($McpTarget)) {
    Ok "Already registered (up-to-date)"
} else {
    # Remove from all scopes before re-adding to avoid "already exists" errors
    & claude mcp remove ssh-ops              2>&1 | Out-Null
    & claude mcp remove ssh-ops -s local    2>&1 | Out-Null
    & claude mcp remove ssh-ops -s user     2>&1 | Out-Null
    & claude mcp remove ssh-ops -s project  2>&1 | Out-Null
    & claude mcp add ssh-ops node $McpTarget 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok "Registered" }
    else { Err "Registration failed — run manually: claude mcp add ssh-ops node `"$McpTarget`"" }
}

# ── Codex ──────────────────────────────────────────────────────────────────────

Step "Codex"
if ((Has "codex") -or (Test-Path $CodexPlugins)) {
    New-Item -ItemType Directory -Force -Path $CodexPlugins | Out-Null
    $link = Join-Path $CodexPlugins "ssh-ops"
    $linkTarget = if (Test-Path $link) { (Get-Item $link).Target } else { $null }
    if ($linkTarget -and ((Resolve-Path $linkTarget -ErrorAction SilentlyContinue).Path -eq (Resolve-Path $Dir).Path)) {
        Ok "Already linked (up-to-date)"
    } else {
        if (Test-Path $link) { Remove-Item $link -Force -Recurse }
        New-Item -ItemType Junction -Path $link -Target $Dir | Out-Null
        Ok "Linked at $link"
    }
} else { Skip "Not detected — skipping" }

# ── Cursor ─────────────────────────────────────────────────────────────────────

Step "Cursor"
$cursorDir = "$env:USERPROFILE\.cursor"
$cursorCfg = "$cursorDir\mcp.json"
if ((Has "cursor") -or (Test-Path $cursorDir)) {
    if ((Test-Path $cursorCfg) -and ((Get-Content $cursorCfg -Raw 2>$null) -match [regex]::Escape("$Dir\scripts\ssh-mcp-server.mjs"))) {
        Ok "Already registered (up-to-date)"
    } else {
        AddMcp $cursorCfg
        Ok "Registered in $cursorCfg"
    }
} else { Skip "Not detected — skipping" }

# ── VS Code Copilot ────────────────────────────────────────────────────────────

Step "VS Code Copilot"
$vscodeCfg = "$env:APPDATA\Code\User\settings.json"
if ((Has "code") -or (Test-Path "$env:APPDATA\Code")) {
    if ((Test-Path $vscodeCfg) -and ((Get-Content $vscodeCfg -Raw 2>$null) -match [regex]::Escape("$Dir\scripts\ssh-mcp-server.mjs"))) {
        Ok "Already registered (up-to-date)"
    } else {
        AddMcp $vscodeCfg "vscode"
        Ok "Registered in $vscodeCfg"
    }
} else { Skip "Not detected — skipping" }

# ── Gemini CLI ─────────────────────────────────────────────────────────────────

Step "Gemini CLI"
if (Has "gemini") {
    $geminiInfo = & gemini mcp list 2>&1
    if ($geminiInfo -match [regex]::Escape("$Dir\scripts\ssh-mcp-server.mjs")) {
        Ok "Already registered (up-to-date)"
    } else {
        & gemini mcp remove ssh-ops --scope user 2>&1 | Out-Null
        $r = & gemini mcp add ssh-ops node "$Dir\scripts\ssh-mcp-server.mjs" --scope user 2>&1
        if ($LASTEXITCODE -eq 0) { Ok "Registered (user scope)" }
        else { Err "gemini mcp add failed: $r" }
    }
} else { Skip "Not detected — skipping" }

# ── Antigravity IDE ────────────────────────────────────────────────────────────

Step "Antigravity IDE"
$antigravityCfg = "$env:USERPROFILE\.gemini\antigravity\mcp_config.json"
if ((Has "antigravity") -or (Test-Path "$env:USERPROFILE\.gemini\antigravity")) {
    if ((Test-Path $antigravityCfg) -and ((Get-Content $antigravityCfg -Raw 2>$null) -match [regex]::Escape("$Dir\scripts\ssh-mcp-server.mjs"))) {
        Ok "Already registered (up-to-date)"
    } else {
        AddMcp $antigravityCfg
        Ok "Registered in $antigravityCfg"
    }
} else { Skip "Not detected — skipping" }

# ── Config ─────────────────────────────────────────────────────────────────────

Step "Config"
$cfg     = Join-Path $Dir "ssh-ops.config.yaml"
$RunSetup = $false

if ($ForceSetup) { $RunSetup = $true }
elseif (-not (Test-Path $cfg)) {
    Copy-Item (Join-Path $Dir "ssh-ops.config.example.yaml") $cfg
    $RunSetup = $true
} elseif ((Get-Content $cfg -Raw 2>$null) -match "server\.example\.com") {
    Warn "Config still contains demo data — running setup"
    $RunSetup = $true
}

if ($RunSetup) {
    if (-not [Environment]::UserInteractive) {
        Info "Non-interactive install — edit $cfg to add your server profiles"
    } else {
        Write-Host
        Info "Server setup (Enter to skip any field, Ctrl+C to cancel)"
        Write-Host

        $sHost = Read-Host "  Server host or IP"
        if ([string]::IsNullOrWhiteSpace($sHost)) {
            Info "Skipped — edit $cfg to add your server profiles"
        } else {
            $sUser  = Read-Host "  SSH user [root]"
            if ([string]::IsNullOrWhiteSpace($sUser)) { $sUser = "root" }
            $sPort  = Read-Host "  SSH port [22]"
            if ([string]::IsNullOrWhiteSpace($sPort)) { $sPort = "22" }
            $sPname = Read-Host "  Profile name [server1]"
            if ([string]::IsNullOrWhiteSpace($sPname)) { $sPname = "server1" }
            $sIdfile = Read-Host "  SSH identity file (blank for default)"

            $sJump = Read-Host "  Route through jump/bastion server? [y/N]"
            $jumpBlock = ""; $jumpRef = ""; $jHost = ""; $jUser = ""; $jPname = ""
            if ($sJump -match "^[yY]") {
                $jHost = Read-Host "  Jump host or IP"
                $jUser = Read-Host "  Jump SSH user [$env:USERNAME]"
                if ([string]::IsNullOrWhiteSpace($jUser)) { $jUser = $env:USERNAME }
                $jSwitchUser = Read-Host "  Switch to user on jump server (blank = none)"
                $jPname = Read-Host "  Jump profile name [bastion]"
                if ([string]::IsNullOrWhiteSpace($jPname)) { $jPname = "bastion" }
                $jumpBlock = "`n  ${jPname}:`n    host: $jHost`n    user: $jUser"
                $jumpRef   = "`n    jumpProfile: $jPname"
                if (-not [string]::IsNullOrWhiteSpace($jSwitchUser)) { $jumpRef += "`n    jumpUser: $jSwitchUser" }
            }

            $sLocalSwitch = Read-Host "  Is ssh-ops on this machine reaching internal hosts via local user switch? [y/N]"
            $localSwitchLine = ""
            if ($sLocalSwitch -match "^[yY]") {
                $lUser = Read-Host "  Local user to switch to (sudo -n -u <user> ssh ...)"
                if (-not [string]::IsNullOrWhiteSpace($lUser)) { $localSwitchLine = "`n    localSwitchUser: $lUser" }
            }

            $idLine = if (-not [string]::IsNullOrWhiteSpace($sIdfile)) { "`n    identityFile: $sIdfile" } else { "" }

            $cfgContent = @"
defaultTarget: $sPname
defaults:
  connectTimeoutSec: 12
  strictHostKeyChecking: accept-new
  timeoutMs: 120000
  maxOutputBytes: 2000000
profiles:
  ${sPname}:
    host: $sHost
    user: $sUser
    port: $sPort${idLine}${localSwitchLine}${jumpRef}
${jumpBlock}
"@
            $cfgContent | Set-Content $cfg -Encoding UTF8
            Ok "Config saved: $sPname → $sUser@$sHost"
            if (-not [string]::IsNullOrWhiteSpace($jHost)) { Info "Via jump: $jPname → $jUser@$jHost" }
        }
    }
} else { Info "Preserved existing $cfg" }

# ── Done ───────────────────────────────────────────────────────────────────────

Write-Host
Write-Host "  ✓  SSH Ops installed successfully." -ForegroundColor Green
Write-Host "  Restart Claude Code, Codex, Cursor, VS Code, Gemini, or Antigravity to activate." -ForegroundColor DarkGray
Write-Host
