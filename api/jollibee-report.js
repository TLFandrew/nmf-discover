// Jollibee demand report feed (separate from the staff dashboard).
// Deploy target: Vercel serverless function at /api/jollibee-report.
//
// GET -> { count, distinctZips, zips: [{zip,votes}], daily: [{day,votes}] }
// Read-only, aggregate, no personal data. PUBLIC for now so the report is easy
// to share for the pitch. To re-gate later, require a passcode in the handler
// (e.g. req.query.key === process.env.JOLLIBEE_PASSCODE). Reads Supabase with
// the server-side service key (never exposed to the browser).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbHeaders() {
  const h = { "apikey": SUPABASE_SERVICE_KEY };
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
  try {
    const r = await fetch(sbBase() + "/rest/v1/" + path, { headers: sbHeaders() });
    if (!r.ok) return null;
    return r.json();
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.status(405).json({ error: "method not allowed" }); return; }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { res.status(500).json({ error: "server not configured" }); return; }

  // Public for the pitch; no passcode. Re-gate here later if Jollibee proceeds.

  const summary = await sbGet("jollibee_summary?select=votes,zips");
  const zips = await sbGet("jollibee_zip_counts?select=zip,votes&order=votes.desc");
  const daily = await sbGet("jollibee_daily?select=day,votes&order=day.asc");

  res.status(200).json({
    count: (summary && summary[0] && summary[0].votes) || 0,
    distinctZips: (summary && summary[0] && summary[0].zips) || 0,
    zips: Array.isArray(zips) ? zips : [],
    daily: Array.isArray(daily) ? daily : [],
  });
}
