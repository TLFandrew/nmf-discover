// NightMarket.fun Discover - anonymous telemetry ingest
// Deploy target: Vercel serverless function at /api/track.
//
// WHAT THIS DOES
// Receives tiny, anonymous events from the app (a star rating, a search term)
// and records them in Supabase for internal reporting only: Audience Favorite,
// the search word cloud, and reach / engagement numbers for grant narratives.
// No names, no emails. A random device id generated in the browser lets us
// de-duplicate ratings (and later build the leaderboard) without identifying
// anyone. The app calls this fire-and-forget, so a failure here never affects
// the visitor experience.
//
// ONE-TIME SETUP (all in your browser, no local tooling):
//   1. Create a free project at supabase.com.
//   2. In the Supabase SQL editor, paste and run nmf_supabase_schema.sql.
//   3. In Vercel > your project > Settings > Environment Variables, add:
//        SUPABASE_URL          = https://YOURPROJECT.supabase.co
//        SUPABASE_SERVICE_KEY  = the service_role key (Supabase > Settings > API)
//      The service_role key bypasses row security and must stay server-side.
//      It is only ever read here from the environment and never sent to the app.
//   4. Deploy. If the env vars are missing, this endpoint quietly no-ops, so the
//      app keeps working and nothing breaks while you finish setup.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Page and function share the Vercel origin, so CORS is normally a no-op. Listed
// origins are allowed in case you ever host the page on its own domain.
const ALLOWED_ORIGINS = [
  "https://nightmarket.fun",
  "https://www.nightmarket.fun",
];

// Soft per-IP rate limit to deter abuse. In-memory only (per warm instance), so
// it is a light guard, not a hard cap. Good enough for anonymous telemetry.
const RATE_LIMIT = 40;          // max events
const RATE_WINDOW_MS = 60000;   // per 60 seconds, per IP
const hits = new Map();
function allowed(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) { hits.set(ip, arr); return false; }
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

// Insert (or upsert) a row through Supabase's REST API using plain fetch, so this
// function needs no npm dependencies (matches the no-build deploy workflow).
async function sbInsert(table, row, opts) {
  opts = opts || {};
  const headers = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_SERVICE_KEY,
    "Prefer": opts.upsert ? "resolution=merge-duplicates,return=minimal" : "return=minimal",
  };
  // Legacy service_role keys are JWTs (start with "eyJ") and are also sent on the
  // Authorization header. New secret keys (sb_secret_...) are not JWTs and must go
  // only on the apikey header, so we add Authorization only for the legacy key.
  if (SUPABASE_SERVICE_KEY && SUPABASE_SERVICE_KEY.startsWith("eyJ")) {
    headers["Authorization"] = "Bearer " + SUPABASE_SERVICE_KEY;
  }
  const url = SUPABASE_URL + "/rest/v1/" + table + (opts.onConflict ? ("?on_conflict=" + opts.onConflict) : "");
  return fetch(url, { method: "POST", headers, body: JSON.stringify(row) });
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  // Not configured yet: no-op so the app keeps working during setup.
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: false, skipped: "unconfigured" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (!allowed(ip)) return res.status(200).json({ ok: false, skipped: "rate" });

  let body = typeof req.body === "string" ? safeParse(req.body) : (req.body || {});
  const type = String(body.type || "");
  const device = String(body.deviceId || "").slice(0, 64);
  if (!device) return res.status(200).json({ ok: false, skipped: "no-device" });

  try {
    if (type === "rating") {
      const vendorId = parseInt(body.vendorId, 10);
      const stars = parseInt(body.stars, 10);
      if (!(vendorId >= 0) || !(stars >= 1 && stars <= 5)) {
        return res.status(200).json({ ok: false, skipped: "bad-rating" });
      }
      // One row per (device, performance); re-rating within the window overwrites.
      await sbInsert(
        "ratings",
        { device_id: device, vendor_id: vendorId, stars: stars, updated_at: new Date().toISOString() },
        { upsert: true, onConflict: "device_id,vendor_id" }
      );
      return res.status(200).json({ ok: true });
    }

    if (type === "search") {
      const q = String(body.query || "").trim().slice(0, 200);
      const lang = String(body.lang || "").slice(0, 8);
      if (!q) return res.status(200).json({ ok: false, skipped: "empty" });
      await sbInsert("events", { type: "search", device_id: device, query: q, lang: lang }, {});
      return res.status(200).json({ ok: true });
    }

    if (type === "view" || type === "plan_add" || type === "social") {
      const vendorId = parseInt(body.vendorId, 10);
      if (!(vendorId >= 0)) return res.status(200).json({ ok: false, skipped: "bad-vendor" });
      const meta = type === "social" ? { platform: String(body.platform || "").slice(0, 24) } : null;
      await sbInsert("events", { type: type, device_id: device, vendor_id: vendorId, meta: meta }, {});
      return res.status(200).json({ ok: true });
    }

    // Unknown event types are accepted and ignored, so future client versions
    // can add events without ever erroring against an older function.
    return res.status(200).json({ ok: false, skipped: "unknown-type" });
  } catch (e) {
    // Telemetry must never surface an error to the app.
    return res.status(200).json({ ok: false, skipped: "error" });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
