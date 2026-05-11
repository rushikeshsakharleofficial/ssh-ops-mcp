#!/usr/bin/env node
import {
  addJumpServer,
  addProfile,
  diskReportScript,
  fileReadScript,
  fileWriteScript,
  formatRunResult,
  hardwareInventoryScript,
  healthReportScript,
  listJumpServers,
  listProfiles,
  logSearchScript,
  networkCheckScript,
  packageScript,
  removeJumpServer,
  removeProfile,
  runSshCommand,
  serviceScript
} from "./ssh-core.mjs";
import { parseOptions } from "./ssh-cli-options.mjs";

const [command, ...rest] = process.argv.slice(2);

try {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    process.exit(0);
  }

  if (command === "profiles") {
    console.log(JSON.stringify(listProfiles(), null, 2));
    process.exit(0);
  }

  if (command === "run") {
    const { options, positional } = parseOptions(rest);
    const target = positional.shift();
    const remoteCommand = positional.join(" ");
    if (!remoteCommand) {
      throw new Error("run requires a target/profile and command.");
    }
    await printRun({
      ...options,
      target,
      command: remoteCommand,
      sudo: Boolean(options.sudo),
      mode: options.raw ? "raw" : "bash"
    });
    process.exit(0);
  }

  if (command === "inventory") {
    const { options, positional } = parseOptions(rest);
    const target = positional.shift();
    await printRun({
      ...options,
      target,
      command: hardwareInventoryScript({ includeSudo: options.includeSudo !== false }),
      mode: "bash",
      timeoutMs: options.timeoutMs || 180_000
    });
    process.exit(0);
  }

  if (command === "disk") {
    const { options, positional } = parseOptions(rest);
    const target = positional.shift();
    const path = positional.shift() || options.path || "/";
    const depth = positional.shift() || options.depth || 1;
    await printRun({
      ...options,
      target,
      command: diskReportScript({ path, depth }),
      mode: "bash",
      timeoutMs: options.timeoutMs || 180_000
    });
    process.exit(0);
  }

  if (command === "health") {
    const { options, positional } = parseOptions(rest);
    const target = positional.shift();
    await printRun({
      ...options,
      target,
      command: healthReportScript(),
      mode: "bash",
      timeoutMs: options.timeoutMs || 120_000
    });
    process.exit(0);
  }

  if (command === "file-read") {
    const { options, positional } = parseOptions(rest);
    const target = positional.shift();
    const filePath = positional.shift();
    if (!target || !filePath) throw new Error("file-read requires <target> <path>.");
    await printRun({
      ...options,
      target,
      command: fileReadScript(filePath, options.maxBytes, options.encoding),
      mode: "bash"
    });
    process.exit(0);
  }

  if (command === "file-write") {
    const { options, positional } = parseOptions(rest);
    const target = positional.shift();
    const filePath = positional.shift();
    if (!target || !filePath) throw new Error("file-write requires <target> <path> <content|->");
    let content = positional.join(" ");
    if (content === "-" || (!content && positional.length === 0)) {
      content = await readStdin();
    }
    await printRun({
      ...options,
      target,
      command: fileWriteScript(filePath, content, { sudo: Boolean(options.sudo), backup: options.backup !== false }),
      mode: "bash"
    });
    process.exit(0);
  }

  if (command === "service") {
    const { options, positional } = parseOptions(rest);
    const target = positional.shift();
    const action = positional.shift();
    const unit = positional.shift();
    if (!target || !action || !unit) throw new Error("service requires <target> <action> <unit>.");
    await printRun({
      ...options,
      target,
      command: serviceScript(unit, action, { sudo: options.sudo !== false }),
      mode: "bash"
    });
    process.exit(0);
  }

  if (command === "logs") {
    const { options, positional } = parseOptions(rest);
    const target = positional.shift();
    if (!target) throw new Error("logs requires <target>.");
    await printRun({
      ...options,
      target,
      command: logSearchScript({
        unit: options.unit,
        lines: options.lines,
        since: options.since,
        pattern: options.pattern
      }),
      mode: "bash"
    });
    process.exit(0);
  }

  if (command === "package") {
    const { options, positional } = parseOptions(rest);
    const target = positional.shift();
    const action = positional.shift();
    if (!target || !action) throw new Error("package requires <target> <action> [<pkg>...].");
    const packages = positional;
    await printRun({
      ...options,
      target,
      command: packageScript({ action, packages, sudo: options.sudo !== false }),
      mode: "bash"
    });
    process.exit(0);
  }

  if (command === "network-check") {
    const { options, positional } = parseOptions(rest);
    const target = positional.shift();
    const host = positional.shift();
    if (!target || !host) throw new Error("network-check requires <target> <host> [<port>].");
    const port = positional.shift() || options.port;
    await printRun({
      ...options,
      target,
      command: networkCheckScript({ host, port, ping: options.ping !== false, tls: Boolean(options.tls) }),
      mode: "bash"
    });
    process.exit(0);
  }

  if (command === "profile") {
    const sub = rest[0];
    const subRest = rest.slice(1);
    if (sub === "add") {
      const { options, positional } = parseOptions(subRest);
      const name = positional.shift();
      const host = positional.shift();
      const user = positional.shift();
      if (!name || !host) throw new Error("profile add requires <name> <host> [<user>].");
      const result = addProfile(name, {
        host,
        ...(user && { user }),
        ...(options.port && { port: options.port }),
        ...(options.identity && { identityFile: options.identity }),
        ...(options.jump && { jumpProfile: options.jump })
      });
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    if (sub === "remove") {
      const { positional } = parseOptions(subRest);
      const name = positional.shift();
      if (!name) throw new Error("profile remove requires <name>.");
      const result = removeProfile(name);
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    throw new Error(`Unknown profile subcommand: ${sub}. Use: add, remove`);
  }

  if (command === "jump") {
    const sub = rest[0];
    const subRest = rest.slice(1);
    if (sub === "list") {
      console.log(JSON.stringify(listJumpServers(), null, 2));
      process.exit(0);
    }
    if (sub === "add") {
      const { options, positional } = parseOptions(subRest);
      const name = positional.shift();
      const host = positional.shift();
      const user = positional.shift();
      if (!name || !host) throw new Error("jump add requires <name> <host> [<user>].");
      const result = addJumpServer(name, { host, ...(user && { user }) });
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    if (sub === "remove") {
      const { positional } = parseOptions(subRest);
      const name = positional.shift();
      if (!name) throw new Error("jump remove requires <name>.");
      const result = removeJumpServer(name);
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    throw new Error(`Unknown jump subcommand: ${sub}. Use: list, add, remove`);
  }

  throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}

async function printRun(input) {
  const result = await runSshCommand(input);
  console.log(formatRunResult(result));
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode || 1;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function usage() {
  console.log(`SSH Ops

Usage:
  node scripts/ssh-ops.mjs profiles
  node scripts/ssh-ops.mjs run <target|profile> <command...>
  node scripts/ssh-ops.mjs inventory [target|profile]
  node scripts/ssh-ops.mjs disk [target|profile] [path] [depth]
  node scripts/ssh-ops.mjs health [target|profile]
  node scripts/ssh-ops.mjs file-read <target> <path>
  node scripts/ssh-ops.mjs file-write <target> <path> <content|->
  node scripts/ssh-ops.mjs service <target> <action> <unit>
  node scripts/ssh-ops.mjs logs <target> [--unit=<unit>] [--lines=N] [--since=<time>] [--pattern=<regex>]
  node scripts/ssh-ops.mjs package <target> <action> [<pkg>...]
  node scripts/ssh-ops.mjs network-check <target> <host> [<port>]
  node scripts/ssh-ops.mjs profile add <name> <host> [<user>] [--port=N] [--identity=<file>] [--jump=<profile>]
  node scripts/ssh-ops.mjs profile remove <name>
  node scripts/ssh-ops.mjs jump add <name> <host> [<user>]
  node scripts/ssh-ops.mjs jump remove <name>
  node scripts/ssh-ops.mjs jump list

Options (run/exec commands):
  --sudo                  Run command through sudo -n bash -s
  --raw                   Pass command as the raw SSH remote command
  --timeout-ms <number>   Local command timeout
  --port <number>         SSH port override
  --identity-file <path>  SSH private key path
  --jump-host <target>    SSH jump host passed with -J
  --no-sudo               Disable sudo attempts in inventory

service actions:   status | start | stop | restart | enable | disable
package actions:   list | install | remove | update | upgrade | search
file-write:        pass - as content to read from stdin

Config:
  Prefer ssh-ops.config.yaml in this plugin directory, or ~/.ssh/ssh-ops.yaml.
  JSON config remains supported for compatibility.

Profiles:
  Create ssh-ops.config.yaml from ssh-ops.config.example.yaml.
`);
}
