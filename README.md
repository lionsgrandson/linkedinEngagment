# LinkedIn Engagement Copilot

A local Python copilot that reads the LinkedIn feed visible in your own Chrome session and uses
Ollama for relevance decisions, comment drafting, comment review, and daily post research.

This tool runs without terminal confirmations while remaining observable in the signed-in browser.
Every comment and daily post gets a visible 10-second pre-submit countdown. The browser panel can
pause/resume the bot at any time, and the STOP kill switch still shuts it down completely.

## Features

- Local AI only through Ollama; there is no cloud-AI fallback.
- Two-pass comments: generation followed by a separate human-likeness and safety review.
- Visible 10-second countdown before every comment or daily post submission.
- Always-visible Pause/Resume button; paused time does not consume delays or countdowns.
- Random 5–10 second delay before LinkedIn actions.
- Daily limits persisted in `state.json`: one post, five comments, and ten likes by default.
- Visible-feed qualitative research for post format, topic, length, and a testable time window.
- Controls the already-open, normally signed-in Chrome through a local extension.
- Logs actions, decisions, rejected drafts, and errors to `linkedin_bot.log`.
- Separate Pause/Resume control plus STOP-file and Ctrl+C kill switches.
- Strategy-driven targeting for seed-to-Series-A B2B startups, buyer roles, buying signals, and
  referral partners, configured in `linkedin_strategy.json`.
- Weekday daily-post workflow with a strict one-post-per-day state gate and 70/20/10 content mix.
- Relationship-stage message drafting for connection, accepted, useful-followup, diagnostic-call,
  and referral-partner conversations; bulk unsolicited sending is intentionally excluded.
- Engagement topics include web development, B2B startups, personal growth, Zionism, technology,
  software development, and AI. After confirmed engagement, the extension can open the author's
  profile and create a profile-based connection note with the same pauseable 10-second countdown.
- Sent connection profiles are persisted and checked periodically. When LinkedIn exposes the
  Message action after acceptance, Ollama drafts a profile-grounded non-pitch opener, reviews it,
  and submits it through the same pauseable countdown.
- Qualified author profiles are collected in batches of 15. The extension keeps the feed selected,
  opens the batch as inactive profile tabs, processes their connection requests, closes completed
  tabs, and then continues scrolling the original feed.
- Append-only KPI events in `linkedin_metrics.jsonl` for scoring, drafts, and confirmed actions.

The program does not self-modify or install capabilities autonomously. When a capability is
missing, it logs the error and stops safely so the code can be reviewed before changes are made.

## Requirements

- Python 3.11+
- Google Chrome
- [Ollama](https://ollama.com/) running locally
- An Ollama model such as `llama3.1:8b`

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
the `chrome_extension` folder in this project. This one-time extension install lets Python control
your already-open, normally signed-in Chrome without copying its profile.

After updating extension files, click the extension's reload icon and then refresh the LinkedIn
tab. Chrome does not replace an already-injected content script until its page is refreshed.
To make Chrome treat your updated extension as a new version, increase the `version` value in
`chrome_extension/manifest.json` before reloading the extension.

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

Optional daily engagement limits:

```powershell
$env:MAX_COMMENTS_PER_DAY = "3"
$env:MAX_LIKES_PER_DAY = "6"
python linkedin_bot.py
```

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
