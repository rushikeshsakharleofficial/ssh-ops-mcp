---
name: ssh-ops
description: "SSH Ops: eight default remote SSH tools; 95 optional tools in full profile. Use for Linux and Windows server operations."
---

# SSH Ops

Use profile names or user@host. Default `lite` includes:
`ssh_run`, `ssh_run_multi`, `ssh_add_profile`, `ssh_profiles`,
`ssh_health_report`, `ssh_disk_report`, `ssh_log_search`, `ssh_tail`.

## Efficient usage

- Use short targeted commands; cap long output with `head -n 50`.
- Prefer `ssh_log_search` for logs and `ssh_health_report` for quick status.
- `ssh_add_profile` saves a host with confirmation; never echo credentials.
- `ssh_run_multi` targets profiles/groups when fleet checks are necessary.
- Use `--profile full` and restart for specialist operations (95 tools).
- `--profile readonly` reduces tool visibility but does **not** prevent mutating shell commands.
- Mutating operations require careful review; privileged `ssh_run` requires confirmation when `sudo:true`.
- Compact context when lengthy, not automatically after every call.

See `skills/ssh-ops/SKILL.md` for compact instructions and `README.md` for full tool documentation.
