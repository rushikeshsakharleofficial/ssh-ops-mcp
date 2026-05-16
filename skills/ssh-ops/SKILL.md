---
name: ssh-ops
description: SSH Ops MCP — 88 tools for remote SSH ops across Linux, BSD, macOS, and Windows. Covers: exec, inventory, health, files, services, packages (14 managers), cron, timers, users, docker, compose, kubernetes, databases (5 engines), nginx, apache, firewall, TLS/certs/certbot, port scan, fail2ban, security audit, intrusion detection, authorized_keys, LVM, sysctl, swap, kernel, ulimits, rsync, atomic deploy, rollback, fleet health, anomaly detection, change tracking, perf, dmesg, tcpdump, DNS, traceroute, /etc/hosts, mounts, git, backups, templates, snapshots, server diff, output diff watching, IP groups, jump servers, process management, env vars.
---

# SSH Ops — 75 Tools

Target = profile name OR `user@host`. All tools accept `target:` param.

---

## Windows Support

Windows SSH (OpenSSH for Windows, built-in since Windows 10 1809 / Server 2019) is fully supported.

**Auto-detection:** On first connect to any target, ssh-ops probes the OS (`uname || ver`). If Windows is detected, all commands automatically route to PowerShell. Cached per session (one probe).

**Manual override:** Set `shell:"powershell"` on the profile to skip auto-detection:
```
ssh_add_profile(name="winbox", host="192.168.1.100", user="Administrator", shell="powershell")
```

**Mode param:** `ssh_run` accepts `mode:"powershell"` to force PowerShell for a single call.

**Linux-only tools on Windows:** `ssh_inventory`, `ssh_service`, `ssh_health_report`, `ssh_disk_report`, `ssh_metrics`, `ssh_process`, `ssh_log_search`, `ssh_cron`, `ssh_user`, `ssh_chmod`, `ssh_sudo_rule`, `ssh_ip_assign` — these return a clear error with the Windows equivalent to use.

**`ssh_package` and `ssh_file_*` are cross-platform** — auto-route to PowerShell scripts on Windows (winget/choco/scoop for packages; `Get-Content`/`Set-Content` for files).

---

## Quick Tool Selector

| Goal | Tool |
|------|------|
| Run a command | `ssh_run` |
| Run on many servers | `ssh_run_multi` / `ssh_fleet_health` |
| Monitor changes over time | `ssh_run_watch` |
| Server health overview | `ssh_health_report` |
| Full fleet status | `ssh_fleet_health` |
| Compare two servers | `ssh_compare` |
| Detect config drift | `ssh_snapshot` + `ssh_compare` |
| Detect metric anomalies | `ssh_anomaly` |
| Post-deploy verification | `ssh_change_tracker` |
| Check disk space | `ssh_disk_report` |
| Check memory | `ssh_memory_report` |
| Performance snapshot | `ssh_perf` |
| List running processes | `ssh_process` action=list |
| Read log file | `ssh_tail` / `ssh_log_search` |
| Capture packets | `ssh_tcpdump` |
| Check TLS cert | `ssh_ssl_cert` |
| Manage firewall | `ssh_firewall` |
| Security scan | `ssh_audit` |
| Check for intrusion | `ssh_intrusion_check` |
| Manage SSH keys | `ssh_authorized_keys` |
| Manage Let's Encrypt | `ssh_certbot` |
| Install package | `ssh_package` action=install |
| Manage service | `ssh_service` |
| Manage docker containers | `ssh_docker` |
| Manage docker-compose | `ssh_compose` |
| Run kubectl | `ssh_k8s` |
| Query database | `ssh_db` |
| Manage nginx | `ssh_nginx` |
| Manage apache | `ssh_apache` |
| Edit remote file | `ssh_file_write` / `ssh_file_patch` |
| Sync files | `ssh_rsync` / `ssh_transfer` |
| Deploy code | `ssh_deploy` |
| Rollback deployment | `ssh_rollback` |
| Manage LVM | `ssh_lvm` |
| Kernel parameters | `ssh_sysctl` |
| DNS resolution from server | `ssh_dns_check` |
| Trace network path | `ssh_traceroute` |

---

## Tool Reference

### Exec
- `ssh_run` — single host; params: command/target/sudo/mode/cwd/jumpHost/sshOptions
- `ssh_run_multi` — parallel multi-host; `group:"prod"` targets all profiles with matching group; `format:"json"` for structured output
- `ssh_run_watch` — run + diff vs last output; first call = full, subsequent = changed lines only; `resetCache:true` to reset *(saves AI context)*
- `ssh_script` — upload+run local script file on remote; params: localScript/args/sudo/cwd

### Inventory & Health
- `ssh_inventory` — OS/CPU/RAM/DMI/disks/PCI/network/load/service health
- `ssh_health_report` — load/memory/disk/failed units/processes/docker; fires alertWebhook if thresholds breached
- `ssh_disk_report` — df/inode/du/Docker storage hints; params: target/path/depth
- `ssh_metrics` — structured /proc metrics (no agent): cpuPercent/memPercent/memUsedMB/loadAvg/uptimeSeconds/diskIO/netIO
- `ssh_memory_report` — detailed memory: totals/swap/huge pages/top-N processes by RSS; params: target/topN
- `ssh_snapshot` — full server state JSON: OS/CPU/mem/disk/load/services/ports/users/packages/top procs
- `ssh_compare` — parallel snapshots of two servers → diff report (OS/kernel/services/ports/users/packages)
- `ssh_fleet_health` — health check ALL profiles in parallel → summary table (server/status/cpu%/mem%/disk%/load/failed); params: group/timeoutMs
- `ssh_anomaly` — compare current metrics to rolling 10-sample baseline; flags stddev deviations; params: target/updateBaseline/sensitivity(low|medium|high)
- `ssh_ping` — TCP reachability (no SSH auth); returns reachable/avgLatencyMs; params: target/host/port/count
- `ssh_diff` — compare remote file vs local or remote-vs-remote

### Files *(CONFIRM writes)*
- `ssh_file_read` — `encoding:"base64"` for binary; params: target/path/maxBytes
- `ssh_file_write` — auto-backup; `sudo` for root files *(CONFIRM)*
- `ssh_file_patch` — line-range or regex replace *(CONFIRM)*
- `ssh_tail` — last N lines; optional `followSeconds` (live tail bounded); params: target/path/lines/followSeconds
- `ssh_template` — render `{{VAR}}` template locally → write to remote path *(CONFIRM)*; params: target/template/vars/remotePath
- `ssh_transfer` — scp local↔remote or remote↔remote; use `profile:path`; params: src/dst/recursive *(CONFIRM)*
- `ssh_rsync` — rsync (runs locally); params: src/dst/exclude/delete/checksum/bwlimit/compress; `--delete` requires confirm

### Logs & Observability
- `ssh_log_search` — journal or file grep; params: unit/pattern/lines/since/path
- `ssh_dmesg` — kernel ring buffer; levels: all/emerg/alert/crit/err/warn/notice/info/debug; params: target/level/lines/filter/since
- `ssh_perf` — vmstat+iostat+/proc network delta; params: target/interval/count
- `ssh_tcpdump` — bounded capture (max 200 packets / 30s) *(CONFIRM)*; params: target/interface/filter/count/seconds
- `ssh_change_tracker` — `find -mmin -N` for recently modified files; params: target/minutes/path/exclude

### System *(CONFIRM writes)*
- `ssh_service` — status/start/stop/restart/enable/disable *(non-status CONFIRM)*
- `ssh_package` — 14 managers auto-detected: apt/dnf/yum/apk/pacman/zypper/xbps/snap/flatpak/pkg/emerge/nix/opkg/brew; actions: list/search/info/install/remove/update/upgrade/autoremove; `manager:` param to force specific PM *(install/remove/update/upgrade/autoremove CONFIRM)*
- `ssh_cron` — list/add/remove crontab for any user *(add/remove CONFIRM)*
- `ssh_systemd_timer` — list/status/enable/disable/start/stop systemd timers *(mutating CONFIRM)*
- `ssh_user` — add/del/mod/list/info/passwd/lock/unlock *(mutating CONFIRM)*
- `ssh_chmod` — chmod+chown+chgrp; mode/owner/group/recursive *(CONFIRM)*
- `ssh_sudo_rule` — /etc/sudoers.d/; visudo -c validation; commands required; nopasswd defaults false *(mutating CONFIRM)*
- `ssh_env` — /etc/environment list/get/set/unset *(set/unset CONFIRM)*
- `ssh_process` — list or kill by PID/name; signal param *(kill CONFIRM)*
- `ssh_mount` — list(findmnt)/mount/umount filesystems *(mount/umount CONFIRM)*
- `ssh_sysctl` — kernel params list/get/set/search; `persist:true` writes to /etc/sysctl.d/ *(set CONFIRM)*
- `ssh_swap` — status/add/remove/on/off swap files; params: target/action/swapFile/sizeMB *(mutating CONFIRM)*
- `ssh_kernel` — version/modules/dmesg/params; read-only
- `ssh_limits` — /etc/security/limits.conf list/get/set/remove/current *(set/remove CONFIRM)*

### Networking
- `ssh_network_check` — ping/port/TLS from remote server
- `ssh_port_scan` — listening ports via ss (netstat fallback); params: target/proto(tcp|udp|all)/filter
- `ssh_ssl_cert` — TLS cert expiry+subject+SANs+fingerprint; runs openssl from remote; params: target/host/port
- `ssh_firewall` — ufw/firewalld/iptables auto-detect; actions: list/add/remove/flush; params: target/action/protocol/port/source/ruleSpec *(add/remove/flush CONFIRM)*
- `ssh_dns_check` — DNS resolution FROM remote server (dig→nslookup→host fallback); params: target/domain/type/nameserver
- `ssh_traceroute` — mtr/tracepath/traceroute from remote; params: target/host/tool/maxHops
- `ssh_hosts` — /etc/hosts list/add/remove with auto-backup *(add/remove CONFIRM)*
- `ssh_ip_assign` — permanent IP; auto-detects netplan/NM/network-scripts/networkd/rc.local *(CONFIRM)*

### Security *(read-only scans safe; mutations CONFIRM)*
- `ssh_authorized_keys` — list/add/remove ~/.ssh/authorized_keys; validates key format (ssh-rsa/ed25519/ecdsa); deduplicates *(add/remove CONFIRM)*
- `ssh_fail2ban` — status/list-jails/banned-ips/ban/unban/reload *(ban/unban/reload CONFIRM)*
- `ssh_audit` — read-only scan: SUID/SGID files, world-writable dirs, passwordless sudo, empty passwords, SSH config weaknesses, 0.0.0.0 listeners, recent /etc changes
- `ssh_intrusion_check` — parse auth logs: brute force IPs (>10 failures), root logins, new UIDs, suspicious patterns; params: target/hours(1-168)
- `ssh_certbot` — Let's Encrypt: list/renew/renew-all/status/expand/delete; `dryRun:true` passes `--dry-run` *(mutating CONFIRM)*

### Containers *(CONFIRM mutating)*
- `ssh_compose` — docker-compose; auto-detects v2/v1; actions: up/down/ps/logs/pull/build/restart/stop/config/exec; params: target/action/service/composeFile/detach/lines *(up/down/restart/stop/pull/build CONFIRM)*
- `ssh_docker` — list/logs/restart/stop/start/inspect/stats; params: action/container/lines/since *(restart/stop/start CONFIRM)*
- `ssh_k8s` — kubectl: get/describe/logs/exec/apply/delete/rollout/scale/top/events; params: resource/name/namespace/selector/outputFormat/tailLines *(apply/delete/scale/rollout-restart/rollout-undo CONFIRM)*

### Databases *(write queries CONFIRM)*
- `ssh_db` — query local MySQL/PostgreSQL/Redis/MongoDB/SQLite; auto-detect engine; actions: query/list-dbs/list-tables/stats/ping/slow-queries; write keywords (INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE) auto-gate on confirm; query passed via env var (injection-safe); params: target/action/engine/query/database/dbUser/dbHost

### Web Servers *(CONFIRM reload/restart/enable/disable)*
- `ssh_nginx` — test/reload/restart/status/list-sites/enable/disable/logs/show-config; params: target/action/site/lines
- `ssh_apache` — test/reload/restart/status/list-sites/enable-site/disable-site/list-mods/enable-mod/disable-mod/logs; params: target/action/site/module

### Storage
- `ssh_backup` — tar.gz create/list/restore/prune with rotation; params: target/action/source/dest/maxCount *(create/restore/prune CONFIRM)*
- `ssh_lvm` — pvs/vgs/lvs list/status/extend/create-snapshot/remove-snapshot/resize; params: target/action/vg/lv/size/snapshotName *(mutating CONFIRM)*

### Windows Tools (PowerShell, auto-routed on Windows targets)
- `ssh_win_inventory` — OS/CPU/RAM/disks/NICs via CIM/WMI; read-only
- `ssh_win_health` — CPU%/mem%/disk/stopped-services/recent-errors; read-only
- `ssh_win_disk` — Get-PSDrive/Get-Volume/Get-PhysicalDisk; read-only
- `ssh_win_metrics` — structured JSON metrics (cpuPercent/memPercent/uptimeSeconds/processCount); read-only
- `ssh_win_service` — list/status/start/stop/restart/enable/disable; params: target/action/service *(mutating CONFIRM)*
- `ssh_win_process` — list (top 50 by CPU)/kill by PID or name; params: target/action/pid/processName *(kill CONFIRM)*
- `ssh_win_user` — list/info/add/remove/passwd/lock/unlock local users; params: target/action/username/password/groups *(mutating CONFIRM)*
- `ssh_win_eventlog` — Get-WinEvent with level filter (error/warning/info/all); params: target/logName/level/hours/maxEvents
- `ssh_win_schtask` — list/status/register/unregister/run scheduled tasks; params: target/action/taskName *(mutating CONFIRM)*
- `ssh_win_firewall` — list/add/remove firewall rules; params: target/action/ruleName/direction/protocol/localPort *(mutating CONFIRM)*
- `ssh_win_ip_assign` — list/set static IPv4 address; params: target/action/interfaceAlias/ipAddress/prefixLength/gateway *(set CONFIRM)*
- `ssh_win_acl` — list/set file ACLs; params: target/action/path/identity/rights *(set CONFIRM)*
- `ssh_win_reg` — list/get/set/delete registry values; path must start with HKLM:/HKCU:/etc.; params: target/action/path/name/value/type *(set/delete CONFIRM)*

### Deployment *(CONFIRM)*
- `ssh_git` — git ops on remote repo: status/pull/fetch/log/checkout/diff; params: target/action/repoPath/branch *(pull/checkout CONFIRM)*
- `ssh_deploy` — atomic: git pull → buildCmd → restart services → health check → auto-rollback on fail; params: target/repoPath/branch/buildCmd/services/healthCheck/rollbackOnFail
- `ssh_rollback` — restore latest/named backup + restart services + health check; params: target/backupDir/backupFile/restoreTo/services/healthCheck
- `ssh_rsync` — local rsync (runs on local machine); params: src/dst/exclude/delete/checksum/bwlimit *(--delete CONFIRM)*

### Profile & Infrastructure Management
- **Profiles** *(CONFIRM add/remove)*: `ssh_add_profile(name,host,user,port,password,identityFile,access,jumpProfile,jumpUser,targetUser,localSwitchUser,group,allowedCommands,extends,hidden)` / `ssh_remove_profile` / `ssh_profiles` / `ssh_list_keys`
- **Jump servers** *(CONFIRM add/remove)*: `ssh_add_jump(name,host,user,commonUser)` / `ssh_remove_jump` / `ssh_list_jumps`
- **IP groups**: `ssh_save_ip_group` / `ssh_remove_ip_group` / `ssh_list_ip_groups`

---

## Key Behaviors

### Confirm Required (all mutating ops)
Pass `confirm:true` or server returns error. Pass `reason:"why"` to log intent.
New in v1.19: ssh_compose(up/down/restart/stop/pull/build), ssh_k8s(apply/delete/scale/rollout-restart), ssh_db(write keywords), ssh_nginx/apache(reload/restart/enable/disable), ssh_authorized_keys(add/remove), ssh_fail2ban(ban/unban/reload), ssh_certbot(renew/expand/delete), ssh_sysctl(set), ssh_swap(add/remove/on/off), ssh_limits(set/remove), ssh_hosts(add/remove), ssh_lvm(extend/snapshot/resize), ssh_deploy, ssh_rollback, ssh_tcpdump.

### Double-Confirm (ask user twice before calling tool)
| Category | Triggers |
|----------|---------|
| Data destruction | `rm -rf`, `dd`, `mkfs`, `DROP TABLE`, `wipefs`, `> file` overwrite |
| Critical service | restart/stop/disable on nginx, mysql, postgresql, redis, sshd, docker, kubelet |
| Access changes | `ssh_user` del+removeHome, `ssh_sudo_rule` remove, passwd on root |
| Critical package | remove/purge: kernel, openssh, systemd, libc |
| Network | `ssh_ip_assign` on prod; firewall flush; default route changes |
| Bulk | `ssh_run_multi` write/delete/restart across 3+ hosts |
| Power | reboot/shutdown/halt/poweroff |
| k8s | `kubectl delete` on running workloads; namespace delete |

### dryRun
All mutating tools accept `dryRun:true` → returns bash script preview without executing.

### Audit
All calls logged to `ssh-ops-audit.log` (passwords redacted). `rateLimitPerMin` default 60/target/min.

---

## Routing Modes

| Config | Behavior |
|--------|----------|
| `jumpChain: [b1,b2]` | SSH `-J user@b1,user@b2` multi-hop |
| `jumpProfile`+`jumpUser`+`targetUser` | Connect to bastion, `sudo -n -u jumpUser ssh targetUser@dest` |
| `localSwitchUser` | ssh-ops IS the bastion — `sudo -n -u <user> ssh dest` locally |

### New IP — auto-try first
Unknown host → do NOT ask for credentials:
1. `ssh_profiles` → note routing/commonUser
2. `ssh_run(host=<IP>, user=<commonUser|root>, command="hostname && uptime")`
3. Success → `ssh_add_profile`, proceed. Fail → report error, ask.

---

## Profile Features

- **`allowedCommands`** — per-profile command allowlist; ssh_run rejects non-matching prefixes
- **`group`** — for `ssh_run_multi(group:"prod")` and `ssh_fleet_health(group:"prod")`
- **`extends`** — inherit parent profile fields (child wins); single-level only
- **`hidden:true`** — excluded from `ssh_profiles` listing
- **`password`** — stored AES-256-GCM encrypted; requires sshpass on local machine
- **`exposeProfiles:false`** config — hides profile tools from tools/list entirely

---

## Context-Saving Patterns

### Monitor without flooding context
```
# First call: full output
ssh_run_watch(target="prod", command="systemctl list-units --state=failed")
# Subsequent: unified diff only — "[watch] Changed since 2026-05-16T10:30:00Z: ..."
```

### Large output → local file
```
ssh_run(target=X, command="cmd > /tmp/out.txt")
scp user@host:/tmp/out.txt ~/Downloads/out.txt   # via Bash tool
ssh_run(target=X, command="rm /tmp/out.txt")
```

### Fleet security sweep
```
ssh_fleet_health()                      → all servers in one call
ssh_audit(target="prod")               → security scan
ssh_intrusion_check(target="prod", hours=24)  → auth log analysis
```

### Anomaly detection workflow
```
# Build baseline (first few calls):
ssh_anomaly(target="prod", updateBaseline=true)

# Monitor (flags deviations > 2x stddev by default):
ssh_anomaly(target="prod", sensitivity="medium")
# Returns: "ANOMALY: cpuPercent 87.3 vs baseline 12.1 (mean±std: 12.1±3.2)"
```

### Atomic deploy with auto-rollback
```
ssh_deploy(
  target="prod",
  repoPath="/var/www/app",
  branch="main",
  buildCmd="npm ci && npm run build",
  services=["app.service"],
  healthCheck="curl -sf http://localhost:3000/health",
  rollbackOnFail=true,
  confirm=true
)
```

---

## Auto-Update

Disabled by default. `SSH_OPS_AUTO_UPDATE=1` to enable.

## Truncation

Output truncated at `maxOutputBytes` (default 2MB): `[OUTPUT TRUNCATED: received X bytes, limit Y bytes — Z bytes dropped]`.
