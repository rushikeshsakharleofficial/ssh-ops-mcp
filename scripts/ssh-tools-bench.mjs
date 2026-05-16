// ssh-tools-bench.mjs — performance benchmark and port-forward tunnel management
import { runSshCommand, formatRunResult } from "./ssh-core.mjs";

function shellQuote(v) { return `'${String(v).replace(/'/g, "'\\''")}'`; }
function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }
function dryRunResult(toolName, args, command, target) {
  return textResult(JSON.stringify({ dryRun: true, tool: toolName, target: target || args.target || args.host || "(default)", command: command || null, note: "dryRun:true — nothing executed" }, null, 2));
}
function requireConfirm(toolName, args) {
  const r = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${r}`, true);
}

export const toolDefs = [
  {
    name: "ssh_benchmark",
    title: "SSH Performance Benchmark",
    description: "Run performance benchmarks on a remote host: disk I/O (dd/fio), CPU (prime sieve/sysbench), and network (iperf3). Falls back gracefully when tools are missing.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        tests: {
          type: "array",
          items: { type: "string", enum: ["disk", "cpu", "network", "all"] },
          description: "Which benchmarks to run. Default: ['all']."
        },
        diskPath: { type: "string", description: "Path for disk benchmark temp files (default /tmp)." },
        iperf3Server: { type: "string", description: "iperf3 server hostname for network test (required for network benchmark)." },
        timeoutMs: { type: "number", description: "Timeout ms. Default 120000." }
      }
    }
  },
  {
    name: "ssh_port_forward",
    title: "SSH Port Forward / Tunnel Management",
    description: "Manage persistent port-forward tunnels on a remote host via systemd+socat services. list shows active tunnels; create sets up a new tunnel; kill removes it.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: { type: "string", enum: ["list", "create", "kill"], description: "Tunnel action." },
        name: { type: "string", description: "Tunnel name (alphanumeric + hyphens). Required for create/kill." },
        localPort: { type: "number", description: "Local port to listen on (for create)." },
        remoteHost: { type: "string", description: "Destination host to forward to (for create)." },
        remotePort: { type: "number", description: "Destination port (for create)." },
        bindAddress: { type: "string", description: "Bind address (default 127.0.0.1)." },
        sudo: { type: "boolean", description: "Use sudo. Default true." },
        confirm: { type: "boolean", description: "Required for create/kill." },
        dryRun: { type: "boolean", description: "Preview without executing." },
        reason: { type: "string", description: "Reason logged to audit log." }
      },
      required: ["action"]
    }
  }
];

export async function handleTool(name, args) {
  if (name === "ssh_benchmark") {
    const tests = (args.tests && args.tests.length > 0) ? args.tests : ["all"];
    const runDisk = tests.includes("all") || tests.includes("disk");
    const runCpu = tests.includes("all") || tests.includes("cpu");
    const runNet = tests.includes("all") || tests.includes("network");

    const diskPath = args.diskPath || "/tmp";
    if (!diskPath.startsWith("/") || diskPath.includes("..") || /[\r\n\x00`]/.test(diskPath)) {
      return textResult("diskPath must be an absolute path without '..' segments.", true);
    }
    const diskPathQ = shellQuote(diskPath);

    const iperf3Server = args.iperf3Server || "";
    if (iperf3Server && !/^[a-zA-Z0-9._-]+$/.test(iperf3Server)) {
      return textResult("iperf3Server must be a valid hostname.", true);
    }
    const iperf3Q = shellQuote(iperf3Server);

    let sections = [];
    sections.push(`echo "=== SSH Ops Benchmark: $(hostname) — $(date) ==="`);
    sections.push(`echo ""`);

    if (runDisk) {
      sections.push(`echo "=== Disk I/O Benchmark (${diskPath}) ==="`);
      sections.push(`_dp=${diskPathQ}`);
      sections.push(`echo "Sequential write (512MB via dd):"`);
      sections.push(`dd if=/dev/zero of="$_dp/bench_write_$$.tmp" bs=1M count=512 conv=fdatasync 2>&1 | tail -1`);
      sections.push(`echo "Sequential read:"`);
      sections.push(`dd if="$_dp/bench_write_$$.tmp" of=/dev/null bs=1M 2>&1 | tail -1`);
      sections.push(`rm -f "$_dp/bench_write_$$.tmp"`);
      sections.push(`if command -v fio >/dev/null 2>&1; then`);
      sections.push(`  echo "fio random 4K r/w (10s):"`);
      sections.push(`  fio --name=t --filename="$_dp/fio_$$.tmp" --rw=randrw --bs=4k --size=128M --numjobs=1 --time_based --runtime=10 --output-format=terse --terse-version=3 2>/dev/null | awk -F';' '{printf "Read: %s KB/s  Write: %s KB/s\\n",$7,$48}'`);
      sections.push(`  rm -f "$_dp/fio_$$.tmp"`);
      sections.push(`fi`);
      sections.push(`echo ""`);
    }

    if (runCpu) {
      sections.push(`echo "=== CPU Benchmark ==="`);
      sections.push(`echo "Prime sieve to 100000 (awk timing):"`);
      sections.push(`time awk 'BEGIN{n=100000;for(i=2;i<=n;i++)c[i]=1;for(i=2;i<=n;i++)if(c[i])for(j=i*i;j<=n;j+=i)c[j]=0;cnt=0;for(i=2;i<=n;i++)if(c[i])cnt++;print cnt" primes found"}' /dev/null 2>&1`);
      sections.push(`if command -v sysbench >/dev/null 2>&1; then`);
      sections.push(`  echo "sysbench CPU (10s):"`);
      sections.push(`  sysbench cpu --time=10 run 2>&1 | grep -E "events per second|total time|min:|avg:|max:"`);
      sections.push(`fi`);
      sections.push(`echo "Cores: $(nproc)"`);
      sections.push(`echo "Model: $(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | sed 's/^ //')"`);
      sections.push(`echo ""`);
    }

    if (runNet) {
      sections.push(`echo "=== Network Benchmark ==="`);
      if (iperf3Server) {
        sections.push(`if command -v iperf3 >/dev/null 2>&1; then`);
        sections.push(`  echo "iperf3 to ${iperf3Server} (10s):"`);
        sections.push(`  iperf3 -c ${iperf3Q} -t 10 2>&1 | tail -5`);
        sections.push(`else`);
        sections.push(`  echo "iperf3 not installed — skipping full network test"`);
        sections.push(`fi`);
      } else {
        sections.push(`echo "(iperf3Server not provided — using /proc/net/dev delta for rate estimate)"`);
      }
      sections.push(`echo "Interface throughput (2s sample):"`);
      sections.push(`_iface=$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="dev"){print $(i+1);exit}}')`);
      sections.push(`[ -z "$_iface" ] && _iface=$(ls /sys/class/net/ | grep -v lo | head -1)`);
      sections.push(`_r1=$(cat /sys/class/net/$_iface/statistics/rx_bytes 2>/dev/null || echo 0)`);
      sections.push(`_t1=$(cat /sys/class/net/$_iface/statistics/tx_bytes 2>/dev/null || echo 0)`);
      sections.push(`sleep 2`);
      sections.push(`_r2=$(cat /sys/class/net/$_iface/statistics/rx_bytes 2>/dev/null || echo 0)`);
      sections.push(`_t2=$(cat /sys/class/net/$_iface/statistics/tx_bytes 2>/dev/null || echo 0)`);
      sections.push(`echo "Interface: $_iface"`);
      sections.push(`echo "RX: $(( (_r2 - _r1) / 2 / 1024 )) KB/s  TX: $(( (_t2 - _t1) / 2 / 1024 )) KB/s"`);
      sections.push(`echo ""`);
    }

    sections.push(`echo "=== Benchmark Complete: $(date) ==="`);

    const command = `set +e\nexport LC_ALL=C\n${sections.join("\n")}\n`;
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 120_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_port_forward") {
    const mutating = ["create", "kill"];
    if (mutating.includes(args.action) && args.confirm !== true) {
      return requireConfirm(name, args);
    }

    let command;

    if (args.action === "list") {
      command = `set +e
export LC_ALL=C
echo "=== SSH Tunnel Services (ssh-tunnel-*) ==="
systemctl list-units "ssh-tunnel-*.service" --no-pager 2>/dev/null || echo "(none found)"
echo ""
echo "=== socat / tunnel processes ==="
ps aux 2>/dev/null | grep -E "socat|ssh.*-[LRD]" | grep -v grep | head -20
echo ""
echo "=== Listening Ports ==="
ss -tlnp 2>/dev/null | grep -E "127\\.0\\.0\\.1|0\\.0\\.0\\.0" | head -20
`;
    } else if (args.action === "create") {
      if (!args.name) return textResult("name is required for create.", true);
      if (!/^[a-zA-Z0-9_-]+$/.test(args.name)) return textResult("name must be alphanumeric + hyphens/underscores.", true);
      if (!args.localPort || !Number.isInteger(args.localPort) || args.localPort < 1 || args.localPort > 65535) {
        return textResult("localPort must be integer 1-65535.", true);
      }
      if (!args.remoteHost) return textResult("remoteHost is required.", true);
      if (!/^[a-zA-Z0-9._-]+$/.test(args.remoteHost)) return textResult("remoteHost must be a valid hostname.", true);
      if (!args.remotePort || !Number.isInteger(args.remotePort) || args.remotePort < 1 || args.remotePort > 65535) {
        return textResult("remotePort must be integer 1-65535.", true);
      }
      const bind = args.bindAddress || "127.0.0.1";
      if (!/^[0-9.]+$/.test(bind)) return textResult("bindAddress must be an IPv4 address.", true);

      const svcName = `ssh-tunnel-${args.name}`;
      const svcFile = `/etc/systemd/system/${svcName}.service`;
      const desc = `Port Forward ${bind}:${args.localPort} -> ${args.remoteHost}:${args.remotePort}`;

      command = `set +e
export LC_ALL=C
_svc=${shellQuote(svcName)}
_svcfile=${shellQuote(svcFile)}

if ! command -v socat >/dev/null 2>&1; then
  echo "socat not found. Install: apt-get install socat" >&2; exit 1
fi

cat > "$_svcfile" <<SVCEOF
[Unit]
Description=${desc}
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:${args.localPort},bind=${bind},fork,reuseaddr TCP:${args.remoteHost}:${args.remotePort}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

chmod 644 "$_svcfile"
systemctl daemon-reload
systemctl enable --now "$_svc"
echo "Port forward created: ${bind}:${args.localPort} -> ${args.remoteHost}:${args.remotePort}"
systemctl status "$_svc" --no-pager
`;
    } else if (args.action === "kill") {
      if (!args.name) return textResult("name is required for kill.", true);
      if (!/^[a-zA-Z0-9_-]+$/.test(args.name)) return textResult("name must be alphanumeric + hyphens/underscores.", true);

      const svcName = `ssh-tunnel-${args.name}`;
      const svcNameQ = shellQuote(svcName);

      command = `set +e
export LC_ALL=C
_svc=${svcNameQ}
systemctl disable --now "$_svc" 2>&1
rm -f ${shellQuote(`/etc/systemd/system/${svcName}.service`)}
systemctl daemon-reload
echo "Tunnel ${args.name} removed"
`;
    } else {
      return textResult(`Unknown action: ${args.action}`, true);
    }

    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({ ...args, command, mode: "bash", sudo: args.sudo !== false, timeoutMs: args.timeoutMs || 60_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  return null;
}
