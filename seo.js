// seo.js — server-side rendering of the sponsors directory on ai4.com
// =====================================================================
// When this Worker is routed on the site (ai4.com/sponsors-exhibitors*), it
// fetches the real (static) WordPress page and, as it streams through, writes
// real HTML for every sponsor into it with HTMLRewriter. The widget JS then
// reuses those cards ("hydration").
//
// Everyone — people, Google, LLM crawlers — gets the SAME HTML (no bot
// sniffing). Any failure passes the page through untouched.
//
// Routes (relative to SPONSORS_PATH, default "/sponsors-exhibitors/"):
//   /sponsors-exhibitors/              → page + pre-rendered tier sections + JSON-LD
//   /sponsors-exhibitors/<slug>/       → sponsor profile (page shell, own title/canonical/meta,
//                                        description, booth, product types, sessions)
//   /sponsors-exhibitors/sitemap.xml   → sitemap of profile URLs
//   /sponsors-exhibitors.md            → plain-markdown directory for LLMs

const SLUGGED = new WeakSet();
let speakerMemo = null; // { at, map: Map(lowercase full name → slug) }

// ---------- entry points ----------

// SITE_HOSTS: comma list of hostnames; an entry ending in ".*" matches by prefix.
export function isSiteRequest(url, env) {
  const host = url.hostname.toLowerCase();
  const hosts = (env.SITE_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return hosts.some((h) => (h.endsWith(".*") ? host.startsWith(h.slice(0, -1)) : host === h));
}

/**
 * @param data loaders injected from worker.js:
 *   loadSponsors(env, ctx, { allowCold }) → { data, generatedAt } | null
 *   loadSessions(env, ctx, { allowCold }) → Session[] | null
 */
export async function handleSite(request, env, ctx, data) {
  let res = await routeSite(request, env, ctx, data);
  if (env.NOINDEX === "true") {
    res = new Response(res.body, res);
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return res;
}

async function routeSite(request, env, ctx, data) {
  if (request.method !== "GET" && request.method !== "HEAD") return originFetch(request, env);
  const url = new URL(request.url);
  const base = sponsorsBase(env);
  const path = url.pathname;
  try {
    if (path === base) return await renderListPage(request, env, ctx, data);
    if (path === base + "sitemap.xml") return (await renderSitemap(request, env, ctx, data)) || originFetch(request, env);
    if (path === base.replace(/\/$/, "") + ".md") return (await renderMarkdown(request, env, ctx, data)) || originFetch(request, env);
    if (path.startsWith(base)) {
      const m = path.slice(base.length).match(/^([a-z0-9-]+)(\/?)$/);
      if (m) {
        const res = await renderSponsorPage(request, env, ctx, data, m[1], m[2] === "/");
        if (res) return res;
      }
    }
  } catch (err) {
    console.error("[seo] render failed, passing through:", (err && err.stack) || err);
  }
  return originFetch(request, env);
}

// ---------- slugs ----------

export function slugify(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "sponsor";
}

/** Adds a stable `slug` to each sponsor (lowest id keeps the plain slug on a name clash). */
export function withSlugs(sponsors) {
  if (!Array.isArray(sponsors) || SLUGGED.has(sponsors)) return sponsors;
  const groups = new Map();
  for (const s of sponsors) {
    const b = slugify(s.name);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(s);
  }
  for (const [b, list] of groups) {
    list.sort((a, c) => String(a.id).localeCompare(String(c.id)));
    list.forEach((s, i) => { s.slug = i === 0 ? b : `${b}-${slugify(String(s.id)).slice(-6)}`; });
  }
  SLUGGED.add(sponsors);
  return sponsors;
}

// ---------- shared sponsor logic (mirrors sponsors-widget.html) ----------

function publicSponsors(payload) {
  const all = withSlugs(payload.sponsors || []);
  const names = (payload.fieldDefinitions || []).map((d) => d.name).filter(Boolean);
  const field = names.find((n) => /include.*public.*list/i.test(n)) || names.find((n) => /public.*list/i.test(n)) || null;
  if (!field) return all.slice();
  return all.filter((s) => {
    const f = s.customFields?.[field];
    if (!f) return false;
    const vals = f.type === "multiselect" ? (f.values || []) : (f.value ? [f.value] : []);
    return vals.some((v) => /^(yes|true|public)$/i.test(String(v).trim()));
  });
}

function getSponsorTier(s) {
  const cf = s.customFields?.["Sponsor Level"];
  if (cf) return cf.type === "multiselect" ? (cf.values && cf.values[0]) || null : cf.value || null;
  return s.sponsorLevel?.name || null;
}

const TIER_LABEL = { "tier-1": "Diamond", "tier-2": "Platinum", "tier-3": "Gold", "tier-4": "Silver", "tier-5": "Bronze", partner: "Partner", exhibitor: "Exhibitor" };
function displayTier(name) {
  if (!name) return name;
  return TIER_LABEL[String(name).toLowerCase().trim()] || name;
}

function tierSorterFor(payload) {
  const priority = new Map();
  const def = (payload.fieldDefinitions || []).find((d) => d.name === "Sponsor Level");
  if (def && def.options) def.options.forEach((o, i) => priority.set(o.value, i));
  return (a, b) => {
    const ai = priority.has(a) ? priority.get(a) : Infinity;
    const bi = priority.has(b) ? priority.get(b) : Infinity;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  };
}

/** Same grouping/order as the widget's render(): [{ tier, label, sponsors }] */
function groupByTier(payload, sponsors) {
  const byTier = new Map();
  const noTier = [];
  for (const s of sponsors) {
    const t = getSponsorTier(s);
    if (t) { if (!byTier.has(t)) byTier.set(t, []); byTier.get(t).push(s); } else noTier.push(s);
  }
  const out = [...byTier.keys()].sort(tierSorterFor(payload)).map((t) => ({
    tier: t, label: displayTier(t), sponsors: byTier.get(t).sort((a, b) => a.name.localeCompare(b.name)),
  }));
  if (noTier.length) out.push({ tier: "Other", label: "Other", sponsors: noTier.sort((a, b) => a.name.localeCompare(b.name)) });
  return out;
}

const ACRONYM_MAP = { ai: "AI", it: "IT", bi: "BI", ml: "ML", llm: "LLM", nlp: "NLP", api: "API", sdk: "SDK", iot: "IoT", ui: "UI", ux: "UX", ar: "AR", vr: "VR", qa: "QA", rpa: "RPA", saas: "SaaS", gpu: "GPU", gpus: "GPUs", cpu: "CPU", cpus: "CPUs", ci: "CI", cd: "CD" };
const LOWERCASE_WORDS = new Set(["and", "or", "of", "the", "to", "for", "in", "on", "at", "by", "with", "a", "an"]);
function prettifyValue(s) {
  if (!s || typeof s !== "string" || !/^[a-z0-9-]+$/.test(s)) return s;
  return s.split("-").map((w, i) => ACRONYM_MAP[w] || (i > 0 && LOWERCASE_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

function boothLabel(name, s) {
  const idx = (s.booths || []).indexOf(name);
  return (idx >= 0 && s.boothLabels && s.boothLabels[idx]) || "Booth";
}

// ---------- list page ----------

async function renderListPage(request, env, ctx, data) {
  const loaded = await data.loadSponsors(env, ctx, { allowCold: false });
  if (!loaded) return tag(await originFetch(request, env), "bypass-cold");

  const origin = await originFetch(request, env);
  if (!origin.ok || !isHtml(origin)) return origin;

  const base = sponsorsBase(env);
  const siteOrigin = siteOriginFor(request, env);
  const sponsors = publicSponsors(loaded.data);
  const groups = groupByTier(loaded.data, sponsors);
  let index = 0;
  const html = groups.map((g) =>
    `<section class="a4s-tier-section"><header class="a4s-tier-header"><h2 class="a4s-tier-name">${esc(g.label)}</h2></header><div class="a4s-grid">` +
    g.sponsors.map((s) => cardHtml(s, base, index++)).join("") +
    `</div></section>`
  ).join("");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${eventLabel(env)} Sponsors & Exhibitors`,
    numberOfItems: sponsors.length,
    itemListElement: groups.flatMap((g) => g.sponsors).map((s, i) => ({
      "@type": "ListItem", position: i + 1, url: siteOrigin + base + s.slug + "/", name: s.name,
    })),
  };

  const rw = new HTMLRewriter()
    .on("#ai4-sponsors-root .a4s-content", {
      element(el) {
        el.setAttribute("data-ssr", String(sponsors.length));
        el.setInnerContent(html, { html: true });
      },
    })
    .on("head", {
      element(el) {
        el.append(
          `<link rel="alternate" type="text/markdown" href="${esc(base.replace(/\/$/, "") + ".md")}" title="Sponsors & exhibitors (markdown)">` + ldScript(jsonLd),
          { html: true }
        );
      },
    });
  return tag(cleanHeaders(rw.transform(origin)), "list");
}

// Must match renderCard() in sponsors-widget.html so the widget can reuse it.
function cardHtml(s, base, index) {
  const logo = s.logoUrl
    ? `<div class="a4s-card-logo"><img src="${esc(s.logoUrl)}" alt="${esc(s.name)} logo" loading="${index < 12 ? "eager" : "lazy"}" decoding="async" onerror="var p=this.parentElement;p.classList.add('is-empty');p.textContent=this.alt.replace(/ logo$/,'');"></div>`
    : `<div class="a4s-card-logo is-empty">${esc(s.name)}</div>`;
  // The visually-hidden name gives text-only readers (LLMs, screen readers)
  // the company name that the logo shows.
  const srName = s.logoUrl ? `<span class="a4s-sr-only" style="position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0">${esc(s.name)}</span>` : "";
  return `<a class="a4s-card" href="${esc(base + s.slug + "/")}" data-id="${esc(s.id)}" aria-label="${esc(s.name)}">${logo}${srName}</a>`;
}

// ---------- sponsor profile page ----------

async function renderSponsorPage(request, env, ctx, data, slug, hasSlash) {
  const loaded = await data.loadSponsors(env, ctx, { allowCold: true });
  if (!loaded) return null;
  const s = publicSponsors(loaded.data).find((x) => x.slug === slug);
  if (!s) return null; // unknown or not public → WordPress handles it

  const base = sponsorsBase(env);
  if (!hasSlash) {
    const u = new URL(request.url);
    u.pathname = base + slug + "/";
    return Response.redirect(u.toString(), 301);
  }

  const sessions = ((await data.loadSessions(env, ctx, { allowCold: false })) || [])
    .filter((x) => (x.exhibitorIds || []).includes(s.id))
    .sort((a, b) => (a.beginsAt || "").localeCompare(b.beginsAt || ""));
  const speakerSlugs = sessions.some((x) => (x.speakerNames || []).length) ? await getSpeakerSlugs(env) : null;
  const sessionsHtml = await sessionsSectionHtml(sessions, env, speakerSlugs);

  const shellHeaders = new Headers(request.headers);
  ["if-none-match", "if-modified-since", "range"].forEach((h) => shellHeaders.delete(h));
  const shell = await originFetch(new Request(new URL(base, request.url).toString(), { method: "GET", headers: shellHeaders, redirect: "follow" }), env);
  if (!shell.ok || !isHtml(shell)) return null;

  const siteOrigin = siteOriginFor(request, env);
  const canonical = siteOrigin + base + s.slug + "/";
  const tier = displayTier(getSponsorTier(s));
  const role = tier && !/^(exhibitor|partner|other)$/i.test(tier) ? `${tier} Sponsor` : tier || "Sponsor";
  const title = `${s.name} – ${role} at ${eventLabel(env)}`;
  const description = truncate(`${s.name} is a ${role.toLowerCase()} at ${eventLabel(env)}. ${plain(s.description)}`.trim(), 160);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url: canonical,
    name: title,
    mainEntity: {
      "@type": "Organization",
      name: s.name,
      url: s.websiteUrl || undefined,
      logo: s.logoUrl || undefined,
      description: plain(s.description) ? truncate(plain(s.description), 500) : undefined,
      sameAs: (s.socials || []).map(socialUrl).filter((u) => /^https?:\/\//.test(u)),
    },
  };

  const seen = {};
  const setMeta = (key, value) => ({ element(el) { seen[key] = true; el.setAttribute("content", value); } });
  const rw = new HTMLRewriter()
    .on("title", { element(el) { seen.title = true; el.setInnerContent(title); } })
    .on('meta[name="description"]', setMeta("description", description))
    .on('meta[property="og:title"]', setMeta("ogTitle", title))
    .on('meta[property="og:description"]', setMeta("ogDescription", description))
    .on('meta[property="og:url"]', setMeta("ogUrl", canonical))
    .on('meta[name="twitter:title"]', setMeta("twTitle", title))
    .on('meta[name="twitter:description"]', setMeta("twDescription", description))
    .on('meta[property="og:image"]', s.logoUrl ? setMeta("ogImage", s.logoUrl) : {})
    .on('meta[name="twitter:image"]', s.logoUrl ? setMeta("twImage", s.logoUrl) : {})
    .on('meta[property="og:image:width"], meta[property="og:image:height"], meta[property="og:image:type"]', { element(el) { if (s.logoUrl) el.remove(); } })
    .on('link[rel="canonical"]', { element(el) { seen.canonical = true; el.setAttribute("href", canonical); } })
    .on('link[rel="shortlink"], link[rel="alternate"][type="application/json"]', { element(el) { el.remove(); } })
    .on("script.yoast-schema-graph, script.rank-math-schema, script.rank-math-schema-pro", { element(el) { el.remove(); } })
    .on("head", {
      element(el) {
        el.onEndTag((end) => {
          let extra = "";
          if (!seen.title) extra += `<title>${esc(title)}</title>`;
          if (!seen.description) extra += `<meta name="description" content="${esc(description)}">`;
          if (!seen.canonical) extra += `<link rel="canonical" href="${esc(canonical)}">`;
          if (!seen.ogTitle) extra += `<meta property="og:title" content="${esc(title)}">`;
          if (!seen.ogDescription) extra += `<meta property="og:description" content="${esc(description)}">`;
          if (!seen.ogUrl) extra += `<meta property="og:url" content="${esc(canonical)}">`;
          if (s.logoUrl && !seen.ogImage) extra += `<meta property="og:image" content="${esc(s.logoUrl)}">`;
          end.before(extra + ldScript(jsonLd), { html: true });
        });
      },
    })
    .on("#ai4-sponsors-root", {
      element(el) {
        const hideBooths = el.hasAttribute("data-hide-booths");
        // data-ai4-initialized makes both old and new widget scripts skip this root.
        el.setAttribute("data-ai4-initialized", "");
        el.setAttribute("data-view", "sponsor");
        el.setInnerContent(profileHtml(s, { base, tier, hideBooths, sessionsHtml }), { html: true });
      },
    });

  const out = cleanHeaders(rw.transform(shell));
  out.headers.delete("link");
  return tag(out, "sponsor");
}

function profileHtml(s, { base, tier, hideBooths, sessionsHtml }) {
  const p = [];
  p.push(`<nav class="a4s-sp-back"><a href="${esc(base)}">← All sponsors &amp; exhibitors</a></nav>`);
  p.push(`<article class="a4s-sp">`);
  p.push(`<header class="a4s-sp-head"><div class="a4s-sp-logo">`);
  p.push(s.logoUrl ? `<img src="${esc(s.logoUrl)}" alt="${esc(s.name)} logo">` : `<span>${esc(s.name)}</span>`);
  p.push(`</div><div class="a4s-sp-head-text">`);
  if (tier) p.push(`<div class="a4s-sp-tier">${esc(tier)}</div>`);
  p.push(`<h1>${esc(s.name)}</h1>`);
  const booths = (s.booths || []).filter((b) => b && b !== "—" && b !== "-");
  if (!hideBooths) for (const b of booths) p.push(`<div class="a4s-sp-booth">${esc(boothLabel(b, s))} ${esc(b)}</div>`);
  p.push(`</div></header>`);

  const paras = String(s.description || "").split(/\r\n|\r|\n/).map((x) => x.trim()).filter(Boolean);
  if (paras.length) p.push(`<section><h2>About ${esc(s.name)}</h2>${paras.map((x) => `<p>${esc(x)}</p>`).join("")}</section>`);

  const types = s.customFields?.["Product Types"]?.values || s.customFields?.["Product Type"]?.values || [];
  if (types.length) p.push(`<section><h2>Product types</h2><ul class="a4s-sp-pills">${types.map((t) => `<li>${esc(prettifyValue(t))}</li>`).join("")}</ul></section>`);

  if (sessionsHtml) p.push(sessionsHtml);

  const socials = (s.socials || []).filter((x) => x && x.url);
  if (s.websiteUrl || socials.length) {
    p.push(`<section><h2>Links</h2><ul class="a4s-sp-links">`);
    if (s.websiteUrl) p.push(`<li><a href="${esc(s.websiteUrl)}" target="_blank" rel="noopener">${esc(s.websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a></li>`);
    for (const x of socials) p.push(`<li><a href="${esc(socialUrl(x))}" target="_blank" rel="noopener nofollow">${esc(friendlySocialName(x.type))}</a></li>`);
    p.push(`</ul></section>`);
  }
  p.push(`</article>`);
  p.push(`<style>
    #ai4-sponsors-root[data-view="sponsor"] { max-width: 860px; margin: 0 auto; padding: 8px 16px 56px; font-family: Lato, inherit; color: #1a1a1a; }
    #ai4-sponsors-root .a4s-sp-back { margin: 0 0 24px; }
    #ai4-sponsors-root .a4s-sp a { color: #553C9A; text-decoration: none; font-weight: 600; }
    #ai4-sponsors-root .a4s-sp a:hover, #ai4-sponsors-root .a4s-sp-back a:hover { text-decoration: underline; }
    #ai4-sponsors-root .a4s-sp-back a { color: #553C9A; font-weight: 700; text-decoration: none; }
    #ai4-sponsors-root .a4s-sp-head { display: grid; grid-template-columns: 200px 1fr; gap: 28px; align-items: center; padding-bottom: 28px; margin-bottom: 28px; border-bottom: 1px solid #E5E7EB; }
    @media (max-width: 600px) { #ai4-sponsors-root .a4s-sp-head { grid-template-columns: 1fr; } }
    #ai4-sponsors-root .a4s-sp-logo { background: #fff; border-radius: 14px; box-shadow: 0 1px 3px rgba(20,16,8,.08); aspect-ratio: 4/3; display: flex; align-items: center; justify-content: center; padding: 18px; font-weight: 700; color: #666; text-align: center; }
    #ai4-sponsors-root .a4s-sp-logo img { max-width: 100%; max-height: 100%; object-fit: contain; }
    #ai4-sponsors-root .a4s-sp-tier { display: inline-block; font-size: 12px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #6B46C1; margin: 0 0 6px; }
    #ai4-sponsors-root .a4s-sp h1 { font-size: 34px; line-height: 1.15; margin: 0 0 8px; color: #1a1a1a; }
    #ai4-sponsors-root .a4s-sp-booth { font-size: 15px; font-weight: 700; color: #4B5563; }
    #ai4-sponsors-root .a4s-sp section { padding-bottom: 24px; margin-bottom: 24px; border-bottom: 1px solid #E5E7EB; }
    #ai4-sponsors-root .a4s-sp section:last-child { border-bottom: 0; }
    #ai4-sponsors-root .a4s-sp h2 { font-size: 18px; font-weight: 800; margin: 0 0 12px; color: #1a1a1a; }
    #ai4-sponsors-root .a4s-sp p { font-size: 15px; line-height: 1.6; color: #4B5563; margin: 0 0 12px; }
    #ai4-sponsors-root .a4s-sp-pills { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
    #ai4-sponsors-root .a4s-sp-pills li { background: rgba(107,70,193,.08); color: #553C9A; border-radius: 999px; padding: 5px 12px; font-size: 13px; font-weight: 600; }
    #ai4-sponsors-root .a4s-sp-links { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px 20px; }
    #ai4-sponsors-root .a4s-sp-session { background: #FBFAF7; border: 1px solid #EEE; border-radius: 12px; padding: 16px; margin: 0 0 12px; }
    #ai4-sponsors-root .a4s-sp-session h3 { font-size: 16px; margin: 0 0 6px; }
    #ai4-sponsors-root .a4s-sp-session-meta { font-size: 13px !important; color: #6B7280 !important; margin: 0 0 8px !important; }
    #ai4-sponsors-root .a4s-sp-session-desc p { font-size: 14px; margin: 0 0 8px; }
  </style>`);
  return p.join("");
}

async function sessionsSectionHtml(sessions, env, speakerSlugs) {
  if (!sessions.length) return "";
  const sessionBase = sessionUrlBase(env);
  const speakerBase = env.SPEAKERS_PAGE_BASE || "/speakers/";
  const parts = [`<section><h2>Sessions at ${esc(eventLabel(env))}</h2>`];
  for (const x of sessions) {
    const href = sessionBase ? sessionBase + encodeURIComponent(x.id).replace(/%3D/g, "=") : "";
    parts.push(`<div class="a4s-sp-session">`);
    parts.push(`<h3>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(x.title || "Untitled session")}</a>` : esc(x.title || "Untitled session")}</h3>`);
    const when = formatSessionTime(x.beginsAt, x.endsAt);
    const meta = [when ? `<time datetime="${esc(x.beginsAt)}">${esc(when)}</time>` : "", x.place ? `${esc(x.place)}` : ""].filter(Boolean).join(" · ");
    if (meta) parts.push(`<p class="a4s-sp-session-meta">${meta}</p>`);
    const desc = x.htmlDescription ? await sanitizeHtml(x.htmlDescription) : x.description ? `<p>${esc(x.description)}</p>` : "";
    if (desc) parts.push(`<div class="a4s-sp-session-desc">${desc}</div>`);
    const names = x.speakerNames || [];
    if (names.length) {
      parts.push(`<p class="a4s-sp-session-meta">Speakers: ${names.map((n) => {
        const person = String(n).split(" · ")[0].trim();
        const slug = speakerSlugs && speakerSlugs.get(person.toLowerCase());
        return slug ? `<a href="${esc(speakerBase + slug + "/")}">${esc(n)}</a>` : esc(n);
      }).join(", ")}</p>`);
    }
    if (href) parts.push(`<p class="a4s-sp-session-meta"><a href="${esc(href)}" target="_blank" rel="noopener">View session in the Ai4 agenda →</a></p>`);
    parts.push(`</div>`);
  }
  parts.push(`</section>`);
  return parts.join("");
}

// Optional: link session speakers to their ai4.com/speakers/<slug>/ pages
// using the speakers Worker's API. Preferred: a service binding named
// SPEAKERS to the "ai4-speakers" Worker (a Worker can't fetch another Worker
// on the same account's workers.dev URL). Fallback: SPEAKERS_API_URL.
// Cached 10 min.
async function getSpeakerSlugs(env) {
  if (!env.SPEAKERS && !env.SPEAKERS_API_URL) return null;
  if (speakerMemo && Date.now() - speakerMemo.at < 10 * 60 * 1000) return speakerMemo.map;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = env.SPEAKERS
      ? await env.SPEAKERS.fetch("https://ai4-speakers.internal/speakers", { signal: ctrl.signal })
      : await fetch(env.SPEAKERS_API_URL, { signal: ctrl.signal, cf: { cacheTtl: 600, cacheEverything: true } });
    if (!r.ok) throw new Error("speakers HTTP " + r.status);
    const d = await r.json();
    const map = new Map();
    for (const sp of d.speakers || []) if (sp.slug && sp.fullName) map.set(sp.fullName.trim().toLowerCase(), sp.slug);
    speakerMemo = { at: Date.now(), map };
    return map;
  } catch (err) {
    console.error("[seo] speakers lookup failed:", err && err.message);
    return speakerMemo ? speakerMemo.map : null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- sitemap & markdown ----------

async function renderSitemap(request, env, ctx, data) {
  const loaded = await data.loadSponsors(env, ctx, { allowCold: true });
  if (!loaded) return null;
  const base = sponsorsBase(env);
  const siteOrigin = siteOriginFor(request, env);
  const lastmod = new Date(loaded.generatedAt || Date.now()).toISOString().slice(0, 10);
  const urls = [siteOrigin + base].concat(publicSponsors(loaded.data).map((s) => siteOrigin + base + s.slug + "/"));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${esc(u)}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n") + `\n</urlset>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=1800", "X-Sponsors-SSR": "sitemap" } });
}

async function renderMarkdown(request, env, ctx, data) {
  const loaded = await data.loadSponsors(env, ctx, { allowCold: true });
  if (!loaded) return null;
  const sessions = (await data.loadSessions(env, ctx, { allowCold: false })) || [];
  const base = sponsorsBase(env);
  const siteOrigin = siteOriginFor(request, env);
  const sessionBase = sessionUrlBase(env);
  const sponsors = publicSponsors(loaded.data);
  const groups = groupByTier(loaded.data, sponsors);
  const out = [`# ${eventLabel(env)} Sponsors & Exhibitors`, "", `${sponsors.length} sponsors and exhibitors. Canonical page: ${siteOrigin + base}. Updated ${loaded.generatedAt || ""}.`, ""];
  for (const g of groups) {
    out.push(`## ${g.label} (${g.sponsors.length})`, "");
    for (const s of g.sponsors) {
      out.push(`### ${s.name}`);
      out.push(`Profile: ${siteOrigin + base + s.slug}/`);
      if (s.websiteUrl) out.push(`Website: ${s.websiteUrl}`);
      const types = s.customFields?.["Product Types"]?.values || [];
      if (types.length) out.push(`Product types: ${types.map(prettifyValue).join(", ")}`);
      for (const x of sessions.filter((y) => (y.exhibitorIds || []).includes(s.id))) {
        out.push(`Session: ${x.title}${x.beginsAt ? " — " + formatSessionTime(x.beginsAt, x.endsAt) : ""}${sessionBase ? " — " + sessionBase + encodeURIComponent(x.id).replace(/%3D/g, "=") : ""}`);
      }
      const d = plain(s.description);
      if (d) out.push("", d);
      out.push("");
    }
  }
  return new Response(out.join("\n"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=1800", "Link": `<${siteOrigin + base}>; rel="canonical"`, "X-Sponsors-SSR": "markdown" },
  });
}

// ---------- helpers ----------

function sponsorsBase(env) {
  let p = env.SPONSORS_PATH || "/sponsors-exhibitors/";
  if (!p.startsWith("/")) p = "/" + p;
  if (!p.endsWith("/")) p += "/";
  return p;
}
function sessionUrlBase(env) {
  return env.SESSION_URL_BASE === undefined ? "https://ai4.app.swapcard.com/event/ai4-2026/planning/" : env.SESSION_URL_BASE;
}
function eventLabel(env) { return env.EVENT_LABEL || "Ai4"; }
function siteOriginFor(request, env) { return (env.SITE_ORIGIN || new URL(request.url).origin).replace(/\/$/, ""); }

// Production: fetch(request) goes to the origin (a Worker's same-zone
// subrequest doesn't re-enter the Worker). ORIGIN_OVERRIDE is for staging.
function originFetch(request, env) {
  if (env.ORIGIN_OVERRIDE) {
    const u = new URL(request.url);
    const o = new URL(env.ORIGIN_OVERRIDE);
    u.protocol = o.protocol; u.host = o.host;
    return fetch(new Request(u.toString(), request));
  }
  return fetch(request);
}
function isHtml(res) { return (res.headers.get("content-type") || "").includes("text/html"); }
function cleanHeaders(res) {
  const out = new Response(res.body, res);
  out.headers.delete("etag"); out.headers.delete("last-modified"); out.headers.delete("content-length");
  return out;
}
function tag(res, value) {
  const out = new Response(res.body, res);
  out.headers.set("X-Sponsors-SSR", value);
  return out;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function ldScript(obj) { return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`; }
function plain(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 20)).replace(/[\s,.;:]+$/, "") + "…";
}
function socialUrl(soc) {
  const p = soc.url || soc.profile || "";
  if (/^https?:\/\//i.test(p)) return p;
  switch (soc.type) {
    case "LINKEDIN": return "https://linkedin.com/company/" + p;
    case "TWITTER": return "https://twitter.com/" + p.replace(/^@/, "");
    case "X": return "https://x.com/" + p.replace(/^@/, "");
    case "FACEBOOK": return "https://facebook.com/" + p;
    case "INSTAGRAM": return "https://instagram.com/" + p.replace(/^@/, "");
    case "YOUTUBE": return "https://youtube.com/" + p;
    default: return p;
  }
}
function friendlySocialName(type) {
  return ({ LINKEDIN: "LinkedIn", TWITTER: "X (Twitter)", X: "X", FACEBOOK: "Facebook", INSTAGRAM: "Instagram", YOUTUBE: "YouTube" })[type] || (type ? type.charAt(0) + type.slice(1).toLowerCase() : "Link");
}

// Swapcard session times are venue-local without an offset ("2026-08-03 17:00:00").
// Show them as-is in Pacific (the event is in Las Vegas).
function getDisplayDate(iso) {
  if (!iso) return null;
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(iso)) return { date: new Date(iso), tz: "America/Los_Angeles" };
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))), tz: "UTC" };
}
function formatSessionTime(beginsAt, endsAt) {
  try {
    const b = getDisplayDate(beginsAt);
    if (!b) return "";
    const day = b.date.toLocaleDateString("en-US", { timeZone: b.tz, weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const t1 = b.date.toLocaleTimeString("en-US", { timeZone: b.tz, hour: "numeric", minute: "2-digit" });
    const e = getDisplayDate(endsAt);
    const t2 = e ? e.date.toLocaleTimeString("en-US", { timeZone: e.tz, hour: "numeric", minute: "2-digit" }) : "";
    return `${day}, ${t1}${t2 ? " – " + t2 : ""} PT`;
  } catch { return ""; }
}

// Allow-list sanitizer for Swapcard session descriptions (HTML).
async function sanitizeHtml(html) {
  const ALLOWED = new Set(["p", "br", "strong", "b", "em", "i", "ul", "ol", "li", "a"]);
  const DROP = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "base", "link", "meta", "noscript", "template", "svg", "math", "head", "title"]);
  const rw = new HTMLRewriter()
    .on("*", {
      element(el) {
        const t = el.tagName.toLowerCase();
        if (DROP.has(t)) { el.remove(); return; }
        if (!ALLOWED.has(t)) { el.removeAndKeepContent(); return; }
        const href = t === "a" ? (el.getAttribute("href") || "").trim() : "";
        for (const [name] of [...el.attributes]) el.removeAttribute(name);
        if (t === "a") {
          if (/^https?:\/\//i.test(href)) { el.setAttribute("href", href); el.setAttribute("rel", "noopener nofollow"); el.setAttribute("target", "_blank"); }
          else el.removeAndKeepContent();
        }
      },
    })
    .onDocument({ comments(c) { c.remove(); } });
  return rw.transform(new Response(String(html), { headers: { "content-type": "text/html" } })).text();
}
