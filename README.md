# SSH Ops

SSH Ops is a small Codex plugin that exposes SSH tasks as an MCP server and a plain Node CLI. It uses your local `ssh` binary, existing keys, and SSH config. It does not store passwords or private keys.

## Configure

Copy `ssh-ops.config.example.yaml` to `ssh-ops.config.yaml` and edit profiles there, or place the same YAML shape at `~/.ssh/ssh-ops.yaml`.

`ssh-ops.config.yaml` is intentionally local so per-machine targets and key paths stay out of shared examples. Existing JSON config files still work for compatibility.

## CLI

From this plugin directory:

```bash
node scripts/ssh-ops.mjs profiles
node scripts/ssh-ops.mjs run production 'hostname; uptime'
node scripts/ssh-ops.mjs inventory production
node scripts/ssh-ops.mjs disk production / 1
node scripts/ssh-ops.mjs health production
```

You can also skip profiles and use a raw target:

```bash
node scripts/ssh-ops.mjs inventory deploy@server.example.com
```

To route destination servers through a configured jump server, set these defaults:

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

With that config, non-jump targets such as `app.example.com` first connect to `bastion` as `operator`, then run the destination SSH command as `relay` on the jump server so it can use that account's key for `root@app.example.com`. The jump profile itself still connects directly with its configured user.

## MCP Tools

The plugin exposes these MCP tools:

- `ssh_profiles`: list configured profiles without connecting.
- `ssh_run`: run an arbitrary remote command or script.
- `ssh_inventory`: read-only hardware and VM inventory.
- `ssh_disk_report`: read-only filesystem and container storage report.
- `ssh_health_report`: read-only load, service, journal, process, and Docker snapshot.

The MCP server uses newline-delimited JSON-RPC over stdio and writes only MCP messages to stdout.
