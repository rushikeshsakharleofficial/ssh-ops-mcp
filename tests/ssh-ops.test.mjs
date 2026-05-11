import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseOptions } from "../scripts/ssh-cli-options.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function writeTempConfig(config) {
  const dir = mkdtempSync(join(tmpdir(), "ssh-ops-test-"));
  const configPath = join(dir, "ssh-ops.config.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

function writeTempConfigYaml(source) {
  const dir = mkdtempSync(join(tmpdir(), "ssh-ops-test-"));
  const configPath = join(dir, "ssh-ops.config.yaml");
  writeFileSync(configPath, source.trimStart(), "utf8");
  return configPath;
}

test("loadConfig reads YAML profiles and defaults", async () => {
  const configPath = writeTempConfigYaml(`
defaultTarget: staging
defaults:
  connectTimeoutSec: 7
  strictHostKeyChecking: no
  timeoutMs: 45000
profiles:
  staging:
    host: example.test
    user: deploy
    port: 2222
    extraArgs: []
`);
  const previousConfig = process.env.SSH_OPS_CONFIG;
  process.env.SSH_OPS_CONFIG = configPath;

  try {
    const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=yaml-${Date.now()}`;
    const { loadConfig, resolveTarget } = await import(moduleUrl);
    const config = loadConfig();
    const target = resolveTarget({ target: "staging" });

    assert.equal(config.defaultTarget, "staging");
    assert.equal(config.defaults.timeoutMs, 45000);
    assert.equal(config.profiles.staging.host, "example.test");
    assert.deepEqual(target.sshArgs.slice(0, 6), [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=7",
      "-o",
      "StrictHostKeyChecking=no"
    ]);
  } finally {
    if (previousConfig === undefined) {
      delete process.env.SSH_OPS_CONFIG;
    } else {
      process.env.SSH_OPS_CONFIG = previousConfig;
    }
  }
});

test("resolveTarget rejects a profile that does not define a host", async () => {
  const configPath = writeTempConfig({
    defaultTarget: "broken",
    profiles: {
      broken: {
        user: "deploy"
      }
    }
  });
  const previousConfig = process.env.SSH_OPS_CONFIG;
  process.env.SSH_OPS_CONFIG = configPath;

  try {
    const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=missing-host-${Date.now()}`;
    const { resolveTarget } = await import(moduleUrl);

    assert.throws(
      () => resolveTarget({ target: "broken" }),
      /Profile "broken" does not define a host\./
    );
  } finally {
    if (previousConfig === undefined) {
      delete process.env.SSH_OPS_CONFIG;
    } else {
      process.env.SSH_OPS_CONFIG = previousConfig;
    }
  }
});

test("resolveTarget routes destination profiles through the configured jump profile", async () => {
  const configPath = writeTempConfig({
    defaults: {
      jumpProfile: "bastion",
      jumpUser: "relay",
      targetUser: "root"
    },
    profiles: {
      bastion: {
        host: "bastion.example.com",
        user: "operator"
      },
      app1: {
        host: "10.10.10.15"
      }
    }
  });
  const previousConfig = process.env.SSH_OPS_CONFIG;
  process.env.SSH_OPS_CONFIG = configPath;

  try {
    const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=jump-profile-${Date.now()}`;
    const { resolveTarget } = await import(moduleUrl);
    const target = resolveTarget({ target: "app1" });

    assert.equal(target.target, "operator@bastion.example.com");
    assert.deepEqual(target.remoteJump, {
      destination: "root@10.10.10.15",
      user: "relay"
    });
    assert.equal(target.targetLabel, "app1 via bastion");
    assert.equal(target.sshArgs.includes("-J"), false);
  } finally {
    if (previousConfig === undefined) {
      delete process.env.SSH_OPS_CONFIG;
    } else {
      process.env.SSH_OPS_CONFIG = previousConfig;
    }
  }
});

test("resolveTarget does not route the jump profile through itself", async () => {
  const configPath = writeTempConfig({
    defaults: {
      jumpProfile: "bastion",
      jumpUser: "relay",
      targetUser: "root"
    },
    profiles: {
      bastion: {
        host: "bastion.example.com",
        user: "operator"
      }
    }
  });
  const previousConfig = process.env.SSH_OPS_CONFIG;
  process.env.SSH_OPS_CONFIG = configPath;

  try {
    const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=jump-self-${Date.now()}`;
    const { resolveTarget } = await import(moduleUrl);
    const target = resolveTarget({ target: "bastion" });

    assert.equal(target.target, "operator@bastion.example.com");
    assert.equal(target.sshArgs.includes("-J"), false);
    assert.equal(target.remoteJump, null);
  } finally {
    if (previousConfig === undefined) {
      delete process.env.SSH_OPS_CONFIG;
    } else {
      process.env.SSH_OPS_CONFIG = previousConfig;
    }
  }
});

test("resolveTarget applies targetUser to raw destination targets routed through jump profile", async () => {
  const configPath = writeTempConfig({
    defaults: {
      jumpProfile: "bastion",
      jumpUser: "relay",
      targetUser: "root"
    },
    profiles: {
      bastion: {
        host: "bastion.example.com",
        user: "operator"
      }
    }
  });
  const previousConfig = process.env.SSH_OPS_CONFIG;
  process.env.SSH_OPS_CONFIG = configPath;

  try {
    const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=jump-raw-target-${Date.now()}`;
    const { resolveTarget } = await import(moduleUrl);
    const target = resolveTarget({ target: "198.51.100.20" });

    assert.equal(target.target, "operator@bastion.example.com");
    assert.deepEqual(target.remoteJump, {
      destination: "root@198.51.100.20",
      user: "relay"
    });
    assert.equal(target.targetLabel, "root@198.51.100.20 via bastion");
    assert.equal(target.sshArgs.includes("-J"), false);
  } finally {
    if (previousConfig === undefined) {
      delete process.env.SSH_OPS_CONFIG;
    } else {
      process.env.SSH_OPS_CONFIG = previousConfig;
    }
  }
});

test("parseOptions rejects missing option values before target resolution", () => {
  assert.throws(
    () => parseOptions(["--timeout-ms"]),
    /Option --timeout-ms requires a value\./
  );
  assert.throws(
    () => parseOptions(["--timeout-ms", "--port", "22"]),
    /Option --timeout-ms requires a value\./
  );
});

test("fileWriteScript uses SSH_OPS_WRITE delimiter prefix in heredoc", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=write-delim-${Date.now()}`;
  const { fileWriteScript } = await import(moduleUrl);
  const script = fileWriteScript("/etc/hosts", "127.0.0.1 localhost\n");
  assert.ok(script.includes("SSH_OPS_WRITE"), "heredoc delimiter should use SSH_OPS_WRITE prefix");
  assert.ok(!script.includes("SSH_OPS_REMOTE_SCRIPT"), "should not use remote script prefix");
});

test("fileReadScript includes head command with quoted path and byte cap", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=file-read-${Date.now()}`;
  const { fileReadScript } = await import(moduleUrl);
  const script = fileReadScript("/etc/nginx/nginx.conf", 1024);
  assert.ok(script.includes("head -c 1024"), "should contain head -c with byte cap");
  assert.ok(script.includes("'/etc/nginx/nginx.conf'"), "should contain shell-quoted path");
});

test("fileReadScript defaults to 51200 bytes", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=file-read-default-${Date.now()}`;
  const { fileReadScript } = await import(moduleUrl);
  const script = fileReadScript("/var/log/syslog");
  assert.ok(script.includes("head -c 51200"), "should use default 51200 bytes");
});
