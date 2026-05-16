// ssh-tools-storage3.mjs — advanced storage: ssh_nfs, ssh_zfs
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

function validateAbsPath(p) {
  return typeof p === "string" && p.startsWith("/") && !p.includes("..") && !/[\r\n\x00]/.test(p);
}

function validateZfsName(n) {
  return typeof n === "string" && /^[a-zA-Z0-9_.:@/-]+$/.test(n) && n.length > 0;
}

export const toolDefs = [
  {
    name: "ssh_nfs",
    title: "SSH NFS Export Management",
    description: "Manage NFS exports on a remote host: list exports, show connected clients, add/remove export entries.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: {
          type: "string",
          enum: ["list", "clients", "add", "remove", "reload"],
          description: "NFS action."
        },
        path: { type: "string", description: "Absolute path to export (required for add/remove)." },
        options: { type: "string", description: "NFS export options string e.g. '*(rw,sync,no_subtree_check)'." },
        host: { type: "string", description: "Client host/range e.g. '192.168.1.0/24' (for add, embedded in options if omitted)." },
        sudo: { type: "boolean", description: "Use sudo. Default true." },
        confirm: { type: "boolean", description: "Required for add/remove/reload." },
        dryRun: { type: "boolean", description: "Preview command without executing." },
        reason: { type: "string", description: "Reason logged to audit log." }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_zfs",
    title: "SSH ZFS Management",
    description: "Manage ZFS storage pools and datasets: list, create, destroy, snapshot, rollback, scrub, get/set properties.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: {
          type: "string",
          enum: ["list", "list-pools", "create", "destroy", "snapshot", "rollback", "scrub", "status", "get", "set"],
          description: "ZFS action."
        },
        dataset: { type: "string", description: "Dataset or pool name (required for most actions)." },
        snapshot: { type: "string", description: "Snapshot name (appended after @) for snapshot/rollback." },
        recursive: { type: "boolean", description: "Apply recursively (-r flag)." },
        property: { type: "string", description: "ZFS property name for get/set." },
        value: { type: "string", description: "Property value for set." },
        mountpoint: { type: "string", description: "Mountpoint for create action." },
        sudo: { type: "boolean", description: "Use sudo. Default true." },
        confirm: { type: "boolean", description: "Required for create/destroy/rollback/scrub/set." },
        dryRun: { type: "boolean", description: "Preview command without executing." },
        reason: { type: "string", description: "Reason logged to audit log." }
      },
      required: ["action"]
    }
  }
];

export async function handleTool(name, args) {
  if (name === "ssh_nfs") {
    const mutating = ["add", "remove", "reload"];
    if (mutating.includes(args.action) && args.confirm !== true) {
      return requireConfirm(name, args);
    }

    let command;

    if (args.action === "list") {
      command = `set +e
export LC_ALL=C
echo "=== /etc/exports ==="
cat /etc/exports 2>/dev/null || echo "(not found)"
echo ""
echo "=== Active Exports (exportfs) ==="
exportfs -v 2>&1 || showmount -e localhost 2>&1
`;
    } else if (args.action === "clients") {
      command = `set +e
export LC_ALL=C
echo "=== Connected NFS Clients ==="
showmount --all 2>/dev/null || ss -tn sport = :2049 2>/dev/null | head -20
echo ""
echo "=== NFS Server Stats ==="
nfsstat -s 2>/dev/null | head -20 || echo "(nfsstat not available)"
`;
    } else if (args.action === "add") {
      if (!args.path) return textResult("path is required for add.", true);
      if (!validateAbsPath(args.path)) return textResult("path must be absolute with no '..' segments.", true);
      if (!/[\r\n\x00`]/.test(String(args.options || ""))) {
        // valid
      } else {
        return textResult("options must not contain newlines or backticks.", true);
      }

      const pathQ = shellQuote(args.path);
      const opts = args.options || (args.host ? `${args.host}(rw,sync,no_subtree_check)` : "*(rw,sync,no_subtree_check)");
      const entryQ = shellQuote(`${args.path}\t${opts}`);

      command = `set +e
export LC_ALL=C
_f=/etc/exports
_path=${pathQ}
_entry=${entryQ}

if grep -qF "$_path" "$_f" 2>/dev/null; then
  echo "Warning: $_path already in $_f:"
  grep "$_path" "$_f"
fi

echo "$_entry" >> "$_f"
echo "Added to $_f: $_entry"
exportfs -ra 2>&1 && echo "NFS exports reloaded"
`;
    } else if (args.action === "remove") {
      if (!args.path) return textResult("path is required for remove.", true);
      if (!validateAbsPath(args.path)) return textResult("path must be absolute with no '..' segments.", true);
      const pathQ = shellQuote(args.path);

      command = `set +e
export LC_ALL=C
_path=${pathQ}
cp /etc/exports /etc/exports.bak.$(date +%s)
grep -v "^$_path[[:space:]]" /etc/exports | grep -v "^${shellQuote(args.path)}$" > /etc/exports.tmp
mv /etc/exports.tmp /etc/exports
echo "Removed $_path from /etc/exports"
exportfs -ra 2>&1 && echo "NFS exports reloaded"
`;
    } else if (args.action === "reload") {
      command = `set +e
exportfs -ra 2>&1 && echo "NFS exports reloaded"
`;
    } else {
      return textResult(`Unknown action: ${args.action}`, true);
    }

    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({ ...args, command, mode: "bash", sudo: args.sudo !== false, timeoutMs: args.timeoutMs || 60_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_zfs") {
    const mutating = ["create", "destroy", "rollback", "scrub", "set"];
    if (mutating.includes(args.action) && args.confirm !== true) {
      return requireConfirm(name, args);
    }

    if (["create", "destroy", "snapshot", "rollback", "scrub", "status", "get", "set"].includes(args.action) && !args.dataset) {
      return textResult("dataset is required for this action.", true);
    }
    if (args.dataset && !validateZfsName(args.dataset)) {
      return textResult(`dataset name is invalid. Use only [a-zA-Z0-9_.:@/-]. Got: ${args.dataset}`, true);
    }

    const r = args.recursive ? "-r " : "";
    const ds = args.dataset ? shellQuote(args.dataset) : "";
    let command;

    if (args.action === "list") {
      command = `set +e
export LC_ALL=C
zfs list ${r}${ds} -o name,used,avail,refer,mountpoint 2>&1
`;
    } else if (args.action === "list-pools") {
      command = `set +e
export LC_ALL=C
echo "=== ZFS Pools ==="
zpool list -o name,size,alloc,free,frag,cap,dedup,health 2>&1
echo ""
echo "=== Pool Status ==="
zpool status 2>&1
`;
    } else if (args.action === "status") {
      command = `set +e
export LC_ALL=C
zpool status ${ds} 2>&1
echo ""
zfs list ${ds} 2>&1
`;
    } else if (args.action === "create") {
      const mp = args.mountpoint ? `-o mountpoint=${shellQuote(args.mountpoint)} ` : "";
      command = `set +e
export LC_ALL=C
zfs create -p ${mp}${ds} 2>&1 && echo "Created: ${args.dataset}"
`;
    } else if (args.action === "destroy") {
      command = `set +e
export LC_ALL=C
zfs destroy ${r}${ds} 2>&1 && echo "Destroyed: ${args.dataset}"
`;
    } else if (args.action === "snapshot") {
      if (!args.snapshot) return textResult("snapshot name is required.", true);
      if (!/^[a-zA-Z0-9_.:@-]+$/.test(args.snapshot)) return textResult("snapshot name contains invalid characters.", true);
      const snapFull = shellQuote(`${args.dataset}@${args.snapshot}`);
      command = `set +e
export LC_ALL=C
zfs snapshot ${r}${snapFull} 2>&1 && echo "Snapshot created: ${args.dataset}@${args.snapshot}"
`;
    } else if (args.action === "rollback") {
      if (!args.snapshot) return textResult("snapshot name is required for rollback.", true);
      if (!/^[a-zA-Z0-9_.:@-]+$/.test(args.snapshot)) return textResult("snapshot name contains invalid characters.", true);
      const snapFull = shellQuote(`${args.dataset}@${args.snapshot}`);
      command = `set +e
export LC_ALL=C
zfs rollback ${r}${snapFull} 2>&1 && echo "Rolled back to: ${args.dataset}@${args.snapshot}"
`;
    } else if (args.action === "scrub") {
      command = `set +e
export LC_ALL=C
zpool scrub ${ds} 2>&1 && echo "Scrub started on ${args.dataset}"
`;
    } else if (args.action === "get") {
      if (!args.property) return textResult("property is required for get.", true);
      if (!/^[a-zA-Z0-9:_]+$/.test(args.property)) return textResult("property contains invalid characters.", true);
      command = `set +e
export LC_ALL=C
zfs get ${shellQuote(args.property)} ${ds} 2>&1
`;
    } else if (args.action === "set") {
      if (!args.property) return textResult("property is required for set.", true);
      if (!args.value && args.value !== "") return textResult("value is required for set.", true);
      if (!/^[a-zA-Z0-9:_]+$/.test(args.property)) return textResult("property contains invalid characters.", true);
      if (/[\r\n\x00`]/.test(String(args.value))) return textResult("value must not contain newlines or backticks.", true);
      const propVal = shellQuote(`${args.property}=${args.value}`);
      command = `set +e
export LC_ALL=C
zfs set ${propVal} ${ds} 2>&1 && echo "Set ${args.property}=${args.value} on ${args.dataset}"
`;
    } else {
      return textResult(`Unknown action: ${args.action}`, true);
    }

    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({ ...args, command, mode: "bash", sudo: args.sudo !== false, timeoutMs: args.timeoutMs || 120_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  return null;
}
