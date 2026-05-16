// ssh-tools-network.mjs — network security tools: ssh_firewall, ssh_ssl_cert, ssh_port_scan
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

function validatePort(port, name = "port") {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be an integer 1-65535`);
  return n;
}

// ─── ssh_firewall ────────────────────────────────────────────────────────────

function buildFirewallScript(args) {
  const action = args.action;
  const proto = args.protocol || "tcp";
  const sudoPrefix = args.sudo !== false ? "sudo " : "";

  const detectBlock = `set +e
export LC_ALL=C

if command -v ufw >/dev/null 2>&1 && ${sudoPrefix}ufw status 2>/dev/null | grep -q "Status: active"; then
  FW=ufw
elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active firewalld >/dev/null 2>&1; then
  FW=firewalld
elif command -v iptables >/dev/null 2>&1; then
  FW=iptables
else
  echo "No supported firewall found (checked: ufw, firewalld, iptables)" >&2; exit 1
fi
echo "Detected firewall: $FW"
`;

  let actionBlock = "";

  if (action === "list") {
    actionBlock = `if [ "$FW" = "ufw" ]; then ${sudoPrefix}ufw status verbose
elif [ "$FW" = "firewalld" ]; then ${sudoPrefix}firewall-cmd --list-all
else ${sudoPrefix}iptables -L -n -v --line-numbers; fi
`;
  } else if (action === "add") {
    if (args.ruleSpec) {
      const rs = String(args.ruleSpec);
      actionBlock = `_ruleSpec=${shellQuote(rs)}
if [ "$FW" = "ufw" ]; then ${sudoPrefix}ufw allow $_ruleSpec
elif [ "$FW" = "firewalld" ]; then ${sudoPrefix}firewall-cmd --permanent --add-rich-rule="$_ruleSpec" && ${sudoPrefix}firewall-cmd --reload
else ${sudoPrefix}iptables $_ruleSpec
fi
`;
    } else {
      const portNum = validatePort(args.port);
      const srcVal = args.source ? String(args.source) : "";
      const protoVal = proto;
      actionBlock = `_port=${portNum}
_proto=${shellQuote(protoVal)}
_src=${shellQuote(srcVal)}

if [ "$FW" = "ufw" ]; then
  [ -n "$_src" ] && ${sudoPrefix}ufw allow from "$_src" to any port "$_port" proto "$_proto" || ${sudoPrefix}ufw allow "$_port/$_proto"
elif [ "$FW" = "firewalld" ]; then
  if [ -n "$_src" ]; then
    _rich_add=$(printf 'rule family="ipv4" source address="%s" port port="%s" protocol="%s" accept' "$_src" "$_port" "$_proto")
    ${sudoPrefix}firewall-cmd --permanent --add-rich-rule="$_rich_add"
  else
    ${sudoPrefix}firewall-cmd --permanent --add-port="$_port/$_proto"
  fi
  ${sudoPrefix}firewall-cmd --reload
else
  [ -n "$_src" ] && ${sudoPrefix}iptables -A INPUT -p "$_proto" -s "$_src" --dport "$_port" -j ACCEPT || ${sudoPrefix}iptables -A INPUT -p "$_proto" --dport "$_port" -j ACCEPT
  echo "Rule added. Use iptables-save to persist across reboots."
fi
`;
    }
  } else if (action === "remove") {
    if (args.ruleSpec) {
      const rs = String(args.ruleSpec);
      actionBlock = `_ruleSpec=${shellQuote(rs)}
if [ "$FW" = "ufw" ]; then ${sudoPrefix}ufw delete allow $_ruleSpec
elif [ "$FW" = "firewalld" ]; then ${sudoPrefix}firewall-cmd --permanent --remove-rich-rule="$_ruleSpec" && ${sudoPrefix}firewall-cmd --reload
else ${sudoPrefix}iptables -D $_ruleSpec
fi
`;
    } else {
      const portNum = validatePort(args.port);
      const srcVal = args.source ? String(args.source) : "";
      const protoVal = proto;
      actionBlock = `_port=${portNum}
_proto=${shellQuote(protoVal)}
_src=${shellQuote(srcVal)}

if [ "$FW" = "ufw" ]; then
  [ -n "$_src" ] && ${sudoPrefix}ufw delete allow from "$_src" to any port "$_port" proto "$_proto" || ${sudoPrefix}ufw delete allow "$_port/$_proto"
elif [ "$FW" = "firewalld" ]; then
  if [ -n "$_src" ]; then
    _rich_rem=$(printf 'rule family="ipv4" source address="%s" port port="%s" protocol="%s" accept' "$_src" "$_port" "$_proto")
    ${sudoPrefix}firewall-cmd --permanent --remove-rich-rule="$_rich_rem"
  else
    ${sudoPrefix}firewall-cmd --permanent --remove-port="$_port/$_proto"
  fi
  ${sudoPrefix}firewall-cmd --reload
else
  [ -n "$_src" ] && ${sudoPrefix}iptables -D INPUT -p "$_proto" -s "$_src" --dport "$_port" -j ACCEPT || ${sudoPrefix}iptables -D INPUT -p "$_proto" --dport "$_port" -j ACCEPT
  echo "Rule removed. Use iptables-save to persist across reboots."
fi
`;
    }
  } else if (action === "flush") {
    actionBlock = `echo "WARNING: Flushing all firewall rules!"
if [ "$FW" = "ufw" ]; then ${sudoPrefix}ufw --force reset
elif [ "$FW" = "firewalld" ]; then
  ${sudoPrefix}firewall-cmd --permanent --set-default-zone=block && ${sudoPrefix}firewall-cmd --reload
  echo "firewalld default zone set to block (all traffic denied)"
else
  ${sudoPrefix}iptables -F INPUT; ${sudoPrefix}iptables -F FORWARD; ${sudoPrefix}iptables -F OUTPUT
  ${sudoPrefix}iptables -P INPUT ACCEPT; ${sudoPrefix}iptables -P FORWARD ACCEPT; ${sudoPrefix}iptables -P OUTPUT ACCEPT
  echo "All iptables chains flushed. Policies set to ACCEPT."
fi
`;
  }

  return detectBlock + actionBlock;
}

async function handleFirewall(args) {
  const validActions = ["list", "add", "remove", "flush"];
  if (!validActions.includes(args.action)) {
    return textResult(`ssh_firewall: action must be one of ${validActions.join(", ")}`, true);
  }

  if (args.action !== "list" && !args.confirm) {
    return requireConfirm("ssh_firewall", args);
  }

  if ((args.action === "add" || args.action === "remove") && !args.port && !args.ruleSpec) {
    return textResult("ssh_firewall: add/remove require port or ruleSpec", true);
  }

  if (args.port !== undefined && args.port !== null) {
    try { validatePort(args.port); } catch (e) { return textResult(`ssh_firewall: ${e.message}`, true); }
  }

  if (args.source !== undefined && args.source !== null) {
    rejectControlChars(String(args.source), "source");
    if (!/^[0-9a-fA-F.:\/]+$/.test(String(args.source))) {
      return textResult("ssh_firewall: source must be a valid IPv4/IPv6/CIDR (only digits, a-f, A-F, . : /)", true);
    }
  }

  if (args.ruleSpec !== undefined && args.ruleSpec !== null) {
    const rs = String(args.ruleSpec);
    rejectControlChars(rs, "ruleSpec");
    if (/`|\$\(|\$\{/.test(rs)) {
      return textResult("ssh_firewall: ruleSpec must not contain backticks or $( or ${", true);
    }
  }

  let command;
  try {
    command = buildFirewallScript(args);
  } catch (e) {
    return textResult(`ssh_firewall: ${e.message}`, true);
  }

  if (args.dryRun) return dryRunResult("ssh_firewall", args, command);

  const result = await runSshCommand({ ...args, command, mode: "bash", sudo: args.sudo !== false });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ─── ssh_ssl_cert ─────────────────────────────────────────────────────────────

function buildSslCertScript(host, port) {
  const hostJson = JSON.stringify(String(host));
  const portNum = port;
  return `set +e
export LC_ALL=C
_host=${hostJson}
_port=${portNum}

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl not found on remote host" >&2; exit 1
fi

_cert=$(echo | timeout 10 openssl s_client -connect "$_host:$_port" -servername "$_host" 2>/dev/null)
if [ -z "$_cert" ]; then
  echo "ERROR: Could not connect to $_host:$_port or no certificate returned" >&2; exit 1
fi

echo "=== Subject ==="
echo "$_cert" | openssl x509 -noout -subject 2>/dev/null

echo ""
echo "=== Issuer ==="
echo "$_cert" | openssl x509 -noout -issuer 2>/dev/null

echo ""
echo "=== Validity ==="
echo "$_cert" | openssl x509 -noout -dates 2>/dev/null

echo ""
echo "=== SANs ==="
echo "$_cert" | openssl x509 -noout -ext subjectAltName 2>/dev/null || echo "(none)"

echo ""
echo "=== Days until expiry ==="
_end=$(echo "$_cert" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$_end" ]; then
  _end_epoch=$(date -d "$_end" +%s 2>/dev/null)
  if [ -z "$_end_epoch" ]; then
    _end_epoch=$(date -j -f "%b %d %H:%M:%S %Y %Z" "$_end" +%s 2>/dev/null)
  fi
  _now=$(date +%s)
  _days=$(( (_end_epoch - _now) / 86400 ))
  echo "$_days days remaining"
  [ "$_days" -lt 30 ] && echo "WARNING: Expires in less than 30 days!"
  [ "$_days" -lt 0 ] && echo "ERROR: Certificate has EXPIRED!"
fi

echo ""
echo "=== Fingerprint (SHA256) ==="
echo "$_cert" | openssl x509 -noout -fingerprint -sha256 2>/dev/null
`;
}

async function handleSslCert(args) {
  if (!args.host || typeof args.host !== "string") {
    return textResult("ssh_ssl_cert: host is required", true);
  }
  rejectControlChars(args.host, "host");
  if (!/^[a-zA-Z0-9._-]+$/.test(args.host)) {
    return textResult("ssh_ssl_cert: host must contain only alphanumeric, dot, hyphen, or underscore characters", true);
  }

  let port = 443;
  if (args.port !== undefined && args.port !== null) {
    try { port = validatePort(args.port, "port"); } catch (e) { return textResult(`ssh_ssl_cert: ${e.message}`, true); }
  }

  const command = buildSslCertScript(args.host, port);

  if (args.dryRun) return dryRunResult("ssh_ssl_cert", args, command, args.target);

  const runArgs = { ...args, command, mode: "bash", sudo: false };
  if (args.timeoutMs !== undefined) runArgs.timeoutMs = args.timeoutMs;
  const result = await runSshCommand(runArgs);
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ─── ssh_port_scan ────────────────────────────────────────────────────────────

function buildPortScanScript(args) {
  const proto = args.proto || "tcp";
  const filterVal = args.filter ? String(args.filter) : "";

  let ssFlags, netstatFlags;
  if (proto === "tcp") { ssFlags = "-tlnp"; netstatFlags = "-tlnp"; }
  else if (proto === "udp") { ssFlags = "-ulnp"; netstatFlags = "-ulnp"; }
  else { ssFlags = "-tlnpu"; netstatFlags = "-tlnpu"; }

  const filterLine = filterVal
    ? `_filter=${shellQuote(filterVal)}`
    : `_filter=''`;

  return `set +e
export LC_ALL=C
${filterLine}

if command -v ss >/dev/null 2>&1; then
  echo "=== Listening ports (ss) ==="
  _out=$(ss ${ssFlags} 2>/dev/null)
else
  echo "=== Listening ports (netstat) ==="
  _out=$(netstat ${netstatFlags} 2>/dev/null)
fi

if [ -n "$_filter" ]; then
  echo "$_out" | grep -i "$_filter"
else
  echo "$_out"
fi

echo ""
echo "=== Summary count ==="
echo "$_out" | tail -n +2 | wc -l | xargs echo "listening entries:"
`;
}

async function handlePortScan(args) {
  const validProtos = ["tcp", "udp", "all"];
  if (args.proto !== undefined && !validProtos.includes(args.proto)) {
    return textResult(`ssh_port_scan: proto must be one of ${validProtos.join(", ")}`, true);
  }

  if (args.filter !== undefined && args.filter !== null) {
    rejectControlChars(String(args.filter), "filter");
    if (!/^[a-zA-Z0-9._:@-]+$/.test(String(args.filter))) {
      return textResult("ssh_port_scan: filter must contain only alphanumeric, dot, underscore, colon, @, or hyphen characters", true);
    }
  }

  const command = buildPortScanScript(args);

  if (args.dryRun) return dryRunResult("ssh_port_scan", args, command);

  const runArgs = { ...args, command, mode: "bash", sudo: args.sudo !== false };
  if (args.timeoutMs !== undefined) runArgs.timeoutMs = args.timeoutMs;
  const result = await runSshCommand(runArgs);
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const toolDefs = [
  {
    name: "ssh_firewall",
    title: "SSH Firewall Management",
    description: "Manage firewall rules on a remote host. Auto-detects ufw, firewalld, or iptables. list is read-only; add/remove/flush require confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host. Uses defaultTarget if omitted." },
        action: {
          type: "string",
          enum: ["list", "add", "remove", "flush"],
          description: "Firewall action to perform."
        },
        protocol: {
          type: "string",
          enum: ["tcp", "udp", "any"],
          description: "Protocol for rule. Default tcp."
        },
        port: { type: "number", description: "Port 1-65535 for add/remove." },
        source: { type: "string", description: "Source IP or CIDR for add/remove (optional)." },
        ruleSpec: { type: "string", description: "Raw rule spec for advanced use (ufw rule string or iptables args)." },
        sudo: { type: "boolean", description: "Run commands via sudo. Default true." },
        confirm: { type: "boolean", description: "Must be true to execute add/remove/flush." },
        dryRun: { type: "boolean", description: "Return the bash script without executing." },
        reason: { type: "string", description: "Optional reason logged to audit log." }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_ssl_cert",
    title: "SSH TLS Certificate Check",
    description: "Check TLS certificate expiry and details for a domain. Runs openssl s_client from the remote SSH host — useful for checking certificates of internal services not reachable from local.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "SSH profile or user@host (where to run openssl from)." },
        host: { type: "string", description: "Hostname or IP to check TLS for." },
        port: { type: "number", description: "TLS port. Default 443." },
        timeoutMs: { type: "number", description: "Local timeout in milliseconds." },
        dryRun: { type: "boolean", description: "Return the bash script without executing." }
      },
      required: ["host"]
    }
  },
  {
    name: "ssh_port_scan",
    title: "SSH Listening Ports",
    description: "List all listening ports on a remote host using ss (or netstat fallback). Requires sudo for full PID/process name info.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host. Uses defaultTarget if omitted." },
        proto: {
          type: "string",
          enum: ["tcp", "udp", "all"],
          description: "Protocol filter. Default tcp."
        },
        sudo: { type: "boolean", description: "Run via sudo for PID visibility. Default true." },
        filter: { type: "string", description: "Optional grep filter on output." },
        timeoutMs: { type: "number", description: "Local timeout in milliseconds." },
        dryRun: { type: "boolean", description: "Return the bash script without executing." }
      }
    }
  }
];

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export async function handleTool(name, args) {
  if (name === "ssh_firewall") return handleFirewall(args);
  if (name === "ssh_ssl_cert") return handleSslCert(args);
  if (name === "ssh_port_scan") return handlePortScan(args);
  return null;
}
