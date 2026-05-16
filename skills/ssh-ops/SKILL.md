---
name: ssh-ops
description: SSH Ops MCP — 48 tools for remote SSH ops: commands, inventory, health, disk, logs, files, services, packages, cron, users, docker, metrics, firewall, TLS certs, port scan, log tail, memory, timers, mounts, git, backups, templates, snapshots, server comparison, output diff watching, IP assignment, jump servers, file transfer, process management, env vars.
---

# SSH Ops

Use `ssh-ops` MCP tools. Target = profile name or `user@host`.

## Tools

**Read-only**
- `ssh_profiles` — list profiles (no connect)
- `ssh_inventory` — OS/CPU/RAM/disk/network
- `ssh_disk_report` — disk/inode/container storage
- `ssh_health_report` — load/services/processes/docker; fires alertWebhook if thresholds breached
- `ssh_log_search` — journal or file grep; params: unit/pattern/lines/since/path
- `ssh_network_check` — ping/port/TLS from remote server
- `ssh_ping` — TCP reachability without auth; params: target/host/port/timeoutMs/count; returns reachable/avgLatencyMs
- `ssh_metrics` — /proc metrics (no agent); returns cpuPercent/memPercent/memUsedMB/loadAvg/uptimeSeconds/diskIO/netIO
- `ssh_diff` — compare remote file vs local or remote-vs-remote; params: target/remotePath/localPath/target2/remotePath2/context
- `ssh_ssl_cert` — TLS certificate expiry + subject/SANs/fingerprint for a domain; runs openssl from remote; params: target/host/port
- `ssh_port_scan` — listening ports via ss (netstat fallback); params: target/proto(tcp|udp|all)/sudo/filter
- `ssh_memory_report` — detailed memory: totals/swap/huge pages/top-N processes by RSS; params: target/topN
- `ssh_snapshot` — full server state JSON: OS/CPU/mem/disk/load/running services/ports/users/packages/top procs; params: target/timeoutMs

**Exec**
- `ssh_run` — single host; params: command/target/sudo/mode/cwd/jumpHost/sshOptions
- `ssh_run_multi` — parallel multi-host; `format:"json"` for structured output; `group:"prod"` targets all profiles with matching group field
- `ssh_run_watch` — run command + diff vs last run; first call returns full output, subsequent calls return only changed lines (unified diff); params: command/target/resetCache — **use this to monitor recurring state without flooding context**

**Files** *(CONFIRM before write)*
- `ssh_file_read` — `encoding:"base64"` for binary
- `ssh_file_write` — auto-backup; `sudo` param for root files
- `ssh_file_patch` — line-range or regex replace
- `ssh_tail` — read last N lines of remote file; optional followSeconds (like tail -f); params: target/path/lines/followSeconds
- `ssh_template` — render `{{VAR}}` template locally, write rendered content to remote path; params: target/template/vars/remotePath/sudo/backup *(CONFIRM)*

**Security** *(list read-only; add/remove/flush CONFIRM)*
- `ssh_firewall` — manage ufw/firewalld/iptables rules; auto-detects active manager; params: target/action(list|add|remove|flush)/protocol/port/source/ruleSpec

**System** *(CONFIRM before write)*
- `ssh_service` — status/start/stop/restart/enable/disable
- `ssh_package` — apt/yum/dnf/apk auto-detect; list/search/install/remove/update/upgrade
- `ssh_cron` — list/add/remove for any user
- `ssh_systemd_timer` — list/status/enable/disable/start/stop systemd timers; params: target/action/timer *(enable/disable/start/stop CONFIRM)*
- `ssh_ip_assign` — permanent IP; `ips`/`group`/`fromFile`; auto-detects netplan/NM/network-scripts/networkd/rc.local; always sudo
- `ssh_user` — add/del/mod/list/info/passwd/lock/unlock; groups/shell/home/system
- `ssh_chmod` — chmod+chown+chgrp; mode/owner/group/recursive
- `ssh_sudo_rule` — /etc/sudoers.d/; visudo -c validation; `commands` required (no default ALL); nopasswd defaults false; list/add/remove
- `ssh_docker` — list/logs/restart/stop/start/inspect/stats; params: action/container/lines/since/sudo
- `ssh_env` — /etc/environment list/get/set/unset; params: action/key/value
- `ssh_process` — list processes or kill; params: action/pid/processName/signal/filter
- `ssh_script` — upload+run local script on remote via bash; params: localScript/args/sudo/cwd; must be within plugin dir
- `ssh_transfer` — scp local↔remote or remote↔remote; params: src/dst/recursive; use `profile:path` notation
- `ssh_mount` — list mounts (findmnt) or mount/umount filesystems; params: target/action(list|mount|umount)/device/mountpoint/fstype/options *(mount/umount CONFIRM)*

**Deployment / Storage** *(CONFIRM for writes)*
- `ssh_git` — git ops on remote repo; params: target/action(status|pull|fetch|log|checkout|diff)/repoPath/branch/remote/logLines *(pull/checkout CONFIRM)*
- `ssh_backup` — tar.gz backup management; params: target/action(create|list|restore|prune)/source/dest/backupFile/restoreTo/maxCount *(create/restore/prune CONFIRM)*

**Analysis**
- `ssh_compare` — snapshot two servers and diff side-by-side; params: target1/target2/timeoutMs — shows OS/kernel/services/ports/users/packages differences

**IP groups**
- `ssh_save_ip_group` / `ssh_remove_ip_group` / `ssh_list_ip_groups`

**Profile mgmt** *(CONFIRM for add/remove)*
- `ssh_add_profile(name,host,user,port,password,identityFile,access,jumpProfile,jumpUser,targetUser,localSwitchUser,group,allowedCommands,extends,hidden)`
- `ssh_remove_profile` / `ssh_list_keys`

**Jump servers** *(CONFIRM for add/remove)*
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

## Profile features

- **`allowedCommands`** — per-profile command allowlist; `ssh_run` rejects commands not starting with a listed prefix
  ```
  ssh_add_profile(name="prod", host="x.x.x.x", allowedCommands=["systemctl status","df -h","journalctl -n"])
  ```
- **`group`** — tag profiles for `ssh_run_multi` group targeting: `group:"prod"` runs on all prod-tagged profiles
- **`extends`** — inherit another profile's fields (child wins on conflict, single-level only):
  ```yaml
  base: { user: ubuntu, port: 22 }
  web-1: { extends: base, host: 10.0.1.1, group: prod }
  ```
- **`hidden:true`** — profile excluded from `ssh_profiles` listing but still usable when targeted directly
- **`exposeProfiles:false`** config — hides `ssh_profiles` tool from tools/list entirely

## dryRun + reason

All mutating tools accept:
- `dryRun:true` → returns the bash script that would run, without executing
- `reason:"why"` → logged to `ssh-ops-audit.log` and shown in confirm message

## Audit + rate limiting

- All tool calls logged to `ssh-ops-audit.log` (passwords redacted)
- `rateLimitPerMin` config (default 60) — per target per minute

## Large output — export to local file

When expected output > ~100 lines (user lists, log dumps, full inventories, bulk data):
**Do NOT stream back through MCP** — wastes tokens and hits limits.

Instead:
1. `ssh_run` → pipe output to remote temp file:
   ```
   ssh_run(target=X, command="<cmd> > /tmp/ssh-ops-export.ext")
   ```
2. Pull to local via Bash scp:
   ```bash
   scp user@host:/tmp/ssh-ops-export.ext ~/Downloads/ssh-ops-export.ext
   ```
3. Tell user: "Saved to ~/Downloads/ssh-ops-export.ext — open to review."
4. Clean up remote: `ssh_run(command="rm /tmp/ssh-ops-export.ext")`

**Extension by situation:**

| Data type | Extension |
|-----------|-----------|
| User/email lists, tables | `.csv` |
| Logs, journal output | `.txt` |
| JSON API / structured | `.json` |
| Config file dumps | `.conf` / `.yaml` |
| Mixed/unknown | `.txt` |

**Trigger on:** "list all users", "export logs", "show all X", "dump config", any query where result set is unbounded or known large.

## Safety

- `authFailed:true` → `ssh_list_keys` → update via `ssh_add_profile`/`ssh_add_jump`; creds reused silently until failure
- Read-only first; sudo = `sudo -n` (never prompts)
- CONFIRM writes: `ssh_file_write/patch`, `ssh_service` (non-status), `ssh_package` (non-list/search), `ssh_cron` (add/remove), `ssh_ip_assign`, `ssh_user` (add/del/mod/passwd), `ssh_chmod`, `ssh_sudo_rule` (add/remove), `ssh_add_profile`, `ssh_remove_profile`, `ssh_add_jump`, `ssh_remove_jump`, `ssh_run`+`ssh_run_multi` (sudo:true), `ssh_docker` (restart/stop/start), `ssh_env` (set/unset), `ssh_process` (kill), `ssh_script`, `ssh_transfer`, `ssh_firewall` (add/remove/flush), `ssh_systemd_timer` (enable/disable/start/stop), `ssh_mount` (mount/umount), `ssh_git` (pull/checkout), `ssh_backup` (create/restore/prune), `ssh_template`
- Summarize output; skip raw walls unless asked

## Mutating tools — confirm param required

All write/mutating tools require `confirm:true` parameter, or server returns error.
Mutating: ssh_file_write, ssh_file_patch, ssh_service (start/stop/restart/enable/disable),
ssh_package (install/remove/update/upgrade), ssh_cron (add/remove), ssh_ip_assign,
ssh_user (add/del/mod/passwd/lock/unlock), ssh_chmod, ssh_sudo_rule (add/remove),
ssh_add_profile, ssh_remove_profile, ssh_add_jump, ssh_remove_jump,
ssh_run (sudo:true), ssh_run_multi (sudo:true),
ssh_docker (restart/stop/start), ssh_env (set/unset), ssh_process (kill),
ssh_script, ssh_transfer,
ssh_firewall (add/remove/flush), ssh_systemd_timer (enable/disable/start/stop),
ssh_mount (mount/umount), ssh_git (pull/checkout),
ssh_backup (create/restore/prune), ssh_template.

## Double confirmation — critical / destructive commands

For the operations below, ask **twice** before executing. First ask states what will happen; second ask requires explicit "yes" before calling any tool.

**Requires double confirmation:**

| Category | Triggers |
|----------|---------|
| Data destruction | `rm -rf`, `dd`, `mkfs`, `shred`, `truncate`, `> file` (overwrite), `DROP TABLE`, `wipefs` |
| Service impact | `ssh_service` restart/stop/disable on `nginx`, `mysql`, `postgresql`, `redis`, `sshd`, `docker`, `kubelet` or any db/web/auth service |
| User/access changes | `ssh_user` del (especially with `removeHome:true`), `ssh_sudo_rule` remove, `ssh_user` passwd on root/admin |
| Package removal | `ssh_package` remove/purge on system-critical packages (kernel, openssh, systemd, libc) |
| IP/network changes | `ssh_ip_assign` on production servers; any command touching default route or firewall rules |
| Bulk operations | `ssh_run_multi` with any write/delete/restart command across 3+ hosts |
| Reboot/shutdown | `reboot`, `shutdown`, `halt`, `poweroff` |

**Format:**

```
⚠ CRITICAL OPERATION — [what will happen, which target, what is irreversible]

Confirmation 1/2: Type "yes" to proceed →
[wait for user]

Final confirmation 2/2: This cannot be undone. Type "yes" again to execute →
[wait for user — then call tool]
```

If user says "proceed automatically" or "no confirmation needed" at session start, skip to single confirm for writes but still double-confirm for irreversible destructive actions (data deletion, reboots, mass multi-host writes).

## Output diff watching (context-efficient monitoring)

`ssh_run_watch` stores last output per target+command in memory. On subsequent calls, returns only changed lines as a unified diff. Use for recurring checks where you only care about what changed.

```
# First call — full output
ssh_run_watch(target="prod", command="systemctl list-units --state=failed")

# Second call — only shows new failures or recovered services
ssh_run_watch(target="prod", command="systemctl list-units --state=failed")
# Returns: "[watch] No change since 2026-05-16T10:30:00Z"
# OR:      "[watch] Changed since ...: <diff>"
```

Use `resetCache:true` to force a fresh full output.

## Server comparison and drift detection

```
# Snapshot individual server
ssh_snapshot(target="prod-1")  → JSON with OS/services/ports/packages/users

# Compare two servers for drift
ssh_compare(target1="prod-1", target2="prod-2")  → diff report showing differences
```

## Auto-update

Auto-update disabled by default. Set `SSH_OPS_AUTO_UPDATE=1` env var to enable.

## Truncation

Truncation messages include exact byte counts: `[OUTPUT TRUNCATED: received 2345678 bytes, limit 2000000 bytes — 345678 bytes dropped]`.
