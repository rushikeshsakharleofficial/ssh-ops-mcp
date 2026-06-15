# FIXES.md — ssh-ops-mcp Bug Fix Summary

Branch: `fix/all-issues-p0-p1`

---

## P0 Fixes

### 1. Extra tool modules now loaded (`ssh-mcp-server.mjs`)
`_extraModules` was hard-coded to `[]`. The server now dynamically imports all
`scripts/ssh-tools-*.mjs` files at startup, merges their `toolDefs` into
`tools/list`, and dispatches `tools/call` to their `handleTool()`. Tool count
increased from ~30 built-ins to **92 tools** including `ssh_compose`, `ssh_k8s`,
`ssh_firewall`, `ssh_ssl_cert`, `ssh_fleet_health`, and more.

### 2. Field-aware validation — multi-line commands now accepted (`ssh-mcp-server.mjs`)
The global validator rejected newlines in every string parameter, breaking
`ssh_run` multi-line scripts and `ssh_file_write` multi-line content.
Replaced with field-aware logic: NUL bytes rejected everywhere; newlines
permitted in `command`, `content`, `replacement`, `script`, `body`, `template`;
all other fields remain strict. `ssh_cron` keeps its own single-line check.

### 3. Safe shell quoting — replaced `JSON.stringify` with `shellQuote` (`ssh-mcp-server.mjs`, `ssh-tools-network.mjs`)
`JSON.stringify()` produces double-quoted strings that allow `$()` and `$VAR`
shell expansion — a command injection risk. Replaced with the existing
`shellQuote()` (POSIX single-quote escape) in:
- `ssh_docker`: container name, `--since` value
- `ssh_env`: key and value in `set` action
- `ssh_process`: `filter` and `processName`
- `ssh_script`: exported arg values
- `ssh_ssl_cert` in `ssh-tools-network.mjs`: host parameter
Also exported `shellQuote` from `ssh-core.mjs` for use by extra modules.

### 4. `localSwitchUser` now persisted in `addProfile()` (`ssh-core.mjs`)
`addProfile()` accepted `localSwitchUser` from the tool schema but never
included it in the saved profile entry. Added `...(profile.localSwitchUser && { localSwitchUser: profile.localSwitchUser })` to the entry object.

### 5. `confirm`/`reason` added to mutating tool schemas (`ssh-mcp-server.mjs`)
`ssh_add_profile`, `ssh_remove_profile`, `ssh_add_jump`, `ssh_remove_jump`
required `confirm:true` in code but omitted the fields from their `inputSchema`.
Added `confirm` and `reason` to all four schemas.

---

## P1 Fixes

### 6. Retry options propagated through `runSshCommand()` (`ssh-core.mjs`)
`ssh_run` and other callers pass `retries`/`retryDelayMs` to `runSshCommand()`,
but `runSshCommand()` did not forward them to `runProcess()`. Added
`retries` and `retryDelayMs` to the `runProcess()` options object.

### 7. VERSION path corrected (`ssh-mcp-server.mjs`)
`SERVER_VERSION` read `join(PLUGIN_ROOT, "..", "VERSION")` but `PLUGIN_ROOT`
already resolves to the install root. Fixed to `join(PLUGIN_ROOT, "VERSION")`.

### 8. Incomplete runtime self-update disabled (`ssh-mcp-server.mjs`)
`selfUpdate()` downloaded only 4 files while the installer deploys 20+ modules,
leaving a mixed-version state. Disabled the `selfUpdate()` call from
`initialize()`. Users should rerun `install.sh` / `install.ps1` to update.

### 9. Recursive audit log redaction (`ssh-mcp-server.mjs`)
Audit log only redacted the top-level `password` key and truncated long
`content`. Added `redactDeep()` with `REDACT_KEYS` regex covering:
password, pass, token, secret, key, private, credential, auth, cookie, header.
Applies recursively to nested objects. Strings longer than 500 chars are
truncated. Log shipping sends only the redacted payload.

### 10. CLI export/import round-trip (`ssh-core.mjs`, `ssh-ops.mjs`)
`ssh-ops export` used the sanitized `listProfiles()` display output (no
encrypted passwords, no jump config, no ipGroups). `ssh-ops import` only
restored `host`/`user`/`port`. Added `exportRawConfig()` and `importRawConfig()`
to `ssh-core.mjs` that read/write raw profile files and the index (including
`encryptedPassword`, `identityFile`, `jumpProfile`, `jumpUser`, `targetUser`,
`localSwitchUser`, `extraArgs`, `shell`, `defaults`, `jumpChain`, `ipGroups`).
Bundle version bumped to v2; v1 bundles still import via legacy path.

### 11. Passphrase input hidden in CLI export/import (`ssh-ops.mjs`)
`rl.question("Passphrase: ", ...)` echoed every character. Added
`readHiddenLine()` that uses `process.stdin.setRawMode(true)` to suppress echo,
handles Ctrl-C, Backspace, Enter. Falls back to plain readline when stdin is
not a TTY (piped input).

### 12. Windows absolute paths accepted in file tools (`ssh-mcp-server.mjs`)
`validateInput()` rejected any path not starting with `/`, breaking
`ssh_file_read`/`ssh_file_write`/`ssh_file_patch` on Windows targets.
Now accepts Windows drive paths (`C:\Temp\file.txt`) and UNC paths
(`\\server\share\file.txt`, `//server/share/file`). NUL and `..` traversal
checks applied to all formats.

### 13. `ssh_transfer` reuses profile SSH options (`ssh-mcp-server.mjs`)
`ssh_transfer` resolved profiles to `user@host` but dropped port, identity
file, jump chain, and timeout. Now extracts these from `resolveTarget()` info
and passes them as scp flags (`-P`, `-i`, `-J`). Adds a process timeout
via `setTimeout`/`proc.kill()`. Password-based profiles return a clear error
(scp does not support sshpass safely).

---

## P2 Fixes

### 14. README dependency claims corrected (`README.md`)
"Zero external dependencies" and "No prerequisites" were inaccurate — the
installer installs system packages and AI CLI integrations. Updated to
distinguish runtime (Node.js built-ins only, no npm install) from
installer-time (OS packages, node, sshpass, etc.).

### 15. YAML subset documented (`ssh-ops.config.example.yaml`)
The custom YAML parser supports a small subset. Added a header comment
documenting what is supported (key:value, nested objects, inline arrays,
quoted strings, booleans, numbers) and what is not (block sequences,
multiline strings, anchors, tags, flow mappings).

---

## Test Results

```
ssh-mcp-protocol.test.mjs   5/5 pass
ssh-ops.test.mjs            84/84 pass
Total                       89/89 pass
```

MCP smoke test: 92 tools exposed (was ~30 before fix #1).
