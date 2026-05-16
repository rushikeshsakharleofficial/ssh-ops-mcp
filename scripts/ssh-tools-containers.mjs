// ssh-tools-containers.mjs — container tools: ssh_compose, ssh_k8s
import { runSshCommand, formatRunResult } from "./ssh-core.mjs";

function shellQuote(v) { return `'${String(v).replace(/'/g, "'\\''")}'`; }
function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }
function dryRunResult(toolName, args, command, target) {
  return textResult(JSON.stringify({
    dryRun: true,
    tool: toolName,
    target: target || args.target || args.host || "(default)",
    sudo: Boolean(args.sudo),
    command: command || null,
    note: "dryRun:true — nothing executed"
  }, null, 2));
}
function requireConfirm(toolName, args) {
  const r = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${r}`, true);
}

function hasBadChars(v) {
  return /[\r\n\x00]/.test(String(v));
}

// ── Tool definitions ────────────────────────────────────────────────────────

export const toolDefs = [
  {
    name: "ssh_compose",
    title: "SSH Docker Compose Management",
    description: "Manage Docker Compose stacks on a remote host. Auto-detects docker compose v2 vs docker-compose v1. Mutating actions require confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        target:       { type: "string",  description: "Profile name or user@host" },
        action:       { type: "string",  enum: ["up","down","ps","logs","pull","build","restart","stop","config","exec"], description: "Compose action to run" },
        composeFile:  { type: "string",  description: "Absolute path to compose file (optional, auto-detected if omitted)" },
        service:      { type: "string",  description: "Specific service name (required for exec)" },
        detach:       { type: "boolean", description: "Run in background for up/restart (default true)" },
        lines:        { type: "number",  description: "Log lines for logs action (default 100)" },
        execCommand:  { type: "string",  description: "Command to run inside container for exec action" },
        sudo:         { type: "boolean", description: "Run with sudo (default false)" },
        confirm:      { type: "boolean", description: "Required for mutating actions: up/down/restart/stop/pull/build" },
        dryRun:       { type: "boolean", description: "Preview without executing" },
        reason:       { type: "string",  description: "Reason for the change" }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_k8s",
    title: "SSH Kubernetes (kubectl) Operations",
    description: "Run kubectl operations on a remote host. Covers get/describe/logs/exec/apply/delete/rollout/scale. Mutating actions require confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        target:         { type: "string",  description: "Profile name or user@host" },
        action:         { type: "string",  enum: ["get","describe","logs","exec","apply","delete","rollout","scale","top","events"], description: "kubectl action" },
        resource:       { type: "string",  description: "Resource type: pod/deployment/service/node/namespace/configmap/secret/ingress/statefulset/daemonset" },
        name:           { type: "string",  description: "Resource name (optional for get/describe)" },
        namespace:      { type: "string",  description: "Kubernetes namespace (default: default)" },
        selector:       { type: "string",  description: "Label selector for -l flag" },
        execCommand:    { type: "string",  description: "Command for exec action" },
        container:      { type: "string",  description: "Container name for logs/exec" },
        replicas:       { type: "number",  description: "Replica count for scale action" },
        rolloutAction:  { type: "string",  enum: ["status","history","undo","restart"], description: "Sub-action for rollout" },
        kubeconfig:     { type: "string",  description: "Absolute path to kubeconfig file" },
        allNamespaces:  { type: "boolean", description: "-A flag for get" },
        outputFormat:   { type: "string",  enum: ["wide","json","yaml","name"], description: "-o output format" },
        tailLines:      { type: "number",  description: "--tail for logs" },
        follow:         { type: "boolean", description: "-f for logs (bounded: max 30 seconds)" },
        sudo:           { type: "boolean", description: "Run with sudo (default false)" },
        confirm:        { type: "boolean", description: "Required for apply/delete/scale/rollout(restart/undo)" },
        dryRun:         { type: "boolean", description: "Preview without executing" },
        reason:         { type: "string",  description: "Reason for the change" }
      },
      required: ["action"]
    }
  }
];

// ── ssh_compose handler ──────────────────────────────────────────────────────

const COMPOSE_MUTATING = new Set(["up","down","restart","stop","pull","build"]);

async function handleCompose(args) {
  const VALID_ACTIONS = new Set(["up","down","ps","logs","pull","build","restart","stop","config","exec"]);

  const action = String(args.action || "");
  if (!VALID_ACTIONS.has(action)) {
    return textResult(`ssh_compose: invalid action "${action}". Valid: ${[...VALID_ACTIONS].join(", ")}`, true);
  }

  // exec requires service + execCommand
  if (action === "exec") {
    if (!args.service) return textResult("ssh_compose exec: service is required.", true);
    if (!args.execCommand) return textResult("ssh_compose exec: execCommand is required.", true);
  }

  // Validate service name
  if (args.service !== undefined && args.service !== null) {
    const svc = String(args.service);
    if (hasBadChars(svc)) return textResult("ssh_compose: service contains invalid characters.", true);
    if (!/^[a-zA-Z0-9._-]+$/.test(svc)) {
      return textResult(`ssh_compose: invalid service name "${svc}". Use only [a-zA-Z0-9._-].`, true);
    }
  }

  // Validate execCommand
  if (args.execCommand !== undefined) {
    if (hasBadChars(String(args.execCommand))) {
      return textResult("ssh_compose: execCommand contains invalid characters (\\r\\n\\x00).", true);
    }
  }

  // Validate composeFile
  let composeFile = null;
  if (args.composeFile !== undefined && args.composeFile !== null && String(args.composeFile).trim() !== "") {
    composeFile = String(args.composeFile);
    if (!composeFile.startsWith("/")) return textResult("ssh_compose: composeFile must be an absolute path.", true);
    if (composeFile.includes("..")) return textResult("ssh_compose: composeFile must not contain '..'.", true);
    if (hasBadChars(composeFile)) return textResult("ssh_compose: composeFile contains invalid characters.", true);
  }

  const detach = args.detach !== false;
  const lines = (Number.isInteger(args.lines) && args.lines > 0 && args.lines <= 10000) ? args.lines : 100;
  const useSudo = args.sudo === true;
  const pfx = useSudo ? "sudo " : "";

  // Build action-specific command segment
  const svcArg = args.service ? ` ${shellQuote(args.service)}` : "";
  let actionCmd;
  switch (action) {
    case "up":
      actionCmd = `${pfx}$_compose up${detach ? " -d" : ""}${svcArg}`;
      break;
    case "down":
      actionCmd = `${pfx}$_compose down`;
      break;
    case "ps":
      actionCmd = `${pfx}$_compose ps`;
      break;
    case "logs":
      actionCmd = `${pfx}$_compose logs --tail=${lines}${svcArg}`;
      break;
    case "pull":
      actionCmd = `${pfx}$_compose pull${svcArg}`;
      break;
    case "build":
      actionCmd = `${pfx}$_compose build${svcArg}`;
      break;
    case "restart":
      actionCmd = `${pfx}$_compose restart${svcArg}`;
      break;
    case "stop":
      actionCmd = `${pfx}$_compose stop${svcArg}`;
      break;
    case "config":
      actionCmd = `${pfx}$_compose config`;
      break;
    case "exec":
      actionCmd = `${pfx}$_compose exec ${shellQuote(args.service)} ${shellQuote(args.execCommand)}`;
      break;
  }

  const cdBlock = composeFile
    ? `\n_compose_dir=$(dirname ${shellQuote(composeFile)})\ncd "$_compose_dir" || { echo "Cannot cd to $_compose_dir" >&2; exit 1; }`
    : "";

  const command = `set +e
export LC_ALL=C

if ${pfx}docker compose version >/dev/null 2>&1; then
  _compose="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  _compose="docker-compose"
else
  echo "Neither 'docker compose' nor 'docker-compose' found" >&2; exit 1
fi
${cdBlock}
echo "Using: $_compose"
${actionCmd}
`;

  if (args.dryRun) return dryRunResult("ssh_compose", args, command);
  if (COMPOSE_MUTATING.has(action) && !args.confirm) return requireConfirm("ssh_compose", args);

  const result = await runSshCommand({ ...args, command, mode: "bash" });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ── ssh_k8s handler ──────────────────────────────────────────────────────────

const K8S_MUTATING_ACTIONS = new Set(["apply","delete","scale"]);
const K8S_RESOURCE_ALLOWLIST = new Set([
  "pod","pods","deployment","deployments","service","services",
  "node","nodes","namespace","namespaces","configmap","configmaps",
  "secret","secrets","ingress","ingresses","statefulset","statefulsets",
  "daemonset","daemonsets","replicaset","replicasets","job","jobs",
  "cronjob","cronjobs","persistentvolume","persistentvolumes",
  "persistentvolumeclaim","persistentvolumeclaims","serviceaccount","serviceaccounts"
]);

async function handleK8s(args) {
  const VALID_ACTIONS = new Set(["get","describe","logs","exec","apply","delete","rollout","scale","top","events"]);

  const action = String(args.action || "");
  if (!VALID_ACTIONS.has(action)) {
    return textResult(`ssh_k8s: invalid action "${action}". Valid: ${[...VALID_ACTIONS].join(", ")}`, true);
  }

  // Namespace validation
  const namespace = args.namespace ? String(args.namespace) : "default";
  if (hasBadChars(namespace)) return textResult("ssh_k8s: namespace contains invalid characters.", true);
  if (!/^[a-zA-Z0-9._-]+$/.test(namespace)) {
    return textResult(`ssh_k8s: invalid namespace "${namespace}".`, true);
  }

  // Resource validation
  if (args.resource !== undefined && args.resource !== null) {
    const res = String(args.resource).toLowerCase();
    if (!K8S_RESOURCE_ALLOWLIST.has(res)) {
      return textResult(`ssh_k8s: resource type "${args.resource}" not in allowlist.`, true);
    }
  }

  // Name validation
  if (args.name !== undefined && args.name !== null) {
    const nm = String(args.name);
    if (hasBadChars(nm)) return textResult("ssh_k8s: name contains invalid characters.", true);
    if (!/^[a-zA-Z0-9._\/-]+$/.test(nm)) {
      return textResult(`ssh_k8s: invalid resource name "${nm}".`, true);
    }
  }

  // Selector validation
  if (args.selector !== undefined && args.selector !== null) {
    if (hasBadChars(String(args.selector))) {
      return textResult("ssh_k8s: selector contains invalid characters (\\r\\n\\x00).", true);
    }
  }

  // Kubeconfig validation
  let kubeconfig = null;
  if (args.kubeconfig !== undefined && args.kubeconfig !== null && String(args.kubeconfig).trim() !== "") {
    kubeconfig = String(args.kubeconfig);
    if (!kubeconfig.startsWith("/")) return textResult("ssh_k8s: kubeconfig must be an absolute path.", true);
    if (kubeconfig.includes("..")) return textResult("ssh_k8s: kubeconfig must not contain '..'.", true);
    if (hasBadChars(kubeconfig)) return textResult("ssh_k8s: kubeconfig contains invalid characters.", true);
  }

  // execCommand validation (for exec action)
  if (action === "exec") {
    if (!args.name) return textResult("ssh_k8s exec: name (pod name) is required.", true);
    if (!args.execCommand) return textResult("ssh_k8s exec: execCommand is required.", true);
    if (hasBadChars(String(args.execCommand))) {
      return textResult("ssh_k8s exec: execCommand contains invalid characters.", true);
    }
  }

  // rollout sub-action validation
  let rolloutAction = null;
  if (action === "rollout") {
    if (!args.rolloutAction) return textResult("ssh_k8s rollout: rolloutAction is required (status/history/undo/restart).", true);
    rolloutAction = String(args.rolloutAction);
    if (!["status","history","undo","restart"].includes(rolloutAction)) {
      return textResult(`ssh_k8s: invalid rolloutAction "${rolloutAction}".`, true);
    }
  }

  // scale: replicas required
  if (action === "scale") {
    if (args.replicas === undefined || args.replicas === null) {
      return textResult("ssh_k8s scale: replicas is required.", true);
    }
    if (!Number.isInteger(args.replicas) || args.replicas < 0 || args.replicas > 1000) {
      return textResult("ssh_k8s scale: replicas must be an integer 0-1000.", true);
    }
  }

  // apply: resource file comes via name field (treated as -f path) or resource
  if (action === "apply") {
    if (!args.name) return textResult("ssh_k8s apply: name (path to manifest file) is required.", true);
  }

  const useSudo = args.sudo === true;
  const pfx = useSudo ? "sudo " : "";
  const kcFlag = kubeconfig ? `--kubeconfig ${shellQuote(kubeconfig)} ` : "";
  const nsFlag = `-n ${shellQuote(namespace)}`;
  const nameArg = args.name ? ` ${shellQuote(args.name)}` : "";
  const resArg = args.resource ? ` ${shellQuote(String(args.resource).toLowerCase())}` : "";

  // Determine if this is a mutating operation
  const isMutating = K8S_MUTATING_ACTIONS.has(action) ||
    (action === "rollout" && (rolloutAction === "undo" || rolloutAction === "restart"));

  let actionCmd;
  switch (action) {
    case "get": {
      const aFlag = args.allNamespaces ? " -A" : "";
      const oFlag = args.outputFormat ? ` -o ${shellQuote(args.outputFormat)}` : "";
      const lFlag = args.selector ? ` -l ${shellQuote(args.selector)}` : "";
      actionCmd = `${pfx}kubectl ${kcFlag}get${resArg}${nameArg} ${nsFlag}${aFlag}${oFlag}${lFlag}`;
      break;
    }
    case "describe": {
      actionCmd = `${pfx}kubectl ${kcFlag}describe${resArg}${nameArg} ${nsFlag}`;
      break;
    }
    case "logs": {
      const tailFlag = (Number.isInteger(args.tailLines) && args.tailLines > 0) ? ` --tail=${args.tailLines}` : "";
      const contFlag = args.container ? ` -c ${shellQuote(args.container)}` : "";
      if (args.follow) {
        actionCmd = `timeout 30 ${pfx}kubectl ${kcFlag}logs${nameArg} ${nsFlag}${tailFlag} -f${contFlag}`;
      } else {
        actionCmd = `${pfx}kubectl ${kcFlag}logs${nameArg} ${nsFlag}${tailFlag}${contFlag}`;
      }
      break;
    }
    case "exec": {
      const contFlag = args.container ? ` -c ${shellQuote(args.container)}` : "";
      actionCmd = `timeout 60 ${pfx}kubectl ${kcFlag}exec -it${nameArg} ${nsFlag}${contFlag} -- ${shellQuote(args.execCommand)}`;
      break;
    }
    case "apply": {
      actionCmd = `${pfx}kubectl ${kcFlag}apply -f ${shellQuote(args.name)} ${nsFlag}`;
      break;
    }
    case "delete": {
      actionCmd = `${pfx}kubectl ${kcFlag}delete${resArg}${nameArg} ${nsFlag}`;
      break;
    }
    case "rollout": {
      const resourceTarget = args.resource && args.name
        ? ` ${shellQuote(String(args.resource).toLowerCase())}/${shellQuote(args.name).slice(1,-1)}`
        : resArg + nameArg;
      actionCmd = `${pfx}kubectl ${kcFlag}rollout ${shellQuote(rolloutAction)}${resourceTarget} ${nsFlag}`;
      break;
    }
    case "scale": {
      actionCmd = `${pfx}kubectl ${kcFlag}scale${resArg}${nameArg} --replicas=${args.replicas} ${nsFlag}`;
      break;
    }
    case "top": {
      actionCmd = `${pfx}kubectl ${kcFlag}top${resArg}${nameArg} ${nsFlag}`;
      break;
    }
    case "events": {
      actionCmd = `${pfx}kubectl ${kcFlag}get events ${nsFlag} --sort-by='.lastTimestamp' | tail -30`;
      break;
    }
  }

  const command = `set +e
export LC_ALL=C

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl not found" >&2; exit 1
fi

_ns=${shellQuote(namespace)}
${actionCmd}
`;

  if (args.dryRun) return dryRunResult("ssh_k8s", args, command);
  if (isMutating && !args.confirm) return requireConfirm("ssh_k8s", args);

  const result = await runSshCommand({ ...args, command, mode: "bash" });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export async function handleTool(name, args) {
  if (name === "ssh_compose") return handleCompose(args);
  if (name === "ssh_k8s") return handleK8s(args);
  return null;
}
