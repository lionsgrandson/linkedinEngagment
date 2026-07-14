"""Maintenance commands for versioning, extension verification, and daily state."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from datetime import date
from pathlib import Path

import requests


ROOT = Path(__file__).resolve().parent
EXTENSION = ROOT / "chrome_extension"
VERSION_FILES = {
    "manifest": EXTENSION / "manifest.json",
    "python": ROOT / "linkedin_bot.py",
    "project": ROOT / "pyproject.toml",
    "linkedin": EXTENSION / "content.js",
    "instagram": EXTENSION / "instagram_content.js",
}
HASHED_EXTENSION_FILES = (
    EXTENSION / "manifest.json",
    EXTENSION / "service_worker.js",
    EXTENSION / "content.js",
    EXTENSION / "instagram_content.js",
)


def version() -> str:
    return json.loads(VERSION_FILES["manifest"].read_text(encoding="utf-8"))["version"]


def bump(value: str, level: str) -> str:
    major, minor, patch = map(int, value.split("."))
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def extension_build() -> str:
    digest = hashlib.sha256()
    for path in HASHED_EXTENSION_FILES:
        content = path.read_text(encoding="utf-8")
        content = re.sub(r"const EXTENSION_BUILD = '[^']*'",
                         "const EXTENSION_BUILD = '<normalized>'", content)
        digest.update(path.name.encode())
        digest.update(content.encode())
    return digest.hexdigest()[:12]


def replace_once(path: Path, pattern: str, replacement: str) -> None:
    content = path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.MULTILINE)
    if count != 1:
        raise SystemExit(f"Expected one version marker in {path}, found {count}")
    path.write_text(updated, encoding="utf-8")


def sync_extension(level: str | None) -> None:
    current = version()
    target = bump(current, level) if level else current
    manifest = json.loads(VERSION_FILES["manifest"].read_text(encoding="utf-8"))
    manifest["version"] = target
    VERSION_FILES["manifest"].write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    replace_once(VERSION_FILES["python"], r'^APP_VERSION = "[^"]+"$', f'APP_VERSION = "{target}"')
    replace_once(VERSION_FILES["project"], r'^version = "[^"]+"$', f'version = "{target}"')
    for key in ("linkedin", "instagram"):
        replace_once(VERSION_FILES[key], r"^  const EXTENSION_VERSION = '[^']+'$",
                     f"  const EXTENSION_VERSION = '{target}'")
    build = extension_build()
    for key in ("linkedin", "instagram"):
        replace_once(VERSION_FILES[key], r"^  const EXTENSION_BUILD = '[^']+'$",
                     f"  const EXTENSION_BUILD = '{build}'")
    (EXTENSION / "build_info.json").write_text(
        json.dumps({"version": target, "build": build}, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Extension prepared: version={target} build={build}")
    print("Reload the unpacked extension at chrome://extensions, then refresh the site tab.")


def verify_extension(wait_seconds: int) -> None:
    expected_version = version()
    expected_build = extension_build()
    deadline = time.time() + wait_seconds
    while True:
        try:
            response = requests.get("http://127.0.0.1:8765/extension-status", timeout=2)
            loaded = response.json()
        except requests.RequestException as exc:
            loaded = {"seen": False, "error": str(exc)}
        if (loaded.get("version") == expected_version and
                loaded.get("build") == expected_build):
            print(f"PASS: Chrome is running this code (version={expected_version}, build={expected_build}).")
            print(f"Last browser heartbeat: {loaded.get('seen_at')} at {loaded.get('url')}")
            return
        if time.time() >= deadline:
            raise SystemExit(
                "FAIL: Chrome does not match the current extension files. "
                f"Expected {expected_version}/{expected_build}; loaded "
                f"{loaded.get('version', 'not seen')}/{loaded.get('build', 'not seen')}. "
                "Reload the extension and refresh LinkedIn or Instagram."
            )
        time.sleep(1)


def reset_today() -> None:
    path = ROOT / "state.json"
    state = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    pending = state.get("pending_connections", [])
    replied = state.get("replied_notification_ids", [])
    state = {
        "day": date.today().isoformat(),
        "comments": 0, "likes": 0, "messages": 0, "connections": 0,
        "pending_connections": pending,
        "notification_replies": 0, "replied_notification_ids": replied,
        "last_followup_day": "",
        "instagram_comments": 0, "instagram_likes": 0,
    }
    path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    print(f"Reset today's interaction counters for {state['day']}; pending connections preserved.")


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    update = sub.add_parser("extension-update", help="sync extension build and version markers")
    update.add_argument("--bump", choices=("major", "minor", "patch"))
    verify = sub.add_parser("verify-extension", help="prove Chrome loaded the current source")
    verify.add_argument("--wait", type=int, default=0, metavar="SECONDS")
    sub.add_parser("reset-today", help="reset today's LinkedIn and Instagram counters")
    args = parser.parse_args()
    if args.command == "extension-update":
        sync_extension(args.bump)
    elif args.command == "verify-extension":
        verify_extension(args.wait)
    else:
        reset_today()


if __name__ == "__main__":
    main()
