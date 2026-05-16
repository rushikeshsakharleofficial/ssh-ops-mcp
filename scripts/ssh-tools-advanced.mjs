// ssh-tools-advanced.mjs — advanced tools: ssh_template, ssh_snapshot, ssh_compare
import { runSshCommand, formatRunResult, fileWriteScript } from "./ssh-core.mjs";

function shellQuote(v) { return `'${String(v).replace(/'/g, "'\\''")}'`; }
function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }
function dryRunResult(toolName, args, command, target) {
  return textResult(JSON.stringify({
    dryRun: true,
    tool: toolName,
    target: target || args.target || args.host || "(default)",
    sudo: Boolean(args.sudo),
    command: command || null,
    note: "dryRun:true — nothing executed"
  }, null, 2));
}
function requireConfirm(toolName, args) {
  const r = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${r}`, true);
}

const SNAPSHOT_SCRIPT = `set +e
export LC_ALL=C

_os_name=$(grep "^PRETTY_NAME" /etc/os-release 2>/dev/null | cut -d'"' -f2 || uname -s)
_kernel=$(uname -r)
_arch=$(uname -m)
_hostname=$(hostname -f 2>/dev/null || hostname)
_uptime_sec=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)

_cpu_cores=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)
_cpu_model=$(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | sed 's/^ *//')

_mem_total=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
_mem_avail=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
_mem_used=$(( _mem_total - _mem_avail ))

_load=$(awk '{print $1","$2","$3}' /proc/loadavg 2>/dev/null)

_disk_info=$(df -h / 2>/dev/null | tail -1 | awk '{print $2","$3","$4","$5}')

_services=$(systemctl list-units --state=running --type=service --no-pager --plain 2>/dev/null | awk 'NR>1{print $1}' | head -20 | tr '\\n' ',' | sed 's/,$//')

_ports=$(ss -tlnp 2>/dev/null | tail -n +2 | awk '{print $4}' | head -20 | tr '\\n' ',' | sed 's/,$//')

_users=$(who 2>/dev/null | awk '{print $1}' | sort -u | tr '\\n' ',' | sed 's/,$//')

_pkg_count=0
if command -v dpkg >/dev/null 2>&1; then _pkg_count=$(dpkg -l 2>/dev/null | grep -c "^ii")
elif command -v rpm >/dev/null 2>&1; then _pkg_count=$(rpm -qa 2>/dev/null | wc -l); fi

_user_count=$(awk -F: '$3>=1000 && $3<65534' /etc/passwd 2>/dev/null | wc -l)

_top_procs=$(ps aux --sort=-%cpu 2>/dev/null | tail -n +2 | head -5 | awk '{printf "%s(%s%%cpu),",$11,$3}' | sed 's/,$//')

_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

printf '{
  "ts": "%s",
  "hostname": "%s",
  "os": "%s",
  "kernel": "%s",
  "arch": "%s",
  "uptimeSec": %s,
  "cpu": {"cores": %s, "model": "%s"},
  "memoryMB": {"total": %s, "used": %s, "available": %s},
  "load": {"1m": %s, "5m": %s, "15m": %s},
  "disk_root": "%s",
  "runningServices": "%s",
  "listeningPorts": "%s",
  "loggedInUsers": "%s",
  "installedPackages": %s,
  "userAccounts": %s,
  "topCpuProcs": "%s"
}\\n' \
  "$_ts" "$_hostname" "$_os_name" "$_kernel" "$_arch" "$_uptime_sec" \
  "$_cpu_cores" "$_cpu_model" \
  "$_mem_total" "$_mem_used" "$_mem_avail" \
  "$(echo $_load | cut -d, -f1)" "$(echo $_load | cut -d, -f2)" "$(echo $_load | cut -d, -f3)" \
  "$_disk_info" "$_services" "$_ports" "$_users" \
  "$_pkg_count" "$_user_count" "$_top_procs"
`;

export const toolDefs = [
  {
    name: "ssh_template",
    title: "SSH Template Deploy",
    description: "Render a template string (using {{VAR}} placeholders) with provided variables, then write the rendered content to a remote path.",
    inputSchema: {
      type: "object",
      properties: {
        target:     { type: "string",  description: "Profile name or user@host" },
        template:   { type: "string",  description: "Template content with {{VAR}} placeholders" },
        vars:       { type: "object",  description: "Key-value pairs for template substitution", additionalProperties: { type: "string" } },
        remotePath: { type: "string",  description: "Absolute remote destination path" },
        backup:     { type: "boolean", description: "Backup existing file before overwrite, default true" },
        sudo:       { type: "boolean", description: "Write via sudo" },
        confirm:    { type: "boolean", description: "Required to execute" },
        dryRun:     { type: "boolean", description: "Preview without executing" },
        reason:     { type: "string",  description: "Reason for the change" }
      },
      required: ["template", "remotePath"]
    }
  },
  {
    name: "ssh_snapshot",
    title: "SSH Server Snapshot",
    description: "Capture a structured JSON snapshot of server state: OS, memory, CPU, disk, load, running services, listening ports, logged-in users, cron jobs, and top processes.",
    inputSchema: {
      type: "object",
      properties: {
        target:      { type: "string",  description: "Profile name or user@host" },
        timeoutMs:   { type: "number",  description: "Timeout in ms, default 60000" },
        includeSudo: { type: "boolean", description: "Try sudo for more details, default false" }
      }
    }
  },
  {
    name: "ssh_compare",
    title: "SSH Server Comparison",
    description: "Compare configuration and state between two servers by running snapshots on both and diffing the results. Useful for detecting config drift.",
    inputSchema: {
      type: "object",
      properties: {
        target1:   { type: "string", description: "First profile or user@host" },
        target2:   { type: "string", description: "Second profile or user@host" },
        timeoutMs: { type: "number", description: "Per-target timeout ms, default 60000" }
      },
      required: ["target1", "target2"]
    }
  }
];

export async function handleTool(name, args) {
  // ── ssh_template ──────────────────────────────────────────────────────────
  if (name === "ssh_template") {
    if (!args.template) return textResult("template is required.", true);
    if (!args.remotePath) return textResult("remotePath is required.", true);

    // Validate remotePath
    const rp = String(args.remotePath);
    if (!rp.startsWith("/")) return textResult("remotePath must be absolute.", true);
    if (rp.includes("..")) return textResult("remotePath must not contain '..'.", true);
    if (rp.includes("\0")) return textResult("remotePath must not contain null bytes.", true);

    // Render template locally
    let rendered = String(args.template);
    for (const [key, value] of Object.entries(args.vars || {})) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        return textResult(`Invalid variable name: ${key}`, true);
      }
      rendered = rendered.replaceAll(`{{${key}}}`, String(value));
    }

    // Check for unreplaced placeholders
    const unreplaced = [...rendered.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]);
    if (unreplaced.length > 0) {
      return textResult(`Unreplaced template variables: ${unreplaced.join(", ")}`, true);
    }

    if (args.dryRun) {
      return textResult(JSON.stringify({
        dryRun: true,
        tool: "ssh_template",
        target: args.target || "(default)",
        sudo: Boolean(args.sudo),
        remotePath: rp,
        renderedContent: rendered,
        note: "dryRun:true — nothing executed"
      }, null, 2));
    }

    if (!args.confirm) return requireConfirm("ssh_template", args);

    const command = fileWriteScript(rp, rendered, {
      backup: args.backup !== false,
      sudo: Boolean(args.sudo)
    });

    const result = await runSshCommand({ ...args, command, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── ssh_snapshot ──────────────────────────────────────────────────────────
  if (name === "ssh_snapshot") {
    const result = await runSshCommand({
      ...args,
      command: SNAPSHOT_SCRIPT,
      mode: "bash",
      timeoutMs: args.timeoutMs || 60_000
    });

    if (result.exitCode !== 0 && !result.stdout) {
      return textResult(formatRunResult(result), true);
    }

    // Try to pretty-print JSON
    try {
      const parsed = JSON.parse(result.stdout);
      return textResult(JSON.stringify(parsed, null, 2));
    } catch {
      return textResult(result.stdout || formatRunResult(result), result.exitCode !== 0);
    }
  }

  // ── ssh_compare ───────────────────────────────────────────────────────────
  if (name === "ssh_compare") {
    if (!args.target1 || !args.target2) {
      return textResult("target1 and target2 are required.", true);
    }

    const timeoutMs = args.timeoutMs || 60_000;

    const [r1, r2] = await Promise.all([
      runSshCommand({ target: args.target1, command: SNAPSHOT_SCRIPT, mode: "bash", timeoutMs }),
      runSshCommand({ target: args.target2, command: SNAPSHOT_SCRIPT, mode: "bash", timeoutMs })
    ]);

    let snap1, snap2;
    try { snap1 = JSON.parse(r1.stdout || "{}"); } catch { snap1 = null; }
    try { snap2 = JSON.parse(r2.stdout || "{}"); } catch { snap2 = null; }

    if (!snap1) return textResult(`Failed to snapshot ${args.target1}: ${r1.stderr || r1.stdout}`, true);
    if (!snap2) return textResult(`Failed to snapshot ${args.target2}: ${r2.stderr || r2.stdout}`, true);

    const lines = [
      `=== Server Comparison: ${args.target1} vs ${args.target2} ===`,
      `Timestamp: ${new Date().toISOString()}`,
      ""
    ];

    const compareField = (label, v1, v2) => {
      const s1 = typeof v1 === "object" ? JSON.stringify(v1) : String(v1 ?? "(none)");
      const s2 = typeof v2 === "object" ? JSON.stringify(v2) : String(v2 ?? "(none)");
      const match = s1 === s2;
      lines.push(`${match ? "  " : "! "} ${label}:`);
      lines.push(`    ${args.target1}: ${s1}`);
      lines.push(`    ${args.target2}: ${s2}`);
      if (!match) lines.push(`    ^ DIFFERS`);
      lines.push("");
    };

    compareField("OS", snap1.os, snap2.os);
    compareField("Kernel", snap1.kernel, snap2.kernel);
    compareField("CPU Cores", snap1.cpu?.cores, snap2.cpu?.cores);
    compareField("Memory Total (MB)", snap1.memoryMB?.total, snap2.memoryMB?.total);
    compareField("Installed Packages", snap1.installedPackages, snap2.installedPackages);
    compareField("User Accounts", snap1.userAccounts, snap2.userAccounts);
    compareField("Uptime (sec)", snap1.uptimeSec, snap2.uptimeSec);

    const svc1 = new Set((snap1.runningServices || "").split(",").filter(Boolean));
    const svc2 = new Set((snap2.runningServices || "").split(",").filter(Boolean));
    const onlyIn1 = [...svc1].filter(s => !svc2.has(s));
    const onlyIn2 = [...svc2].filter(s => !svc1.has(s));
    if (onlyIn1.length || onlyIn2.length) {
      lines.push(`! Running Services (DIFFERS):`);
      if (onlyIn1.length) lines.push(`    Only on ${args.target1}: ${onlyIn1.join(", ")}`);
      if (onlyIn2.length) lines.push(`    Only on ${args.target2}: ${onlyIn2.join(", ")}`);
    } else {
      lines.push(`  Running Services: match (${svc1.size} services)`);
    }
    lines.push("");

    const diffCount = lines.filter(l => l.startsWith("! ")).length;
    lines.unshift(`Summary: ${diffCount} field(s) differ\n`);

    return textResult(lines.join("\n"));
  }

  return null;
}
