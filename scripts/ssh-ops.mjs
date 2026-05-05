#!/usr/bin/env node
import {
  diskReportScript,
  formatRunResult,
  hardwareInventoryScript,
  healthReportScript,
  listProfiles,
  runSshCommand
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

function usage() {
  console.log(`SSH Ops

Usage:
  node scripts/ssh-ops.mjs profiles
  node scripts/ssh-ops.mjs run <target|profile> <command...>
  node scripts/ssh-ops.mjs inventory [target|profile]
  node scripts/ssh-ops.mjs disk [target|profile] [path] [depth]
  node scripts/ssh-ops.mjs health [target|profile]

Options:
  --sudo                  Run command through sudo -n bash -s
  --raw                   Pass command as the raw SSH remote command
  --timeout-ms <number>   Local command timeout
  --port <number>         SSH port override
  --identity-file <path>  SSH private key path
  --jump-host <target>    SSH jump host passed with -J
  --no-sudo               Disable sudo attempts in inventory

Config:
  Prefer ssh-ops.config.yaml in this plugin directory, or ~/.ssh/ssh-ops.yaml.
  JSON config remains supported for compatibility.

Profiles:
  Create ssh-ops.config.yaml from ssh-ops.config.example.yaml.
`);
}
