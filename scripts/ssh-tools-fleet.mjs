// ssh-tools-fleet.mjs — fleet tools: ssh_fleet_health, ssh_anomaly, ssh_change_tracker
import { runSshCommand, formatRunResult, runMultiSshCommand, listProfiles } from "./ssh-core.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ANOMALY_STORE = join(PLUGIN_ROOT, "ssh-ops-anomaly.json");

function shellQuote(v) { return `'${String(v).replace(/'/g, "'\\''")}'`; }
function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }
function dryRunResult(toolName, args, command, target) {
  return textResult(JSON.stringify({ dryRun: true, tool: toolName, target: target || args.target || args.host || "(default)", sudo: Boolean(args.sudo), command: command || null, note: "dryRun:true — nothing executed" }, null, 2));
}
function requireConfirm(toolName, args) {
  const r = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${r}`, true);
}

function validatePath(path) {
  if (typeof path !== "string") return "path must be a string";
  if (!path.startsWith("/")) return "path must be absolute (start with /)";
  if (path.includes("..")) return "path must not contain ..";
  if (/[\x00\r\n]/.test(path)) return "path must not contain null bytes or newlines";
  return null;
}

function loadAnomalyStore() {
  try { return JSON.parse(readFileSync(ANOMALY_STORE, "utf8")); } catch { return {}; }
}

function saveAnomalyStore(data) {
  writeFileSync(ANOMALY_STORE, JSON.stringify(data, null, 2));
}

export const toolDefs = [
  {
    name: "ssh_fleet_health",
    title: "SSH Fleet Health Dashboard",
    description: "Run health checks across ALL configured profiles in parallel and return a summary table showing status, CPU%, mem%, disk%, and failed services per server.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Filter profiles by group field. Default: all profiles." },
        timeoutMs: { type: "number", description: "Per-server timeout in ms. Default 30000." },
        includeSudo: { type: "boolean", description: "Try sudo for richer data. Default false." }
      }
    }
  },
  {
    name: "ssh_anomaly",
    title: "SSH Metric Anomaly Detection",
    description: "Compare current server metrics to a rolling baseline. Flags significant deviations in CPU, memory, disk, and load. Stores baseline locally per target.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Required. Profile name or user@host." },
        updateBaseline: { type: "boolean", description: "Update stored baseline with current values. Default false." },
        sensitivity: { type: "string", enum: ["low", "medium", "high"], description: "Deviation threshold. low=3x, medium=2x, high=1.5x stddev. Default medium." },
        timeoutMs: { type: "number", description: "SSH timeout in ms." }
      },
      required: ["target"]
    }
  },
  {
    name: "ssh_change_tracker",
    title: "SSH Filesystem Change Tracker",
    description: "Find files modified in the last N minutes on a remote host. Useful for detecting unexpected changes after deployments or incidents.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host." },
        minutes: { type: "number", description: "Look back N minutes. Default 60. Max 10080 (1 week)." },
        path: { type: "string", description: "Absolute path to search. Default /." },
        exclude: { type: "array", items: { type: "string" }, description: "Additional paths to exclude beyond /proc /sys /dev /run /tmp." },
        sudo: { type: "boolean", description: "Run find with sudo. Default false." },
        timeoutMs: { type: "number", description: "SSH timeout in ms. Default 60000." }
      }
    }
  }
];

export async function handleTool(name, args) {
  // ── ssh_fleet_health ────────────────────────────────────────────────────────
  if (name === "ssh_fleet_health") {
    const profileData = listProfiles();
    const profileEntries = Object.entries(profileData.profiles || {});
    let targets = profileEntries.map(([pname, p]) => ({ name: pname, ...p }));
    if (args.group) targets = targets.filter(p => p.group === args.group);
    if (targets.length === 0) {
      return textResult("No profiles found" + (args.group ? ` for group ${JSON.stringify(args.group)}` : ""), true);
    }

    const healthScript = `set +e
export LC_ALL=C
_cpu=$(top -bn1 2>/dev/null | grep -i "cpu(s)\\|%cpu" | head -1 | awk '{for(i=1;i<=NF;i++){if($i~/^[0-9]/ && $(i-1)~/us|id/){print $i; break}}}' | tr -d '%us,' 2>/dev/null || echo "?")
_mem=$(awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{printf "%.0f",100*(t-a)/t}' /proc/meminfo 2>/dev/null || echo "?")
_disk=$(df / 2>/dev/null | tail -1 | awk '{print $5}' | tr -d %)
_load=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo "?")
_failed=$(systemctl list-units --state=failed --no-pager --plain 2>/dev/null | grep -c "failed" || echo 0)
_uptime=$(awk '{print int($1/3600)"h"}' /proc/uptime 2>/dev/null || echo "?")
printf '{"cpu":"%s","mem":"%s","disk":"%s","load":"%s","failed":%s,"uptime":"%s"}' "$_cpu" "$_mem" "$_disk" "$_load" "$_failed" "$_uptime"
`;

    const results = await Promise.all(targets.map(async (p) => {
      const tgt = p.name;
      try {
        const r = await runSshCommand({ target: tgt, command: healthScript, mode: "bash", timeoutMs: args.timeoutMs || 30_000 });
        let metrics = {};
        try { metrics = JSON.parse(r.stdout.trim()); } catch {}
        return { name: tgt, ok: r.exitCode === 0, ...metrics };
      } catch (e) {
        return { name: tgt, ok: false, error: e.message };
      }
    }));

    const lines = [
      "=== Fleet Health Dashboard ===",
      "",
      "Server              | Status | CPU%  | Mem%  | Disk% | Load  | Failed | Uptime",
      "--------------------|--------|-------|-------|-------|-------|--------|-------"
    ];
    for (const r of results) {
      const status = r.ok ? "  OK  " : " FAIL ";
      const cpu    = String(r.cpu    ?? "?").padStart(5);
      const mem    = String(r.mem    ?? "?").padStart(5);
      const disk   = String(r.disk   ?? "?").padStart(5);
      const load   = String(r.load   ?? "?").padStart(5);
      const failed = String(r.failed ?? "?").padStart(6);
      const uptime = String(r.uptime ?? "?").padStart(6);
      const sname  = r.name.padEnd(19).slice(0, 19);
      lines.push(`${sname} | ${status} | ${cpu} | ${mem} | ${disk} | ${load} | ${failed} | ${uptime}`);
    }
    const failCount = results.filter(r => !r.ok).length;
    lines.push("", `Summary: ${results.length} servers — ${results.length - failCount} OK, ${failCount} failed`);
    return textResult(lines.join("\n"));
  }

  // ── ssh_anomaly ─────────────────────────────────────────────────────────────
  if (name === "ssh_anomaly") {
    if (!args.target) return textResult("ssh_anomaly: target is required", true);

    const metricsScript = `set +e
export LC_ALL=C
_cpu=$(top -bn1 2>/dev/null | grep -i "cpu(s)\\|%cpu" | head -1 | awk '{for(i=1;i<=NF;i++){if($i~/^[0-9]/ && $(i-1)~/us|id/){print $i; break}}}' | tr -d '%us,' 2>/dev/null || echo 0)
_mem=$(awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{printf "%.1f",100*(t-a)/t}' /proc/meminfo 2>/dev/null || echo 0)
_disk=$(df / 2>/dev/null | tail -1 | awk '{print $5}' | tr -d % || echo 0)
_load=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
printf '{"cpu":%s,"mem":%s,"disk":%s,"load":%s}' "${_cpu:-0}" "${_mem:-0}" "${_disk:-0}" "${_load:-0}"
`;

    let r;
    try {
      r = await runSshCommand({ target: args.target, command: metricsScript, mode: "bash", timeoutMs: args.timeoutMs || 30_000 });
    } catch (e) {
      return textResult(`ssh_anomaly: SSH error — ${e.message}`, true);
    }
    if (r.exitCode !== 0) {
      return textResult(`ssh_anomaly: command failed — ${r.stderr || r.stdout}`, true);
    }

    let current;
    try {
      current = JSON.parse(r.stdout.trim());
    } catch {
      return textResult(`ssh_anomaly: failed to parse metrics output: ${r.stdout.trim()}`, true);
    }

    const store = loadAnomalyStore();
    const key = String(args.target).replace(/[^a-zA-Z0-9@._-]/g, "_");
    const entry = store[key] || { readings: [] };

    const thresholds = { low: 3.0, medium: 2.0, high: 1.5 };
    const threshold = thresholds[args.sensitivity || "medium"] || 2.0;
    const metrics = ["cpu", "mem", "disk", "load"];
    const anomalies = [];
    const baselineSummary = {};

    if (entry.readings.length >= 2) {
      for (const m of metrics) {
        const vals = entry.readings.map(rd => Number(rd[m])).filter(v => !isNaN(v));
        if (vals.length < 2) continue;
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
        const std = Math.sqrt(variance);
        const cur = Number(current[m]);
        baselineSummary[m] = { mean: +mean.toFixed(2), std: +std.toFixed(2), current: cur };
        if (std > 0 && Math.abs(cur - mean) > threshold * std) {
          const dir = cur > mean ? "HIGH" : "LOW";
          anomalies.push({ metric: m, current: cur, mean: +mean.toFixed(2), std: +std.toFixed(2), direction: dir, deviations: +((Math.abs(cur - mean) / std).toFixed(2)) });
        }
      }
    } else {
      for (const m of metrics) {
        baselineSummary[m] = { mean: null, std: null, current: Number(current[m]) };
      }
    }

    if (args.updateBaseline) {
      const reading = { ts: new Date().toISOString(), ...Object.fromEntries(metrics.map(m => [m, Number(current[m])])) };
      entry.readings.push(reading);
      if (entry.readings.length > 10) entry.readings = entry.readings.slice(-10);
      store[key] = entry;
      try { saveAnomalyStore(store); } catch (e) { /* non-fatal */ }
    }

    const lines = [`=== Anomaly Report: ${args.target} ===`, `Sensitivity: ${args.sensitivity || "medium"} (threshold: ${threshold}x stddev)`, `Baseline readings stored: ${entry.readings.length}`, ""];
    if (entry.readings.length < 2) {
      lines.push("Insufficient baseline data. Run with updateBaseline:true at least 2 times to build a baseline.");
    } else if (anomalies.length === 0) {
      lines.push("No anomalies detected. All metrics within normal range.");
    } else {
      lines.push(`ANOMALIES DETECTED (${anomalies.length}):`);
      for (const a of anomalies) {
        lines.push(`  [${a.direction}] ${a.metric.toUpperCase()}: current=${a.current}, baseline_mean=${a.mean}, std=${a.std}, deviations=${a.deviations}x`);
      }
    }
    lines.push("", "Current metrics vs baseline:");
    for (const m of metrics) {
      const b = baselineSummary[m];
      if (!b) continue;
      const baseStr = b.mean !== null ? `mean=${b.mean}, std=${b.std}` : "no baseline yet";
      lines.push(`  ${m.padEnd(5)}: current=${b.current}, ${baseStr}`);
    }
    if (args.updateBaseline) lines.push("", `Baseline updated (${entry.readings.length} readings stored).`);
    return textResult(lines.join("\n"));
  }

  // ── ssh_change_tracker ──────────────────────────────────────────────────────
  if (name === "ssh_change_tracker") {
    let minutes = args.minutes === undefined ? 60 : args.minutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
      return textResult("ssh_change_tracker: minutes must be an integer 1–10080", true);
    }

    const searchPath = args.path || "/";
    const pathErr = validatePath(searchPath);
    if (pathErr) return textResult(`ssh_change_tracker: invalid path — ${pathErr}`, true);

    const extraExcludes = Array.isArray(args.exclude) ? args.exclude : [];
    for (const ex of extraExcludes) {
      const exErr = validatePath(ex);
      if (exErr) return textResult(`ssh_change_tracker: invalid exclude path ${JSON.stringify(ex)} — ${exErr}`, true);
    }

    const minsLit = String(minutes);
    const pathLit = JSON.stringify(searchPath);

    // Build extra exclude clauses: each becomes -o -path PATH -prune
    const extraExcludeClauses = extraExcludes.map(ex => `-o -path ${JSON.stringify(ex)} -prune`).join(" ");

    const findBase = `find "$_path" \\( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /tmp -o -path /var/tmp${extraExcludes.map(ex => ` -o -path ${JSON.stringify(ex)}`).join("")} \\) -prune -o -type f -mmin -"$_mins" -print 2>/dev/null`;

    const sudoPrefix = args.sudo ? "sudo " : "";

    const bash = `set +e
export LC_ALL=C
_mins=${minsLit}
_path=${pathLit}

echo "=== Files changed in last $_mins minutes under $_path ==="
echo "(excluding /proc /sys /dev /run /tmp /var/tmp${extraExcludes.map(ex => " " + ex).join("")})"
echo ""

${sudoPrefix}find "$_path" \\( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /tmp -o -path /var/tmp${extraExcludes.map(ex => ` -o -path ${JSON.stringify(ex)}`).join("")} \\) -prune -o -type f -mmin -"$_mins" -print 2>/dev/null | \\
  xargs -r ls -la 2>/dev/null | sort -k6,7 | tail -100

echo ""
echo "=== Count by directory ==="
${sudoPrefix}find "$_path" \\( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /tmp -o -path /var/tmp${extraExcludes.map(ex => ` -o -path ${JSON.stringify(ex)}`).join("")} \\) -prune -o -type f -mmin -"$_mins" -print 2>/dev/null | \\
  awk -F/ '{OFS="/"; NF--; print}' | sort | uniq -c | sort -rn | head -20
`;

    const runArgs = { target: args.target, command: bash, mode: "bash", timeoutMs: args.timeoutMs || 60_000 };
    let result;
    try {
      result = await runSshCommand(runArgs);
    } catch (e) {
      return textResult(`ssh_change_tracker: SSH error — ${e.message}`, true);
    }
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  return null;
}
