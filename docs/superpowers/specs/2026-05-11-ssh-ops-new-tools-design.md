# SSH Ops — New Tools Design

**Date:** 2026-05-11
**Scope:** 4 new MCP tools + updated skill file for AI-driven SSH ops (diagnose + change)

---

## Problem

Current tools cover read-only diagnostics (inventory, disk, health) and arbitrary command execution. No structured tools for: reading files, writing files, controlling services, or searching logs. AI must compose raw bash for all of these — loses structured output, schema validation, and safety hints.

## Goal

Add 4 focused tools so Claude/Codex can diagnose and change remote servers through named, narrow MCP tools. Default behavior: confirm with user before write operations unless user explicitly says "automatically".

---

## Tools

### `ssh_file_read`

Read content of a remote file.

**Input schema:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string | no | Profile or `user@host`. Uses `defaultTarget` if omitted. |
| `path` | string | yes | Absolute remote file path. |
| `maxBytes` | number | no | Cap output. Default 51200 (50 KB). |

**Behavior:** Runs `head -c <maxBytes> <path>` via `bash -s`. Returns file content via `formatRunResult`. Exits non-zero if file not found.

**Safety:** Read-only. No confirmation needed.

---

### `ssh_file_write`

Overwrite a remote file. **Confirmation required** unless user says to proceed automatically.

**Input schema:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string | no | Profile or `user@host`. |
| `path` | string | yes | Absolute remote file path. |
| `content` | string | yes | New file content. |
| `backup` | boolean | no | Backup before overwrite. Default `true`. |
| `sudo` | boolean | no | Write via `sudo tee`. |

**Behavior:**
1. If `backup: true` (default): runs `cp <path> <path>.bak.<epoch>` before writing.
2. Writes content via `cat > <path>` (or `sudo tee <path>` if `sudo: true`), piped through stdin.
3. Returns `formatRunResult` with exit code.

**Safety:** Description annotated "CONFIRM with user before calling unless told to proceed automatically."

---

### `ssh_service`

Systemd service control: status, start, stop, restart, enable, disable.

**Input schema:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string | no | Profile or `user@host`. |
| `service` | string | yes | Systemd unit name, e.g. `nginx`. |
| `action` | string | yes | `status` \| `start` \| `stop` \| `restart` \| `enable` \| `disable` |
| `sudo` | boolean | no | Run via `sudo -n`. Default `true`. |

**Behavior:** Runs `systemctl <action> <service>` (with `sudo -n` when `sudo: true`). Uses `mode: bash` through `runSshCommand`.

**Safety:** `status` is read-only, no confirm. All other actions: description annotated "CONFIRM with user before calling unless told to proceed automatically."

---

### `ssh_log_search`

Search systemd journal or a log file by pattern.

**Input schema:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string | no | Profile or `user@host`. |
| `unit` | string | no | journalctl `-u` filter. |
| `pattern` | string | no | grep pattern applied to output. |
| `lines` | number | no | Max lines returned. Default 100. |
| `since` | string | no | Time filter, e.g. `"1h"`, `"2026-05-10"`. |
| `path` | string | no | Grep a file instead of journalctl. |
| `timeoutMs` | number | no | Override default 60s timeout. |

**Behavior:**
- If `path` provided: `tail -n <lines> <path> | grep -E <pattern>` (grep skipped if no pattern).
- Otherwise: `journalctl` with `-u`, `--since`, `-n` flags then piped to `grep -E <pattern>` if pattern given.
- Returns `formatRunResult`.

**Safety:** Read-only. No confirmation needed.

---

## Skill File Update

Replace current `.claude/skills/ssh-ops.md` body with compressed bullets:

```
- ssh_profiles: list profiles, no connection
- ssh_run: run command/script on remote host
- ssh_inventory: OS/CPU/RAM/disk/network inventory
- ssh_disk_report: disk/inode/container storage pressure
- ssh_health_report: load/memory/disk/services/processes/docker snapshot
- ssh_file_read: read remote file content
- ssh_file_write: write remote file — CONFIRM with user before calling unless told automatically
- ssh_service: systemd control — CONFIRM for start/stop/restart/enable/disable unless told automatically
- ssh_log_search: search journal or log file by pattern
```

Skill description updated to:
> Use SSH Ops when inspecting, changing, or running commands on remote SSH servers. Covers inventory, health, disk, file read/write, service control, and log search.

---

## Implementation Plan (outline)

1. Add 4 bash script builder functions to `ssh-core.mjs`:
   - `fileReadScript(path, maxBytes)`
   - `fileWriteScript(path, content, backup, sudo)`
   - `serviceScript(service, action, sudo)`
   - `logSearchScript({unit, pattern, lines, since, path})`

2. Add 4 tool definitions to `ssh-mcp-server.mjs` tools array.

3. Add 4 `if (name === ...)` branches in `callTool()`.

4. Update `.claude/skills/ssh-ops.md` with compressed bullets.

5. Add tests in `tests/ssh-ops.test.mjs` for script-builder output (no live SSH needed).

---

## Token Budget

Tool descriptions: ≤15 words each. Param descriptions: ≤8 words. Skill bullets: one line per tool.
