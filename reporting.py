"""Generate auditable social activity and website traffic reports."""
from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from html import escape
from pathlib import Path


ACTION_EVENTS = {
    "confirmed_like": ("linkedin", "likes"),
    "confirmed_comment": ("linkedin", "comments"),
    "confirmed_message": ("linkedin", "messages"),
    "confirmed_connection": ("linkedin", "connections"),
    "confirmed_connection_accept": ("linkedin", "connections_accepted"),
    "confirmed_notification_reply": ("linkedin", "notification_replies"),
    "confirmed_instagram_like": ("instagram", "likes"),
    "confirmed_instagram_story_view": ("instagram", "story_views"),
    "confirmed_instagram_follow": ("instagram", "follows"),
    "confirmed_facebook_like": ("facebook", "likes"),
    "confirmed_facebook_comment": ("facebook", "comments"),
    "confirmed_facebook_follow": ("facebook", "follows"),
    "confirmed_inbox_reply": ("inbox", "replies"),
}
WINDOWS = ("day", "week", "month", "year")


def _window_start(now: datetime, label: str) -> datetime:
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if label == "week":
        return start - timedelta(days=start.weekday())
    if label == "month":
        return start.replace(day=1)
    if label == "year":
        return start.replace(month=1, day=1)
    return start


def _jsonl(path: Path) -> list[dict]:
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                rows.append(value)
        except json.JSONDecodeError:
            continue
    return rows


def _when(row: dict) -> datetime | None:
    value = row.get("at") or row.get("captured_at")
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)
    except (TypeError, ValueError):
        return None


def _pearson(pairs: list[tuple[float, float]]) -> float | None:
    if len(pairs) < 3:
        return None
    xs, ys = zip(*pairs)
    mean_x, mean_y = sum(xs) / len(xs), sum(ys) / len(ys)
    top = sum((x - mean_x) * (y - mean_y) for x, y in pairs)
    left = math.sqrt(sum((x - mean_x) ** 2 for x in xs))
    right = math.sqrt(sum((y - mean_y) ** 2 for y in ys))
    return round(top / (left * right), 3) if left and right else None


def build_report(root: Path, now: datetime | None = None) -> dict:
    now = now or datetime.now()
    events = _jsonl(root / "linkedin_metrics.jsonl")
    snapshots = _jsonl(root / "account_metrics.jsonl")
    try:
        configured_websites = list(json.loads(
            (root / "analytics_properties.json").read_text(encoding="utf-8")
        ))
    except (FileNotFoundError, json.JSONDecodeError, TypeError):
        configured_websites = []
    report = {
        "generated_at": now.isoformat(timespec="seconds"),
        "phase": "blank",
        "windows": {},
        "account_snapshots": {},
        "website_analytics": {
            domain: {"captured_at": None, "metrics": {}, "verification": {
                "status": "not_connected", "method": "ga4_data_api_missing",
            }} for domain in configured_websites
        },
        "correlation": {},
        "notes": [
            "Only uniquely identified browser confirmations are counted as actions.",
            "Only self-account DOM captures and GA4 Data API rows marked verified are shown.",
            "Legacy counters and snapshots without verification evidence are excluded.",
        ],
    }
    for label in WINDOWS:
        cutoff = _window_start(now, label)
        totals: dict[str, Counter] = defaultdict(Counter)
        failures = Counter()
        for row in events:
            captured = _when(row)
            if not captured or captured < cutoff or captured > now:
                continue
            mapped = ACTION_EVENTS.get(str(row.get("event"))) if row.get("verified") is True and row.get("action_id") else None
            if mapped:
                platform, metric = mapped
                totals[platform][metric] += 1
            elif row.get("allowed") is False or "failure" in str(row.get("event", "")):
                failures[str(row.get("site") or "system")] += 1
        report["windows"][label] = {
            "from": cutoff.isoformat(timespec="seconds"),
            "to": now.isoformat(timespec="seconds"),
            "actions": {platform: dict(values) for platform, values in totals.items()},
            "failures": dict(failures),
        }

    latest: dict[str, dict] = {}
    daily_social_rows, daily_site_rows = {}, {}
    for row in snapshots:
        captured = _when(row)
        verification = row.get("verification") if isinstance(row.get("verification"), dict) else {}
        if not captured or verification.get("status") != "verified":
            continue
        source = str(row.get("source") or row.get("platform") or "unknown")
        if source not in latest or captured > _when(latest[source]):
            latest[source] = row
        date_key = captured.date().isoformat()
        metrics = row.get("metrics") if isinstance(row.get("metrics"), dict) else {}
        if source in {"linkedin", "facebook", "instagram"}:
            daily_social_rows[(source, date_key)] = (
                captured, sum(float(metrics.get(key, 0) or 0) for key in
                              ("likes", "comments", "connections", "followers")))
        if source.startswith("ga4:"):
            daily_site_rows[(source, date_key)] = (captured, float(metrics.get("sessions", 0) or 0))
    report["account_snapshots"] = {
        key: {"captured_at": value.get("captured_at") or value.get("at"),
              "metrics": value.get("metrics", {}), "verification": value.get("verification", {})}
        for key, value in latest.items() if not key.startswith("ga4:")
    }
    report["website_analytics"].update({
        key.removeprefix("ga4:"): {"captured_at": value.get("captured_at") or value.get("at"),
                                    "metrics": value.get("metrics", {}),
                                    "verification": value.get("verification", {})}
        for key, value in latest.items() if key.startswith("ga4:")
    })
    daily_social, daily_sites = defaultdict(float), defaultdict(float)
    for (_, day), (_, value) in daily_social_rows.items():
        daily_social[day] += value
    for (_, day), (_, value) in daily_site_rows.items():
        daily_sites[day] += value
    common = sorted(set(daily_social) & set(daily_sites))
    coefficient = _pearson([(daily_social[day], daily_sites[day]) for day in common])
    report["correlation"] = {
        "days": len(common), "coefficient": coefficient,
        "status": "filled" if coefficient is not None else "blank",
        "explanation": ("Positive values move together; correlation does not prove causation."
                        if coefficient is not None else "At least three matching snapshot days are required."),
    }
    has_actions = any(window["actions"] for window in report["windows"].values())
    has_snapshots = bool(report["account_snapshots"] or any(
        value.get("metrics") for value in report["website_analytics"].values()
    ))
    report["phase"] = "success" if has_actions and has_snapshots else "filled" if has_actions else "blank"
    return report


def render_html(report: dict) -> str:
    def cards(values: dict) -> str:
        blocks = []
        for platform, metrics in sorted(values.items()):
            body = "".join(f"<li><span>{escape(key.replace('_', ' ').title())}</span><b>{int(value)}</b></li>"
                           for key, value in sorted(metrics.items()))
            blocks.append(f"<section class='card'><h3>{escape(platform.title())}</h3><ul>{body}</ul></section>")
        return "".join(blocks) or "<section class='empty'>Blank — no confirmed actions in this period.</section>"

    windows = "".join(
        f"<section><h2>{label.title()}</h2><div class='meta'>Verified actions from "
        f"{escape(data['from'])} through {escape(data['to'])}</div>"
        f"<div class='grid'>{cards(data['actions'])}</div></section>"
        for label, data in report["windows"].items()
    )
    snapshot_cards = cards({
        key: value.get("metrics", {}) for key, value in report["account_snapshots"].items()
    })
    website_cards = "".join(
        (f"<section class='card'><h3>{escape(domain)}</h3><ul>" +
         "".join(f"<li><span>{escape(key.replace('_', ' ').title())}</span><b>{int(value)}</b></li>"
                 for key, value in sorted(item.get('metrics', {}).items())) + "</ul></section>")
        if item.get("metrics") else
        f"<section class='card'><h3>{escape(domain)}</h3><p class='empty'>Not connected — no verified GA4 Data API snapshot.</p></section>"
        for domain, item in sorted(report["website_analytics"].items())
    ) or "<section class='empty'>No website domains are configured.</section>"
    correlation = report["correlation"]
    notes = "".join(f"<li>{escape(note)}</li>" for note in report.get("notes", []))
    return f"""<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width'>
<title>CodeCrafter Social Report</title><style>
:root{{--bg:#08111f;--panel:#111e31;--muted:#9fb0c8;--text:#f5f7fb;--accent:#4ade80}}*{{box-sizing:border-box}}
body{{margin:0;background:linear-gradient(135deg,#08111f,#13243b);color:var(--text);font:15px/1.5 Inter,Arial,sans-serif}}
main{{max-width:1080px;margin:auto;padding:40px 22px}}h1{{margin:0;font-size:clamp(30px,5vw,52px)}}h2{{margin-top:36px}}
.meta,.empty{{color:var(--muted)}}.phase{{display:inline-block;margin-top:12px;padding:6px 10px;border:1px solid #3d5675;border-radius:999px}}.evidence{{margin-top:16px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}}.card,.empty{{background:var(--panel);border:1px solid #263b58;border-radius:16px;padding:18px}}
.card:hover{{border-color:#4d719c;transform:translateY(-1px)}}.card{{transition:.18s ease}}ul{{padding:0;margin:0;list-style:none}}li{{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #20334e}}li:last-child{{border:0}}b{{color:var(--accent)}}
</style></head><body><main><h1>Social + Website Report</h1><div class='meta'>Generated {escape(report['generated_at'])}</div>
<div class='phase'>State: {escape(report['phase'])}</div><section class='card evidence'><h3>Evidence policy</h3><ul>{notes}</ul></section><h2>Automation activity</h2><p class='meta'>Day, week, month, and year can match when every verified action happened today.</p>{windows}<section><h2>Account totals</h2><p class='meta'>Current totals read from the signed-in account pages, not bot-action counts.</p><div class='grid'>{snapshot_cards}</div></section><section><h2>Website analytics</h2><div class='grid'>{website_cards}</div></section>
<section><h2>Traffic correlation</h2><div class='card'><p>Days compared: <b>{correlation['days']}</b></p><p>Coefficient: <b>{correlation['coefficient'] if correlation['coefficient'] is not None else '—'}</b></p><p>{escape(correlation['explanation'])}</p></div></section>
</main></body></html>"""


def write_report(root: Path) -> tuple[Path, Path, dict]:
    report = build_report(root)
    output = root / "reports"
    output.mkdir(exist_ok=True)
    json_path, html_path = output / "latest.json", output / "latest.html"
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    html_path.write_text(render_html(report), encoding="utf-8")
    return json_path, html_path, report


def record_snapshot(root: Path, source: str, metrics: dict, captured_at: str | None = None,
                    verification: dict | None = None) -> dict:
    row = {"captured_at": captured_at or datetime.now().isoformat(timespec="seconds"),
           "source": source, "metrics": metrics,
           "verification": verification or {"status": "unverified", "method": "manual"}}
    with (root / "account_metrics.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")
    return row
