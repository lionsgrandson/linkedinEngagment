# Opportunity Hunter search providers

Brave is no longer required.

## Recommended: Tavily

Tavily is now the first general-web provider used by Auto mode when `TAVILY_API_KEY` exists.

Add this to the repository `.env`:

```dotenv
TAVILY_API_KEY=your_key_here
HUNTER_SEARCH_PROVIDER=tavily
```

Then restart `run_hunter.cmd`.

Tavily's free Researcher plan currently includes 1,000 API credits per month and does not require a credit card.

## No search-provider account: local SearXNG

If you do not want any hosted search API account, self-host SearXNG and point Hunter at it:

```dotenv
SEARXNG_URL=http://127.0.0.1:8888
HUNTER_SEARCH_PROVIDER=searxng
```

SearXNG must have JSON output enabled. In its `settings.yml`:

```yaml
use_default_settings: true

search:
  formats:
    - html
    - json

server:
  limiter: false
  bind_address: "0.0.0.0"
```

The official SearXNG documentation provides Docker/Compose installation instructions. A local instance commonly maps container port 8080 to localhost port 8888.

## Auto mode

You can omit `HUNTER_SEARCH_PROVIDER` or set:

```dotenv
HUNTER_SEARCH_PROVIDER=auto
```

Auto uses the first configured provider in this order:

1. Tavily
2. local/custom SearXNG
3. Brave Search, if an old Brave key is already configured

Adzuna remains separate. When Adzuna credentials are configured, normal Job Hunter Auto mode may use Adzuna first for structured job listings and fall back to the general web provider when needed. Resume-driven multi-role search uses the general web provider.

## Explicit provider selection

The Job Hunter dropdown supports:

- Auto
- Tavily
- Local SearXNG
- Adzuna
- Brave Search (legacy/optional)

Client Hunter uses Auto general-web search because it needs broad company discovery rather than a jobs-only API.
