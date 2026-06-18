# Token-Safe SSH Ops Mode

## Problem

The original full MCP server exposes 95 tools and can return very large command output. This is powerful, but it increases Claude Code context and plan usage, especially when the server is enabled all day or used by subagents.

Main token risks:

- many MCP tool schemas exposed at once
- full skill reference auto-loaded into Claude context
- large stdout/stderr from remote commands
- fleet, snapshot, and log tools returning broad output
- live logs or repeated remote debug loops

## Default fix

`.mcp.json` now points to `scripts/ssh-mcp-server-lite.mjs`.

The lite server exposes only:

- `ssh_run`
- `ssh_log_search`
- `ssh_health_report`
- `ssh_disk_report`
- `ssh_file_read`
- `ssh_profiles`

Full mode is still available through `.mcp.full.json` but should be opt-in only.

## Lite limits

| Limit | Value |
|---|---:|
| Default timeout | 20s |
| Max timeout | 30s |
| Default output bytes | 32KB |
| Max output bytes | 64KB |
| Default lines shown | 100 |
| Max lines shown | 200 |

## Blocked in lite mode

The lite server blocks high-token or high-risk patterns, including:

- live/following logs
- unbounded service logs
- full log-file reads
- root filesystem scans
- recursive scans from root
- raw environment dumps
- private-key or secret-file reads
- destructive file operations
- service restart or stop actions
- mutating Kubernetes/Terraform/deploy operations
- pipe-to-shell installers

## Daily Claude Code workflow

Start with all MCP disabled:

```text
/mcp disable all
```

Enable SSH only when live access is required:

```text
/mcp enable ssh-ops
```

After use:

```text
/mcp disable ssh-ops
/compact Preserve CAVEMAN_ULTRA. Keep only: goal, command summaries, errors, decisions, next steps.
```

## When to use full mode

Use `.mcp.full.json` only when you explicitly need broad operations such as deployment, Kubernetes mutations, file writes, or fleet management.

Do not leave full mode enabled as the daily default.
