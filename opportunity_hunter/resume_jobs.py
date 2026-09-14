from __future__ import annotations

import hashlib
from typing import Any

from . import engine


def suggest_queries() -> list[str]:
    state = engine.load_state()
    resume = str(state.get("resume", {}).get("text", "")).strip()
    if not resume:
        raise ValueError("Upload or paste your resume first")
    prompt = f"""Choose realistic job-search titles for this candidate from the resume only.
Do not invent seniority, certifications, management experience, degrees, or technologies.
Prefer titles that are likely to exist on job boards. Return 3 to 5 distinct search queries.

RESUME:
{resume[:20000]}

Return JSON only: {{"queries":["job title","job title"],"reason":"short explanation"}}
"""
    result = engine.ollama_json(prompt, timeout=180)
    raw = result.get("queries", [])
    queries: list[str] = []
    for item in raw if isinstance(raw, list) else []:
        clean = " ".join(str(item).split()).strip()
        if clean and clean.casefold() not in {existing.casefold() for existing in queries}:
            queries.append(clean[:120])
    if not queries:
        raise RuntimeError("Ollama did not produce usable job search titles")
    return queries[:5]


def _search_one(query: str, location: str, country: str, per_query: int) -> tuple[list[dict[str, Any]], str, list[str]]:
    errors: list[str] = []
    jobs: list[dict[str, Any]] = []
    provider = ""
    status = engine.integration_status()
    if status["adzuna"]["configured"]:
        try:
            jobs = engine.adzuna_search_jobs(query, location, limit=per_query, country=country)
            provider = "adzuna"
        except Exception as exc:
            errors.append(f"Adzuna ({query}): {exc}")
    if not jobs:
        search = (
            f'jobs "{query}" {location} '
            "(site:jobs.lever.co OR site:boards.greenhouse.io OR "
            "site:jobs.workable.com OR site:careers-page.com OR site:linkedin.com/jobs)"
        )
        rows = engine.brave_search(search, count=per_query, country=country)
        jobs = engine._web_results_to_jobs(rows)
        provider = "brave"
    for job in jobs:
        job["resumeSuggestedQuery"] = query
    return jobs, provider, errors


def find_from_resume(location: str, *, country: str = "", limit: int = 25) -> dict[str, Any]:
    queries = suggest_queries()
    per_query = max(3, min(10, (max(5, int(limit)) + len(queries) - 1) // len(queries)))
    combined: list[dict[str, Any]] = []
    errors: list[str] = []
    providers: set[str] = set()
    seen: set[str] = set()
    for query in queries:
        jobs, provider, failures = _search_one(query, location, country, per_query)
        providers.add(provider)
        errors.extend(failures)
        for job in jobs:
            identity = str(job.get("url", "")).strip()
            if not identity:
                identity = f"{job.get('title','')}|{job.get('company','')}|{job.get('location','')}"
            key = hashlib.sha256(identity.casefold().encode()).hexdigest()
            if key in seen:
                continue
            seen.add(key)
            combined.append(job)
    ranked = engine.rank_jobs(combined, " / ".join(queries))[: max(1, min(50, int(limit)))]
    state = engine.load_state()
    state["jobs"] = ranked
    engine.save_state(state)
    return {
        "queries": queries,
        "providers": sorted(provider for provider in providers if provider),
        "jobs": ranked,
        "errors": errors,
    }
