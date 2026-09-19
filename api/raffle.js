// /api/raffle — raffle email capture + anonymous demographics for NightMarket.fun Passport.
// Email + newsletter opt-in go to `raffle_entries`. Optional demographics go to a SEPARATE
// `raffle_demographics` table with NO email and NO device id, so they stay anonymous/aggregate
// and cannot be joined back to a person.
//
// Vercel env required:
//   SUPABASE_URL          = https://YOURPROJECT.supabase.co
//   SUPABASE_SERVICE_KEY  = the service_role (or sb_secret_...) key
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbHeaders(prefer) {
  const h = { "Content-Type": "application/json", "apikey": SUPABASE_SERVICE_KEY, "Prefer": prefer };
  // New secret keys (sb_secret_...) are not JWTs and must go only on apikey.
  if (SUPABASE_SERVICE_KEY && SUPABASE_SERVICE_KEY.startsWith("eyJ")) {
    h["Authorization"] = "Bearer " + SUPABASE_SERVICE_KEY;
  }
  return h;
}
function sbInsert(table, row, opts) {
  opts = opts || {};
  const base = (SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const url = base + "/rest/v1/" + table + (opts.onConflict ? ("?on_conflict=" + opts.onConflict) : "");
  const prefer = (opts.upsert ? "resolution=merge-duplicates," : "") + "return=minimal";
  return fetch(url, { method: "POST", headers: sbHeaders(prefer), body: JSON.stringify(row) });
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: false, skipped: "unconfigured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const email = String(body.email || "").trim().toLowerCase();
  const program = String(body.program || "nmf").slice(0, 20);
  const year = parseInt(body.year, 10) || new Date().getFullYear();
  const newsletter = !!body.newsletter;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: "email" });

  const d = body.demographics || {};
  const demo = {
    program, year,
    zip: d.zip ? String(d.zip).slice(0, 12) : null,
    age: d.age ? String(d.age).slice(0, 20) : null,
    first_time: d.first_time ? String(d.first_time).slice(0, 20) : null,
    how_heard: d.how_heard ? String(d.how_heard).slice(0, 40) : null
  };
  const hasDemo = demo.zip || demo.age || demo.first_time || demo.how_heard;

  try {
    const r1 = await sbInsert("raffle_entries", { program, year, email, newsletter_optin: newsletter }, { upsert: true, onConflict: "program,year,email" });
    if (!r1.ok && r1.status !== 409) {
      const t = await r1.text().catch(() => "");
      return res.status(502).json({ ok: false, error: "entry", detail: t.slice(0, 200) });
    }
    if (hasDemo) { await sbInsert("raffle_demographics", demo, {}); }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server" });
  }
}
