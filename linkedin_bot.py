"""Local, observable LinkedIn engagement copilot.

The program may read the visible feed and prepare Ollama-generated suggestions,
then performs engagement after a visible cancellation window.
Create a file named STOP beside this script (or press Ctrl+C) to halt it.
"""

from __future__ import annotations

import json
import logging
import os
import random
import signal
import shutil
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import requests
from playwright.sync_api import BrowserContext, Page, TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


APP_VERSION = "3.2.2"
ROOT = Path(__file__).resolve().parent
STOP_FILE = ROOT / "STOP"
STATE_FILE = ROOT / "state.json"
LOG_FILE = ROOT / "linkedin_bot.log"
STRATEGY_FILE = ROOT / "linkedin_strategy.json"
METRICS_FILE = ROOT / "linkedin_metrics.jsonl"
SKIPPED_POST_TOPICS_FILE = ROOT / "skipped_post_topics.txt"
DEFAULT_CHROME_DATA = Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"
AUTOMATION_CHROME_DATA = ROOT / ".chrome-profile"


@dataclass(frozen=True)
class Settings:
    ollama_url: str = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "llama3.1:8b")
    min_delay: float = 5.0
    max_delay: float = 10.0
    max_comments_per_day: int = int(os.getenv("MAX_COMMENTS_PER_DAY", "15"))
    max_likes_per_day: int = int(os.getenv("MAX_LIKES_PER_DAY", "15"))
    profile_url: str = "https://www.linkedin.com/in/moshe-schwartzberg-ab54401a7/"
    company_url: str = "http://mosheschwartzberg.com/"
    chrome_user_data_dir: Path = Path(
        os.getenv("CHROME_USER_DATA_DIR", str(DEFAULT_CHROME_DATA))
    )
    chrome_profile: str = os.getenv("CHROME_PROFILE", "Default")
    automation_chrome_user_data_dir: Path = Path(
        os.getenv("AUTOMATION_CHROME_USER_DATA_DIR", str(AUTOMATION_CHROME_DATA))
    )
    submit_countdown: float = float(os.getenv("SUBMIT_COUNTDOWN", "10"))


SETTINGS = Settings()
RUNNING = True
STRATEGY = json.loads(STRATEGY_FILE.read_text(encoding="utf-8"))


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
    logging.warning("Stop signal received; shutting down immediately.")
    raise KeyboardInterrupt


def ensure_control_panel(page: Page) -> None:
    """Install the persistent on-page pause control when LinkedIn replaces the DOM."""
    page.evaluate(
        """
        () => {
          if (document.getElementById('cc-bot-controls')) return;
          if (window.__ccBotPaused === undefined) window.__ccBotPaused = false;
          const panel = document.createElement('div');
          panel.id = 'cc-bot-controls';
          panel.style.cssText = [
            'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
            'width:250px', 'padding:14px', 'border-radius:12px',
            'background:#111827', 'color:white', 'font:14px Arial,sans-serif',
            'box-shadow:0 8px 30px rgba(0,0,0,.35)'
          ].join(';');
          panel.innerHTML = `
            <div style="font-weight:700;margin-bottom:8px">CodeCrafter Bot</div>
            <div id="cc-bot-status" style="margin-bottom:10px">Running</div>
            <button id="cc-bot-pause" type="button" style="width:100%;padding:10px;
              border:0;border-radius:8px;background:#f59e0b;color:#111827;
              font-weight:700;cursor:pointer;transition:filter .15s">Pause bot</button>`;
          document.documentElement.appendChild(panel);
          const button = document.getElementById('cc-bot-pause');
          button.addEventListener('mouseenter', () => button.style.filter = 'brightness(1.12)');
          button.addEventListener('mouseleave', () => button.style.filter = 'none');
          button.addEventListener('click', () => {
            window.__ccBotPaused = !window.__ccBotPaused;
            button.textContent = window.__ccBotPaused ? 'Resume bot' : 'Pause bot';
            button.style.background = window.__ccBotPaused ? '#22c55e' : '#f59e0b';
            document.getElementById('cc-bot-status').textContent =
              window.__ccBotPaused ? 'Paused - nothing will submit' : 'Running';
          });
        }
        """
    )


def browser_paused(page: Page) -> bool:
    ensure_control_panel(page)
    return bool(page.evaluate("() => Boolean(window.__ccBotPaused)"))


def set_panel_status(page: Page, message: str) -> None:
    ensure_control_panel(page)
    page.evaluate(
        "message => { const status = document.getElementById('cc-bot-status'); "
        "if (status) status.textContent = message; }",
        message,
    )


def wait_while_paused(page: Page) -> bool:
    announced = False
    while browser_paused(page):
        if stop_requested():
            return False
        if not announced:
            logging.info("Bot paused from the browser control panel")
            announced = True
        time.sleep(0.2)
    if announced:
        logging.info("Bot resumed from the browser control panel")
    return not stop_requested()


def interruptible_delay(reason: str, page: Page | None = None) -> bool:
    """Enforce the action buffer; paused time does not consume the delay."""
    delay = random.uniform(SETTINGS.min_delay, SETTINGS.max_delay)
    logging.info("Waiting %.1fs before %s", delay, reason)
    remaining = delay
    while remaining > 0:
        if stop_requested():
            return False
        if page is not None and not wait_while_paused(page):
            return False
        step = min(0.2, remaining)
        time.sleep(step)
        remaining -= step
    return True


def pre_submit_countdown(page: Page, action: str) -> bool:
    """Show a ten-second cancellation window; Pause freezes the countdown."""
    remaining = SETTINGS.submit_countdown
    logging.info("Starting %.0fs pre-submit countdown for %s", remaining, action)
    while remaining > 0:
        if stop_requested():
            return False
        if browser_paused(page):
            set_panel_status(page, f"Paused - {action} will not submit")
            if not wait_while_paused(page):
                return False
            continue
        set_panel_status(page, f"{action} submits in {remaining:.1f}s - Pause to hold")
        step = min(0.1, remaining)
        time.sleep(step)
        remaining -= step
    set_panel_status(page, f"Submitting {action} now")
    return not stop_requested() and not browser_paused(page)


def load_state() -> dict[str, Any]:
    default = {"day": date.today().isoformat(), "posts": 0, "comments": 0, "likes": 0,
               "messages": 0, "connections": 0, "pending_connections": []}
    if not STATE_FILE.exists():
        return default
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logging.exception("State file was invalid; starting fresh counters")
        return default
    if state.get("day") != default["day"]:
        default["pending_connections"] = state.get("pending_connections", [])
        return default
    return {**default, **state}


def save_state(state: dict[str, Any]) -> None:
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    temp.replace(STATE_FILE)


def record_metric(event: str, **details: Any) -> None:
    entry = {"at": datetime.now().isoformat(timespec="seconds"), "event": event, **details}
    with METRICS_FILE.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry, ensure_ascii=False) + "\n")


def record_skipped_post(post_text: str, analysis: dict[str, Any]) -> None:
    if not SKIPPED_POST_TOPICS_FILE.exists():
        SKIPPED_POST_TOPICS_FILE.write_text("Skipped post topics\n==================\n", encoding="utf-8")

    text = " ".join(post_text.split())
    matched_topics = [
        topic for topic in STRATEGY.get("engagement_topics", [])
        if topic.lower() in text.lower()
    ]
    if not matched_topics:
        matched_topics = ["no matching engagement topics"]

    excerpt = text[:180]
    entry = (
        f"{datetime.now().isoformat(timespec='seconds')} | "
        f"reason={analysis.get('reason', 'unknown')} | "
        f"topics={', '.join(matched_topics)} | excerpt={excerpt}\n"
    )
    with SKIPPED_POST_TOPICS_FILE.open("a", encoding="utf-8") as stream:
        stream.write(entry)


def prepare_automation_profile() -> Path:
    """Clone the signed-in Chrome profile once because Chrome blocks its default dir."""
    destination = SETTINGS.automation_chrome_user_data_dir
    marker = destination / ".linkedin-bot-profile-ready"
    if marker.exists():
        return destination

    source_profile = SETTINGS.chrome_user_data_dir / SETTINGS.chrome_profile
    if not source_profile.exists():
        raise SystemExit(f"Chrome profile not found: {source_profile}")

    logging.info("Creating a local automation copy of Chrome profile %s", source_profile)
    print("Creating a one-time local copy of your signed-in Chrome profile...")
    destination.mkdir(parents=True, exist_ok=True)
    local_state = SETTINGS.chrome_user_data_dir / "Local State"
    if local_state.exists():
        shutil.copy2(local_state, destination / "Local State")

    ignored_names = {
        "Cache",
        "Code Cache",
        "GPUCache",
        "GrShaderCache",
        "DawnCache",
        "ShaderCache",
        "Crashpad",
        "BrowserMetrics",
        "SingletonCookie",
        "SingletonLock",
        "SingletonSocket",
    }

    def ignore_cache(_directory: str, names: list[str]) -> set[str]:
        return {name for name in names if name in ignored_names or name.startswith("Singleton")}

    shutil.copytree(
        source_profile,
        destination / SETTINGS.chrome_profile,
        dirs_exist_ok=True,
        ignore=ignore_cache,
    )
    marker.write_text(
        f"source={source_profile}\ncreated={datetime.now().isoformat(timespec='seconds')}\n",
        encoding="utf-8",
    )
    logging.info("Automation profile copy is ready at %s", destination)
    return destination


def wait_for_linkedin_feed(page: Page) -> bool:
    """Wait safely for the one-time LinkedIn login without touching page content."""
    login_announced = False
    while not stop_requested():
        if "/feed/" in page.url:
            page.wait_for_selector("main", timeout=30_000)
            return True
        if not login_announced:
            print(
                "LinkedIn needs a one-time sign-in in this Chrome window. "
                "The login will be retained for future runs."
            )
            logging.info("Waiting for one-time LinkedIn sign-in at %s", page.url)
            login_announced = True
        ensure_control_panel(page)
        set_panel_status(page, "Waiting for one-time LinkedIn sign-in")
        time.sleep(0.5)
    return False


def ollama(prompt: str, *, json_mode: bool = False) -> str:
    """Call only the local Ollama API; no cloud AI fallback is permitted."""
    if stop_requested():
        raise KeyboardInterrupt
    payload: dict[str, Any] = {
        "model": SETTINGS.ollama_model,
        "prompt": prompt,
        "stream": False,
        # Thinking models such as qwen3.5 otherwise put all output in `thinking`
        # and leave `response` empty, which cannot be used as a decision.
        "think": False,
        "options": {"temperature": 0.65},
    }
    if json_mode:
        payload["format"] = "json"
    response = requests.post(f"{SETTINGS.ollama_url}/api/generate", json=payload, timeout=180)
    response.raise_for_status()
    data = response.json()
    generated = str(data.get("response", "")).strip()
    if not generated:
        raise ValueError(
            f"Ollama model {SETTINGS.ollama_model} returned an empty response "
            f"(done_reason={data.get('done_reason', 'unknown')})"
        )
    return generated


def relevant_post(post_text: str) -> dict[str, Any]:
    prompt = f"""You are a cautious LinkedIn research assistant for this positioning:
{STRATEGY['positioning']}
Primary ICP: {json.dumps(STRATEGY['icp'], ensure_ascii=False)}
Engagement topics: {json.dumps(STRATEGY['engagement_topics'], ensure_ascii=False)}
Mark relevant=true when the post substantively concerns ANY ONE engagement topic. ICP fit,
buying signals, referral fit, or a genuine web/automation problem CodeCrafter
({SETTINGS.company_url}) can solve should raise the score, but they are NOT required. For example,
a useful software-development, AI, Zionism, personal-growth, or technology post is relevant even
without funding or hiring signals. Never infer sensitive traits. Do not treat mere keyword overlap
as relevance. Return JSON only:
{{"relevant": true|false, "reason": "short reason", "score": 0-100}}.

POST:\n{post_text[:5000]}"""
    try:
        return json.loads(ollama(prompt, json_mode=True))
    except (ValueError, requests.RequestException):
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
Business positioning for context only: {STRATEGY['positioning']}
Be specific to the post, natural, non-salesy, and honest. Do not claim experiences or results
not supplied. Do not use generic praise, engagement bait, hashtags, or mention CodeCrafter unless
it is directly useful. Output only the proposed comment.\n\nPOST:\n{post_text[:5000]}"""
    return ollama(prompt)


def generate_daily_post(samples: list[str], state: dict[str, Any]) -> dict[str, Any]:
    """Generate at most one strategy-aligned post per day."""
    if state["posts"] >= 1:
        return {"allowed": False, "reason": "daily post already used"}
    prompt = f"""Create today's LinkedIn post for Moshe Schwartzberg.
Positioning: {STRATEGY['positioning']}
Offer: {STRATEGY['offer']}
Outcome: {STRATEGY['outcome']}
Content mix: {json.dumps(STRATEGY['content_mix'])}
Topic options: {json.dumps(STRATEGY['content_topics'], ensure_ascii=False)}
Use the visible samples only as qualitative context: {json.dumps(samples[:6], ensure_ascii=False)}
Choose tactical advice most often, founder POV sometimes, and an offer/case-study angle rarely.
Do not fabricate revenue, clients, metrics, or results. Use a useful low-pressure CTA. Return JSON:
{{"category":"tactical|founder_pov|offer_case_study","topic":"...","draft":"..."}}"""
    result = json.loads(ollama(prompt, json_mode=True))
    result["allowed"] = True
    return result


def draft_relationship_message(profile_context: str, stage: str) -> dict[str, Any]:
    """Draft, but never bulk-send, a stage-appropriate LinkedIn message."""
    guidance = STRATEGY["message_stages"].get(stage)
    if not guidance:
        return {"allowed": False, "reason": "unknown relationship stage"}
    prompt = f"""Draft one LinkedIn message as Moshe Schwartzberg.
Positioning: {STRATEGY['positioning']}
Stage: {stage}. Rule: {guidance}
Visible context: {profile_context[:4000]}
Be concise, personalized, truthful, and non-automated. Never invent familiarity, clients, results,
or placeholders such as [Name]. Do not mention the offer before the diagnostic_invite or partner stage.
Return JSON: {{"allowed":true|false,"reason":"...","message":"..."}}"""
    draft = json.loads(ollama(prompt, json_mode=True))
    if not draft.get("allowed") or not draft.get("message"):
        return draft
    message = str(draft["message"]).strip().strip('"')
    forbidden = ("[", "]", "we're helping", "we are helping", "our clients", "similar teams")
    if any(token in message.lower() for token in forbidden):
        return {"allowed": False, "reason": "message contains a placeholder or unsupported proof claim", "message": ""}
    draft["message"] = message
    review_prompt = f"""Strictly review this LinkedIn message for the {stage} stage.
Context: {profile_context[:4000]}
Message: {draft['message']}
Reject fabricated clients/results/familiarity, placeholders, generic automation language, premature
pitches, or a meeting request before relevance is clear. Return JSON only:
{{"pass":true|false,"reason":"...","confidence":0-100}}"""
    review = json.loads(ollama(review_prompt, json_mode=True))
    if not review.get("pass") or int(review.get("confidence", 0)) < 80:
        return {"allowed": False, "reason": review.get("reason", "message review failed"), "message": ""}
    draft["review"] = review
    return draft


def evaluate_comment(post_text: str, comment: str) -> dict[str, Any]:
    """Second, independent Ollama pass required before a comment may be offered."""
    prompt = f"""Act as a strict editor. Evaluate whether the proposed LinkedIn comment is human,
specific, truthful, respectful, non-spammy, and useful. Reject generic praise, fabricated claims,
sales pitches, repetitive phrasing, or text that sounds automated. Return JSON only:
{{"pass": true|false, "reason": "short reason", "confidence": 0-100}}.

POST:\n{post_text[:5000]}\n\nCOMMENT:\n{comment}"""
    try:
        return json.loads(ollama(prompt, json_mode=True))
    except (ValueError, requests.RequestException):
        logging.exception("Ollama comment review failed")
        return {"pass": False, "reason": "review failed", "confidence": 0}


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


def maybe_like(page: Page, post: Any, state: dict[str, Any]) -> None:
    if state["likes"] >= SETTINGS.max_likes_per_day:
        return
    button = post.locator("button[aria-label*='Like'], button[aria-label*='React Like']").first
    if not button.count() or button.get_attribute("aria-pressed") == "true":
        return
    if interruptible_delay("like", page):
        button.click()
        state["likes"] += 1
        save_state(state)
        logging.info("Liked an Ollama-selected relevant post")


def maybe_comment(page: Page, post: Any, text: str, state: dict[str, Any]) -> None:
    if state["comments"] >= SETTINGS.max_comments_per_day:
        return
    draft = generate_comment(text)
    review = evaluate_comment(text, draft)
    logging.info("Comment review: %s", review)
    if not review.get("pass") or int(review.get("confidence", 0)) < 75:
        logging.warning("Rejected draft: %s", review.get("reason", "unknown"))
        return
    print(f"\nProposed comment:\n{draft}\nReview: {review.get('reason')}")
    if not interruptible_delay("open comment editor", page):
        return
    button = post.locator("button[aria-label*='Comment']").first
    button.click()
    if not interruptible_delay("fill comment editor", page):
        return
    editor = post.locator("div[contenteditable='true'][role='textbox']").first
    editor.wait_for(state="visible", timeout=10_000)
    editor.fill(draft)
    if pre_submit_countdown(page, "comment"):
        post.locator("button.comments-comment-box__submit-button").first.click()
        state["comments"] += 1
        save_state(state)
        set_panel_status(page, "Running - comment submitted")
        logging.info("Published an Ollama-reviewed comment after the visible countdown")
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
                maybe_like(page, post, state)
                maybe_comment(page, post, text, state)
            else:
                record_skipped_post(text, analysis)
            if interruptible_delay("scroll", page):
                post.scroll_into_view_if_needed()
        except PlaywrightTimeoutError:
            logging.exception("LinkedIn post structure changed or timed out")
        except Exception:
            logging.exception("Unexpected error while processing a post")


def research_daily_post(page: Page, state: dict[str, Any]) -> None:
    if state["posts"] >= 1:
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
    except (ValueError, requests.RequestException):
        logging.exception("Daily post research failed")
        return
    print("\nDaily post research:\n" + json.dumps(result, indent=2, ensure_ascii=False))
    draft = str(result.get("draft", "")).strip()
    if not draft:
        logging.warning("Ollama returned an empty daily post draft; nothing will be posted")
        return
    if not interruptible_delay("open post composer", page):
        return
    page.locator("button:has-text('Start a post')").first.click()
    if not interruptible_delay("fill daily post editor", page):
        return
    editor = page.locator("div[contenteditable='true'][role='textbox']").first
    editor.wait_for(state="visible", timeout=10_000)
    editor.fill(draft)
    if pre_submit_countdown(page, "daily post"):
        page.locator("button.share-actions__primary-action").first.click()
        state["posts"] = 1
        state["last_post_at"] = datetime.now().isoformat(timespec="seconds")
        save_state(state)
        set_panel_status(page, "Running - daily post submitted")
        logging.info("Published the daily post after the visible countdown")
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
    from extension_server import run_server
    run_server(sys.modules[__name__])
    return
    state = load_state()
    with sync_playwright() as playwright:
        if not SETTINGS.chrome_user_data_dir.exists():
            raise SystemExit(
                f"Chrome profile directory not found: {SETTINGS.chrome_user_data_dir}"
            )
        automation_profile = prepare_automation_profile()
        try:
            context: BrowserContext = playwright.chromium.launch_persistent_context(
                str(automation_profile),
                headless=False,
                channel="chrome",
                viewport=None,
                timeout=30_000,
                args=[f"--profile-directory={SETTINGS.chrome_profile}"],
            )
        except KeyboardInterrupt:
            logging.info("Stopped during Chrome startup")
            return
        except Exception as exc:
            logging.exception("Could not open the normal Chrome profile")
            raise SystemExit(
                "Could not open the bot's local Chrome profile copy. Close the Chrome window "
                "opened by the bot, then retry."
            ) from exc
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded")
        if not wait_for_linkedin_feed(page):
            context.close()
            return
        ensure_control_panel(page)
        print(
            f"Using a local copy of signed-in Chrome profile: {SETTINGS.chrome_profile}. "
            "The copilot never stores your LinkedIn password."
        )
        try:
            while not stop_requested():
                analyze_feed(page, state)
                research_daily_post(page, state)
                print("\nCycle complete. Waiting before refreshing the visible feed.")
                if not interruptible_delay("next feed cycle", page):
                    break
                page.reload(wait_until="domcontentloaded")
        finally:
            context.close()
    logging.info("Stopped cleanly")


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        logging.info("Stopped cleanly by Ctrl+C")
        print("\nStopped.")
