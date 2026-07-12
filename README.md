# LinkedIn Engagement Copilot

A local Python copilot that reads the LinkedIn feed visible in your own Chrome session and uses
Ollama for relevance decisions, comment drafting, comment review, and daily post research.

This tool is intentionally human-in-the-loop. It will **never** like, comment, or publish without
an explicit `YES` confirmation. Automating unsolicited engagement or bypassing LinkedIn controls
can create spam, account-security, and platform-policy risks.

## Features

- Local AI only through Ollama; there is no cloud-AI fallback.
- Two-pass comments: generation followed by a separate human-likeness and safety review.
- Two confirmations for comments and daily posts: before filling and before publishing.
- Random 5–10 second delay before LinkedIn actions.
- Daily limits persisted in `state.json`: one post, five comments, and ten likes by default.
- Visible-feed qualitative research for post format, topic, length, and a testable time window.
- Persistent browser profile, so LinkedIn login can survive restarts.
- Logs actions, decisions, rejected drafts, and errors to `linkedin_bot.log`.
- STOP-file and Ctrl+C kill switches.

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
python -m playwright install chromium
ollama pull llama3.1:8b
```

Start Ollama if it is not already running:

```powershell
ollama serve
```

## Run

```powershell
python linkedin_bot.py
```

Chrome opens with a dedicated profile in `.browser-profile`. Sign in manually, return to the
terminal, and press Enter. The copilot will inspect only posts currently visible in the feed.

To use another installed Ollama model:

```powershell
$env:OLLAMA_MODEL = "mistral:7b"
python linkedin_bot.py
```

Optional daily engagement limits:

```powershell
$env:MAX_COMMENTS_PER_DAY = "3"
$env:MAX_LIKES_PER_DAY = "6"
python linkedin_bot.py
```

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
