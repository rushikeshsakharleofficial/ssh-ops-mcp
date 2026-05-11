# SSH Ops

SSH Ops exposes SSH tasks as an MCP server and a plain Node CLI. Works as a plugin for **Claude Code** and **Codex**. Uses your local `ssh` binary, existing keys, and SSH config. Does not store passwords or private keys.

## One-Click Install

### Claude Code

```bash
git clone https://github.com/rushikeshsakharleofficial/ssh-ops-mcp.git
cd ssh-ops-mcp
claude mcp add ssh-ops node ./scripts/ssh-mcp-server.mjs
```

Then configure your targets (see [Configure](#configure)) and start a new Claude Code session — the tools are live.

> **Prerequisite:** Node.js on your PATH.

### Codex

```bash
git clone https://github.com/rushikeshsakharleofficial/ssh-ops-mcp.git
```

Move or symlink the cloned folder into your Codex plugins directory. Codex reads `.codex-plugin/plugin.json` and `.mcp.json` automatically — no extra steps.

---

## Configure

Copy the example config and edit your profiles:

```bash
cp ssh-ops.config.example.yaml ssh-ops.config.yaml
```

Or place the same YAML at `~/.ssh/ssh-ops.yaml` for a machine-wide default.

```yaml
defaultTarget: production
defaults:
  connectTimeoutSec: 12
  strictHostKeyChecking: accept-new
profiles:
  production:
    host: server.example.com
    user: deploy
    port: 22
```

`ssh-ops.config.yaml` is gitignored — per-machine targets and key paths stay local. JSON config files also work.

### Jump Server Routing

To route all non-jump targets through a bastion:

```yaml
defaults:
  jumpProfile: bastion
  jumpUser: relay
  targetUser: root
profiles:
  bastion:
    host: bastion.example.com
    user: operator
```

Non-jump targets connect to `bastion` as `operator`, then SSH as `relay` to `root@<destination>`. The bastion profile itself connects directly.

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `ssh_profiles` | List configured profiles without connecting |
| `ssh_run` | Run an arbitrary remote command or script |
| `ssh_inventory` | Read-only hardware and VM inventory (OS, CPU, RAM, disk, network) |
| `ssh_disk_report` | Read-only filesystem, inode, and container storage report |
| `ssh_health_report` | Read-only load, services, journal errors, processes, Docker snapshot |
| `ssh_file_read` | Read a remote file |
| `ssh_file_write` | Overwrite a remote file (backs up original by default) |
| `ssh_service` | Start, stop, restart, enable, disable, or status a systemd service |
| `ssh_log_search` | Search systemd journal or a log file by pattern |

The MCP server communicates over newline-delimited JSON-RPC on stdio.

---

## CLI

```bash
node scripts/ssh-ops.mjs profiles
node scripts/ssh-ops.mjs run production 'hostname; uptime'
node scripts/ssh-ops.mjs inventory production
node scripts/ssh-ops.mjs disk production / 1
node scripts/ssh-ops.mjs health production
```

Raw targets work without a profile:

```bash
node scripts/ssh-ops.mjs inventory deploy@server.example.com
```

CLI options:

| Flag | Description |
|------|-------------|
| `--sudo` | Run via `sudo -n bash -s` |
| `--raw` | Pass command as raw SSH remote command |
| `--timeout-ms <ms>` | Local command timeout |
| `--port <n>` | SSH port override |
| `--identity-file <path>` | SSH private key |
| `--jump-host <target>` | SSH jump host (`-J`) |
| `--no-sudo` | Disable sudo in inventory |

---

## How It Works

- **Config loading** — merges `ssh-ops.config.yaml` in the project root with `~/.ssh/ssh-ops.yaml`. Override with `SSH_OPS_CONFIG` env var.
- **Script builders** — each tool generates a bash script piped to `bash -s` on the remote (no interactive shell needed).
- **Two-hop routing** — when `jumpProfile` is set, the SSH command is wrapped in a nested `ssh` call executed on the jump server.
- **Safety** — all sudo uses `sudo -n` (fails instead of prompting). `ssh_file_write` creates a timestamped `.bak` before overwriting.
