// ssh-tools-webserver.mjs — web server tools: ssh_nginx, ssh_apache
import { runSshCommand, formatRunResult } from "./ssh-core.mjs";

function shellQuote(v) { return `'${String(v).replace(/'/g, "'\\''")}'`; }
function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }
function dryRunResult(toolName, args, command, target) {
  return textResult(JSON.stringify({ dryRun: true, tool: toolName, target: target || args.target || args.host || "(default)", sudo: Boolean(args.sudo), command: command || null, note: "dryRun:true — nothing executed" }, null, 2));
}
function requireConfirm(toolName, args) {
  const r = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${r}`, true);
}

const SITE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const MOD_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export const toolDefs = [
  {
    name: "ssh_nginx",
    title: "SSH Nginx Management",
    description: "Manage nginx web server on a remote host: test config, reload, restart, list/enable/disable sites, show status and access logs.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host" },
        action: {
          type: "string",
          enum: ["test", "reload", "restart", "status", "list-sites", "enable", "disable", "logs", "show-config"],
          description: "Action to perform"
        },
        site: { type: "string", description: "Site name in sites-available (for enable/disable/show-config)" },
        lines: { type: "number", description: "Log lines for logs action (default 50)" },
        sudo: { type: "boolean", description: "Run with sudo (default true)" },
        confirm: { type: "boolean", description: "Required for reload/restart/enable/disable" },
        dryRun: { type: "boolean", description: "If true, return command without executing" },
        reason: { type: "string", description: "Reason for destructive action" }
      },
      required: ["action"]
    }
  },
  {
    name: "ssh_apache",
    title: "SSH Apache Management",
    description: "Manage Apache web server: test config, reload, restart, list/enable/disable sites and modules.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile name or user@host" },
        action: {
          type: "string",
          enum: ["test", "reload", "restart", "status", "list-sites", "enable-site", "disable-site", "list-mods", "enable-mod", "disable-mod", "logs", "show-config"],
          description: "Action to perform"
        },
        site: { type: "string", description: "Site name for enable-site/disable-site/show-config" },
        module: { type: "string", description: "Module name for enable-mod/disable-mod" },
        lines: { type: "number", description: "Log lines for logs action (default 50)" },
        sudo: { type: "boolean", description: "Run with sudo (default true)" },
        confirm: { type: "boolean", description: "Required for reload/restart/enable-site/disable-site/enable-mod/disable-mod" },
        dryRun: { type: "boolean", description: "If true, return command without executing" },
        reason: { type: "string", description: "Reason for destructive action" }
      },
      required: ["action"]
    }
  }
];

const NGINX_CONFIRM_ACTIONS = new Set(["reload", "restart", "enable", "disable"]);
const APACHE_CONFIRM_ACTIONS = new Set(["reload", "restart", "enable-site", "disable-site", "enable-mod", "disable-mod"]);

async function handleNginx(args) {
  const action = args.action;
  const sudo = args.sudo !== false;
  const lines = Number(args.lines) > 0 ? Math.floor(Number(args.lines)) : 50;
  const pfx = sudo ? "sudo " : "";

  if (NGINX_CONFIRM_ACTIONS.has(action) && !args.confirm) {
    return requireConfirm("ssh_nginx", args);
  }

  let command;

  if (action === "test") {
    command = `${pfx}nginx -t 2>&1`;
  } else if (action === "reload") {
    command = `${pfx}systemctl reload nginx 2>&1 || ${pfx}nginx -s reload 2>&1`;
  } else if (action === "restart") {
    command = `${pfx}systemctl restart nginx 2>&1`;
  } else if (action === "status") {
    command = `${pfx}systemctl status nginx --no-pager 2>&1; echo "---"; ${pfx}nginx -v 2>&1`;
  } else if (action === "list-sites") {
    command = [
      `echo "=== Sites Available ==="`,
      `${pfx}ls -la /etc/nginx/sites-available/ 2>/dev/null || ${pfx}ls -la /etc/nginx/conf.d/ 2>/dev/null`,
      `echo ""`,
      `echo "=== Sites Enabled ==="`,
      `${pfx}ls -la /etc/nginx/sites-enabled/ 2>/dev/null`,
      `echo ""`,
      `echo "=== Active vhosts (nginx -T) ==="`,
      `${pfx}nginx -T 2>/dev/null | grep -E "^server_name|^    server_name|listen " | head -30`
    ].join("\n");
  } else if (action === "enable") {
    if (!args.site) return textResult("ssh_nginx enable requires site parameter", true);
    if (!SITE_NAME_RE.test(args.site)) return textResult(`Invalid site name: ${JSON.stringify(args.site)}`, true);
    const site = shellQuote(args.site);
    command = `${pfx}ln -sf /etc/nginx/sites-available/${site} /etc/nginx/sites-enabled/${site} && ${pfx}nginx -t && ${pfx}systemctl reload nginx`;
  } else if (action === "disable") {
    if (!args.site) return textResult("ssh_nginx disable requires site parameter", true);
    if (!SITE_NAME_RE.test(args.site)) return textResult(`Invalid site name: ${JSON.stringify(args.site)}`, true);
    const site = shellQuote(args.site);
    command = `${pfx}rm -f /etc/nginx/sites-enabled/${site} && ${pfx}nginx -t && ${pfx}systemctl reload nginx`;
  } else if (action === "logs") {
    const n = shellQuote(String(lines));
    command = `${pfx}tail -n ${n} /var/log/nginx/access.log 2>/dev/null; echo "---ERRORS---"; ${pfx}tail -n ${n} /var/log/nginx/error.log 2>/dev/null`;
  } else if (action === "show-config") {
    if (args.site) {
      if (!SITE_NAME_RE.test(args.site)) return textResult(`Invalid site name: ${JSON.stringify(args.site)}`, true);
      const site = shellQuote(args.site);
      command = `${pfx}cat /etc/nginx/sites-available/${site} 2>/dev/null || ${pfx}cat /etc/nginx/conf.d/${site} 2>/dev/null`;
    } else {
      command = `${pfx}cat /etc/nginx/nginx.conf`;
    }
  } else {
    return textResult(`Unknown action: ${JSON.stringify(action)}`, true);
  }

  if (args.dryRun) return dryRunResult("ssh_nginx", args, command);

  const result = await runSshCommand({ target: args.target, command, mode: "bash", sudo: false });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

async function handleApache(args) {
  const action = args.action;
  const sudo = args.sudo !== false;
  const lines = Number(args.lines) > 0 ? Math.floor(Number(args.lines)) : 50;
  const pfx = sudo ? "sudo " : "";

  if (APACHE_CONFIRM_ACTIONS.has(action) && !args.confirm) {
    return requireConfirm("ssh_apache", args);
  }

  const apacheDetect = [
    `if command -v apache2 >/dev/null 2>&1; then _apache=apache2; _ctl=apache2ctl`,
    `elif command -v httpd >/dev/null 2>&1; then _apache=httpd; _ctl=apachectl`,
    `else echo "Apache not found" >&2; exit 1; fi`
  ].join("\n");

  let command;

  if (action === "test") {
    command = `${apacheDetect}\n${pfx}$_ctl -t 2>&1`;
  } else if (action === "reload") {
    command = `${apacheDetect}\n${pfx}systemctl reload $_apache 2>&1`;
  } else if (action === "restart") {
    command = `${apacheDetect}\n${pfx}systemctl restart $_apache 2>&1`;
  } else if (action === "status") {
    command = `${apacheDetect}\n${pfx}systemctl status $_apache --no-pager 2>&1; ${pfx}$_ctl -v 2>&1`;
  } else if (action === "list-sites") {
    command = `${apacheDetect}\n${pfx}ls -la /etc/apache2/sites-available/ 2>/dev/null; ${pfx}ls -la /etc/apache2/sites-enabled/ 2>/dev/null`;
  } else if (action === "enable-site") {
    if (!args.site) return textResult("ssh_apache enable-site requires site parameter", true);
    if (!SITE_NAME_RE.test(args.site)) return textResult(`Invalid site name: ${JSON.stringify(args.site)}`, true);
    const site = shellQuote(args.site);
    command = `${apacheDetect}\n${pfx}a2ensite ${site} && ${pfx}$_ctl -t && ${pfx}systemctl reload $_apache`;
  } else if (action === "disable-site") {
    if (!args.site) return textResult("ssh_apache disable-site requires site parameter", true);
    if (!SITE_NAME_RE.test(args.site)) return textResult(`Invalid site name: ${JSON.stringify(args.site)}`, true);
    const site = shellQuote(args.site);
    command = `${apacheDetect}\n${pfx}a2dissite ${site} && ${pfx}$_ctl -t && ${pfx}systemctl reload $_apache`;
  } else if (action === "list-mods") {
    command = `${pfx}apache2ctl -M 2>/dev/null || ${pfx}apachectl -M 2>/dev/null`;
  } else if (action === "enable-mod") {
    if (!args.module) return textResult("ssh_apache enable-mod requires module parameter", true);
    if (!MOD_NAME_RE.test(args.module)) return textResult(`Invalid module name: ${JSON.stringify(args.module)}`, true);
    const mod = shellQuote(args.module);
    command = `${apacheDetect}\n${pfx}a2enmod ${mod} && ${pfx}systemctl reload $_apache`;
  } else if (action === "disable-mod") {
    if (!args.module) return textResult("ssh_apache disable-mod requires module parameter", true);
    if (!MOD_NAME_RE.test(args.module)) return textResult(`Invalid module name: ${JSON.stringify(args.module)}`, true);
    const mod = shellQuote(args.module);
    command = `${apacheDetect}\n${pfx}a2dismod ${mod} && ${pfx}systemctl reload $_apache`;
  } else if (action === "logs") {
    const n = shellQuote(String(lines));
    command = `${pfx}tail -n ${n} /var/log/apache2/access.log 2>/dev/null || ${pfx}tail -n ${n} /var/log/httpd/access_log 2>/dev/null`;
  } else if (action === "show-config") {
    if (args.site) {
      if (!SITE_NAME_RE.test(args.site)) return textResult(`Invalid site name: ${JSON.stringify(args.site)}`, true);
      const site = shellQuote(args.site);
      command = `${pfx}cat /etc/apache2/sites-available/${site} 2>/dev/null`;
    } else {
      command = `${pfx}cat /etc/apache2/apache2.conf 2>/dev/null || ${pfx}cat /etc/httpd/conf/httpd.conf 2>/dev/null`;
    }
  } else {
    return textResult(`Unknown action: ${JSON.stringify(action)}`, true);
  }

  if (args.dryRun) return dryRunResult("ssh_apache", args, command);

  const result = await runSshCommand({ target: args.target, command, mode: "bash", sudo: false });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}

export async function handleTool(name, args) {
  if (name === "ssh_nginx") return handleNginx(args);
  if (name === "ssh_apache") return handleApache(args);
  return null;
}
