# Python SSH Ops MCP v2 alpha hardening — design

Date: 2026-11-09
Related: draft PR #4 (Python baseline), stacked draft PR #5 (this upgrade)

## Intent
Provide a secure, low-token Python alternative for routine Linux SSH diagnostics without modifying the production Node.js implementation or installing anything on remote servers.

## Approaches evaluated
1. **Official MCP SDK v2 + system OpenSSH** — chosen. Reuses tested host-key/agent/ProxyJump/ControlMaster behaviour, minimal Python dependencies, works with the baseline code.
2. **MCP SDK + AsyncSSH >=2.24.0** — native async SFTP/SSH, but duplicates the transport, changes compatibility behaviour and introduces extra security maintenance (2026 AsyncSSH advisories). Reconsider only after measured gains.
3. **MCP SDK + Paramiko** — strong Python ecosystem and SFTP but likewise duplicates OpenSSH transport and complicates key/agent/jump compatibility.

## Scope for this incremental PR
- Preserve baseline seven Python tools and remote key-only authentication.
- Repair indefinite stdin blocking so timeout remains authoritative.
- Return explicit stdout/stderr truncation flags; output remains capped per stream.
- Add `ssh_log_search`: last-hour journald, validated unit, shell-quoted pattern, <=100 matching lines.
- Add `ssh_fleet_health`: up to 20 unique profile names, four parallel connections, compact two-line previews plus warnings and status.
- Verify registration via official Python SDK in-memory MCP client; cover timeout, output cap, injection and fleet limits.

## Security boundaries
- No password/private-key storage in SQLite.
- Strict known_hosts, no agent forwarding, no remote package/agent required.
- General shell command execution remains gated by local opt-in + explicit confirm; the gate is not human authorisation or a sandbox.
- Diagnostics may expose remote information; operators must use least-privileged SSH accounts and authorised targets.
- Failure events log aliases and status, not command output or credentials.

## Non-goals
- Replacing Node.js or recreating all 95 tools in this PR.
- SFTP abstraction, remote credential migration, persistent Windows PowerShell multiplexing, permanent host connectivity.
- Starting unattended remote monitoring, alert dispatch or installing agent software.

## Acceptance and rollback
- Python unittest + in-memory MCP protocol, Ruff, Bandit, pip-audit and CodeQL pass.
- No live host tests claimed; run against authorised Linux and Windows test hosts before cutover.
- PR #5 is stacked on #4; merge base Python PR first or rebase after review.
- Keep Node.js installation and its original configuration as rollback.
