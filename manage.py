"""Maintenance commands for versioning, extension verification, and daily state."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

import requests

from reporting import record_snapshot, write_report
from ga4_collector import collect_ga4


ROOT = Path(__file__).resolve().parent
EXTENSION = ROOT / "chrome_extension"
VERSION_FILES = {
    "manifest": EXTENSION / "manifest.json",
    "python": ROOT / "linkedin_bot.py",
    "project": ROOT / "pyproject.toml",
    "linkedin": EXTENSION / "content.js",
    "instagram": EXTENSION / "instagram_content.js",
    "facebook": EXTENSION / "facebook_content.js",
    "inbox": EXTENSION / "inbox_content.js",
    "whatsapp": EXTENSION / "whatsapp_content.js",
}
HASHED_EXTENSION_FILES = (
    EXTENSION / "manifest.json",
    EXTENSION / "service_worker.js",
    EXTENSION / "content.js",
    EXTENSION / "instagram_content.js",
    EXTENSION / "facebook_content.js",
    EXTENSION / "inbox_content.js",
    EXTENSION / "whatsapp_content.js",
    EXTENSION / "metrics_content.js",
    EXTENSION / "settings.js",
    EXTENSION / "options.html",
    EXTENSION / "options.css",
    EXTENSION / "options.js",
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
    for key in ("linkedin", "instagram", "facebook", "inbox", "whatsapp"):
        replace_once(VERSION_FILES[key], r"^  const EXTENSION_VERSION = '[^']+'$",
                     f"  const EXTENSION_VERSION = '{target}'")
    build = extension_build()
    for key in ("linkedin", "instagram", "facebook", "inbox", "whatsapp"):
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
    instagram_story_progress = state.get("instagram_likes_since_stories", 0)
    state = {
        "day": date.today().isoformat(),
        "comments": 0, "likes": 0, "messages": 0, "connections": 0,
        "connections_accepted": 0,
        "pending_connections": pending,
        "notification_replies": 0, "replied_notification_ids": replied,
        "last_followup_day": "",
        "instagram_likes": 0, "instagram_story_views": 0,
        "instagram_follows": 0,
        "instagram_likes_since_stories": instagram_story_progress,
        "facebook_likes": 0, "facebook_comments": 0, "facebook_follows": 0,
        "inbox_replies": 0,
    }
    path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    print(f"Reset today's interaction counters for {state['day']}; pending connections preserved.")


def parse_metrics(value: str) -> dict:
    try:
        parsed = json.loads(value)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    metrics = {}
    for item in value.split(","):
        if "=" not in item:
            raise SystemExit("metrics must be JSON or comma-separated key=value pairs")
        key, raw = item.split("=", 1)
        try:
            metrics[key.strip()] = float(raw) if "." in raw else int(raw)
        except ValueError as exc:
            raise SystemExit(f"metric {key.strip()} must be numeric") from exc
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    update = sub.add_parser("extension-update", help="sync extension build and version markers")
    update.add_argument("--bump", choices=("major", "minor", "patch"))
    verify = sub.add_parser("verify-extension", help="prove Chrome loaded the current source")
    verify.add_argument("--wait", type=int, default=0, metavar="SECONDS")
    sub.add_parser("reset-today", help="reset today's LinkedIn and Instagram counters")
    report = sub.add_parser("report", help="generate daily, weekly, monthly and yearly reports")
    snapshot = sub.add_parser("snapshot", help="record an account or GA4 metrics snapshot")
    snapshot.add_argument("source", help="linkedin, facebook, instagram, or ga4:domain")
    snapshot.add_argument("metrics", help="JSON or comma-separated numeric key=value pairs")
    ga4 = sub.add_parser("collect-ga4", help="collect GA4 daily metrics for both websites")
    ga4.add_argument("--days", type=int, default=365)
    schedule = sub.add_parser("install-report-task", help="schedule the report once every day")
    schedule.add_argument("--time", default="23:55", help="local 24-hour time, HH:MM")
    sub.add_parser("install-bridge-task", help="start the local bridge and Ollama at Windows logon")
    args = parser.parse_args()
    if args.command == "extension-update":
        sync_extension(args.bump)
    elif args.command == "verify-extension":
        verify_extension(args.wait)
    elif args.command == "reset-today":
        reset_today()
    elif args.command == "snapshot":
        metrics = parse_metrics(args.metrics)
        print(json.dumps(record_snapshot(ROOT, args.source, metrics), indent=2))
    elif args.command == "collect-ga4":
        rows = collect_ga4(ROOT, args.days)
        print(f"Collected {len(rows)} GA4 daily snapshots.")
        write_report(ROOT)
    elif args.command == "install-report-task":
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", args.time):
            raise SystemExit("--time must use 24-hour HH:MM format")
        task_command = (f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File '
                        f'"{ROOT / "scripts" / "daily_report.ps1"}"')
        subprocess.run(["schtasks.exe", "/Create", "/F", "/SC", "DAILY",
                        "/TN", "CodeCrafter Social Daily Report", "/TR", task_command,
                        "/ST", args.time], check=True)
        print(f"Scheduled CodeCrafter Social Daily Report every day at {args.time}.")
    elif args.command == "install-bridge-task":
        bridge_script = ROOT / "scripts" / "start_bridge.ps1"
        task_command = (f'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden '
                        f'-File "{bridge_script}"')
        try:
            subprocess.run(["schtasks.exe", "/Create", "/F", "/SC", "ONLOGON",
                            "/TN", "CodeCrafter Social Bridge", "/TR", task_command], check=True)
            print("Installed CodeCrafter Social Bridge scheduled task at Windows logon.")
        except subprocess.CalledProcessError:
            subprocess.run(["reg.exe", "add",
                            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                            "/v", "CodeCrafter Social Bridge", "/t", "REG_SZ",
                            "/d", task_command, "/f"], check=True)
            print("Installed CodeCrafter Social Bridge current-user startup entry.")
    else:
        json_path, html_path, report_data = write_report(ROOT)
        print(f"Report state={report_data['phase']}")
        print(json_path)
        print(html_path)


if __name__ == "__main__":
    main()
