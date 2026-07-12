"""Local, human-in-the-loop LinkedIn engagement copilot.

The program may read the visible feed and prepare Ollama-generated suggestions,
but it never likes, comments, or publishes without an explicit confirmation.
Create a file named STOP beside this script (or press Ctrl+C) to halt it.
"""

from __future__ import annotations

import json
import logging
import os
import random
import signal
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import requests
from playwright.sync_api import BrowserContext, Page, TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


APP_VERSION = "1.0.1"
ROOT = Path(__file__).resolve().parent
STOP_FILE = ROOT / "STOP"
STATE_FILE = ROOT / "state.json"
LOG_FILE = ROOT / "linkedin_bot.log"
PROFILE_DIR = ROOT / ".browser-profile"


@dataclass(frozen=True)
class Settings:
    ollama_url: str = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "llama3.1:8b")
    min_delay: float = 5.0
    max_delay: float = 10.0
    max_comments_per_day: int = int(os.getenv("MAX_COMMENTS_PER_DAY", "5"))
    max_likes_per_day: int = int(os.getenv("MAX_LIKES_PER_DAY", "10"))
    profile_url: str = "https://www.linkedin.com/in/moshe-schwartzberg-ab54401a7/"
    company_url: str = "http://mosheschwartzberg.com/"


SETTINGS = Settings()
RUNNING = True


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler()],
    )


def stop_requested() -> bool:
    return not RUNNING or STOP_FILE.exists()


def handle_stop(_signum: int, _frame: Any) -> None:
    global RUNNING
    RUNNING = False
    logging.warning("Stop signal received; halting before the next action.")


def interruptible_delay(reason: str) -> bool:
    """Enforce the required action buffer while checking STOP every 0.2 seconds."""
    delay = random.uniform(SETTINGS.min_delay, SETTINGS.max_delay)
    logging.info("Waiting %.1fs before %s", delay, reason)
    deadline = time.monotonic() + delay
    while time.monotonic() < deadline:
        if stop_requested():
            return False
        time.sleep(min(0.2, deadline - time.monotonic()))
    return True


def load_state() -> dict[str, Any]:
    default = {"day": date.today().isoformat(), "posts": 0, "comments": 0, "likes": 0}
    if not STATE_FILE.exists():
        return default
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logging.exception("State file was invalid; starting fresh counters")
        return default
    return state if state.get("day") == default["day"] else default


def save_state(state: dict[str, Any]) -> None:
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    temp.replace(STATE_FILE)


def ollama(prompt: str, *, json_mode: bool = False) -> str:
    """Call only the local Ollama API; no cloud AI fallback is permitted."""
    if stop_requested():
        raise KeyboardInterrupt
    payload: dict[str, Any] = {
        "model": SETTINGS.ollama_model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.65},
    }
    if json_mode:
        payload["format"] = "json"
    response = requests.post(f"{SETTINGS.ollama_url}/api/generate", json=payload, timeout=180)
    response.raise_for_status()
    return response.json()["response"].strip()


def relevant_post(post_text: str) -> dict[str, Any]:
    prompt = f"""You are a cautious LinkedIn research assistant. Decide whether the post is
relevant to small business owners, entrepreneurs, or web/technology professionals who might
benefit from CodeCrafter ({SETTINGS.company_url}). Never infer sensitive traits. Return JSON only:
{{"relevant": true|false, "reason": "short reason", "score": 0-100}}.

POST:\n{post_text[:5000]}"""
    try:
        return json.loads(ollama(prompt, json_mode=True))
    except (json.JSONDecodeError, requests.RequestException):
        logging.exception("Ollama relevance analysis failed")
        return {"relevant": False, "reason": "analysis failed", "score": 0}


def generate_comment(post_text: str) -> str:
    styles = random.choice([
        "one concise, thoughtful sentence",
        "two friendly sentences with a practical observation",
        "a brief question grounded in the post",
        "a short professional response with a concrete takeaway",
    ])
    prompt = f"""Draft {styles} as Moshe Schwartzberg responding to this LinkedIn post.
Be specific to the post, natural, non-salesy, and honest. Do not claim experiences or results
not supplied. Do not use generic praise, engagement bait, hashtags, or mention CodeCrafter unless
it is directly useful. Output only the proposed comment.\n\nPOST:\n{post_text[:5000]}"""
    return ollama(prompt)


def evaluate_comment(post_text: str, comment: str) -> dict[str, Any]:
    """Second, independent Ollama pass required before a comment may be offered."""
    prompt = f"""Act as a strict editor. Evaluate whether the proposed LinkedIn comment is human,
specific, truthful, respectful, non-spammy, and useful. Reject generic praise, fabricated claims,
sales pitches, repetitive phrasing, or text that sounds automated. Return JSON only:
{{"pass": true|false, "reason": "short reason", "confidence": 0-100}}.

POST:\n{post_text[:5000]}\n\nCOMMENT:\n{comment}"""
    try:
        return json.loads(ollama(prompt, json_mode=True))
    except (json.JSONDecodeError, requests.RequestException):
        logging.exception("Ollama comment review failed")
        return {"pass": False, "reason": "review failed", "confidence": 0}


def confirm(question: str) -> bool:
    if stop_requested():
        return False
    answer = input(f"\n{question} Type YES to confirm: ").strip()
    return answer == "YES" and not stop_requested()


def visible_posts(page: Page) -> list[Any]:
    page.wait_for_selector("main", timeout=30_000)
    posts = page.locator("div.feed-shared-update-v2:visible")
    return [posts.nth(i) for i in range(min(posts.count(), 8))]


def post_text(post: Any) -> str:
    for selector in (".update-components-text", ".feed-shared-update-v2__description"):
        node = post.locator(selector).first
        if node.count():
            return node.inner_text(timeout=5_000).strip()
    return post.inner_text(timeout=5_000).strip()


def maybe_like(post: Any, state: dict[str, Any]) -> None:
    if state["likes"] >= SETTINGS.max_likes_per_day:
        return
    button = post.locator("button[aria-label*='Like'], button[aria-label*='React Like']").first
    if not button.count() or button.get_attribute("aria-pressed") == "true":
        return
    if confirm("Like this post?") and interruptible_delay("like"):
        button.click()
        state["likes"] += 1
        save_state(state)
        logging.info("Liked a user-confirmed post")


def maybe_comment(post: Any, text: str, state: dict[str, Any]) -> None:
    if state["comments"] >= SETTINGS.max_comments_per_day:
        return
    draft = generate_comment(text)
    review = evaluate_comment(text, draft)
    logging.info("Comment review: %s", review)
    if not review.get("pass") or int(review.get("confidence", 0)) < 75:
        logging.warning("Rejected draft: %s", review.get("reason", "unknown"))
        return
    print(f"\nProposed comment:\n{draft}\nReview: {review.get('reason')}")
    if not confirm("Post this exact comment?") or not interruptible_delay("comment"):
        return
    button = post.locator("button[aria-label*='Comment']").first
    button.click()
    if not interruptible_delay("fill comment editor"):
        return
    editor = post.locator("div[contenteditable='true'][role='textbox']").first
    editor.wait_for(state="visible", timeout=10_000)
    editor.fill(draft)
    # A second confirmation prevents accidental publication after previewing in LinkedIn.
    if confirm("The comment is filled in LinkedIn. Publish it now?") and interruptible_delay("publish comment"):
        post.locator("button.comments-comment-box__submit-button").first.click()
        state["comments"] += 1
        save_state(state)
        logging.info("Published a twice-confirmed comment")
    else:
        editor.fill("")


def analyze_feed(page: Page, state: dict[str, Any]) -> None:
    for post in visible_posts(page):
        if stop_requested():
            return
        try:
            text = post_text(post)
            if len(text) < 30:
                continue
            analysis = relevant_post(text)
            logging.info("Relevance %s: %s", analysis.get("score"), analysis.get("reason"))
            if analysis.get("relevant") and int(analysis.get("score", 0)) >= 70:
                print(f"\nRelevant post ({analysis.get('score')}/100):\n{text[:900]}")
                maybe_like(post, state)
                maybe_comment(post, text, state)
            if interruptible_delay("scroll"):
                post.scroll_into_view_if_needed()
        except PlaywrightTimeoutError:
            logging.exception("LinkedIn post structure changed or timed out")
        except Exception:
            logging.exception("Unexpected error while processing a post")


def research_daily_post(page: Page, state: dict[str, Any]) -> None:
    if state["posts"] >= 1 or not confirm("Research and draft today's optional LinkedIn post?"):
        return
    # Research is grounded only in posts currently visible to the signed-in user.
    samples = [post_text(p)[:1500] for p in visible_posts(page) if len(post_text(p)) > 50][:6]
    prompt = f"""Using the visible LinkedIn samples below as qualitative research, propose one
useful post for Moshe Schwartzberg, serving small businesses and web/tech professionals through
CodeCrafter ({SETTINGS.company_url}). Do not pretend this small sample proves an optimal posting
time. Recommend a testable time window, format, topic, and length, then draft the post. Be useful,
specific, non-salesy, and do not fabricate metrics or client stories. Return JSON with keys
recommended_time, rationale, format, topic, draft.\n\nSAMPLES:\n{json.dumps(samples)}"""
    try:
        result = json.loads(ollama(prompt, json_mode=True))
    except (json.JSONDecodeError, requests.RequestException):
        logging.exception("Daily post research failed")
        return
    print("\nDaily post research:\n" + json.dumps(result, indent=2, ensure_ascii=False))
    if not confirm("Open LinkedIn's post composer and fill this draft?"):
        return
    if not interruptible_delay("open post composer"):
        return
    page.locator("button:has-text('Start a post')").first.click()
    if not interruptible_delay("fill daily post editor"):
        return
    editor = page.locator("div[contenteditable='true'][role='textbox']").first
    editor.wait_for(state="visible", timeout=10_000)
    editor.fill(str(result.get("draft", "")))
    if confirm("Draft is filled. Publish it now?") and interruptible_delay("publish daily post"):
        page.locator("button.share-actions__primary-action").first.click()
        state["posts"] = 1
        state["last_post_at"] = datetime.now().isoformat(timespec="seconds")
        save_state(state)
        logging.info("Published the user-confirmed daily post")
    else:
        logging.info("Daily draft left unposted for manual review")


def run() -> None:
    configure_logging()
    signal.signal(signal.SIGINT, handle_stop)
    if STOP_FILE.exists():
        print(f"Remove {STOP_FILE} before starting.")
        return
    logging.info("Starting LinkedIn copilot v%s with model %s", APP_VERSION, SETTINGS.ollama_model)
    try:
        ollama("Reply with OK only.")
    except requests.RequestException as exc:
        logging.exception("Ollama is unavailable")
        raise SystemExit(f"Ollama unavailable: {exc}") from exc
    state = load_state()
    with sync_playwright() as playwright:
        context: BrowserContext = playwright.chromium.launch_persistent_context(
            str(PROFILE_DIR), headless=False, channel="chrome", viewport=None
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded")
        print("Sign in manually if needed. The copilot never stores your LinkedIn password.")
        input("When the feed is visible, press Enter to continue...")
        try:
            while not stop_requested():
                analyze_feed(page, state)
                research_daily_post(page, state)
                print("\nCycle complete. Waiting before refreshing the visible feed.")
                if not interruptible_delay("next feed cycle"):
                    break
                page.reload(wait_until="domcontentloaded")
        finally:
            context.close()
    logging.info("Stopped cleanly")


if __name__ == "__main__":
    run()
