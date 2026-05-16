// ssh-tools-system2.mjs — system tools: ssh_sysctl, ssh_swap, ssh_kernel, ssh_limits
import { runSshCommand, formatRunResult } from "./ssh-core.mjs";

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

const LIMITS_ITEM_ALLOWLIST = new Set([
  "nofile","nproc","memlock","stack","core","fsize","as","cpu","rss","locks",
  "sigpending","msgqueue","nice","rtprio","data","maxlogins","maxsyslogins",
  "priority","chroot","namespace"
]);

export const toolDefs = [
  {
    name: "ssh_sysctl",
    title: "SSH Kernel Parameter Management",
    description: "Read or write kernel parameters via sysctl. list shows all params, get reads one, set writes one (requires confirm, optionally persisted to /etc/sysctl.d/).",
    inputSchema: {
      type: "object",
      properties: {
        target:  { type: "string",  description: "Profile name or user@host" },
        action:  { type: "string",  enum: ["list","get","set","search"], description: "Action to perform" },
        key:     { type: "string",  description: "Sysctl key (e.g. vm.swappiness). Required for get/set" },
        value:   { type: "string",  description: "Value for set action" },
        persist: { type: "boolean", description: "Write to /etc/sysctl.d/99-ssh-ops.conf for persistence (set only)" },
        filter:  { type: "string",  description: "Grep filter for list/search" },
        sudo:    { type: "boolean", description: "Run via sudo (default true for set, false for get/list)" },
        confirm: { type: "boolean", description: "Required for set" },
        dryRun:  { type: "boolean", description: "Preview without executing" },
        reason:  { type: "string",  description: "Reason for the change" }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_swap",
    title: "SSH Swap Management",
    description: "View and manage swap space: show current usage, add/remove swap files, enable/disable swap partitions.",
    inputSchema: {
      type: "object",
      properties: {
        target:   { type: "string",  description: "Profile name or user@host" },
        action:   { type: "string",  enum: ["status","add","remove","on","off"], description: "Action to perform" },
        swapFile: { type: "string",  description: "Path for swap file (for add/remove/on/off)" },
        sizeMB:   { type: "number",  description: "Swap file size in MB (for add, default 1024)" },
        sudo:     { type: "boolean", description: "Run via sudo (default true)" },
        confirm:  { type: "boolean", description: "Required for add/remove/on/off" },
        dryRun:   { type: "boolean", description: "Preview without executing" },
        reason:   { type: "string",  description: "Reason for the change" }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_kernel",
    title: "SSH Kernel Info",
    description: "Show kernel version, loaded modules, recent dmesg output, and kernel parameters summary.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host" },
        action: { type: "string", enum: ["version","modules","dmesg","params"], description: "Action to perform" },
        filter: { type: "string", description: "Grep filter for modules/dmesg" },
        level:  { type: "string", enum: ["all","err","warn","info"], description: "Dmesg level filter (default err)" },
        lines:  { type: "number", description: "Dmesg lines (default 50)" },
        sudo:   { type: "boolean", description: "Run via sudo (default false)" }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_limits",
    title: "SSH Ulimit / Security Limits Management",
    description: "Read and manage /etc/security/limits.conf entries and view current process limits.",
    inputSchema: {
      type: "object",
      properties: {
        target:    { type: "string", description: "Profile name or user@host" },
        action:    { type: "string", enum: ["list","get","set","remove","current"], description: "Action to perform" },
        domain:    { type: "string", description: "User or group (@ prefix for groups) for set/remove/get" },
        limitType: { type: "string", enum: ["soft","hard","both"], description: "Limit type for set" },
        item:      { type: "string", description: "Limit item: nofile/nproc/memlock/stack/core/fsize/as/cpu/rss/locks/etc" },
        value:     { type: "string", description: "Limit value (number or unlimited) for set" },
        sudo:      { type: "boolean", description: "Run via sudo (default true for set/remove)" },
        confirm:   { type: "boolean", description: "Required for set/remove" },
        dryRun:    { type: "boolean", description: "Preview without executing" },
        reason:    { type: "string",  description: "Reason for the change" }
      },
      required: ["action"]
    }
  }
];

export async function handleTool(name, args) {

  // ── ssh_sysctl ──────────────────────────────────────────────────────────────
  if (name === "ssh_sysctl") {
    const action = args.action;
    if (!action) return textResult("action is required.", true);

    const validActions = ["list","get","set","search"];
    if (!validActions.includes(action)) return textResult(`Invalid action. Must be one of: ${validActions.join(", ")}`, true);

    // Validate key for get/set
    if (action === "get" || action === "set") {
      if (!args.key) return textResult("key is required for get/set.", true);
      if (!/^[a-zA-Z0-9._-]+$/.test(String(args.key))) {
        return textResult("Invalid sysctl key. Only letters, digits, dots, underscores, and hyphens allowed.", true);
      }
    }

    // Validate value for set
    if (action === "set") {
      if (args.value === undefined || args.value === null || args.value === "") {
        return textResult("value is required for set.", true);
      }
      const valStr = String(args.value);
      if (/[\r\n\x00]/.test(valStr)) {
        return textResult("value must not contain newlines or null bytes.", true);
      }
    }

    const key = args.key ? String(args.key) : null;
    const value = args.value !== undefined ? String(args.value) : null;
    const filter = args.filter ? String(args.filter) : null;

    // Default sudo: true for set, false for get/list/search
    const useSudo = args.sudo !== undefined ? Boolean(args.sudo) : action === "set";

    let command;
    if (action === "list") {
      command = filter
        ? `sysctl -a 2>/dev/null | grep -i ${JSON.stringify(filter)}`
        : `sysctl -a 2>/dev/null`;
    } else if (action === "search") {
      if (!filter) return textResult("filter is required for search.", true);
      command = `sysctl -a 2>/dev/null | grep -i ${JSON.stringify(filter)}`;
    } else if (action === "get") {
      command = `sysctl ${JSON.stringify(key)}`;
    } else if (action === "set") {
      if (args.dryRun) return dryRunResult("ssh_sysctl", args, `sysctl -w ${key}=${value}`, args.target);
      if (!args.confirm) return requireConfirm("ssh_sysctl", args);

      const setPart = `sysctl -w ${JSON.stringify(key)}=${JSON.stringify(value)}`;
      if (args.persist) {
        command = `${setPart} && echo ${JSON.stringify(`${key}=${value}`)} >> /etc/sysctl.d/99-ssh-ops.conf && sysctl -p /etc/sysctl.d/99-ssh-ops.conf`;
      } else {
        command = setPart;
      }
    }

    const result = await runSshCommand({ ...args, command, mode: "bash", sudo: useSudo });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── ssh_swap ────────────────────────────────────────────────────────────────
  if (name === "ssh_swap") {
    const action = args.action;
    if (!action) return textResult("action is required.", true);

    const validActions = ["status","add","remove","on","off"];
    if (!validActions.includes(action)) return textResult(`Invalid action. Must be one of: ${validActions.join(", ")}`, true);

    const useSudo = args.sudo !== undefined ? Boolean(args.sudo) : true;
    const writeActions = ["add","remove","on","off"];

    if (writeActions.includes(action)) {
      // Validate swapFile
      if (!args.swapFile) return textResult("swapFile is required for add/remove/on/off.", true);
      const sf = String(args.swapFile);
      if (!sf.startsWith("/")) return textResult("swapFile must be an absolute path.", true);
      if (sf.includes("..")) return textResult("swapFile must not contain '..'.", true);
      if (/[\x00\r\n]/.test(sf)) return textResult("swapFile must not contain null bytes or newlines.", true);

      if (args.dryRun) return dryRunResult("ssh_swap", args, `swap ${action} ${sf}`, args.target);
      if (!args.confirm) return requireConfirm("ssh_swap", args);
    }

    let command;
    if (action === "status") {
      command = `free -h && swapon --show 2>/dev/null && cat /proc/swaps`;
    } else if (action === "add") {
      const sf = String(args.swapFile);
      const sizeMB = args.sizeMB !== undefined ? Number(args.sizeMB) : 1024;
      if (!Number.isInteger(sizeMB) || sizeMB < 64 || sizeMB > 32768) {
        return textResult("sizeMB must be an integer between 64 and 32768.", true);
      }
      const sfJ = JSON.stringify(sf);
      const szJ = JSON.stringify(String(sizeMB));
      command = `_file=${sfJ}
_size=${szJ}
dd if=/dev/zero of="$_file" bs=1M count="$_size" status=progress 2>&1
chmod 600 "$_file"
mkswap "$_file" 2>&1
swapon "$_file" 2>&1
echo "Swap activated: $_file (${sizeMB}MB)"
echo "$_file none swap sw 0 0" >> /etc/fstab && echo "Added to /etc/fstab"`;
    } else if (action === "remove") {
      const sf = String(args.swapFile);
      const sfJ = JSON.stringify(sf);
      command = `_file=${sfJ}
swapoff "$_file" 2>/dev/null
rm -f "$_file"
sed -i "\\|$_file|d" /etc/fstab
echo "Swap file removed and disabled"`;
    } else if (action === "on") {
      command = `swapon ${JSON.stringify(String(args.swapFile))}`;
    } else if (action === "off") {
      command = `swapoff ${JSON.stringify(String(args.swapFile))}`;
    }

    const result = await runSshCommand({ ...args, command, mode: "bash", sudo: useSudo });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── ssh_kernel ──────────────────────────────────────────────────────────────
  if (name === "ssh_kernel") {
    const action = args.action;
    if (!action) return textResult("action is required.", true);

    const validActions = ["version","modules","dmesg","params"];
    if (!validActions.includes(action)) return textResult(`Invalid action. Must be one of: ${validActions.join(", ")}`, true);

    const useSudo = Boolean(args.sudo);
    const filter = args.filter ? String(args.filter) : null;
    const lines = args.lines ? Number(args.lines) : 50;
    const level = args.level || "err";

    let command;
    if (action === "version") {
      command = `uname -a && cat /proc/version && cat /etc/os-release | grep -E "^(NAME|VERSION)="`;
    } else if (action === "modules") {
      if (filter) {
        command = `lsmod | grep -i ${JSON.stringify(filter)}`;
      } else {
        command = `lsmod | head -50`;
      }
    } else if (action === "dmesg") {
      let levelFlag;
      if (level === "all") levelFlag = "";
      else if (level === "err") levelFlag = "--level=err ";
      else if (level === "warn") levelFlag = "--level=warn,err ";
      else if (level === "info") levelFlag = "--level=info ";
      else levelFlag = "--level=err ";

      const baseCmd = `dmesg ${levelFlag}--time-format iso | tail -${lines}`;
      const fallback = `dmesg | tail -${lines}`;
      command = `${baseCmd} 2>/dev/null || ${fallback}`;
      if (filter) {
        command = `(${baseCmd} 2>/dev/null || ${fallback}) | grep -i ${JSON.stringify(filter)}`;
      }
    } else if (action === "params") {
      command = `sysctl -a 2>/dev/null | grep -E "^(vm\\.|net\\.ipv4\\.|kernel\\.)" | head -40`;
    }

    const result = await runSshCommand({ ...args, command, mode: "bash", sudo: useSudo });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── ssh_limits ──────────────────────────────────────────────────────────────
  if (name === "ssh_limits") {
    const action = args.action;
    if (!action) return textResult("action is required.", true);

    const validActions = ["list","get","set","remove","current"];
    if (!validActions.includes(action)) return textResult(`Invalid action. Must be one of: ${validActions.join(", ")}`, true);

    const writeActions = ["set","remove"];
    const useSudo = args.sudo !== undefined ? Boolean(args.sudo) : writeActions.includes(action);

    // Validate domain for get/set/remove
    if (["get","set","remove"].includes(action)) {
      if (!args.domain) return textResult("domain is required for get/set/remove.", true);
      if (!/^[@a-zA-Z0-9_.-]+$/.test(String(args.domain))) {
        return textResult("Invalid domain. Use letters, digits, @, hyphens, underscores, and dots only.", true);
      }
    }

    // Validate item for get/set/remove
    if (["get","set","remove"].includes(action)) {
      if (!args.item) return textResult("item is required for get/set/remove.", true);
      if (!LIMITS_ITEM_ALLOWLIST.has(String(args.item))) {
        return textResult(`Invalid item. Must be one of: ${[...LIMITS_ITEM_ALLOWLIST].join(", ")}`, true);
      }
    }

    // Validate for set
    if (action === "set") {
      if (!args.limitType) return textResult("limitType is required for set.", true);
      if (!["soft","hard","both"].includes(String(args.limitType))) {
        return textResult("limitType must be soft, hard, or both.", true);
      }
      if (args.value === undefined || args.value === null) return textResult("value is required for set.", true);
      const val = String(args.value);
      if (val !== "unlimited" && !/^\d+$/.test(val)) {
        return textResult("value must be an integer or 'unlimited'.", true);
      }
    }

    const domain = args.domain ? String(args.domain) : null;
    const item = args.item ? String(args.item) : null;
    const value = args.value !== undefined ? String(args.value) : null;
    const limitType = args.limitType ? String(args.limitType) : null;

    if (writeActions.includes(action)) {
      if (args.dryRun) return dryRunResult("ssh_limits", args, `limits ${action} ${domain} ${item}`, args.target);
      if (!args.confirm) return requireConfirm("ssh_limits", args);
    }

    let command;
    if (action === "list") {
      command = `cat /etc/security/limits.conf | grep -v "^#" | grep -v "^$"`;
    } else if (action === "get") {
      command = `grep "^${domain} " /etc/security/limits.conf | grep " ${item} "`;
    } else if (action === "current") {
      command = `ulimit -a`;
    } else if (action === "set") {
      const writeEntry = (ltype) => {
        const line = `${domain} ${ltype} ${item} ${value}`;
        return `echo ${JSON.stringify(line)} >> /etc/security/limits.d/99-ssh-ops.conf`;
      };
      if (limitType === "both") {
        command = `${writeEntry("soft")} && ${writeEntry("hard")}`;
      } else {
        command = writeEntry(limitType);
      }
    } else if (action === "remove") {
      command = `sed -i ${JSON.stringify(`/^${domain}.*${item}/d`)} /etc/security/limits.conf /etc/security/limits.d/*.conf 2>/dev/null; echo "Done"`;
    }

    const result = await runSshCommand({ ...args, command, mode: "bash", sudo: useSudo });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  return null;
}
