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

## Security Design

- **Passwords** stored AES-256-GCM encrypted with a device-specific key (`~/.ssh-ops/.encryption-key`, mode 0600). Keys are never transmitted or committed to version control.
- **Password auth** uses `sshpass -e` with `SSHPASS` env var — passwords never appear in process arguments or logs.
- **`sudo` calls** always use `sudo -n` (non-interactive) — fails immediately rather than prompting, preventing credential exposure.
- **Dynamic config** (`ssh-ops.dynamic.json`) and encryption key (`.encryption-key`) are gitignored and never committed.
- **No outbound data collection** — the MCP server only communicates over local stdio and SSH to hosts you configure.
- **Auto-update** fetches only from the official GitHub Releases API and `raw.githubusercontent.com`.
