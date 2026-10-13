# Ai4 Sponsors Widget

A self-contained sponsors/exhibitors widget for the Ai4 website, backed by a Cloudflare Worker
that proxies the Swapcard Content API.

## Files

- **`seo.js`** — Server-side rendering for ai4.com (see below).
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

- `GET /api/...` — same endpoints under `/api/` (works on any host)

## Server-side rendering (SEO / LLM readability)

The widget renders client-side, so crawlers and LLMs that don't run JS saw
an empty grid. The production Worker also runs on
`ai4.com/sponsors-exhibitors*` and writes real HTML into the (static)
WordPress page as it streams through (Cloudflare `HTMLRewriter`). The widget
then reuses those cards instead of rebuilding them. Code: `seo.js`.

| URL | What it serves |
|---|---|
| `/sponsors-exhibitors/` | Page with every public sponsor pre-rendered in its tier section as a real link, plus `ItemList` JSON-LD |
| `/sponsors-exhibitors/<slug>/` | Sponsor profile: own title/description/canonical, `Organization` JSON-LD, description, tier, booth (hidden while `data-hide-booths` is on the root div), product types, sessions (linked to the Swapcard agenda, speakers linked to ai4.com/speakers/), website/socials |
| `/sponsors-exhibitors/sitemap.xml` | Sitemap of profile URLs |
| `/sponsors-exhibitors.md` | Plain-markdown directory for LLMs |

- Only sponsors marked **Include in public list = yes** are rendered (same rule as the widget).
- Same HTML for everyone (no bot detection). Any failure passes the page through untouched; page views never wait on Swapcard (cold cache → page served as before, cache warms in the background).
- Clicking a card still opens the modal; the URL changes to the sponsor's profile so it can be shared. Back/Escape returns to the list.
- Debug header: `X-Sponsors-SSR: list | sponsor | bypass-cold | sitemap | markdown`.
- Settings in `wrangler.toml` (`[env.production]`): `routes`, `workers_dev = true` (keeps the API URL alive), `SITE_HOSTS`, `SITE_ORIGIN`, `SPONSORS_PATH`, `EVENT_LABEL`, `SESSION_URL_BASE` (update the event slug yearly), the `SPEAKERS` service binding, optional `SPONSORS_KV` + hourly cron (commented out in `wrangler.toml`).

### Rollout order
1. `npx wrangler deploy --env production` — the Worker works with the current widget too.
2. Paste the updated `sponsors-widget.html` into the WordPress block (keep `data-hide-booths` on the root div if booths are still hidden) and regenerate the static site.
3. Submit `https://ai4.com/sponsors-exhibitors/sitemap.xml` in Search Console.
