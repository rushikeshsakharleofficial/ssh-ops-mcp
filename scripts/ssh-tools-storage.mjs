// ssh-tools-storage.mjs — storage and deployment tools: ssh_mount, ssh_git, ssh_backup
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

function hasControlChars(s) {
  return /[\r\n\x00]/.test(s);
}

function isAbsNoTraversal(p) {
  if (typeof p !== "string") return false;
  if (!p.startsWith("/")) return false;
  if (p.includes("\x00")) return false;
  const parts = p.split("/");
  return !parts.includes("..");
}

// ─── ssh_mount ───────────────────────────────────────────────────────────────

const mountToolDef = {
  name: "ssh_mount",
  title: "SSH Mount Management",
  description: "List filesystem mounts or mount/unmount filesystems on a remote host. mount/umount require confirm:true and sudo.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      target:     { type: "string",  description: "Profile name or user@host." },
      action:     { type: "string",  enum: ["list", "mount", "umount"], description: "Operation to perform." },
      device:     { type: "string",  description: "Block device (e.g. /dev/sdb1) or NFS path (HOST:/path). Required for mount." },
      mountpoint: { type: "string",  description: "Absolute mount path. Required for mount/umount." },
      fstype:     { type: "string",  description: "Filesystem type (ext4, xfs, nfs, etc.)." },
      options:    { type: "string",  description: "Mount options (e.g. rw,relatime)." },
      sudo:       { type: "boolean", description: "Run with sudo (default true)." },
      confirm:    { type: "boolean", description: "Required for mount/umount." },
      dryRun:     { type: "boolean", description: "Preview only, do not execute." },
      reason:     { type: "string",  description: "Reason for the operation." }
    }
  }
};

async function handleMount(args) {
  const VALID_ACTIONS = ["list", "mount", "umount"];
  const action = String(args.action || "");
  if (!VALID_ACTIONS.includes(action)) {
    return textResult(`ssh_mount: invalid action "${action}". Must be one of: ${VALID_ACTIONS.join(", ")}`, true);
  }

  const sudo = args.sudo !== false; // default true

  if (action === "mount" || action === "umount") {
    if (!args.confirm) return requireConfirm("ssh_mount", args);

    const mp = String(args.mountpoint || "");
    if (!mp) return textResult("ssh_mount: mountpoint is required for mount/umount", true);
    if (!isAbsNoTraversal(mp)) return textResult(`ssh_mount: mountpoint must be absolute with no .. segments: ${mp}`, true);
    if (!/^[/a-zA-Z0-9._-]+$/.test(mp)) return textResult(`ssh_mount: mountpoint contains invalid characters: ${mp}`, true);
    if (hasControlChars(mp)) return textResult("ssh_mount: mountpoint contains control characters", true);

    if (action === "mount") {
      const device = String(args.device || "");
      if (!device) return textResult("ssh_mount: device is required for mount", true);
      if (hasControlChars(device)) return textResult("ssh_mount: device contains control characters", true);
      // must start with /dev/ OR match NFS HOST:/path
      const isDevPath = device.startsWith("/dev/");
      const isNfs = /^[a-zA-Z0-9._-]+:\//.test(device);
      if (!isDevPath && !isNfs) {
        return textResult(`ssh_mount: device must start with /dev/ or be an NFS path (HOST:/path): ${device}`, true);
      }
      if (device.includes("..")) return textResult("ssh_mount: device must not contain .. segments", true);

      if (args.fstype !== undefined) {
        const fstype = String(args.fstype);
        if (!/^[a-zA-Z0-9._-]+$/.test(fstype)) {
          return textResult(`ssh_mount: invalid fstype "${fstype}"`, true);
        }
      }
      if (args.options !== undefined) {
        const opts = String(args.options);
        if (hasControlChars(opts)) return textResult("ssh_mount: options contains control characters", true);
        if (opts.includes("`")) return textResult("ssh_mount: options must not contain backticks", true);
        if (opts.includes("$(") || opts.includes("${")) return textResult("ssh_mount: options must not contain shell expansions", true);
      }

      const devQ  = JSON.stringify(String(args.device));
      const mpQ   = JSON.stringify(mp);
      const fstypeClean = args.fstype ? String(args.fstype).replace(/[^a-zA-Z0-9._-]/g, "") : "";
      const fstypeFlag  = fstypeClean ? `-t ${JSON.stringify(fstypeClean)}` : "";
      const optsFlag    = args.options ? `-o ${JSON.stringify(String(args.options))}` : "";

      const script = `set +e
export LC_ALL=C
_dev=${devQ}
_mp=${mpQ}

mkdir -p "$_mp"
mount ${fstypeFlag} ${optsFlag} "$_dev" "$_mp" && echo "Mounted $_dev at $_mp" || { echo "Mount failed" >&2; exit 1; }

findmnt "$_mp" 2>/dev/null || mount | grep "$_mp"
`;

      if (args.dryRun) return dryRunResult("ssh_mount", args, script, args.target);

      const result = await runSshCommand({ target: args.target, command: script, sudo, mode: "bash" });
      return textResult(formatRunResult(result), result.exitCode !== 0);
    }

    // umount
    const mpQ = JSON.stringify(mp);
    const script = `set +e
export LC_ALL=C
_mp=${mpQ}
umount "$_mp" && echo "Unmounted $_mp" || { echo "Unmount failed" >&2; exit 1; }
`;
    if (args.dryRun) return dryRunResult("ssh_mount", args, script, args.target);

    const result = await runSshCommand({ target: args.target, command: script, sudo, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // list
  const script = `set +e
export LC_ALL=C
echo "=== Mounted Filesystems (findmnt) ==="
findmnt --output TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%,OPTIONS 2>/dev/null || \
  mount | column -t 2>/dev/null || \
  cat /proc/mounts
`;
  if (args.dryRun) return dryRunResult("ssh_mount", args, script, args.target);

  const result = await runSshCommand({ target: args.target, command: script, sudo: false, mode: "bash" });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ─── ssh_git ─────────────────────────────────────────────────────────────────

const gitToolDef = {
  name: "ssh_git",
  title: "SSH Git Operations",
  description: "Run git operations (status, pull, fetch, log, checkout, diff) on a remote repository. pull/checkout require confirm:true.",
  inputSchema: {
    type: "object",
    required: ["action", "repoPath"],
    properties: {
      target:    { type: "string",  description: "Profile name or user@host." },
      action:    { type: "string",  enum: ["status", "pull", "fetch", "log", "checkout", "diff"], description: "Git action to perform." },
      repoPath:  { type: "string",  description: "Absolute path to git repository on remote." },
      branch:    { type: "string",  description: "Branch name for checkout/pull." },
      remote:    { type: "string",  description: "Remote name, default \"origin\"." },
      logLines:  { type: "number",  description: "Lines for log action, default 10." },
      sudo:      { type: "boolean", description: "Run with sudo." },
      confirm:   { type: "boolean", description: "Required for pull/checkout." },
      dryRun:    { type: "boolean", description: "Preview only, do not execute." },
      reason:    { type: "string",  description: "Reason for the operation." }
    }
  }
};

async function handleGit(args) {
  const VALID_ACTIONS = ["status", "pull", "fetch", "log", "checkout", "diff"];
  const action = String(args.action || "");
  if (!VALID_ACTIONS.includes(action)) {
    return textResult(`ssh_git: invalid action "${action}". Must be one of: ${VALID_ACTIONS.join(", ")}`, true);
  }

  if (action === "pull" || action === "checkout") {
    if (!args.confirm) return requireConfirm("ssh_git", args);
  }

  const repoPath = String(args.repoPath || "");
  if (!isAbsNoTraversal(repoPath)) {
    return textResult(`ssh_git: repoPath must be absolute with no .. segments: ${repoPath}`, true);
  }
  if (hasControlChars(repoPath)) return textResult("ssh_git: repoPath contains control characters", true);

  if (args.branch !== undefined) {
    const branch = String(args.branch);
    if (!/^[a-zA-Z0-9._\/-]+$/.test(branch)) {
      return textResult(`ssh_git: invalid branch name "${branch}"`, true);
    }
  }

  const remote = args.remote !== undefined ? String(args.remote) : "origin";
  if (!/^[a-zA-Z0-9._-]+$/.test(remote)) {
    return textResult(`ssh_git: invalid remote name "${remote}"`, true);
  }

  if (args.logLines !== undefined) {
    const ll = args.logLines;
    if (!Number.isInteger(ll) || ll < 1 || ll > 500) {
      return textResult("ssh_git: logLines must be an integer between 1 and 500", true);
    }
  }
  const logLines = Number.isInteger(args.logLines) ? args.logLines : 10;

  const repoQ  = JSON.stringify(repoPath);
  const remoteQ = JSON.stringify(remote);

  let actionScript;
  if (action === "status") {
    actionScript = `git status --short && echo "" && git log --oneline -5`;
  } else if (action === "pull") {
    const branchPart = args.branch ? ` ${JSON.stringify(String(args.branch))}` : "";
    actionScript = `git pull ${remoteQ}${branchPart}`;
  } else if (action === "fetch") {
    actionScript = `git fetch ${remoteQ} --prune`;
  } else if (action === "log") {
    actionScript = `git log --oneline -${logLines} --graph --decorate`;
  } else if (action === "checkout") {
    const branch = String(args.branch || "");
    if (!branch) return textResult("ssh_git: branch is required for checkout", true);
    actionScript = `git checkout ${JSON.stringify(branch)}`;
  } else if (action === "diff") {
    actionScript = `git diff --stat HEAD`;
  }

  const script = `set +e
export LC_ALL=C
_repo=${repoQ}

if [ ! -d "$_repo/.git" ] && [ ! -f "$_repo/HEAD" ]; then
  echo "Not a git repository: $_repo" >&2; exit 1
fi

cd "$_repo" || { echo "Cannot cd to $_repo" >&2; exit 1; }
${actionScript}
`;

  if (args.dryRun) return dryRunResult("ssh_git", args, script, args.target);

  const result = await runSshCommand({ target: args.target, command: script, sudo: Boolean(args.sudo), mode: "bash" });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ─── ssh_backup ──────────────────────────────────────────────────────────────

const backupToolDef = {
  name: "ssh_backup",
  title: "SSH Backup Management",
  description: "Create, list, or prune tar.gz backups on a remote host. create/restore/prune require confirm:true.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      target:      { type: "string",  description: "Profile name or user@host." },
      action:      { type: "string",  enum: ["create", "list", "restore", "prune"], description: "Backup operation." },
      source:      { type: "string",  description: "Absolute path to back up. Required for create." },
      dest:        { type: "string",  description: "Backup directory, default /var/backups/ssh-ops." },
      backupFile:  { type: "string",  description: "Specific backup filename to restore. Required for restore." },
      restoreTo:   { type: "string",  description: "Restore destination directory, default /tmp/ssh-ops-restore." },
      maxCount:    { type: "number",  description: "Max backups to keep for prune, default 5." },
      sudo:        { type: "boolean", description: "Run with sudo (default false)." },
      confirm:     { type: "boolean", description: "Required for create/restore/prune." },
      dryRun:      { type: "boolean", description: "Preview only, do not execute." },
      reason:      { type: "string",  description: "Reason for the operation." }
    }
  }
};

async function handleBackup(args) {
  const VALID_ACTIONS = ["create", "list", "restore", "prune"];
  const action = String(args.action || "");
  if (!VALID_ACTIONS.includes(action)) {
    return textResult(`ssh_backup: invalid action "${action}". Must be one of: ${VALID_ACTIONS.join(", ")}`, true);
  }

  const MUTATING = ["create", "restore", "prune"];
  if (MUTATING.includes(action) && !args.confirm) {
    return requireConfirm("ssh_backup", args);
  }

  const dest = args.dest ? String(args.dest) : "/var/backups/ssh-ops";
  if (!isAbsNoTraversal(dest)) {
    return textResult(`ssh_backup: dest must be absolute with no .. segments: ${dest}`, true);
  }
  if (hasControlChars(dest)) return textResult("ssh_backup: dest contains control characters", true);

  const sudo = Boolean(args.sudo);

  if (action === "create") {
    const source = String(args.source || "");
    if (!source) return textResult("ssh_backup: source is required for create", true);
    if (!isAbsNoTraversal(source)) {
      return textResult(`ssh_backup: source must be absolute with no .. segments: ${source}`, true);
    }
    if (hasControlChars(source)) return textResult("ssh_backup: source contains control characters", true);

    const srcQ  = JSON.stringify(source);
    const destQ = JSON.stringify(dest);

    const script = `set +e
export LC_ALL=C
_src=${srcQ}
_dest=${destQ}
_ts=$(date +%Y%m%d-%H%M%S)
_host=$(hostname -s 2>/dev/null || hostname)
_file="$_dest/ssh-ops-backup-$_host-$_ts.tar.gz"

mkdir -p "$_dest"
echo "Creating backup: $_file"
tar czf "$_file" "$_src" 2>&1
if [ $? -eq 0 ]; then
  _size=$(du -sh "$_file" 2>/dev/null | cut -f1)
  echo "Backup created: $_file ($_size)"
else
  echo "Backup failed" >&2; exit 1
fi
`;
    if (args.dryRun) return dryRunResult("ssh_backup", args, script, args.target);

    const result = await runSshCommand({ target: args.target, command: script, sudo, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (action === "list") {
    const destQ = JSON.stringify(dest);
    const script = `set +e
export LC_ALL=C
_dest=${destQ}
echo "=== Backups in $_dest ==="
ls -lhS "$_dest"/*.tar.gz 2>/dev/null || echo "(no backups found)"
echo ""
echo "Total:"
du -sh "$_dest" 2>/dev/null | cut -f1
`;
    if (args.dryRun) return dryRunResult("ssh_backup", args, script, args.target);

    const result = await runSshCommand({ target: args.target, command: script, sudo, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (action === "restore") {
    const backupFile = String(args.backupFile || "");
    if (!backupFile) return textResult("ssh_backup: backupFile is required for restore", true);
    if (!/^[a-zA-Z0-9._-]+$/.test(backupFile)) {
      return textResult(`ssh_backup: backupFile must contain only alphanumeric, dot, underscore, hyphen characters: ${backupFile}`, true);
    }
    if (hasControlChars(backupFile)) return textResult("ssh_backup: backupFile contains control characters", true);

    const restoreTo = args.restoreTo ? String(args.restoreTo) : "/tmp/ssh-ops-restore";
    if (!isAbsNoTraversal(restoreTo)) {
      return textResult(`ssh_backup: restoreTo must be absolute with no .. segments: ${restoreTo}`, true);
    }
    if (hasControlChars(restoreTo)) return textResult("ssh_backup: restoreTo contains control characters", true);

    const destQ      = JSON.stringify(dest);
    const restoreToQ = JSON.stringify(restoreTo);
    // backupFile is validated to alphanumeric+._- only — safe for direct interpolation
    const script = `set +e
export LC_ALL=C
_dest=${destQ}
_file="$_dest/${backupFile}"
_to=${restoreToQ}

[ ! -f "$_file" ] && { echo "Backup not found: $_file" >&2; exit 1; }
mkdir -p "$_to"
echo "Restoring $_file to $_to"
tar xzf "$_file" -C "$_to" 2>&1 && echo "Restore complete: $_to"
`;
    if (args.dryRun) return dryRunResult("ssh_backup", args, script, args.target);

    const result = await runSshCommand({ target: args.target, command: script, sudo, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // prune
  const maxCount = args.maxCount !== undefined ? args.maxCount : 5;
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 100) {
    return textResult("ssh_backup: maxCount must be an integer between 1 and 100", true);
  }

  const destQ = JSON.stringify(dest);
  const script = `set +e
export LC_ALL=C
_dest=${destQ}
_max=${maxCount}

_count=$(ls "$_dest"/*.tar.gz 2>/dev/null | wc -l)
echo "Found $_count backups, keeping last $_max"
ls -t "$_dest"/*.tar.gz 2>/dev/null | tail -n +$((_max + 1)) | while read f; do
  echo "Removing: $f"
  rm -f "$f"
done
echo "Done. Remaining:"
ls -lh "$_dest"/*.tar.gz 2>/dev/null | wc -l | xargs echo "backups:"
`;
  if (args.dryRun) return dryRunResult("ssh_backup", args, script, args.target);

  const result = await runSshCommand({ target: args.target, command: script, sudo, mode: "bash" });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export const toolDefs = [mountToolDef, gitToolDef, backupToolDef];

export async function handleTool(name, args) {
  if (name === "ssh_mount")  return handleMount(args);
  if (name === "ssh_git")    return handleGit(args);
  if (name === "ssh_backup") return handleBackup(args);
  return null;
}
