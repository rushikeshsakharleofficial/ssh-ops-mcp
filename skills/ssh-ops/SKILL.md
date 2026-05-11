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
- `ssh_add_profile`: add or update an SSH profile dynamically; passwords stored AES-256-GCM encrypted; requires `sshpass` on local machine for password-based auth; `localSwitchUser` for bastion-local execution (see below)
- `ssh_remove_profile`: remove a dynamically-added profile
- `ssh_add_jump`: add a jump/bastion server and append to the SSH -J chain; optional `commonUser` sets default user for all target connections; supports password auth
- `ssh_remove_jump`: remove a jump server and auto-remove from chain
- `ssh_list_jumps`: show current jump chain, all jump servers, and commonUser
- `ssh_list_keys`: list SSH private key files in `~/.ssh/` and home directory; call when auth fails or user needs to pick a key for a new profile
- `ssh_user`: manage Linux users — add/del/mod/list/info/passwd/lock/unlock; handles groups, shell, home dir, system accounts; CONFIRM for add/del/mod/passwd
- `ssh_chmod`: chmod + chown + chgrp in one call; mode/owner/group/recursive; CONFIRM before calling
- `ssh_sudo_rule`: manage sudoers rules via /etc/sudoers.d/; validates with visudo -c; supports specific commands, NOPASSWD toggle; CONFIRM for add/remove
- `ssh_ip_assign`: assign IPs to an interface permanently; accepts `ips` array, `group` name, or `fromFile` path to local JSON/YAML; auto-detects netplan/NetworkManager/network-scripts/systemd-networkd/rc.local; always runs sudo; CONFIRM before calling
- `ssh_save_ip_group`: save a named set of IPs (with iface/gateway/dns) to dynamic config for reuse
- `ssh_remove_ip_group`: remove a saved IP group
- `ssh_list_ip_groups`: list all saved IP groups

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

## New IP / unknown server — auto-try default login

When the user gives an IP or hostname that is NOT in `ssh_profiles`:

1. Call `ssh_profiles` to check existing profiles and note the current jump chain / commonUser.
2. **Try connecting immediately** using the same method as existing profiles — do NOT ask for credentials first:
   - If profiles use `jumpProfile` + `jumpUser` → try `ssh_run(host=<IP>, user=<commonUser or root>, jumpProfile=<existingJump>, jumpUser=<existingJumpUser>, command="hostname && uptime")`
   - If profiles use `jumpChain` → try `ssh_run(host=<IP>, user=<commonUser or root>, command="hostname && uptime")`
   - If profiles connect directly → try `ssh_run(host=<IP>, user=<commonUser or root>, command="hostname && uptime")`
3. If connection succeeds → save as profile with `ssh_add_profile`, then proceed with the requested task.
4. If connection fails → report the error and ask the user for the correct user/key/jump method.

**Never ask "do you want me to connect?" — just try using the default method and report what happened.**

## Two-Hop Jump Routing

Config defaults with `jumpProfile`, `jumpUser`, `targetUser` route non-jump targets as nested SSH:
1. Connect to `jumpProfile` using its user.
2. Run destination SSH as `jumpUser` on jump server.
3. Connect to final destination as `targetUser`.

## Running on a Jump Server (localSwitchUser)

When ssh-ops MCP is running directly on a bastion/jump server and needs to reach internal hosts:
- Use `localSwitchUser` in the profile or defaults to switch the local user before running SSH.
- ssh-ops runs `sudo -n -u <localSwitchUser> ssh <destination>` on the local machine.
- Keys should be present under `<localSwitchUser>`'s `~/.ssh/` on the bastion.

When a user gives you internal IPs/hosts and ssh_profiles shows `localSwitchUser` is set:
- Use `ssh_run(target=<IP>, localSwitchUser=<user>, command="hostname")` directly.
- Do NOT add a jump server — you're already on the bastion.

Add via `ssh_add_profile(name="web1", host="10.0.1.10", localSwitchUser="relay")` or set in `defaults.localSwitchUser` for all profiles.

## Safety

- When ssh_run / ssh_inventory etc returns `authFailed: true` — call `ssh_list_keys` to show available keys, then ask user for correct key or password, then call `ssh_add_profile` or `ssh_add_jump` to update credentials. Credentials are stored and reused automatically; re-prompt only on failure.
- Read-only tools first for inventory/health/log checks.
- `sudo` uses `sudo -n` — fails instead of prompting.
- **CONFIRM with user before write actions** unless user says to proceed automatically: `ssh_file_write`, `ssh_file_patch`, `ssh_service` (start/stop/restart/enable/disable), `ssh_package` (install/remove/update/upgrade), `ssh_cron` (add/remove).
- Summarize findings after tool execution; skip raw output walls unless asked.
