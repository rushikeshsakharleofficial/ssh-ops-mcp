import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SCRIPT = join(REPO_ROOT, "scripts/ssh-mcp-server.mjs");

async function mcpRequest(msg) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, SSH_OPS_AUTO_UPDATE: "0" }
    });

    const rl = createInterface({ input: child.stdout });
    let answered = false;

    rl.once("line", (line) => {
      answered = true;
      rl.close();
      child.stdin.end();
      try {
        res(JSON.parse(line));
      } catch (e) {
        rej(new Error(`Non-JSON response: ${line}`));
      }
    });

    child.on("error", rej);

    const timer = setTimeout(() => {
      if (!answered) {
        child.kill();
        rej(new Error("mcpRequest timed out after 5 s"));
      }
    }, 5000);

    rl.once("close", () => clearTimeout(timer));

    child.stdin.write(`${JSON.stringify(msg)}\n`);
  });
}

test("initialize returns protocolVersion and serverInfo.name ssh-ops", async () => {
  const res = await mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" }
  });
  assert.ok(res.result, "should have result");
  assert.equal(res.result.serverInfo.name, "ssh-ops");
  assert.ok(res.result.serverInfo.version, "version should be non-empty");
  assert.notEqual(res.result.serverInfo.version, "0.1.0", "version should not be placeholder");
  assert.ok(res.result.protocolVersion, "should echo a protocolVersion");
});

test("tools/list returns array of at least 20 tools", async () => {
  const res = await mcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  assert.ok(res.result, "should have result");
  assert.ok(Array.isArray(res.result.tools), "tools should be an array");
  assert.ok(res.result.tools.length >= 20, `expected >=20 tools, got ${res.result.tools.length}`);
  const names = res.result.tools.map((t) => t.name);
  assert.ok(names.includes("ssh_run"), "should include ssh_run");
  assert.ok(names.includes("ssh_profiles"), "should include ssh_profiles");
});

test("unknown method returns JSON-RPC error", async () => {
  const res = await mcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "no_such_method",
    params: {}
  });
  assert.ok(res.error, "should have error field");
  assert.equal(res.error.code, -32601, "should be Method Not Found code");
});

test("bad JSON returns parse error response", async () => {
  const parseErrorResponse = await new Promise((res, rej) => {
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, SSH_OPS_AUTO_UPDATE: "0" }
    });

    const rl = createInterface({ input: child.stdout });
    let answered = false;

    rl.once("line", (line) => {
      answered = true;
      rl.close();
      child.stdin.end();
      try {
        res(JSON.parse(line));
      } catch (e) {
        rej(new Error(`Non-JSON response: ${line}`));
      }
    });

    child.on("error", rej);

    const timer = setTimeout(() => {
      if (!answered) {
        child.kill();
        rej(new Error("bad-JSON test timed out"));
      }
    }, 5000);

    rl.once("close", () => clearTimeout(timer));

    child.stdin.write("this is not json\n");
  });

  assert.ok(parseErrorResponse.error, "should have error field");
  assert.equal(parseErrorResponse.error.code, -32700, "should be Parse Error code");
});

test("ping returns empty result object", async () => {
  const res = await mcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "ping",
    params: {}
  });
  assert.ok(res.result !== undefined, "should have result");
  assert.deepEqual(res.result, {}, "ping result should be {}");
});
