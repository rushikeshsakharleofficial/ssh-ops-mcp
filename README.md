# SSH Ops

SSH Ops exposes SSH tasks as an MCP server and a plain Node CLI. Works with **Claude Code, Codex, Cursor, VS Code Copilot, Gemini CLI, and Antigravity IDE**. Uses your local `ssh` binary, existing keys, and SSH config. Passwords stored encrypted (AES-256-GCM, device-specific key).

## Install

**Prerequisites:** `node` on your PATH (auto-installed if missing).

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main/install.sh | bash
```

Installs to `~/.ssh-ops`.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main/install.ps1 | iex
```

Installs to `%USERPROFILE%\.ssh-ops`.

---

Each installer auto-detects which tools are installed and registers the MCP server with all of them:

| Tool | Config |
|------|--------|
| Claude Code | `claude mcp add` CLI |
| Codex | symlink in `~/.codex/plugins/` |
| Cursor | `~/.cursor/mcp.json` |
| VS Code Copilot | `settings.json` → `mcp.servers` |
| Gemini CLI | `~/.gemini/settings.json` |
| Antigravity IDE | `~/.gemini/antigravity/mcp_config.json` |

Also:
- Auto-installs Node.js if missing (nvm on macOS/Linux; winget/choco/scoop on Windows)
- Auto-installs `claude` CLI if missing
- Downloads only needed files to `~/.ssh-ops/` — no git clone, no repo leftovers
- Generates a device-specific AES-256-GCM encryption key at `~/.ssh-ops/.encryption-key` (0600)
- Re-running updates all files; your `ssh-ops.config.yaml` and encryption key are preserved
- **Auto-updates on session start** — MCP server checks GitHub Releases on every `initialize` and silently pulls updates when a new version is available

Restart your IDE or CLI session after running.

**Custom install location:**
```bash
# macOS / Linux
SSH_OPS_DIR=~/tools/ssh-ops curl -fsSL https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main/install.sh | bash

# Windows
$env:SSH_OPS_DIR="C:\tools\ssh-ops"; irm https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main/install.ps1 | iex
```

**Update:** re-run the same install command to force an immediate update.

---

## Configure

Copy the example config and edit your profiles:

```bash
cp ssh-ops.config.example.yaml ssh-ops.config.yaml
```

Or place the same YAML at `~/.ssh/ssh-ops.yaml` for a machine-wide default.

```yaml
defaultTarget: production
defaults:
  connectTimeoutSec: 12
  strictHostKeyChecking: accept-new
profiles:
  production:
    host: server.example.com
    user: deploy
    port: 22
  bastion:
    host: bastion.example.com
    user: operator
    access: sudo          # prepend sudo to all commands for this profile
```

`ssh-ops.config.yaml` is gitignored — per-machine targets and key paths stay local. JSON config files also work.

### Dynamic profiles (via MCP)

Add servers at runtime without editing any file:

```
ssh_add_profile(name="staging", host="10.0.0.5", user="admin", password="s3cr3t")
ssh_add_profile(name="prod-key", host="prod.example.com", user="deploy", identityFile="~/.ssh/prod_rsa")
ssh_remove_profile(name="staging")
```

Passwords are encrypted with AES-256-GCM using the device key at `~/.ssh-ops/.encryption-key`. Requires `sshpass` on the local machine for password-based auth. Dynamic profiles are stored in `ssh-ops.dynamic.json` (gitignored).

### Jump Server Routing

To route all non-jump targets through a bastion:

```yaml
defaults:
  jumpProfile: bastion
  jumpUser: relay
  targetUser: root
profiles:
  bastion:
    host: bastion.example.com
    user: operator
```

Non-jump targets connect to `bastion` as `operator`, then SSH as `relay` to `root@<destination>`. The bastion profile itself connects directly.

---

## MCP Tools

### Diagnostics (read-only)

| Tool | Description |
|------|-------------|
| `ssh_profiles` | List configured profiles without connecting |
| `ssh_inventory` | Hardware and VM inventory — OS, CPU, RAM, disk, PCI, network |
| `ssh_disk_report` | Filesystem, inode, and container storage report |
| `ssh_health_report` | Load, services, journal errors, processes, Docker snapshot |
| `ssh_log_search` | Search systemd journal or a log file by pattern |
| `ssh_network_check` | Ping, port probe, TLS cert check — runs FROM the SSH server to another host |

### Execution

| Tool | Description |
|------|-------------|
| `ssh_run` | Run a command or script on a single remote host |
| `ssh_run_multi` | Run a command on multiple hosts in parallel; returns per-target results as text or JSON |

### File Operations

| Tool | Description |
|------|-------------|
| `ssh_file_read` | Read a remote file (`encoding: "base64"` for binary) |
| `ssh_file_write` | Overwrite a remote file; auto-backup before write (`encoding: "base64"` for binary) |
| `ssh_file_patch` | Edit a remote file — replace a line range or regex find-and-replace |

### System Management *(confirm before write actions)*

| Tool | Description |
|------|-------------|
| `ssh_service` | Systemd service control — status, start, stop, restart, enable, disable |
| `ssh_package` | Package management — auto-detects apt/yum/dnf/apk; list, search, install, remove, update, upgrade |
| `ssh_cron` | Crontab CRUD for any user — list, add, remove |

### Profile Management

| Tool | Description |
|------|-------------|
| `ssh_add_profile` | Add or update an SSH profile at runtime; passwords stored AES-256-GCM encrypted |
| `ssh_remove_profile` | Remove a dynamically-added profile |

The MCP server communicates over newline-delimited JSON-RPC on stdio.

---

## CLI

```bash
node scripts/ssh-ops.mjs profiles
node scripts/ssh-ops.mjs run production 'hostname; uptime'
node scripts/ssh-ops.mjs inventory production
node scripts/ssh-ops.mjs disk production / 1
node scripts/ssh-ops.mjs health production
```

Raw targets work without a profile:

```bash
node scripts/ssh-ops.mjs inventory deploy@server.example.com
```

CLI options:

| Flag | Description |
|------|-------------|
| `--sudo` | Run via `sudo -n bash -s` |
| `--raw` | Pass command as raw SSH remote command |
| `--timeout-ms <ms>` | Local command timeout |
| `--port <n>` | SSH port override |
| `--identity-file <path>` | SSH private key |
| `--jump-host <target>` | SSH jump host (`-J`) |
| `--no-sudo` | Disable sudo in inventory |

---

## How It Works

- **Config loading** — merges `ssh-ops.config.yaml` (project root) with `~/.ssh/ssh-ops.yaml` (machine-wide) and `ssh-ops.dynamic.json` (MCP-added profiles). Override or add extra files with the `SSH_OPS_CONFIG` env var (colon-separated paths). Later files win on conflicts.
- **Script builders** — each tool generates a self-contained bash script piped to `bash -s` on the remote. No interactive shell, no agent forwarding required.
- **Two-hop routing** — when `jumpProfile` is set in defaults, SSH Ops connects to the jump host first, then runs a nested `ssh` from there to the final destination using a heredoc. Transparent to the caller.
- **Password auth** — profiles with a password use `sshpass -e` with the decrypted password injected via the `SSHPASS` env var. Password never appears in process args. Requires `sshpass` installed locally.
- **Encryption** — passwords stored as `iv:ciphertext:authtag` (AES-256-GCM). Device key generated at install time (`~/.ssh-ops/.encryption-key`, 0600). Passwords from one machine cannot be decrypted on another.
- **Safety** — all sudo uses `sudo -n` (fails instead of prompting if a password would be required). `ssh_file_write` and `ssh_file_patch` create a timestamped `.bak` before modifying.
- **Auto-update** — on every MCP `initialize`, the server checks GitHub Releases in the background. If a newer version exists, updated script files are downloaded silently and `VERSION` is bumped. No restart needed for the next session.
