// ssh-tools-security2.mjs — security tools: ssh_authorized_keys, ssh_fail2ban, ssh_audit, ssh_intrusion_check
import { runSshCommand, formatRunResult } from "./ssh-core.mjs";

function shellQuote(v) { return `'${String(v).replace(/'/g, "'\\''")}'`; }
function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }
function dryRunResult(toolName, args, command, target) {
  return textResult(JSON.stringify({ dryRun: true, tool: toolName, target: target || args.target || args.host || "(default)", sudo: Boolean(args.sudo), command: command || null, note: "dryRun:true — nothing executed" }, null, 2));
}
function requireConfirm(toolName, args) {
  const r = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${r}`, true);
}

function rejectControlChars(val, name) {
  if (/[\r\n\x00]/.test(val)) throw new Error(`${name} must not contain newline or null bytes`);
}

const POSIX_USER_RE = /^[a-z_][a-z0-9_-]{0,30}$/;
const IP_RE = /^[0-9a-fA-F.:\/]+$/;
const JAIL_RE = /^[a-zA-Z0-9_-]+$/;
const KEY_PREFIXES = ["ssh-rsa", "ssh-ed25519", "ssh-ecdsa", "ecdsa-sha2", "sk-ssh"];

// ─── ssh_authorized_keys ──────────────────────────────────────────────────────

function buildAuthorizedKeysScript(args) {
  const action = args.action;
  const userExpr = args.user ? shellQuote(String(args.user)) : '"$(whoami)"';

  const header = `set +e
export LC_ALL=C
_user=${userExpr}
_home=$(getent passwd "$_user" 2>/dev/null | cut -d: -f6)
[ -z "$_home" ] && _home=$(eval echo ~$_user 2>/dev/null)
_authkeys="$_home/.ssh/authorized_keys"
`;

  if (action === "list") {
    return header + `
if [ -f "$_authkeys" ]; then
  _count=$(grep -v "^#" "$_authkeys" 2>/dev/null | grep -cv "^$")
  echo "=== Authorized keys for $_user ($_count entries) ==="
  grep -v "^#" "$_authkeys" | grep -v "^$" | awk '{print NR". "$0}'
else
  echo "No authorized_keys file found at $_authkeys"
fi
`;
  }

  if (action === "add") {
    const keyJson = JSON.stringify(String(args.key));
    const commentStr = args.comment ? ` ${String(args.comment).replace(/[\r\n\x00]/g, "")}` : "";
    const fullKey = args.comment
      ? JSON.stringify(String(args.key) + commentStr)
      : keyJson;
    return header + `
_key=${fullKey}
mkdir -p "$_home/.ssh"
chmod 700 "$_home/.ssh"
touch "$_authkeys"
chmod 600 "$_authkeys"
if grep -qF "$_key" "$_authkeys" 2>/dev/null; then
  echo "Key already exists — not adding duplicate"
else
  printf '%s\\n' "$_key" >> "$_authkeys"
  echo "Key added. Total: $(grep -c . "$_authkeys") lines"
fi
`;
  }

  if (action === "remove") {
    const keyJson = JSON.stringify(String(args.key));
    return header + `
_key=${keyJson}
if [ ! -f "$_authkeys" ]; then
  echo "No authorized_keys file at $_authkeys"
  exit 0
fi
grep -vF "$_key" "$_authkeys" > "$_authkeys.tmp" && mv "$_authkeys.tmp" "$_authkeys"
echo "Key removed (if it existed). Remaining lines: $(grep -c . "$_authkeys")"
`;
  }

  throw new Error(`Unknown action: ${action}`);
}

async function handleAuthorizedKeys(args) {
  const validActions = ["list", "add", "remove"];
  if (!validActions.includes(args.action)) {
    return textResult(`ssh_authorized_keys: action must be one of ${validActions.join(", ")}`, true);
  }

  if ((args.action === "add" || args.action === "remove") && !args.confirm) {
    return requireConfirm("ssh_authorized_keys", args);
  }

  if (args.user !== undefined && args.user !== null) {
    const u = String(args.user);
    if (!POSIX_USER_RE.test(u) && u !== "root") {
      return textResult(`ssh_authorized_keys: invalid username "${u}" — must match POSIX /^[a-z_][a-z0-9_-]{0,30}$/ or be "root"`, true);
    }
  }

  if (args.action === "add" || args.action === "remove") {
    if (!args.key || typeof args.key !== "string") {
      return textResult(`ssh_authorized_keys: key is required for ${args.action}`, true);
    }
    if (/[\r\n\x00]/.test(args.key)) {
      return textResult("ssh_authorized_keys: key must not contain newlines or null bytes", true);
    }
    if (args.action === "add") {
      const hasPrefix = KEY_PREFIXES.some((p) => args.key.startsWith(p));
      if (!hasPrefix) {
        return textResult(`ssh_authorized_keys: key must start with one of: ${KEY_PREFIXES.join(", ")}`, true);
      }
    }
  }

  let command;
  try {
    command = buildAuthorizedKeysScript(args);
  } catch (e) {
    return textResult(`ssh_authorized_keys: ${e.message}`, true);
  }

  if (args.dryRun) return dryRunResult("ssh_authorized_keys", args, command);

  const useSudo = args.sudo === true || (args.user && args.user !== "" && args.user !== undefined);
  const result = await runSshCommand({ ...args, command, mode: "bash", sudo: Boolean(useSudo) });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ─── ssh_fail2ban ─────────────────────────────────────────────────────────────

function buildFail2banScript(args) {
  const action = args.action;
  const jail = args.jail || "sshd";
  const ip = args.ip ? String(args.ip) : "";
  const sudoPrefix = args.sudo !== false ? "sudo " : "";

  const header = `set +e
export LC_ALL=C
if ! command -v fail2ban-client >/dev/null 2>&1; then
  echo "fail2ban-client not found on this host" >&2; exit 1
fi
`;

  if (action === "status") {
    return header + `${sudoPrefix}fail2ban-client status\n`;
  }
  if (action === "list-jails") {
    return header + `${sudoPrefix}fail2ban-client status | grep "Jail list"\n`;
  }
  if (action === "banned-ips") {
    const jailQ = shellQuote(jail);
    return header + `${sudoPrefix}fail2ban-client status ${jailQ} | grep -E "Banned IP|Currently banned"\n`;
  }
  if (action === "ban") {
    const jailQ = shellQuote(jail);
    const ipQ = shellQuote(ip);
    return header + `${sudoPrefix}fail2ban-client set ${jailQ} banip ${ipQ}\n`;
  }
  if (action === "unban") {
    const jailQ = shellQuote(jail);
    const ipQ = shellQuote(ip);
    return header + `${sudoPrefix}fail2ban-client set ${jailQ} unbanip ${ipQ}\n`;
  }
  if (action === "reload") {
    return header + `${sudoPrefix}fail2ban-client reload\n`;
  }
  throw new Error(`Unknown action: ${action}`);
}

async function handleFail2ban(args) {
  const validActions = ["status", "list-jails", "banned-ips", "ban", "unban", "reload"];
  if (!validActions.includes(args.action)) {
    return textResult(`ssh_fail2ban: action must be one of ${validActions.join(", ")}`, true);
  }

  const mutatingActions = ["ban", "unban", "reload"];
  if (mutatingActions.includes(args.action) && !args.confirm) {
    return requireConfirm("ssh_fail2ban", args);
  }

  const jail = args.jail || "sshd";
  if (!JAIL_RE.test(jail)) {
    return textResult(`ssh_fail2ban: invalid jail name "${jail}" — only alphanumeric, hyphen, underscore allowed`, true);
  }

  if (args.action === "ban" || args.action === "unban") {
    if (!args.ip || typeof args.ip !== "string") {
      return textResult(`ssh_fail2ban: ip is required for ${args.action}`, true);
    }
    if (!IP_RE.test(String(args.ip))) {
      return textResult(`ssh_fail2ban: invalid IP address "${args.ip}"`, true);
    }
  }

  let command;
  try {
    command = buildFail2banScript(args);
  } catch (e) {
    return textResult(`ssh_fail2ban: ${e.message}`, true);
  }

  if (args.dryRun) return dryRunResult("ssh_fail2ban", args, command);

  const result = await runSshCommand({
    ...args,
    command,
    mode: "bash",
    sudo: args.sudo !== false,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {})
  });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ─── ssh_audit ────────────────────────────────────────────────────────────────

function buildAuditScript() {
  return `set +e
export LC_ALL=C

echo "=== SSH Security Audit: $(hostname) — $(date) ==="
echo ""

echo "--- SUID/SGID Files (non-standard) ---"
find / -perm /6000 -type f 2>/dev/null | grep -vE "^/(bin|sbin|usr/bin|usr/sbin|usr/lib|lib)" | head -20

echo ""
echo "--- World-Writable Directories ---"
find / -perm -o+w -type d 2>/dev/null | grep -vE "^/(proc|sys|dev|run|tmp|var/tmp)" | head -20

echo ""
echo "--- Users with Empty Passwords ---"
awk -F: '($2=="" || $2=="!!" || $2=="*"){print $1" — no password or locked"}' /etc/shadow 2>/dev/null | head -10

echo ""
echo "--- Passwordless SUDO accounts ---"
grep -r "NOPASSWD" /etc/sudoers /etc/sudoers.d/ 2>/dev/null | grep -v "^#"

echo ""
echo "--- Failed Login Attempts (last 24h) ---"
journalctl -u sshd --since "24 hours ago" 2>/dev/null | grep -c "Failed" | xargs echo "failed SSH attempts:"
grep "Failed password" /var/log/auth.log 2>/dev/null | tail -5

echo ""
echo "--- SSH Config Weaknesses ---"
grep -E "PermitRootLogin yes|PasswordAuthentication yes|PermitEmptyPasswords yes|X11Forwarding yes" /etc/ssh/sshd_config 2>/dev/null | sed 's/^/  WARNING: /'

echo ""
echo "--- Listening on 0.0.0.0 (all interfaces) ---"
ss -tlnp 2>/dev/null | grep "0.0.0.0" | awk '{print $4, $6}'

echo ""
echo "--- Recently Modified /etc files (24h) ---"
find /etc -newer /etc/passwd -type f 2>/dev/null | grep -v ".dpkg-" | head -10

echo ""
echo "=== Audit Complete ==="
`;
}

async function handleAudit(args) {
  const command = buildAuditScript();

  if (args.dryRun) return dryRunResult("ssh_audit", args, command);

  const result = await runSshCommand({
    ...args,
    command,
    mode: "bash",
    sudo: args.sudo !== false,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {})
  });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ─── ssh_intrusion_check ──────────────────────────────────────────────────────

function buildIntrusionScript(hours) {
  const h = Number(hours);
  return `set +e
export LC_ALL=C
_hours=${h}

echo "=== Intrusion Check: $(hostname) — last $_hours hours ==="
echo ""

_authlog=""
for f in /var/log/auth.log /var/log/secure /var/log/messages; do
  [ -f "$f" ] && _authlog="$f" && break
done

if [ -z "$_authlog" ]; then
  echo "Using journald (no auth.log found)"
  _authlog="journald"
fi

echo "--- Failed Login Attempts (top 10 source IPs) ---"
if [ "$_authlog" = "journald" ]; then
  journalctl -u sshd --since "$_hours hours ago" 2>/dev/null | grep "Failed password" | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+" | sort | uniq -c | sort -rn | head -10
else
  grep "Failed password" "$_authlog" 2>/dev/null | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+" | sort | uniq -c | sort -rn | head -10
fi

echo ""
echo "--- Successful Root Logins ---"
if [ "$_authlog" = "journald" ]; then
  journalctl -u sshd --since "$_hours hours ago" 2>/dev/null | grep "Accepted.*root"
else
  grep "Accepted.*root" "$_authlog" 2>/dev/null | tail -10
fi

echo ""
echo "--- Successful Logins (all users) ---"
last -a 2>/dev/null | grep -v "^wtmp\\|reboot\\|shutdown" | head -15

echo ""
echo "--- Brute Force Indicators (>10 failures from same IP) ---"
if [ "$_authlog" = "journald" ]; then
  journalctl -u sshd --since "$_hours hours ago" 2>/dev/null | grep "Failed" | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+" | sort | uniq -c | awk '$1>10{print "ALERT: "$1" failures from "$2}'
else
  grep "Failed" "$_authlog" 2>/dev/null | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+" | sort | uniq -c | awk '$1>10{print "ALERT: "$1" failures from "$2}'
fi

echo ""
echo "--- New User Accounts (recently created) ---"
awk -F: '{print $1, $3}' /etc/passwd | awk '$2>=1000 && $2<65534{print $1}' | while read u; do
  created=$(stat -c %y /home/$u 2>/dev/null | cut -d' ' -f1)
  echo "$u (home created: $created)"
done 2>/dev/null | head -10

echo ""
echo "=== Intrusion Check Complete ==="
`;
}

async function handleIntrusionCheck(args) {
  let hours = args.hours !== undefined ? Number(args.hours) : 24;
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    return textResult("ssh_intrusion_check: hours must be an integer between 1 and 168", true);
  }

  const command = buildIntrusionScript(hours);

  if (args.dryRun) return dryRunResult("ssh_intrusion_check", args, command);

  const result = await runSshCommand({
    ...args,
    command,
    mode: "bash",
    sudo: args.sudo !== false,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {})
  });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const toolDefs = [
  {
    name: "ssh_authorized_keys",
    title: "SSH Authorized Keys Management",
    description: "List, add, or remove entries in ~/.ssh/authorized_keys for any user. Validates key format before adding. Deduplicates on add.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host. Uses defaultTarget if omitted." },
        action: {
          type: "string",
          enum: ["list", "add", "remove"],
          description: "Action to perform on authorized_keys."
        },
        user: { type: "string", description: "Username whose authorized_keys to manage. Default: current SSH user. Use \"root\" for root's keys." },
        key: { type: "string", description: "Full SSH public key string for add/remove. Format: \"ssh-rsa AAAA... comment\"." },
        comment: { type: "string", description: "Optional comment to append when adding a key." },
        sudo: { type: "boolean", description: "Run via sudo. Defaults true when user differs from SSH user." },
        confirm: { type: "boolean", description: "Must be true to execute add or remove." },
        dryRun: { type: "boolean", description: "Return the bash script without executing." },
        reason: { type: "string", description: "Optional reason logged to audit log." }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_fail2ban",
    title: "SSH Fail2ban Management",
    description: "Manage fail2ban intrusion prevention: check status, list banned IPs, ban or unban specific IPs.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host. Uses defaultTarget if omitted." },
        action: {
          type: "string",
          enum: ["status", "list-jails", "banned-ips", "ban", "unban", "reload"],
          description: "Fail2ban action to perform."
        },
        jail: { type: "string", description: "Jail name. Default: sshd." },
        ip: { type: "string", description: "IP address for ban/unban." },
        sudo: { type: "boolean", description: "Run via sudo. Default true." },
        confirm: { type: "boolean", description: "Must be true to execute ban, unban, or reload." },
        dryRun: { type: "boolean", description: "Return the bash script without executing." },
        reason: { type: "string", description: "Optional reason logged to audit log." }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_audit",
    title: "SSH Security Audit",
    description: "Run a read-only security audit: SUID/SGID files, world-writable dirs, passwordless sudo accounts, users without passwords, failed login count, listening ports, SSH config weaknesses, recently modified /etc files.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host. Uses defaultTarget if omitted." },
        sudo: { type: "boolean", description: "Run via sudo (needed for /etc/shadow access). Default true." },
        timeoutMs: { type: "number", description: "Local timeout in milliseconds. Default 120000." },
        dryRun: { type: "boolean", description: "Return the bash script without executing." }
      }
    }
  },
  {
    name: "ssh_intrusion_check",
    title: "SSH Intrusion Check",
    description: "Analyze auth logs for suspicious patterns: brute force attempts, successful root logins, new sudo grants, logins from unusual IPs.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host. Uses defaultTarget if omitted." },
        hours: { type: "number", description: "Look back N hours. Default 24, max 168." },
        sudo: { type: "boolean", description: "Run via sudo. Default true." },
        timeoutMs: { type: "number", description: "Local timeout in milliseconds. Default 60000." },
        dryRun: { type: "boolean", description: "Return the bash script without executing." }
      }
    }
  }
];

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export async function handleTool(name, args) {
  if (name === "ssh_authorized_keys") return handleAuthorizedKeys(args);
  if (name === "ssh_fail2ban") return handleFail2ban(args);
  if (name === "ssh_audit") return handleAudit(args);
  if (name === "ssh_intrusion_check") return handleIntrusionCheck(args);
  return null;
}
