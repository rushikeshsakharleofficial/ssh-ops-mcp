# SSH Ops Python (alpha; separate from the working Node.js server)

Local MCP server using official MCP Python SDK and system OpenSSH. **No SSH agent or Python package is installed on remote machines.** Only standard SSH services are required.

## Security model

- **SSH keys/agent only.** No SSH passwords, password hashes, tokens or private keys are stored in SQLite. Hashes cannot authenticate to an SSH server. Migrate password-based profiles manually to SSH keys; do not copy their encrypted secrets into the Python database.
- Server metadata lives in `~/.ssh-ops/profiles.sqlite3` (private directory `0700`, file `0600` on Unix). The database is **not encrypted at rest**; use FileVault, BitLocker or LUKS to encrypt the local disk. Windows permissions inherit the user's profile ACL; verify that ACL before production use.
- No remote command execution by default other than the fixed `ssh_health` diagnostic. `ssh_run` requires **both** `SSH_OPS_ALLOW_WRITE=1` in the local MCP process environment and `confirm=true`. The flag is not a substitute for a human approval check; constrain the SSH account and MCP client permissions.
- SSH host keys are always verified with `StrictHostKeyChecking=yes`; add trusted host keys to `~/.ssh/known_hosts` out of band.
- SSH keepalive: `ServerAliveInterval=30`, `ServerAliveCountMax=3`; on macOS/Linux, local OpenSSH connection sharing uses `ControlMaster=auto`, `ControlPersist=300`, hashed socket paths inside a private directory. This reuses a connection while active; it does **not** guarantee permanent connectivity.
- SCP is used for upload/download (OpenSSH 9+ normally uses SFTP); transfer of directories requires `recursive=true`. Existing remote SSH/SFTP support is required. rsync is not included because it requires rsync installed on **both** machines.
- Important failures and root filesystem pressure (90% or more) are appended to `~/.ssh-ops/incidents.jsonl`. Logs contain only profile aliases, event names and codes. Rotate the log with OS tools as required. This is deterministic risk detection, **not predictive AI**.
- Windows SSH targets can set `shell="powershell"`; Unix targets use `sh`. Copying Windows remote paths depends on the server's SFTP path conventions.

## Install locally (Python 3.11+)

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/ssh-ops-mcp
```

Configure your MCP client with the absolute path to `.venv/bin/ssh-ops-mcp` as a **stdio** MCP server. Avoid setting `SSH_OPS_ALLOW_WRITE=1` in everyday read-only sessions.

Available MCP tools (nine): `ssh_profiles`, `ssh_save_profile`, `ssh_remove_profile`, `ssh_health`, `ssh_run`, `ssh_copy`, `ssh_incidents`, `ssh_log_search`, `ssh_fleet_health`.

### Bounded diagnostics and process safety

- `ssh_log_search(target, pattern="", unit="", lines=50)`: searches the last hour of Linux journald, at most 100 matching lines. Patterns are shell-quoted; journald handles filtering. This does not support Windows event logs.
- `ssh_fleet_health(targets=["web1", "web2"])`: fixed diagnostics across 1–20 unique profiles, at most four concurrent SSH calls, returns concise status per server instead of full reports.
- The subprocess executor drains stdout/stderr continuously to a 32 KiB cap per stream, reports truncation, and enforces timeouts even when the remote process does not read stdin.
- Log results and command output can contain sensitive information from remote systems. Restrict SSH account privileges and invoke diagnostics only on authorised servers.

### Module selection

- **Official MCP Python SDK v2** handles protocol, schema and stdio.
- **sqlite3, shlex, concurrent.futures, subprocess** in the standard library handle private metadata, shell quoting, parallel health checks and process execution.
- **System OpenSSH** supplies SSH-agent authentication, known_hosts checking, ProxyJump, ControlMaster and native SCP/SFTP without a remote agent or second SSH stack.
- **Ruff, Bandit, pip-audit and CodeQL** run as CI-only development tooling.

Paramiko and AsyncSSH are intentionally not added: both duplicate transport provided by locally maintained OpenSSH and increase the security/dependency surface. Review this choice only if native connection support delivers a measurable compatibility or performance improvement.


For a read-only connection use `ssh_save_profile(name="lab", host="server.example.org", username="ops", confirm=true)` and `ssh_health(target="lab")`. Use an SSH key in the SSH agent or provide an absolute `identity_file` path. For a bastion, use `jump_host` (OpenSSH `-J`) or your existing SSH config.

## Validation

```sh
PYTHONPATH=src python -m unittest discover -s tests -v
python -m compileall -q src
```

Every PR triggers the Python CI checks: unit tests, Ruff, Bandit static security scan, pip-audit for known dependency CVEs and Python CodeQL. CVE scans cover dependencies, **not** arbitrary Python logic. Integration testing against authorised Linux/Windows test hosts remains necessary before production use.

## Migration and rollback

The Node.js server remains untouched and is the rollback path. Install Python separately; use a distinct MCP server name while testing. Run `python -m ssh_ops.migrate` to preview import of old per-profile JSON entries, then `python -m ssh_ops.migrate --apply` to import **only non-secret fields** into SQLite. Profiles requiring passwords or unsupported nested jumps are skipped and must be re-added manually. Back up the existing Node config/key and all original files before cutover. Do not run both backends against the same mutable state. Remove the old implementation only after user-approved cutover and parity testing.
