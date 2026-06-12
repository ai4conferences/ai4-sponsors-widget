# Ai4 Sponsors Widget

A self-contained sponsors/exhibitors widget for the Ai4 website, backed by a Cloudflare Worker
that proxies the Swapcard Content API.

## Files

- **`worker.js`** — Cloudflare Worker. Fetches sponsor/exhibitor data from Swapcard, normalizes it,
  and serves it (with edge caching) to the public widget.
- **`wrangler.toml`** — Cloudflare Worker configuration (event/community IDs, allowed origins, env settings).
- **`sponsors-widget.html`** — The embeddable widget (HTML + CSS + JS in one file). Drop this into a
  WordPress "Custom HTML" block or any page.

## Deploying the Worker

Requires a Cloudflare account and [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed.

```bash
npm install -g wrangler
wrangler login

# Set the Swapcard API key as a secret (do NOT put it in wrangler.toml)
wrangler secret put SWAPCARD_API_KEY
wrangler secret put SWAPCARD_API_KEY --env production

# Deploy
wrangler deploy
wrangler deploy --env production
```

## Configuring the Widget

In `sponsors-widget.html`, set the worker URL either by adding a `data-worker-url` attribute to the
root `<div id="ai4-sponsors-root">`, or by setting `window.AI4_SPONSORS_WORKER_URL` before the script
runs, e.g.:

```html
<script>window.AI4_SPONSORS_WORKER_URL = "https://ai4-sponsors-prod.YOUR-SUBDOMAIN.workers.dev";</script>
```

## Endpoints

- `GET /sponsors` — full normalized payload (cached at the edge for 10 minutes)
- `GET /sessions?id=<exhibitorId>` — sessions related to a single sponsor (lazy-loaded on expand)
- `GET /health` — uncached health check
