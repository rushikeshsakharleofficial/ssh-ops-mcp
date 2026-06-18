---
name: ssh-ops
description: "Token-safe SSH Ops skill. Use only for live server checks with bounded commands and compact output."
---

# SSH Ops — Token-Safe Mode

Use SSH Ops only when live server access is required.

Default MCP server is `ssh-ops-lite`, which exposes only bounded tools:

- `ssh_run`
- `ssh_log_search`
- `ssh_health_report`
- `ssh_disk_report`
- `ssh_file_read`
- `ssh_profiles`

## Rules

- Do not use SSH Ops for local code search, planning, docs, or static review.
- Do not use SSH Ops from subagents.
- First pass: max 5 tool calls.
- Full task: max 15 tool calls unless user approves more.
- Max output target: 100 lines.
- Prefer summaries over raw output.
- Disable MCP after use and compact the session.

## Safe command patterns

Use bounded commands:

```bash
tail -n 100 /var/log/app.log
grep -iE "error|warn|fatal|fail" /var/log/app.log | tail -n 100
journalctl -u SERVICE --since "30 min ago" -n 100 --no-pager
docker logs --tail 100 CONTAINER
kubectl logs --tail=100 POD
```

## Blocked patterns

Do not run:

```bash
cat /var/log/*
tail -f FILE
journalctl -f
docker logs -f CONTAINER
kubectl logs -f POD
find /
ls -R /
watch COMMAND
while true; do COMMAND; done
```

## High-risk actions

Full SSH Ops has many mutating tools. Keep full mode disabled unless explicitly needed.

Ask for user approval before:

- service restart/stop
- package install/remove/update
- file write/patch
- deploy/rollback
- rsync/scp transfer
- kubectl apply/delete/scale
- terraform apply/destroy
- firewall changes
- user/authorized_keys changes

## After use

Run:

```text
/mcp disable ssh-ops
/compact Preserve CAVEMAN_ULTRA. Keep only: goal, command summaries, errors, decisions, next steps.
```
