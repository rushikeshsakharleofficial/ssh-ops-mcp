"""MCP v2 stdio entrypoint: seven focused operations, no remote agent."""
from mcp.server import MCPServer
from . import core

mcp = MCPServer("ssh-ops")


@mcp.tool()
def ssh_profiles() -> list[dict]:
    """List local SSH profiles (no credentials)."""
    return core.profiles()


@mcp.tool()
def ssh_save_profile(name: str, host: str, username: str, port: int = 22,
                     identity_file: str = "", jump_host: str = "", shell: str = "sh", confirm: bool = False) -> str:
    """Add or update a profile; SSH keys only. Requires confirmation."""
    if not confirm:
        raise PermissionError("confirm=true required to change profiles")
    return core.save_profile(name, host, username, port, identity_file, jump_host, shell)


@mcp.tool()
def ssh_remove_profile(name: str, confirm: bool = False) -> str:
    """Delete a stored SSH profile. Requires confirmation."""
    if not confirm:
        raise PermissionError("confirm=true required")
    return core.remove_profile(name)


@mcp.tool()
def ssh_health(target: str) -> dict:
    """Bounded hostname, uptime and root filesystem diagnostics; warn on disk pressure."""
    return core.health(target)


@mcp.tool()
def ssh_run(target: str, command: str, confirm: bool = False, timeout: int = 20) -> dict:
    """Execute an arbitrary remote shell command. Disabled by default; requires opt-in and confirmation."""
    return core.execute(target, command, confirm=confirm, timeout=timeout)


@mcp.tool()
def ssh_copy(target: str, source: str, destination: str, direction: str,
             recursive: bool = False, confirm: bool = False) -> dict:
    """Transfer file/directory using local scp (SFTP default on OpenSSH 9+), with no remote agent."""
    return core.copy(target, source, destination, direction, recursive, confirm)


@mcp.tool()
def ssh_incidents(limit: int = 20) -> list[dict]:
    """Show recent local incident metadata; never includes command text or secrets."""
    return core.incidents(limit)


@mcp.tool()
def ssh_log_search(target: str, pattern: str = "", unit: str = "", lines: int = 50) -> dict:
    """Find up to 100 journal entries from the last hour, with safe arguments."""
    return core.log_search(target, pattern, unit, lines)


@mcp.tool()
def ssh_fleet_health(targets: list[str]) -> list[dict]:
    """Summarise fixed health diagnostics on up to 20 server profiles."""
    return core.fleet_health(targets)


def main() -> None:
    mcp.run()  # stdio transport
