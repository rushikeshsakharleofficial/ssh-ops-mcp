---
name: ssh-ops
description: Use SSH Ops for all remote SSH server operations — 35 tools covering inventory, health, metrics, files, services, packages, cron, users, docker, IP assignment, process management, env vars, file transfer, and jump server management.
---

# SSH Ops

Prefer `ssh-ops` MCP tools when available. Target = profile name or `user@host`.

## Read-only tools

- `ssh_profiles` — list profiles (no connect); `exposeProfiles:false` config hides this tool
- `ssh_inventory` — OS/CPU/RAM/disk/network inventory
- `ssh_disk_report` — disk/inode/container storage
- `ssh_health_report` — load/services/processes/docker; fires alertWebhook on threshold breach
- `ssh_log_search` — journal or file grep; params: unit/pattern/lines/since/path
- `ssh_network_check` — ping/port/TLS from remote server
- `ssh_ping` — TCP reachability without auth; params: target/host/port/timeoutMs/count
- `ssh_metrics` — /proc metrics (no agent needed); returns cpuPercent/memPercent/loadAvg/uptimeSeconds
- `ssh_diff` — compare remote file vs local or remote-vs-remote; params: target/remotePath/localPath/target2/remotePath2

## Execution

- `ssh_run` — single host; params: command/target/sudo/mode/cwd/sshOptions; `sudo:true` requires `confirm:true`
- `ssh_run_multi` — parallel multi-host; `format:"json"`; `group:"prod"` targets all profiles in that group

## Files *(confirm required for writes)*

- `ssh_file_read` — `encoding:"base64"` for binary
- `ssh_file_write` — auto-backup; `sudo` for root files; `followSymlinks:false` by default
- `ssh_file_patch` — line-range or regex replace
- `ssh_script` — run local script file on remote; localScript must be within plugin dir
- `ssh_transfer` — scp local↔remote or remote↔remote; use `profile:path` notation

## System *(confirm required for write actions)*

- `ssh_service` — status/start/stop/restart/enable/disable
- `ssh_package` — apt/yum/dnf/apk auto-detect; list/search/install/remove/update/upgrade
- `ssh_cron` — list/add/remove for any user
- `ssh_ip_assign` — permanent IP assignment; ips/group/fromFile params; always sudo
- `ssh_user` — add/del/mod/list/info/passwd/lock/unlock
- `ssh_chmod` — chmod+chown+chgrp; mode/owner/group/recursive
- `ssh_sudo_rule` — /etc/sudoers.d/; `commands` required (no "ALL" default); nopasswd:false default
- `ssh_docker` — list/logs/restart/stop/start/inspect/stats containers
- `ssh_env` — /etc/environment list/get/set/unset
- `ssh_process` — list processes or kill by pid/name

## IP groups

- `ssh_save_ip_group` / `ssh_remove_ip_group` / `ssh_list_ip_groups`

## Profile mgmt *(confirm for add/remove)*

- `ssh_add_profile(name,host,user,port,password,identityFile,access,jumpProfile,jumpUser,targetUser,localSwitchUser,group,allowedCommands,extends,hidden)`
- `ssh_remove_profile` / `ssh_list_keys`

## Jump servers *(confirm for add/remove)*

- `ssh_add_jump(name,host,user,commonUser)` — appends to -J chain
- `ssh_remove_jump` / `ssh_list_jumps`

## Profile features

- **`allowedCommands`** — per-profile command prefix allowlist; `ssh_run` rejects non-matching commands
- **`group`** — tag profiles; `ssh_run_multi(group:"prod")` targets all in group
- **`extends`** — inherit another profile's fields; single-level only
- **`hidden:true`** — excludes from `ssh_profiles` listing but still usable directly

## dryRun + reason

All mutating tools accept:
- `dryRun:true` → previews bash script without executing
- `reason:"why"` → logged to `ssh-ops-audit.log` and shown in confirm message

## Routing

| Config | Behavior |
|--------|----------|
| `jumpChain: [b1,b2]` | SSH `-J user@b1,user@b2` multi-hop |
| `jumpProfile`+`jumpUser`+`targetUser` | Nested SSH via jump host |
| `localSwitchUser` | ssh-ops runs on bastion — `sudo -n -u <user> ssh dest` locally |

## Large output — export pattern

When output > ~100 lines, pipe to remote file then scp locally:
```bash
ssh_run(target=X, command="<cmd> > /tmp/export.txt")
# then locally:
scp user@host:/tmp/export.txt ~/Downloads/
```

## Safety

- `authFailed:true` → `ssh_list_keys` → update via `ssh_add_profile`; cleared on next success
- `sudo` = `sudo -n` (never prompts)
- All tool calls logged to `ssh-ops-audit.log`
- `rateLimitPerMin` config (default 60) per target

## Confirm required

ssh_file_write/patch, ssh_service (non-status), ssh_package (non-list/search), ssh_cron (add/remove), ssh_ip_assign, ssh_user (add/del/mod/passwd/lock/unlock), ssh_chmod, ssh_sudo_rule (add/remove), ssh_add_profile, ssh_remove_profile, ssh_add_jump, ssh_remove_jump, ssh_run+ssh_run_multi (sudo:true), ssh_docker (restart/stop/start), ssh_env (set/unset), ssh_process (kill), ssh_script, ssh_transfer.

## CLI fallback

```bash
node scripts/ssh-ops.mjs run <target> 'hostname; uptime'
node scripts/ssh-ops.mjs inventory <target>
node scripts/ssh-ops.mjs health <target>
node scripts/ssh-ops.mjs add          # interactive profile wizard
node scripts/ssh-ops.mjs export <file.enc>
node scripts/ssh-ops.mjs import <file.enc>
```
