"""One-time, non-destructive import of legacy JSON server metadata (no secrets)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from . import core


def import_legacy(directory: Path, apply: bool = False) -> dict:
    directory = directory.expanduser()
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Legacy profiles directory must exist and not be a symlink")
    index = directory / "_index.json"
    if index.is_symlink() or not index.is_file() or index.stat().st_size > 1_000_000:
        raise ValueError("Missing or invalid legacy index")
    names = json.loads(index.read_text(encoding="utf-8")).get("profileNames", [])
    if not isinstance(names, list) or len(names) > 5000:
        raise ValueError("Invalid legacy profile index")
    result = {"imported": [], "skipped": []}
    for name in names:
        if not isinstance(name, str) or not core.NAME.fullmatch(name):
            result["skipped"].append("invalid_name")
            continue
        source = directory / f"{name}.json"
        try:
            if source.is_symlink() or source.stat().st_size > 16_384:
                raise ValueError("symlink or oversized profile")
            info = json.loads(source.read_text(encoding="utf-8"))
            # Old nested jumps and password auth need an explicit migration decision.
            if any(info.get(field) for field in ("encryptedPassword", "password", "jumpProfile", "localSwitchUser")):
                raise ValueError("credentials or unsupported legacy routing")
            if apply:
                core.save_profile(name, info["host"], info["user"],
                                  int(info.get("port") or 22), info.get("identityFile") or "",
                                  info.get("jumpHost") or "", "powershell" if info.get("shell") == "powershell" else "sh")
            result["imported"].append(name)
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            result["skipped"].append(name)
    return {"dry_run": not apply, **result}


def main() -> None:
    parser = argparse.ArgumentParser(description="Import only non-secret SSH profiles into SQLite")
    parser.add_argument("--source", type=Path, default=core.home() / "ssh-ops-profiles")
    parser.add_argument("--apply", action="store_true", help="Actually write SQLite profiles")
    args = parser.parse_args()
    print(json.dumps(import_legacy(args.source, args.apply), indent=2))


if __name__ == "__main__":
    main()
