# LinkedIn, Instagram, and Facebook Engagement Copilot

A local Python copilot and Chrome extension for configurable LinkedIn, Instagram, and Facebook
engagement in your already signed-in browser sessions.

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
- Click the extension icon to open one settings page containing master switches, per-feature
  toggles, and editable topic lists for LinkedIn, Instagram, and Facebook.
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
  same pauseable countdown. Each new reply gets a text fingerprint, so later responses in the same
  thread continue the full conversation without resending an answer to the same notification.
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
- Instagram likes visible feed, Explore, post, and Reel items. Visible text and optional local
  multimodal recognition can narrow activity to configured non-sensitive topics. After
  every 100 confirmed likes it watches the available story sequence to the end, then resumes liking.
  Instagram never posts feed comments. Matching-account follows and inbox replies have separate
  opt-in toggles and configurable daily limits.
- Facebook can like and draft/review comments on matching visible posts. Both actions have separate
  toggles and count only after the browser confirms the result.
- On a specific Instagram or Facebook profile, profile-batch mode likes the configured X newest
  posts, scrolls to the bottom of the loaded profile, then likes another X older posts.
- Inbox answering is disabled by default. When enabled per site, the service worker opens a new
  LinkedIn, Instagram, or Facebook inbox tab once daily, answers unread conversations it can safely
  identify, and closes automation tabs when no unread conversations remain.
- WhatsApp replies run only on `https://web.whatsapp.com/`. The extension opens a dedicated
  WhatsApp Web tab, responds only when the newest visible turn is inbound, confirms the send, and
  closes its automation tab after replying.
- WhatsApp client names can be added to the Automatic clients list for immediate replies. Clients
  not listed there still receive a reply, but only after the visible 10-second cancellation timer.
- The Options page accepts either an LLM-written style summary or plain-text writing samples. The
  locally stored text controls tone only and is never treated as facts, promises, or instructions.
- The Options page also stores verified company information and deterministic inbox safeguards:
  direct messages and groups, direct-only, groups-only, everyone-except-blocked, or exact allowlist.
  Exact blocked contacts always take priority and are rejected before Ollama is called.
- LinkedIn notification interruption is off by default so normal browsing is never redirected.
  It can be enabled explicitly in Options after notification replying is verified on the account.

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
python -m pip install -e .
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

For normal use you do not need to keep a terminal open. Install the Windows logon task once:

```powershell
python manage.py install-bridge-task
```

It starts the local bridge and Ollama in hidden windows after Windows sign-in. Automation tabs are
opened in the background, so the rest of Chrome and the computer remain available. Avoid manually
editing or closing a tab at the exact moment that tab is submitting an action; other tabs and apps
can be used normally.

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

The following command resets today's LinkedIn counters plus Instagram like and story-view counters.
Pending LinkedIn connection checks are preserved:

```powershell
.\.venv\Scripts\python.exe manage.py reset-today
```

Stop the bot before resetting if it is running, then start it again so no in-flight browser action
immediately increments a freshly reset counter.

## Social and Google Analytics reports

Generate one HTML and one JSON report with day, 7-day, 30-day, and 365-day windows:

```powershell
.\.venv\Scripts\python.exe manage.py report
```

The files are written to `reports\latest.html` and `reports\latest.json`. Confirmed browser actions
come from `linkedin_metrics.jsonl`. Organic account totals such as received likes, comments,
followers, connections, messages, and views are stored separately in `account_metrics.jsonl` so
they are never confused with actions performed by the bot.

With the bridge running, the current dashboard is available at
`http://127.0.0.1:8765/dashboard`. The extension settings page also has an **Open statistics
dashboard** button. The dashboard regenerates when opened.

When a LinkedIn profile/dashboard, Instagram profile, or Facebook profile/page exposes clearly
labeled account totals, the extension records them automatically. It intentionally does not sum
numbers from feed posts. Metrics that the site does not expose on the current page stay blank.

The configured GA4 properties are `251729349` for `code-site.tech` and `258133186` for
`mosheschwartzberg.com`. For unattended collection, create a Google service account, grant its
email Viewer access to both GA4 properties, and set `GOOGLE_APPLICATION_CREDENTIALS` to the JSON
credential path. Then run:

```powershell
.\.venv\Scripts\python.exe manage.py collect-ga4 --days 365
.\.venv\Scripts\python.exe manage.py install-report-task --time 23:55
```

The scheduled job refreshes GA4 when credentials are available and always rebuilds the report.
Its correlation section requires at least three dates that have both a social account snapshot and
website traffic; correlation is descriptive and does not prove that social activity caused visits.

## Instagram mode

Sign in to `https://www.instagram.com/` in the same normal Chrome profile. The extension likes each
new visible feed, Explore, post, or Reel item and immediately moves on. It never generates feed
comments. When topics are configured, visible text is checked first and the local Qwen vision model
can classify attached images for non-sensitive topics such as AI, HR, recruiting, or technology.
Appearance-based gender, race, religion, disability, and ethnicity inference is rejected.

Instagram likes have no daily limit. A persistent counter survives day changes and restarts. When
it reaches `story_interval_likes` (100 by default), the extension scrolls to the top, opens Stories,
leaves videos visible for their remaining duration (and images for their display interval), advances
until no Next control remains, refreshes the page, resets the counter, and resumes normal post/reel
liking. The panel provides loading, success, failure, blank, and filled states;
its Pause/Resume button has a hover state and pauses both likes and story advancement.
If Stories cannot be found or do not actually open, the 100-like trigger remains pending and the
page is not refreshed.

Instagram changes its HTML frequently. Likes count only after the Like control changes to Unlike.
Story views count only after the story has remained visible for the viewing interval.

## Settings, topics, and feature toggles

Click the CodeCrafter Social Bridge extension icon or use **Extension details → Extension options**.
Each website has a master switch plus independent toggles for its supported features:

- LinkedIn: likes, comments, connections, notification replies, and inbox messages.
- Instagram: feed likes, Stories, matching-account follows, visual topic recognition, profile-batch
  likes, and inbox messages. Instagram feed comments remain unavailable.
- Facebook: feed likes, feed comments, matching-account follows, visual topic recognition,
  profile-batch likes, and inbox messages.

For Instagram and Facebook, set **Posts per profile section (X)** from 1 to 100. When profile-batch
likes are enabled and you open a specific profile, the extension likes X posts from the top, loads
until page height is stable and no loading indicator remains, then likes another X posts there and
returns to the website home page. The same settings page controls daily follows (20 by default),
daily likes (`0` means unlimited), likes between Instagram story batches, and stories per batch
(`0` means watch all available stories).

Each site also has an editable topic list. Add topics such as `hightech` and `HR`, remove topics with
the chip × button, and save. An empty topic list allows every visible topic. LinkedIn passes the
saved list into its Ollama relevance analysis; Instagram and Facebook use direct visible-text
matching without OCR. Settings are stored in Chrome and take effect without editing JSON files.
Visual recognition runs locally through `qwen3.5:9b`; it does not classify protected traits from
appearance. Explicit self-description text can still be matched like any other configured text topic.

All inbox-message toggles default to off so a real conversation is never answered before setup.
Enable the sites you want and either wait for the automatic run or click **Run enabled inbox replies now**. Every
drafted reply receives a safety review and a visible 10-second pre-submit countdown. The writing
style card accepts pasted text or a `.txt`/`.md` import.

Use **Important information and safeguards** for facts the bot is allowed to state, for example:

```text
Opening hours: Sunday-Thursday, 09:00-17:00.
Friday and Saturday: closed.
Support email: help@example.com.
```

Choose **Groups only** to reject every direct message, or **Direct messages only** to reject group
conversations. Choose **Only allowed contacts** for an exact-name allowlist. Add any contact under
**Never answer** to block it regardless of the other settings. If the extension cannot identify a
contact while allowlist mode is active, it refuses the reply rather than guessing.

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
