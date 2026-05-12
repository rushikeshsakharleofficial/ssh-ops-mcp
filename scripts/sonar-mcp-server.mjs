#!/usr/bin/env node
const SONAR_TOKEN = process.env.SONAR_TOKEN || "";
const SONAR_HOST = (process.env.SONAR_HOST_URL || "http://localhost:9000").replace(/\/$/, "");

async function sonarApi(path, params = {}) {
  const url = new URL(`${SONAR_HOST}/api/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const headers = { Authorization: `Bearer ${SONAR_TOKEN}` };
  const res = await fetch(url.toString(), { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`SonarQube API ${res.status}: ${text}`);
  return JSON.parse(text);
}

const TOOLS = [
  {
    name: "sonar_list_projects",
    title: "List SonarQube Projects",
    description: "List all projects in the SonarQube instance with key, name, and quality gate status.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Optional search query to filter projects by name." } } }
  },
  {
    name: "sonar_get_metrics",
    title: "Get Project Metrics",
    description: "Get quality metrics for a project: bugs, vulnerabilities, code smells, coverage, duplications, lines of code.",
    inputSchema: {
      type: "object",
      required: ["projectKey"],
      properties: {
        projectKey: { type: "string", description: "SonarQube project key." },
        branch: { type: "string", description: "Branch name. Defaults to main branch." }
      }
    }
  },
  {
    name: "sonar_get_quality_gate",
    title: "Get Quality Gate Status",
    description: "Get the quality gate status (PASSED/FAILED/ERROR) for a project with condition details.",
    inputSchema: {
      type: "object",
      required: ["projectKey"],
      properties: {
        projectKey: { type: "string", description: "SonarQube project key." },
        branch: { type: "string", description: "Branch name." }
      }
    }
  },
  {
    name: "sonar_get_issues",
    title: "Get Project Issues",
    description: "Get bugs, vulnerabilities, or code smells for a project with severity and location.",
    inputSchema: {
      type: "object",
      required: ["projectKey"],
      properties: {
        projectKey: { type: "string", description: "SonarQube project key." },
        types: { type: "string", description: "Comma-separated issue types: BUG, VULNERABILITY, CODE_SMELL. Defaults to all." },
        severities: { type: "string", description: "Comma-separated: BLOCKER, CRITICAL, MAJOR, MINOR, INFO." },
        resolved: { type: "boolean", description: "Filter resolved issues. Default: false (unresolved only)." },
        pageSize: { type: "number", description: "Results per page, max 500. Default 50." }
      }
    }
  },
  {
    name: "sonar_get_hotspots",
    title: "Get Security Hotspots",
    description: "Get security hotspots for a project that need manual review.",
    inputSchema: {
      type: "object",
      required: ["projectKey"],
      properties: {
        projectKey: { type: "string", description: "SonarQube project key." },
        status: { type: "string", description: "TO_REVIEW, REVIEWED. Default: TO_REVIEW." }
      }
    }
  },
  {
    name: "sonar_system_health",
    title: "SonarQube System Health",
    description: "Check SonarQube system health, version, and database status.",
    inputSchema: { type: "object", properties: {} }
  }
];

async function handleTool(name, args) {
  switch (name) {
    case "sonar_list_projects": {
      const data = await sonarApi("projects/search", { q: args.query, ps: 100 });
      const rows = data.components.map(p => `${p.key} | ${p.name} | last analysis: ${p.lastAnalysisDate || "never"}`);
      return `Found ${data.paging.total} project(s):\n\n` + rows.join("\n");
    }
    case "sonar_get_metrics": {
      const metricKeys = "bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,ncloc,security_rating,reliability_rating,sqale_rating,alert_status";
      const data = await sonarApi("measures/component", { component: args.projectKey, metricKeys, branch: args.branch });
      const measures = {};
      for (const m of data.component.measures) measures[m.metric] = m.value;
      return [
        `Project: ${data.component.name} (${data.component.key})`,
        `Quality Gate: ${measures.alert_status || "N/A"}`,
        ``,
        `Reliability:  Bugs=${measures.bugs || 0}  Rating=${measures.reliability_rating || "-"}`,
        `Security:     Vulnerabilities=${measures.vulnerabilities || 0}  Rating=${measures.security_rating || "-"}`,
        `Maintainability: Code Smells=${measures.code_smells || 0}  Rating=${measures.sqale_rating || "-"}`,
        `Coverage:     ${measures.coverage !== undefined ? measures.coverage + "%" : "N/A"}`,
        `Duplication:  ${measures.duplicated_lines_density !== undefined ? measures.duplicated_lines_density + "%" : "N/A"}`,
        `Lines of Code: ${measures.ncloc || "N/A"}`
      ].join("\n");
    }
    case "sonar_get_quality_gate": {
      const data = await sonarApi("qualitygates/project_status", { projectKey: args.projectKey, branch: args.branch });
      const qs = data.projectStatus;
      const conditions = (qs.conditions || []).map(c =>
        `  ${c.status === "OK" ? "✓" : "✗"} ${c.metricKey}: ${c.actualValue} (threshold: ${c.errorThreshold || c.warningThreshold || "-"})`
      );
      return [`Quality Gate: ${qs.status}`, "", "Conditions:", ...conditions].join("\n");
    }
    case "sonar_get_issues": {
      const data = await sonarApi("issues/search", {
        componentKeys: args.projectKey, types: args.types, severities: args.severities,
        resolved: args.resolved === true ? "true" : "false", ps: args.pageSize || 50
      });
      if (data.issues.length === 0) return "No issues found.";
      const rows = data.issues.map(i => `[${i.severity}] ${i.type} — ${i.message}\n  File: ${i.component} Line: ${i.line || "?"}`);
      return `${data.total} total issue(s) (showing ${data.issues.length}):\n\n` + rows.join("\n\n");
    }
    case "sonar_get_hotspots": {
      const data = await sonarApi("hotspots/search", { projectKey: args.projectKey, status: args.status || "TO_REVIEW", ps: 50 });
      if (!data.hotspots || data.hotspots.length === 0) return "No hotspots found.";
      const rows = data.hotspots.map(h => `[${h.vulnerabilityProbability}] ${h.message}\n  File: ${h.component} Line: ${h.line || "?"}`);
      return `${data.paging.total} hotspot(s) (showing ${data.hotspots.length}):\n\n` + rows.join("\n\n");
    }
    case "sonar_system_health": {
      const [health, ver] = await Promise.all([sonarApi("system/health"), sonarApi("server/version").catch(() => "unknown")]);
      return [`Health: ${health.health}`, `Version: ${typeof ver === "string" ? ver : JSON.stringify(ver)}`, health.causes?.length ? `Issues: ${health.causes.join(", ")}` : "No issues."].join("\n");
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

const handlers = {
  initialize: () => ({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "sonarqube-mcp", version: "1.0.0" } }),
  "tools/list": () => ({ tools: TOOLS }),
  "tools/call": async (msg) => {
    const { name, arguments: args } = msg.params;
    const text = await handleTool(name, args || {});
    return { content: [{ type: "text", text }] };
  }
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) void handleLine(line);
  }
});

async function handleLine(line) {
  let message;
  try { message = JSON.parse(line); } catch (e) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${e.message}` } }); return;
  }
  if (!message.id && message.id !== 0) return;
  try {
    const handler = handlers[message.method];
    if (!handler) { send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }); return; }
    const result = await handler(message);
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (e) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: e.message || String(e) } });
  }
}

function send(payload) { process.stdout.write(`${JSON.stringify(payload)}\n`); }
