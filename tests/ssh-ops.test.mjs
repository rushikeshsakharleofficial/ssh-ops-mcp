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
