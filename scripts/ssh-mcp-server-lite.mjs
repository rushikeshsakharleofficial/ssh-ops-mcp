#!/usr/bin/env node
import {
  diskReportScript,
  fileReadScript,
  formatRunResult,
  healthReportScript,
  listProfiles,
  logSearchScript,
  runSshCommand
} from "./ssh-core.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "lite-1";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32_768;
const MAX_OUTPUT_BYTES = 65_536;
const DEFAULT_MAX_LINES = 100;
const MAX_LINES = 200;

const tools = [
  {
    name: "ssh_run",
    title: "Run bounded SSH command",
    description: "Run one bounded, token-safe SSH command. No live logs, broad scans, secret dumps, or destructive commands.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host." },
        host: { type: "string", description: "Host/IP when target/profile is omitted." },
        user: { type: "string", description: "SSH username when host is provided." },
        command: { type: "string", description: "Bounded read-only or diagnostic command." },
        cwd: { type: "string", description: "Optional remote working directory." },
        mode: { type: "string", enum: ["bash", "raw", "powershell"], description: "Execution mode. Default auto." },
        timeoutMs: { type: "number", description: "Timeout, capped at 30000ms. Default 20000." },
        maxOutputBytes: { type: "number", description: "Output byte cap, capped at 65536. Default 32768." }
      },
      required: ["command"]
    }
  },
  {
    name: "ssh_log_search",
    title: "Search bounded logs",
    description: "Search journal or a log file with bounded lines. Defaults to 100 lines; max 200.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host." },
        unit: { type: "string", description: "journalctl -u unit." },
        pattern: { type: "string", description: "grep -E pattern." },
        path: { type: "string", description: "Log file path instead of journal." },
        since: { type: "string", description: "journalctl since value, e.g. '30 min ago'." },
        lines: { type: "number", description: "Max lines, capped at 200." },
        timeoutMs: { type: "number", description: "Timeout, capped at 30000ms." }
      }
    }
  },
  {
    name: "ssh_health_report",
    title: "Health snapshot",
    description: "Bounded read-only health snapshot: load, memory, disk, failed units, recent boot errors, top processes.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host." },
        timeoutMs: { type: "number", description: "Timeout, capped at 30000ms." }
      }
    }
  },
  {
    name: "ssh_disk_report",
    title: "Disk snapshot",
    description: "Bounded disk/inode/du snapshot. Depth capped at 2 in lite mode.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host." },
        path: { type: "string", description: "Remote path. Default /." },
        depth: { type: "number", description: "du depth, capped at 2." },
        timeoutMs: { type: "number", description: "Timeout, capped at 30000ms." }
      }
    }
  },
  {
    name: "ssh_file_read",
    title: "Read bounded remote file",
    description: "Read first bytes of a remote text file. Default 32768 bytes; max 65536. No binary/base64 in lite mode.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host." },
        path: { type: "string", description: "Absolute remote path." },
        maxBytes: { type: "number", description: "Max bytes, capped at 65536." },
        timeoutMs: { type: "number", description: "Timeout, capped at 30000ms." }
      },
      required: ["path"]
    }
  },
  {
    name: "ssh_profiles",
    title: "List profiles",
    description: "List configured profiles without connecting to hosts.",
    inputSchema: { type: "object", properties: {} }
  }
];

function capNumber(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function tokenSafeArgs(args = {}) {
  return {
    ...args,
    timeoutMs: capNumber(args.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxOutputBytes: capNumber(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
    retries: 0
  };
}

function lineCap(text, maxLines = DEFAULT_MAX_LINES) {
  const lines = String(text || "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const cap = capNumber(maxLines, DEFAULT_MAX_LINES, MAX_LINES);
  if (lines.length <= cap) return lines.join("\n");
  return [
    ...lines.slice(0, cap),
    `... truncated ${lines.length - cap} lines; narrow command or raise limits intentionally ...`
  ].join("\n");
}

function denyReason(command) {
  const c = String(command || "").trim();
  const checks = [
    [/tail\s+.*(-f|--follow)/i, "live tail is blocked; use tail -n 100"],
    [/journalctl\s+.*(-f|--follow)/i, "journalctl follow is blocked"],
    [/docker\s+logs\s+.*(-f|--follow)/i, "docker logs follow is blocked"],
    [/kubectl\s+logs\s+.*(-f|--follow)/i, "kubectl logs follow is blocked"],
    [/\bwatch\b/i, "watch loops are blocked"],
    [/while\s+true|for\s*\(;;\)/i, "infinite loops are blocked"],
    [/\bcat\s+\/var\/log\b/i, "cat on /var/log is blocked; use grep/tail"],
    [/\bcat\s+.*\.(log|jsonl|dump|sql)\b/i, "cat on likely large file is blocked"],
    [/\bfind\s+\/\b/i, "find / is blocked"],
    [/\bls\s+-R\s+\/\b/i, "ls -R / is blocked"],
    [/\bgrep\s+.*(-r|-R)\s+\/\b/i, "recursive grep from / is blocked"],
    [/\b(printenv|env|set)\b\s*$/i, "raw environment dump is blocked"],
    [/\bcat\s+(~\/\.ssh|\.env|.*\.(pem|key))\b/i, "secret/private-key reads are blocked"],
    [/\brm\s+-rf\b|\bsudo\s+rm\b/i, "destructive delete is blocked"],
    [/\b(chmod\s+-R\s+777|chown\s+-R|mkfs|wipefs|fdisk|parted|dd\s+if=)\b/i, "disk/permission destructive command is blocked"],
    [/\b(systemctl|service)\s+(restart|stop)\b/i, "service restart/stop is blocked in lite mode"],
    [/\bkubectl\s+(apply|delete|patch|scale|rollout)\b/i, "mutating kubectl is blocked in lite mode"],
    [/\bterraform\s+(apply|destroy)\b/i, "terraform apply/destroy is blocked"],
    [/\b(ansible-playbook|npm\s+publish|docker\s+push)\b/i, "deployment/publish commands are blocked"],
    [/\b(curl|wget)\b.*\|\s*(sh|bash)/i, "pipe-to-shell installer is blocked"]
  ];
  for (const [re, reason] of checks) if (re.test(c)) return reason;
  if (/\bjournalctl\b/i.test(c) && !/(-n\s*\d+|--lines\s*=?\d+|--since|--until)/i.test(c)) return "unbounded journalctl is blocked";
  if (/\bdocker\s+logs\b/i.test(c) && !/(--tail\s*=?\d+|-n\s*\d+)/i.test(c)) return "unbounded docker logs is blocked";
  if (/\bkubectl\s+logs\b/i.test(c) && !/(--tail\s*=?\d+|--since|--limit-bytes)/i.test(c)) return "unbounded kubectl logs is blocked";
  if (/\b(tcpdump|ping)\b/i.test(c) && !/(\s-c\s*\d+|\s-c\d+)/i.test(c)) return "unbounded network command is blocked";
  return null;
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text: lineCap(text) }], isError };
}

async function handleTool(name, args = {}) {
  if (name === "ssh_profiles") return textResult(JSON.stringify(listProfiles(), null, 2));

  if (name === "ssh_run") {
    const reason = denyReason(args.command);
    if (reason) return textResult(`Blocked by ssh-ops-lite: ${reason}`, true);
    const result = await runSshCommand(tokenSafeArgs(args));
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_log_search") {
    const lines = capNumber(args.lines, DEFAULT_MAX_LINES, MAX_LINES);
    const command = logSearchScript({ ...args, lines });
    const reason = denyReason(command);
    if (reason) return textResult(`Blocked by ssh-ops-lite: ${reason}`, true);
    const result = await runSshCommand(tokenSafeArgs({ ...args, command, mode: "bash" }));
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_health_report") {
    const result = await runSshCommand(tokenSafeArgs({ ...args, command: healthReportScript(), mode: "bash" }));
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_disk_report") {
    const depth = Math.min(Number(args.depth) || 1, 2);
    const result = await runSshCommand(tokenSafeArgs({ ...args, command: diskReportScript({ path: args.path || "/", depth }), mode: "bash" }));
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  if (name === "ssh_file_read") {
    if (!String(args.path || "").startsWith("/")) return textResult("path must be absolute", true);
    if (/\/(\.ssh|\.aws|\.kube)\/|\.env|\.(pem|key)$/i.test(String(args.path))) return textResult("secret/key paths are blocked in lite mode", true);
    const maxBytes = capNumber(args.maxBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const result = await runSshCommand(tokenSafeArgs({ ...args, command: fileReadScript(args.path, maxBytes, "text"), mode: "bash" }));
    return textResult(formatRunResult(result), result.exitCode !== 0);
  }

  return textResult(`Unknown tool: ${name}`, true);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(req) {
  if (!req || typeof req !== "object" || req.id === undefined) return;
  try {
    if (req.method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "ssh-ops-lite", version: SERVER_VERSION }
        }
      });
    }
    if (req.method === "tools/list") {
      return send({ jsonrpc: "2.0", id: req.id, result: { tools } });
    }
    if (req.method === "tools/call") {
      const result = await handleTool(req.params?.name, req.params?.arguments || {});
      return send({ jsonrpc: "2.0", id: req.id, result });
    }
    return send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  } catch (e) {
    return send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: e?.message || String(e) } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const i = buf.indexOf("\n");
    if (i === -1) break;
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); }
    catch (e) { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: e.message } }); }
  }
});
