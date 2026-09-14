# Opportunity Hunter

A separate local module for finding jobs and potential clients without mixing experimental search/outreach code into the existing social-engagement automation.

## What it does

- Accepts a PDF, DOCX, TXT, MD, JSON, CSV, or pasted resume.
- Searches for jobs through Adzuna when configured, otherwise through Brave Search.
- Uses local Ollama to rank jobs against the actual resume and identify gaps.
- Generates a truthful application pack (fit summary, cover letter, likely questions, warnings).
- Searches the public web for potential client businesses.
- Fetches one client website at a time, extracts public email/phone details, and asks Ollama to assess fit using only visible website evidence.
- Drafts email, WhatsApp, and TTS call outreach.
- Requires a one-time approval for each email, WhatsApp draft, or TTS call. Final edits made in the review dialog are the exact content used after approval.
- Stores resume text, search results, and pending approvals only in local `hunter_state.json`, which is ignored by Git.

## Important LinkedIn limitation

This module deliberately does **not** mass-submit LinkedIn Easy Apply or scrape LinkedIn pages. It can discover public job URLs, rank them, prepare the application, and open the real job page. LinkedIn currently prohibits third-party bots/extensions that automate site activity, and high-volume automated behavior can cause account restrictions.

## Start on Windows

Double-click:

```text
run_hunter.cmd
```

Or run manually:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m opportunity_hunter.server
```

Open `http://127.0.0.1:8770`.

## Minimum setup

Ollama is required for ranking and drafting. Brave Search is the simplest general search provider:

```dotenv
OLLAMA_MODEL=qwen3.5:9b
BRAVE_SEARCH_API_KEY=...
```

The search key is used only by the local Python backend. Do not put it in browser JavaScript.

## Optional job provider

Adzuna gives more structured job objects in countries it supports:

```dotenv
ADZUNA_APP_ID=...
ADZUNA_APP_KEY=...
ADZUNA_COUNTRY=gb
```

If Adzuna is missing or unavailable and Brave is configured, Auto mode falls back to Brave Search.

## Optional approved email sending

Any SMTP provider can be used:

```dotenv
OUTREACH_SMTP_HOST=smtp.example.com
OUTREACH_SMTP_PORT=587
OUTREACH_SMTP_USER=...
OUTREACH_SMTP_PASSWORD=...
OUTREACH_SMTP_FROM=you@example.com
OUTREACH_SMTP_STARTTLS=1
```

The app drafts first. The email is sent only after the draft is shown and the user clicks **Approve and send email**.

## Optional approved TTS calls

Twilio Voice is the first implemented provider:

```dotenv
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...
TWILIO_TTS_LANGUAGE=en-US
TWILIO_TTS_VOICE=alice
```

The app drafts a short call script first. The user can edit the script and phone number, then must confirm immediately before the call API is invoked.

Twilio trial accounts have restrictions. Use the Setup tab only as a connection-status view; secrets remain in `.env`.

## WhatsApp

For cold/prospect outreach the current implementation does not auto-send through WhatsApp Web. After approval it opens a `wa.me` URL with the exact approved text prefilled, leaving the final **Send** action in WhatsApp. This avoids silently turning the existing inbound-reply automation into a bulk cold-messaging bot.

## Data and approval model

- Search/research: automatic after the user requests it.
- AI drafting: automatic after the user requests it.
- Job submission: never automatic in this module.
- Email send: one approval token, consumed after one send.
- WhatsApp: one approval token, consumed when the prefilled WhatsApp page is opened.
- TTS call: one approval token, consumed after one call is successfully created.
- If a provider call fails, the approval is restored so the same reviewed draft can be retried.

The local server binds only to `127.0.0.1`. State-changing endpoints require JSON plus the private UI request header, and the server does not expose cross-origin CORS headers.
