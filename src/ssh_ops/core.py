"""Small, local-only OpenSSH backend. Never stores credentials."""
from __future__ import annotations

import json
import os
import re
import shlex
import sqlite3
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$")
USER = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$")
REMOTE_PATH = re.compile(r"^/[A-Za-z0-9._/@+/-]+$")
MAX_BYTES = 32_768


def home() -> Path:
    p = Path(os.environ.get("SSH_OPS_HOME", str(Path.home() / ".ssh-ops"))).expanduser()
    if not p.is_absolute() or p.is_symlink():
        raise ValueError("SSH_OPS_HOME must be an absolute, non-symlink directory")
    p.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != "nt":
        os.chmod(p, 0o700)
    return p


@contextmanager
def database():
    path = home() / "profiles.sqlite3"
    if path.is_symlink():
        raise ValueError("Refusing symlinked profile database")
    # File creation must be private; sqlite3 uses parameterized statements below.
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.close(fd)
    if os.name != "nt":
        os.chmod(path, 0o600)
    db = sqlite3.connect(path, timeout=3)
    db.execute("PRAGMA trusted_schema=OFF")
    db.execute("CREATE TABLE IF NOT EXISTS profiles (name TEXT PRIMARY KEY, host TEXT NOT NULL, username TEXT NOT NULL, port INTEGER NOT NULL, identity_file TEXT, jump_host TEXT, shell TEXT NOT NULL DEFAULT 'sh')")
    try:
        with db:
            yield db
    finally:
        db.close()


def profiles() -> list[dict]:
    with database() as db:
        rows = db.execute("SELECT name,host,username,port,identity_file,jump_host,shell FROM profiles ORDER BY name").fetchall()
    return [dict(zip(("name", "host", "username", "port", "identity_file", "jump_host", "shell"), row)) for row in rows]


def profile(name: str) -> dict:
    if not NAME.fullmatch(name):
        raise ValueError("Invalid profile name")
    with database() as db:
        row = db.execute("SELECT name,host,username,port,identity_file,jump_host,shell FROM profiles WHERE name=?", (name,)).fetchone()
    if row is None:
        raise ValueError("Unknown SSH profile")
    return dict(zip(("name", "host", "username", "port", "identity_file", "jump_host", "shell"), row))


def save_profile(name: str, host: str, username: str, port: int = 22, identity_file: str = "", jump_host: str = "", shell: str = "sh") -> str:
    if not NAME.fullmatch(name) or not HOST.fullmatch(host) or not USER.fullmatch(username):
        raise ValueError("Invalid profile, hostname or username")
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Invalid SSH port")
    if shell not in ("sh", "powershell"):
        raise ValueError("Shell must be sh or powershell")
    if jump_host and not HOST.fullmatch(jump_host):
        raise ValueError("Invalid jump host; use an SSH hostname or config alias")
    if identity_file:
        path = Path(identity_file).expanduser()
        if not path.is_absolute() or not path.is_file():
            raise ValueError("Identity file must be an existing absolute path")
        identity_file = str(path)
    with database() as db:
        db.execute("INSERT INTO profiles VALUES(?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET host=excluded.host,username=excluded.username,port=excluded.port,identity_file=excluded.identity_file,jump_host=excluded.jump_host,shell=excluded.shell", (name, host, username, port, identity_file or None, jump_host or None, shell))
    incident("profile_saved", name)
    return "Profile saved (no passwords stored)"


def remove_profile(name: str) -> str:
    profile(name)
    with database() as db:
        db.execute("DELETE FROM profiles WHERE name=?", (name,))
    incident("profile_removed", name)
    return "Profile removed"


def incident(event: str, target: str = "", code: int | str = "") -> None:
    # Never log commands, IP addresses, file contents, passwords or SSH output.
    if not re.fullmatch(r"[a-z_]{1,40}", event):
        raise ValueError("Invalid incident event")
    record = {"at": datetime.now(timezone.utc).isoformat(), "event": event,
              "target": target if NAME.fullmatch(target) else "redacted", "code": str(code)[:30]}
    path = home() / "incidents.jsonl"
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        if os.name != "nt":
            os.fchmod(fd, 0o600)
        os.write(fd, (json.dumps(record, separators=(",", ":")) + "\n").encode())
    finally:
        os.close(fd)


def incidents(limit: int = 20) -> list[dict]:
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("Invalid incident limit")
    path = home() / "incidents.jsonl"
    if not path.exists():
        return []
    if path.is_symlink():
        raise ValueError("Refusing symlinked incident log")
    # Bounded read for local state; log rotation is performed by the operator.
    with path.open("rb") as f:
        f.seek(max(0, path.stat().st_size - 65536))
        data = f.read(65536).decode("utf-8", "replace").splitlines()
    result = []
    for line in data[-limit:]:
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return result


def ssh_options(p: dict) -> list[str]:
    args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=12", "-o", "ConnectionAttempts=1",
            "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
            "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes"]
    if os.name != "nt":
        sockets = home() / "cm"
        sockets.mkdir(mode=0o700, exist_ok=True)
        os.chmod(sockets, 0o700)
        args += ["-o", "ControlMaster=auto", "-o", "ControlPersist=300",
                 "-o", f"ControlPath={sockets}/%C"]
    if p["identity_file"]:
        args += ["-i", p["identity_file"]]
    if p["jump_host"]:
        args += ["-J", p["jump_host"]]
    return args


def _run(argv: list[str], *, stdin: bytes | None = None, timeout: int = 20) -> dict:
    """Run without shell interpolation, bounded memory, or blocking stdin writes."""
    if type(timeout) is not int or not 1 <= timeout <= 300:
        raise ValueError("Timeout must be between 1 and 300 seconds")
    process = subprocess.Popen(
        argv, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
    )
    output: dict[str, bytes] = {}
    truncated: dict[str, bool] = {}

    def drain(name: str, stream) -> None:
        chunks = bytearray()
        did_truncate = False
        while block := stream.read(4096):
            available = MAX_BYTES - len(chunks)
            if available < len(block):
                did_truncate = True
            if available > 0:
                chunks.extend(block[:available])
        output[name] = bytes(chunks)
        truncated[name] = did_truncate
        stream.close()

    readers = [
        threading.Thread(target=drain, args=(name, stream), daemon=True)
        for name, stream in (("stdout", process.stdout), ("stderr", process.stderr))
    ]
    for reader in readers:
        reader.start()

    # A remote process may never read stdin. Writing on the caller thread
    # would deadlock before process.wait(timeout) is reached.
    writer = None
    if stdin is not None:
        def send_input() -> None:
            try:
                process.stdin.write(stdin)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                try:
                    process.stdin.close()
                except OSError:
                    pass

        writer = threading.Thread(target=send_input, daemon=True)
        writer.start()

    timed_out = False
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        process.kill()
        process.wait()
        code = 124
    if writer is not None:
        writer.join(timeout=2)
    for reader in readers:
        reader.join(timeout=2)
    return {
        "exit_code": code,
        "timeout": timed_out,
        "stdout": output.get("stdout", b"").decode("utf-8", "replace"),
        "stderr": output.get("stderr", b"").decode("utf-8", "replace"),
        "stdout_truncated": truncated.get("stdout", False),
        "stderr_truncated": truncated.get("stderr", False),
    }


def execute(target: str, command: str, *, authorised: bool = False, confirm: bool = False, timeout: int = 20) -> dict:
    p = profile(target)
    if not isinstance(command, str) or not command.strip() or "\x00" in command or len(command) > 8192:
        raise ValueError("Invalid command")
    if not authorised and not (os.environ.get("SSH_OPS_ALLOW_WRITE") == "1" and confirm):
        raise PermissionError("Arbitrary commands disabled: set SSH_OPS_ALLOW_WRITE=1 and confirm=true")
    remote_shell = ["powershell", "-NoProfile", "-NonInteractive", "-Command", "-"] if p["shell"] == "powershell" else ["sh", "-s"]
    argv = ["ssh", "-T", *ssh_options(p), "-p", str(p["port"]), f'{p["username"]}@{p["host"]}', *remote_shell]
    try:
        result = _run(argv, stdin=(command + "\n").encode(), timeout=timeout)
    except OSError:
        incident("ssh_launch_failure", target)
        raise
    if result["exit_code"] != 0:
        incident("ssh_timeout" if result["timeout"] else "ssh_failure", target, result["exit_code"])
    return result


def health(target: str) -> dict:
    # Fixed diagnostic program; no user-controlled shell fragments.
    p = profile(target)
    diagnostics = "hostname; uptime; df -P /" if p["shell"] == "sh" else "$env:COMPUTERNAME; Get-Uptime; Get-Volume | Select-Object DriveLetter,SizeRemaining,Size"
    result = execute(target, diagnostics, authorised=True)
    pressures = []
    for line in result["stdout"].splitlines():
        match = re.search(r"\b(\d{1,3})%\s+/$", line)
        if match and int(match.group(1)) >= 90:
            pressures.append("root filesystem at or above 90%")
            incident("disk_pressure", target, int(match.group(1)))
    return {**result, "warnings": pressures}


def copy(target: str, source: str, destination: str, direction: str, recursive: bool = False, confirm: bool = False) -> dict:
    p = profile(target)
    if direction not in ("upload", "download") or not confirm:
        raise PermissionError("Specify upload or download and confirm=true")
    if direction == "upload" and os.environ.get("SSH_OPS_ALLOW_WRITE") != "1":
        raise PermissionError("Uploads disabled until SSH_OPS_ALLOW_WRITE=1")
    remote = destination if direction == "upload" else source
    local = source if direction == "upload" else destination
    if not REMOTE_PATH.fullmatch(remote) or ".." in Path(remote).parts:
        raise ValueError("Remote path must be absolute without traversal or shell metacharacters")
    lp = Path(local).expanduser()
    if not lp.is_absolute() or lp.is_symlink():
        raise ValueError("Local path must be absolute and not a symlink")
    if direction == "upload" and (not lp.exists() or (lp.is_dir() and not recursive)):
        raise ValueError("Upload source missing or directory requires recursive=true")
    if direction == "download" and not lp.parent.is_dir():
        raise ValueError("Download destination parent does not exist")
    if direction == "download" and lp.exists():
        raise FileExistsError("Refusing to overwrite existing local path")
    remote_spec = f'{p["username"]}@{p["host"]}:{remote}'
    argv = ["scp", *ssh_options(p), "-P", str(p["port"]), *(["-r"] if recursive else []),
            *( [str(lp), remote_spec] if direction == "upload" else [remote_spec, str(lp)] )]
    try:
        result = _run(argv, timeout=300)
    except OSError:
        incident("transfer_launch_failure", target)
        raise
    if result["exit_code"] != 0:
        incident("transfer_failure", target, result["exit_code"])
    return result


def log_search(target: str, pattern: str = "", unit: str = "", lines: int = 50) -> dict:
    """Search the last hour of journald with bounded, shell-quoted arguments."""
    p = profile(target)
    if p["shell"] != "sh":
        raise ValueError("ssh_log_search currently supports Linux journald only")
    if type(lines) is not int or not 1 <= lines <= 100:
        raise ValueError("Log line limit must be between 1 and 100")
    if not isinstance(pattern, str) or len(pattern) > 80 or any(c in pattern for c in "\\x00\\r\\n"):
        raise ValueError("Invalid search pattern")
    if unit and (not isinstance(unit, str) or not re.fullmatch(r"[A-Za-z0-9_.@-]{1,100}", unit)):
        raise ValueError("Invalid systemd unit")
    command = "journalctl --no-pager --output=short-iso --since='1 hour ago' -n " + str(lines)
    if unit:
        command += " -u " + shlex.quote(unit)
    if pattern:
        command += " --grep=" + shlex.quote(pattern)
    return execute(target, command, authorised=True, timeout=30)


def fleet_health(targets: list[str]) -> list[dict]:
    """Run fixed health diagnostics concurrently and return concise summaries."""
    if (
        not isinstance(targets, list) or not 1 <= len(targets) <= 20
        or any(not isinstance(name, str) or not NAME.fullmatch(name) for name in targets)
        or len(set(targets)) != len(targets)
    ):
        raise ValueError("Provide 1-20 unique valid SSH profile names")

    def check(target: str) -> dict:
        try:
            result = health(target)
            stdout = result.get("stdout", "")
            preview = [line[:120] for line in stdout.splitlines()[:2]]
            return {
                "target": target, "ok": result.get("exit_code") == 0,
                "timeout": bool(result.get("timeout", False)),
                "preview": preview, "warnings": result.get("warnings", [])[:3],
            }
        except (OSError, ValueError, PermissionError):
            incident("fleet_failure", target)
            return {"target": target, "ok": False, "error": "Health check failed"}

    with ThreadPoolExecutor(max_workers=min(4, len(targets))) as pool:
        return list(pool.map(check, targets))
