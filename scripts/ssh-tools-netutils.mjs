// ssh-tools-netutils.mjs — network utils: ssh_dns_check, ssh_traceroute, ssh_hosts
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

const DOMAIN_RE = /^[a-zA-Z0-9._-]+$/;
const HOST_RE = /^[a-zA-Z0-9._-]+$/;
const IP_RE = /^[0-9a-fA-F.:]+$/;
const HOSTNAME_MULTI_RE = /^[a-zA-Z0-9._-]+([ \t][a-zA-Z0-9._-]+)*$/;

export const toolDefs = [
  {
    name: "ssh_dns_check",
    title: "SSH DNS Resolution Check",
    description: "Perform DNS lookups FROM the remote server using dig/nslookup/host. Useful for verifying DNS resolution as seen by the server itself.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        target:      { type: "string", description: "SSH profile/host" },
        domain:      { type: "string", description: "Domain to resolve" },
        type:        { type: "string", enum: ["A","AAAA","MX","NS","TXT","CNAME","PTR","SOA","ANY"], description: "Record type (default A)" },
        nameserver:  { type: "string", description: "Optional specific nameserver to query" },
        short:       { type: "boolean", description: "Short output only (default false)" },
        timeoutMs:   { type: "number" }
      }
    }
  },
  {
    name: "ssh_traceroute",
    title: "SSH Traceroute",
    description: "Run traceroute/tracepath/mtr from the remote server to diagnose network paths.",
    inputSchema: {
      type: "object",
      required: ["host"],
      properties: {
        target:    { type: "string", description: "SSH profile/host" },
        host:      { type: "string", description: "Destination host to trace" },
        tool:      { type: "string", enum: ["auto","traceroute","tracepath","mtr"], description: "Tool to use (default auto)" },
        maxHops:   { type: "number", description: "Max hops (default 20)" },
        timeoutMs: { type: "number", description: "Timeout ms (default 60000)" }
      }
    }
  },
  {
    name: "ssh_hosts",
    title: "SSH /etc/hosts Management",
    description: "List, add, or remove /etc/hosts entries on a remote host.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target:   { type: "string", description: "SSH profile/host" },
        action:   { type: "string", enum: ["list","add","remove"], description: "Action to perform" },
        ip:       { type: "string", description: "IP address for add/remove" },
        hostname: { type: "string", description: "Hostname(s) for add (space-separated)" },
        comment:  { type: "string", description: "Optional inline comment for add" },
        sudo:     { type: "boolean", description: "Use sudo (default true)" },
        confirm:  { type: "boolean", description: "Required for add/remove" },
        dryRun:   { type: "boolean" },
        reason:   { type: "string" }
      }
    }
  }
];

export async function handleTool(name, args) {
  if (name === "ssh_dns_check") return handleDnsCheck(args);
  if (name === "ssh_traceroute") return handleTraceroute(args);
  if (name === "ssh_hosts")     return handleHosts(args);
  return null;
}

// ── ssh_dns_check ────────────────────────────────────────────────────────────

async function handleDnsCheck(args) {
  const domain = String(args.domain || "").trim();
  if (!domain) return textResult("dns_check: domain is required", true);
  if (!DOMAIN_RE.test(domain)) return textResult(`dns_check: invalid domain ${JSON.stringify(domain)}`, true);

  const recordType = String(args.type || "A");
  const short = Boolean(args.short);
  const nameserver = args.nameserver ? String(args.nameserver).trim() : "";

  if (nameserver) {
    if (!IP_RE.test(nameserver) && !DOMAIN_RE.test(nameserver)) {
      return textResult(`dns_check: invalid nameserver ${JSON.stringify(nameserver)}`, true);
    }
  }

  const qDomain = JSON.stringify(domain);
  const qNs = nameserver ? JSON.stringify(nameserver) : "";

  const nsArgDig   = nameserver ? ` @${nameserver}` : "";
  const nsArgOther = nameserver ? ` ${nameserver}` : "";
  const shortFlag  = short ? " +short" : "";

  const bash = `set +e
export LC_ALL=C
_domain=${qDomain}
_type=${JSON.stringify(recordType)}

if command -v dig >/dev/null 2>&1; then
  echo "=== dig $_type $_domain ==="
  dig $_type "$_domain"${nsArgDig}${shortFlag} 2>&1
elif command -v nslookup >/dev/null 2>&1; then
  echo "=== nslookup $_domain ==="
  nslookup -type=$_type "$_domain"${nameserver ? ` ${qNs}` : ""} 2>&1
elif command -v host >/dev/null 2>&1; then
  echo "=== host $_domain ==="
  host -t $_type "$_domain"${nameserver ? ` ${qNs}` : ""} 2>&1
else
  echo "No DNS tools found (dig/nslookup/host)" >&2; exit 1
fi

echo ""
echo "=== Server's /etc/resolv.conf ==="
cat /etc/resolv.conf 2>/dev/null
`;

  try {
    const result = await runSshCommand({
      target: args.target,
      command: bash,
      mode: "bash",
      timeoutMs: args.timeoutMs
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  } catch (e) {
    return textResult(`ssh_dns_check error: ${e.message}`, true);
  }
}

// ── ssh_traceroute ───────────────────────────────────────────────────────────

async function handleTraceroute(args) {
  const host = String(args.host || "").trim();
  if (!host) return textResult("traceroute: host is required", true);
  if (!HOST_RE.test(host)) return textResult(`traceroute: invalid host ${JSON.stringify(host)}`, true);

  const tool = String(args.tool || "auto");
  const maxHops = Math.max(1, Math.min(64, Math.round(Number(args.maxHops) || 20)));
  const timeoutMs = Number(args.timeoutMs) || 60000;

  const qHost = JSON.stringify(host);

  const bash = `set +e
export LC_ALL=C
_dest=${qHost}
_hops=${maxHops}

if [ "${tool}" = "mtr" ] || { [ "${tool}" = "auto" ] && command -v mtr >/dev/null 2>&1; }; then
  timeout 55 mtr --report --report-cycles 3 --max-ttl "$_hops" "$_dest" 2>&1
elif [ "${tool}" = "tracepath" ] || { [ "${tool}" = "auto" ] && command -v tracepath >/dev/null 2>&1; }; then
  timeout 55 tracepath -m "$_hops" "$_dest" 2>&1
elif command -v traceroute >/dev/null 2>&1; then
  timeout 55 traceroute -m "$_hops" "$_dest" 2>&1
else
  echo "No traceroute tool found (mtr/tracepath/traceroute)" >&2; exit 1
fi
`;

  try {
    const result = await runSshCommand({
      target: args.target,
      command: bash,
      mode: "bash",
      timeoutMs
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  } catch (e) {
    return textResult(`ssh_traceroute error: ${e.message}`, true);
  }
}

// ── ssh_hosts ────────────────────────────────────────────────────────────────

async function handleHosts(args) {
  const action = String(args.action || "").trim();
  if (!["list","add","remove"].includes(action)) {
    return textResult(`ssh_hosts: action must be list|add|remove`, true);
  }

  const sudo = args.sudo !== false;
  const sudoPrefix = sudo ? "sudo " : "";

  if (action === "list") {
    const bash = `set +e\nexport LC_ALL=C\n${sudoPrefix}cat /etc/hosts\n`;
    try {
      const result = await runSshCommand({ target: args.target, command: bash, mode: "bash" });
      return textResult(formatRunResult(result), result.exitCode !== 0);
    } catch (e) {
      return textResult(`ssh_hosts error: ${e.message}`, true);
    }
  }

  // add / remove — require confirm
  if (!args.confirm) return requireConfirm("ssh_hosts", args);

  const ip = String(args.ip || "").trim();
  if (!ip) return textResult("ssh_hosts: ip is required for add/remove", true);
  if (!IP_RE.test(ip)) return textResult(`ssh_hosts: invalid ip ${JSON.stringify(ip)}`, true);

  const qIp = JSON.stringify(ip);

  if (action === "add") {
    const hostname = String(args.hostname || "").trim();
    if (!hostname) return textResult("ssh_hosts: hostname is required for add", true);
    if (!HOSTNAME_MULTI_RE.test(hostname)) return textResult(`ssh_hosts: invalid hostname ${JSON.stringify(hostname)}`, true);

    const comment = args.comment ? String(args.comment).replace(/[\r\n]/g, "") : "";
    const qHostname = JSON.stringify(hostname);
    const qComment  = JSON.stringify(comment);

    if (args.dryRun) {
      const entry = comment ? `${ip}\t${hostname} # ${comment}` : `${ip}\t${hostname}`;
      return dryRunResult("ssh_hosts", args, `add: "${entry}"`, args.target);
    }

    const bash = `set +e
export LC_ALL=C
_ip=${qIp}
_hn=${qHostname}
_comment=${qComment}
_entry=$(printf '%s\\t%s' "$_ip" "$_hn")
[ -n "$_comment" ] && _entry="$_entry # $_comment"

if ${sudoPrefix}grep -qF "$_ip" /etc/hosts; then
  echo "Warning: IP already exists in /etc/hosts:"
  ${sudoPrefix}grep "$_ip" /etc/hosts
fi
echo "$_entry" | ${sudoPrefix}tee -a /etc/hosts >/dev/null
echo "Added: $_entry"
`;
    try {
      const result = await runSshCommand({ target: args.target, command: bash, mode: "bash" });
      return textResult(formatRunResult(result), result.exitCode !== 0);
    } catch (e) {
      return textResult(`ssh_hosts error: ${e.message}`, true);
    }
  }

  // remove
  if (args.dryRun) {
    return dryRunResult("ssh_hosts", args, `remove entries for ip: ${ip}`, args.target);
  }

  const bash = `set +e
export LC_ALL=C
_ip=${qIp}
${sudoPrefix}cp /etc/hosts /etc/hosts.bak.$(date +%s)
${sudoPrefix}grep -v "^${ip}[[:space:]]" /etc/hosts > /tmp/_hosts_tmp && ${sudoPrefix}mv /tmp/_hosts_tmp /etc/hosts
echo "Removed entries for ${ip}"
${sudoPrefix}grep "${ip}" /etc/hosts || echo "(no more entries for this IP)"
`;

  try {
    const result = await runSshCommand({ target: args.target, command: bash, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  } catch (e) {
    return textResult(`ssh_hosts error: ${e.message}`, true);
  }
}
