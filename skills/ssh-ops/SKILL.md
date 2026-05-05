---
name: ssh-ops
description: Use SSH Ops when the user asks to inspect, inventory, monitor, diagnose, or run commands on a remote SSH server through the ssh-ops MCP tools, including two-hop jump-server routing.
---

# SSH Ops

Prefer the `ssh-ops` MCP tools for remote SSH work when they are available:

- `ssh_profiles`: inspect configured profiles without connecting.
- `ssh_run`: run a specific command or script.
- `ssh_inventory`: collect OS, CPU, RAM, disk, PCI, network, and service inventory.
- `ssh_disk_report`: inspect disk and inode pressure.
- `ssh_health_report`: inspect load, memory, disk, failed units, recent errors, and process pressure.

Use the CLI fallback from the plugin root when MCP tools are unavailable:

```bash
node scripts/ssh-ops.mjs inventory <target-or-profile>
node scripts/ssh-ops.mjs health <target-or-profile>
node scripts/ssh-ops.mjs disk <target-or-profile> / 1
node scripts/ssh-ops.mjs run <target-or-profile> 'hostname; uptime'
```

## Targets

- `target` may be a profile name from `ssh-ops.config.yaml`, `~/.ssh/ssh-ops.yaml`, or a compatible JSON config.
- `target` may also be a raw SSH target such as `user@server.example.com` or `server.example.com`.
- Do not store passwords or private keys in plugin files. Use local SSH keys, SSH agent, or normal OpenSSH config.

## Two-Hop Jump Routing

When config defaults include `jumpProfile`, `jumpUser`, and `targetUser`, non-jump targets are routed as a nested SSH command:

1. Connect locally to `jumpProfile` using that profile's configured user.
2. On the jump server, run the destination SSH command as `jumpUser`.
3. Connect to the final destination as `targetUser`.

Example shape:

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

With that config, `ssh_run` targeting `app.example.com` connects to `bastion` first, then runs SSH as `relay` to `root@app.example.com`. The jump profile itself still connects directly.

## Safety

- For inventory and health checks, use read-only commands first.
- For sudo, use `sudo -n` so commands fail instead of prompting for a password.
- Confirm with the user before running destructive commands such as deletes, package removals, reboots, firewall changes, service restarts, or disk formatting.
- Summarize key findings after tool execution; the user usually does not need raw command walls unless they ask.
