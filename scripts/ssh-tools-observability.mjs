// ssh-tools-observability.mjs — observability tools: ssh_tail, ssh_memory_report, ssh_systemd_timer
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

function validatePath(path) {
  if (typeof path !== "string") return "path must be a string";
  if (!path.startsWith("/")) return "path must be absolute (start with /)";
  if (path.includes("..")) return "path must not contain ..";
  if (/[\x00\r\n]/.test(path)) return "path must not contain null bytes or newlines";
  return null;
}

function validateString(val, name) {
  if (typeof val !== "string") return null;
  if (/[\r\n\x00]/.test(val)) return `${name} must not contain \\r, \\n, or null bytes`;
  return null;
}

export const toolDefs = [
  {
    name: "ssh_tail",
    title: "SSH Log Tail",
    description: "Read the last N lines of a remote file, with optional follow mode (waits for new lines for up to followSeconds).",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host" },
        path: { type: "string", description: "Required. Absolute remote file path." },
        lines: { type: "number", description: "Lines to show, default 50, max 10000." },
        followSeconds: { type: "number", description: "If > 0, follow file for this many seconds. Max 300." },
        timeoutMs: { type: "number", description: "SSH timeout in ms." }
      },
      required: ["path"]
    }
  },
  {
    name: "ssh_memory_report",
    title: "SSH Detailed Memory Report",
    description: "Detailed memory analysis from /proc: totals, swap, huge pages, and top N processes by RSS.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host" },
        topN: { type: "number", description: "Top processes by memory, default 10, max 50." },
        timeoutMs: { type: "number", description: "SSH timeout in ms." }
      }
    }
  },
  {
    name: "ssh_systemd_timer",
    title: "SSH Systemd Timer Management",
    description: "List, inspect, and control systemd timers on a remote host. Mutating actions (enable/disable/start/stop) require confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host" },
        action: { type: "string", enum: ["list", "status", "enable", "disable", "start", "stop"], description: "Required. Timer action." },
        timer: { type: "string", description: "Timer unit name (with or without .timer suffix). Required for all actions except list." },
        sudo: { type: "boolean", description: "Default true." },
        confirm: { type: "boolean", description: "Required for enable/disable/start/stop." },
        dryRun: { type: "boolean", description: "Preview action without executing." },
        reason: { type: "string", description: "Stated reason for the action." }
      },
      required: ["action"]
    }
  }
];

const MUTATING_TIMER_ACTIONS = new Set(["enable", "disable", "start", "stop"]);

export async function handleTool(name, args) {
  // ── ssh_tail ──────────────────────────────────────────────────────────────
  if (name === "ssh_tail") {
    const pathErr = validatePath(args.path);
    if (pathErr) return textResult(`ssh_tail: invalid path — ${pathErr}`, true);

    let lines = args.lines === undefined ? 50 : args.lines;
    if (!Number.isInteger(lines) || lines < 1 || lines > 10000) {
      return textResult("ssh_tail: lines must be an integer 1–10000", true);
    }

    let followSeconds = args.followSeconds === undefined ? 0 : args.followSeconds;
    if (!Number.isInteger(followSeconds) || followSeconds < 0 || followSeconds > 300) {
      return textResult("ssh_tail: followSeconds must be an integer 0–300", true);
    }

    const quotedPath = JSON.stringify(String(args.path));
    const linesN = lines;
    const followSecs = followSeconds;

    let bash = `set +e\nexport LC_ALL=C\n_path=${quotedPath}\n_lines=${linesN}\n\nif [ ! -f "$_path" ] && [ ! -e "$_path" ]; then\n  echo "File not found: $_path" >&2; exit 1\nfi\n\ntail -n "$_lines" "$_path"\n`;

    if (followSecs > 0) {
      bash += `\necho "--- Following for ${followSecs} seconds ---"\ntimeout ${followSecs} tail -f -n 0 "$_path" 2>/dev/null\necho "--- Follow ended ---"\n`;
    }

    const effectiveTimeout = followSecs > 0 ? (followSecs + 30) * 1000 : args.timeoutMs;
    const runArgs = { command: bash, target: args.target, mode: "bash" };
    if (effectiveTimeout !== undefined) runArgs.timeoutMs = effectiveTimeout;

    const result = await runSshCommand(runArgs);
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── ssh_memory_report ─────────────────────────────────────────────────────
  if (name === "ssh_memory_report") {
    let topN = args.topN === undefined ? 10 : args.topN;
    if (!Number.isInteger(topN) || topN < 1 || topN > 50) {
      return textResult("ssh_memory_report: topN must be an integer 1–50", true);
    }

    const bash = `set +e
export LC_ALL=C

echo "=== Memory Overview (/proc/meminfo) ==="
awk '
  /^MemTotal:/ { total=$2 }
  /^MemFree:/ { free=$2 }
  /^MemAvailable:/ { avail=$2 }
  /^Buffers:/ { buf=$2 }
  /^Cached:/ { cached=$2 }
  /^SwapTotal:/ { stot=$2 }
  /^SwapFree:/ { sfree=$2 }
  /^HugePages_Total:/ { hptot=$2 }
  /^HugePages_Free:/ { hpfree=$2 }
  /^Hugepagesize:/ { hpsize=$2 }
  END {
    used=total-avail
    printf "Total:     %8d MB\\n", total/1024
    printf "Used:      %8d MB (%.1f%%)\\n", used/1024, (total>0)?100*used/total:0
    printf "Free:      %8d MB\\n", free/1024
    printf "Available: %8d MB\\n", avail/1024
    printf "Buffers:   %8d MB\\n", buf/1024
    printf "Cached:    %8d MB\\n", cached/1024
    printf "Swap Total:%8d MB\\n", stot/1024
    printf "Swap Free: %8d MB\\n", sfree/1024
    printf "Swap Used: %8d MB (%.1f%%)\\n", (stot-sfree)/1024, (stot>0)?100*(stot-sfree)/stot:0
    if (hptot>0) printf "HugePages: %d total / %d free (%d kB each)\\n", hptot, hpfree, hpsize
  }
' /proc/meminfo

echo ""
echo "=== Top ${topN} Processes by RSS ==="
printf "%-10s %-20s %10s %10s\\n" "PID" "PROCESS" "RSS_MB" "VSZ_MB"
printf "%-10s %-20s %10s %10s\\n" "---" "-------" "------" "------"
for f in /proc/[0-9]*/status; do
  pid=$(echo "$f" | cut -d/ -f3)
  name=$(grep "^Name:" "$f" 2>/dev/null | awk '{print $2}')
  rss=$(grep "^VmRSS:" "$f" 2>/dev/null | awk '{print $2}')
  vsz=$(grep "^VmSize:" "$f" 2>/dev/null | awk '{print $2}')
  [ -n "$rss" ] && echo "$rss $pid $name $vsz"
done 2>/dev/null | sort -rn | head -${topN} | while read rss pid name vsz; do
  printf "%-10s %-20s %10.1f %10.1f\\n" "$pid" "$name" "$(echo $rss | awk '{print $1/1024}')" "$(echo $vsz | awk '{print $1/1024}')"
done
`;

    const runArgs = { command: bash, target: args.target, mode: "bash" };
    if (args.timeoutMs !== undefined) runArgs.timeoutMs = args.timeoutMs;

    const result = await runSshCommand(runArgs);
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── ssh_systemd_timer ─────────────────────────────────────────────────────
  if (name === "ssh_systemd_timer") {
    const validActions = ["list", "status", "enable", "disable", "start", "stop"];
    if (!validActions.includes(args.action)) {
      return textResult(`ssh_systemd_timer: action must be one of ${validActions.join(", ")}`, true);
    }

    const isMutating = MUTATING_TIMER_ACTIONS.has(args.action);
    const needsTimer = args.action !== "list";

    if (isMutating && !args.confirm) {
      return requireConfirm("ssh_systemd_timer", args);
    }

    if (needsTimer) {
      if (!args.timer || typeof args.timer !== "string") {
        return textResult(`ssh_systemd_timer: timer is required for action "${args.action}"`, true);
      }
      const timerErr = validateString(args.timer, "timer");
      if (timerErr) return textResult(`ssh_systemd_timer: ${timerErr}`, true);
      if (!/^[a-zA-Z0-9@._:+\-]+$/.test(args.timer)) {
        return textResult("ssh_systemd_timer: timer name contains invalid characters", true);
      }
    }

    let timerName = args.timer ? String(args.timer) : null;
    if (timerName && !timerName.endsWith(".timer")) {
      timerName = timerName + ".timer";
    }

    if (args.dryRun) {
      const cmd = args.action === "list"
        ? "systemctl list-timers --all --no-pager"
        : `systemctl ${args.action} ${timerName}`;
      return dryRunResult("ssh_systemd_timer", args, cmd, args.target);
    }

    let bash;

    if (args.action === "list") {
      bash = `set +e\nexport LC_ALL=C\necho "=== Active Systemd Timers ==="\nsystemctl list-timers --all --no-pager 2>/dev/null || systemctl list-timers --no-pager\n`;
    } else {
      const quotedUnit = JSON.stringify(timerName);
      bash = `set +e\nexport LC_ALL=C\n_unit=${quotedUnit}\nsystemctl ${args.action} "$_unit"\n`;
      if (args.action === "enable" || args.action === "disable") {
        bash += `systemctl daemon-reload\n`;
      }
    }

    const useSudo = args.action === "list" || args.action === "status" ? false : args.sudo !== false;
    const runArgs = { command: bash, target: args.target, mode: "bash", sudo: useSudo };
    if (args.timeoutMs !== undefined) runArgs.timeoutMs = args.timeoutMs;

    const result = await runSshCommand(runArgs);
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  return null;
}
