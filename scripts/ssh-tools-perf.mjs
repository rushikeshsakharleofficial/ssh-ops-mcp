// ssh-tools-perf.mjs — performance tools: ssh_perf, ssh_dmesg, ssh_tcpdump
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

// ─── Tool definitions ──────────────────────────────────────────────────────

export const toolDefs = [
  {
    name: "ssh_perf",
    title: "SSH Performance Snapshot",
    description: "Capture a performance snapshot using vmstat, iostat, and sar. Shows CPU, memory, I/O, and network trends over a short sampling interval.",
    inputSchema: {
      type: "object",
      properties: {
        target:     { type: "string", description: "Profile name or user@host" },
        interval:   { type: "number", description: "Sampling interval seconds (default 2, max 10)" },
        count:      { type: "number", description: "Number of samples (default 3, max 10)" },
        include:    { type: "array", items: { type: "string", enum: ["cpu","memory","io","network","all"] }, description: "What to include (default [\"all\"])" },
        sudo:       { type: "boolean", description: "Run with sudo (default false)" },
        timeoutMs:  { type: "number", description: "Timeout in ms (default 60000)" },
        dryRun:     { type: "boolean", description: "Preview without executing" }
      }
    }
  },
  {
    name: "ssh_dmesg",
    title: "SSH Kernel Ring Buffer (dmesg)",
    description: "Read kernel ring buffer messages with optional level filtering and grep pattern.",
    inputSchema: {
      type: "object",
      properties: {
        target:    { type: "string", description: "Profile name or user@host" },
        level:     { type: "string", enum: ["all","emerg","alert","crit","err","warn","notice","info","debug"], description: "Log level filter (default \"err\")" },
        lines:     { type: "number", description: "Max lines (default 50, max 500)" },
        filter:    { type: "string", description: "Optional grep filter string" },
        since:     { type: "string", description: "Time filter e.g. \"1h\" \"30m\"" },
        sudo:      { type: "boolean", description: "Run with sudo (default false)" },
        timeoutMs: { type: "number", description: "Timeout in ms" },
        dryRun:    { type: "boolean", description: "Preview without executing" }
      }
    }
  },
  {
    name: "ssh_tcpdump",
    title: "SSH Packet Capture (tcpdump)",
    description: "Run a bounded tcpdump capture on a remote host. Limited to max 200 packets or 30 seconds to prevent runaway capture.",
    inputSchema: {
      type: "object",
      properties: {
        target:    { type: "string", description: "Profile name or user@host" },
        interface: { type: "string", description: "Network interface (default any)" },
        filter:    { type: "string", description: "BPF filter expression (e.g. \"port 80\", \"host 1.2.3.4\")" },
        count:     { type: "number", description: "Max packets to capture (default 50, max 200)" },
        seconds:   { type: "number", description: "Max capture duration seconds (default 10, max 30)" },
        sudo:      { type: "boolean", description: "Run with sudo (default true)" },
        timeoutMs: { type: "number", description: "Timeout in ms (default 45000)" },
        confirm:   { type: "boolean", description: "Must be true to execute" },
        reason:    { type: "string", description: "Stated reason for capture" },
        dryRun:    { type: "boolean", description: "Preview without executing" }
      }
    }
  }
];

// ─── Handlers ─────────────────────────────────────────────────────────────

async function handleSshPerf(args) {
  let interval = args.interval !== undefined ? Math.round(Number(args.interval)) : 2;
  let count    = args.count    !== undefined ? Math.round(Number(args.count))    : 3;

  if (!Number.isInteger(interval) || interval < 1 || interval > 10)
    return textResult("interval must be an integer 1–10", true);
  if (!Number.isInteger(count) || count < 1 || count > 10)
    return textResult("count must be an integer 1–10", true);

  const sudo      = Boolean(args.sudo);
  const timeoutMs = args.timeoutMs !== undefined ? Number(args.timeoutMs) : 60000;

  const intStr  = JSON.stringify(String(interval));
  const cntStr  = JSON.stringify(String(count));

  const script = `set +e
export LC_ALL=C
_int=${intStr}
_cnt=${cntStr}

echo "=== Performance Snapshot: $(hostname) — $(date) ==="
echo "Sampling: $_cnt intervals of $_int seconds"
echo ""

echo "=== CPU & Memory (vmstat) ==="
vmstat -w $_int $_cnt 2>/dev/null || vmstat $_int $_cnt

echo ""
echo "=== Disk I/O (iostat) ==="
if command -v iostat >/dev/null 2>&1; then
  iostat -xz $_int $_cnt 2>/dev/null | head -40
else
  echo "iostat not available — install sysstat"
  cat /proc/diskstats | awk '{print $3, "reads:"$6, "writes:"$10}' | head -10
fi

echo ""
echo "=== Network I/O (/proc/net/dev delta) ==="
_net1=$(cat /proc/net/dev)
sleep $_int
_net2=$(cat /proc/net/dev)
echo "$_net2" | awk 'NR>2{print $1, "rx:"$2, "tx:"$10}' | grep -v "^lo:" | head -5

echo ""
echo "=== Memory Pressure ==="
awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}/^SwapTotal/{st=$2}/^SwapFree/{sf=$2}END{
  printf "RAM: %d MB used / %d MB total (%.1f%%)\n",(t-a)/1024,t/1024,100*(t-a)/t
  if(st>0) printf "Swap: %d MB used / %d MB total (%.1f%%)\n",(st-sf)/1024,st/1024,100*(st-sf)/st
}' /proc/meminfo

echo ""
echo "=== Load Average ==="
cat /proc/loadavg
echo "(1min 5min 15min running/total lastpid)"
`;

  if (args.dryRun) return dryRunResult("ssh_perf", args, script, args.target);

  const result = await runSshCommand({
    target: args.target,
    command: script,
    mode: "bash",
    sudo,
    timeoutMs
  });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

async function handleSshDmesg(args) {
  let lines = args.lines !== undefined ? Math.round(Number(args.lines)) : 50;
  const level  = args.level  || "err";
  const filter = args.filter || null;
  const since  = args.since  || null;
  const sudo   = Boolean(args.sudo);
  const timeoutMs = args.timeoutMs !== undefined ? Number(args.timeoutMs) : 30000;

  if (!Number.isInteger(lines) || lines < 1 || lines > 500)
    return textResult("lines must be an integer 1–500", true);

  const validLevels = ["all","emerg","alert","crit","err","warn","notice","info","debug"];
  if (!validLevels.includes(level))
    return textResult(`level must be one of: ${validLevels.join(", ")}`, true);

  if (filter !== null && /[\r\n\x00]/.test(filter))
    return textResult("filter must not contain newlines or null bytes", true);

  const linesStr  = JSON.stringify(String(lines));
  const levelStr  = JSON.stringify(level);
  const sinceStr  = since ? JSON.stringify(String(since)) : null;
  const filterStr = filter ? JSON.stringify(filter) : null;

  const filterPipe = filterStr
    ? `grep -i ${filterStr}`
    : "cat";

  const sinceFlag = sinceStr
    ? `--since ${sinceStr}`
    : "";

  const script = `set +e
export LC_ALL=C
_lines=${linesStr}
_level=${levelStr}

if dmesg --help 2>&1 | grep -q "level"; then
  _level_flag=""
  [ "$_level" != "all" ] && _level_flag="--level=$_level"
  _out=$(dmesg -T ${sinceFlag} $_level_flag 2>/dev/null | tail -n "$_lines")
else
  _out=$(dmesg | tail -n "$_lines")
  if [ "$_level" = "err" ]; then
    _out=$(echo "$_out" | grep -iE "error|fault|fail|panic|oops|bug")
  elif [ "$_level" = "warn" ]; then
    _out=$(echo "$_out" | grep -iE "warn|error|fault|fail|panic")
  fi
fi

echo "$_out" | ${filterPipe} | tail -n "$_lines"
`;

  if (args.dryRun) return dryRunResult("ssh_dmesg", args, script, args.target);

  const result = await runSshCommand({
    target: args.target,
    command: script,
    mode: "bash",
    sudo,
    timeoutMs
  });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

async function handleSshTcpdump(args) {
  // tcpdump requires confirm
  if (!args.confirm) return requireConfirm("ssh_tcpdump", args);

  const iface   = args.interface || "any";
  let count   = args.count   !== undefined ? Math.round(Number(args.count))   : 50;
  let seconds = args.seconds !== undefined ? Math.round(Number(args.seconds)) : 10;
  const filter  = args.filter || null;
  const sudo    = args.sudo !== undefined ? Boolean(args.sudo) : true;
  const timeoutMs = args.timeoutMs !== undefined ? Number(args.timeoutMs) : 45000;

  if (!/^[a-zA-Z0-9._-]+$/.test(iface))
    return textResult("interface must match /^[a-zA-Z0-9._-]+$/", true);
  if (!Number.isInteger(count) || count < 1 || count > 200)
    return textResult("count must be an integer 1–200", true);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30)
    return textResult("seconds must be an integer 1–30", true);
  if (filter !== null) {
    if (/[\r\n\x00]/.test(filter))
      return textResult("filter must not contain newlines or null bytes", true);
    if (/`|\$\(|\$\{/.test(filter))
      return textResult("filter must not contain shell metacharacters (backtick, $(, ${)", true);
  }

  const ifaceStr   = JSON.stringify(iface);
  const countStr   = JSON.stringify(String(count));
  const secsStr    = JSON.stringify(String(seconds));
  const filterDisp = filter ? JSON.stringify(filter) : JSON.stringify("(none)");

  // For the actual tcpdump invocation, filter is passed as a single shell-quoted arg
  const filterArg = filter ? shellQuote(filter) : "";

  const script = `set +e
export LC_ALL=C

if ! command -v tcpdump >/dev/null 2>&1; then
  echo "tcpdump not found. Install: apt-get install tcpdump" >&2; exit 1
fi

_iface=${ifaceStr}
_count=${countStr}
_secs=${secsStr}

echo "=== Capturing $_count packets on $_iface (max ${secsStr}s) ==="
echo "Filter: ${filterDisp}"
echo ""

timeout "$_secs" tcpdump -i "$_iface" -n -l -c "$_count" ${filterArg} 2>&1
echo ""
echo "=== Capture complete ==="
`;

  if (args.dryRun) return dryRunResult("ssh_tcpdump", args, script, args.target);

  const result = await runSshCommand({
    target: args.target,
    command: script,
    mode: "bash",
    sudo,
    timeoutMs
  });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

export async function handleTool(name, args) {
  if (name === "ssh_perf")    return handleSshPerf(args);
  if (name === "ssh_dmesg")   return handleSshDmesg(args);
  if (name === "ssh_tcpdump") return handleSshTcpdump(args);
  return null;
}
