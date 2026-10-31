---
name: ssh-ops
description: "SSH Ops MCP — remote SSH commands on Linux/BSD/macOS/Windows. Default profile: lite (8 tools). Use --profile readonly or --profile full for more."
---

# ssh-ops

Run bounded SSH commands on remote hosts. Defaults: timeout=20s, output=32KB, stdout=100 lines, stderr=50 lines.

## Profiles
- `--profile lite` (default): ssh_run, ssh_run_multi, ssh_add_profile, ssh_tail, ssh_log_search, ssh_health_report, ssh_disk_report, ssh_profiles
- `--profile readonly`: lite minus ssh_add_profile, plus ssh_inventory, ssh_metrics, ssh_memory_report, ssh_file_read, ssh_dmesg, ssh_audit, ssh_ssl_cert, ssh_port_scan, ssh_intrusion_check (visibility only, not a read-only command sandbox)
- `--profile full`: all 95 tools; opt-in by configuring the server arguments or SSH_OPS_PROFILE=full, then restart

## Rules
- Add `| head -n 50` to any command that may produce long output.
- Use `ssh_log_search` instead of `cat *.log` or `grep /var/log`.
- Use `ssh_tail` with `maxLines` instead of `tail -f`.
- Blocked: `tail -f`, `journalctl -f`, unbounded `docker logs`/`kubectl logs`, `cat /var/log/*`, `find /`, `ls -R /`, `grep -r /`, `watch`, `while true`.
- Consider `/compact` when context grows large, not after every SSH call. Start a fresh chat for unrelated work.

## Full docs
See README.md for complete tool reference and advanced profiles.
