import { runSshCommand, formatRunResult } from "./ssh-core.mjs";

function shellQuote(v) { return `'${String(v).replace(/'/g, "'\\''")}'`; }
function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }
function dryRunResult(toolName, args, command, target) {
  return textResult(JSON.stringify({ dryRun: true, tool: toolName, target: target || args.target || args.host || "(default)", sudo: Boolean(args.sudo !== false), command: command || null, note: "dryRun:true — nothing executed" }, null, 2));
}
function requireConfirm(toolName, args) {
  const r = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${r}`, true);
}

const DOMAIN_RE = /^[a-zA-Z0-9._-]+$/;

export const toolDefs = [
  {
    name: "ssh_certbot",
    title: "SSH Certbot / Let's Encrypt Management",
    description: "Manage Let's Encrypt certificates via certbot: list certs with expiry, renew specific or all certs, check auto-renewal status.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        target: { type: "string", description: "Profile name or user@host" },
        action: { type: "string", enum: ["list","renew","renew-all","status","expand","delete"], description: "Certbot action to perform" },
        domain: { type: "string", description: "Domain name for renew/expand/delete" },
        dryRun: { type: "boolean", description: "For renew/renew-all: passes --dry-run to certbot (test mode)" },
        sudo:   { type: "boolean", description: "Run with sudo (default true)", default: true },
        confirm:{ type: "boolean", description: "Required for mutating operations (not needed when dryRun:true)" },
        reason: { type: "string", description: "Reason for the operation" }
      }
    }
  }
];

export async function handleTool(name, args) {
  if (name !== "ssh_certbot") return null;

  const { action, domain, dryRun, confirm, reason } = args;
  const sudo = args.sudo !== false;
  const sudoPrefix = sudo ? "sudo " : "";

  const MUTATING = ["renew", "renew-all", "expand", "delete"];

  // Domain validation for actions that need it
  if (["renew", "expand", "delete"].includes(action)) {
    if (!domain || !DOMAIN_RE.test(domain)) return textResult(`ssh_certbot: invalid or missing domain name.`, true);
  }

  let script;

  if (action === "list") {
    script = [
      "set +e",
      "export LC_ALL=C",
      `echo "=== Let's Encrypt Certificates ==="`,
      `${sudoPrefix}certbot certificates 2>/dev/null || {`,
      `  echo "certbot not found. Checking /etc/letsencrypt/live/..."`,
      `  for d in /etc/letsencrypt/live/*/; do`,
      `    domain=$(basename "$d")`,
      `    cert="$d/cert.pem"`,
      `    if [ -f "$cert" ]; then`,
      `      expiry=$(openssl x509 -noout -enddate -in "$cert" 2>/dev/null | cut -d= -f2)`,
      `      epoch=$(date -d "$expiry" +%s 2>/dev/null)`,
      `      now=$(date +%s)`,
      `      days=$(( (epoch - now) / 86400 ))`,
      `      status="OK"`,
      `      [ $days -lt 30 ] && status="EXPIRING SOON"`,
      `      [ $days -lt 0 ] && status="EXPIRED"`,
      `      echo "$domain — expires $expiry ($days days) [$status]"`,
      `    fi`,
      `  done`,
      `}`
    ].join("\n");
  } else if (action === "status") {
    script = [
      "set +e",
      `${sudoPrefix}systemctl status certbot.timer 2>/dev/null || \\`,
      `  ${sudoPrefix}systemctl status certbot 2>/dev/null || \\`,
      `  crontab -l 2>/dev/null | grep certbot || \\`,
      `  echo "No certbot service/timer/cron found"`
    ].join("\n");
  } else if (action === "renew") {
    const _domain = shellQuote(domain);
    const dryFlag = dryRun ? " --dry-run" : "";
    script = [
      "set +e",
      `${sudoPrefix}certbot renew --cert-name ${_domain}${dryFlag} 2>&1`
    ].join("\n");
  } else if (action === "renew-all") {
    const dryFlag = dryRun ? " --dry-run" : "";
    script = [
      "set +e",
      `${sudoPrefix}certbot renew${dryFlag} 2>&1`
    ].join("\n");
  } else if (action === "expand") {
    const _domain = shellQuote(domain);
    script = [
      "set +e",
      `${sudoPrefix}certbot certonly --expand -d ${_domain} --non-interactive 2>&1`
    ].join("\n");
  } else if (action === "delete") {
    const _domain = shellQuote(domain);
    script = [
      "set +e",
      `${sudoPrefix}certbot delete --cert-name ${_domain} 2>&1`
    ].join("\n");
  } else {
    return textResult(`ssh_certbot: unknown action "${action}".`, true);
  }

  // dryRun as MCP preview (no execution) — only for non-certbot-dryrun actions
  // For renew/renew-all, dryRun passes --dry-run to certbot; still executes (read-only test)
  // For other actions, dryRun=true means preview without executing
  if (dryRun && !["renew", "renew-all"].includes(action)) {
    return dryRunResult("ssh_certbot", args, script, args.target);
  }

  // Confirm required for mutating ops when NOT a certbot dry-run
  if (MUTATING.includes(action) && !dryRun && !confirm) return requireConfirm("ssh_certbot", args);

  const result = await runSshCommand({ target: args.target, command: script, mode: "bash", sudo: false });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}
