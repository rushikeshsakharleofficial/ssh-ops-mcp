# Changelog

All notable changes to ssh-ops MCP are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

---

## [v1.17.0] — 2026-05-15

### Added
- **`allowedCommands` per-profile** — whitelist commands model can run on a profile; `ssh_run` rejects anything not matching
- **Append-only audit log** — every tool call logged to `ssh-ops-audit.log` (passwords redacted, large content truncated)
- **`dryRun:true`** — pass to any mutating tool to preview the exact bash script without executing
- **Rate limiting** — `rateLimitPerMin` config (default 60) caps calls per target per minute with sliding-window counter
- **`reason:` field** — optional intent string on all mutating tools; logged to audit and shown in confirm prompts
- **Profile groups** — `group:` field on profiles; `ssh_run_multi` accepts `group: "prod"` to target all matching profiles
- **Profile inheritance** — `extends: base-profile` merges parent fields (child wins on conflict, single-level)
- **Alert webhooks** — `alertWebhook` + `alertThresholds` in config; `ssh_health_report` POSTs JSON alert on threshold breach
- **`ssh_ping`** — TCP reachability check with latency measurements (no SSH auth required)
- **`ssh_diff`** — compare remote file vs local or remote-vs-remote (pure-JS LCS unified diff, no shell diff binary)
- **`ssh_script`** — upload and run a local script file on remote via bash; supports args as env vars
- **`ssh_docker`** — list / logs / restart / stop / start / inspect / stats Docker containers
- **`ssh_metrics`** — structured CPU/mem/disk I/O/net I/O metrics from `/proc` directly — no external agent
- **`ssh_transfer`** — scp file transfer local↔remote or remote↔remote with profile resolution
- **`ssh_env`** — read/set/unset `/etc/environment` variables on remote
- **`ssh_process`** — list running processes or kill by PID/name
- **CLI `ssh-ops add`** — interactive wizard: prompts host/user/port/key, test-connects, saves profile
- **CLI `ssh-ops export <file.enc>`** — AES-256-GCM + PBKDF2 (100k iterations) encrypted profile bundle
- **CLI `ssh-ops import <file.enc>`** — decrypt and restore profiles from bundle
- **Per-profile file storage** — dynamic profiles now stored as individual `ssh-ops-profiles/<name>.json` files with `_index.json`; auto-migrates from `ssh-ops.dynamic.json` on first run

### Security
- Block `ProxyCommand`, `ForwardAgent`, `-L/-R/-D/-J` flags in `sshOptions`/`extraArgs` (local RCE prevention)
- `ssh_sudo_rule`: `commands` required for add; `nopasswd` defaults false; `"ALL"` needs `iAcceptRiskOfAllCommands:true`
- `sudoRuleScript` uses heredoc instead of `echo "$RULE"` — closes command-substitution RCE path
- `filePatchScript` enforces `Number.isInteger` on `startLine`/`endLine` — closes bash arithmetic injection
- `userManageScript` adds `--` before username in all `useradd`/`usermod`/`userdel` — closes argument injection
- `cronScript` rejects `\r\n\x00` in schedule/command; fixes `\s` → `[ \t]` in schedule regex
- `confirm:true` gates on `ssh_run+sudo`, `ssh_run_multi+sudo`, `ssh_add_profile`, `ssh_remove_profile`, `ssh_add_jump`, `ssh_remove_jump`
- `validateInput` expanded: global control-char reject, int ranges, POSIX username regex, path `..` blocking
- YAML parser blocks `__proto__`/`constructor`/`prototype` keys (prototype pollution prevention)
- Encryption key created with `O_EXCL` flag (TOCTOU race fix); ciphertext versioned `v1:keyId:iv:ct:tag`
- `selfUpdate` HTTP redirects pinned to `api.github.com` / `raw.githubusercontent.com`
- `ssh_ip_assign fromFile` restricted to plugin directory; error messages no longer leak file paths
- `exposeProfiles: false` now also blocks hidden tools from being called by name (not just hidden from listing)
- `ssh_list_jumps` / `ssh_list_keys` / `ssh_list_ip_groups` gated by `exposeProfiles` config flag

### Breaking Changes
- `ssh_sudo_rule add`: `commands` is now required (no longer defaults to `"ALL"`); `nopasswd` defaults to `false`
- `ssh_add_profile` / `ssh_add_jump` / `ssh_remove_profile` / `ssh_remove_jump`: now require `confirm:true`
- `ssh_run` / `ssh_run_multi` with `sudo:true`: now require `confirm:true`
- Dynamic profile storage migrated from `ssh-ops.dynamic.json` → `ssh-ops-profiles/` (auto-migrated on first run)

---

## [v1.16.0] — 2025

### Added
- SonarQube MCP server integration
- Auto-accept on Claude Code launch optimization
- Exact hostname check to prevent URL substring bypass in update checker

---

## [v1.15.0] — 2025

### Added
- `confirm:true` required for destructive operations
- Auto-update documentation in SKILL.md

---

## [v1.14.1] — 2025

### Added
- Inject SKILL.md via MCP `initialize` instructions field
- Auto-load skill via `@import` in CLAUDE.md when MCP plugin active
- Double confirmation for critical/destructive commands

---

## [v1.13.0] — 2025

### Fixed
- Installer improvements — `localSwitchUser` wizard, PowerShell skill/Gemini/wizard fixes

---

## [v1.12.0] — 2025

### Added
- Large output export to local file via scp
- `localSwitchUser` for bastion-local execution
- Compressed SKILL.md (~45% token reduction)

---

## [v1.11.0] — 2025

### Added
- `ssh_user`, `ssh_chmod`, `ssh_sudo_rule` — user and permissions management tools
- Auto-install all dependencies in both installers (bash + PowerShell)
- Smart setup wizard — auto-trigger on demo config, connection test, retry flow

---

## [v1.10.0] — 2025

### Added
- `jumpProfile`/`jumpUser` in `ssh_add_profile`
- Skill plugin install support
- Setup wizard

---

## [v1.9.1] — 2025

### Added
- Post-assign IP verification in `ssh_ip_assign`

---

## [v1.9.0] — 2025

### Added
- IP groups + `fromFile` reference in `ssh_ip_assign`
- IP alias dedup fix

---

## [v1.8.0] — 2025

### Added
- `ssh_ip_assign` — multi-IP assignment with permanent persistence across reboots

---

## [v1.7.0] — 2025

### Added
- Auth failure detection
- `ssh_list_keys`
- Credential retry flow
- Typed dynamic config

---

[v1.17.0]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.17.0
[v1.16.0]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.16.0
[v1.15.0]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.15.0
[v1.14.1]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.14.1
[v1.13.0]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.13.0
[v1.12.0]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.12.0
[v1.11.0]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.11.0
[v1.10.0]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.10.0
[v1.9.1]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.9.1
[v1.9.0]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.9.0
[v1.8.0]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.8.0
[v1.7.0]: https://github.com/rushikeshsakharleofficial/ssh-ops-mcp/releases/tag/v1.7.0
