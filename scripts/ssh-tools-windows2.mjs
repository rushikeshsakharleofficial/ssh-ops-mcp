// ssh-tools-windows2.mjs — Windows tools: ssh_win_wsl, ssh_win_iis
import { runSshCommand, formatRunResult, psQuote } from "./ssh-core.mjs";

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function dryRunResult(toolName, args, command, target) {
  return textResult(JSON.stringify({
    dryRun: true,
    tool: toolName,
    target: target || args.target || args.host || "(default)",
    command: command || null,
    note: "dryRun:true — nothing executed"
  }, null, 2));
}

function requireConfirm(toolName, args) {
  const r = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${r}`, true);
}

function validateDistroOrSiteName(name) {
  return typeof name === "string" && /^[a-zA-Z0-9._\s-]+$/.test(name) && name.length > 0 && name.length <= 256;
}

function validateWslCommand(cmd) {
  return typeof cmd === "string" && !/[\r\n\x00`]/.test(cmd);
}

const IIS_PREAMBLE = `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# Check IIS/WebAdministration availability
if (-not (Get-Module -ListAvailable -Name WebAdministration)) {
  Write-Error "WebAdministration module not found. Install IIS: Enable-WindowsOptionalFeature -Online -FeatureName IIS-WebServerRole"
  exit 1
}
Import-Module WebAdministration -ErrorAction Stop
`;

export const toolDefs = [
  {
    name: "ssh_win_wsl",
    title: "SSH Windows WSL Management",
    description: "Manage Windows Subsystem for Linux (WSL) distros on a Windows server. list/status are read-only; install/unregister/set-default/run require confirm.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target: { type: "string", description: "Profile name or user@host" },
        action: { type: "string", enum: ["list", "status", "run", "set-default", "terminate", "unregister", "export", "import"] },
        distro: { type: "string", description: "WSL distro name for distro-specific actions" },
        command: { type: "string", description: "Command to run inside WSL (for run action)" },
        exportPath: { type: "string", description: "Windows path for export (e.g. C:\\wsl-backup\\ubuntu.tar)" },
        importPath: { type: "string", description: "Path to tar file for import" },
        installPath: { type: "string", description: "Installation directory for import" },
        confirm: { type: "boolean", description: "Required for set-default/terminate/unregister/export/import" },
        dryRun: { type: "boolean" },
        reason: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_iis",
    title: "SSH Windows IIS Management",
    description: "Manage IIS websites and application pools on Windows. Requires WebAdministration PowerShell module (included with IIS). Returns helpful error if IIS not installed.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target: { type: "string", description: "Profile name or user@host" },
        action: { type: "string", enum: ["list", "status", "start", "stop", "restart", "list-pools", "start-pool", "stop-pool", "recycle-pool", "list-bindings"] },
        site: { type: "string", description: "IIS site name for site-specific actions" },
        pool: { type: "string", description: "App pool name for pool actions" },
        sudo: { type: "boolean", default: false, description: "IIS cmdlets run as current user" },
        confirm: { type: "boolean", description: "Required for start/stop/restart/start-pool/stop-pool/recycle-pool" },
        dryRun: { type: "boolean" },
        reason: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  }
];

export async function handleTool(name, args) {
  const timeout = args.timeoutMs || 60_000;

  // ── Tool 1: ssh_win_wsl ───────────────────────────────────────────────────
  if (name === "ssh_win_wsl") {
    const { action, distro, command: wslCommand, exportPath, importPath, installPath, confirm, dryRun } = args;
    const mutating = ["set-default", "terminate", "unregister", "export", "import"].includes(action);

    if (action !== "list") {
      if (action !== "run" || distro != null) {
        if (distro != null && !validateDistroOrSiteName(distro)) {
          return textResult(`Invalid distro name: ${JSON.stringify(distro)}. Must match /^[a-zA-Z0-9._\\s-]+$/.`, true);
        }
      }
    }

    let psScript;

    if (action === "list") {
      psScript = `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Write-Output "=== Installed WSL Distros ==="
wsl --list --verbose 2>&1
Write-Output ""
Write-Output "=== WSL Version ==="
wsl --version 2>&1
Write-Output ""
Write-Output "=== WSL Status ==="
wsl --status 2>&1`;

    } else if (action === "status") {
      if (!distro) return textResult("status requires distro.", true);
      psScript = `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$distro = ${psQuote(distro)}
Write-Output "=== WSL Distro: $distro ==="
wsl --list --verbose 2>&1 | Where-Object { $_ -match $distro }
Write-Output ""
Write-Output "=== Running Processes in $distro ==="
wsl -d $distro -- ps aux 2>&1 | Select-Object -First 20`;

    } else if (action === "run") {
      if (!distro) return textResult("run requires distro.", true);
      if (!wslCommand) return textResult("run requires command.", true);
      if (!validateWslCommand(wslCommand)) {
        return textResult("Invalid command: must not contain \\r, \\n, \\x00, or backticks.", true);
      }
      psScript = `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$distro = ${psQuote(distro)}
$cmd = ${psQuote(wslCommand)}
Write-Output "Running in WSL distro: $distro"
Write-Output "Command: $cmd"
Write-Output "---"
wsl -d $distro -- bash -c $cmd 2>&1`;
      if (!confirm) return requireConfirm(name, args);

    } else if (action === "set-default") {
      if (!distro) return textResult("set-default requires distro.", true);
      psScript = `$distro = ${psQuote(distro)}
wsl --set-default $distro 2>&1
Write-Output "Default WSL distro set to: $distro"`;

    } else if (action === "terminate") {
      if (!distro) return textResult("terminate requires distro.", true);
      psScript = `$distro = ${psQuote(distro)}
wsl --terminate $distro 2>&1
Write-Output "WSL distro terminated: $distro"`;

    } else if (action === "unregister") {
      if (!distro) return textResult("unregister requires distro.", true);
      psScript = `$distro = ${psQuote(distro)}
Write-Output "WARNING: Unregistering $distro will permanently delete all data in this distro!"
wsl --unregister $distro 2>&1
Write-Output "Distro $distro unregistered"`;

    } else if (action === "export") {
      if (!distro) return textResult("export requires distro.", true);
      if (!exportPath) return textResult("export requires exportPath.", true);
      psScript = `$distro = ${psQuote(distro)}
$path = ${psQuote(exportPath)}
Write-Output "Exporting $distro to $path..."
wsl --export $distro $path 2>&1
Write-Output "Export complete: $path"`;

    } else if (action === "import") {
      if (!distro) return textResult("import requires distro.", true);
      if (!importPath) return textResult("import requires importPath.", true);
      if (!installPath) return textResult("import requires installPath.", true);
      psScript = `$distro = ${psQuote(distro)}
$ipath = ${psQuote(importPath)}
$installDir = ${psQuote(installPath)}
wsl --import $distro $installDir $ipath 2>&1
Write-Output "Imported $ipath as distro: $distro at $installDir"`;

    } else {
      return textResult(`Unknown action: ${action}`, true);
    }

    if (mutating) {
      if (dryRun) return dryRunResult(name, args, psScript);
      if (!confirm) return requireConfirm(name, args);
    }

    const result = await runSshCommand({ target: args.target, command: psScript, mode: "powershell", timeoutMs: timeout });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── Tool 2: ssh_win_iis ───────────────────────────────────────────────────
  if (name === "ssh_win_iis") {
    const { action, site, pool, confirm, dryRun } = args;
    const mutating = ["start", "stop", "restart", "start-pool", "stop-pool", "recycle-pool"].includes(action);
    const siteActions = ["status", "start", "stop", "restart"];
    const poolActions = ["start-pool", "stop-pool", "recycle-pool"];

    if (siteActions.includes(action)) {
      if (!site) return textResult(`${action} requires site.`, true);
      if (!validateDistroOrSiteName(site)) {
        return textResult(`Invalid site name: ${JSON.stringify(site)}. Must match /^[a-zA-Z0-9._\\s-]+$/.`, true);
      }
    }

    if (poolActions.includes(action)) {
      if (!pool) return textResult(`${action} requires pool.`, true);
      if (!validateDistroOrSiteName(pool)) {
        return textResult(`Invalid pool name: ${JSON.stringify(pool)}. Must match /^[a-zA-Z0-9._\\s-]+$/.`, true);
      }
    }

    let psBody;

    if (action === "list") {
      psBody = `Get-Website | Select-Object Name, State, PhysicalPath, @{n='Bindings';e={$_.Bindings.Collection | ForEach-Object {"$($_.Protocol)://$($_.bindingInformation)"}}} | Format-Table -Wrap`;
    } else if (action === "status") {
      psBody = `Get-Website -Name ${psQuote(site)} | Format-List; Get-WebApplication -Site ${psQuote(site)} | Format-Table`;
    } else if (action === "start") {
      psBody = `Start-Website -Name ${psQuote(site)}; Get-Website -Name ${psQuote(site)} | Select-Object Name, State`;
    } else if (action === "stop") {
      psBody = `Stop-Website -Name ${psQuote(site)}; Get-Website -Name ${psQuote(site)} | Select-Object Name, State`;
    } else if (action === "restart") {
      psBody = `Stop-Website -Name ${psQuote(site)}; Start-Website -Name ${psQuote(site)}; Get-Website -Name ${psQuote(site)} | Select-Object Name, State`;
    } else if (action === "list-pools") {
      psBody = `Get-WebConfiguration /system.applicationHost/applicationPools/add | Select-Object name, state, managedRuntimeVersion, startMode | Format-Table`;
    } else if (action === "start-pool") {
      psBody = `Start-WebAppPool -Name ${psQuote(pool)}; Get-WebAppPoolState -Name ${psQuote(pool)}`;
    } else if (action === "stop-pool") {
      psBody = `Stop-WebAppPool -Name ${psQuote(pool)}; Get-WebAppPoolState -Name ${psQuote(pool)}`;
    } else if (action === "recycle-pool") {
      psBody = `Restart-WebAppPool -Name ${psQuote(pool)}; Write-Output "App pool recycled: ${psQuote(pool)}"`;
    } else if (action === "list-bindings") {
      psBody = `Get-WebBinding | Select-Object protocol, bindingInformation, sslFlags | Format-Table`;
    } else {
      return textResult(`Unknown action: ${action}`, true);
    }

    const psScript = IIS_PREAMBLE + psBody;

    if (mutating) {
      if (dryRun) return dryRunResult(name, args, psScript);
      if (!confirm) return requireConfirm(name, args);
    }

    const result = await runSshCommand({ target: args.target, command: psScript, mode: "powershell", timeoutMs: timeout });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  return null;
}
