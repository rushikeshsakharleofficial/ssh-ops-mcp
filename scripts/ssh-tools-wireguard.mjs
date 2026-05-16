// ssh-tools-wireguard.mjs — WireGuard VPN management
import { runSshCommand, formatRunResult } from "./ssh-core.mjs";

function shellQuote(v) { return `'${String(v).replace(/'/g, "'\\''")}'`; }
function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }
function dryRunResult(toolName, args, command, target) {
  return textResult(JSON.stringify({ dryRun: true, tool: toolName, target: target || args.target || args.host || "(default)", command: command || null, note: "dryRun:true — nothing executed" }, null, 2));
}
function requireConfirm(toolName, args) {
  const r = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${r}`, true);
}

function validateInterface(name) {
  return typeof name === "string" && /^[a-zA-Z0-9_-]+$/.test(name) && name.length <= 15;
}

function validateWgPubKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9+/]{43}=$/.test(key);
}

function validateCIDR(cidr) {
  return typeof cidr === "string" && /^[0-9a-fA-F.:\/,\s]+$/.test(cidr) && !/[\r\n\x00`]/.test(cidr);
}

export const toolDefs = [
  {
    name: "ssh_wireguard",
    title: "SSH WireGuard VPN Management",
    description: "Manage WireGuard VPN interfaces and peers on a remote host. status/list-peers/stats are read-only; add-peer/remove-peer/enable/disable require confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Profile or user@host." },
        action: {
          type: "string",
          enum: ["status", "list-peers", "add-peer", "remove-peer", "enable", "disable", "stats"],
          description: "WireGuard action."
        },
        interface: { type: "string", description: "WireGuard interface name (default: wg0)." },
        peerKey: { type: "string", description: "Peer public key (44-char base64) for add-peer/remove-peer." },
        allowedIPs: { type: "string", description: "Allowed IPs for peer in CIDR notation (e.g. 10.0.0.2/32)." },
        endpoint: { type: "string", description: "Peer endpoint host:port for add-peer (optional)." },
        persistentKeepalive: { type: "number", description: "Keepalive interval in seconds (optional, for add-peer)." },
        sudo: { type: "boolean", description: "Use sudo. Default true." },
        confirm: { type: "boolean", description: "Required for add-peer/remove-peer/enable/disable." },
        dryRun: { type: "boolean", description: "Preview command without executing." },
        reason: { type: "string", description: "Reason logged to audit log." },
        timeoutMs: { type: "number", description: "Timeout ms." }
      },
      required: ["action"]
    }
  }
];

export async function handleTool(name, args) {
  if (name !== "ssh_wireguard") return null;

  const iface = args.interface || "wg0";
  if (!validateInterface(iface)) {
    return textResult(`interface must be alphanumeric/hyphens/underscores, max 15 chars. Got: ${iface}`, true);
  }

  const mutating = ["add-peer", "remove-peer", "enable", "disable"];
  if (mutating.includes(args.action) && args.confirm !== true) {
    return requireConfirm(name, args);
  }

  const ifaceQ = shellQuote(iface);
  let command;

  if (args.action === "status") {
    command = `set +e
export LC_ALL=C
if ! command -v wg >/dev/null 2>&1; then
  echo "wg not found. Install: apt-get install wireguard-tools" >&2; exit 1
fi
echo "=== WireGuard Interface: ${iface} ==="
wg show ${ifaceQ} 2>&1
echo ""
echo "=== IP Addresses ==="
ip addr show ${ifaceQ} 2>/dev/null || echo "(interface not found)"
echo ""
echo "=== Link State ==="
ip link show ${ifaceQ} 2>/dev/null | grep -E "UP|DOWN|mtu" || echo "(interface not found)"
`;
  } else if (args.action === "list-peers") {
    command = `set +e
export LC_ALL=C
echo "=== Peers on ${iface} ==="
wg show ${ifaceQ} peers 2>&1
echo ""
echo "=== Allowed IPs ==="
wg show ${ifaceQ} allowed-ips 2>&1
echo ""
echo "=== Latest Handshakes ==="
wg show ${ifaceQ} latest-handshakes 2>&1
`;
  } else if (args.action === "stats") {
    command = `set +e
export LC_ALL=C
echo "=== Transfer Stats: ${iface} ==="
wg show ${ifaceQ} transfer 2>&1
echo ""
echo "=== Endpoints ==="
wg show ${ifaceQ} endpoints 2>&1
`;
  } else if (args.action === "enable") {
    command = `set +e
export LC_ALL=C
if command -v wg-quick >/dev/null 2>&1; then
  wg-quick up ${ifaceQ} 2>&1
elif systemctl is-enabled "wg-quick@${iface}" >/dev/null 2>&1 || true; then
  systemctl enable --now ${shellQuote(`wg-quick@${iface}`)} 2>&1
else
  ip link add dev ${ifaceQ} type wireguard 2>/dev/null
  ip link set up dev ${ifaceQ} 2>&1
fi
echo "Interface ${iface} enabled"
wg show ${ifaceQ} 2>/dev/null
`;
  } else if (args.action === "disable") {
    command = `set +e
export LC_ALL=C
if command -v wg-quick >/dev/null 2>&1; then
  wg-quick down ${ifaceQ} 2>&1
else
  systemctl disable --now ${shellQuote(`wg-quick@${iface}`)} 2>&1 || \
    ip link set down dev ${ifaceQ} 2>&1
fi
echo "Interface ${iface} disabled"
`;
  } else if (args.action === "add-peer") {
    if (!args.peerKey) return textResult("peerKey is required for add-peer.", true);
    if (!validateWgPubKey(args.peerKey)) return textResult("peerKey must be a valid WireGuard public key (44-char base64).", true);
    if (!args.allowedIPs) return textResult("allowedIPs is required for add-peer.", true);
    if (!validateCIDR(args.allowedIPs)) return textResult("allowedIPs must be valid IP/CIDR notation.", true);

    const keyQ = shellQuote(args.peerKey);
    const ipsQ = shellQuote(args.allowedIPs);
    let endpointPart = "";
    let endpointConf = "";
    if (args.endpoint) {
      if (!/^[a-zA-Z0-9._-]+:[0-9]+$/.test(args.endpoint)) return textResult("endpoint must be host:port format.", true);
      endpointPart = `endpoint ${shellQuote(args.endpoint)}`;
      endpointConf = `Endpoint = ${args.endpoint}`;
    }
    let keepalivePart = "";
    let keepaliveConf = "";
    if (args.persistentKeepalive) {
      const ka = Math.floor(Number(args.persistentKeepalive));
      if (!Number.isFinite(ka) || ka < 1 || ka > 65535) return textResult("persistentKeepalive must be 1-65535.", true);
      keepalivePart = `persistent-keepalive ${ka}`;
      keepaliveConf = `PersistentKeepalive = ${ka}`;
    }

    const confFile = `/etc/wireguard/${iface}.conf`;
    command = `set +e
export LC_ALL=C
_key=${keyQ}
_ips=${ipsQ}

wg set ${ifaceQ} peer "$_key" allowed-ips "$_ips" ${endpointPart} ${keepalivePart} 2>&1
if [ $? -eq 0 ]; then
  echo "Peer added to ${iface} (runtime)"
  _conf=${shellQuote(confFile)}
  if [ -f "$_conf" ]; then
    if grep -qF "$_key" "$_conf" 2>/dev/null; then
      echo "Peer already in config file — skipping persistence"
    else
      printf '\\n[Peer]\\nPublicKey = %s\\nAllowedIPs = %s\\n${endpointConf ? `Endpoint = ${args.endpoint}\\n` : ""}${keepaliveConf ? `PersistentKeepalive = ${args.persistentKeepalive}\\n` : ""}' "$_key" "$_ips" >> "$_conf"
      echo "Peer appended to $_conf"
    fi
  else
    echo "Warning: $_conf not found — peer added to runtime only (not persistent)"
  fi
else
  echo "Failed to add peer" >&2; exit 1
fi
`;
  } else if (args.action === "remove-peer") {
    if (!args.peerKey) return textResult("peerKey is required for remove-peer.", true);
    if (!validateWgPubKey(args.peerKey)) return textResult("peerKey must be a valid WireGuard public key.", true);

    const keyQ = shellQuote(args.peerKey);
    const confFile = `/etc/wireguard/${iface}.conf`;
    command = `set +e
export LC_ALL=C
_key=${keyQ}
wg set ${ifaceQ} peer "$_key" remove 2>&1
if [ $? -eq 0 ]; then
  echo "Peer removed from ${iface} (runtime)"
  _conf=${shellQuote(confFile)}
  if [ -f "$_conf" ]; then
    awk -v key="$_key" '
      /^\\[Peer\\]/ { in_peer=1; peer_block=$0"\\n"; next }
      in_peer && /^\\[/ { if (!found) printf "%s", peer_block; in_peer=0; found=0 }
      in_peer { if (index($0, key)) found=1; peer_block=peer_block $0"\\n"; next }
      { print }
      END { if (in_peer && !found) printf "%s", peer_block }
    ' "$_conf" > "$_conf.tmp" && mv "$_conf.tmp" "$_conf"
    echo "Peer removed from $_conf"
  fi
else
  echo "Failed to remove peer" >&2; exit 1
fi
`;
  } else {
    return textResult(`Unknown action: ${args.action}`, true);
  }

  if (args.dryRun === true) return dryRunResult(name, args, command, args.target || args.host);
  const result = await runSshCommand({ ...args, command, mode: "bash", sudo: args.sudo !== false, timeoutMs: args.timeoutMs || 60_000 });
  return textResult(formatRunResult(result), result.exitCode !== 0);
}
