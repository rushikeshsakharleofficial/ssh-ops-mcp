import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");

const DEFAULT_CONNECT_TIMEOUT_SEC = 12;
const DEFAULT_STRICT_HOST_KEY_CHECKING = "accept-new";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
const ROOT_CONFIG_FILES = [
  "ssh-ops.config.yaml",
  "ssh-ops.config.yml",
  "ssh-ops.config.json"
];
const HOME_CONFIG_FILES = [
  "ssh-ops.yaml",
  "ssh-ops.yml",
  "ssh-ops.json"
];

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL_MS = 5_000;

export function loadConfig() {
  const now = Date.now();
  if (_configCache && now - _configCacheTime < CONFIG_CACHE_TTL_MS) {
    return _configCache;
  }
  const configPaths = [
    ...preferredExistingConfigPaths(PLUGIN_ROOT, ROOT_CONFIG_FILES),
    ...preferredExistingConfigPaths(join(os.homedir(), ".ssh"), HOME_CONFIG_FILES)
  ];
  if (process.env.SSH_OPS_CONFIG) {
    for (const rawPath of process.env.SSH_OPS_CONFIG.split(delimiter)) {
      if (rawPath.trim()) {
        configPaths.push(resolveConfigPath(rawPath.trim()));
      }
    }
  }

  const config = { defaults: {}, profiles: {} };
  const loadedFrom = [];

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    let parsed;
    try {
      parsed = parseConfigFile(configPath);
    } catch (err) {
      throw new Error(`Config file ${configPath}: ${err.message}`);
    }
    loadedFrom.push(configPath);
    const previousDefaults = config.defaults || {};
    const previousProfiles = config.profiles || {};
    const parsedDefaults = parsed.defaults || {};
    const parsedProfiles = parsed.profiles || {};
    Object.assign(config, parsed, {
      defaults: {
        ...previousDefaults,
        ...parsedDefaults
      },
      profiles: {
        ...previousProfiles,
        ...parsedProfiles
      }
    });
  }

  const result = { ...config, loadedFrom, defaults: config.defaults || {}, profiles: config.profiles || {} };
  _configCache = result;
  _configCacheTime = Date.now();
  return result;
}

function preferredExistingConfigPaths(baseDir, files) {
  const configPath = files.map((file) => join(baseDir, file)).find((path) => existsSync(path));
  return configPath ? [configPath] : [];
}

function parseConfigFile(configPath) {
  const source = readFileSync(configPath, "utf8");
  if (/\.ya?ml$/i.test(configPath)) {
    return parseYamlConfig(source);
  }
  return JSON.parse(source);
}

function parseYamlConfig(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    if (/^\t+/.test(rawLine)) {
      throw new Error(`YAML line ${index + 1}: tabs are not supported for indentation.`);
    }

    const indent = rawLine.match(/^ */)[0].length;
    const trimmed = rawLine.trim();
    const match = /^([^:]+):(.*)$/.exec(trimmed);
    if (!match) {
      throw new Error(`YAML line ${index + 1}: expected "key: value".`);
    }

    const key = match[1].trim();
    const rawValue = match[2].trim();
    while (indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].value;

    if (!rawValue) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseYamlScalar(rawValue);
    }
  }

  return root;
}

function parseYamlScalar(rawValue) {
  const value = stripYamlComment(rawValue).trim();
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseYamlScalar(item.trim()));
  }
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(value)) return JSON.parse(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function stripYamlComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === "\"" || char === "'") && value[i - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (char === "#" && !quote && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i);
    }
  }
  return value;
}

function resolveConfigPath(rawPath) {
  if (isAbsolute(rawPath)) return rawPath;
  return resolve(process.cwd(), rawPath);
}

export function listProfiles() {
  const config = loadConfig();
  return {
    defaultTarget: config.defaultTarget || null,
    loadedFrom: config.loadedFrom,
    profiles: Object.fromEntries(
      Object.entries(config.profiles).map(([name, profile]) => [
        name,
        {
          host: profile.host || null,
          user: profile.user || null,
          port: profile.port || 22,
          hasIdentityFile: Boolean(profile.identityFile),
          extraArgs: Array.isArray(profile.extraArgs) ? profile.extraArgs : []
        }
      ])
    )
  };
}

export function resolveTarget(input = {}) {
  const config = loadConfig();
  const requestedTarget = input.profile || input.target || input.host || config.defaultTarget;
  if (!requestedTarget) {
    throw new Error("Provide target, profile, host, or set defaultTarget in ssh-ops.config.json.");
  }

  const profile = config.profiles[requestedTarget] || {};
  const usingProfile = Boolean(config.profiles[requestedTarget]);
  const merged = {
    ...(config.defaults || {}),
    ...profile,
    ...input
  };
  const remoteJump = resolveRemoteJump(config, requestedTarget, merged);
  const targetUser = remoteJump && merged.targetUser && !merged.user ? merged.targetUser : merged.user;

  let destinationTarget;
  if (merged.host) {
    destinationTarget = `${targetUser ? `${targetUser}@` : ""}${merged.host}`;
  } else if (usingProfile) {
    throw new Error(`Profile "${requestedTarget}" does not define a host.`);
  } else {
    destinationTarget = remoteJump && targetUser && !String(requestedTarget).includes("@")
      ? `${targetUser}@${requestedTarget}`
      : requestedTarget;
  }

  const connectionProfile = remoteJump ? remoteJump.profile : profile;
  const connectionOptions = remoteJump
    ? { ...merged, ...remoteJump.profile, jumpHost: null }
    : merged;
  const target = remoteJump
    ? `${remoteJump.profile.user ? `${remoteJump.profile.user}@` : ""}${remoteJump.profile.host}`
    : destinationTarget;
  if (remoteJump) {
    remoteJump.destination = destinationTarget;
    delete remoteJump.profile;
  }

  if (!target || target === "undefined") {
    throw new Error(`Profile "${requestedTarget}" does not define a host.`);
  }

  const args = [];
  if (connectionOptions.batchMode !== false) {
    args.push("-o", "BatchMode=yes");
  }
  args.push("-o", `ConnectTimeout=${Number(connectionOptions.connectTimeoutSec || DEFAULT_CONNECT_TIMEOUT_SEC)}`);
  args.push("-o", `StrictHostKeyChecking=${connectionOptions.strictHostKeyChecking || DEFAULT_STRICT_HOST_KEY_CHECKING}`);

  if (connectionOptions.port) {
    args.push("-p", String(connectionOptions.port));
  }
  if (connectionOptions.identityFile) {
    args.push("-i", String(connectionOptions.identityFile));
  }
  if (connectionOptions.jumpHost) {
    args.push("-J", String(merged.jumpHost));
  }

  const profileExtraArgs = Array.isArray(connectionProfile.extraArgs) ? connectionProfile.extraArgs : [];
  const inputExtraArgs = Array.isArray(input.sshOptions) ? input.sshOptions : [];
  args.push(...profileExtraArgs.map(String), ...inputExtraArgs.map(String));

  return {
    target,
    targetLabel: remoteJump
      ? `${usingProfile ? requestedTarget : destinationTarget} via ${merged.jumpProfile}`
      : usingProfile ? requestedTarget : target,
    sshArgs: args,
    options: merged,
    remoteJump: remoteJump || null,
    configLoadedFrom: config.loadedFrom
  };
}

function resolveRemoteJump(config, requestedTarget, merged) {
  if (!merged.jumpProfile || merged.jumpHost) return null;
  if (requestedTarget === merged.jumpProfile) return null;

  const jumpProfile = config.profiles[merged.jumpProfile];
  if (!jumpProfile) {
    throw new Error(`Jump profile "${merged.jumpProfile}" is not defined.`);
  }
  if (!jumpProfile.host) {
    throw new Error(`Jump profile "${merged.jumpProfile}" does not define a host.`);
  }

  return {
    profile: jumpProfile,
    user: merged.jumpUser || null,
    destination: null
  };
}

export async function runSshCommand(input = {}) {
  if (!input.command || typeof input.command !== "string") {
    throw new Error("command is required.");
  }

  const targetInfo = resolveTarget(input);
  const timeoutMs = Number(targetInfo.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const mode = input.mode || "bash";
  const sshArgs = [...targetInfo.sshArgs, targetInfo.target];
  let stdin = null;

  if (mode === "raw") {
    if (targetInfo.remoteJump) {
      sshArgs.push("bash", "-s");
      stdin = buildRemoteJumpRawScript(input.command, targetInfo.remoteJump, targetInfo.options);
    } else {
      sshArgs.push(input.command);
    }
  } else {
    const useSudo = Boolean(input.sudo) || targetInfo.options.access === "sudo";
    const remoteCommand = useSudo ? ["sudo", "-n", "bash", "-s"] : ["bash", "-s"];
    sshArgs.push(...remoteCommand);
    stdin = targetInfo.remoteJump
      ? buildRemoteJumpScript({ ...input, sudo: useSudo }, targetInfo.remoteJump, targetInfo.options)
      : buildRemoteScript(input);
  }

  const startedAt = Date.now();
  const result = await runProcess("ssh", sshArgs, {
    input: stdin,
    timeoutMs,
    maxOutputBytes: Number(targetInfo.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
  });

  return {
    ...result,
    durationMs: Date.now() - startedAt,
    target: targetInfo.target,
    targetLabel: targetInfo.targetLabel,
    remoteJump: targetInfo.remoteJump,
    mode,
    sudo: Boolean(input.sudo) || targetInfo.options.access === "sudo"
  };
}

function buildRemoteJumpScript(input, remoteJump, options) {
  const destinationScript = buildRemoteScript(input);
  const delimiter = uniqueHeredocDelimiter(destinationScript);
  const nestedArgs = buildNestedSshArgs(remoteJump.destination, options);
  const prefix = remoteJump.user ? `sudo -n -u ${shellQuote(remoteJump.user)} -- ` : "";
  return [
    "set +e",
    `${prefix}ssh ${nestedArgs.map(shellQuote).join(" ")} bash -s <<'${delimiter}'`,
    destinationScript.trimEnd(),
    delimiter,
    ""
  ].join("\n");
}

function buildRemoteJumpRawScript(command, remoteJump, options) {
  const nestedArgs = buildNestedSshArgs(remoteJump.destination, options);
  const prefix = remoteJump.user ? `sudo -n -u ${shellQuote(remoteJump.user)} -- ` : "";
  return `set +e\n${prefix}ssh ${nestedArgs.map(shellQuote).join(" ")} ${shellQuote(command)}\n`;
}

function buildNestedSshArgs(destination, options) {
  const args = [];
  if (options.batchMode !== false) {
    args.push("-o", "BatchMode=yes");
  }
  args.push("-o", `ConnectTimeout=${Number(options.connectTimeoutSec || DEFAULT_CONNECT_TIMEOUT_SEC)}`);
  args.push("-o", `StrictHostKeyChecking=${options.strictHostKeyChecking || DEFAULT_STRICT_HOST_KEY_CHECKING}`);
  if (options.port) {
    args.push("-p", String(options.port));
  }
  args.push(destination);
  return args;
}

function uniqueHeredocDelimiter(source, prefix = "SSH_OPS_REMOTE_SCRIPT") {
  let delimiter = prefix;
  let counter = 0;
  while (source.includes(delimiter)) {
    counter += 1;
    delimiter = `${prefix}_${counter}`;
  }
  return delimiter;
}

function buildRemoteScript(input) {
  const parts = [];
  parts.push("set +e");
  if (input.cwd) {
    parts.push(`cd ${shellQuote(String(input.cwd))} || exit $?`);
  }
  if (input.env && typeof input.env === "object") {
    for (const [key, value] of Object.entries(input.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        parts.push(`export ${key}=${shellQuote(String(value))}`);
      }
    }
  }
  parts.push(input.command.replace(/\r\n/g, "\n"));
  return `${parts.join("\n")}\n`;
}

export function hardwareInventoryScript({ includeSudo = true } = {}) {
  const sudo = includeSudo ? "sudo -n" : "";
  return String.raw`set +e
export LC_ALL=C
section() { printf '\n===== %s =====\n' "$1"; }
run() { printf '\n$ %s\n' "$*"; "$@" 2>&1; }

section "System"
run hostnamectl
run uptime -p
run date -Is
run uname -a
[ -r /etc/os-release ] && { printf '\n$ /etc/os-release\n'; sed -n '1,14p' /etc/os-release; }

section "Provider Metadata"
if command -v curl >/dev/null 2>&1; then
  base='http://169.254.169.254/hetzner/v1/metadata'
  for ep in hostname instance-id region availability-zone public-ipv4 public-ipv6 local-ipv4; do
    printf '%-18s ' "${ep}:"
    curl -fsS --connect-timeout 2 --max-time 3 "${base}/${ep}" 2>/dev/null || echo 'unavailable'
    printf '\n'
  done
else
  echo 'curl not available'
fi

section "CPU"
run lscpu
printf '\n$ CPU model summary\n'
awk -F: '/model name|cpu cores|siblings|processor/ {gsub(/^[ \t]+/,"",$2); print $1 ": " $2}' /proc/cpuinfo | head -80

section "Memory"
run free -h
printf '\n$ /proc/meminfo key lines\n'
grep -E 'MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree|HugePages|Hugepagesize' /proc/meminfo

section "DMI / Firmware"
for f in sys_vendor product_name product_version product_serial board_vendor board_name board_version board_serial bios_vendor bios_version bios_date chassis_type; do
  p="/sys/class/dmi/id/$f"
  [ -r "$p" ] && printf '%-18s %s\n' "$f:" "$(cat "$p" 2>/dev/null)"
done
printf '\n$ dmidecode summary (if permitted)\n'
${sudo} dmidecode -t system -t baseboard -t bios -t memory 2>&1 | sed -n '1,220p'

section "Storage"
run lsblk -e7 -o NAME,TYPE,SIZE,MODEL,SERIAL,ROTA,TRAN,FSTYPE,FSVER,LABEL,MOUNTPOINTS
run df -hT -x tmpfs -x devtmpfs
run df -ih -x tmpfs -x devtmpfs
run findmnt -D
printf '\n$ NVMe devices\n'
command -v nvme >/dev/null 2>&1 && ${sudo} nvme list 2>&1 || echo 'nvme CLI unavailable or permission denied'
printf '\n$ SMART summaries\n'
if command -v smartctl >/dev/null 2>&1; then
  for d in /dev/sd? /dev/nvme?n?; do
    [ -e "$d" ] && echo "--- $d" && ${sudo} smartctl -H -i "$d" 2>&1 | sed -n '1,80p'
  done
else
  echo 'smartctl unavailable'
fi

section "PCI / GPU / USB"
run lspci -nn
printf '\n$ GPU utilities\n'
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi || echo 'nvidia-smi not found'
run lsusb

section "Network"
run ip -br addr
run ip route
printf '\n$ NIC hardware\n'
lspci -nn | grep -Ei 'ethernet|network|wireless|infiniband|fibre|raid|sata|nvme|vga|3d|display'
printf '\n$ Interface speeds\n'
for i in $(ls /sys/class/net | grep -v '^lo$'); do
  echo "--- $i"
  command -v ethtool >/dev/null 2>&1 && ethtool "$i" 2>&1 | grep -E 'Speed|Duplex|Link detected|driver|bus-info' || cat /sys/class/net/$i/{operstate,address} 2>/dev/null
done

section "Thermal / Virtualization"
printf '\n$ thermal zones\n'
for z in /sys/class/thermal/thermal_zone*; do
  [ -e "$z" ] && echo "$(cat "$z/type" 2>/dev/null): $(cat "$z/temp" 2>/dev/null)"
done
printf '\n$ sensors\n'
command -v sensors >/dev/null 2>&1 && sensors || echo 'lm-sensors not installed'
printf '\n$ virtualization\n'
command -v systemd-detect-virt >/dev/null 2>&1 && systemd-detect-virt -v || true
printf '\n$ kernel hypervisor flag\n'
grep -m1 -o 'hypervisor' /proc/cpuinfo || echo 'no hypervisor flag seen in first CPU entry'

section "Load / Processes"
run uptime
printf '\n$ top CPU processes\n'
ps -eo pid,user,comm,%cpu,%mem,rss --sort=-%cpu | head -16
printf '\n$ top memory processes\n'
ps -eo pid,user,comm,%cpu,%mem,rss --sort=-rss | head -16

section "Service Health"
run systemctl --failed --no-pager
printf '\n$ recent boot errors\n'
journalctl -p 3 -b --no-pager -n 50 2>&1
`;
}

export function diskReportScript({ path = "/", depth = 1 } = {}) {
  const safeDepth = Math.max(0, Math.min(5, Number(depth) || 1));
  const quotedPath = shellQuote(String(path));
  return `set +e
export LC_ALL=C
path=${quotedPath}
printf '\\n===== Filesystems =====\\n'
df -hT -x tmpfs -x devtmpfs
printf '\\n===== Inodes =====\\n'
df -ih -x tmpfs -x devtmpfs
printf '\\n===== Disk Usage: %s =====\\n' "$path"
sudo -n du -xhd${safeDepth} "$path" 2>/dev/null | sort -h || du -xhd${safeDepth} "$path" 2>/dev/null | sort -h
printf '\\n===== /var/lib containers, if present =====\\n'
[ -d /var/lib/containerd ] && sudo -n du -xhd1 /var/lib/containerd 2>/dev/null | sort -h
[ -d /var/lib/docker ] && sudo -n du -xhd1 /var/lib/docker 2>/dev/null | sort -h
printf '\\n===== Docker system df, if available =====\\n'
command -v docker >/dev/null 2>&1 && sudo -n docker system df 2>&1 || true
`;
}

export function healthReportScript() {
  return String.raw`set +e
export LC_ALL=C
printf '\n===== Load =====\n'
uptime
cat /proc/loadavg
printf '\n===== Memory =====\n'
free -h
printf '\n===== Disk =====\n'
df -hT -x tmpfs -x devtmpfs
printf '\n===== Failed Units =====\n'
systemctl --failed --no-pager
printf '\n===== Recent Boot Errors =====\n'
journalctl -p 3 -b --no-pager -n 80 2>&1
printf '\n===== Top CPU =====\n'
ps -eo pid,user,comm,%cpu,%mem,rss --sort=-%cpu | head -20
printf '\n===== Top Memory =====\n'
ps -eo pid,user,comm,%cpu,%mem,rss --sort=-rss | head -20
printf '\n===== Docker =====\n'
command -v docker >/dev/null 2>&1 && sudo -n docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>&1 || echo 'docker unavailable or permission denied'
`;
}

export function fileReadScript(path, maxBytes = 51200, encoding = "text") {
  if (encoding === "base64") {
    return `set +e\nbase64 ${shellQuote(String(path))}\n`;
  }
  const safeMax = Math.max(1, Number(maxBytes) || 51200);
  return `set +e\nhead -c ${safeMax} ${shellQuote(String(path))}\n`;
}

export function fileWriteScript(path, content, { backup = true, sudo = false, encoding = "text" } = {}) {
  const parts = [
    "set +e",
    `_f=${shellQuote(String(path))}`
  ];
  if (backup) {
    parts.push(`cp "$_f" "$_f.bak.$(date +%s)" 2>/dev/null || true`);
  }
  if (encoding === "base64") {
    const writer = sudo ? `base64 -d | sudo tee "$_f" > /dev/null` : `base64 -d > "$_f"`;
    parts.push(`${writer} <<'SSH_OPS_B64'`);
    parts.push(String(content).replace(/\r\n/g, "\n").trimEnd());
    parts.push("SSH_OPS_B64");
    return parts.join("\n") + "\n";
  }
  const safeContent = content.replace(/\r\n/g, "\n");
  const delimiter = uniqueHeredocDelimiter(safeContent, "SSH_OPS_WRITE");
  const target = sudo ? `sudo tee "$_f" > /dev/null` : `cat > "$_f"`;
  parts.push(`${target} <<'${delimiter}'`);
  parts.push(safeContent.trimEnd());
  parts.push(delimiter);
  return parts.join("\n") + "\n";
}

export function filePatchScript(path, {
  startLine, endLine, content = "",
  pattern, replacement = "", flags = "g",
  backup = true, sudo = false
} = {}) {
  if (startLine !== undefined && pattern !== undefined) {
    throw new Error("Provide startLine or pattern, not both.");
  }
  if (endLine !== undefined && startLine === undefined) {
    throw new Error("endLine requires startLine.");
  }
  if (startLine === undefined && pattern === undefined) {
    throw new Error("Provide startLine or pattern.");
  }
  if (startLine !== undefined && startLine < 1) {
    throw new Error("startLine must be >= 1.");
  }
  const resolvedEnd = endLine !== undefined ? endLine : startLine;
  if (startLine !== undefined && resolvedEnd < startLine) {
    throw new Error("endLine must be >= startLine.");
  }
  if (!/^[a-zA-Z]*$/.test(flags)) {
    throw new Error("flags must be letters only.");
  }
  if (pattern !== undefined && String(pattern).includes("|")) {
    throw new Error("Pattern cannot contain | (sed delimiter). Use [|] to match a literal pipe.");
  }
  if (replacement !== undefined && String(replacement).includes("|")) {
    throw new Error("Replacement cannot contain | (sed delimiter).");
  }

  const parts = ["set +e", `_f=${shellQuote(String(path))}`];
  if (backup) {
    parts.push(`cp "$_f" "$_f.bak.$(date +%s)" 2>/dev/null || true`);
  }

  if (startLine !== undefined) {
    const safeContent = String(content).replace(/\r\n/g, "\n");
    const delimiter = uniqueHeredocDelimiter(safeContent, "SSH_OPS_PATCH");
    const sudoMv = sudo ? "sudo mv" : "mv";
    parts.push(`{`);
    parts.push(`  head -n $((${startLine} - 1)) "$_f"`);
    if (safeContent.trimEnd()) {
      parts.push(`  cat <<'${delimiter}'`);
      parts.push(safeContent.trimEnd());
      parts.push(delimiter);
    }
    parts.push(`  tail -n +$((${resolvedEnd} + 1)) "$_f"`);
    parts.push(`} > "$_f.tmp" && ${sudoMv} "$_f.tmp" "$_f"`);
  } else {
    const sudoMv = sudo ? "sudo mv" : "mv";
    parts.push(`export SSH_OPS_PATTERN=${shellQuote(String(pattern))}`);
    parts.push(`export SSH_OPS_REPLACEMENT=${shellQuote(String(replacement))}`);
    parts.push(`sed -E "s|$SSH_OPS_PATTERN|$SSH_OPS_REPLACEMENT|${flags}" "$_f" > "$_f.tmp" && ${sudoMv} "$_f.tmp" "$_f"`);
  }

  return parts.join("\n") + "\n";
}

export function serviceScript(service, action, { sudo = true } = {}) {
  const valid = ["status", "start", "stop", "restart", "enable", "disable"];
  if (!valid.includes(action)) {
    throw new Error(`Invalid action: ${action}. Must be one of: ${valid.join(", ")}`);
  }
  const prefix = sudo ? "sudo -n " : "";
  return `set +e\n${prefix}systemctl ${shellQuote(action)} ${shellQuote(String(service))}\n`;
}

export function logSearchScript({ unit, pattern, lines = 100, since, path: logPath } = {}) {
  const safeLines = Math.max(1, Number(lines) || 100);
  const parts = ["set +e", "export LC_ALL=C"];

  if (logPath) {
    const tailCmd = `tail -n ${safeLines} ${shellQuote(String(logPath))}`;
    parts.push(pattern ? `${tailCmd} | grep -E ${shellQuote(String(pattern))}` : tailCmd);
  } else {
    const jParts = ["journalctl", "--no-pager"];
    if (unit) jParts.push("-u", shellQuote(String(unit)));
    if (since) jParts.push("--since", shellQuote(String(since)));
    jParts.push("-n", String(safeLines));
    const journalCmd = jParts.join(" ");
    parts.push(pattern ? `${journalCmd} | grep -E ${shellQuote(String(pattern))}` : journalCmd);
  }
  return parts.join("\n") + "\n";
}

export function formatRunResult(result) {
  const lines = [];
  lines.push(`target: ${result.targetLabel || result.target}`);
  lines.push(`exitCode: ${result.exitCode}`);
  lines.push(`durationMs: ${result.durationMs}`);
  if (result.timedOut) lines.push("timedOut: true");
  if (result.stdoutTruncated) lines.push("stdoutTruncated: true");
  if (result.stderrTruncated) lines.push("stderrTruncated: true");
  lines.push("");
  lines.push("----- stdout -----");
  lines.push(result.stdout || "");
  if (result.stderr) {
    lines.push("");
    lines.push("----- stderr -----");
    lines.push(result.stderr);
  }
  return lines.join("\n");
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (stdoutTruncated) return;
      if (stdoutBytes + chunk.length <= maxOutputBytes) {
        stdout += chunk.toString("utf8");
        stdoutBytes += chunk.length;
      } else {
        stdoutTruncated = true;
      }
    });

    child.stderr.on("data", (chunk) => {
      if (stderrTruncated) return;
      if (stderrBytes + chunk.length <= maxOutputBytes) {
        stderr += chunk.toString("utf8");
        stderrBytes += chunk.length;
      } else {
        stderrTruncated = true;
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({
        exitCode: 127,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        stdoutTruncated,
        stderrTruncated,
        timedOut
      });
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({
        exitCode: timedOut ? 124 : exitCode,
        signal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut
      });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
