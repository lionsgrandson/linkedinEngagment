from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from typing import Any, Callable
from urllib.parse import urlparse

import requests


_REQUEST = threading.local()


def _clean_url(value: Any) -> str:
    url = str(value or "").strip()
    return url if url.startswith(("http://", "https://")) else ""


def _configured_provider() -> str:
    preferred = os.getenv("HUNTER_SEARCH_PROVIDER", "auto").strip().lower() or "auto"
    if preferred not in {"auto", "tavily", "searxng", "brave"}:
        preferred = "auto"
    return preferred


def _available() -> dict[str, bool]:
    return {
        "tavily": bool(os.getenv("TAVILY_API_KEY", "").strip()),
        "searxng": bool(os.getenv("SEARXNG_URL", "").strip()),
        "brave": bool(os.getenv("BRAVE_SEARCH_API_KEY", "").strip()),
    }


def selected_provider() -> str:
    available = _available()
    preferred = _configured_provider()
    if preferred != "auto" and available.get(preferred):
        return preferred
    for provider in ("tavily", "searxng", "brave"):
        if available[provider]:
            return provider
    return ""


def last_provider() -> str:
    return str(getattr(_REQUEST, "last_provider", "") or "")


@contextmanager
def requested_provider(provider: str):
    previous = getattr(_REQUEST, "requested_provider", None)
    _REQUEST.requested_provider = provider
    try:
        yield
    finally:
        if previous is None:
            try:
                delattr(_REQUEST, "requested_provider")
            except AttributeError:
                pass
        else:
            _REQUEST.requested_provider = previous


def tavily_search(query: str, *, count: int = 10, country: str = "", language: str = "en") -> list[dict[str, Any]]:
    token = os.getenv("TAVILY_API_KEY", "").strip()
    if not token:
        raise RuntimeError("TAVILY_API_KEY is not configured")
    # Tavily accepts natural-language search. Adding the region to the query gives
    # more predictable local results than pretending a country filter exists.
    regional_query = str(query).strip()
    if country:
        regional_query = f"{regional_query} country:{str(country).strip().upper()}"
    response = requests.post(
        "https://api.tavily.com/search",
        json={
            "api_key": token,
            "query": regional_query[:900],
            "topic": "general",
            "search_depth": "basic",
            "max_results": max(1, min(20, int(count))),
            "include_answer": False,
            "include_raw_content": False,
        },
        headers={"Accept": "application/json", "User-Agent": "CodeCrafter-Opportunity-Hunter/1.1"},
        timeout=30,
    )
    response.raise_for_status()
    results = []
    for row in response.json().get("results", []):
        url = _clean_url(row.get("url"))
        if not url:
            continue
        results.append({
            "title": str(row.get("title", "")).strip(),
            "url": url,
            "description": str(row.get("content", "")).strip()[:5000],
            "source": "tavily",
        })
    return results


def searxng_search(query: str, *, count: int = 10, country: str = "", language: str = "en") -> list[dict[str, Any]]:
    base = os.getenv("SEARXNG_URL", "").strip().rstrip("/")
    if not base:
        raise RuntimeError("SEARXNG_URL is not configured")
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError("SEARXNG_URL must be a valid http(s) URL")
    response = requests.get(
        f"{base}/search",
        params={
            "q": str(query)[:900],
            "format": "json",
            "language": (language or "en")[:12],
            "safesearch": 1,
        },
        headers={"Accept": "application/json", "User-Agent": "CodeCrafter-Opportunity-Hunter/1.1"},
        timeout=30,
    )
    response.raise_for_status()
    rows = response.json().get("results", [])
    results = []
    for row in rows[: max(1, min(20, int(count)))]:
        url = _clean_url(row.get("url"))
        if not url:
            continue
        results.append({
            "title": str(row.get("title", "")).strip(),
            "url": url,
            "description": str(row.get("content", "")).strip()[:5000],
            "source": "searxng",
        })
    return results


def search_web(
    query: str,
    *,
    count: int = 10,
    country: str = "",
    language: str = "en",
    brave_search: Callable[..., list[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    requested = str(getattr(_REQUEST, "requested_provider", "") or "").lower()
    preferred = requested if requested in {"tavily", "searxng", "brave"} else _configured_provider()
    available = _available()
    order = [preferred] if preferred != "auto" else ["tavily", "searxng", "brave"]
    errors: list[str] = []
    for provider in order:
        if not available.get(provider):
            errors.append(f"{provider} is not configured")
            continue
        try:
            if provider == "tavily":
                rows = tavily_search(query, count=count, country=country, language=language)
            elif provider == "searxng":
                rows = searxng_search(query, count=count, country=country, language=language)
            elif brave_search is not None:
                rows = brave_search(query, count=count, country=country, language=language)
            else:
                rows = []
            _REQUEST.last_provider = provider
            return rows
        except Exception as exc:
            errors.append(f"{provider}: {exc}")
            if preferred != "auto":
                raise
    raise RuntimeError(
        "No working web-search provider. Easiest: set TAVILY_API_KEY. "
        "No-account option: run local SearXNG and set SEARXNG_URL. "
        + (f"Details: {'; '.join(errors)}" if errors else "")
    )


def install(engine) -> None:
    """Install provider routing without changing the existing Hunter engine API."""
    if getattr(engine, "_SEARCH_PROVIDER_ROUTER_INSTALLED", False):
        return
    original_brave_search = engine.brave_search
    original_integration_status = engine.integration_status
    original_search_jobs = engine.search_jobs
    original_search_clients = engine.search_clients

    def compatible_web_search(query: str, *, count: int = 10, country: str = "", language: str = "en"):
        return search_web(
            query,
            count=count,
            country=country,
            language=language,
            brave_search=original_brave_search,
        )

    def integration_status():
        status = original_integration_status()
        available = _available()
        chosen = selected_provider()
        status["tavilySearch"] = {"configured": available["tavily"]}
        status["searxng"] = {
            "configured": available["searxng"],
            "url": os.getenv("SEARXNG_URL", ""),
        }
        status["webSearch"] = {
            "configured": any(available.values()),
            "provider": chosen,
            "preferred": _configured_provider(),
        }
        return status

    def search_jobs(query: str, location: str, *, country: str = "", limit: int = 15, provider: str = "auto"):
        requested = str(provider or "auto").lower()
        if requested == "web":
            requested = "auto"
        routed = requested if requested in {"tavily", "searxng", "brave"} else "auto"
        engine_provider = "brave" if requested in {"tavily", "searxng", "brave"} else requested
        with requested_provider(routed):
            result = original_search_jobs(
                query,
                location,
                country=country,
                limit=limit,
                provider=engine_provider,
            )
        if result.get("provider") == "brave":
            result["provider"] = last_provider() or selected_provider() or "web"
        return result

    def search_clients(service_type: str, location: str, *, country: str = "", limit: int = 12):
        with requested_provider("auto"):
            result = original_search_clients(service_type, location, country=country, limit=limit)
        if result.get("provider") == "brave":
            result["provider"] = last_provider() or selected_provider() or "web"
        return result

    engine.brave_search = compatible_web_search
    engine.integration_status = integration_status
    engine.search_jobs = search_jobs
    engine.search_clients = search_clients
    engine._SEARCH_PROVIDER_ROUTER_INSTALLED = True
