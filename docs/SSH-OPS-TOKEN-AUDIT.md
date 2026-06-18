# SSH Ops Token Audit

## Findings

- The README advertises 95 MCP tools.
- The installer downloads many `ssh-tools-*` modules, so the full server is broad by default.
- The installed Claude plugin previously auto-loaded the full `skills/ssh-ops/SKILL.md` into Claude context.
- The core default output cap was very large for Claude Code usage.
- Full server tools include high-output operations such as snapshots, fleet health, Docker/Kubernetes logs, file reads, disk reports, and inventory reports.

## Root cause

The repo optimized for operational coverage, not Claude Code context efficiency. Full mode is useful for manual opt-in operations, but too expensive as the default MCP server.

## Applied fixes in this branch

- Added `scripts/ssh-mcp-server-lite.mjs`.
- Updated `.mcp.json` to use lite mode by default.
- Added `.mcp.full.json` for explicit full-mode opt-in.
- Replaced long skill instructions with compact token-safe guidance.
- Added `docs/TOKEN-SAFE-SSH-OPS.md`.

## Remaining recommended follow-up

- Add tests for lite server JSON-RPC initialize, tools/list, and tools/call.
- Consider splitting the full server into separate read-only, ops, fleet, and deploy MCP servers.
- Consider lowering full-server defaults too, not only lite-server behavior.
- Update installer to register lite mode by default and full mode only on explicit opt-in.
