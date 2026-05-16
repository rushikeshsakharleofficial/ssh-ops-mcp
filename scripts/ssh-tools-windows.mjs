// ssh-tools-windows.mjs — Windows/PowerShell tools for ssh-ops
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

function validateWinServiceName(name) {
  return typeof name === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(name);
}

function validateRegPath(path) {
  return typeof path === "string" &&
    /^HK(LM|CU|CR|U|CC):/.test(path) &&
    !path.includes("..") &&
    !/[\r\n\x00]/.test(path);
}

function validateFirewallRuleName(name) {
  return typeof name === "string" && !/[;&|><\r\n\x00]/.test(name) && name.length > 0 && name.length <= 256;
}

function validateUsername(name) {
  return typeof name === "string" &&
    /^[A-Za-z][A-Za-z0-9_.\s-]{0,19}$/.test(name) &&
    !/[\\/:*?"<>|]/.test(name);
}

function validateIpAddress(ip) {
  return typeof ip === "string" && /^[0-9.]+$/.test(ip);
}

function validateWinPath(p) {
  return typeof p === "string" && !p.includes("..") && !/[\r\n\x00]/.test(p);
}

const WIN_INVENTORY_PS = `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Write-Output "=== OS ==="
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture, BuildNumber, LastBootUpTime, TotalVisibleMemorySize, FreePhysicalMemory | Format-List
Write-Output ""
Write-Output "=== Computer ==="
Get-CimInstance Win32_ComputerSystem | Select-Object Name, Manufacturer, Model, TotalPhysicalMemory, NumberOfProcessors, NumberOfLogicalProcessors | Format-List
Write-Output ""
Write-Output "=== CPU ==="
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, LoadPercentage | Format-Table
Write-Output ""
Write-Output "=== Disks ==="
Get-CimInstance Win32_DiskDrive | Select-Object DeviceID, Model, Size, Status | Format-Table
Write-Output ""
Write-Output "=== Volumes ==="
Get-PSDrive -PSProvider FileSystem | Select-Object Name, Used, Free, Root | Format-Table
Write-Output ""
Write-Output "=== Network Adapters ==="
Get-NetAdapter | Select-Object Name, Status, MacAddress, LinkSpeed | Format-Table
Write-Output ""
Write-Output "=== IP Addresses ==="
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -ne 'WellKnown' } | Select-Object InterfaceAlias, IPAddress, PrefixLength | Format-Table`;

const WIN_HEALTH_PS = `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Write-Output "=== System Uptime ==="
$os = Get-CimInstance Win32_OperatingSystem
$uptime = (Get-Date) - $os.LastBootUpTime
"Uptime: {0}d {1}h {2}m" -f $uptime.Days, $uptime.Hours, $uptime.Minutes

Write-Output ""
Write-Output "=== Memory ==="
$total = $os.TotalVisibleMemorySize
$free = $os.FreePhysicalMemory
$used = $total - $free
"Total: {0:N0} MB  Used: {1:N0} MB  Free: {2:N0} MB  ({3:N1}% used)" -f ($total/1KB), ($used/1KB), ($free/1KB), (100*$used/$total)

Write-Output ""
Write-Output "=== CPU Load ==="
(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average | ForEach-Object { "CPU: {0:N1}%" -f $_ }

Write-Output ""
Write-Output "=== Disk Usage ==="
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -gt 0 } | ForEach-Object {
  $pct = if ($_.Used + $_.Free -gt 0) { 100 * $_.Used / ($_.Used + $_.Free) } else { 0 }
  "{0}: Used {1:N1} GB / {2:N1} GB ({3:N1}%)" -f $_.Name, ($_.Used/1GB), (($_.Used+$_.Free)/1GB), $pct
}

Write-Output ""
Write-Output "=== Stopped Services (Auto-start) ==="
Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } | Select-Object Name, Status | Format-Table

Write-Output ""
Write-Output "=== Recent Error Events (last 20) ==="
Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2; StartTime=(Get-Date).AddHours(-24)} -MaxEvents 20 -ErrorAction SilentlyContinue | Select-Object TimeCreated, Id, Message | Format-Table -Wrap`;

const WIN_DISK_PS = `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Write-Output "=== Drives (PSDrive) ==="
Get-PSDrive -PSProvider FileSystem | Select-Object Name, Root, Used, Free | Format-Table

Write-Output ""
Write-Output "=== Volumes ==="
Get-Volume | Select-Object DriveLetter, FileSystemLabel, FileSystem, SizeRemaining, Size, HealthStatus, DriveType | Format-Table

Write-Output ""
Write-Output "=== Physical Disks ==="
Get-PhysicalDisk | Select-Object DeviceId, FriendlyName, MediaType, Size, HealthStatus, OperationalStatus | Format-Table`;

const WIN_METRICS_PS = `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
$memTotal = $os.TotalVisibleMemorySize / 1KB
$memFree = $os.FreePhysicalMemory / 1KB
$memUsed = $memTotal - $memFree
$memPct = if ($memTotal -gt 0) { 100 * $memUsed / $memTotal } else { 0 }
$uptime = ((Get-Date) - $os.LastBootUpTime).TotalSeconds
$procs = (Get-Process).Count
[PSCustomObject]@{cpuPercent=[math]::Round($cpu,1);memPercent=[math]::Round($memPct,1);memUsedMB=[math]::Round($memUsed,0);memTotalMB=[math]::Round($memTotal,0);uptimeSeconds=[math]::Round($uptime,0);processCount=$procs} | ConvertTo-Json -Compress`;

export const toolDefs = [
  {
    name: "ssh_win_inventory",
    title: "SSH Windows Inventory",
    description: "Hardware and OS inventory for a Windows server via PowerShell: OS, CPU, RAM, disks, network adapters.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host" },
        timeoutMs: { type: "number" },
        includeSudo: { type: "boolean", description: "Ignored (compat)" }
      }
    }
  },
  {
    name: "ssh_win_health",
    title: "SSH Windows Health Report",
    description: "Windows server health: CPU usage, memory, disk pressure, failed services, recent error events.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_disk",
    title: "SSH Windows Disk Report",
    description: "Disk usage, volumes, and physical disk status on a Windows server.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_metrics",
    title: "SSH Windows Metrics",
    description: "Structured Windows performance metrics: CPU%, memory%, disk usage, uptime, process count.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_service",
    title: "SSH Windows Service Management",
    description: "Manage Windows services: list, status, start, stop, restart, enable, disable. Mutating actions require confirm:true.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target: { type: "string" },
        action: { type: "string", enum: ["list", "status", "start", "stop", "restart", "enable", "disable"] },
        service: { type: "string", description: "Service name (required for non-list actions)" },
        sudo: { type: "boolean", description: "Ignored (compat)" },
        confirm: { type: "boolean" },
        dryRun: { type: "boolean" },
        reason: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_process",
    title: "SSH Windows Process Management",
    description: "List running processes or kill a process by PID or name. kill requires confirm:true.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target: { type: "string" },
        action: { type: "string", enum: ["list", "kill"] },
        pid: { type: "number" },
        processName: { type: "string" },
        signal: { type: "string", description: "Ignored on Windows" },
        filter: { type: "string", description: "String filter for list" },
        confirm: { type: "boolean" },
        reason: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_user",
    title: "SSH Windows Local User Management",
    description: "Manage Windows local user accounts: list, add, remove, info, lock, unlock, passwd.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target: { type: "string" },
        action: { type: "string", enum: ["list", "info", "add", "remove", "passwd", "lock", "unlock"] },
        username: { type: "string" },
        password: { type: "string" },
        groups: { type: "array", items: { type: "string" } },
        description: { type: "string" },
        confirm: { type: "boolean" },
        dryRun: { type: "boolean" },
        reason: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_eventlog",
    title: "SSH Windows Event Log",
    description: "Search Windows Event Log. Equivalent of journalctl for Windows.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        logName: { type: "string", default: "System" },
        level: { type: "string", enum: ["all", "error", "warning", "info"], default: "error" },
        hours: { type: "number", default: 24 },
        maxEvents: { type: "number", default: 50 },
        filter: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_schtask",
    title: "SSH Windows Scheduled Task Management",
    description: "Manage Windows Task Scheduler: list, status, register, unregister, run. Equivalent of cron for Windows.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target: { type: "string" },
        action: { type: "string", enum: ["list", "status", "register", "unregister", "run"] },
        taskName: { type: "string" },
        taskPath: { type: "string", default: "\\" },
        trigger: { type: "string", enum: ["daily", "hourly", "onstart"] },
        command: { type: "string" },
        arguments: { type: "string" },
        runAs: { type: "string" },
        confirm: { type: "boolean" },
        dryRun: { type: "boolean" },
        reason: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_firewall",
    title: "SSH Windows Firewall Management",
    description: "Manage Windows Firewall rules: list, add, remove. Uses New-NetFirewallRule.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target: { type: "string" },
        action: { type: "string", enum: ["list", "add", "remove"] },
        ruleName: { type: "string" },
        direction: { type: "string", enum: ["Inbound", "Outbound"], default: "Inbound" },
        protocol: { type: "string", enum: ["TCP", "UDP", "Any"], default: "TCP" },
        localPort: { type: "number" },
        remoteAddress: { type: "string" },
        action_fw: { type: "string", enum: ["Allow", "Block"], default: "Allow" },
        confirm: { type: "boolean" },
        dryRun: { type: "boolean" },
        reason: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_ip_assign",
    title: "SSH Windows IP Assignment",
    description: "View or set static IPv4 address on a Windows network interface.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target: { type: "string" },
        action: { type: "string", enum: ["list", "set"] },
        interfaceAlias: { type: "string" },
        ipAddress: { type: "string" },
        prefixLength: { type: "number", default: 24 },
        gateway: { type: "string" },
        dnsServers: { type: "array", items: { type: "string" } },
        confirm: { type: "boolean" },
        dryRun: { type: "boolean" },
        reason: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_acl",
    title: "SSH Windows ACL Management",
    description: "View or set file/directory ACLs (Access Control Lists) on a Windows server.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target: { type: "string" },
        action: { type: "string", enum: ["list", "set"] },
        path: { type: "string", description: "Windows path" },
        identity: { type: "string", description: "e.g. DOMAIN\\User" },
        rights: { type: "string", description: "e.g. FullControl" },
        accessType: { type: "string", enum: ["Allow", "Deny"], default: "Allow" },
        confirm: { type: "boolean" },
        dryRun: { type: "boolean" },
        reason: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ssh_win_reg",
    title: "SSH Windows Registry Management",
    description: "Read, write, or delete Windows Registry keys and values. Path must start with a valid hive (HKLM:, HKCU:, etc.).",
    inputSchema: {
      type: "object",
      required: ["action", "path"],
      properties: {
        target: { type: "string" },
        action: { type: "string", enum: ["list", "get", "set", "delete"] },
        path: { type: "string", description: "Registry path starting with HKLM:/HKCU:/HKCR:/HKU:/HKCC:" },
        name: { type: "string" },
        value: { type: "string" },
        type: { type: "string", enum: ["String", "DWord", "QWord", "Binary", "MultiString", "ExpandString"], default: "String" },
        confirm: { type: "boolean" },
        dryRun: { type: "boolean" },
        reason: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  }
];

export async function handleTool(name, args) {
  const timeout = args.timeoutMs || 60_000;

  // ── Tool 1: ssh_win_inventory ─────────────────────────────────────────────
  if (name === "ssh_win_inventory") {
    const result = await runSshCommand({ target: args.target, command: WIN_INVENTORY_PS, mode: "powershell", timeoutMs: timeout });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── Tool 2: ssh_win_health ────────────────────────────────────────────────
  if (name === "ssh_win_health") {
    const result = await runSshCommand({ target: args.target, command: WIN_HEALTH_PS, mode: "powershell", timeoutMs: timeout });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── Tool 3: ssh_win_disk ──────────────────────────────────────────────────
  if (name === "ssh_win_disk") {
    const result = await runSshCommand({ target: args.target, command: WIN_DISK_PS, mode: "powershell", timeoutMs: timeout });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── Tool 4: ssh_win_metrics ───────────────────────────────────────────────
  if (name === "ssh_win_metrics") {
    const result = await runSshCommand({ target: args.target, command: WIN_METRICS_PS, mode: "powershell", timeoutMs: timeout });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── Tool 5: ssh_win_service ───────────────────────────────────────────────
  if (name === "ssh_win_service") {
    const { action, service, confirm, dryRun } = args;
    const mutating = ["start", "stop", "restart", "enable", "disable"].includes(action);

    if (action !== "list") {
      if (!validateWinServiceName(service)) {
        return textResult(`Invalid service name: ${service}. Must match /^[A-Za-z0-9._-]{1,256}$/.`, true);
      }
    }

    let psScript;
    if (action === "list") {
      psScript = `Get-Service | Select-Object Name, DisplayName, Status, StartType | Sort-Object Name | Format-Table`;
    } else if (action === "status") {
      psScript = `Get-Service -Name ${psQuote(service)} -ErrorAction Stop | Select-Object Name, DisplayName, Status, StartType, DependentServices | Format-List`;
    } else if (action === "start") {
      psScript = `Start-Service -Name ${psQuote(service)} -ErrorAction Stop; Get-Service -Name ${psQuote(service)} | Select-Object Name, Status`;
    } else if (action === "stop") {
      psScript = `Stop-Service -Name ${psQuote(service)} -Force -ErrorAction Stop; Get-Service -Name ${psQuote(service)} | Select-Object Name, Status`;
    } else if (action === "restart") {
      psScript = `Restart-Service -Name ${psQuote(service)} -Force -ErrorAction Stop; Get-Service -Name ${psQuote(service)} | Select-Object Name, Status`;
    } else if (action === "enable") {
      psScript = `Set-Service -Name ${psQuote(service)} -StartupType Automatic -ErrorAction Stop; Write-Output "Service ${psQuote(service)} set to Automatic"`;
    } else if (action === "disable") {
      psScript = `Set-Service -Name ${psQuote(service)} -StartupType Disabled -ErrorAction Stop; Write-Output "Service ${psQuote(service)} disabled"`;
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

  // ── Tool 6: ssh_win_process ───────────────────────────────────────────────
  if (name === "ssh_win_process") {
    const { action, pid: pidVal, processName, filter, confirm } = args;

    let psScript;
    if (action === "list") {
      if (filter) {
        psScript = `Get-Process | Sort-Object CPU -Descending | Select-Object -First 50 | Select-Object Id, Name, CPU, WorkingSet, StartTime | Where-Object { $_.Name -like ${psQuote(`*${filter}*`)} } | Format-Table`;
      } else {
        psScript = `Get-Process | Sort-Object CPU -Descending | Select-Object -First 50 | Select-Object Id, Name, CPU, WorkingSet, StartTime | Format-Table`;
      }
    } else if (action === "kill") {
      if (pidVal == null && !processName) {
        return textResult("kill requires pid or processName.", true);
      }
      if (pidVal != null) {
        psScript = `Stop-Process -Id ${Number(pidVal)} -Force -ErrorAction Stop; Write-Output "Stopped PID ${Number(pidVal)}"`;
      } else {
        if (!validateWinServiceName(processName)) {
          return textResult(`Invalid processName: ${processName}`, true);
        }
        psScript = `Stop-Process -Name ${psQuote(processName)} -Force -ErrorAction Stop; Write-Output "Stopped processes matching ${psQuote(processName)}"`;
      }
      if (!confirm) return requireConfirm(name, args);
    } else {
      return textResult(`Unknown action: ${action}`, true);
    }

    const result = await runSshCommand({ target: args.target, command: psScript, mode: "powershell", timeoutMs: timeout });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── Tool 7: ssh_win_user ──────────────────────────────────────────────────
  if (name === "ssh_win_user") {
    const { action, username, password, groups, description, confirm, dryRun } = args;
    const mutating = ["add", "remove", "passwd", "lock", "unlock"].includes(action);

    if (action !== "list") {
      if (!validateUsername(username)) {
        return textResult(`Invalid username: ${JSON.stringify(username)}. Must match /^[A-Za-z][A-Za-z0-9_.\\s-]{0,19}$/ and must not contain \\/:*?"<>|`, true);
      }
    }

    let psScript;
    if (action === "list") {
      psScript = `Get-LocalUser | Select-Object Name, Enabled, LastLogon, PasswordLastSet, Description | Format-Table`;
    } else if (action === "info") {
      psScript = `Get-LocalUser -Name ${psQuote(username)} | Format-List\nGet-LocalGroup | Where-Object { (Get-LocalGroupMember $_ -ErrorAction SilentlyContinue).Name -like ${psQuote(`*${username}*`)} } | Select-Object Name`;
    } else if (action === "add") {
      const desc = description || "";
      const grpList = Array.isArray(groups) && groups.length > 0
        ? groups.map(g => psQuote(g)).join(", ")
        : null;
      psScript = `New-LocalUser -Name ${psQuote(username)} -Password (ConvertTo-SecureString ${psQuote(password || "")} -AsPlainText -Force) -FullName ${psQuote(username)} -Description ${psQuote(desc)} -ErrorAction Stop` +
        (grpList ? `\nforeach ($g in @(${grpList})) { Add-LocalGroupMember -Group $g -Member ${psQuote(username)} -ErrorAction SilentlyContinue }` : "");
    } else if (action === "remove") {
      psScript = `Remove-LocalUser -Name ${psQuote(username)} -ErrorAction Stop`;
    } else if (action === "passwd") {
      psScript = `Set-LocalUser -Name ${psQuote(username)} -Password (ConvertTo-SecureString ${psQuote(password || "")} -AsPlainText -Force) -ErrorAction Stop`;
    } else if (action === "lock") {
      psScript = `Disable-LocalUser -Name ${psQuote(username)} -ErrorAction Stop`;
    } else if (action === "unlock") {
      psScript = `Enable-LocalUser -Name ${psQuote(username)} -ErrorAction Stop`;
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

  // ── Tool 8: ssh_win_eventlog ──────────────────────────────────────────────
  if (name === "ssh_win_eventlog") {
    const logName = args.logName || "System";
    const level = args.level || "error";
    const hours = Math.min(Math.max(Number(args.hours) || 24, 1), 168);
    const maxEvents = Math.min(Math.max(Number(args.maxEvents) || 50, 1), 500);
    const filter = args.filter || null;

    let levelFilter;
    if (level === "error") {
      levelFilter = "Level=1,2";
    } else if (level === "warning") {
      levelFilter = "Level=1,2,3";
    } else if (level === "info") {
      levelFilter = "Level=1,2,3,4";
    } else {
      levelFilter = null; // all — no level filter
    }

    const filterHash = levelFilter
      ? `@{LogName=${psQuote(logName)}; StartTime=(Get-Date).AddHours(-${hours}); ${levelFilter}}`
      : `@{LogName=${psQuote(logName)}; StartTime=(Get-Date).AddHours(-${hours})}`;

    let psScript = `Get-WinEvent -FilterHashtable ${filterHash} -MaxEvents ${maxEvents} -ErrorAction SilentlyContinue | Select-Object TimeCreated, Id, LevelDisplayName, Message | Format-Table -Wrap`;

    if (filter) {
      psScript = `Get-WinEvent -FilterHashtable ${filterHash} -MaxEvents ${maxEvents} -ErrorAction SilentlyContinue | Where-Object { $_.Message -like ${psQuote(`*${filter}*`)} } | Select-Object TimeCreated, Id, LevelDisplayName, Message | Format-Table -Wrap`;
    }

    const result = await runSshCommand({ target: args.target, command: psScript, mode: "powershell", timeoutMs: timeout });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── Tool 9: ssh_win_schtask ───────────────────────────────────────────────
  if (name === "ssh_win_schtask") {
    const { action, taskName, taskPath, trigger, command: taskCommand, arguments: taskArgs, runAs, confirm, dryRun } = args;
    const mutating = ["register", "unregister"].includes(action);

    let psScript;
    if (action === "list") {
      psScript = `Get-ScheduledTask | Select-Object TaskName, TaskPath, State | Format-Table`;
    } else if (action === "status") {
      psScript = `Get-ScheduledTask -TaskName ${psQuote(taskName)} | Select-Object TaskName, State, Description | Format-List\nGet-ScheduledTaskInfo -TaskName ${psQuote(taskName)} | Select-Object LastRunTime, NextRunTime, LastTaskResult | Format-List`;
    } else if (action === "unregister") {
      psScript = `Unregister-ScheduledTask -TaskName ${psQuote(taskName)} -Confirm:$false -ErrorAction Stop`;
    } else if (action === "run") {
      psScript = `Start-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction Stop`;
    } else if (action === "register") {
      if (!taskName || !taskCommand) {
        return textResult("register requires taskName and command.", true);
      }
      let triggerPs;
      if (trigger === "daily") {
        triggerPs = `New-ScheduledTaskTrigger -Daily -At 00:00`;
      } else if (trigger === "hourly") {
        triggerPs = `New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 1) -Once -At 00:00`;
      } else if (trigger === "onstart") {
        triggerPs = `New-ScheduledTaskTrigger -AtStartup`;
      } else {
        triggerPs = `New-ScheduledTaskTrigger -Daily -At 00:00`;
      }
      const actionArgs = taskArgs ? ` -Argument ${psQuote(taskArgs)}` : "";
      const path = taskPath || "\\";
      const principal = runAs ? `-Principal (New-ScheduledTaskPrincipal -UserId ${psQuote(runAs)} -RunLevel Highest)` : "";
      psScript = `$action = New-ScheduledTaskAction -Execute ${psQuote(taskCommand)}${actionArgs}\n$trigger = ${triggerPs}\nRegister-ScheduledTask -TaskName ${psQuote(taskName)} -TaskPath ${psQuote(path)} -Action $action -Trigger $trigger ${principal} -Force`;
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

  // ── Tool 10: ssh_win_firewall ─────────────────────────────────────────────
  if (name === "ssh_win_firewall") {
    const { action, ruleName, direction, protocol, localPort, remoteAddress, action_fw, confirm, dryRun } = args;
    const mutating = ["add", "remove"].includes(action);

    if (action !== "list") {
      if (!validateFirewallRuleName(ruleName)) {
        return textResult(`Invalid ruleName: must not contain ; & | > < or control characters.`, true);
      }
    }

    let psScript;
    if (action === "list") {
      psScript = `Get-NetFirewallRule | Where-Object Enabled -eq 'True' | Select-Object Name, Direction, Action, Protocol, DisplayName | Format-Table`;
    } else if (action === "add") {
      const dir = direction || "Inbound";
      const proto = protocol || "TCP";
      const fw_action = action_fw || "Allow";
      let cmd = `New-NetFirewallRule -Name ${psQuote(ruleName)} -Direction ${dir} -Protocol ${proto} -Action ${fw_action} -Enabled True`;
      if (localPort != null) cmd += ` -LocalPort ${Number(localPort)}`;
      if (remoteAddress) cmd += ` -RemoteAddress ${psQuote(remoteAddress)}`;
      psScript = cmd;
    } else if (action === "remove") {
      psScript = `Remove-NetFirewallRule -Name ${psQuote(ruleName)} -ErrorAction Stop`;
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

  // ── Tool 11: ssh_win_ip_assign ────────────────────────────────────────────
  if (name === "ssh_win_ip_assign") {
    const { action, interfaceAlias, ipAddress, prefixLength, gateway, dnsServers, confirm, dryRun } = args;

    let psScript;
    if (action === "list") {
      psScript = `Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress, PrefixLength, AddressFamily | Format-Table\nGet-NetRoute -AddressFamily IPv4 | Where-Object DestinationPrefix -eq '0.0.0.0/0' | Select-Object InterfaceAlias, NextHop | Format-Table`;
    } else if (action === "set") {
      if (!interfaceAlias) return textResult("set requires interfaceAlias.", true);
      if (!ipAddress || !validateIpAddress(ipAddress)) return textResult(`Invalid ipAddress: ${ipAddress}`, true);
      const prefix = Number(prefixLength) || 24;
      let cmd = `New-NetIPAddress -InterfaceAlias ${psQuote(interfaceAlias)} -IPAddress ${psQuote(ipAddress)} -PrefixLength ${prefix}`;
      if (gateway) {
        if (!validateIpAddress(gateway)) return textResult(`Invalid gateway: ${gateway}`, true);
        cmd += ` -DefaultGateway ${psQuote(gateway)}`;
      }
      if (Array.isArray(dnsServers) && dnsServers.length > 0) {
        const dnsArr = dnsServers.map(d => psQuote(d)).join(", ");
        cmd += `\nSet-DnsClientServerAddress -InterfaceAlias ${psQuote(interfaceAlias)} -ServerAddresses @(${dnsArr})`;
      }
      psScript = cmd;
      if (dryRun) return dryRunResult(name, args, psScript);
      if (!confirm) return requireConfirm(name, args);
    } else {
      return textResult(`Unknown action: ${action}`, true);
    }

    const result = await runSshCommand({ target: args.target, command: psScript, mode: "powershell", timeoutMs: timeout });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── Tool 12: ssh_win_acl ──────────────────────────────────────────────────
  if (name === "ssh_win_acl") {
    const { action, path: winPath, identity, rights, accessType, confirm, dryRun } = args;

    if (!winPath || !validateWinPath(winPath)) {
      return textResult(`Invalid path: must not contain '..' or control characters.`, true);
    }

    let psScript;
    if (action === "list") {
      psScript = `Get-Acl -LiteralPath ${psQuote(winPath)} | Format-List\n(Get-Acl -LiteralPath ${psQuote(winPath)}).Access | Format-Table`;
    } else if (action === "set") {
      if (!identity) return textResult("set requires identity.", true);
      if (!rights) return textResult("set requires rights.", true);
      const aType = accessType || "Allow";
      psScript = `$acl = Get-Acl -LiteralPath ${psQuote(winPath)}\n$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(${psQuote(identity)}, ${psQuote(rights)}, 'ContainerInherit,ObjectInherit', 'None', '${aType}')\n$acl.SetAccessRule($rule)\nSet-Acl -LiteralPath ${psQuote(winPath)} -AclObject $acl\nWrite-Output "ACL updated on ${psQuote(winPath)}"`;
      if (dryRun) return dryRunResult(name, args, psScript);
      if (!confirm) return requireConfirm(name, args);
    } else {
      return textResult(`Unknown action: ${action}`, true);
    }

    const result = await runSshCommand({ target: args.target, command: psScript, mode: "powershell", timeoutMs: timeout });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  // ── Tool 13: ssh_win_reg ──────────────────────────────────────────────────
  if (name === "ssh_win_reg") {
    const { action, path: regPath, name: valueName, value, type: valueType, confirm, dryRun } = args;

    if (!validateRegPath(regPath)) {
      return textResult(`Invalid registry path: must start with HKLM:/HKCU:/HKCR:/HKU:/HKCC: and must not contain '..' or control characters.`, true);
    }

    const mutating = ["set", "delete"].includes(action);
    let psScript;

    if (action === "list") {
      psScript = `Get-ItemProperty -LiteralPath ${psQuote(regPath)} | Format-List`;
    } else if (action === "get") {
      if (!valueName) return textResult("get requires name.", true);
      psScript = `(Get-ItemProperty -LiteralPath ${psQuote(regPath)} -Name ${psQuote(valueName)} -ErrorAction Stop).${psQuote(valueName)}`;
    } else if (action === "set") {
      if (!valueName) return textResult("set requires name.", true);
      const vType = valueType || "String";
      const quotedValue = psQuote(value != null ? String(value) : "");
      psScript = `if (-not (Test-Path -LiteralPath ${psQuote(regPath)})) { New-Item -LiteralPath ${psQuote(regPath)} -Force | Out-Null }\nSet-ItemProperty -LiteralPath ${psQuote(regPath)} -Name ${psQuote(valueName)} -Value ${quotedValue} -Type ${vType}`;
    } else if (action === "delete") {
      if (!valueName) return textResult("delete requires name.", true);
      psScript = `Remove-ItemProperty -LiteralPath ${psQuote(regPath)} -Name ${psQuote(valueName)} -ErrorAction Stop`;
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

  return null;
}
