#!/usr/bin/env node
import {
  addJumpServer,
  addProfile,
  chmodScript,
  cronScript,
  ipAssignScript,
  sudoRuleScript,
  userManageScript,
  listIpGroups,
  listLocalSshKeys,
  parseYamlConfig,
  removeIpGroup,
  resolveIpGroup,
  saveIpGroup,
  diskReportScript,
  filePatchScript,
  fileReadScript,
  fileWriteScript,
  formatMultiRunResult,
  formatRunResult,
  hardwareInventoryScript,
  healthReportScript,
  listJumpServers,
  listProfiles,
  resolveGroup,
  getConfig,
  logSearchScript,
  networkCheckScript,
  packageScript,
  PLUGIN_ROOT,
  removeJumpServer,
  removeProfile,
  runMultiSshCommand,
  runSshCommand,
  serviceScript
} from "./ssh-core.mjs";
import * as _netTools from "./ssh-tools-network.mjs";
import * as _obsTools from "./ssh-tools-observability.mjs";
import * as _storeTools from "./ssh-tools-storage.mjs";
import * as _advTools from "./ssh-tools-advanced.mjs";
import * as _sec2Tools from "./ssh-tools-security2.mjs";
import * as _containersTools from "./ssh-tools-containers.mjs";
import * as _dbTools from "./ssh-tools-database.mjs";
import * as _webTools from "./ssh-tools-webserver.mjs";
import * as _sys2Tools from "./ssh-tools-system2.mjs";
import * as _netutilsTools from "./ssh-tools-netutils.mjs";
import * as _perfTools from "./ssh-tools-perf.mjs";
import * as _deploy2Tools from "./ssh-tools-deploy2.mjs";
import * as _storage2Tools from "./ssh-tools-storage2.mjs";
import * as _certbotTools from "./ssh-tools-certbot.mjs";
import * as _fleetTools from "./ssh-tools-fleet.mjs";
const _extraModules = [
  _netTools, _obsTools, _storeTools, _advTools, _sec2Tools,
  _containersTools, _dbTools, _webTools, _sys2Tools, _netutilsTools,
  _perfTools, _deploy2Tools, _storage2Tools, _certbotTools, _fleetTools
];
import https from "node:https";
import net from "node:net";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve, sep as pathSep } from "node:path";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = (() => {
  try {
    return readFileSync(join(PLUGIN_ROOT, "..", "VERSION"), "utf8").trim().replace(/^v/, "");
  } catch {
    return "1.14.1";
  }
})();
const RELEASES_API = "https://api.github.com/repos/rushikeshsakharleofficial/ssh-ops-mcp/releases/latest";
const UPDATE_FILES = [
  "scripts/ssh-mcp-server.mjs",
  "scripts/ssh-core.mjs",
  "scripts/ssh-ops.mjs",
  "scripts/ssh-cli-options.mjs"
];

const ALLOWED_FETCH_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);

function httpsGetText(url, hops = 5) {
  return new Promise((resolve) => {
    if (hops <= 0) return resolve(null);
    let parsed;
    try { parsed = new URL(url); } catch { return resolve(null); }
    if (!ALLOWED_FETCH_HOSTS.has(parsed.hostname)) return resolve(null);
    const headers = { "User-Agent": "ssh-ops-mcp" };
    if (parsed.hostname === "api.github.com") {
      headers["Accept"] = "application/vnd.github+json";
    }
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGetText(res.headers.location, hops - 1));
      }
      if (res.statusCode !== 200) return resolve(null);
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body.trim()));
      res.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}

async function selfUpdate() {
  try {
    const versionPath = join(PLUGIN_ROOT, "VERSION");
    let localVersion = "";
    try { localVersion = readFileSync(versionPath, "utf8").trim(); } catch {}

    const releaseJson = await httpsGetText(RELEASES_API);
    if (!releaseJson) return;
    const { tag_name: remoteVersion } = JSON.parse(releaseJson);
    if (!remoteVersion || remoteVersion === localVersion) return;

    const rawBase = `https://raw.githubusercontent.com/rushikeshsakharleofficial/ssh-ops-mcp/${remoteVersion}`;
    for (const file of UPDATE_FILES) {
      const content = await httpsGetText(`${rawBase}/${file}`);
      if (!content) continue;
      const dest = join(PLUGIN_ROOT, ...file.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content, "utf8");
    }
    writeFileSync(versionPath, remoteVersion, "utf8");
  } catch {}
}

async function sendAlert(webhook, payload) {
  try {
    const { hostname, pathname, port, protocol } = new URL(webhook);
    if (protocol !== "https:") return;
    const body = JSON.stringify(payload);
    await new Promise((resolve) => {
      const req = https.request(
        { hostname, path: pathname, port: port || 443, method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => { res.resume(); res.on("end", resolve); }
      );
      req.on("error", resolve);
      req.write(body);
      req.end();
    });
  } catch {}
}

function parseHealthMetrics(output) {
  const metrics = {};
  const cpuMatch = output.match(/cpu[^:]*:\s*([\d.]+)%/i);
  if (cpuMatch) metrics.cpuPercent = parseFloat(cpuMatch[1]);
  const memMatch = output.match(/mem[^:]*:\s*([\d.]+)%/i) || output.match(/([\d.]+)%\s*used/i);
  if (memMatch) metrics.memPercent = parseFloat(memMatch[1]);
  const diskMatch = output.match(/disk[^:]*:\s*([\d.]+)%/i) || output.match(/([\d.]+)%\s*full/i);
  if (diskMatch) metrics.diskPercent = parseFloat(diskMatch[1]);
  return metrics;
}

const profilesTool = {
  name: "ssh_profiles",
  title: "List SSH Ops Profiles",
  description: "List configured SSH Ops profiles and the default target. Does not connect to any host.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

const allTools = [
  {
    name: "ssh_run",
    title: "Run SSH Command",
    description: "Run a command on a remote host through the local ssh binary. Reuses local SSH keys/config and optional SSH Ops profiles.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Profile name or raw SSH target such as user@example.com. Uses defaultTarget if omitted."
        },
        host: {
          type: "string",
          description: "Host/IP to connect to. Used with user when target/profile is not provided."
        },
        user: {
          type: "string",
          description: "SSH username when host is provided."
        },
        command: {
          type: "string",
          description: "Remote command or multi-line shell script to execute."
        },
        cwd: {
          type: "string",
          description: "Optional remote working directory."
        },
        sudo: {
          type: "boolean",
          description: "Run the script through sudo -n bash -s. Fails instead of prompting if sudo requires a password."
        },
        mode: {
          type: "string",
          enum: ["bash", "raw"],
          description: "bash pipes the command to bash -s. raw passes the command as the SSH remote command."
        },
        timeoutMs: {
          type: "number",
          description: "Local timeout in milliseconds."
        },
        retries: {
          type: "number",
          description: "Retry failed connections up to this many times. Default 2. Retries on SSH connection errors (exit 255, connection reset, timeout)."
        },
        retryDelayMs: {
          type: "number",
          description: "Base delay in ms between retries, multiplied by attempt number. Default 1500."
        },
        port: {
          type: "number",
          description: "SSH port override."
        },
        identityFile: {
          type: "string",
          description: "Optional identity file path."
        },
        jumpHost: {
          type: "string",
          description: "Optional SSH jump host passed as -J."
        },
        jumpProfile: {
          type: "string",
          description: "Optional profile name for a two-hop SSH command path. The plugin connects to this profile first, then runs destination SSH from there."
        },
        jumpUser: {
          type: "string",
          description: "Optional user to run the destination SSH command as on the jump server."
        },
        targetUser: {
          type: "string",
          description: "Optional username applied to destination hosts routed through a configured jump profile."
        },
        localSwitchUser: {
          type: "string",
          description: "Switch to this local user (sudo -n -u) before running SSH. Use when ssh-ops runs on a jump/bastion server and internal targets require a different local user for key access."
        },
        sshOptions: {
          type: "array",
          items: { type: "string" },
          description: "Extra ssh arguments, for example ['-o','UserKnownHostsFile=/path/file']."
        }
      },
      required: ["command"]
    }
  },
  {
    name: "ssh_inventory",
    title: "SSH Hardware Inventory",
    description: "Run a read-only Linux hardware and VM inventory over SSH: OS, CPU, RAM, DMI, disks, PCI, network, load, and service health.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Profile name or raw SSH target. Uses defaultTarget if omitted."
        },
        timeoutMs: {
          type: "number",
          description: "Local timeout in milliseconds."
        },
        includeSudo: {
          type: "boolean",
          description: "Try sudo -n for richer DMI/storage details. Defaults to true."
        }
      }
    }
  },
  {
    name: "ssh_disk_report",
    title: "SSH Disk Report",
    description: "Run a read-only disk pressure report over SSH, including df, inode usage, du, and Docker/containerd storage hints.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Profile name or raw SSH target. Uses defaultTarget if omitted."
        },
        path: {
          type: "string",
          description: "Remote path to summarize. Defaults to /."
        },
        depth: {
          type: "number",
          description: "du depth from 0 to 5. Defaults to 1."
        },
        timeoutMs: {
          type: "number",
          description: "Local timeout in milliseconds."
        }
      }
    }
  },
  {
    name: "ssh_health_report",
    title: "SSH Health Report",
    description: "Run a read-only server health snapshot over SSH: load, memory, disk, failed units, boot errors, processes, and Docker status.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Profile name or raw SSH target. Uses defaultTarget if omitted."
        },
        timeoutMs: {
          type: "number",
          description: "Local timeout in milliseconds."
        }
      }
    }
  }
  ,
  {
    name: "ssh_file_read",
    title: "Read Remote File",
    description: "Read a remote file over SSH.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        path: { type: "string", description: "Absolute remote path." },
        maxBytes: { type: "number", description: "Byte cap. Default 51200." },
        encoding: { type: "string", enum: ["text", "base64"], description: "text or base64. Default text." }
      },
      required: ["path"]
    }
  },
  {
    name: "ssh_file_write",
    title: "Write Remote File",
    description: "Overwrite a remote file. CONFIRM with user before calling unless told to proceed automatically.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        path: { type: "string", description: "Absolute remote path." },
        content: { type: "string", description: "New file content." },
        backup: { type: "boolean", description: "Backup before overwrite. Default true." },
        sudo: { type: "boolean", description: "Write via sudo tee." },
        encoding: { type: "string", enum: ["text", "base64"], description: "text or base64. Default text." },
        confirm: { type: "boolean", description: "Must be true to execute this mutating operation." },
        reason: { type: "string", description: "Optional reason for this action. Logged to audit log and shown in confirmation prompts." }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "ssh_service",
    title: "SSH Service Control",
    description: "Systemd service control. CONFIRM before start/stop/restart/enable/disable unless told automatically.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        service: { type: "string", description: "Unit name, e.g. nginx." },
        action: {
          type: "string",
          enum: ["status", "start", "stop", "restart", "enable", "disable"],
          description: "Systemd action."
        },
        sudo: { type: "boolean", description: "Run via sudo -n. Default true." },
        confirm: { type: "boolean", description: "Required true for start/stop/restart/enable/disable." },
        reason: { type: "string", description: "Optional reason for this action. Logged to audit log and shown in confirmation prompts." }
      },
      required: ["service", "action"]
    }
  },
  {
    name: "ssh_log_search",
    title: "SSH Log Search",
    description: "Search systemd journal or log file by pattern.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        unit: { type: "string", description: "journalctl -u filter." },
        pattern: { type: "string", description: "grep -E pattern." },
        lines: { type: "number", description: "Max lines. Default 100." },
        since: { type: "string", description: "Time filter, e.g. '1h'." },
        path: { type: "string", description: "Grep a file instead of journal." },
        timeoutMs: { type: "number", description: "Timeout ms. Default 60000." }
      }
    }
  },
  {
    name: "ssh_file_patch",
    title: "Patch Remote File",
    description: "Edit a remote file: replace a line range or apply a regex substitution. CONFIRM with user before calling unless told to proceed automatically.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        path: { type: "string", description: "Absolute remote path." },
        startLine: { type: "number", description: "First line to replace (1-indexed)." },
        endLine: { type: "number", description: "Last line to replace. Defaults to startLine." },
        content: { type: "string", description: "Replacement content for line range." },
        pattern: { type: "string", description: "ERE regex. Use | as sed delimiter." },
        replacement: { type: "string", description: "Sed replacement string." },
        flags: { type: "string", description: "Sed flags. Default g." },
        backup: { type: "boolean", description: "Backup before patch. Default true." },
        sudo: { type: "boolean", description: "Run mv via sudo." },
        confirm: { type: "boolean", description: "Must be true to execute this mutating operation." },
        reason: { type: "string", description: "Optional reason for this action. Logged to audit log and shown in confirmation prompts." }
      },
      required: ["path"]
    }
  },
  {
    name: "ssh_run_multi",
    title: "Run SSH Command on Multiple Hosts",
    description: "Run a command on multiple SSH targets. Batched execution (maxConcurrent, default 10) with automatic retry on connection failures (retries, default 2).",
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          description: "Profile names or user@host targets."
        },
        command: { type: "string", description: "Remote command or script." },
        format: { type: "string", enum: ["text", "json"], description: "Output format. Default text." },
        sudo: { type: "boolean", description: "Run via sudo -n on all targets." },
        mode: { type: "string", enum: ["bash", "raw"], description: "bash or raw. Default bash." },
        cwd: { type: "string", description: "Remote working directory." },
        timeoutMs: { type: "number", description: "Per-target timeout ms." },
        sshOptions: { type: "array", items: { type: "string" }, description: "Extra SSH args." },
        identityFile: { type: "string", description: "SSH identity file." },
        jumpHost: { type: "string", description: "SSH jump host (-J)." },
        maxConcurrent: {
          type: "number",
          description: "Max parallel SSH connections at once. Default 10. Use lower values (5) for large target sets to avoid overwhelming the jump server."
        },
        retries: {
          type: "number",
          description: "Retry failed connections up to this many times. Default 2. Retries on SSH connection errors (exit 255, connection reset, timeout)."
        },
        retryDelayMs: {
          type: "number",
          description: "Base delay in ms between retries, multiplied by attempt number. Default 1500."
        },
        group: { type: "string", description: "Profile group name. Runs command on all profiles with matching group field." }
      },
      required: ["command"]
    }
  },
  {
    name: "ssh_network_check",
    title: "SSH Network Check",
    description: "Check network reachability from a remote SSH server: ping, port probe, TLS cert. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        host: { type: "string", description: "Host to probe from the SSH server." },
        port: { type: "number", description: "Port to check reachability." },
        ping: { type: "boolean", description: "Run ping. Default true." },
        tls: { type: "boolean", description: "Check TLS cert. Requires port." },
        timeoutMs: { type: "number", description: "Timeout ms. Default 30000." }
      },
      required: ["host"]
    }
  },
  {
    name: "ssh_package",
    title: "SSH Package Management",
    description: "Manage packages on a remote host. Auto-detects: apt, dnf, yum, apk, pacman, zypper, xbps, snap, flatpak, pkg (FreeBSD), emerge (Gentoo), nix-env, opkg, brew. CONFIRM before install/remove/update/upgrade/autoremove.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: {
          type: "string",
          enum: ["list", "search", "info", "install", "remove", "update", "upgrade", "autoremove"],
          description: "list: installed packages. search: find packages. info: package details. install/remove: add or remove. update: refresh+upgrade specific or all. upgrade: full dist-upgrade equivalent. autoremove: remove unused deps."
        },
        packages: { type: "array", items: { type: "string" }, description: "Package names. Required for install/remove/search/info." },
        manager: { type: "string", description: "Force a specific package manager (apt/dnf/yum/apk/pacman/zypper/xbps/snap/flatpak/pkg/emerge/nix/opkg/brew). Skip auto-detection." },
        sudo: { type: "boolean", description: "Use sudo -n. Default true." },
        timeoutMs: { type: "number", description: "Timeout ms. Default 120000." },
        confirm: { type: "boolean", description: "Required true for install/remove/update/upgrade/autoremove." },
        dryRun: { type: "boolean", description: "Preview command without executing." },
        reason: { type: "string", description: "Optional reason. Logged to audit log." }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_cron",
    title: "SSH Cron Management",
    description: "Manage crontab entries on a remote host. Supports any user via sudo. CONFIRM before add/remove unless told to proceed automatically.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: { type: "string", enum: ["list", "add", "remove"], description: "Cron action." },
        user: { type: "string", description: "Crontab owner. Omit for current SSH user." },
        schedule: { type: "string", description: "Cron schedule, 5 fields (e.g. '0 * * * *'). Required for add." },
        command: { type: "string", description: "Command. Required for add/remove." },
        confirm: { type: "boolean", description: "Required true for add/remove." },
        reason: { type: "string", description: "Optional reason for this action. Logged to audit log and shown in confirmation prompts." }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_add_profile",
    title: "Add SSH Profile",
    description: "Add or update an SSH profile in the dynamic config. Passwords are stored AES-256-GCM encrypted. Supports jump server routing (jumpProfile + jumpUser) for nested SSH flows where you need to switch users on a bastion before connecting to the target.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Profile name (alphanumeric, hyphens, underscores)." },
        host: { type: "string", description: "Hostname or IP address." },
        user: { type: "string", description: "SSH username on the target host." },
        port: { type: "number", description: "SSH port. Default 22." },
        password: { type: "string", description: "SSH password. Stored encrypted. Requires sshpass on the local machine." },
        identityFile: { type: "string", description: "Path to SSH private key file." },
        access: { type: "string", enum: ["normal", "sudo"], description: "Set to sudo to prepend sudo to all commands for this profile." },
        jumpProfile: { type: "string", description: "Profile name of the jump/bastion server to connect through first." },
        jumpUser: { type: "string", description: "User to switch to on the jump server (via sudo -n -u) before running the destination SSH. Use when keys for this target live on the jump server under a different user." },
        targetUser: { type: "string", description: "Override the destination SSH username when routing through a jumpProfile." },
        localSwitchUser: { type: "string", description: "Switch to this local user (via sudo -n -u) before running SSH. Use when ssh-ops is running on a jump/bastion server and internal targets require a different local user for key access." },
        extraArgs: { type: "array", items: { type: "string" }, description: "Extra SSH arguments." }
      },
      required: ["name", "host"]
    }
  },
  {
    name: "ssh_remove_profile",
    title: "Remove SSH Profile",
    description: "Remove a dynamically-added SSH profile. Only profiles added via ssh_add_profile can be removed this way.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Profile name to remove." }
      },
      required: ["name"]
    }
  },
  {
    name: "ssh_add_jump",
    title: "Add Jump Server",
    description: "Add a jump/bastion server and append it to the active jump chain. All subsequent SSH commands route through the chain using SSH -J multi-hop. Set commonUser to use a shared login name for all target connections without needing to specify user per profile.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Jump server name (alphanumeric, hyphens, underscores)." },
        host: { type: "string", description: "Hostname or IP of the jump server." },
        user: { type: "string", description: "SSH username on the jump server." },
        port: { type: "number", description: "SSH port on the jump server. Default 22." },
        password: { type: "string", description: "SSH password (stored AES-256-GCM encrypted). Requires sshpass locally." },
        identityFile: { type: "string", description: "Path to SSH private key for this jump server." },
        appendToChain: { type: "boolean", description: "Append to the active jump chain. Default true." },
        commonUser: { type: "string", description: "Set a shared default user for ALL target connections that have no explicit user defined (e.g. 'deploy', 'ubuntu'). Stored in dynamic config defaults." }
      },
      required: ["name", "host"]
    }
  },
  {
    name: "ssh_remove_jump",
    title: "Remove Jump Server",
    description: "Remove a jump server and automatically remove it from the jump chain. Only MCP-added jump servers can be removed this way.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Jump server name to remove." }
      },
      required: ["name"]
    }
  },
  {
    name: "ssh_list_jumps",
    title: "List Jump Servers",
    description: "Show the current jump chain, all configured jump servers, and the commonUser default. Does not connect to any host.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "ssh_list_keys",
    title: "List Local SSH Keys",
    description: "List SSH private key files found in ~/.ssh/ and home directory. Use to identify which identityFile to specify when adding a profile or jump server, or when the default key stopped working.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "ssh_ip_assign",
    title: "Assign IP Addresses",
    description: "Assign one or more IP addresses to a network interface on a remote host. Applies immediately via `ip addr add` AND persists across reboots. Auto-detects the network manager (netplan → NetworkManager → network-scripts → systemd-networkd → rc.local) or override with `method`. Accept ips array, a named group (group param), or a local JSON/YAML file (fromFile param). Always runs as sudo. CONFIRM with user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        iface: { type: "string", description: "Network interface name, e.g. eth0, ens3, enp0s3. Can be omitted when group or fromFile defines it." },
        ips: {
          type: "array",
          items: { type: "string" },
          description: "IP addresses in CIDR notation. Mutually exclusive with group/fromFile."
        },
        group: { type: "string", description: "Name of a saved IP group (from ssh_save_ip_group). Resolves ips, iface, gateway, dns from the group." },
        fromFile: { type: "string", description: "Path to a local JSON or YAML file containing {iface, ips, gateway?, dns?}. Loaded by the MCP server before running." },
        gateway: { type: "string", description: "Optional default gateway IP. Overrides group/file value." },
        dns: {
          type: "array",
          items: { type: "string" },
          description: "Optional DNS server IPs. Overrides group/file value."
        },
        method: {
          type: "string",
          enum: ["auto", "netplan", "networkmanager", "network-scripts", "networkd", "rc.local"],
          description: "Persistence method. Default auto-detects from the running system."
        },
        timeoutMs: { type: "number", description: "Timeout ms. Default 60000." },
        confirm: { type: "boolean", description: "Must be true to execute this mutating operation." },
        reason: { type: "string", description: "Optional reason for this action. Logged to audit log and shown in confirmation prompts." }
      }
    }
  },
  {
    name: "ssh_save_ip_group",
    title: "Save IP Group",
    description: "Save a named set of IPs (with optional iface, gateway, dns) to the dynamic config. Reference it later with ssh_ip_assign(group='name') instead of repeating the IP list every time.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Group name (alphanumeric, hyphens, underscores)." },
        ips: { type: "array", items: { type: "string" }, description: "IP addresses in CIDR notation." },
        iface: { type: "string", description: "Default interface for this group." },
        gateway: { type: "string", description: "Default gateway." },
        dns: { type: "array", items: { type: "string" }, description: "Default DNS servers." }
      },
      required: ["name", "ips"]
    }
  },
  {
    name: "ssh_remove_ip_group",
    title: "Remove IP Group",
    description: "Remove a saved IP group from the dynamic config.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Group name to remove." }
      },
      required: ["name"]
    }
  },
  {
    name: "ssh_list_ip_groups",
    title: "List IP Groups",
    description: "List all saved IP groups and their contents. Does not connect to any host.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "ssh_user",
    title: "SSH User Management",
    description: "Manage Linux users on a remote host — add, delete, modify, list, show info, change password, lock, or unlock. CONFIRM before add/del/mod/passwd unless told to proceed automatically.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: {
          type: "string",
          enum: ["add", "del", "mod", "list", "info", "passwd", "lock", "unlock"],
          description: "User action."
        },
        username: { type: "string", description: "Target username. Required for all actions except list." },
        password: { type: "string", description: "Password (plain text, set via chpasswd). Required for passwd action." },
        groups: { type: "array", items: { type: "string" }, description: "Groups to add the user to (appended, not replaced)." },
        shell: { type: "string", description: "Login shell, e.g. /bin/bash." },
        homeDir: { type: "string", description: "Custom home directory path." },
        comment: { type: "string", description: "GECOS comment field (full name etc.)." },
        system: { type: "boolean", description: "Create as system user (no home, UID < 1000)." },
        createHome: { type: "boolean", description: "Create home directory on add (default true)." },
        removeHome: { type: "boolean", description: "Remove home directory and mail spool on del (default false)." },
        sudo: { type: "boolean", description: "Run via sudo. Default true for this tool." },
        confirm: { type: "boolean", description: "Required true for add/del/mod/passwd/lock/unlock." },
        reason: { type: "string", description: "Optional reason for this action. Logged to audit log and shown in confirmation prompts." }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_chmod",
    title: "SSH Permissions",
    description: "Change file/directory permissions (chmod), owner (chown), or group (chgrp) on a remote host. Provide mode for chmod, owner for chown, group for chgrp — any combination. CONFIRM before calling unless told to proceed automatically.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        path: { type: "string", description: "Absolute remote path (required)." },
        mode: { type: "string", description: "Permission mode, e.g. 755, 644, u+x, g-w." },
        owner: { type: "string", description: "Owner username to set." },
        group: { type: "string", description: "Group name to set." },
        recursive: { type: "boolean", description: "Apply recursively (-R). Default false." },
        sudo: { type: "boolean", description: "Run via sudo. Default false." },
        confirm: { type: "boolean", description: "Must be true to execute this mutating operation." },
        reason: { type: "string", description: "Optional reason for this action. Logged to audit log and shown in confirmation prompts." }
      },
      required: ["path"]
    }
  },
  {
    name: "ssh_sudo_rule",
    title: "SSH Sudoers Management",
    description: "Add, remove, or list sudoers rules on a remote host. Writes to /etc/sudoers.d/ and validates with visudo -c before accepting. CONFIRM before add/remove unless told to proceed automatically.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: {
          type: "string",
          enum: ["list", "add", "remove"],
          description: "Sudoers action."
        },
        username: { type: "string", description: "Username to grant/revoke sudo access. Required for add/remove." },
        commands: { type: "string", description: "Allowed commands. Default ALL." },
        runas: { type: "string", description: "Run-as spec. Default ALL:ALL." },
        nopasswd: { type: "boolean", description: "Add NOPASSWD flag (no password prompt). Default true." },
        ruleFile: { type: "string", description: "Custom sudoers.d file path. Default /etc/sudoers.d/<username>." },
        confirm: { type: "boolean", description: "Required true for add/remove." },
        reason: { type: "string", description: "Optional reason for this action. Logged to audit log and shown in confirmation prompts." }
      },
      required: ["action"]
    }
  }
  ,{
    name: "ssh_ping",
    title: "SSH Ping (TCP Check)",
    description: "Check TCP reachability of a profile's host:port without authenticating. Returns latency in ms and open/closed status. Use to verify connectivity before SSH operations.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host or host." },
        host: { type: "string", description: "Hostname or IP. Used if target not provided." },
        port: { type: "number", description: "Port to check. Defaults to profile port or 22." },
        timeoutMs: { type: "number", description: "Connect timeout in ms. Default 5000." },
        count: { type: "number", description: "Number of ping attempts. Default 3." }
      }
    }
  }
  ,{
    name: "ssh_diff",
    title: "SSH File Diff",
    description: "Compare a file on a remote host against a local file or a second remote file. Returns unified diff output.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host for the remote file." },
        remotePath: { type: "string", description: "Absolute path to file on remote host." },
        localPath: { type: "string", description: "Absolute path to local file to compare against. Mutually exclusive with target2/remotePath2." },
        target2: { type: "string", description: "Second remote profile for remote-vs-remote diff." },
        remotePath2: { type: "string", description: "Path on second remote host." },
        context: { type: "number", description: "Lines of context in diff output. Default 3." }
      },
      required: ["target", "remotePath"]
    }
  }
  ,{
    name: "ssh_script",
    title: "SSH Run Local Script",
    description: "Upload and run a local script file on a remote host by piping it to bash. Safer than building commands inline. Requires confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        localScript: { type: "string", description: "Absolute path to local script file to execute on remote." },
        args: { type: "array", items: { type: "string" }, description: "Positional arguments passed to the script (appended as env vars SSH_OPS_ARG_1, SSH_OPS_ARG_2, ...)." },
        sudo: { type: "boolean", description: "Run with sudo on remote." },
        cwd: { type: "string", description: "Working directory on remote." },
        timeoutMs: { type: "number", description: "Timeout in ms. Default 120000." },
        confirm: { type: "boolean", description: "Required true to execute." },
        reason: { type: "string", description: "Optional reason for this action. Logged to audit log and shown in confirmation prompts." }
      },
      required: ["localScript"]
    }
  }
  ,{
    name: "ssh_docker",
    title: "SSH Docker Management",
    description: "Manage Docker containers on a remote host. List containers, fetch logs, restart/stop/inspect. Mutating actions require confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: {
          type: "string",
          enum: ["list", "logs", "restart", "stop", "start", "inspect", "stats"],
          description: "Docker action."
        },
        container: { type: "string", description: "Container name or ID. Required for logs/restart/stop/start/inspect." },
        lines: { type: "number", description: "Log lines to fetch (logs action). Default 100." },
        since: { type: "string", description: "Show logs since timestamp/duration e.g. '1h' (logs action)." },
        sudo: { type: "boolean", description: "Run docker with sudo. Default false." },
        confirm: { type: "boolean", description: "Required true for restart/stop/start." },
        reason: { type: "string", description: "Optional reason for this action. Logged to audit log and shown in confirmation prompts." }
      },
      required: ["action"]
    }
  }
  ,{
    name: "ssh_metrics",
    title: "SSH System Metrics",
    description: "Fetch structured system metrics from a remote host: CPU%, memory%, disk I/O, network I/O, load average, uptime. Reads /proc directly — no external monitoring agent required.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        timeoutMs: { type: "number", description: "Timeout in ms. Default 30000." }
      }
    }
  }
  ,{
    name: "ssh_transfer",
    title: "SSH File Transfer",
    description: "Transfer files between local and remote hosts, or between two remote hosts, using scp. Requires confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        src: { type: "string", description: "Source. Local absolute path, or 'profile:path' / 'user@host:path' for remote." },
        dst: { type: "string", description: "Destination. Local absolute path, or 'profile:path' / 'user@host:path' for remote." },
        recursive: { type: "boolean", description: "Copy directories recursively (-r flag)." },
        confirm: { type: "boolean", description: "Required true to execute." },
        reason: { type: "string", description: "Optional reason for this action. Logged to audit log and shown in confirmation prompts." }
      },
      required: ["src", "dst"]
    }
  }
  ,{
    name: "ssh_env",
    title: "SSH Environment Variables",
    description: "Read, set, or unset system environment variables on a remote host via /etc/environment. Mutating actions require confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: {
          type: "string",
          enum: ["list", "get", "set", "unset"],
          description: "Action to perform."
        },
        key: { type: "string", description: "Variable name. Required for get/set/unset." },
        value: { type: "string", description: "Value to set. Required for set action." },
        confirm: { type: "boolean", description: "Required true for set/unset." },
        reason: { type: "string", description: "Optional reason logged to audit log." }
      },
      required: ["action"]
    }
  }
  ,{
    name: "ssh_process",
    title: "SSH Process Management",
    description: "List running processes or kill a process by PID or name on a remote host. kill action requires confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: {
          type: "string",
          enum: ["list", "kill"],
          description: "list: snapshot of running processes. kill: send signal to process."
        },
        pid: { type: "number", description: "PID to kill. Mutually exclusive with processName." },
        processName: { type: "string", description: "Process name pattern to kill (uses pkill). Mutually exclusive with pid." },
        signal: { type: "string", description: "Signal to send. Default TERM. Use KILL for force-kill." },
        filter: { type: "string", description: "Filter string for list action (grep pattern)." },
        confirm: { type: "boolean", description: "Required true for kill." },
        reason: { type: "string", description: "Optional reason logged to audit log." }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_run_watch",
    title: "SSH Run Watch (Diff Output)",
    description: "Run a command and return a diff vs the last time it ran. On first call returns full output. Subsequent calls return only changed lines (unified diff). Reduces context by surfacing only what changed.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        command: { type: "string", description: "Remote command to run." },
        sudo: { type: "boolean", description: "Run via sudo -n bash -s." },
        mode: { type: "string", enum: ["bash", "raw"], description: "Execution mode. Default bash." },
        cwd: { type: "string", description: "Remote working directory." },
        timeoutMs: { type: "number", description: "Timeout ms." },
        resetCache: { type: "boolean", description: "If true, discard cached output and return fresh full output." }
      },
      required: ["command"]
    }
  }
];

function getTools() {
  const extra = _extraModules.flatMap(m => Array.isArray(m.toolDefs) ? m.toolDefs : []);
  try {
    const cfg = getConfig();
    if (cfg.exposeProfiles === false) return [...allTools, ...extra];
  } catch {}
  return [profilesTool, ...allTools, ...extra];
}

function isTopologyExposed() {
  try { return getConfig().exposeProfiles !== false; } catch { return true; }
}

let _skillInstructions = null;
function getSkillInstructions() {
  if (_skillInstructions !== null) return _skillInstructions;
  try {
    _skillInstructions = readFileSync(join(PLUGIN_ROOT, "skills", "ssh-ops", "SKILL.md"), "utf8").trim();
  } catch {
    _skillInstructions = "";
  }
  return _skillInstructions;
}

const handlers = {
  initialize(message) {
    initLogger();
    serverLog("info", "ssh-ops MCP server initialized", { version: SERVER_VERSION });
    if (process.env.SSH_OPS_AUTO_UPDATE === "1") {
      void selfUpdate();
    }
    const instructions = getSkillInstructions();
    const result = {
      protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: "ssh-ops",
        version: SERVER_VERSION
      }
    };
    if (instructions) result.instructions = instructions;
    return result;
  },

  "tools/list"() {
    return { tools: getTools() };
  },

  async "tools/call"(message) {
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    try {
      const cfg = getConfig();
      const limit = cfg.rateLimitPerMin ?? 60;
      const target = args?.target || args?.host || "__default__";
      const rateLimitErr = checkRateLimit(target, limit);
      if (rateLimitErr) {
        const result = textResult(rateLimitErr, true);
        writeAuditLog(name, args, result);
        serverLog("warn", "rate limit exceeded", { tool: name, target });
        return result;
      }
    } catch {}
    const _start = Date.now();
    let result;
    try {
      result = await callTool(name, args);
    } catch (err) {
      serverLog("error", "callTool threw", { tool: name, error: err?.message });
      result = textResult(`Internal error: ${err?.message}`, true);
    }
    const durationMs = Date.now() - _start;
    writeAuditLog(name, args, result, { durationMs });
    if (result?.isError) serverLog("warn", "tool returned error", { tool: name, durationMs });
    return result;
  },

  ping() {
    return {};
  }
};

const BLOCKED_SSH_OPTIONS = new Set([
  "ProxyCommand", "LocalCommand", "PermitLocalCommand", "ProxyJump",
  "Include", "Match", "ForwardAgent", "ForwardX11", "ForwardX11Trusted",
  "DynamicForward", "LocalForward", "RemoteForward", "Tunnel", "TunnelDevice"
]);

const BLOCKED_SSH_FLAGS = new Set(["-D", "-L", "-R", "-w", "-W", "-J"]);

function validateSshOptions(opts) {
  if (!Array.isArray(opts)) return null;
  for (let i = 0; i < opts.length; i++) {
    const opt = String(opts[i]);
    if (BLOCKED_SSH_FLAGS.has(opt)) {
      return `SSH flag "${opt}" is not permitted for security reasons.`;
    }
    if (opt === "-o") {
      const val = String(opts[i + 1] || "");
      const key = val.split("=")[0];
      if (BLOCKED_SSH_OPTIONS.has(key)) {
        return `SSH option "${key}" is not permitted for security reasons.`;
      }
      i++;
    } else if (opt.startsWith("-o") && opt.length > 2) {
      const val = opt.slice(2);
      const key = val.split("=")[0];
      if (BLOCKED_SSH_OPTIONS.has(key)) {
        return `SSH option "${key}" is not permitted for security reasons.`;
      }
    }
  }
  return null;
}

function validateInput(toolName, params) {
  // Global: reject control characters in all string params
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && /[\r\n\x00]/.test(v)) {
      return `Parameter "${k}" must not contain newlines or null bytes.`;
    }
  }

  // sshOptions / extraArgs validation (applies to any tool that accepts them)
  if (params.sshOptions !== undefined) {
    const err = validateSshOptions(params.sshOptions);
    if (err) return err;
  }
  if (params.extraArgs !== undefined) {
    const err = validateSshOptions(params.extraArgs);
    if (err) return err;
  }

  // Integer range checks for common numeric fields
  const intRanges = { port: [1, 65535], timeoutMs: [1, 3600000], connectTimeoutSec: [1, 300], maxOutputBytes: [1, 100_000_000] };
  for (const [field, [min, max]] of Object.entries(intRanges)) {
    if (params[field] !== undefined && (!Number.isInteger(params[field]) || params[field] < min || params[field] > max)) {
      return `${field} must be an integer between ${min} and ${max}. Got: ${params[field]}`;
    }
  }
  // startLine / endLine
  if (params.startLine !== undefined && (!Number.isInteger(params.startLine) || params.startLine < 1)) {
    return `startLine must be a positive integer. Got: ${params.startLine}`;
  }
  if (params.endLine !== undefined && (!Number.isInteger(params.endLine) || params.endLine < 1)) {
    return `endLine must be a positive integer. Got: ${params.endLine}`;
  }

  if (toolName === "ssh_file_read" || toolName === "ssh_file_write" || toolName === "ssh_file_patch") {
    if (params.path) {
      if (!params.path.startsWith("/")) {
        return `path must be absolute (start with /). Got: ${params.path}`;
      }
      if (/(\/\.\.)|(\/\.$)/.test(params.path) || params.path.includes("\x00")) {
        return `path must not contain ".." segments or null bytes. Got: ${params.path}`;
      }
    }
  }

  if (toolName === "ssh_service") {
    const unit = params.unit || params.service;
    if (unit && !/^[a-zA-Z0-9@_:.+-]+$/.test(unit)) {
      return `service/unit contains invalid characters. Use only [a-zA-Z0-9@_:.+-]. Got: ${unit}`;
    }
  }

  if (toolName === "ssh_package") {
    const entries = Array.isArray(params.packages) ? params.packages : (params.package ? [params.package] : []);
    for (const pkg of entries) {
      if (!/^[a-zA-Z0-9._+:/-]+$/.test(pkg) || pkg.startsWith("-")) {
        return `package name is invalid or starts with a dash. Use only [a-zA-Z0-9._+:/-]. Got: ${pkg}`;
      }
    }
    const validManagers = ["apt","dnf","yum","apk","pacman","zypper","xbps","snap","flatpak","pkg","emerge","nix","opkg","brew"];
    if (params.manager !== undefined && !validManagers.includes(String(params.manager))) {
      return `manager must be one of: ${validManagers.join(", ")}. Got: ${params.manager}`;
    }
  }

  if (toolName === "ssh_chmod") {
    if (params.mode !== undefined && !/^[0-7]{3,4}$|^[ugoa]*[+\-=][rwxXst]+$/.test(params.mode)) {
      return `mode is invalid. Use octal (755, 0644) or symbolic (u+x, g-w). Got: ${params.mode}`;
    }
    if (params.owner !== undefined && !/^[a-zA-Z0-9._-]+$/.test(params.owner)) {
      return `owner contains invalid characters. Use only [a-zA-Z0-9._-]. Got: ${params.owner}`;
    }
    if (params.group !== undefined && !/^[a-zA-Z0-9._-]+$/.test(params.group)) {
      return `group contains invalid characters. Use only [a-zA-Z0-9._-]. Got: ${params.group}`;
    }
  }

  if (toolName === "ssh_sudo_rule") {
    if (params.ruleFile !== undefined) {
      if (!/^[a-zA-Z0-9._-]+$/.test(params.ruleFile) || /^\.+$/.test(params.ruleFile)) {
        return `ruleFile must be a plain filename (no path separators, not all-dots). Got: ${params.ruleFile}`;
      }
    }
    if (params.commands !== undefined) {
      const cmds = Array.isArray(params.commands) ? params.commands : [params.commands];
      for (const cmd of cmds) {
        if (/[\r\n\x00$`\\"]/.test(cmd)) {
          return `commands must not contain newlines, null bytes, or shell metacharacters.`;
        }
      }
    }
    if (params.runas !== undefined && /[\r\n\x00$`\\"]/.test(params.runas)) {
      return `runas must not contain shell metacharacters.`;
    }
    if (params.username !== undefined && !/^[a-z_][a-z0-9_-]{0,30}$/.test(params.username)) {
      return `username must match ^[a-z_][a-z0-9_-]{0,30}$ (POSIX). Got: ${params.username}`;
    }
  }

  if (toolName === "ssh_user") {
    if (params.username !== undefined && params.action !== "list" && !/^[a-z_][a-z0-9_-]{0,30}$/.test(params.username)) {
      return `username must match ^[a-z_][a-z0-9_-]{0,30}$ (POSIX). Got: ${params.username}`;
    }
    if (params.shell !== undefined && /[\r\n\x00 ]/.test(params.shell)) {
      return `shell must not contain spaces, newlines, or null bytes.`;
    }
    if (params.homeDir !== undefined && (!params.homeDir.startsWith("/") || params.homeDir.includes("..") || /[\r\n\x00]/.test(params.homeDir))) {
      return `homeDir must be an absolute path without ".." segments.`;
    }
  }

  if (toolName === "ssh_cron") {
    if (params.schedule !== undefined && /[\r\n\x00]/.test(params.schedule)) {
      return `schedule must not contain newlines or null bytes.`;
    }
    if (params.command !== undefined && /[\r\n\x00]/.test(params.command)) {
      return `command must not contain newlines or null bytes.`;
    }
  }

  return null;
}

async function callTool(name, args) {
  // Enforce tool visibility: reject tools hidden from tools/list
  const visibleToolNames = new Set(getTools().map(t => t.name));
  if (!visibleToolNames.has(name)) {
    return textResult(`Unknown tool: ${name}`, true);
  }

  if (name === "ssh_profiles") {
    return textResult(JSON.stringify(listProfiles(), null, 2));
  }

  if (name === "ssh_ping") {
    const { resolveTarget } = await import("./ssh-core.mjs");
    let host = args.host;
    let port = args.port || 22;
    try {
      const info = resolveTarget({ target: args.target, host: args.host });
      host = host || info.options.host || (info.target.includes("@") ? info.target.split("@")[1] : info.target);
      port = args.port || info.options.port || 22;
    } catch {}
    if (!host) return textResult("host or target required.", true);
    const timeoutMs = args.timeoutMs || 5000;
    const count = Math.min(Math.max(1, args.count || 3), 10);
    const results = [];
    for (let i = 0; i < count; i++) {
      const start = Date.now();
      const ok = await new Promise((resolve) => {
        const sock = net.createConnection({ host, port, timeout: timeoutMs });
        sock.once("connect", () => { sock.destroy(); resolve(true); });
        sock.once("timeout", () => { sock.destroy(); resolve(false); });
        sock.once("error", () => resolve(false));
      });
      results.push(ok ? Date.now() - start : null);
      if (i < count - 1) await new Promise(r => setTimeout(r, 200));
    }
    const successes = results.filter(r => r !== null);
    const avgMs = successes.length ? Math.round(successes.reduce((a, b) => a + b, 0) / successes.length) : null;
    return textResult(JSON.stringify({
      host, port,
      reachable: successes.length > 0,
      attempts: count,
      successCount: successes.length,
      avgLatencyMs: avgMs,
      results: results.map(r => r === null ? "timeout" : `${r}ms`)
    }, null, 2));
  }

  if (name === "ssh_run") {
    if (args.sudo === true && args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);
    if (args.dryRun === true) return dryRunResult(name, args, args.command, args.target || args.host);
    const result = await runSshCommand({ retries: args.retries ?? 0, retryDelayMs: args.retryDelayMs ?? 1500, ...args });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_inventory") {
    const command = hardwareInventoryScript({ includeSudo: args.includeSudo !== false });
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 180_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_disk_report") {
    const command = diskReportScript({ path: args.path || "/", depth: args.depth || 1 });
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 180_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_health_report") {
    const command = healthReportScript();
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 120_000 });
    // Alert webhook if configured and thresholds breached
    try {
      const cfg = getConfig();
      if (cfg.alertWebhook && result.exitCode === 0) {
        const thresholds = cfg.alertThresholds || {};
        const cpuLimit = thresholds.cpuPercent ?? 95;
        const memLimit = thresholds.memPercent ?? 95;
        const diskLimit = thresholds.diskPercent ?? 90;
        const metrics = parseHealthMetrics(result.stdout || "");
        const breaches = [];
        if (metrics.cpuPercent !== undefined && metrics.cpuPercent > cpuLimit)
          breaches.push(`CPU ${metrics.cpuPercent}% > ${cpuLimit}%`);
        if (metrics.memPercent !== undefined && metrics.memPercent > memLimit)
          breaches.push(`Memory ${metrics.memPercent}% > ${memLimit}%`);
        if (metrics.diskPercent !== undefined && metrics.diskPercent > diskLimit)
          breaches.push(`Disk ${metrics.diskPercent}% > ${diskLimit}%`);
        if (breaches.length > 0) {
          void sendAlert(cfg.alertWebhook, {
            text: `ssh-ops health alert on ${result.targetLabel || args.target || "unknown"}: ${breaches.join(", ")}`,
            target: result.targetLabel || args.target,
            breaches,
            metrics,
            ts: new Date().toISOString()
          });
        }
      }
    } catch {}
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_file_read") {
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);
    const command = fileReadScript(args.path, args.maxBytes, args.encoding);
    const result = await runSshCommand({ ...args, command, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_file_write") {
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);
    if (args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const command = fileWriteScript(args.path, args.content, {
      backup: args.backup !== false,
      sudo: Boolean(args.sudo),
      encoding: args.encoding
    });
    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({ ...args, command, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_service") {
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);
    const mutatingActions = { start: true, stop: true, restart: true, enable: true, disable: true };
    if (mutatingActions[args.action] && args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const command = serviceScript(args.service, args.action, {
      sudo: args.sudo !== false
    });
    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({ ...args, command, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_log_search") {
    const command = logSearchScript(args);
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 60_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_file_patch") {
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);
    if (args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const command = filePatchScript(args.path, {
      startLine: args.startLine,
      endLine: args.endLine,
      content: args.content,
      pattern: args.pattern,
      replacement: args.replacement,
      flags: args.flags,
      backup: args.backup !== false,
      sudo: Boolean(args.sudo)
    });
    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({ ...args, command, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_run_multi") {
    if (args.sudo === true && args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);
    const maxConcurrent = args.maxConcurrent || 10;
    const retries = args.retries ?? 2;
    const retryDelayMs = args.retryDelayMs ?? 1500;

    async function runBatched(targets, fn) {
      const results = [];
      for (let i = 0; i < targets.length; i += maxConcurrent) {
        const batch = targets.slice(i, i + maxConcurrent);
        const batchResults = await Promise.all(batch.map(fn));
        results.push(...batchResults);
      }
      return results;
    }

    const perTargetOpts = {
      command: args.command,
      sudo: args.sudo,
      mode: args.mode,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      sshOptions: args.sshOptions,
      identityFile: args.identityFile,
      jumpHost: args.jumpHost,
      retries,
      retryDelayMs
    };

    let targets = Array.isArray(args.targets) ? args.targets : [args.target || args.host].filter(Boolean);
    if (args.group) {
      const groupTargets = resolveGroup(args.group);
      targets = [...new Set([...targets, ...groupTargets])];
    }
    if (targets.length === 0) return textResult("No targets specified. Provide targets array, target, host, or group.", true);

    const results = await runBatched(targets, (target) =>
      runMultiSshCommand([target], perTargetOpts).then((r) => r[0])
    );
    const text = formatMultiRunResult(results, args.format || "text");
    const hasError = results.some((r) => r.exitCode !== 0 || r.exitCode === null);
    return textResult(text, hasError);
  }

  if (name === "ssh_network_check") {
    const command = networkCheckScript({
      host: args.host,
      port: args.port,
      ping: args.ping !== false,
      tls: Boolean(args.tls)
    });
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 30_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_package") {
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);
    const mutatingActions = { install: true, remove: true, update: true, upgrade: true, autoremove: true };
    if (mutatingActions[args.action] && args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const command = packageScript({
      action: args.action,
      packages: Array.isArray(args.packages) ? args.packages : [],
      sudo: args.sudo !== false,
      manager: args.manager || null
    });
    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 120_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_cron") {
    const mutatingActions = { add: true, remove: true };
    if (mutatingActions[args.action] && args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const command = cronScript({
      action: args.action,
      user: args.user,
      schedule: args.schedule,
      command: args.command
    });
    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 60_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_add_profile") {
    if (args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);
    const profiles = addProfile(args.name, {
      host: args.host,
      user: args.user,
      port: args.port,
      password: args.password,
      identityFile: args.identityFile,
      access: args.access,
      jumpProfile: args.jumpProfile,
      jumpUser: args.jumpUser,
      targetUser: args.targetUser,
      localSwitchUser: args.localSwitchUser,
      extraArgs: args.extraArgs
    });
    return textResult(JSON.stringify(profiles, null, 2));
  }

  if (name === "ssh_remove_profile") {
    if (args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const profiles = removeProfile(args.name);
    return textResult(JSON.stringify(profiles, null, 2));
  }

  if (name === "ssh_add_jump") {
    if (args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);
    const result = addJumpServer(
      args.name,
      {
        host: args.host,
        user: args.user,
        port: args.port,
        password: args.password,
        identityFile: args.identityFile
      },
      {
        appendToChain: args.appendToChain !== false,
        commonUser: args.commonUser
      }
    );
    return textResult(JSON.stringify(result, null, 2));
  }

  if (name === "ssh_remove_jump") {
    if (args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const result = removeJumpServer(args.name);
    return textResult(JSON.stringify(result, null, 2));
  }

  if (name === "ssh_list_jumps") {
    if (!isTopologyExposed()) return textResult(`Tool not available.`, true);
    return textResult(JSON.stringify(listJumpServers(), null, 2));
  }

  if (name === "ssh_list_keys") {
    if (!isTopologyExposed()) return textResult(`Tool not available.`, true);
    const keys = listLocalSshKeys();
    const out = keys.length > 0
      ? `Found ${keys.length} SSH private key(s):\n${keys.map((k) => `  ${k}`).join("\n")}`
      : "No SSH private keys found in ~/.ssh/ or home directory.";
    return textResult(out);
  }

  if (name === "ssh_ip_assign") {
    if (args.confirm !== true) {
      return requireConfirm(name, args);
    }
    let resolved = { iface: args.iface, ips: args.ips, gateway: args.gateway, dns: args.dns };

    if (args.group) {
      const g = resolveIpGroup(args.group);
      resolved = { iface: g.iface, ips: g.ips, gateway: g.gateway, dns: g.dns, ...resolved };
    } else if (args.fromFile) {
      const resolvedFromFile = pathResolve(args.fromFile);
      const allowedBase = PLUGIN_ROOT;
      if (!resolvedFromFile.startsWith(allowedBase + "/") && !resolvedFromFile.startsWith(allowedBase + pathSep)) {
        return textResult(`fromFile must be within the ssh-ops plugin directory (${allowedBase}).`, true);
      }
      let raw;
      try { raw = readFileSync(resolvedFromFile, "utf8"); } catch {
        return textResult(`Cannot read the specified fromFile.`, true);
      }
      let parsed;
      try {
        parsed = resolvedFromFile.match(/\.ya?ml$/i)
          ? parseYamlConfig(raw)
          : JSON.parse(raw);
      } catch {
        return textResult(`Failed to parse fromFile: invalid JSON or YAML format.`, true);
      }
      resolved = { ...parsed, ...resolved };
    }

    if (!resolved.ips || resolved.ips.length === 0)
      return textResult("ips is required — provide ips array, group, or fromFile.", true);
    if (!resolved.iface)
      return textResult("iface is required — provide it directly, in the group, or in fromFile.", true);

    const command = ipAssignScript({
      iface: resolved.iface,
      ips: resolved.ips,
      gateway: resolved.gateway,
      dns: resolved.dns,
      method: args.method || "auto"
    });
    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({
      ...args,
      command,
      mode: "bash",
      sudo: true,
      timeoutMs: args.timeoutMs || 60_000
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_save_ip_group") {
    if (!isTopologyExposed()) return textResult(`Tool not available.`, true);
    const groups = saveIpGroup(args.name, {
      iface: args.iface,
      ips: args.ips,
      gateway: args.gateway,
      dns: args.dns
    });
    return textResult(JSON.stringify(groups, null, 2));
  }

  if (name === "ssh_remove_ip_group") {
    if (!isTopologyExposed()) return textResult(`Tool not available.`, true);
    const groups = removeIpGroup(args.name);
    return textResult(JSON.stringify(groups, null, 2));
  }

  if (name === "ssh_list_ip_groups") {
    if (!isTopologyExposed()) return textResult(`Tool not available.`, true);
    return textResult(JSON.stringify(listIpGroups(), null, 2));
  }

  if (name === "ssh_user") {
    const mutatingActions = { add: true, del: true, mod: true, passwd: true, lock: true, unlock: true };
    if (mutatingActions[args.action] && args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const command = userManageScript({
      action: args.action,
      username: args.username,
      password: args.password,
      groups: args.groups,
      shell: args.shell,
      homeDir: args.homeDir,
      comment: args.comment,
      system: Boolean(args.system),
      createHome: args.createHome !== false,
      removeHome: Boolean(args.removeHome)
    });
    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({
      ...args,
      command,
      mode: "bash",
      sudo: args.sudo !== false
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_chmod") {
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);
    if (args.confirm !== true) {
      return requireConfirm(name, args);
    }
    const command = chmodScript({
      path: args.path,
      mode: args.mode,
      owner: args.owner,
      group: args.group,
      recursive: Boolean(args.recursive)
    });
    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({
      ...args,
      command,
      mode: "bash",
      sudo: Boolean(args.sudo)
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_sudo_rule") {
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);
    const mutatingActions = { add: true, remove: true };
    if (mutatingActions[args.action] && args.confirm !== true) {
      return requireConfirm(name, args);
    }
    if (args.action === "add") {
      const cmds = args.commands;
      if (!cmds) {
        return textResult(`commands is required for ssh_sudo_rule add. Specify an array of allowed commands.`, true);
      }
      const cmdList = Array.isArray(cmds) ? cmds : [cmds];
      if (cmdList.includes("ALL") && args.iAcceptRiskOfAllCommands !== true) {
        return textResult(`commands:"ALL" grants unrestricted sudo. Set iAcceptRiskOfAllCommands:true to confirm this risk.`, true);
      }
    }
    const command = sudoRuleScript({
      action: args.action,
      username: args.username,
      commands: args.commands,
      runas: args.runas || "ALL:ALL",
      nopasswd: args.nopasswd === true,
      ruleFile: args.ruleFile
    });
    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({
      ...args,
      command,
      mode: "bash",
      sudo: true
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_diff") {
    if (!args.remotePath || !args.remotePath.startsWith("/")) {
      return textResult("remotePath must be an absolute path.", true);
    }
    const context = Math.min(Math.max(0, Number(args.context) || 3), 20);
    const cmd1 = fileReadScript(args.remotePath, 2_000_000);
    const res1 = await runSshCommand({ ...args, command: cmd1, mode: "bash" });
    if (res1.exitCode !== 0) return textResult(`Failed to read remote file: ${res1.stderr}`, true);
    const remoteContent = res1.stdout;

    let localContent;
    if (args.localPath) {
      if (!args.localPath.startsWith("/")) return textResult("localPath must be absolute.", true);
      try { localContent = readFileSync(args.localPath, "utf8"); } catch (e) {
        return textResult(`Cannot read local file: ${e.message}`, true);
      }
    } else if (args.target2 && args.remotePath2) {
      if (!args.remotePath2.startsWith("/")) return textResult("remotePath2 must be absolute.", true);
      const cmd2 = fileReadScript(args.remotePath2, 2_000_000);
      const res2 = await runSshCommand({ ...args, target: args.target2, host: undefined, command: cmd2, mode: "bash" });
      if (res2.exitCode !== 0) return textResult(`Failed to read remote2 file: ${res2.stderr}`, true);
      localContent = res2.stdout;
    } else {
      return textResult("Provide localPath or target2+remotePath2.", true);
    }

    const diff = unifiedDiff(
      args.localPath || `${args.target2}:${args.remotePath2}`,
      `${args.target || "remote"}:${args.remotePath}`,
      localContent, remoteContent, context
    );
    return textResult(diff || "(files are identical)");
  }

  if (name === "ssh_script") {
    if (args.confirm !== true) {
      return requireConfirm(name, args);
    }
    if (!args.localScript || !args.localScript.startsWith("/")) {
      return textResult("localScript must be an absolute path.", true);
    }
    // Restrict localScript to PLUGIN_ROOT for security
    const { resolve: pathResolve } = await import("node:path");
    const resolvedScript = pathResolve(args.localScript);
    if (!resolvedScript.startsWith(PLUGIN_ROOT + "/")) {
      return textResult(`localScript must be within the plugin directory (${PLUGIN_ROOT}).`, true);
    }
    let scriptContent;
    try { scriptContent = readFileSync(resolvedScript, "utf8"); } catch (e) {
      return textResult(`Cannot read script file: ${e.message}`, true);
    }
    // Prepend arg exports if provided
    const scriptArgs = Array.isArray(args.args) ? args.args : [];
    const argExports = scriptArgs.map((a, i) => `export SSH_OPS_ARG_${i + 1}=${JSON.stringify(String(a))}`).join("\n");
    const fullScript = argExports ? `${argExports}\n${scriptContent}` : scriptContent;
    const result = await runSshCommand({
      ...args,
      command: fullScript,
      mode: "bash",
      sudo: Boolean(args.sudo),
      timeoutMs: args.timeoutMs || 120_000
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_docker") {
    const validActions = ["list", "logs", "restart", "stop", "start", "inspect", "stats"];
    if (!validActions.includes(args.action)) {
      return textResult(`action must be one of: ${validActions.join(", ")}`, true);
    }
    const mutating = ["restart", "stop", "start"];
    if (mutating.includes(args.action) && args.confirm !== true) {
      return requireConfirm(name, args);
    }
    if (args.action !== "list" && args.action !== "stats" && !args.container) {
      return textResult("container name or ID required for this action.", true);
    }
    const sudo = args.sudo ? "sudo " : "";
    let command;
    if (args.action === "list") {
      command = `set +e\n${sudo}docker ps -a --format '{{json .}}' 2>&1 | head -c 500000\n`;
    } else if (args.action === "logs") {
      const lines = Math.min(Number(args.lines) || 100, 5000);
      const since = args.since ? ` --since ${JSON.stringify(String(args.since))}` : "";
      command = `set +e\n${sudo}docker logs --tail ${lines}${since} ${JSON.stringify(String(args.container))} 2>&1\n`;
    } else if (args.action === "inspect") {
      command = `set +e\n${sudo}docker inspect ${JSON.stringify(String(args.container))} 2>&1\n`;
    } else if (args.action === "stats") {
      command = `set +e\n${sudo}docker stats --no-stream --format '{{json .}}' 2>&1\n`;
    } else {
      command = `set +e\n${sudo}docker ${args.action} ${JSON.stringify(String(args.container))} 2>&1\n`;
    }
    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({ ...args, command, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_transfer") {
    if (args.confirm !== true) {
      return requireConfirm(name, args);
    }
    if (!args.src || !args.dst) return textResult("src and dst are required.", true);

    // Resolve 'profile:path' notation to 'user@host:path' for scp
    async function resolveScpAddr(addr) {
      if (!addr.includes(":")) return addr; // local path — no colon means local
      const colonIdx = addr.indexOf(":");
      const profileOrHost = addr.slice(0, colonIdx);
      const remotePath = addr.slice(colonIdx + 1);
      // Try to resolve as profile
      try {
        const { resolveTarget: rt } = await import("./ssh-core.mjs");
        const info = rt({ target: profileOrHost });
        return `${info.target}:${remotePath}`;
      } catch {
        return addr; // already user@host:path
      }
    }

    const scpSrc = await resolveScpAddr(args.src);
    const scpDst = await resolveScpAddr(args.dst);
    const { spawn } = await import("node:child_process");
    const scpArgs = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
    if (args.recursive) scpArgs.push("-r");
    scpArgs.push(scpSrc, scpDst);

    if (args.dryRun === true) {
      return textResult(JSON.stringify({ dryRun: true, tool: name, command: `scp ${scpArgs.join(" ")}`, note: "dryRun:true — nothing executed" }, null, 2));
    }

    const result = await new Promise((resolve) => {
      let stdout = "", stderr = "";
      const proc = spawn("scp", scpArgs, { stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", d => { stdout += d; });
      proc.stderr.on("data", d => { stderr += d; });
      proc.on("close", code => resolve({ stdout, stderr, exitCode: code }));
      proc.on("error", e => resolve({ stdout: "", stderr: e.message, exitCode: 1 }));
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "(transfer complete)";
    return textResult(output, result.exitCode !== 0);
  }

  if (name === "ssh_env") {
    const validActions = ["list", "get", "set", "unset"];
    if (!validActions.includes(args.action)) {
      return textResult(`action must be one of: ${validActions.join(", ")}`, true);
    }
    if (["set", "unset"].includes(args.action) && args.confirm !== true) {
      return requireConfirm(name, args);
    }
    if (["get", "set", "unset"].includes(args.action) && !args.key) {
      return textResult("key is required.", true);
    }
    if (args.key && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(args.key)) {
      return textResult("key must be a valid env var name ([a-zA-Z_][a-zA-Z0-9_]*).", true);
    }
    if (args.action === "set" && args.value === undefined) {
      return textResult("value is required for set.", true);
    }

    let command;
    if (args.action === "list") {
      command = `set +e\nexport LC_ALL=C\ncat /etc/environment 2>/dev/null || echo "(empty)"\n`;
    } else if (args.action === "get") {
      const keyQ = JSON.stringify(String(args.key));
      command = `set +e\nexport LC_ALL=C\ngrep -E "^${args.key}=" /etc/environment 2>/dev/null || echo "${args.key} not set in /etc/environment"\n`;
    } else if (args.action === "set") {
      const keyQ = String(args.key);
      const valQ = String(args.value).replace(/'/g, "'\\''");
      command = `set +e
export LC_ALL=C
_f=/etc/environment
_key=${JSON.stringify(keyQ)}
_val=${JSON.stringify(valQ)}
if grep -qE "^${keyQ}=" "$_f" 2>/dev/null; then
  sed -i "s|^${keyQ}=.*|${keyQ}=$_val|" "$_f" && echo "Updated ${keyQ} in $_f"
else
  echo "${keyQ}=$_val" >> "$_f" && echo "Added ${keyQ} to $_f"
fi
`;
    } else {
      command = `set +e
export LC_ALL=C
_f=/etc/environment
if grep -qE "^${args.key}=" "$_f" 2>/dev/null; then
  sed -i "/^${args.key}=/d" "$_f" && echo "Removed ${args.key} from $_f"
else
  echo "${args.key} not found in $_f"
fi
`;
    }

    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({ ...args, command, mode: "bash", sudo: ["set", "unset"].includes(args.action) });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_process") {
    if (!["list", "kill"].includes(args.action)) {
      return textResult("action must be list or kill.", true);
    }
    if (args.action === "kill" && args.confirm !== true) {
      return requireConfirm(name, args);
    }
    if (args.action === "kill" && !args.pid && !args.processName) {
      return textResult("pid or processName required for kill.", true);
    }

    let command;
    if (args.action === "list") {
      const filter = args.filter ? ` | grep -i ${JSON.stringify(String(args.filter))}` : "";
      command = `set +e\nexport LC_ALL=C\nps aux --sort=-%cpu${filter} 2>/dev/null || ps aux${filter}\n`;
    } else {
      const signal = /^[A-Z0-9]+$/.test(String(args.signal || "TERM")) ? String(args.signal || "TERM") : "TERM";
      if (args.pid) {
        const pid = Math.floor(Number(args.pid));
        if (!Number.isFinite(pid) || pid < 1) return textResult("pid must be a positive integer.", true);
        command = `set +e\nexport LC_ALL=C\nkill -${signal} ${pid} && echo "Sent ${signal} to PID ${pid}" || echo "kill failed"\n`;
      } else {
        command = `set +e\nexport LC_ALL=C\npkill -${signal} -f ${JSON.stringify(String(args.processName))} && echo "Sent ${signal} to processes matching '${args.processName}'" || echo "No matching processes found"\n`;
      }
    }

    if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
    const result = await runSshCommand({ ...args, command, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_metrics") {
    const command = `set +e
export LC_ALL=C

# CPU usage (1-second sample via /proc/stat)
read -r cpu1 < /proc/stat
cpu1_arr=($cpu1)
sleep 1
read -r cpu2 < /proc/stat
cpu2_arr=($cpu2)
idle1=\${cpu1_arr[4]}; total1=0; for v in "\${cpu1_arr[@]:1}"; do total1=$((total1+v)); done
idle2=\${cpu2_arr[4]}; total2=0; for v in "\${cpu2_arr[@]:1}"; do total2=$((total2+v)); done
cpu_pct=$(awk "BEGIN{printf \\"%.1f\\", 100*(1-($idle2-$idle1)/($total2-$total1))}")

# Memory
mem=$(awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{printf "%.1f", 100*(t-a)/t}' /proc/meminfo)
mem_total=$(awk '/^MemTotal/{printf "%d",$2/1024}' /proc/meminfo)
mem_used=$(awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{printf "%d",(t-a)/1024}' /proc/meminfo)

# Load average
load=$(cat /proc/loadavg | awk '{print $1,$2,$3}')
load1=$(echo $load | cut -d' ' -f1)
load5=$(echo $load | cut -d' ' -f2)
load15=$(echo $load | cut -d' ' -f3)

# Uptime seconds
uptime_sec=$(awk '{print int($1)}' /proc/uptime)

# Disk I/O (delta over 1s already done above; just report current from /proc/diskstats)
disk_reads=$(awk '{sum+=$6}END{print sum}' /proc/diskstats)
disk_writes=$(awk '{sum+=$10}END{print sum}' /proc/diskstats)

# Network I/O totals
net_rx=$(awk 'NR>2{rx+=$2}END{print rx}' /proc/net/dev)
net_tx=$(awk 'NR>2{tx+=$10}END{print tx}' /proc/net/dev)

printf '{"cpuPercent":%s,"memPercent":%s,"memUsedMB":%s,"memTotalMB":%s,"loadAvg":{"1m":%s,"5m":%s,"15m":%s},"uptimeSeconds":%s,"diskReadSectors":%s,"diskWriteSectors":%s,"netRxBytes":%s,"netTxBytes":%s}\\n' \\
  "$cpu_pct" "$mem" "$mem_used" "$mem_total" "$load1" "$load5" "$load15" "$uptime_sec" "$disk_reads" "$disk_writes" "$net_rx" "$net_tx"
`;
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 30_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_run_watch") {
    const validErr = validateInput(name, args);
    if (validErr) return textResult(validErr, true);

    const cacheKey = `${args.target || args.host || "__default__"}::${args.command}`;

    if (args.resetCache === true) {
      _watchCache.delete(cacheKey);
    }

    const result = await runSshCommand({ retries: 0, ...args });
    const newOutput = formatRunResult(result);
    const prev = _watchCache.get(cacheKey);
    _watchCache.set(cacheKey, { output: newOutput, ts: new Date().toISOString() });

    if (!prev) {
      return textResult(`[watch] First run — full output:\n\n${newOutput}`, result.exitCode !== 0);
    }

    if (prev.output === newOutput) {
      return textResult(`[watch] No change since ${prev.ts}`);
    }

    const diff = unifiedDiff(`previous (${prev.ts})`, `current`, prev.output, newOutput, 3);
    return textResult(`[watch] Changed since ${prev.ts}:\n\n${diff || "(diff empty — whitespace only?)"}`, result.exitCode !== 0);
  }

  // Dispatch to extra tool modules
  for (const mod of _extraModules) {
    if (typeof mod.handleTool === "function") {
      const r = await mod.handleTool(name, args);
      if (r !== null && r !== undefined) return r;
    }
  }

  return textResult(`Unknown tool: ${name}`, true);
}

const AUDIT_LOG = join(PLUGIN_ROOT, "ssh-ops-audit.log");
const SERVER_LOG = join(PLUGIN_ROOT, "ssh-ops-server.log");

// ── Server logger ─────────────────────────────────────────────────────────────
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let _logLevel = 1; // info
let _logShipQueue = [];
let _logShipTimer = null;

function initLogger() {
  try {
    const cfg = getConfig();
    _logLevel = LOG_LEVELS[String(cfg.logLevel || "info").toLowerCase()] ?? 1;
  } catch {}
}

function serverLog(level, message, meta = {}) {
  try {
    const numLevel = LOG_LEVELS[level] ?? 1;
    if (numLevel < _logLevel) return;
    const entry = {
      ts: new Date().toISOString(),
      level: level.toUpperCase(),
      msg: message,
      ...(Object.keys(meta).length > 0 && { meta })
    };
    appendFileSync(SERVER_LOG, JSON.stringify(entry) + "\n");
    _queueForShipping(entry);
  } catch {}
}

// ── Richer audit log ──────────────────────────────────────────────────────────
function writeAuditLog(name, args, result, extra = {}) {
  try {
    const safeArgs = { ...args };
    if (safeArgs.password) safeArgs.password = "[REDACTED]";
    if (safeArgs.content && String(safeArgs.content).length > 200) safeArgs.content = "[TRUNCATED]";
    const entry = {
      ts: new Date().toISOString(),
      tool: name,
      target: args?.target || args?.host || null,
      sudo: args?.sudo === true || undefined,
      dryRun: args?.dryRun === true || undefined,
      reason: args?.reason || undefined,
      isError: result?.isError ?? false,
      ...(extra.durationMs !== undefined && { durationMs: extra.durationMs }),
      ...(extra.exitCode !== undefined && { exitCode: extra.exitCode }),
      args: safeArgs
    };
    // Strip undefined keys
    const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
    appendFileSync(AUDIT_LOG, JSON.stringify(clean) + "\n");
    _queueForShipping({ ...clean, _log: "audit" });
  } catch {}
}

// ── Remote log shipper ────────────────────────────────────────────────────────
function _queueForShipping(entry) {
  try {
    const cfg = getConfig();
    if (!cfg.logShip?.url) return;
    _logShipQueue.push(entry);
    const batchSize = cfg.logShip.batchSize ?? 20;
    const flushMs = cfg.logShip.flushIntervalMs ?? 5000;
    if (_logShipQueue.length >= batchSize) {
      _flushLogShip();
    } else if (!_logShipTimer) {
      _logShipTimer = setTimeout(_flushLogShip, flushMs);
    }
  } catch {}
}

function _flushLogShip() {
  _logShipTimer = null;
  const batch = _logShipQueue.splice(0);
  if (batch.length === 0) return;
  try {
    const cfg = getConfig();
    const shipCfg = cfg.logShip;
    if (!shipCfg?.url) return;
    const body = JSON.stringify({ entries: batch, source: "ssh-ops", version: SERVER_VERSION });
    let parsedUrl;
    try { parsedUrl = new URL(shipCfg.url); } catch { return; }
    const isHttps = parsedUrl.protocol === "https:";
    const transport = isHttps ? https : null;
    if (!transport) return; // only HTTPS shipping supported
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...(shipCfg.headers || {})
    };
    const req = transport.request(
      { hostname: parsedUrl.hostname, path: parsedUrl.pathname + (parsedUrl.search || ""),
        port: parsedUrl.port || 443, method: shipCfg.method || "POST", headers },
      (res) => { res.resume(); }
    );
    req.on("error", () => {});
    req.write(body);
    req.end();
  } catch {}
}

const _rateLimitWindows = new Map(); // target → timestamps[]
const _watchCache = new Map(); // key: `${target}::${command}` -> { output: string, ts: string }

function checkRateLimit(target, limitPerMin) {
  if (!limitPerMin || limitPerMin <= 0) return null;
  const now = Date.now();
  const window = 60_000;
  const key = target || "__default__";
  let timestamps = _rateLimitWindows.get(key) || [];
  timestamps = timestamps.filter(t => now - t < window);
  if (timestamps.length >= limitPerMin) {
    const oldest = timestamps[0];
    const retryAfterSec = Math.ceil((oldest + window - now) / 1000);
    return `Rate limit exceeded for target "${key}" (${limitPerMin} calls/min). Retry after ${retryAfterSec}s.`;
  }
  timestamps.push(now);
  _rateLimitWindows.set(key, timestamps);
  return null;
}

function textResult(text, isError = false) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ],
    isError
  };
}

function requireConfirm(toolName, args) {
  const reasonNote = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${reasonNote}`, true);
}

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

function unifiedDiff(labelA, labelB, textA, textB, context = 3) {
  const linesA = textA.split("\n");
  const linesB = textB.split("\n");
  const m = linesA.length, n = linesB.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = linesA[i] === linesB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && linesA[i] === linesB[j]) {
      ops.push({ type: "=", a: i, b: j }); i++; j++;
    } else if (j < n && (i >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      ops.push({ type: "+", b: j }); j++;
    } else {
      ops.push({ type: "-", a: i }); i++;
    }
  }
  const changed = ops.reduce((acc, op, idx) => { if (op.type !== "=") acc.push(idx); return acc; }, []);
  if (changed.length === 0) return "";
  const hunks = [];
  let h = null;
  for (const ci of changed) {
    const start = Math.max(0, ci - context), end = Math.min(ops.length - 1, ci + context);
    if (!h || start > h.end + 1) { if (h) hunks.push(h); h = { start, end, ops: [] }; }
    h.end = Math.max(h.end, end);
  }
  if (h) hunks.push(h);
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  for (const hunk of hunks) {
    const slice = ops.slice(hunk.start, hunk.end + 1);
    const aStart = slice.find(o => o.a !== undefined)?.a ?? 0;
    const bStart = slice.find(o => o.b !== undefined)?.b ?? 0;
    const aCount = slice.filter(o => o.type !== "+").length;
    const bCount = slice.filter(o => o.type !== "-").length;
    out.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (const op of slice) {
      if (op.type === "=") out.push(` ${linesA[op.a]}`);
      else if (op.type === "+") out.push(`+${linesB[op.b]}`);
      else out.push(`-${linesA[op.a]}`);
    }
  }
  return out.join("\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      void handleLine(line);
    }
  }
});

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    sendError(null, -32700, `Parse error: ${error.message}`);
    return;
  }

  if (!message.id && message.id !== 0) {
    return;
  }

  try {
    const handler = handlers[message.method];
    if (!handler) {
      sendError(message.id, -32601, `Method not found: ${message.method}`);
      return;
    }
    const result = await handler(message);
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    sendError(message.id, -32603, error.stack || error.message || String(error));
  }
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendError(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  });
}
