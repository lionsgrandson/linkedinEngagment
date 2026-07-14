# LinkedIn and Instagram Engagement Copilot

A local Python copilot that reads the LinkedIn feed visible in your own Chrome session and uses
Ollama for relevance decisions, comment drafting, comment review, and connection-note drafting.

This tool runs without terminal confirmations while remaining observable in the signed-in browser.
Every comment and connection request gets a visible 10-second pre-submit countdown. The browser panel can
pause/resume the bot at any time, and the STOP kill switch still shuts it down completely.

## Features

- Local AI only through Ollama; there is no cloud-AI fallback.
- Two-pass comments: generation followed by a separate human-likeness and safety review.
- Deterministic comment cleanup removes model narration and speaker labels; submitted comments never
  include prefixes such as `Here's a proposed comment`, `comment as Moshe`, or `Moshe S:`.
- Visible 10-second countdown before every comment, reply, connection request, or message submission.
- Always-visible Pause/Resume button; paused time does not consume delays or countdowns.
- Random 5–10 second delay before LinkedIn actions.
- Daily interaction limits are persisted in `state.json`.
- Controls the already-open, normally signed-in Chrome through a local extension.
- Logs actions, decisions, rejected drafts, and errors to `linkedin_bot.log`.
- Separate Pause/Resume control plus STOP-file and Ctrl+C kill switches.
- Strategy-driven targeting for seed-to-Series-A B2B startups, buyer roles, buying signals, and
  referral partners, configured in `linkedin_strategy.json`.
- Relationship-stage message drafting for connection, accepted, useful-followup, diagnostic-call,
  and referral-partner conversations; bulk unsolicited sending is intentionally excluded.
- Engagement topics include web development, B2B startups, personal growth, Zionism, technology,
  software development, and AI. After confirmed engagement, the extension can open the author's
  profile and create a profile-based connection note with the same pauseable 10-second countdown.
- Once per day, the app opens an inactive Notifications tab, queues previously unanswered replies
  to Moshe's comments, drafts a thread-grounded response, reviews it, and submits it through the
  same pauseable countdown. Confirmed notification IDs are retained to prevent duplicate answers.
- During the same daily batch, sent connection profiles are checked for acceptance. When LinkedIn
  exposes the Message action and no Pending/Connect action remains, Ollama drafts and reviews a
  profile-grounded non-pitch opener. The message counts only after the editor clears after Send.
- Qualified author profiles use a persisted one-at-a-time inactive-tab queue. A failed UI attempt is
  retried up to twice, the task survives LinkedIn redirects, and a connection counts only after the
  site confirms it as sent or pending. Completed profile tabs close automatically.
- Append-only KPI events in `linkedin_metrics.jsonl` for scoring, drafts, and confirmed actions.
- Every LinkedIn post rejected by relevance scoring is appended to `skipped_post_topics.txt` with
  the detected topics, configured-topic matches, score, reason, and excerpt. This makes it easy to
  decide which new topics belong in `linkedin_strategy.json`.
- Instagram home, Explore, post, and Reels surfaces use every-other-item mode. The extension takes
  a visible screenshot, local Tesseract OCR reads image/video-frame text, and Ollama combines that
  text with the visible caption before liking or commenting. Separate daily limits cover likes and
  comments. The Instagram bot never posts, follows, or sends messages.

The program does not self-modify or install capabilities autonomously. When a capability is
missing, it logs the error and stops safely so the code can be reviewed before changes are made.

## Requirements

- Python 3.11+
- Google Chrome
- [Ollama](https://ollama.com/) running locally
- An Ollama model such as `llama3.1:8b`
- [Tesseract OCR](https://github.com/UB-Mannheim/tesseract/wiki) installed and available as
  `tesseract.exe` (the standard Windows installer path is detected by `pytesseract`)

## Setup (PowerShell)

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
ollama pull llama3.1:8b
```

The extension controls your existing Chrome tab; it does not launch a test browser.

Start Ollama if it is not already running:

```powershell
ollama serve
```

## Run

First, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select
the exact folder `C:\Projects\linkedinEngagment\chrome_extension`. Do not select a similarly named
folder under `Documents`; Chrome must find `manifest.json` directly inside the selected folder.
This one-time extension install lets Python control
your already-open, normally signed-in Chrome without copying its profile.

### Update the extension after changing code

Run this after an ordinary code fix. It synchronizes the source version markers and creates a new
content build fingerprint:

```powershell
.\.venv\Scripts\python.exe manage.py extension-update --bump patch
```

Use `--bump minor` for a feature and `--bump major` for a breaking change. Then open
`chrome://extensions`, click **Reload** on **CodeCrafter Social Bridge**, and refresh the LinkedIn
or Instagram tab. Chrome does not replace an already-injected content script until that tab is
refreshed. The command updates `chrome_extension/manifest.json`, `pyproject.toml`, the Python app
version, both browser content-script versions, and the build fingerprint. This repository is a
Python project and has no `package.json` or `package-lock.json`; if those files are added later,
they must be versioned by this command too.

With `python linkedin_bot.py` running and a LinkedIn or Instagram tab open, prove that Chrome is
executing the exact current extension files:

```powershell
.\.venv\Scripts\python.exe manage.py verify-extension --wait 30
```

It prints `PASS` only when the version and source fingerprint reported by the loaded Chrome content
script match the files in `chrome_extension`. A failure tells you to reload the extension and tab.

```powershell
python linkedin_bot.py
```

Chrome may remain open before, during, and after the bot runs. Open the LinkedIn feed in any tab
where you are already signed in; the extension connects that tab to Python automatically.

To use another installed Ollama model:

```powershell
$env:OLLAMA_MODEL = "mistral:7b"
python linkedin_bot.py
```

Ollama thinking is disabled for automation decisions so reasoning-capable models such as
`qwen3.5:9b` return their structured result in the API `response` field.

The app loads `.env` automatically. An environment variable already set in the current PowerShell
session takes precedence. If the startup output names an old or missing model, clear that session
override so `.env` is used:

```powershell
Remove-Item Env:OLLAMA_MODEL -ErrorAction SilentlyContinue
python linkedin_bot.py
```

Or select an installed model explicitly for the current terminal:

```powershell
$env:OLLAMA_MODEL = "qwen3.5:9b"
python linkedin_bot.py
```

Optional daily engagement limits:

```powershell
$env:MAX_COMMENTS_PER_DAY = "3"
$env:MAX_LIKES_PER_DAY = "6"
python linkedin_bot.py
```

The LinkedIn relevance threshold is `min_relevance_score` in `linkedin_strategy.json` (default 55).
Edit `engagement_topics` after reviewing `skipped_post_topics.txt`. Restart Python after changing
the strategy file so it is loaded again.

## Reset today's interactions

The following command resets today's LinkedIn counters plus Instagram like and comment counters.
Pending LinkedIn connection checks are preserved:

```powershell
.\.venv\Scripts\python.exe manage.py reset-today
```

Stop the bot before resetting if it is running, then start it again so no in-flight browser action
immediately increments a freshly reset counter.

## Instagram mode

Sign in to `https://www.instagram.com/` in the same normal Chrome profile. The extension runs on the
home feed, Explore, individual posts, and Reels. Click the extension icon once while the Instagram
tab is active to grant Chrome's per-tab screenshot permission for OCR. It shows explicit loading,
success, failure, blank,
and skipped states in its panel; the Pause/Resume button has a hover state and freezes countdowns.
Only every second newly seen item is considered. OCR and comment generation happen locally through
Tesseract and Ollama. Daily limits are configured under `instagram.daily_limits` in
`linkedin_strategy.json`.

Instagram is not topic-gated. Every second item receives the available engagement actions. The
caption is treated as authoritative, OCR noise and watermarks are ignored, and the bot panel is
hidden while the screenshot is captured. If no safe comment can be drafted, liking and scrolling
still continue instead of skipping the item. Instagram never follows accounts or sends messages.

Instagram changes its HTML frequently. When a Like or comment control
cannot be confirmed, the action is reported as a failure and its daily counter is not incremented.
The bot automatically advances after skipped, processed, or completed items. On Explore, it opens
every second visible post/reel tile, processes the modal, closes it, and continues down the grid.

Optional pre-submit countdown override (the default is 10 seconds):

```powershell
$env:SUBMIT_COUNTDOWN = "15"
python linkedin_bot.py
```

## Pause without stopping

Use the **Pause bot** button in the dark CodeCrafter Bot panel at the lower-right of LinkedIn.
Pausing freezes all activity, including an active submit countdown. Click **Resume bot** when ready.
This is separate from the kill switch and does not close the browser.

## Stop immediately

From another PowerShell window:

```powershell
New-Item STOP
```

The delay loop checks for `STOP` every 0.2 seconds. You can also press Ctrl+C. Remove `STOP` before
the next run:

```powershell
Remove-Item STOP
```

## Operational notes

- LinkedIn changes its HTML regularly. Selector failures are logged and never trigger generated
  self-patches.
- The posting-time recommendation is qualitative unless your signed-in feed exposes actual
  analytics. The copilot labels it as a test hypothesis rather than claiming statistical proof.
- Review every proposal for truthfulness and relevance. You remain responsible for all actions.
- If LinkedIn shows a challenge, warning, or unusual login screen, stop and resolve it manually.
