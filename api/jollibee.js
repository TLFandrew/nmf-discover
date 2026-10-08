// NightMarket.fun x Jollibee - "I want Jollibee in Austin" demand counter.
// Deploy target: Vercel serverless function at /api/jollibee.
//
// GET  -> public read: { count, topZips: [{ zip, votes }], zips }
// POST -> record one deduped vote: body { deviceId, zip, program, year }
//         one row per device (primary key), so repeat taps never double-count.
// No emails, no names. ZIP is a desire vote ("where should it go"), not an
// address. IP metro is tagged server-side as an honest denominator and is never
// shown to the voter. Uses the same SUPABASE_URL / SUPABASE_SERVICE_KEY env as
// /api/track and /api/report. If unconfigured, it no-ops so the app still runs.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_ORIGINS = [
  "https://nightmarket.fun",
  "https://www.nightmarket.fun",
];

// Soft per-IP rate limit (in-memory per warm instance), light abuse guard.
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60000;
const hits = new Map();
function allowed(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) { hits.set(ip, arr); return false; }
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

function sbHeaders(extra) {
  const h = Object.assign({
    "Content-Type": "application/json",
    "apikey": SUPABASE_SERVICE_KEY,
  }, extra || {});
  if (SUPABASE_SERVICE_KEY && SUPABASE_SERVICE_KEY.startsWith("eyJ")) {
    h["Authorization"] = "Bearer " + SUPABASE_SERVICE_KEY;
  }
  return h;
}
function sbBase() {
  let base = (SUPABASE_URL || "").trim();
  if (base && !/^https?:\/\//i.test(base)) base = "https://" + base;
  return base.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
}
async function sbGet(path) {
  const r = await fetch(sbBase() + "/rest/v1/" + path, { headers: sbHeaders() });
  if (!r.ok) return null;
  return r.json();
}
async function sbInsertIgnore(table, row, onConflict) {
  const headers = sbHeaders({ "Prefer": "resolution=ignore-duplicates,return=minimal" });
  const url = sbBase() + "/rest/v1/" + table + (onConflict ? ("?on_conflict=" + onConflict) : "");
  return fetch(url, { method: "POST", headers, body: JSON.stringify(row) });
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";

  // ---- READ -------------------------------------------------------------
  if (req.method === "GET") {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(200).json({ count: 0, topZips: [], skipped: "unconfigured" });
    if (!allowed(ip)) return res.status(200).json({ count: 0, topZips: [], skipped: "rate" });
    try {
      const summary = await sbGet("jollibee_summary?select=votes,zips");
      const zrows = await sbGet("jollibee_zip_counts?select=zip,votes&order=votes.desc&limit=8");
      const count = (summary && summary[0] && summary[0].votes) || 0;
      const zips = (summary && summary[0] && summary[0].zips) || 0;
      res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
      return res.status(200).json({ count: count, zips: zips, topZips: Array.isArray(zrows) ? zrows : [] });
    } catch (e) {
      return res.status(200).json({ count: 0, topZips: [], skipped: "error" });
    }
  }

  // ---- RECORD A VOTE ----------------------------------------------------
  if (req.method === "POST") {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: false, skipped: "unconfigured" });
    if (!allowed(ip)) return res.status(200).json({ ok: false, skipped: "rate" });

    const body = typeof req.body === "string" ? safeParse(req.body) : (req.body || {});
    const device = String(body.deviceId || "").slice(0, 64);
    const zip = String(body.zip || "").replace(/[^0-9]/g, "").slice(0, 5);
    if (!device) return res.status(200).json({ ok: false, skipped: "no-device" });
    if (zip.length !== 5) return res.status(200).json({ ok: false, skipped: "bad-zip" });

    const program = String(body.program || "").slice(0, 16) || null;
    const year = parseInt(body.year, 10) || null;
    // Vercel edge geo headers (best-effort, coarse metro only; never shown to users).
    const city = String(req.headers["x-vercel-ip-city"] || "").slice(0, 60);
    const region = String(req.headers["x-vercel-ip-country-region"] || "").slice(0, 10);
    const ip_metro = (city ? decodeURIComponent(city) : "") + (region ? (", " + region) : "") || null;

    try {
      await sbInsertIgnore(
        "jollibee_taps",
        { device_id: device, zip: zip, ip_metro: ip_metro, program: program, year: year },
        "device_id"
      );
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(200).json({ ok: false, skipped: "error" });
    }
  }

  return res.status(405).json({ ok: false });
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
