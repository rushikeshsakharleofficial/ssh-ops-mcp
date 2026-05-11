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

test("fileWriteScript includes backup cp and content by default", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=file-write-backup-${Date.now()}`;
  const { fileWriteScript } = await import(moduleUrl);
  const script = fileWriteScript("/etc/hosts", "127.0.0.1 localhost\n");
  assert.ok(script.includes("cp "), "should contain cp for backup");
  assert.ok(script.includes(".bak."), "should produce .bak. timestamped backup");
  assert.ok(script.includes("127.0.0.1 localhost"), "should embed content");
});

test("fileWriteScript skips backup when backup: false", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=file-write-no-backup-${Date.now()}`;
  const { fileWriteScript } = await import(moduleUrl);
  const script = fileWriteScript("/etc/hosts", "content", { backup: false });
  assert.ok(!script.includes("cp "), "should not contain cp when backup disabled");
});

test("fileWriteScript uses sudo tee when sudo: true", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=file-write-sudo-${Date.now()}`;
  const { fileWriteScript } = await import(moduleUrl);
  const script = fileWriteScript("/etc/nginx/nginx.conf", "worker_processes 1;", { sudo: true });
  assert.ok(script.includes("sudo tee"), "should use sudo tee");
});

test("serviceScript produces systemctl command with sudo -n by default", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=service-sudo-${Date.now()}`;
  const { serviceScript } = await import(moduleUrl);
  const script = serviceScript("nginx", "restart");
  assert.ok(script.includes("systemctl"), "should contain systemctl");
  assert.ok(script.includes("sudo -n"), "should use sudo -n by default");
  assert.ok(script.includes("nginx"), "should contain service name");
  assert.ok(script.includes("restart"), "should contain action");
});

test("serviceScript omits sudo when sudo: false", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=service-no-sudo-${Date.now()}`;
  const { serviceScript } = await import(moduleUrl);
  const script = serviceScript("nginx", "status", { sudo: false });
  assert.ok(!script.includes("sudo"), "should not contain sudo");
  assert.ok(script.includes("systemctl"), "should still contain systemctl");
});

test("serviceScript throws on invalid action", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=service-invalid-${Date.now()}`;
  const { serviceScript } = await import(moduleUrl);
  assert.throws(
    () => serviceScript("nginx", "delete"),
    /Invalid action: delete/
  );
});

test("logSearchScript produces journalctl command with unit and pattern", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=log-journal-${Date.now()}`;
  const { logSearchScript } = await import(moduleUrl);
  const script = logSearchScript({ unit: "nginx", pattern: "error", lines: 50 });
  assert.ok(script.includes("journalctl"), "should use journalctl");
  assert.ok(script.includes("-u"), "should filter by unit");
  assert.ok(script.includes("nginx"), "should contain unit name");
  assert.ok(script.includes("grep -E"), "should pipe to grep");
  assert.ok(script.includes("-n 50"), "should set line count");
});

test("logSearchScript greps file when path provided", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=log-file-${Date.now()}`;
  const { logSearchScript } = await import(moduleUrl);
  const script = logSearchScript({ path: "/var/log/nginx/error.log", pattern: "502" });
  assert.ok(script.includes("tail -n"), "should use tail");
  assert.ok(!script.includes("journalctl"), "should not use journalctl");
  assert.ok(script.includes("grep -E"), "should pipe to grep");
  assert.ok(script.includes("502"), "should contain pattern");
});

test("logSearchScript defaults to 100 lines", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=log-default-${Date.now()}`;
  const { logSearchScript } = await import(moduleUrl);
  const script = logSearchScript({});
  assert.ok(script.includes("-n 100"), "should default to 100 lines");
});

test("resolveTarget merges access:sudo from profile into options", async () => {
  const configPath = writeTempConfig({
    profiles: {
      myserver: {
        host: "1.2.3.4",
        user: "deploy",
        access: "sudo"
      }
    }
  });
  const previousConfig = process.env.SSH_OPS_CONFIG;
  process.env.SSH_OPS_CONFIG = configPath;

  try {
    const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=access-sudo-${Date.now()}`;
    const { resolveTarget } = await import(moduleUrl);
    const target = resolveTarget({ target: "myserver" });
    assert.equal(target.options.access, "sudo", "options.access should be 'sudo'");
  } finally {
    if (previousConfig === undefined) {
      delete process.env.SSH_OPS_CONFIG;
    } else {
      process.env.SSH_OPS_CONFIG = previousConfig;
    }
  }
});

test("fileReadScript with encoding base64 returns base64 command not head", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=file-read-b64-${Date.now()}`;
  const { fileReadScript } = await import(moduleUrl);
  const script = fileReadScript("/etc/ssl/cert.pem", 51200, "base64");
  assert.ok(script.includes("base64"), "should use base64 command");
  assert.ok(!script.includes("head"), "should not use head");
  assert.ok(script.includes("'/etc/ssl/cert.pem'"), "should include shell-quoted path");
});

test("fileWriteScript with encoding base64 uses base64 -d and preserves backup", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=file-write-b64-${Date.now()}`;
  const { fileWriteScript } = await import(moduleUrl);
  const script = fileWriteScript("/tmp/test.bin", "SGVsbG8=", { encoding: "base64" });
  assert.ok(script.includes("base64 -d"), "should use base64 -d decoder");
  assert.ok(script.includes("SGVsbG8="), "should contain base64 content in heredoc");
  assert.ok(script.includes(".bak."), "should backup by default");
});

test("filePatchScript throws when both startLine and pattern provided", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=patch-both-${Date.now()}`;
  const { filePatchScript } = await import(moduleUrl);
  assert.throws(
    () => filePatchScript("/etc/hosts", { startLine: 1, pattern: "foo" }),
    /Provide startLine or pattern, not both\./
  );
});

test("filePatchScript throws when neither startLine nor pattern provided", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=patch-neither-${Date.now()}`;
  const { filePatchScript } = await import(moduleUrl);
  assert.throws(
    () => filePatchScript("/etc/hosts", {}),
    /Provide startLine or pattern\./
  );
});

test("filePatchScript throws when endLine provided without startLine", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=patch-endonly-${Date.now()}`;
  const { filePatchScript } = await import(moduleUrl);
  assert.throws(
    () => filePatchScript("/etc/hosts", { endLine: 5 }),
    /endLine requires startLine\./
  );
});

test("filePatchScript line-range produces head/tail/heredoc script", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=patch-range-${Date.now()}`;
  const { filePatchScript } = await import(moduleUrl);
  const script = filePatchScript("/etc/hosts", { startLine: 3, endLine: 5, content: "new line\n" });
  assert.ok(script.includes("head -n"), "should use head");
  assert.ok(script.includes("tail -n +"), "should use tail");
  assert.ok(script.includes("SSH_OPS_PATCH"), "should use SSH_OPS_PATCH heredoc delimiter");
  assert.ok(script.includes("new line"), "should embed content");
  assert.ok(script.includes(".bak."), "should backup");
  assert.ok(script.includes("$_f.tmp"), "should write to temp file");
});

test("filePatchScript regex produces sed -E script with exported pattern vars", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=patch-regex-${Date.now()}`;
  const { filePatchScript } = await import(moduleUrl);
  const script = filePatchScript("/etc/nginx/nginx.conf", {
    pattern: "worker_processes [0-9]+",
    replacement: "worker_processes 4",
    flags: "g"
  });
  assert.ok(script.includes("sed -E"), "should use sed -E");
  assert.ok(script.includes("SSH_OPS_PATTERN"), "should export SSH_OPS_PATTERN");
  assert.ok(script.includes("SSH_OPS_REPLACEMENT"), "should export SSH_OPS_REPLACEMENT");
  assert.ok(script.includes("$_f.tmp"), "should use temp file");
  assert.ok(script.includes(".bak."), "should backup");
});

test("formatMultiRunResult text produces labeled sections per target", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=multi-text-${Date.now()}`;
  const { formatMultiRunResult } = await import(moduleUrl);
  const results = [
    { target: "prod", targetLabel: "prod", exitCode: 0, stdout: "web-01\n", stderr: "", durationMs: 200, timedOut: false },
    { target: "staging", targetLabel: "staging", exitCode: 1, stdout: "", stderr: "refused", durationMs: 150, timedOut: false }
  ];
  const out = formatMultiRunResult(results, "text");
  assert.ok(out.includes("=== prod ==="), "should label prod section");
  assert.ok(out.includes("=== staging ==="), "should label staging section");
  assert.ok(out.includes("web-01"), "should include prod stdout");
  assert.ok(out.includes("refused"), "should include staging stderr");
});

test("formatMultiRunResult json produces array with expected fields", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=multi-json-${Date.now()}`;
  const { formatMultiRunResult } = await import(moduleUrl);
  const results = [
    { target: "prod", targetLabel: "prod", exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 100, timedOut: false }
  ];
  const out = formatMultiRunResult(results, "json");
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].target, "prod");
  assert.equal(parsed[0].exitCode, 0);
  assert.equal(parsed[0].error, null);
});

test("formatMultiRunResult text shows error line for rejected target", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=multi-text-err-${Date.now()}`;
  const { formatMultiRunResult } = await import(moduleUrl);
  const results = [
    { target: "bad", exitCode: null, error: 'Profile "bad" does not define a host.' }
  ];
  const out = formatMultiRunResult(results, "text");
  assert.ok(out.includes("=== bad ==="), "should label bad section");
  assert.ok(out.includes('error: Profile "bad" does not define a host.'), "should show error message");
});

test("formatMultiRunResult json includes exitCode null and error string for rejected target", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=multi-json-err-${Date.now()}`;
  const { formatMultiRunResult } = await import(moduleUrl);
  const results = [
    { target: "bad", exitCode: null, error: "no host", stdout: "", stderr: "", durationMs: 0, timedOut: false }
  ];
  const out = formatMultiRunResult(results, "json");
  const parsed = JSON.parse(out);
  assert.equal(parsed[0].exitCode, null);
  assert.equal(parsed[0].error, "no host");
});

test("networkCheckScript with ping and port includes ping and /dev/tcp", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=net-check-${Date.now()}`;
  const { networkCheckScript } = await import(moduleUrl);
  const script = networkCheckScript({ host: "db.internal", port: 5432, ping: true });
  assert.ok(script.includes("ping"), "should include ping command");
  assert.ok(script.includes("/dev/tcp"), "should include /dev/tcp port check");
  assert.ok(script.includes("db.internal"), "should include host");
  assert.ok(script.includes("5432"), "should include port");
});

test("networkCheckScript throws when tls: true and no port", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=net-tls-noport-${Date.now()}`;
  const { networkCheckScript } = await import(moduleUrl);
  assert.throws(
    () => networkCheckScript({ host: "example.com", tls: true }),
    /port is required when tls: true/
  );
});

test("packageScript list includes auto-detect block for all managers", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=pkg-detect-${Date.now()}`;
  const { packageScript } = await import(moduleUrl);
  const script = packageScript({ action: "list" });
  assert.ok(script.includes("apt-get"), "should check for apt-get");
  assert.ok(script.includes("dnf"), "should check for dnf");
  assert.ok(script.includes("yum"), "should check for yum");
  assert.ok(script.includes("apk"), "should check for apk");
});

test("packageScript install throws when packages empty", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=pkg-nopkg-${Date.now()}`;
  const { packageScript } = await import(moduleUrl);
  assert.throws(
    () => packageScript({ action: "install", packages: [] }),
    /packages is required for install/
  );
});

test("packageScript install includes package names in script", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=pkg-install-${Date.now()}`;
  const { packageScript } = await import(moduleUrl);
  const script = packageScript({ action: "install", packages: ["nginx", "curl"] });
  assert.ok(script.includes("install"), "should contain install keyword");
  assert.ok(script.includes("nginx"), "should contain nginx");
  assert.ok(script.includes("curl"), "should contain curl");
});

test("cronScript list produces crontab -l command", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=cron-list-${Date.now()}`;
  const { cronScript } = await import(moduleUrl);
  const script = cronScript({ action: "list" });
  assert.ok(script.includes("crontab"), "should use crontab");
  assert.ok(script.includes("-l"), "should list crontab");
});

test("cronScript add includes schedule and command in heredoc", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=cron-add-${Date.now()}`;
  const { cronScript } = await import(moduleUrl);
  const script = cronScript({ action: "add", schedule: "0 * * * *", command: "/usr/bin/backup.sh" });
  assert.ok(script.includes("0 * * * *"), "should include schedule");
  assert.ok(script.includes("/usr/bin/backup.sh"), "should include command");
  assert.ok(script.includes("crontab -"), "should pipe to crontab");
});

test("cronScript add throws when schedule missing", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=cron-add-nosched-${Date.now()}`;
  const { cronScript } = await import(moduleUrl);
  assert.throws(
    () => cronScript({ action: "add", command: "/bin/backup.sh" }),
    /schedule is required for add/
  );
});

test("encryptPassword / decryptPassword round-trip", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=enc-roundtrip-${Date.now()}`;
  const { encryptPassword, decryptPassword } = await import(moduleUrl);
  const plaintext = "my$3cret!";
  const encrypted = encryptPassword(plaintext);
  assert.ok(typeof encrypted === "string", "encrypted is string");
  assert.notEqual(encrypted, plaintext);
  assert.equal(decryptPassword(encrypted), plaintext);
});

test("encryptPassword produces different ciphertext each call", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=enc-unique-${Date.now()}`;
  const { encryptPassword } = await import(moduleUrl);
  const a = encryptPassword("same-pass");
  const b = encryptPassword("same-pass");
  assert.notEqual(a, b, "IV randomness should produce different ciphertext");
});

test("addProfile adds profile to dynamic config and listProfiles returns it", async () => {
  const { existsSync, unlinkSync, readFileSync: rfs } = await import("node:fs");
  const dynPath = join(REPO_ROOT, "ssh-ops.dynamic.json");
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=add-profile-${Date.now()}`;
  const { addProfile, removeProfile } = await import(moduleUrl);
  try {
    const result = addProfile("test-add-profile", { host: "10.0.0.1", user: "admin" });
    assert.ok(result.profiles["test-add-profile"], "profile should be present after addProfile");
    assert.equal(result.profiles["test-add-profile"].host, "10.0.0.1");
  } finally {
    // clean up: remove test profile from dynamic config
    if (existsSync(dynPath)) {
      try { removeProfile("test-add-profile"); } catch {}
      const after = JSON.parse(rfs(dynPath, "utf8"));
      if (Object.keys(after.profiles || {}).length === 0) unlinkSync(dynPath);
    }
  }
});

test("addProfile throws on invalid name", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=add-badname-${Date.now()}`;
  const { addProfile } = await import(moduleUrl);
  assert.throws(
    () => addProfile("bad name!", { host: "1.2.3.4" }),
    /invalid profile name/i
  );
});

test("addProfile throws when host missing", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=add-nohost-${Date.now()}`;
  const { addProfile } = await import(moduleUrl);
  assert.throws(
    () => addProfile("myserver", {}),
    /host is required/i
  );
});

test("removeProfile throws when profile not in dynamic config", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=rm-notfound-${Date.now()}`;
  const { removeProfile } = await import(moduleUrl);
  assert.throws(
    () => removeProfile("nonexistent"),
    /not found in dynamic config/i
  );
});

test("addJumpServer adds to profiles with _isJumpServer and appends to jumpChain", async () => {
  const { existsSync, unlinkSync, readFileSync: rfs } = await import("node:fs");
  const dynPath = join(REPO_ROOT, "ssh-ops.dynamic.json");
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=add-jump-${Date.now()}`;
  const { addJumpServer, removeJumpServer } = await import(moduleUrl);
  try {
    const result = addJumpServer("test-jump-bastion", { host: "10.1.0.1", user: "ops", port: 2222 });
    assert.ok(result.jumpChain.includes("test-jump-bastion"), "should be in jumpChain");
    assert.ok(result.jumpServers["test-jump-bastion"], "should be in jumpServers");
    assert.equal(result.jumpServers["test-jump-bastion"].host, "10.1.0.1");
    assert.equal(result.jumpServers["test-jump-bastion"].port, 2222);
  } finally {
    if (existsSync(dynPath)) {
      try { removeJumpServer("test-jump-bastion"); } catch {}
      const after = JSON.parse(rfs(dynPath, "utf8"));
      if (Object.keys(after.profiles || {}).length === 0 && !after.defaults?.jumpChain?.length) {
        unlinkSync(dynPath);
      }
    }
  }
});

test("addJumpServer sets commonUser in dynamic defaults", async () => {
  const { existsSync, unlinkSync, readFileSync: rfs } = await import("node:fs");
  const dynPath = join(REPO_ROOT, "ssh-ops.dynamic.json");
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=add-jump-cu-${Date.now()}`;
  const { addJumpServer, removeJumpServer } = await import(moduleUrl);
  try {
    const result = addJumpServer(
      "test-jump-cu",
      { host: "10.1.0.2", user: "ops" },
      { commonUser: "ubuntu" }
    );
    assert.equal(result.commonUser, "ubuntu", "commonUser should be set");
  } finally {
    if (existsSync(dynPath)) {
      try { removeJumpServer("test-jump-cu"); } catch {}
      const after = JSON.parse(rfs(dynPath, "utf8"));
      if (Object.keys(after.profiles || {}).length === 0) unlinkSync(dynPath);
    }
  }
});

test("addJumpServer throws on invalid name", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=add-jump-badname-${Date.now()}`;
  const { addJumpServer } = await import(moduleUrl);
  assert.throws(() => addJumpServer("bad name!", { host: "1.2.3.4" }), /invalid jump server name/i);
});

test("removeJumpServer throws when not found", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=rm-jump-notfound-${Date.now()}`;
  const { removeJumpServer } = await import(moduleUrl);
  assert.throws(() => removeJumpServer("nonexistent-jump"), /not found/i);
});

test("resolveTarget uses jumpChain to build -J arg", async () => {
  const configPath = writeTempConfig({
    profiles: {
      bastion1: { host: "10.0.0.1", user: "ops" },
      bastion2: { host: "10.0.0.2", user: "relay" },
      target: { host: "10.0.0.99", user: "deploy" }
    },
    defaults: { jumpChain: ["bastion1", "bastion2"] }
  });
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=jump-chain-${Date.now()}`;
  process.env.SSH_OPS_CONFIG = configPath;
  const { resolveTarget } = await import(moduleUrl);
  const info = resolveTarget({ target: "target" });
  delete process.env.SSH_OPS_CONFIG;
  const jIdx = info.sshArgs.indexOf("-J");
  assert.ok(jIdx >= 0, "should have -J flag");
  assert.ok(info.sshArgs[jIdx + 1].includes("10.0.0.1"), "should include bastion1");
  assert.ok(info.sshArgs[jIdx + 1].includes("10.0.0.2"), "should include bastion2");
  assert.ok(info.target.includes("10.0.0.99"), "target should be final destination");
});

test("resolveTarget uses commonUser when profile has no user", async () => {
  const configPath = writeTempConfig({
    profiles: { myserver: { host: "10.0.0.5" } },
    defaults: { commonUser: "ubuntu" }
  });
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=common-user-${Date.now()}`;
  process.env.SSH_OPS_CONFIG = configPath;
  const { resolveTarget } = await import(moduleUrl);
  const info = resolveTarget({ target: "myserver" });
  delete process.env.SSH_OPS_CONFIG;
  assert.ok(info.target.includes("ubuntu@"), "target should use commonUser");
});

test("jumpChain skips for profiles that are in the chain themselves", async () => {
  const configPath = writeTempConfig({
    profiles: {
      bastion1: { host: "10.0.0.1", user: "ops" },
      target: { host: "10.0.0.99", user: "deploy" }
    },
    defaults: { jumpChain: ["bastion1"] }
  });
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=jump-chain-skip-${Date.now()}`;
  process.env.SSH_OPS_CONFIG = configPath;
  const { resolveTarget } = await import(moduleUrl);
  // connecting directly TO bastion1 should NOT add -J (it's in the chain)
  const info = resolveTarget({ target: "bastion1" });
  delete process.env.SSH_OPS_CONFIG;
  assert.ok(!info.sshArgs.includes("-J"), "should not add -J when target is in the chain");
});

test("ipAssignScript throws when iface missing", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=ip-no-iface-${Date.now()}`;
  const { ipAssignScript } = await import(moduleUrl);
  assert.throws(() => ipAssignScript({ ips: ["10.0.0.1/24"] }), /iface.*required/i);
});

test("ipAssignScript throws when ips empty", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=ip-no-ips-${Date.now()}`;
  const { ipAssignScript } = await import(moduleUrl);
  assert.throws(() => ipAssignScript({ iface: "eth0", ips: [] }), /ips array is required/i);
});

test("ipAssignScript throws on invalid CIDR", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=ip-bad-cidr-${Date.now()}`;
  const { ipAssignScript } = await import(moduleUrl);
  assert.throws(() => ipAssignScript({ iface: "eth0", ips: ["192.168.1.100"] }), /Invalid CIDR/i);
});

test("ipAssignScript includes interface and IPs in script", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=ip-script-${Date.now()}`;
  const { ipAssignScript } = await import(moduleUrl);
  const script = ipAssignScript({ iface: "eth0", ips: ["192.168.1.100/24", "10.0.0.5/16"] });
  assert.ok(script.includes("eth0"), "should include interface");
  assert.ok(script.includes("192.168.1.100/24"), "should include first IP");
  assert.ok(script.includes("10.0.0.5/16"), "should include second IP");
  assert.ok(script.includes("detect_method"), "should include method detection");
  assert.ok(script.includes("netplan"), "should handle netplan");
  assert.ok(script.includes("networkmanager"), "should handle NetworkManager");
  assert.ok(script.includes("network-scripts"), "should handle network-scripts");
  assert.ok(script.includes("networkd"), "should handle systemd-networkd");
  assert.ok(script.includes("rc.local"), "should handle rc.local");
});

test("ipAssignScript includes gateway and DNS when provided", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=ip-gw-dns-${Date.now()}`;
  const { ipAssignScript } = await import(moduleUrl);
  const script = ipAssignScript({
    iface: "ens3",
    ips: ["10.0.0.10/24"],
    gateway: "10.0.0.1",
    dns: ["8.8.8.8", "1.1.1.1"]
  });
  assert.ok(script.includes("10.0.0.1"), "should include gateway");
  assert.ok(script.includes("8.8.8.8"), "should include first DNS");
  assert.ok(script.includes("1.1.1.1"), "should include second DNS");
});

test("saveIpGroup and listIpGroups round-trip", async () => {
  const { existsSync, unlinkSync, readFileSync: rfs } = await import("node:fs");
  const dynPath = join(REPO_ROOT, "ssh-ops.dynamic.json");
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=ip-group-${Date.now()}`;
  const { saveIpGroup, removeIpGroup, listIpGroups } = await import(moduleUrl);
  try {
    const groups = saveIpGroup("test-web-cluster", {
      iface: "eth0",
      ips: ["10.0.0.100/24", "10.0.0.101/24"],
      gateway: "10.0.0.1"
    });
    assert.ok(groups["test-web-cluster"], "group should exist after save");
    assert.deepEqual(groups["test-web-cluster"].ips, ["10.0.0.100/24", "10.0.0.101/24"]);
    assert.equal(groups["test-web-cluster"].iface, "eth0");
    assert.equal(groups["test-web-cluster"].gateway, "10.0.0.1");
  } finally {
    if (existsSync(dynPath)) {
      try { removeIpGroup("test-web-cluster"); } catch {}
      const after = JSON.parse(rfs(dynPath, "utf8"));
      if (Object.keys(after.profiles || {}).length === 0 && !after.ipGroups) unlinkSync(dynPath);
    }
  }
});

test("saveIpGroup throws on invalid name", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=ip-group-badname-${Date.now()}`;
  const { saveIpGroup } = await import(moduleUrl);
  assert.throws(() => saveIpGroup("bad name!", { ips: ["10.0.0.1/24"] }), /invalid group name/i);
});

test("resolveIpGroup throws when group not found", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=ip-group-notfound-${Date.now()}`;
  const { resolveIpGroup } = await import(moduleUrl);
  assert.throws(() => resolveIpGroup("nonexistent-group"), /not found/i);
});

test("userManageScript list returns getent passwd script", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=user-list-${Date.now()}`;
  const { userManageScript } = await import(moduleUrl);
  const s = userManageScript({ action: "list" });
  assert.ok(s.includes("getent passwd"), "should include getent passwd");
  assert.ok(s.includes("getent group"), "should include getent group");
});

test("userManageScript add includes useradd and chpasswd", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=user-add-${Date.now()}`;
  const { userManageScript } = await import(moduleUrl);
  const s = userManageScript({ action: "add", username: "testuser", password: "secret", groups: ["sudo", "docker"] });
  assert.ok(s.includes("useradd"), "should include useradd");
  assert.ok(s.includes("chpasswd"), "should include chpasswd");
  assert.ok(s.includes("usermod"), "should add to groups via usermod");
  assert.ok(s.includes("testuser"), "should include username");
});

test("userManageScript del with removeHome includes -r flag", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=user-del-${Date.now()}`;
  const { userManageScript } = await import(moduleUrl);
  const s = userManageScript({ action: "del", username: "olduser", removeHome: true });
  assert.ok(s.includes("userdel"), "should include userdel");
  assert.ok(s.includes("-r"), "should include -r flag for home removal");
});

test("userManageScript throws when action missing", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=user-noact-${Date.now()}`;
  const { userManageScript } = await import(moduleUrl);
  assert.throws(() => userManageScript({}), /action is required/i);
});

test("userManageScript throws when username missing for non-list action", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=user-nouser-${Date.now()}`;
  const { userManageScript } = await import(moduleUrl);
  assert.throws(() => userManageScript({ action: "add" }), /username is required/i);
});

test("chmodScript includes chmod and chown", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=chmod-${Date.now()}`;
  const { chmodScript } = await import(moduleUrl);
  const s = chmodScript({ path: "/var/www", mode: "755", owner: "www-data", group: "www-data", recursive: true });
  assert.ok(s.includes("chmod"), "should include chmod");
  assert.ok(s.includes("chown"), "should include chown");
  assert.ok(s.includes("-R"), "should include recursive flag");
  assert.ok(s.includes("755"), "should include mode");
  assert.ok(s.includes("www-data"), "should include owner/group");
});

test("chmodScript throws when path missing", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=chmod-nopath-${Date.now()}`;
  const { chmodScript } = await import(moduleUrl);
  assert.throws(() => chmodScript({ mode: "755" }), /path is required/i);
});

test("chmodScript throws when no mode/owner/group provided", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=chmod-nothing-${Date.now()}`;
  const { chmodScript } = await import(moduleUrl);
  assert.throws(() => chmodScript({ path: "/tmp/x" }), /mode.*owner.*group/i);
});

test("sudoRuleScript add includes visudo -c validation", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=sudo-add-${Date.now()}`;
  const { sudoRuleScript } = await import(moduleUrl);
  const s = sudoRuleScript({ action: "add", username: "deploy", commands: "/bin/systemctl", nopasswd: true });
  assert.ok(s.includes("visudo -c"), "should validate with visudo -c");
  assert.ok(s.includes("NOPASSWD"), "should include NOPASSWD");
  assert.ok(s.includes("/bin/systemctl"), "should include command");
  assert.ok(s.includes("sudoers.d"), "should write to sudoers.d");
});

test("sudoRuleScript list includes /etc/sudoers content", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=sudo-list-${Date.now()}`;
  const { sudoRuleScript } = await import(moduleUrl);
  const s = sudoRuleScript({ action: "list" });
  assert.ok(s.includes("/etc/sudoers"), "should include sudoers path");
  assert.ok(s.includes("sudoers.d"), "should include sudoers.d dir");
});

test("shellQuote escapes single quotes in special-char targets", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=shellquote-special-${Date.now()}`;
  const { fileReadScript } = await import(moduleUrl);
  // Path containing single quote — shellQuote must escape it so script is valid
  const script = fileReadScript("/var/log/it's-a-test.log", 1024);
  assert.ok(!script.includes("it's-a-test"), "raw single-quote should not appear unescaped");
  assert.ok(script.includes("it'\\''s-a-test"), "single quote should be escaped via '\\'' pattern");
});

test("resolveTarget with localSwitchUser in profile populates options.localSwitchUser", async () => {
  const configPath = writeTempConfig({
    profiles: {
      internal: {
        host: "10.0.1.5",
        user: "app",
        localSwitchUser: "relay"
      }
    }
  });
  const previousConfig = process.env.SSH_OPS_CONFIG;
  process.env.SSH_OPS_CONFIG = configPath;

  try {
    const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=local-switch-${Date.now()}`;
    const { resolveTarget } = await import(moduleUrl);
    const target = resolveTarget({ target: "internal" });
    assert.equal(target.options.localSwitchUser, "relay", "options.localSwitchUser should be relay");
  } finally {
    if (previousConfig === undefined) {
      delete process.env.SSH_OPS_CONFIG;
    } else {
      process.env.SSH_OPS_CONFIG = previousConfig;
    }
  }
});

test("decryptPassword throws on corrupted ciphertext", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=dec-corrupt-${Date.now()}`;
  const { decryptPassword } = await import(moduleUrl);
  assert.throws(
    () => decryptPassword("aGVsbG8="),
    (err) => err instanceof Error,
    "decryptPassword should throw on invalid ciphertext"
  );
});

test("formatRunResult marks truncated flag and includes byte count in output", async () => {
  const moduleUrl = `${pathToFileURL(join(REPO_ROOT, "scripts/ssh-core.mjs")).href}?case=truncate-fmt-${Date.now()}`;
  const { formatRunResult } = await import(moduleUrl);
  const result = {
    exitCode: 0,
    stdout: "partial output\n[OUTPUT TRUNCATED: received 2000000 bytes, limit 500 bytes — 1999500 bytes dropped]",
    stderr: "",
    stdoutTruncated: true,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 42
  };
  const out = formatRunResult(result);
  assert.ok(out.includes("stdoutTruncated: true"), "formatted output should flag stdoutTruncated");
  assert.ok(out.includes("OUTPUT TRUNCATED"), "formatted output should include truncation notice");
  assert.ok(out.includes("2000000"), "truncation notice should include total byte count");
});
