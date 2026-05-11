---
name: ssh-ops
description: SSH Ops MCP — run commands, inventory, health, disk, logs, files, services, packages, cron, users, IP assignment, jump servers on remote hosts via SSH.
---

# SSH Ops

Use `ssh-ops` MCP tools. Target = profile name or `user@host`.

## Tools

**Read-only**
- `ssh_profiles` — list profiles (no connect)
- `ssh_inventory` — OS/CPU/RAM/disk/network
- `ssh_disk_report` — disk/inode/container storage
- `ssh_health_report` — load/services/processes/docker
- `ssh_log_search` — journal or file grep; params: unit/pattern/lines/since/path
- `ssh_network_check` — ping/port/TLS from remote server

**Exec**
- `ssh_run` — single host; params: command/target/sudo/mode/cwd/jumpHost/sshOptions
- `ssh_run_multi` — parallel multi-host; `format:"json"` for structured output

**Files** *(CONFIRM before write)*
- `ssh_file_read` — `encoding:"base64"` for binary
- `ssh_file_write` — auto-backup; `sudo` param for root files
- `ssh_file_patch` — line-range or regex replace

**System** *(CONFIRM before write)*
- `ssh_service` — status/start/stop/restart/enable/disable
- `ssh_package` — apt/yum/dnf/apk auto-detect; list/search/install/remove/update/upgrade
- `ssh_cron` — list/add/remove for any user
- `ssh_ip_assign` — permanent IP; `ips`/`group`/`fromFile`; auto-detects netplan/NM/network-scripts/networkd/rc.local; always sudo
- `ssh_user` — add/del/mod/list/info/passwd/lock/unlock; groups/shell/home/system
- `ssh_chmod` — chmod+chown+chgrp; mode/owner/group/recursive
- `ssh_sudo_rule` — /etc/sudoers.d/; visudo -c validation; commands/nopasswd; list/add/remove

**IP groups**
- `ssh_save_ip_group` / `ssh_remove_ip_group` / `ssh_list_ip_groups`

**Profile mgmt**
- `ssh_add_profile(name,host,user,port,password,identityFile,access,jumpProfile,jumpUser,targetUser,localSwitchUser)`
- `ssh_remove_profile` / `ssh_list_keys`

**Jump servers**
- `ssh_add_jump(name,host,user,commonUser)` — appends to -J chain
- `ssh_remove_jump` / `ssh_list_jumps`

## New IP — auto-try first, ask later

Unknown IP/host → do NOT ask for credentials first:
1. `ssh_profiles` → note jump chain / commonUser
2. Try `ssh_run(host=<IP>, user=<commonUser|root>, command="hostname && uptime")` with same routing as existing profiles
3. Success → `ssh_add_profile`, proceed. Failure → report error, ask user.

## Routing modes

| Config | Behavior |
|--------|----------|
| `jumpChain: [b1,b2]` | SSH `-J user@b1,user@b2` multi-hop |
| `jumpProfile`+`jumpUser`+`targetUser` | Connect to jump host, run `sudo -n -u jumpUser ssh targetUser@dest` from there |
| `localSwitchUser` | ssh-ops IS on bastion — runs `sudo -n -u <user> ssh dest` locally; do NOT add jump server |

`localSwitchUser` per-profile: `ssh_add_profile(name="web1", host="10.0.1.10", localSwitchUser="relay")`
Or globally in `defaults.localSwitchUser`.

## Safety

- `authFailed:true` → `ssh_list_keys` → update via `ssh_add_profile`/`ssh_add_jump`; creds reused silently until failure
- Read-only first; sudo = `sudo -n` (never prompts)
- CONFIRM writes: `ssh_file_write/patch`, `ssh_service` (non-status), `ssh_package` (non-list/search), `ssh_cron` (add/remove), `ssh_ip_assign`, `ssh_user` (add/del/mod/passwd), `ssh_chmod`, `ssh_sudo_rule` (add/remove)
- Summarize output; skip raw walls unless asked
