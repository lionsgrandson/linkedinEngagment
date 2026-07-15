"""Collect daily GA4 traffic using Google Application Default Credentials."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from reporting import record_snapshot


def collect_ga4(root: Path, days: int = 365) -> list[dict]:
    try:
        from google.analytics.data_v1beta import BetaAnalyticsDataClient
        from google.analytics.data_v1beta.types import DateRange, Dimension, Metric, RunReportRequest
    except ImportError as exc:
        raise RuntimeError("Install dependencies first: python -m pip install -e .") from exc
    config_path = root / "analytics_properties.json"
    properties = json.loads(config_path.read_text(encoding="utf-8"))
    client = BetaAnalyticsDataClient()
    collected = []
    for domain, property_id in properties.items():
        response = client.run_report(RunReportRequest(
            property=f"properties/{property_id}",
            date_ranges=[DateRange(start_date=f"{max(1, days)}daysAgo", end_date="yesterday")],
            dimensions=[Dimension(name="date")],
            metrics=[Metric(name=name) for name in
                     ("activeUsers", "newUsers", "sessions", "screenPageViews")],
        ))
        for row in response.rows:
            day = datetime.strptime(row.dimension_values[0].value, "%Y%m%d")
            metrics = {"active_users": int(row.metric_values[0].value or 0),
                       "new_users": int(row.metric_values[1].value or 0),
                       "sessions": int(row.metric_values[2].value or 0),
                       "views": int(row.metric_values[3].value or 0),
                       "property_id": int(property_id)}
            collected.append(record_snapshot(root, f"ga4:{domain}", metrics,
                                             day.replace(hour=23, minute=59).isoformat()))
    return collected
