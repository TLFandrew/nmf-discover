// H-E-B grocery poll: records one response per device, serves aggregate for the H-E-B report.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Must match HEB_POLL_STORES / HEB_POLL_AREAS in index.html exactly (the app sends these strings).
const STORES = ["Central Market", "Costco or Sam's Club", "H-E-B", "Kroger", "Randalls or Tom Thumb", "Target", "Walmart", "Whole Foods, Trader Joe's, or Sprouts", "Asian or international market", "Other"];
const AREAS = ["Greater Austin", "Elsewhere in Texas", "Outside Texas"];
const HEB_FAMILY = ["H-E-B", "Central Market"]; // both are H-E-B-owned banners

function sb(path, opts) {
  return fetch(SUPABASE_URL + "/rest/v1/" + path, Object.assign({
    headers: Object.assign({
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json"
    }, (opts && opts.headers) || {})
  }, opts || {}));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: false, skipped: "unconfigured" });

  if (req.method === "POST") {
    try {
      var body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      var device = String(body.device || "").slice(0, 80);
      var store = String(body.store || "");
      var area = String(body.area || "");
      if (!device || STORES.indexOf(store) < 0 || AREAS.indexOf(area) < 0) {
        return res.status(400).json({ ok: false, error: "bad input" });
      }
      // One row per device: a repeat submission from the same device updates rather than adds.
      var r = await sb("heb_poll?on_conflict=device", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ device: device, store: store, area: area, updated_at: new Date().toISOString() })
      });
      if (!r.ok) { var tx = await r.text(); return res.status(200).json({ ok: false, error: "db", detail: tx.slice(0, 200) }); }
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(200).json({ ok: false, error: String(e).slice(0, 160) }); }
  }

  // GET: aggregate for the report (and for the in-app reveal)
  try {
    var rows = await sb("heb_poll?select=store,area", { method: "GET" });
    var data = rows.ok ? await rows.json() : [];
    var byStore = {}, byArea = {}, hebByArea = {}, total = data.length;
    STORES.forEach(function (s) { byStore[s] = 0; });
    AREAS.forEach(function (a) { byArea[a] = 0; hebByArea[a] = { total: 0, heb: 0 }; });
    data.forEach(function (d) {
      if (d.store in byStore) byStore[d.store]++;
      if (d.area in byArea) {
        byArea[d.area]++;
        hebByArea[d.area].total++;
        if (HEB_FAMILY.indexOf(d.store) >= 0) hebByArea[d.area].heb++;
      }
    });
    var hebCount = HEB_FAMILY.reduce(function (a, s) { return a + (byStore[s] || 0); }, 0);
    var hebShare = total ? Math.round(hebCount / total * 100) : 0;
    res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=60");
    return res.status(200).json({ ok: true, total: total, byStore: byStore, byArea: byArea, hebByArea: hebByArea, hebShare: hebShare, stores: STORES, areas: AREAS, hebFamily: HEB_FAMILY });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e).slice(0, 160) }); }
}
