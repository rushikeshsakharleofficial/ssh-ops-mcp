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
import https from "node:https";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROTOCOL_VERSION = "2025-06-18";
const RELEASES_API = "https://api.github.com/repos/rushikeshsakharleofficial/ssh-ops-mcp/releases/latest";
const UPDATE_FILES = [
  "scripts/ssh-mcp-server.mjs",
  "scripts/ssh-core.mjs",
  "scripts/ssh-ops.mjs",
  "scripts/ssh-cli-options.mjs"
];

function httpsGetText(url, hops = 5) {
  return new Promise((resolve) => {
    if (hops <= 0) return resolve(null);
    const headers = { "User-Agent": "ssh-ops-mcp" };
    if (url.includes("api.github.com")) {
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

const tools = [
  {
    name: "ssh_profiles",
    title: "List SSH Ops Profiles",
    description: "List configured SSH Ops profiles and the default target. Does not connect to any host.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
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
        encoding: { type: "string", enum: ["text", "base64"], description: "text or base64. Default text." }
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
        sudo: { type: "boolean", description: "Run via sudo -n. Default true." }
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
        sudo: { type: "boolean", description: "Run mv via sudo." }
      },
      required: ["path"]
    }
  },
  {
    name: "ssh_run_multi",
    title: "Run SSH Command on Multiple Hosts",
    description: "Run a command on multiple SSH targets in parallel. Returns per-target results.",
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
        jumpHost: { type: "string", description: "SSH jump host (-J)." }
      },
      required: ["targets", "command"]
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
    description: "Manage packages on a remote host. Auto-detects apt/yum/dnf/apk. CONFIRM before install/remove/update/upgrade unless told to proceed automatically.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: {
          type: "string",
          enum: ["list", "search", "install", "remove", "update", "upgrade"],
          description: "Package action."
        },
        packages: { type: "array", items: { type: "string" }, description: "Package names." },
        sudo: { type: "boolean", description: "Use sudo -n. Default true." },
        timeoutMs: { type: "number", description: "Timeout ms. Default 120000." }
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
        command: { type: "string", description: "Command. Required for add/remove." }
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
        timeoutMs: { type: "number", description: "Timeout ms. Default 60000." }
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
        sudo: { type: "boolean", description: "Run via sudo. Default true for this tool." }
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
        sudo: { type: "boolean", description: "Run via sudo. Default false." }
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
        ruleFile: { type: "string", description: "Custom sudoers.d file path. Default /etc/sudoers.d/<username>." }
      },
      required: ["action"]
    }
  }
];

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
    void selfUpdate();
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
        version: "0.1.0"
      }
    };
    if (instructions) result.instructions = instructions;
    return result;
  },

  "tools/list"() {
    return { tools };
  },

  async "tools/call"(message) {
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    return callTool(name, args);
  },

  ping() {
    return {};
  }
};

async function callTool(name, args) {
  if (name === "ssh_profiles") {
    return textResult(JSON.stringify(listProfiles(), null, 2));
  }

  if (name === "ssh_run") {
    const result = await runSshCommand(args);
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
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_file_read") {
    const command = fileReadScript(args.path, args.maxBytes, args.encoding);
    const result = await runSshCommand({ ...args, command, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_file_write") {
    const command = fileWriteScript(args.path, args.content, {
      backup: args.backup !== false,
      sudo: Boolean(args.sudo),
      encoding: args.encoding
    });
    const result = await runSshCommand({ ...args, command, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_service") {
    const command = serviceScript(args.service, args.action, {
      sudo: args.sudo !== false
    });
    const result = await runSshCommand({ ...args, command, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_log_search") {
    const command = logSearchScript(args);
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 60_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_file_patch") {
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
    const result = await runSshCommand({ ...args, command, mode: "bash" });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_run_multi") {
    const results = await runMultiSshCommand(args.targets, {
      command: args.command,
      sudo: args.sudo,
      mode: args.mode,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      sshOptions: args.sshOptions,
      identityFile: args.identityFile,
      jumpHost: args.jumpHost
    });
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
    const command = packageScript({
      action: args.action,
      packages: Array.isArray(args.packages) ? args.packages : [],
      sudo: args.sudo !== false
    });
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 120_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_cron") {
    const command = cronScript({
      action: args.action,
      user: args.user,
      schedule: args.schedule,
      command: args.command
    });
    const result = await runSshCommand({ ...args, command, mode: "bash", timeoutMs: args.timeoutMs || 60_000 });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_add_profile") {
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
    const profiles = removeProfile(args.name);
    return textResult(JSON.stringify(profiles, null, 2));
  }

  if (name === "ssh_add_jump") {
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
    const result = removeJumpServer(args.name);
    return textResult(JSON.stringify(result, null, 2));
  }

  if (name === "ssh_list_jumps") {
    return textResult(JSON.stringify(listJumpServers(), null, 2));
  }

  if (name === "ssh_list_keys") {
    const keys = listLocalSshKeys();
    const out = keys.length > 0
      ? `Found ${keys.length} SSH private key(s):\n${keys.map((k) => `  ${k}`).join("\n")}`
      : "No SSH private keys found in ~/.ssh/ or home directory.";
    return textResult(out);
  }

  if (name === "ssh_ip_assign") {
    let resolved = { iface: args.iface, ips: args.ips, gateway: args.gateway, dns: args.dns };

    if (args.group) {
      const g = resolveIpGroup(args.group);
      resolved = { iface: g.iface, ips: g.ips, gateway: g.gateway, dns: g.dns, ...resolved };
    } else if (args.fromFile) {
      let raw;
      try { raw = readFileSync(args.fromFile, "utf8"); } catch (e) {
        return textResult(`Cannot read file: ${args.fromFile} — ${e.message}`, true);
      }
      let parsed;
      try {
        parsed = args.fromFile.match(/\.ya?ml$/i)
          ? parseYamlConfig(raw)
          : JSON.parse(raw);
      } catch (e) {
        return textResult(`Failed to parse ${args.fromFile}: ${e.message}`, true);
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
    const groups = saveIpGroup(args.name, {
      iface: args.iface,
      ips: args.ips,
      gateway: args.gateway,
      dns: args.dns
    });
    return textResult(JSON.stringify(groups, null, 2));
  }

  if (name === "ssh_remove_ip_group") {
    const groups = removeIpGroup(args.name);
    return textResult(JSON.stringify(groups, null, 2));
  }

  if (name === "ssh_list_ip_groups") {
    return textResult(JSON.stringify(listIpGroups(), null, 2));
  }

  if (name === "ssh_user") {
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
    const result = await runSshCommand({
      ...args,
      command,
      mode: "bash",
      sudo: args.sudo !== false
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_chmod") {
    const command = chmodScript({
      path: args.path,
      mode: args.mode,
      owner: args.owner,
      group: args.group,
      recursive: Boolean(args.recursive)
    });
    const result = await runSshCommand({
      ...args,
      command,
      mode: "bash",
      sudo: Boolean(args.sudo)
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_sudo_rule") {
    const command = sudoRuleScript({
      action: args.action,
      username: args.username,
      commands: args.commands || "ALL",
      runas: args.runas || "ALL:ALL",
      nopasswd: args.nopasswd !== false,
      ruleFile: args.ruleFile
    });
    const result = await runSshCommand({
      ...args,
      command,
      mode: "bash",
      sudo: true
    });
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  return textResult(`Unknown tool: ${name}`, true);
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
