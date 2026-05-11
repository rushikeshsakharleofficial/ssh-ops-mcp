# SSH Ops

SSH Ops exposes SSH tasks as an MCP server and a plain Node CLI. Works with **Claude Code, Codex, Cursor, VS Code Copilot, Gemini CLI, and Antigravity IDE**. Uses your local `ssh` binary, existing keys, and SSH config. Passwords and credentials stored encrypted (AES-256-GCM, device-specific key).

## Install

**No prerequisites** — all dependencies are auto-installed.

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

Package manager is auto-detected: `apt-get` → `dnf` → `yum` → `apk` → `brew` → `pacman` → `zypper`

**After dependencies:**
- Downloads only needed files to `~/.ssh-ops/` — no git clone, no repo leftovers
- Generates a device-specific AES-256-GCM encryption key at `~/.ssh-ops/.encryption-key` (0600)
- Installs SSH Ops as a **Claude Code skill plugin** (`.skill` ZIP — discovered by `/reload-plugins`) and a **Gemini CLI extension** (`~/.gemini/extensions/ssh-ops/` — enabled in `extension-enablement.json`)
- Registers MCP server with every detected IDE/CLI tool
- Re-running is idempotent — shows "Already registered" for each tool, only updates what changed
- Config and encryption key preserved on re-install
- **Interactive setup wizard** runs on first install (or when config still has demo data): asks for server, jump server, switch user — tests the connection before saving
- **Auto-updates on session start** — checks GitHub Releases silently on every `initialize`

Restart your IDE or CLI session after running.

**Custom install location:**
```bash
# macOS / Linux
SSH_OPS_DIR=~/tools/ssh-ops curl -fsSL https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/main/install.sh | bash

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

- SSH Ops builds `-J ops@bastion.example.com,relay@internal-bastion.example.com` automatically
- Connecting directly to a server in the chain skips the `-J` flag
- Manage jump servers dynamically via `ssh_add_jump` / `ssh_remove_jump`

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

This connects to `bastion` as `operator`, then runs `sudo -n -u relay ssh root@destination` from there — useful when the keys for internal servers live on the jump host.

**Running ssh-ops on the jump server itself (`localSwitchUser`):**

When the MCP server runs directly on a bastion/jump host and needs to reach internal targets, use `localSwitchUser` to switch the local user before running SSH — no outbound hop needed:

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

SSH Ops runs `sudo -n -u relay ssh root@10.0.1.10` locally — ideal when internal keys are owned by a service account on the bastion. Set per-profile or in `defaults`.

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

Output ends with `Verification: ALL PASSED` or `Verification: SOME CHECKS FAILED`. The `curl` check catches misconfigured routing where the IP is assigned but traffic still exits via the default route.

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

Updating credentials via `ssh_add_profile` clears the flag. Stored creds are reused silently on every call — you're only asked again when they fail.

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
| `ssh_file_write` | Overwrite a remote file; auto-backup before write |
| `ssh_file_patch` | Edit a remote file — replace a line range or regex find-and-replace |

### System Management *(confirm before write actions)*

| Tool | Description |
|------|-------------|
| `ssh_service` | Systemd service control — status, start, stop, restart, enable, disable |
| `ssh_package` | Package management — auto-detects apt/yum/dnf/apk; list, search, install, remove, update, upgrade |
| `ssh_cron` | Crontab CRUD for any user — list, add, remove |
| `ssh_ip_assign` | Assign IPs to an interface permanently; accepts inline array, saved group, or local file |
| `ssh_user` | User management — add/del/mod/list/info/passwd/lock/unlock; groups, shell, home, system accounts |
| `ssh_chmod` | chmod + chown + chgrp in one call; optional recursive |
| `ssh_sudo_rule` | Sudoers management via `/etc/sudoers.d/`; validates with `visudo -c`; specific commands, NOPASSWD toggle |

### IP Group Management

| Tool | Description |
|------|-------------|
| `ssh_save_ip_group` | Save a named IP set (ips, iface, gateway, dns) for reuse across servers |
| `ssh_remove_ip_group` | Remove a saved IP group |
| `ssh_list_ip_groups` | List all saved IP groups |

### Profile Management

| Tool | Description |
|------|-------------|
| `ssh_add_profile` | Add or update an SSH profile at runtime; passwords AES-256-GCM encrypted; supports `localSwitchUser` for bastion-local execution |
| `ssh_remove_profile` | Remove a dynamically-added profile |
| `ssh_list_keys` | List SSH private key files in `~/.ssh/` and home directory |

### Jump Server Management

| Tool | Description |
|------|-------------|
| `ssh_add_jump` | Add a jump/bastion server; appends to SSH `-J` chain; optional `commonUser` |
| `ssh_remove_jump` | Remove a jump server and prune it from the chain |
| `ssh_list_jumps` | Show current jump chain, all jump servers, and `commonUser` |

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
- **jumpChain (-J multi-hop)** — when `jumpChain` is set in defaults, SSH Ops builds a `-J user@host1,user@host2,...` argument from the chain profiles. SSH handles each hop natively. Connecting to a server that's already in the chain skips the flag.
- **jumpProfile (nested SSH)** — legacy two-hop mode: connects to jump host, then runs `sudo -n -u <jumpUser> ssh <destination>` from there via a heredoc. Useful when keys for internal targets live on the jump server.
- **localSwitchUser** — when ssh-ops itself runs on a bastion/jump server, set `localSwitchUser` to run `sudo -n -u <user> ssh <destination>` locally. Keys stay under the service account; the MCP process runs as the operator user.
- **commonUser** — fallback SSH username applied to all target connections that have no `user` set in their profile. Stored in dynamic config defaults.
- **Password auth** — profiles with a password use `sshpass -e` with the decrypted password injected via the `SSHPASS` env var. Password never appears in process args. Requires `sshpass` installed locally.
- **Encryption** — passwords stored as `iv:ciphertext:authtag` (AES-256-GCM). Device key generated at install time (`~/.ssh-ops/.encryption-key`, 0600). Passwords from one machine cannot be decrypted on another.
- **Auth failure tracking** — SSH exit 255 with auth-failure stderr patterns marks the profile `_authFailed: true` in the dynamic config. Updating credentials clears the flag automatically.
- **New IP auto-login** — when given an IP not in profiles, SSH Ops tries to connect immediately using the same jump chain and user as existing profiles. Saves the profile on success; asks for credentials only on failure.
- **IP assignment** — `ssh_ip_assign` runs `ip addr add` immediately, persists via auto-detected network manager (netplan → NetworkManager → network-scripts → systemd-networkd → rc.local), then runs automatic verification: private IPs get gateway + self ping; public IPs get `ping -I $IP 8.8.8.8` + `curl --interface $IP` to confirm outbound traffic exits via the correct source IP. Accepts inline `ips`, a saved `group` name, or a `fromFile` path. `network-scripts` creates `ifcfg-eth0:N` aliases and skips already-persisted IPs.
- **IP groups** — `ssh_save_ip_group` stores named IP sets (with iface, gateway, dns) in `ssh-ops.dynamic.json`. Reference by name in `ssh_ip_assign(group="name")` to apply the same set to multiple servers without repeating the IP list.
- **User management** — `ssh_user` generates `useradd`/`userdel`/`usermod`/`chpasswd` scripts based on the action. Passwords set via `chpasswd` (pipe, not CLI arg). All actions verify the user exists before proceeding.
- **Permissions** — `ssh_chmod` combines `chmod`/`chown`/`chgrp` in one call. When both `owner` and `group` are set, uses `chown owner:group` for efficiency. Shows `ls -la` before and after for confirmation.
- **Sudoers** — `ssh_sudo_rule` writes to `/etc/sudoers.d/<username>` (never edits `/etc/sudoers` directly). Validates with `visudo -c` before accepting — invalid rules are auto-removed to prevent lockout. Supports specific command lists (e.g. `/bin/systemctl,/usr/bin/apt`) and `NOPASSWD` toggle.
- **Skill activation** — Claude Code discovers skills from `.skill` ZIP archives. Installer creates `ssh-ops.skill` automatically. Run `/reload-plugins` after install. Gemini CLI uses `~/.gemini/extensions/ssh-ops/` which the installer creates and enables.
- **Safety** — all sudo uses `sudo -n` (fails instead of prompting). `ssh_file_write` and `ssh_file_patch` create a timestamped `.bak` before modifying.
- **Double confirmation** — critical/destructive operations (data deletion, service stop/restart on key services, user removal, bulk multi-host writes, reboots) require two explicit "yes" confirmations before any tool is called. The first confirmation states what will happen; the second confirms the action is irreversible.
- **Large output export** — when output is expected to exceed ~100 lines (user lists, log dumps, bulk queries), the model exports to a remote `/tmp` file, pulls via `scp` to `~/Downloads/`, and reports the local path rather than streaming raw output through MCP.
- **Auto-update** — on every MCP `initialize`, the server checks GitHub Releases in the background. If a newer version exists, updated script files are downloaded silently and `VERSION` is bumped. No restart needed for the next session.
