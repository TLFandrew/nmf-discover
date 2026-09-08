// NightMarket.fun Passport — read-only dashboard data feed.
// Deploy target: Vercel serverless function at /api/report.
//
// Serves the reporting views to the staff dashboard (dashboard.html) as JSON,
// read from Supabase with the server-side service key (never exposed to the
// browser). Gated by a shared passcode so the data isn't public.
//
// ONE-TIME SETUP — in Vercel > Settings > Environment Variables, in addition to
// the SUPABASE_URL / SUPABASE_SERVICE_KEY you already have, add:
//   DASHBOARD_PASSCODE = a shared passphrase you give the team
// Then open /dashboard.html and enter that passphrase.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DASHBOARD_PASSCODE = process.env.DASHBOARD_PASSCODE;

function sbHeaders() {
  const h = { "apikey": SUPABASE_SERVICE_KEY };
  // Legacy service_role keys are JWTs (start with "eyJ") and also go on the
  // Authorization header; new sb_secret_ keys use only apikey.
  if (SUPABASE_SERVICE_KEY && SUPABASE_SERVICE_KEY.startsWith("eyJ")) {
    h["Authorization"] = "Bearer " + SUPABASE_SERVICE_KEY;
  }
  return h;
}

async function sbSelect(view, program, year) {
  const q = "program=eq." + encodeURIComponent(program) +
            "&year=eq." + encodeURIComponent(year) + "&select=*";
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/" + view + "?" + q, { headers: sbHeaders() });
    if (!r.ok) return [];
    return await r.json();
  } catch (e) {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.status(405).json({ error: "method not allowed" }); return; }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { res.status(500).json({ error: "server not configured" }); return; }

  const key = req.query.key || req.headers["x-dashboard-key"] || "";
  if (!DASHBOARD_PASSCODE || key !== DASHBOARD_PASSCODE) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const program = String(req.query.program || "nmf");
  const year = String(req.query.year || "2026");
  const views = [
    "reach_summary", "performance_scores", "listing_engagement",
    "category_taps", "search_terms", "demand_gaps", "social_by_platform"
  ];
  const out = { program: program, year: year };
  await Promise.all(views.map(async function (v) { out[v] = await sbSelect(v, program, year); }));
  res.status(200).json(out);
}
