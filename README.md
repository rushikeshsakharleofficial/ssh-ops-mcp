<div align="center">

# SSH Ops MCP

**95 SSH tools for AI coding assistants — exec, inventory, health, files, services, containers, databases, networking, and more.**

[![CI](https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

</div>

---

SSH Ops exposes SSH tasks as an MCP server and a plain Node CLI. Works with **Claude Code, Codex, Cursor, VS Code Copilot, Gemini CLI, and Antigravity IDE**. Uses your local `ssh` binary, existing keys, and SSH config. Passwords and credentials stored encrypted (AES-256-GCM, device-specific key).

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Configure](#configure)
- [MCP Tools](#mcp-tools)
- [CLI](#cli)
- [How It Works](#how-it-works)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **95 MCP tools** — exec, inventory, health, disk, logs, files, services, packages, cron, users, Docker, Kubernetes, databases, web servers, firewalls, WireGuard, ZFS, LVM, benchmarks, and more
- **Linux + Windows** — full PowerShell pipeline for Windows SSH targets; auto-detects OS per connection
- **Multi-hop routing** — `jumpChain` (`-J` multi-hop), `jumpProfile` (nested SSH), `localSwitchUser` (bastion-local)
- **Parallel fleet ops** — `ssh_run_multi` runs across all profiles matching a group; `ssh_fleet_health` gives a dashboard in one call
- **Encrypted credentials** — AES-256-GCM, device-specific key; passwords never appear in process args or model context
- **Safety gates** — all mutating tools require `confirm: true`; critical ops (service restart, user deletion, bulk writes) require double confirmation; `dryRun: true` previews the exact bash script
- **No runtime npm dependencies** — the MCP server uses only Node.js built-ins; no `npm install` or `node_modules` required at runtime
- **Auto-install** — the installer (`install.sh` / `install.ps1`) may install system packages (curl, ssh, node, sshpass) and AI CLI integrations; those are installer-time dependencies, not runtime ones

---

## Requirements

- **Node.js 18+** — the installer auto-installs via nvm (macOS/Linux) or winget/choco/scoop (Windows)
- **OpenSSH client** — auto-installed on all platforms
- **`sshpass`** — only required for password-based profiles (auto-installed)
- No `package.json`, no `node_modules`, no build step

---

## Quick Start

```bash
# 1. Install (macOS / Linux)
curl -fsSL https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main/install.sh | bash

# 2. Restart your IDE or Claude Code session
# 3. Add a server (via MCP tool or config file)
#    ssh_add_profile(name="prod", host="server.example.com", user="deploy")

# 4. Run a command
#    ssh_run(target="prod", command="hostname; uptime")
```

The installer registers the MCP server with every detected tool (Claude Code, Cursor, Codex, VS Code Copilot, Gemini CLI) and runs a setup wizard on first install. See [Install](#install) for all options.

---

## Install

**No runtime prerequisites** — the MCP server runs on Node.js built-ins only. The installer auto-installs system tools (ssh, node, sshpass) as needed.

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
| Gemini CLI | user-scope via `gemini mcp add` |
| Antigravity IDE | `~/.gemini/antigravity/mcp_config.json` |

### What the installer does

**Dependencies** — auto-installs everything needed, nothing to pre-install:

| Dependency | Auto-install method |
|------------|---------------------|
| `curl` | apt / dnf / yum / apk / brew / pacman / zypper |
| `ssh` (OpenSSH client) | system package manager / Windows OpenSSH capability |
| `node` 18+ | nvm (macOS/Linux) · winget / choco / scoop (Windows) |
| `claude` CLI | `npm install -g @anthropic-ai/claude-code` |
| `sshpass` | system package manager (needed for password-based profiles) |

Package manager auto-detected: `apt-get` → `dnf` → `yum` → `apk` → `brew` → `pacman` → `zypper`

**After dependencies:**
- Downloads only needed files to `~/.ssh-ops/` — no git clone, no repo leftovers
- Generates a device-specific AES-256-GCM encryption key at `~/.ssh-ops/.encryption-key` (0600)
- Installs SSH Ops as a **Claude Code skill plugin** (`.skill` ZIP — discovered by `/reload-plugins`) and a **Gemini CLI extension** (`~/.gemini/extensions/ssh-ops/`)
- Registers MCP server with every detected IDE/CLI tool
- Re-running is idempotent — shows "Already registered" for each tool, only updates what changed
- **Interactive setup wizard** runs on first install: asks for server, jump server, switch user — tests the connection before saving

Restart your IDE or CLI session after running.

**Custom install location:**

```bash
# macOS / Linux
SSH_OPS_DIR=~/tools/ssh-ops curl -fsSL https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main/install.sh | bash
```

```powershell
# Windows
$env:SSH_OPS_DIR="C:\tools\ssh-ops"; irm https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main/install.ps1 | iex
```

**Update:** re-run the same install command.

**Force setup wizard** (reconfigure server profiles):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main/install.sh) --setup
```

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
    access: sudo          # prepend sudo to all commands for this profile
    extraArgs: []
```

`ssh-ops.config.yaml` is gitignored — per-machine targets and key paths stay local. JSON config files also work.

### Dynamic profiles (via MCP)

Add servers at runtime without editing any file:

```
ssh_add_profile(name="staging", host="10.0.0.5", user="admin", password="s3cr3t")
ssh_add_profile(name="prod-key", host="prod.example.com", user="deploy", identityFile="~/.ssh/prod_rsa")
ssh_remove_profile(name="staging")
```

- Passwords encrypted with AES-256-GCM using the device key at `~/.ssh-ops/.encryption-key`
- Requires `sshpass` on the local machine for password-based auth
- Dynamic profiles stored in `ssh-ops.dynamic.json` (gitignored)
- Each entry tagged with `_type`, `_addedAt`, `_updatedAt` for JSON filtering

### Jump Server Routing

**Multi-hop via SSH `-J` (recommended):**

```yaml
defaults:
  jumpChain: [bastion1, bastion2]   # ordered chain — all targets route through this
  commonUser: deploy                 # default SSH user when no per-profile user is set
profiles:
  bastion1:
    host: bastion.example.com
    user: operator
    port: 22
  bastion2:
    host: internal-bastion.example.com
    user: relay
```

SSH Ops builds `-J ops@bastion.example.com,relay@internal-bastion.example.com` automatically. Connecting directly to a server in the chain skips the `-J` flag. Manage jump servers dynamically via `ssh_add_jump` / `ssh_remove_jump`.

**Single-hop nested SSH (legacy, keys on jump server):**

```yaml
defaults:
  jumpProfile: bastion
  jumpUser: relay       # switch to this user on jump server before connecting onward
  targetUser: root      # user for the final destination
profiles:
  bastion:
    host: bastion.example.com
    user: operator
```

Connects to `bastion` as `operator`, then runs `sudo -n -u relay ssh root@destination` from there — useful when keys for internal servers live on the jump host.

**Running ssh-ops on the jump server itself (`localSwitchUser`):**

```yaml
defaults:
  localSwitchUser: relay    # sudo -n -u relay ssh ... on this machine
  targetUser: root
profiles:
  web1:
    host: 10.0.1.10
  db1:
    host: 10.0.1.20
```

SSH Ops runs `sudo -n -u relay ssh root@10.0.1.10` locally — ideal when internal keys are owned by a service account on the bastion.

**Choosing a routing strategy:**

| Strategy | When to use |
|----------|-------------|
| `jumpChain` / `jumpHost` (`-J`) | MCP server runs on workstation; direct or single-hop to target via standard ProxyJump |
| `jumpProfile` + `jumpUser`/`targetUser` | MCP server runs on workstation; two-hop via bastion where keys for internal servers live on the jump host |
| `localSwitchUser` | MCP server runs ON the bastion itself; need to switch to a local service account before SSHing to internal targets |

### IP assignment

Assign IPs to a remote interface — applied immediately and persisted across reboots. Three ways to specify IPs:

```
# 1. Inline array
ssh_ip_assign(target="prod", iface="eth0", ips=["192.168.1.100/24", "10.0.0.5/16"])

# 2. Named group (define once, reuse everywhere)
ssh_save_ip_group(name="web-cluster", iface="eth0",
  ips=["192.168.1.100/24", "192.168.1.101/24"],
  gateway="192.168.1.1", dns=["8.8.8.8"])

ssh_ip_assign(target="prod1", group="web-cluster")
ssh_ip_assign(target="prod2", group="web-cluster")

# 3. Local file (JSON or YAML)
ssh_ip_assign(target="prod", fromFile="./configs/prod-ips.yaml")
```

Inline `ips`/`iface`/`gateway`/`dns` params always override group or file values.

After persisting, automatically runs **IP verification** for each assigned address:

| IP type | Checks performed |
|---------|-----------------|
| Private (`10.x`, `192.168.x`, `172.16-31.x`) | IP on interface · gateway ping via interface · self ping |
| Public (all others) | IP on interface · `ping -I $IP 8.8.8.8` · `curl --interface $IP ipify.org` to confirm outbound traffic leaves via the correct IP |

Output ends with `Verification: ALL PASSED` or `Verification: SOME CHECKS FAILED`.

Auto-detects persistence method in priority order:

| Method | Triggered when | Writes to |
|--------|---------------|-----------|
| `netplan` | `netplan` binary + `/etc/netplan/` exists | `/etc/netplan/99-ssh-ops-<iface>.yaml` |
| `networkmanager` | `NetworkManager` service active | `nmcli connection modify` |
| `network-scripts` | `/etc/sysconfig/network-scripts/` exists | `ifcfg-<iface>:N` alias files |
| `systemd-networkd` | `systemd-networkd` service active | `/etc/systemd/network/99-ssh-ops-<iface>.network` |
| `rc.local` | Fallback | Appends `ip addr add` before `exit 0` |

Override with `method="netplan"` etc. Existing IPs skipped (idempotent). Always requires sudo.

### Auth failure handling

When credentials fail, the profile is automatically flagged `_authFailed: true` in the dynamic config. The next command returns:

```
⚠ AUTH FAILURE — credentials stored for this profile no longer work.
  Update via ssh_add_profile / ssh_add_jump with new password or identityFile.
  To see available local SSH keys: ssh_list_keys
```

Updating credentials via `ssh_add_profile` clears the flag. Stored creds are reused silently on every call.

---

## MCP Tools

**95 tools total.** `target` accepts a profile name or raw `user@host`. Full parameter reference: [MCP-Tools wiki](https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/wiki/MCP-Tools).

### Exec

| Tool | Description |
|------|-------------|
| `ssh_run` | Single host; params: command/target/sudo/mode/cwd/jumpHost/sshOptions |
| `ssh_run_multi` | Parallel multi-host; `group:"prod"` targets all matching profiles; `format:"json"` |
| `ssh_run_watch` | Run + diff vs last output; first call full, subsequent = changed lines only *(saves AI context)* |
| `ssh_script` | Upload + run local script file on remote |

### Inventory & Health

| Tool | Description |
|------|-------------|
| `ssh_inventory` | OS/CPU/RAM/DMI/disks/PCI/network/load |
| `ssh_health_report` | Load/memory/disk/failed units/processes/docker; fires alertWebhook on threshold breach |
| `ssh_disk_report` | df/inode/du/Docker storage hints |
| `ssh_metrics` | Structured /proc metrics: cpuPercent/memPercent/memUsedMB/loadAvg/uptimeSeconds/diskIO/netIO |
| `ssh_memory_report` | Detailed memory: totals/swap/huge pages/top-N processes by RSS |
| `ssh_snapshot` | Full server state JSON (OS/CPU/mem/disk/load/services/ports/users/packages/top procs) |
| `ssh_compare` | Parallel snapshots of two servers → diff report |
| `ssh_fleet_health` | Health check ALL profiles in parallel → summary table (server/cpu%/mem%/disk%/load/failed) |
| `ssh_anomaly` | Rolling 10-sample baseline + stddev deviation detection; params: sensitivity/updateBaseline |
| `ssh_ping` | TCP reachability (no SSH auth); returns reachable/avgLatencyMs |
| `ssh_diff` | Compare remote file vs local or remote-vs-remote |

### Files *(CONFIRM writes)*

| Tool | Description |
|------|-------------|
| `ssh_file_read` | `encoding:"base64"` for binary |
| `ssh_file_write` | Auto-backup; `sudo` for root files *(CONFIRM)* |
| `ssh_file_patch` | Line-range or regex replace *(CONFIRM)* |
| `ssh_tail` | Last N lines; optional `followSeconds` live tail |
| `ssh_template` | Render `{{VAR}}` template → write to remote path *(CONFIRM)* |
| `ssh_transfer` | scp local↔remote or remote↔remote *(CONFIRM)* |
| `ssh_rsync` | rsync (runs locally); `--delete` requires confirm |

### Logs & Observability

| Tool | Description |
|------|-------------|
| `ssh_log_search` | Journal or file grep; params: unit/pattern/lines/since/path |
| `ssh_dmesg` | Kernel ring buffer; levels: all/emerg/alert/crit/err/warn/notice/info/debug |
| `ssh_perf` | vmstat+iostat+/proc network delta |
| `ssh_tcpdump` | Bounded capture (max 200 packets / 30s) *(CONFIRM)* |
| `ssh_change_tracker` | `find -mmin -N` recently modified files; params: minutes/path/exclude |

### System *(CONFIRM writes)*

| Tool | Description |
|------|-------------|
| `ssh_service` | status/start/stop/restart/enable/disable *(non-status CONFIRM)* |
| `ssh_package` | 14 managers auto-detected: apt/dnf/yum/apk/pacman/zypper/xbps/snap/flatpak/pkg/emerge/nix/opkg/brew; list/search/info/install/remove/update/upgrade/autoremove |
| `ssh_cron` | list/add/remove crontab for any user *(add/remove CONFIRM)* |
| `ssh_systemd_timer` | list/status/enable/disable/start/stop systemd timers *(mutating CONFIRM)* |
| `ssh_user` | add/del/mod/list/info/passwd/lock/unlock *(mutating CONFIRM)* |
| `ssh_chmod` | chmod+chown+chgrp; mode/owner/group/recursive *(CONFIRM)* |
| `ssh_sudo_rule` | /etc/sudoers.d/; visudo -c validation *(mutating CONFIRM)* |
| `ssh_env` | /etc/environment list/get/set/unset *(set/unset CONFIRM)* |
| `ssh_process` | list or kill by PID/name; signal param *(kill CONFIRM)* |
| `ssh_mount` | list(findmnt)/mount/umount filesystems *(mount/umount CONFIRM)* |
| `ssh_sysctl` | list/get/set/search kernel params; `persist:true` → /etc/sysctl.d/ *(set CONFIRM)* |
| `ssh_swap` | status/add/remove/on/off swap files *(mutating CONFIRM)* |
| `ssh_kernel` | version/modules/dmesg/params (read-only) |
| `ssh_limits` | /etc/security/limits.conf list/get/set/remove/current *(set/remove CONFIRM)* |

### Networking

| Tool | Description |
|------|-------------|
| `ssh_network_check` | ping/port/TLS FROM remote server |
| `ssh_port_scan` | Listening ports via ss (netstat fallback) |
| `ssh_ssl_cert` | TLS cert expiry+subject+SANs+fingerprint (openssl from remote) |
| `ssh_firewall` | ufw/firewalld/iptables auto-detect; list/add/remove/flush *(add/remove/flush CONFIRM)* |
| `ssh_dns_check` | DNS resolution FROM remote (dig→nslookup→host) |
| `ssh_traceroute` | mtr/tracepath/traceroute from remote |
| `ssh_hosts` | /etc/hosts list/add/remove with auto-backup *(add/remove CONFIRM)* |
| `ssh_ip_assign` | Permanent IP; auto-detects netplan/NM/network-scripts/networkd/rc.local *(CONFIRM)* |
| `ssh_wireguard` | WireGuard VPN: status/list-peers/add-peer/remove-peer/enable/disable/stats *(mutating CONFIRM)* |
| `ssh_nfs` | NFS exports: list/clients/add/remove/reload *(mutating CONFIRM)* |

### Security *(mutations CONFIRM)*

| Tool | Description |
|------|-------------|
| `ssh_authorized_keys` | list/add/remove ~/.ssh/authorized_keys; validates key format *(add/remove CONFIRM)* |
| `ssh_fail2ban` | status/list-jails/banned-ips/ban/unban/reload *(ban/unban/reload CONFIRM)* |
| `ssh_audit` | Read-only scan: SUID/SGID, world-writable, passwordless sudo, SSH config weaknesses, 0.0.0.0 listeners |
| `ssh_intrusion_check` | Parse auth logs: brute force IPs, root logins, new UIDs; params: hours (1-168) |
| `ssh_certbot` | Let's Encrypt: list/renew/renew-all/status/expand/delete; `dryRun:true` *(mutating CONFIRM)* |

### Containers *(CONFIRM mutating)*

| Tool | Description |
|------|-------------|
| `ssh_compose` | docker-compose v2/v1 auto-detect; up/down/ps/logs/pull/build/restart/stop/config/exec *(mutating CONFIRM)* |
| `ssh_docker` | list/logs/restart/stop/start/inspect/stats *(restart/stop/start CONFIRM)* |
| `ssh_k8s` | kubectl: get/describe/logs/exec/apply/delete/rollout/scale/top/events *(apply/delete/scale CONFIRM)* |

### Databases *(write queries CONFIRM)*

| Tool | Description |
|------|-------------|
| `ssh_db` | MySQL/PostgreSQL/Redis/MongoDB/SQLite auto-detect; query/list-dbs/list-tables/stats/ping/slow-queries; write keywords require confirm; query via env var (injection-safe) |

### Web Servers *(CONFIRM reload/restart/enable/disable)*

| Tool | Description |
|------|-------------|
| `ssh_nginx` | test/reload/restart/status/list-sites/enable/disable/logs/show-config |
| `ssh_apache` | test/reload/restart/status/list-sites/enable-site/disable-site/list-mods/enable-mod/disable-mod/logs |

### Storage

| Tool | Description |
|------|-------------|
| `ssh_backup` | tar.gz create/list/restore/prune with rotation *(create/restore/prune CONFIRM)* |
| `ssh_lvm` | pvs/vgs/lvs list/status/extend/create-snapshot/remove-snapshot/resize *(mutating CONFIRM)* |
| `ssh_zfs` | ZFS pools and datasets: list/list-pools/create/destroy/snapshot/rollback/scrub/status/get/set *(mutating CONFIRM)* |

### Performance & Benchmarks

| Tool | Description |
|------|-------------|
| `ssh_benchmark` | Disk (dd/fio), CPU (prime sieve/sysbench), network (iperf3); falls back when tools missing |
| `ssh_port_forward` | Persistent tunnels via systemd+socat: list/create/kill *(create/kill CONFIRM)* |

### Windows Tools *(PowerShell, auto-routed on Windows targets)*

| Tool | Description |
|------|-------------|
| `ssh_win_inventory` | OS/CPU/RAM/disks/NICs via CIM/WMI (read-only) |
| `ssh_win_health` | CPU%/mem%/disk/stopped services/recent errors (read-only) |
| `ssh_win_disk` | Get-PSDrive/Get-Volume/Get-PhysicalDisk (read-only) |
| `ssh_win_metrics` | Structured JSON metrics: cpuPercent/memPercent/uptimeSeconds/processCount (read-only) |
| `ssh_win_service` | list/status/start/stop/restart/enable/disable *(mutating CONFIRM)* |
| `ssh_win_process` | list (top 50 by CPU) / kill by PID or name *(kill CONFIRM)* |
| `ssh_win_user` | list/info/add/remove/passwd/lock/unlock local users *(mutating CONFIRM)* |
| `ssh_win_eventlog` | Get-WinEvent with level filter (error/warning/info/all) |
| `ssh_win_schtask` | list/status/register/unregister/run scheduled tasks *(mutating CONFIRM)* |
| `ssh_win_firewall` | list/add/remove firewall rules *(mutating CONFIRM)* |
| `ssh_win_ip_assign` | list/set static IPv4 address *(set CONFIRM)* |
| `ssh_win_acl` | list/set file ACLs *(set CONFIRM)* |
| `ssh_win_reg` | list/get/set/delete registry values; path must start with HKLM:/HKCU:/etc. *(set/delete CONFIRM)* |
| `ssh_win_wsl` | WSL distributions: list/status/start/stop/set-default/run *(mutating CONFIRM)* |
| `ssh_win_iis` | IIS sites and app pools: list-sites/list-pools/start/stop/restart/status/bindings *(mutating CONFIRM)* |

### Deployment *(CONFIRM)*

| Tool | Description |
|------|-------------|
| `ssh_git` | git ops on remote repo: status/pull/fetch/log/checkout/diff *(pull/checkout CONFIRM)* |
| `ssh_deploy` | Atomic: git pull → buildCmd → restart services → health check → auto-rollback on fail |
| `ssh_rollback` | Restore latest/named backup + restart services + health check |
| `ssh_rsync` | Local rsync; params: src/dst/exclude/delete/checksum/bwlimit *(--delete CONFIRM)* |

### Profile & Infrastructure Management

| Tool | Description |
|------|-------------|
| `ssh_profiles` | List all profiles (no connection made) |
| `ssh_add_profile` | Add/update profile; `shell:"bash\|powershell\|auto"` *(CONFIRM)* |
| `ssh_remove_profile` | Remove a profile *(CONFIRM)* |
| `ssh_list_keys` | List available SSH keys |
| `ssh_add_jump` | Add jump/bastion server *(CONFIRM)* |
| `ssh_remove_jump` | Remove jump server *(CONFIRM)* |
| `ssh_list_jumps` | List configured jump servers |
| `ssh_save_ip_group` | Save named IP group |
| `ssh_remove_ip_group` | Remove IP group |
| `ssh_list_ip_groups` | List all IP groups |

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

- **Dependencies** — installer auto-detects the OS package manager (apt/dnf/yum/apk/brew/pacman/zypper) and installs curl, ssh, node, claude CLI, and sshpass without requiring any manual pre-work. On Windows, enables the built-in OpenSSH capability for ssh.
- **Config loading** — merges `ssh-ops.config.yaml` (project root) with `~/.ssh/ssh-ops.yaml` (machine-wide) and `ssh-ops.dynamic.json` (MCP-added profiles and jump servers). Override or add extra files with the `SSH_OPS_CONFIG` env var (colon-separated paths). Later files win on conflicts.
- **Script builders** — each tool generates a self-contained bash script piped to `bash -s` on the remote. No interactive shell, no agent forwarding required.
- **Auto-retry on transient SSH failures** — 2 retries with 1.5× backoff on connection reset, timeout, kex errors.
- **Batched multi-host execution** — `ssh_run_multi` processes targets in groups of 10 (configurable) to prevent jump server overload.
- **jumpChain (-J multi-hop)** — when `jumpChain` is set in defaults, SSH Ops builds a `-J user@host1,user@host2,...` argument from the chain profiles. SSH handles each hop natively.
- **jumpProfile (nested SSH)** — legacy two-hop mode: connects to jump host, then runs `sudo -n -u <jumpUser> ssh <destination>` from there via a heredoc. Useful when keys for internal targets live on the jump server.
- **localSwitchUser** — when ssh-ops itself runs on a bastion/jump server, set `localSwitchUser` to run `sudo -n -u <user> ssh <destination>` locally.
- **commonUser** — fallback SSH username applied to all target connections that have no `user` set in their profile.
- **Password auth** — profiles with a password use `sshpass -e` with the decrypted password injected via the `SSHPASS` env var. Password never appears in process args.
- **Encryption** — passwords stored as `iv:ciphertext:authtag` (AES-256-GCM). Device key generated at install time (`~/.ssh-ops/.encryption-key`, 0600). Passwords from one machine cannot be decrypted on another.
- **Auth failure tracking** — SSH exit 255 with auth-failure stderr patterns marks the profile `_authFailed: true`. Updating credentials clears the flag automatically.
- **New IP auto-login** — when given an IP not in profiles, SSH Ops tries to connect immediately using the same jump chain and user as existing profiles.
- **Safety** — all sudo uses `sudo -n` (fails instead of prompting). `ssh_file_write` and `ssh_file_patch` create a timestamped `.bak` before modifying.
- **Double confirmation** — critical/destructive operations require two explicit confirmations. The first states what will happen; the second confirms the action is irreversible.
- **Large output export** — when output is expected to exceed ~100 lines, the model exports to a remote `/tmp` file, pulls via `scp` to `~/Downloads/`, and reports the local path rather than streaming raw output through MCP.
- **Auto-update** — on every MCP `initialize`, the server checks GitHub Releases in the background. Set `SSH_OPS_AUTO_UPDATE=1` to enable; off by default.

---

## Testing

Tests use the built-in Node.js test runner — no test framework to install.

```bash
# Run all unit tests
node --test tests/ssh-ops.test.mjs

# Run MCP protocol tests
node --test tests/ssh-mcp-protocol.test.mjs

# Run a single test by name
node --test --test-name-pattern="resolveTarget routes" tests/ssh-ops.test.mjs

# Verify all scripts parse without errors
node --check scripts/ssh-mcp-server.mjs && node --check scripts/ssh-core.mjs
```

CI runs tests against Node 18, 20, and 22 on every push and pull request. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

---

## Troubleshooting

**`Permission denied (publickey)`**
The SSH key for this server is missing or not loaded. Check `~/.ssh/` for a matching key, then add `identityFile: ~/.ssh/your_key` to the profile in `ssh-ops.config.yaml` or via `ssh_add_profile`.

**`sudo: a password is required`**
`localSwitchUser` (or `jumpUser`) relies on passwordless sudo. Grant `NOPASSWD` for the service account in `/etc/sudoers.d/` on the bastion, or use `ssh_sudo_rule` to set it up.

**`Host key verification failed`**
The remote host key is not in `~/.ssh/known_hosts`. Add the following to the `defaults` block in your config:

```yaml
defaults:
  strictHostKeyChecking: accept-new
```

**`sshpass: command not found`**
Required for password-based profiles. Install it:
- macOS: `brew install esolitos/ipa/sshpass`
- Ubuntu/Debian: `sudo apt install sshpass`
- RHEL/CentOS: `sudo yum install sshpass`

**Auto-updates not running**
Auto-updates are disabled by default. Set `SSH_OPS_AUTO_UPDATE=1` in your environment (e.g. in `~/.zshrc` or `~/.bashrc`) to enable background update checks on every `initialize`.

**MCP server not loading skill / no instructions**
The `initialize` response must include an `instructions` field for Claude Code to pick up the skill. Verify by running `node scripts/ssh-mcp-server.mjs` and sending a raw `initialize` request — the response `result` should contain `instructions`. Re-running the installer or `/reload-plugins` in Claude Code reloads the skill.

---

## Security

See [SECURITY.md](SECURITY.md) for the full threat model, trust boundaries, hardening checklist, and vulnerability reporting process.

**Summary:**

- Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/security/advisories/new) — do not open public issues for security bugs.
- Expected response: acknowledgement within 48 hours, fix within 14 days for confirmed issues.
- All mutating tools require `confirm: true`. Pass `dryRun: true` to preview the exact bash script without executing.
- Every tool call is appended to `ssh-ops-audit.log` with passwords redacted.

---

## Contributing

1. Fork the repository and create a branch from `main`.
2. Make your changes. All logic lives in `scripts/` — no build step required.
3. Add or update tests in `tests/` and verify they pass:
   ```bash
   node --test tests/ssh-ops.test.mjs
   node --test tests/ssh-mcp-protocol.test.mjs
   ```
4. Ensure syntax is clean: `node --check scripts/ssh-mcp-server.mjs`
5. Open a pull request against `main`.

**Adding a new tool:** export `toolDefs` (array of MCP tool definition objects) and `handleTool(name, args)` from a new `scripts/ssh-tools-<domain>.mjs` file, then add the import to `_extraModules` in `scripts/ssh-mcp-server.mjs`. See [CLAUDE.md](CLAUDE.md) for the full architecture guide.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

See [CHANGELOG.md](CHANGELOG.md) for version history.
