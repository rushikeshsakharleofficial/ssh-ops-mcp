# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest (main branch) | ✅ |
| Older releases | ❌ — upgrade via the install script |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/security/advisories/new).

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

Expected response: acknowledgement within 48 hours, fix within 14 days for confirmed issues.

## Threat Model

ssh-ops is an MCP server invoked by an LLM. The primary threat actor is a **compromised or jailbroken model** issuing tool calls to escalate privileges, exfiltrate data, or persist on managed hosts. All security controls assume the MCP client (the model) is adversarial.

## Trust Boundaries

| Layer | Trusted? | Notes |
|-------|----------|-------|
| SSH keys / local filesystem | Yes | Owned by the user running the MCP server |
| MCP client (LLM) | **No** | Treated as untrusted input |
| Remote hosts | Conditional | Only as trusted as your SSH keys |
| `ssh-ops.config.yaml` | Yes | Local file, user-controlled |
| `SSH_OPS_CONFIG` env | Partial | Loaded last, can override defaults |
| Dynamic profiles (`ssh-ops-profiles/`) | Yes | Written only via confirm-gated tool calls |

## Hardening Checklist

### Limit what models can see

```yaml
# ssh-ops.config.yaml
exposeProfiles: false          # hide ssh_profiles tool from tools/list
```

```yaml
profiles:
  prod-db:
    host: db.internal
    hidden: true               # usable but not listed
```

### Restrict commands per profile

```yaml
profiles:
  prod:
    host: server.example.com
    user: deploy
    allowedCommands:
      - "systemctl status"
      - "journalctl -n"
      - "df -h"
```

### Rate limiting

```yaml
rateLimitPerMin: 30            # max tool calls per target per minute (default 60)
```

### Alert webhooks

```yaml
alertWebhook: https://hooks.slack.com/services/...
alertThresholds:
  cpuPercent: 90
  memPercent: 95
  diskPercent: 85
```

### Profile groups

```yaml
profiles:
  web-1: { host: 10.0.1.1, group: prod }
  web-2: { host: 10.0.1.2, group: prod }
```
`ssh_run_multi group: "prod"` targets all profiles in the group.

## Confirm Gates

All mutating tools require `confirm: true`. Pass `dryRun: true` to preview the exact bash script without executing.

Tools requiring confirm: `ssh_run` (sudo), `ssh_run_multi` (sudo), `ssh_file_write`, `ssh_file_patch`, `ssh_service` (mutating), `ssh_package` (mutating), `ssh_cron` (mutating), `ssh_user` (mutating), `ssh_chmod`, `ssh_sudo_rule` (mutating), `ssh_ip_assign`, `ssh_add_profile`, `ssh_remove_profile`, `ssh_add_jump`, `ssh_remove_jump`, `ssh_docker` (mutating), `ssh_env` (set/unset), `ssh_process` (kill), `ssh_script`, `ssh_transfer`.

## Audit Log

Every tool call is appended to `ssh-ops-audit.log`:
```json
{"ts":"2025-01-01T00:00:00Z","tool":"ssh_run","args":{"target":"prod","command":"uptime"},"isError":false}
```
Passwords are redacted. Large content fields are truncated.

## What Encryption Protects (and Doesn't)

Passwords stored via `ssh_add_profile` use AES-256-GCM with a key in `.encryption-key` (mode 0600).

**Protects:** shoulder-surfing, accidental log leaks, naive file reads.

**Does NOT protect:** anyone with filesystem read access to the plugin directory (key and ciphertext are colocated).

Ciphertext format: `v1:<keyId>:<iv>:<ct>:<tag>` — includes key ID for mismatch detection on key rotation.

## Profile Export / Import

```bash
node scripts/ssh-ops.mjs export profiles.enc    # AES-256-GCM, PBKDF2 passphrase
node scripts/ssh-ops.mjs import profiles.enc
```

## Security Design (original)

- **Passwords** stored AES-256-GCM encrypted with a device-specific key (`.encryption-key`, mode 0600). Keys never transmitted or committed.
- **Password auth** uses `sshpass -e` with `SSHPASS` env var — passwords never appear in process args or logs.
- **`sudo` calls** always use `sudo -n` (non-interactive).
- **Dynamic config** (`ssh-ops-profiles/`) and `.encryption-key` are gitignored.
- **No outbound data collection** — MCP server communicates only over local stdio and SSH.
- **Auto-update** fetches only from `api.github.com` and `raw.githubusercontent.com` (redirects pinned).

## Known Residual Risks

| Risk | Status |
|------|--------|
| Encryption key colocated with data | Partial — `SSH_OPS_KEY_FILE` env planned |
| No per-session tool call budget | Open |
| `ssh_run` without sudo has no command restriction unless `allowedCommands` set | Acceptable — use `allowedCommands` |
