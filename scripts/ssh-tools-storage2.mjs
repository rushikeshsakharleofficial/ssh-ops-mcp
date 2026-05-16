import { runSshCommand, formatRunResult } from "./ssh-core.mjs";

function shellQuote(v) { return `'${String(v).replace(/'/g, "'\\''")}'`; }
function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }
function dryRunResult(toolName, args, command, target) {
  return textResult(JSON.stringify({ dryRun: true, tool: toolName, target: target || args.target || args.host || "(default)", sudo: Boolean(args.sudo !== false), command: command || null, note: "dryRun:true — nothing executed" }, null, 2));
}
function requireConfirm(toolName, args) {
  const r = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${r}`, true);
}

const LVM_NAME_RE = /^[a-zA-Z0-9._+-]+$/;
const SIZE_RE = /^[+]?[0-9]+[MGT]$/;

export const toolDefs = [
  {
    name: "ssh_lvm",
    title: "SSH LVM Volume Management",
    description: "Manage LVM physical volumes, volume groups, and logical volumes: list, extend, create/remove snapshots, check status.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target:       { type: "string", description: "Profile name or user@host" },
        action:       { type: "string", enum: ["list","status","extend","create-snapshot","remove-snapshot","resize"], description: "LVM action to perform" },
        vg:           { type: "string", description: "Volume group name (required for extend/snapshot/resize)" },
        lv:           { type: "string", description: "Logical volume name (required for extend/snapshot/resize)" },
        size:         { type: "string", description: "Size for extend/snapshot/resize e.g. 10G, 500M, +5G" },
        snapshotName: { type: "string", description: "Name for new snapshot LV" },
        sudo:         { type: "boolean", description: "Run with sudo (default true)", default: true },
        confirm:      { type: "boolean", description: "Required for mutating operations" },
        dryRun:       { type: "boolean", description: "Preview command without executing" },
        reason:       { type: "string", description: "Reason for the operation" }
      }
    }
  }
];

export async function handleTool(name, args) {
  if (name !== "ssh_lvm") return null;

  const { action, vg, lv, size, snapshotName, dryRun, confirm, reason } = args;
  const sudo = args.sudo !== false;
  const sudoPrefix = sudo ? "sudo " : "";

  const MUTATING = ["extend", "create-snapshot", "remove-snapshot", "resize"];

  // Validate vg/lv names for actions that need them
  if (["extend", "create-snapshot", "remove-snapshot", "resize"].includes(action)) {
    if (!vg || !LVM_NAME_RE.test(vg)) return textResult(`ssh_lvm: invalid or missing vg name.`, true);
    if (action !== "remove-snapshot" && (!lv || !LVM_NAME_RE.test(lv))) return textResult(`ssh_lvm: invalid or missing lv name.`, true);
  }
  if (action === "create-snapshot" || action === "remove-snapshot") {
    if (!snapshotName || !LVM_NAME_RE.test(snapshotName)) return textResult(`ssh_lvm: invalid or missing snapshotName.`, true);
  }
  if (["extend", "create-snapshot", "resize"].includes(action)) {
    if (!size || !SIZE_RE.test(size)) return textResult(`ssh_lvm: invalid or missing size (e.g. 10G, 500M, +5G).`, true);
  }

  let script;

  if (action === "list") {
    script = [
      "set +e",
      "export LC_ALL=C",
      `echo "=== Physical Volumes ==="`,
      `${sudoPrefix}pvs 2>/dev/null || ${sudoPrefix}pvdisplay 2>/dev/null`,
      `echo ""`,
      `echo "=== Volume Groups ==="`,
      `${sudoPrefix}vgs 2>/dev/null || ${sudoPrefix}vgdisplay 2>/dev/null`,
      `echo ""`,
      `echo "=== Logical Volumes ==="`,
      `${sudoPrefix}lvs 2>/dev/null || ${sudoPrefix}lvdisplay 2>/dev/null`
    ].join("\n");
  } else if (action === "status") {
    script = [
      "set +e",
      "export LC_ALL=C",
      `echo "=== LVM Full Status ==="`,
      `${sudoPrefix}vgdisplay -v 2>/dev/null`,
      `echo ""`,
      `${sudoPrefix}lvs -a -o +devices 2>/dev/null`
    ].join("\n");
  } else if (action === "extend") {
    const _vg = shellQuote(vg);
    const _lv = shellQuote(lv);
    const _size = shellQuote(size);
    script = [
      "set +e",
      `_vg=${_vg} _lv=${_lv} _size=${_size}`,
      `${sudoPrefix}lvextend -L $_size /dev/$_vg/$_lv 2>&1 && \\`,
      `  echo "Extended. Resizing filesystem..." && \\`,
      `  { ${sudoPrefix}resize2fs /dev/$_vg/$_lv 2>/dev/null || \\`,
      `    ${sudoPrefix}xfs_growfs /dev/$_vg/$_lv 2>/dev/null || \\`,
      `    echo "Filesystem resize: run manually for your FS type"; }`
    ].join("\n");
  } else if (action === "create-snapshot") {
    const _vg = shellQuote(vg);
    const _lv = shellQuote(lv);
    const _snap = shellQuote(snapshotName);
    const _size = shellQuote(size);
    script = [
      "set +e",
      `_vg=${_vg} _lv=${_lv} _snap=${_snap} _size=${_size}`,
      `${sudoPrefix}lvcreate -L $_size -s -n $_snap /dev/$_vg/$_lv 2>&1`,
      `echo "Snapshot created: /dev/$_vg/$_snap"`
    ].join("\n");
  } else if (action === "remove-snapshot") {
    const _vg = shellQuote(vg);
    const _snap = shellQuote(snapshotName);
    script = [
      "set +e",
      `_vg=${_vg} _snap=${_snap}`,
      `${sudoPrefix}lvremove -f /dev/$_vg/$_snap 2>&1`
    ].join("\n");
  } else if (action === "resize") {
    const _vg = shellQuote(vg);
    const _lv = shellQuote(lv);
    const _size = shellQuote(size);
    script = [
      "set +e",
      `_vg=${_vg} _lv=${_lv} _size=${_size}`,
      `${sudoPrefix}lvresize -L $_size /dev/$_vg/$_lv 2>&1 && \\`,
      `  echo "Resized. Resizing filesystem..." && \\`,
      `  { ${sudoPrefix}resize2fs /dev/$_vg/$_lv 2>/dev/null || \\`,
      `    ${sudoPrefix}xfs_growfs /dev/$_vg/$_lv 2>/dev/null || \\`,
      `    echo "Filesystem resize: run manually for your FS type"; }`
    ].join("\n");
  } else {
    return textResult(`ssh_lvm: unknown action "${action}".`, true);
  }

  if (dryRun) return dryRunResult("ssh_lvm", args, script, args.target);

  if (MUTATING.includes(action) && !confirm) return requireConfirm("ssh_lvm", args);

  const result = await runSshCommand({ target: args.target, command: script, mode: "bash", sudo: false });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}
