---
name: ssh-ops
description: Use SSH Ops when inspecting, changing, or running commands on remote SSH servers. Covers inventory, health, disk, log search, network checks, multi-host execution, file read/write/patch (binary-safe), service control, package management, cron CRUD, dynamic profile management with encrypted passwords, and jump/bastion server chain management (SSH -J multi-hop).
---

# SSH Ops

Prefer `ssh-ops` MCP tools when available:

- `ssh_profiles`: list profiles, no connection
- `ssh_run`: run command/script on single remote host
- `ssh_run_multi`: run command on multiple hosts in parallel; `format: "json"` for structured output
- `ssh_inventory`: OS/CPU/RAM/disk/network inventory
- `ssh_disk_report`: disk/inode/container storage pressure
- `ssh_health_report`: load/memory/disk/services/processes/docker snapshot
- `ssh_file_read`: read remote file; `encoding: base64` for binary files
- `ssh_file_write`: write remote file; `encoding: base64` for binary — CONFIRM with user before calling unless told to proceed automatically
- `ssh_file_patch`: edit remote file (line-range or regex) — CONFIRM with user before calling unless told to proceed automatically
- `ssh_service`: systemd control — CONFIRM for start/stop/restart/enable/disable unless told automatically
- `ssh_log_search`: search journal or log file by pattern
- `ssh_network_check`: ping, port probe, TLS cert check from remote server
- `ssh_package`: package management (apt/yum/dnf/apk auto-detect) — CONFIRM for install/remove/update/upgrade unless told automatically
- `ssh_cron`: crontab list/add/remove for any user — CONFIRM for add/remove unless told automatically
- `ssh_add_profile`: add or update an SSH profile dynamically; passwords stored AES-256-GCM encrypted; requires `sshpass` on local machine for password-based auth
- `ssh_remove_profile`: remove a dynamically-added profile
- `ssh_add_jump`: add a jump/bastion server and append to the SSH -J chain; optional `commonUser` sets default user for all target connections; supports password auth
- `ssh_remove_jump`: remove a jump server and auto-remove from chain
- `ssh_list_jumps`: show current jump chain, all jump servers, and commonUser
- `ssh_list_keys`: list SSH private key files in `~/.ssh/` and home directory; call when auth fails or user needs to pick a key for a new profile
- `ssh_ip_assign`: assign one or more IPs (CIDR) to a network interface permanently; auto-detects netplan/NetworkManager/network-scripts/systemd-networkd/rc.local; always runs sudo; CONFIRM with user before calling

CLI fallback from plugin root when MCP unavailable:

```bash
node scripts/ssh-ops.mjs inventory <target>
node scripts/ssh-ops.mjs health <target>
node scripts/ssh-ops.mjs disk <target> / 1
node scripts/ssh-ops.mjs run <target> 'hostname; uptime'
```

## Targets

- Profile name from `ssh-ops.config.yaml`, `~/.ssh/ssh-ops.yaml`, or compatible JSON.
- Raw SSH target: `user@server.example.com` or `server.example.com`.

## Two-Hop Jump Routing

Config defaults with `jumpProfile`, `jumpUser`, `targetUser` route non-jump targets as nested SSH:
1. Connect to `jumpProfile` using its user.
2. Run destination SSH as `jumpUser` on jump server.
3. Connect to final destination as `targetUser`.

## Safety

- When ssh_run / ssh_inventory etc returns `authFailed: true` — call `ssh_list_keys` to show available keys, then ask user for correct key or password, then call `ssh_add_profile` or `ssh_add_jump` to update credentials. Credentials are stored and reused automatically; re-prompt only on failure.
- Read-only tools first for inventory/health/log checks.
- `sudo` uses `sudo -n` — fails instead of prompting.
- **CONFIRM with user before write actions** unless user says to proceed automatically: `ssh_file_write`, `ssh_file_patch`, `ssh_service` (start/stop/restart/enable/disable), `ssh_package` (install/remove/update/upgrade), `ssh_cron` (add/remove).
- Summarize findings after tool execution; skip raw output walls unless asked.
