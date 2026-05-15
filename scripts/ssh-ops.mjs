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

  if (command === "export") {
    const { createInterface } = await import("node:readline");
    const { createCipheriv, pbkdf2Sync, randomBytes } = await import("node:crypto");
    const { writeFileSync } = await import("node:fs");
    const outFile = rest[0];
    if (!outFile) { console.error("Usage: ssh-ops export <output-file.enc>"); process.exit(1); }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const passphrase = await new Promise(res => rl.question("Passphrase: ", a => { rl.close(); res(a.trim()); }));
    if (!passphrase) { console.error("Passphrase required."); process.exit(1); }

    const profiles = listProfiles();
    const payload = JSON.stringify(profiles);
    const salt = randomBytes(16);
    const key = pbkdf2Sync(passphrase, salt, 100000, 32, "sha256");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const bundle = JSON.stringify({
      v: 1,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      data: enc.toString("hex")
    });
    writeFileSync(outFile, bundle, { mode: 0o600 });
    console.log(`Exported ${Object.keys(profiles.profiles || {}).length} profile(s) to ${outFile}`);
    process.exit(0);
  }

  if (command === "import") {
    const { createInterface } = await import("node:readline");
    const { createDecipheriv, pbkdf2Sync } = await import("node:crypto");
    const { readFileSync: rfs } = await import("node:fs");
    const inFile = rest[0];
    if (!inFile) { console.error("Usage: ssh-ops import <input-file.enc>"); process.exit(1); }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const passphrase = await new Promise(res => rl.question("Passphrase: ", a => { rl.close(); res(a.trim()); }));
    if (!passphrase) { console.error("Passphrase required."); process.exit(1); }

    let bundle;
    try { bundle = JSON.parse(rfs(inFile, "utf8")); } catch { console.error("Cannot read bundle file."); process.exit(1); }
    if (bundle.v !== 1) { console.error("Unknown bundle version."); process.exit(1); }

    const salt = Buffer.from(bundle.salt, "hex");
    const key = pbkdf2Sync(passphrase, salt, 100000, 32, "sha256");
    const iv = Buffer.from(bundle.iv, "hex");
    const tag = Buffer.from(bundle.tag, "hex");
    const enc = Buffer.from(bundle.data, "hex");
    let payload;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      payload = decipher.update(enc, undefined, "utf8") + decipher.final("utf8");
    } catch { console.error("Decryption failed — wrong passphrase or corrupted bundle."); process.exit(1); }

    let imported;
    try { imported = JSON.parse(payload); } catch { console.error("Bundle payload is not valid JSON."); process.exit(1); }

    let count = 0;
    for (const [name, prof] of Object.entries(imported.profiles || {})) {
      try {
        addProfile(name, { host: prof.host, user: prof.user, port: prof.port });
        count++;
      } catch {}
    }
    console.log(`Imported ${count} profile(s) from ${inFile}`);
    process.exit(0);
  }

  if (command === "add") {
    // Interactive profile wizard
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(res => rl.question(q, res));

    console.log("\n=== ssh-ops: Add Profile ===\n");
    const name = (await ask("Profile name (e.g. prod-web): ")).trim();
    if (!name) { console.error("Name required."); process.exit(1); }

    const host = (await ask("Host or IP: ")).trim();
    if (!host) { console.error("Host required."); process.exit(1); }

    const user = (await ask("SSH user (leave blank for system default): ")).trim() || undefined;
    const portStr = (await ask("Port (leave blank for 22): ")).trim();
    const port = portStr ? Number(portStr) : undefined;
    const identityFile = (await ask("Path to identity file (leave blank to skip): ")).trim() || undefined;
    const jumpProfile = (await ask("Jump profile name (leave blank to skip): ")).trim() || undefined;

    rl.close();

    const profileData = {
      host,
      ...(user && { user }),
      ...(port && { port }),
      ...(identityFile && { identityFile }),
      ...(jumpProfile && { jumpProfile })
    };

    console.log(`\nTesting connection to ${user ? user + "@" : ""}${host}${port ? ":" + port : ""}...`);
    try {
      const testResult = await runSshCommand({
        target: host,
        host,
        user,
        port,
        identityFile,
        command: "echo ssh-ops-test-ok",
        timeoutMs: 10000
      });
      if (testResult.exitCode === 0 && testResult.stdout.includes("ssh-ops-test-ok")) {
        console.log("✓ Connection successful.");
      } else {
        console.warn(`⚠ Connection test failed (exit ${testResult.exitCode}): ${testResult.stderr || testResult.stdout}`);
        const proceed = (await (async () => {
          const rl2 = createInterface({ input: process.stdin, output: process.stdout });
          return new Promise(res => rl2.question("Save anyway? (y/N): ", a => { rl2.close(); res(a); }));
        })()).trim().toLowerCase();
        if (proceed !== "y") { console.log("Aborted."); process.exit(0); }
      }
    } catch (e) {
      console.warn(`⚠ Connection test error: ${e.message}`);
    }

    const result = addProfile(name, profileData);
    console.log(`\nProfile "${name}" saved.`);
    console.log(JSON.stringify(result.profiles[name], null, 2));
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
  node scripts/ssh-ops.mjs add                    — interactive wizard to add and test a new profile
  node scripts/ssh-ops.mjs export <file.enc>      — export all profiles as encrypted bundle
  node scripts/ssh-ops.mjs import <file.enc>      — import profiles from encrypted bundle

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
