// ssh-tools-deploy2.mjs — deployment tools: ssh_deploy, ssh_rollback, ssh_rsync
import { runSshCommand, formatRunResult } from "./ssh-core.mjs";
import { spawn } from "node:child_process";

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

function validateAbsNoTraversal(p, label) {
  if (!p || typeof p !== "string") return `${label} is required.`;
  if (!p.startsWith("/")) return `${label} must be an absolute path.`;
  if (p.includes("..")) return `${label} must not contain "..".`;
  if (p.includes("\x00")) return `${label} must not contain null bytes.`;
  return null;
}

function validateServiceName(s) {
  return /^[a-zA-Z0-9@._:+-]+$/.test(s);
}

export const toolDefs = [
  {
    name: "ssh_deploy",
    title: "SSH Atomic Deployment",
    description: "Atomic deployment workflow: git pull → optional build → restart services → health check. Auto-rolls back on failure.",
    inputSchema: {
      type: "object",
      properties: {
        target:            { type: "string", description: "Profile name or user@host." },
        repoPath:          { type: "string", description: "Absolute path to git repo on remote." },
        branch:            { type: "string", description: "Git branch to pull (default: current branch)." },
        buildCmd:          { type: "string", description: "Optional command to run after pull (e.g. 'npm install && npm run build')." },
        services:          { type: "array", items: { type: "string" }, description: "Systemd services to restart after build." },
        healthCheck:       { type: "string", description: "Optional command to verify deployment (exit 0 = success)." },
        healthCheckDelay:  { type: "number", description: "Seconds to wait before health check (default 5, max 60)." },
        rollbackOnFail:    { type: "boolean", description: "Auto-rollback to previous commit on health check fail (default true)." },
        sudo:              { type: "boolean", description: "Use sudo for service restart (default false — sudo -n is always used for systemctl)." },
        confirm:           { type: "boolean", description: "Required to execute." },
        dryRun:            { type: "boolean", description: "Preview without executing." },
        reason:            { type: "string", description: "Reason for deployment (audit log)." }
      },
      required: ["repoPath", "confirm"]
    }
  },
  {
    name: "ssh_rollback",
    title: "SSH Deployment Rollback",
    description: "Restore from a backup file and restart services. Designed for use after a failed deployment.",
    inputSchema: {
      type: "object",
      properties: {
        target:      { type: "string", description: "Profile name or user@host." },
        backupDir:   { type: "string", description: "Directory containing backups (default /var/backups/ssh-ops)." },
        backupFile:  { type: "string", description: "Specific backup filename to restore (if omitted, uses latest)." },
        restoreTo:   { type: "string", description: "Required. Directory to restore backup contents to." },
        services:    { type: "array", items: { type: "string" }, description: "Services to restart after restore." },
        healthCheck: { type: "string", description: "Optional verification command." },
        sudo:        { type: "boolean", description: "Use sudo (default false)." },
        confirm:     { type: "boolean", description: "Required to execute." },
        dryRun:      { type: "boolean", description: "Preview without executing." },
        reason:      { type: "string", description: "Reason for rollback (audit log)." }
      },
      required: ["restoreTo", "confirm"]
    }
  },
  {
    name: "ssh_rsync",
    title: "SSH Rsync File Sync",
    description: "Sync files using rsync: local→remote, remote→local, or remote→remote. More powerful than scp with exclude patterns, checksums, and delta sync.",
    inputSchema: {
      type: "object",
      properties: {
        src:       { type: "string", description: "Source path (local path or profile:path or user@host:path)." },
        dst:       { type: "string", description: "Destination path (same format)." },
        exclude:   { type: "array", items: { type: "string" }, description: "Patterns to exclude (e.g. ['node_modules', '*.log'])." },
        delete:    { type: "boolean", description: "Delete files at dest not in src (DANGEROUS — requires confirm)." },
        checksum:  { type: "boolean", description: "Use checksum instead of timestamp+size for comparison." },
        bwlimit:   { type: "number", description: "Bandwidth limit in KB/s." },
        dryRun:    { type: "boolean", description: "rsync --dry-run (preview without transferring)." },
        compress:  { type: "boolean", description: "Enable compression (default true for remote sync)." },
        sudo:      { type: "boolean", description: "Use sudo (default false)." },
        confirm:   { type: "boolean", description: "Required if delete:true." },
        reason:    { type: "string", description: "Reason (audit log)." },
        timeoutMs: { type: "number", description: "Timeout in ms (default 300000)." }
      },
      required: ["src", "dst"]
    }
  }
];

export async function handleTool(name, args) {
  if (name === "ssh_deploy") {
    if (args.confirm !== true) return requireConfirm("ssh_deploy", args);

    // Validate repoPath
    const repoErr = validateAbsNoTraversal(args.repoPath, "repoPath");
    if (repoErr) return textResult(repoErr, true);

    // Validate branch
    const branch = args.branch || "";
    if (branch && !/^[a-zA-Z0-9._\/-]+$/.test(branch)) {
      return textResult("branch contains invalid characters.", true);
    }

    // Validate services
    const services = (args.services || []).map(String);
    for (const s of services) {
      if (!validateServiceName(s)) return textResult(`Invalid service name: ${JSON.stringify(s)}`, true);
    }

    // Validate healthCheckDelay
    const hcDelay = args.healthCheckDelay !== undefined ? Math.floor(Number(args.healthCheckDelay)) : 5;
    if (!Number.isFinite(hcDelay) || hcDelay < 0 || hcDelay > 60) {
      return textResult("healthCheckDelay must be an integer 0-60.", true);
    }

    const rollbackOnFail = args.rollbackOnFail !== false;

    if (args.dryRun) {
      const summary = {
        repoPath: args.repoPath,
        branch: branch || "(current)",
        buildCmd: args.buildCmd || null,
        services,
        healthCheck: args.healthCheck || null,
        healthCheckDelay: hcDelay,
        rollbackOnFail
      };
      return dryRunResult("ssh_deploy", args, JSON.stringify(summary), args.target);
    }

    // Build script using heredoc for buildCmd and healthCheck to avoid interpolation
    const repoPathQ = shellQuote(args.repoPath);
    const branchQ = branch ? shellQuote(branch) : '""';

    const serviceRestartLines = services.map(s => {
      const sq = shellQuote(s);
      return `  echo "Restarting ${s}..."; sudo -n systemctl restart ${sq} 2>&1 && echo "  OK" || echo "  FAILED"`;
    }).join("\n");

    const rollbackServiceLines = services.map(s => {
      const sq = shellQuote(s);
      return `  sudo -n systemctl restart ${sq} 2>&1 || true`;
    }).join("\n");

    // buildCmd via heredoc
    let buildCmdBlock = "";
    if (args.buildCmd) {
      buildCmdBlock = `
echo "=== Running build ==="
bash <<'__BUILDCMD_EOF__'
${args.buildCmd}
__BUILDCMD_EOF__
_build_exit=$?
if [ $_build_exit -ne 0 ]; then
  echo "Build failed (exit $_build_exit)" >&2
  if [ "${_rollbackonfail}" = "1" ] && [ -n "$_prev" ]; then
    echo "Rolling back to $_prev..."
    git checkout "$_prev"
${rollbackServiceLines ? rollbackServiceLines : "    true"}
  fi
  exit $_build_exit
fi`;
    }

    // healthCheck via heredoc
    let healthCheckBlock = "";
    if (args.healthCheck) {
      healthCheckBlock = `
echo "=== Health check (waiting ${hcDelay}s) ==="
sleep ${hcDelay}
bash <<'__HEALTHCHECK_EOF__'
${args.healthCheck}
__HEALTHCHECK_EOF__
_hc_exit=$?
if [ $_hc_exit -ne 0 ]; then
  echo "Health check FAILED (exit $_hc_exit)" >&2
  if [ "${_rollbackonfail}" = "1" ] && [ -n "$_prev" ]; then
    echo "Rolling back to $_prev..."
    git checkout "$_prev"
${rollbackServiceLines ? rollbackServiceLines : "    true"}
    echo "Rollback complete."
  fi
  exit $_hc_exit
fi
echo "Health check PASSED"`;
    } else if (hcDelay > 0) {
      healthCheckBlock = `\nsleep ${hcDelay}`;
    }

    const script = `set +e
export LC_ALL=C
_rollbackonfail=${rollbackOnFail ? "1" : "0"}
cd ${repoPathQ} || { echo "Cannot cd to ${args.repoPath}" >&2; exit 1; }
_prev=$(git rev-parse HEAD 2>/dev/null)
echo "=== Current HEAD: $_prev ==="
_branch=${branchQ}
if [ -n "$_branch" ]; then
  echo "=== Fetching and pulling branch: $_branch ==="
  git fetch 2>&1 && git pull origin "$_branch" 2>&1
else
  echo "=== Fetching and pulling current branch ==="
  git fetch 2>&1 && git pull 2>&1
fi
_pull_exit=$?
if [ $_pull_exit -ne 0 ]; then
  echo "git pull failed (exit $_pull_exit)" >&2; exit $_pull_exit
fi
_new=$(git rev-parse HEAD 2>/dev/null)
echo "=== New HEAD: $_new ==="
${buildCmdBlock}
${serviceRestartLines ? `echo "=== Restarting services ==="\n${serviceRestartLines}` : ""}
${healthCheckBlock}
echo "=== Deploy complete: $_prev -> $_new ==="
`;

    const result = await runSshCommand({
      target: args.target,
      command: script,
      mode: "bash",
      timeoutMs: 300_000
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_rollback") {
    if (args.confirm !== true) return requireConfirm("ssh_rollback", args);

    const restoreErr = validateAbsNoTraversal(args.restoreTo, "restoreTo");
    if (restoreErr) return textResult(restoreErr, true);

    const backupDir = args.backupDir || "/var/backups/ssh-ops";
    const backupDirErr = validateAbsNoTraversal(backupDir, "backupDir");
    if (backupDirErr) return textResult(backupDirErr, true);

    if (args.backupFile !== undefined && args.backupFile !== null && args.backupFile !== "") {
      if (!/^[a-zA-Z0-9._-]+$/.test(String(args.backupFile))) {
        return textResult("backupFile must be a plain filename with no slashes or special characters.", true);
      }
    }

    const services = (args.services || []).map(String);
    for (const s of services) {
      if (!validateServiceName(s)) return textResult(`Invalid service name: ${JSON.stringify(s)}`, true);
    }

    if (args.dryRun) {
      const summary = {
        backupDir,
        backupFile: args.backupFile || "(latest)",
        restoreTo: args.restoreTo,
        services,
        healthCheck: args.healthCheck || null
      };
      return dryRunResult("ssh_rollback", args, JSON.stringify(summary), args.target);
    }

    const backupDirQ = shellQuote(backupDir);
    const restoreToQ = shellQuote(args.restoreTo);

    const serviceRestartLines = services.map(s => {
      const sq = shellQuote(s);
      return `echo "Restarting ${s}..."; sudo -n systemctl restart ${sq} 2>&1 && echo "  OK" || echo "  FAILED"`;
    }).join("\n");

    let healthCheckBlock = "";
    if (args.healthCheck) {
      healthCheckBlock = `
echo "Running health check..."
sleep 3
bash <<'__ROLLBACK_HC_EOF__'
${args.healthCheck}
__ROLLBACK_HC_EOF__
_hc_exit=$?
if [ $_hc_exit -ne 0 ]; then
  echo "Health check FAILED (exit $_hc_exit)" >&2
else
  echo "Health check PASSED"
fi`;
    }

    let findBackupBlock;
    if (args.backupFile) {
      const bfQ = shellQuote(args.backupFile);
      findBackupBlock = `_backup="${backupDir}/${String(args.backupFile).replace(/'/g, "'\\''")}"`;
    } else {
      findBackupBlock = `_backup=$(ls -t ${backupDirQ}/*.tar.gz 2>/dev/null | head -1)`;
    }

    const script = `set +e
export LC_ALL=C
_backupdir=${backupDirQ}
_restoreto=${restoreToQ}
${findBackupBlock}
if [ -z "$_backup" ] || [ ! -f "$_backup" ]; then
  echo "No backup found in ${backupDir}" >&2; exit 1
fi
echo "Restoring from: $_backup"
echo "Target: $_restoreto"
mkdir -p "$_restoreto"
tar xzf "$_backup" -C "$_restoreto" 2>&1 && echo "Restore complete"
_tar_exit=$?
if [ $_tar_exit -ne 0 ]; then
  echo "tar extraction failed (exit $_tar_exit)" >&2; exit $_tar_exit
fi
${serviceRestartLines}
${healthCheckBlock}
`;

    const result = await runSshCommand({
      target: args.target,
      command: script,
      mode: "bash",
      timeoutMs: 300_000
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_rsync") {
    if (!args.src || !args.dst) return textResult("src and dst are required.", true);
    if (args.delete === true && args.confirm !== true) return requireConfirm("ssh_rsync (--delete)", args);

    const excludes = (args.exclude || []).map(e => String(e));
    for (const e of excludes) {
      if (/[\r\n\x00]/.test(e)) return textResult("exclude patterns must not contain newlines.", true);
    }

    const rsyncArgs = ["-avz", "--progress"];
    if (args.checksum) rsyncArgs.push("--checksum");
    if (args.delete) rsyncArgs.push("--delete");
    if (args.bwlimit !== undefined && args.bwlimit !== null) {
      const bw = Math.floor(Number(args.bwlimit));
      if (!Number.isFinite(bw) || bw < 1) return textResult("bwlimit must be a positive integer (KB/s).", true);
      rsyncArgs.push(`--bwlimit=${bw}`);
    }
    if (args.dryRun) rsyncArgs.push("--dry-run");
    for (const e of excludes) rsyncArgs.push(`--exclude=${e}`);
    rsyncArgs.push(String(args.src), String(args.dst));

    if (args.dryRun) {
      return textResult(`[rsync dry-run]\nrsync ${rsyncArgs.join(" ")}`);
    }

    const timeoutMs = args.timeoutMs || 300_000;
    const result = await new Promise((resolve) => {
      let stdout = "", stderr = "";
      const proc = spawn("rsync", rsyncArgs, { stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => { proc.kill(); resolve({ stdout, stderr, exitCode: 124 }); }, timeoutMs);
      proc.stdout.on("data", d => { stdout += d; });
      proc.stderr.on("data", d => { stderr += d; });
      proc.on("close", code => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code }); });
      proc.on("error", e => { clearTimeout(timer); resolve({ stdout, stderr: e.message, exitCode: 1 }); });
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "(sync complete)";
    return textResult(output, result.exitCode !== 0);
  }

  return null;
}
