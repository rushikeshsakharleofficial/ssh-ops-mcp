#!/usr/bin/env node
import {
  diskReportScript,
  formatRunResult,
  hardwareInventoryScript,
  healthReportScript,
  listProfiles,
  runSshCommand
} from "./ssh-core.mjs";

const PROTOCOL_VERSION = "2025-06-18";

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
];

const handlers = {
  initialize(message) {
    return {
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
