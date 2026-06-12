/**
 * Ai4 Sponsors Widget — Cloudflare Worker
 * ========================================
 *
 * Proxies the Swapcard Content API for the public exhibitors/sponsors list.
 * Holds the SWAPCARD_API_KEY as a secret so it never reaches the browser.
 *
 * What it does:
 *   1. Pages through `event.exhibitors` to fetch every exhibitor.
 *   2. For each exhibitor, pulls: id, name, description, logo, website, socials,
 *      booth (per-event), group/sponsor tier (per-event), members/team, custom fields.
 *   3. Discovers EventGroups so we can filter by sponsor tier.
 *   4. Discovers EXHIBITOR FieldDefinitions so we know which custom fields are
 *      Single/Multiple Select (these become filters in the UI).
 *   5. Optionally pulls related sessions per sponsor (lazy-loaded on expand).
 *   6. Normalizes everything to a clean shape and caches at the edge for 10 min.
 *
 * Setup:
 *   wrangler secret put SWAPCARD_API_KEY
 *   wrangler deploy
 *
 * Endpoints:
 *   GET /sponsors            → full normalized payload (cached)
 *   GET /sessions?id=<exhibId> → sessions for a single exhibitor (cached)
 *   GET /health              → uncached health probe
 */

const SWAPCARD_ENDPOINT = "https://developer.swapcard.com/event-admin/graphql";
const CACHE_TTL_SECONDS = 600;
const PAGE_SIZE = 100;

// ---------- GraphQL queries ----------

const GROUPS_QUERY = /* GraphQL */ `
  query EventGroups($eventId: ID!) {
    event(id: $eventId) {
      id
      groups {
        id
        name
        exhibitorCount
      }
    }
  }
`;

const FIELD_DEFINITIONS_QUERY = /* GraphQL */ `
  query ExhibitorFieldDefinitions($eventId: ID!) {
    event(id: $eventId) {
      fieldDefinitions(target: EXHIBITORS) {
        __typename
        ... on SelectFieldDefinition {
          id name optionsValues { id value }
        }
        ... on MultipleSelectFieldDefinition {
          id name optionsValues { id value }
        }
        ... on TextFieldDefinition { id name }
        ... on LongTextFieldDefinition { id name }
        ... on UrlFieldDefinition { id name }
        ... on NumberFieldDefinition { id name }
      }
    }
  }
`;

const EXHIBITORS_QUERY = /* GraphQL */ `
  query CommunityExhibitors($communityId: ID!, $eventId: ID!, $cursor: CursorPaginationInput) {
    exhibitorsV2(
      communityId: $communityId
      filter: { eventIds: [$eventId] }
      cursor: $cursor
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        description
        htmlDescription
        logoUrl
        websiteUrl
        socialNetworks { type profile }
        fields {
          __typename
          ... on SelectField {
            definition { id name }
            value
          }
          ... on MultipleSelectField {
            definition { id name }
            value
          }
          ... on TextField {
            definition { id name }
            value
          }
          ... on LongTextField {
            definition { id name }
            value
          }
        }
        withEvent(eventId: $eventId) {
          booths { id name }
          group { id name }
          members(page: 1, pageSize: 50) {
            id
            userId
            firstName
            lastName
            jobTitle
            photoUrl
            biography
            organization
            websiteUrl
            socialNetworks { type profile }
          }
        }
      }
    }
  }
`;

const SESSIONS_FOR_EXHIBITOR_QUERY = /* GraphQL */ `
  query ExhibitorSessions($communityId: ID!, $eventId: ID!, $cursor: CursorPaginationInput) {
    planningsV2(
      communityId: $communityId
      filter: { eventIds: [$eventId] }
      cursor: $cursor
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        place
        beginsAt
        endsAt
        description
        htmlDescription
        format
        type
        exhibitors { id }
        speakers {
          id
          firstName
          lastName
          jobTitle
          organization
        }
        fields {
          __typename
          ... on SelectField {
            definition { id name }
            value
          }
          ... on MultipleSelectField {
            definition { id name }
            value
          }
          ... on TextField {
            definition { id name }
            value
          }
          ... on LongTextField {
            definition { id name }
            value
          }
        }
      }
    }
  }
`;

// ---------- Worker entry ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = buildCorsHeaders(origin, env.ALLOWED_ORIGINS || "");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (url.pathname === "/health") {
        return json({ ok: true, time: new Date().toISOString() }, corsHeaders);
      }
      if (url.pathname === "/sponsors") {
        return await handleSponsors(env, ctx, corsHeaders);
      }
      if (url.pathname === "/sessions") {
        const exhibitorId = url.searchParams.get("id");
        if (!exhibitorId) return json({ error: "missing id" }, corsHeaders, 400);
        return await handleSessions(env, ctx, exhibitorId, corsHeaders);
      }
      return json({ error: "not found" }, corsHeaders, 404);
    } catch (err) {
      console.error("Worker error:", err);
      return json({ error: String(err && err.message || err) }, corsHeaders, 500);
    }
  },
};

// ---------- Handlers ----------

async function handleSponsors(env, ctx, corsHeaders) {
  const cacheKey = new Request("https://cache.local/sponsors", { method: "GET" });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const out = new Response(cached.body, cached);
    for (const [k, v] of Object.entries(corsHeaders)) out.headers.set(k, v);
    out.headers.set("X-Cache", "HIT");
    return out;
  }

  const eventId = env.EVENT_ID;
  const communityId = env.COMMUNITY_ID;
  if (!eventId) throw new Error("EVENT_ID env var not set");
  if (!communityId) throw new Error("COMMUNITY_ID env var not set");
  if (!env.SWAPCARD_API_KEY) throw new Error("SWAPCARD_API_KEY secret not set");

  // Parallel: groups + field definitions + exhibitors
  const [groupsRes, defsRes, exhibitors] = await Promise.all([
    swapcard(env, GROUPS_QUERY, { eventId }),
    swapcard(env, FIELD_DEFINITIONS_QUERY, { eventId }),
    fetchAllExhibitors(env, communityId, eventId),
  ]);

  const groups = (groupsRes?.event?.groups || []).map((g) => ({
    id: g.id,
    name: g.name,
    exhibitorCount: g.exhibitorCount,
  }));

  const fieldDefinitions = (defsRes?.event?.fieldDefinitions || [])
    .filter((d) => d && d.id && d.name)
    .map((d) => ({
      id: d.id,
      name: d.name,
      type: d.__typename, // SelectFieldDefinition / MultipleSelectFieldDefinition / etc.
      options: (d.optionsValues || []).map((o) => ({ id: o.id, value: o.value })),
    }));

  const sponsors = exhibitors.map((e) => normalizeExhibitor(e));

  const payload = {
    generatedAt: new Date().toISOString(),
    eventId,
    counts: { sponsors: sponsors.length, groups: groups.length },
    groups,
    fieldDefinitions,
    sponsors,
  };

  const body = JSON.stringify(payload);
  const response = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "X-Cache": "MISS",
      ...corsHeaders,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleSessions(env, ctx, exhibitorId, corsHeaders) {
  const eventId = env.EVENT_ID;
  const communityId = env.COMMUNITY_ID;
  if (!eventId || !communityId) throw new Error("EVENT_ID or COMMUNITY_ID not set");

  const cacheKey = new Request(`https://cache.local/sessions/${encodeURIComponent(exhibitorId)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const out = new Response(cached.body, cached);
    for (const [k, v] of Object.entries(corsHeaders)) out.headers.set(k, v);
    out.headers.set("X-Cache", "HIT");
    return out;
  }

  // Fetch all plannings for the event, then filter to those linked to this exhibitor.
  // (Swapcard does not currently expose a direct "exhibitor.plannings" connection.)
  const all = await fetchAllPlannings(env, communityId, eventId);
  const sessions = all
    .filter((p) => (p.exhibitors || []).some((x) => x.id === exhibitorId))
    .map((p) => normalizeSession(p))
    .sort((a, b) => (a.beginsAt || "").localeCompare(b.beginsAt || ""));

  const body = JSON.stringify({ exhibitorId, sessions });
  const response = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "X-Cache": "MISS",
      ...corsHeaders,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ---------- Pagination loops ----------

async function fetchAllExhibitors(env, communityId, eventId) {
  const all = [];
  let cursor = { first: PAGE_SIZE };
  // safety guard against infinite loops
  for (let i = 0; i < 50; i++) {
    const data = await swapcard(env, EXHIBITORS_QUERY, { communityId, eventId, cursor });
    const conn = data?.exhibitorsV2;
    if (!conn) break;
    for (const node of conn.nodes || []) all.push(node);
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = { first: PAGE_SIZE, after: conn.pageInfo.endCursor };
  }
  return all;
}

async function fetchAllPlannings(env, communityId, eventId) {
  const all = [];
  let cursor = { first: PAGE_SIZE };
  for (let i = 0; i < 50; i++) {
    const data = await swapcard(env, SESSIONS_FOR_EXHIBITOR_QUERY, {
      communityId,
      eventId,
      cursor,
    });
    const conn = data?.planningsV2;
    if (!conn) break;
    for (const node of conn.nodes || []) all.push(node);
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = { first: PAGE_SIZE, after: conn.pageInfo.endCursor };
  }
  return all;
}

// ---------- Normalization ----------

function normalizeSession(p) {
  const customFields = {};
  for (const f of p.fields || []) {
    if (!f?.definition?.name) continue;
    const name = f.definition.name;
    if (f.__typename === "SelectField") {
      customFields[name] = { type: "select", value: f.value || null };
    } else if (f.__typename === "MultipleSelectField") {
      // Multi-select entries come as one row per selected value — aggregate them.
      if (!customFields[name]) customFields[name] = { type: "multiselect", values: [] };
      if (f.value != null) customFields[name].values.push(f.value);
    } else if (f.__typename === "TextField" || f.__typename === "LongTextField") {
      customFields[name] = { type: "text", value: f.value || null };
    }
  }
  return {
    id: p.id,
    title: p.title || "",
    place: p.place || "",
    beginsAt: p.beginsAt || null,
    endsAt: p.endsAt || null,
    description: p.description || "",
    htmlDescription: p.htmlDescription || "",
    format: p.format || "",
    type: p.type || "",
    exhibitorIds: (p.exhibitors || []).map((x) => x.id),
    speakerIds: (p.speakers || []).map((sp) => sp.id),
    speakerNames: (p.speakers || []).map((sp) =>
      [
        [sp.firstName, sp.lastName].filter(Boolean).join(" "),
        sp.organization
      ].filter(Boolean).join(" · ")
    ),
    customFields,
  };
}

function normalizeExhibitor(e) {
  const we = e.withEvent || {};
  const booths = (we.booths || []).map((b) => b.name).filter(Boolean);
  const group = we.group ? { id: we.group.id, name: we.group.name } : null;

  // Build a clean, name-keyed view of custom fields.
  const customFields = {};
  for (const f of e.fields || []) {
    if (!f?.definition?.name) continue;
    const name = f.definition.name;
    if (f.__typename === "SelectField") {
      customFields[name] = { type: "select", definitionId: f.definition.id, value: f.value || null };
    } else if (f.__typename === "MultipleSelectField") {
      // Multi-select entries come as one row per selected value — aggregate them.
      if (!customFields[name]) {
        customFields[name] = { type: "multiselect", definitionId: f.definition.id, values: [] };
      }
      if (f.value != null) customFields[name].values.push(f.value);
    } else if (f.__typename === "TextField" || f.__typename === "LongTextField" || f.__typename === "UrlField") {
      customFields[name] = { type: "text", definitionId: f.definition.id, value: f.value || null };
    } else if (f.__typename === "NumberField") {
      customFields[name] = { type: "number", definitionId: f.definition.id, value: f.value ?? null };
    }
  }

  // Swapcard returns social link as `profile`; we remap to `url` so the widget stays oblivious.
  const socials = (e.socialNetworks || []).map((s) => ({
    type: s.type,
    url: s.profile,
  }));

  const team = (we.members || []).map((m) => ({
    id: m.id,
    userId: m.userId || null,
    firstName: m.firstName || "",
    lastName: m.lastName || "",
    fullName: [m.firstName, m.lastName].filter(Boolean).join(" "),
    jobTitle: m.jobTitle || "",
    organization: m.organization || "",
    photoUrl: m.photoUrl || "",
    biography: m.biography || "",
    websiteUrl: m.websiteUrl || "",
    socials: (m.socialNetworks || []).map((s) => ({ type: s.type, url: s.profile })),
  }));

  return {
    id: e.id,
    name: e.name || "",
    description: e.description || "",
    htmlDescription: e.htmlDescription || "",
    logoUrl: e.logoUrl || "",
    websiteUrl: e.websiteUrl || "",
    booths,                   // ["407", "Room 259"]
    sponsorLevel: group,      // { id, name } or null
    socials,                  // [{ type, url }]
    customFields,             // keyed by definition name, e.g. customFields["Product Types"]
    team,
  };
}

// ---------- Swapcard fetch ----------

async function swapcard(env, query, variables) {
  const res = await fetch(SWAPCARD_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": env.SWAPCARD_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Swapcard HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Swapcard GraphQL: ${JSON.stringify(json.errors).slice(0, 500)}`);
  }
  return json.data;
}

// ---------- CORS / utils ----------

function buildCorsHeaders(origin, allowedCsv) {
  const allowed = (allowedCsv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ok = allowed.includes("*") || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin || "*" : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(obj, headers = {}, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
