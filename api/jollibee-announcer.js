// AI "contest announcer" for the demand campaign.
// GET -> { ticker: [..short lines..], board: "play-by-play", report: "exec summary", count, nextMilestone, remaining }
//
// Turns the live, aggregate-only vote data into color commentary in three lengths:
//   ticker  -> collapsed card (teaser)
//   board   -> full board screen (play-by-play)
//   report  -> public report page (self-writing executive summary)
//
// Design goals:
//   * CHEAP: generated in Supabase-cached batches (Claude called at most ~once per
//     CACHE_TTL_MS, or when votes jump by VOTE_DELTA), never per page view. A CDN
//     s-maxage layer sits on top.
//   * SAFE: aggregates only. No names, no emails, no ZIP-level PII shown; ZIPs are
//     collapsed to coarse area labels. The model is told to never invent numbers.
//   * GRACEFUL: if ANTHROPIC_API_KEY is unset, the API errors, or credits lapse,
//     it falls back to deterministic templated lines built from the same facts.
//   * REUSABLE: change BRAND / MILESTONES / areaForZip to run it for another brand
//     (future Jollibee re-approach, ADBF sponsors, etc.).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // set from your API credits

// ---- CONFIG (edit to reuse for another campaign) ----------------------------
const BRAND = { name: "Jollibee", city: "Austin", want: "I want Jollibee in Austin" };
const MODEL = "claude-haiku-5-5";   // cheap + fast. If your account differs, try "claude-3-5-haiku-latest".
const MILESTONES = [1000, 2500, 5000, 7500, 10000];
const CACHE_TTL_MS = 90 * 1000;     // regenerate at most this often...
const VOTE_DELTA = 25;              // ...or sooner if votes jump by this many
const MAX_TOKENS = 700;

// Coarse ZIP -> area label (desire vote, not an address; keeps it PII-free)
function areaForZip(zip) {
  const z = String(zip || "");
  const named = {
    "78613": "Cedar Park", "78630": "Cedar Park", "78641": "Leander", "78645": "Leander",
    "78717": "Northwest Austin", "78750": "Northwest Austin", "78726": "Northwest Austin",
    "78664": "Round Rock", "78665": "Round Rock", "78681": "Round Rock",
    "78660": "Pflugerville", "78728": "North Austin", "78729": "Northwest Austin",
    "78610": "Buda", "78640": "Kyle", "78634": "Hutto", "78633": "Georgetown", "78626": "Georgetown"
  };
  if (named[z]) return named[z];
  if (/^787/.test(z)) return "Austin";
  if (/^786/.test(z)) return "Greater Austin";
  return "Out of area";
}

function sbHeaders(extra) {
  const h = Object.assign({ "Content-Type": "application/json", "apikey": SUPABASE_SERVICE_KEY }, extra || {});
  if (SUPABASE_SERVICE_KEY && SUPABASE_SERVICE_KEY.startsWith("eyJ")) h["Authorization"] = "Bearer " + SUPABASE_SERVICE_KEY;
  return h;
}
function sbBase() {
  let base = (SUPABASE_URL || "").trim();
  if (base && !/^https?:\/\//i.test(base)) base = "https://" + base;
  return base.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
}
async function sbGet(path) {
  try { const r = await fetch(sbBase() + "/rest/v1/" + path, { headers: sbHeaders() }); if (!r.ok) return null; return r.json(); }
  catch (e) { return null; }
}
async function sbUpsert(table, row, onConflict) {
  try {
    const headers = sbHeaders({ "Prefer": "resolution=merge-duplicates,return=minimal" });
    const url = sbBase() + "/rest/v1/" + table + (onConflict ? ("?on_conflict=" + onConflict) : "");
    return await fetch(url, { method: "POST", headers, body: JSON.stringify(row) });
  } catch (e) { return null; }
}

// Build the aggregate "facts" the commentary is written from (no PII).
async function getFacts() {
  const summary = await sbGet("jollibee_summary?select=votes,zips");
  const zrows = await sbGet("jollibee_zip_counts?select=zip,votes&order=votes.desc&limit=12");
  const count = (summary && summary[0] && summary[0].votes) || 0;

  // Collapse ZIPs into area totals
  const byArea = {};
  (Array.isArray(zrows) ? zrows : []).forEach(r => {
    const a = areaForZip(r.zip);
    if (a === "Out of area") return;
    byArea[a] = (byArea[a] || 0) + (r.votes || 0);
  });
  const cities = Object.keys(byArea).map(a => ({ area: a, votes: byArea[a] }))
    .sort((x, y) => y.votes - x.votes).slice(0, 4);

  // Momentum: votes in the last hour (best-effort; 0 if the column/query is unavailable)
  let momentum = 0;
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await sbGet("jollibee_taps?select=device_id&created_at=gte." + since + "&limit=1000");
  if (Array.isArray(recent)) momentum = recent.length;

  const nextMilestone = MILESTONES.find(m => m > count) || null;
  const remaining = nextMilestone ? nextMilestone - count : 0;
  return { brand: BRAND.name, city: BRAND.city, count, cities, momentum, nextMilestone, remaining };
}

// Deterministic fallback so the feature works with zero AI (unconfigured/errored/credits out).
function templated(f) {
  const lead = f.cities[0], second = f.cities[1];
  const ticker = [
    lead ? ("Anak, " + lead.area + " leads with " + lead.votes + " - tap to keep up!") : (f.count + " fans want " + f.brand + " in " + f.city + " - add yours na!"),
    f.remaining ? (f.remaining + " to the next unlock - don't be shy, tap!") : "Goal unlocked - keep going, ha!",
    (lead && second) ? (second.area + ", you gonna let " + lead.area + " win? " + lead.votes + " to " + second.votes) : null,
    f.momentum ? (f.momentum + " votes this hour - bring a friend!") : null
  ].filter(Boolean);
  const board = "Ay, " + f.count + " fans and counting! "
    + (lead ? (lead.area + " is out front" + (second ? ", but " + second.area + " is close - don't get lazy, ha. " : " - keep it up! ") ) : "")
    + (f.remaining ? ("Only " + f.remaining + " to the next unlock, so tap and bring your friends!") : "Next goal unlocked - salamat!");
  const report = f.count + " people have voted \"" + f.want + "\". "
    + (lead ? ("Demand is strongest in " + lead.area + (second ? " and " + second.area : "") + ". ") : "")
    + (f.remaining ? ("The campaign is " + f.remaining + " votes from its next milestone" + (f.momentum ? ", with " + f.momentum + " votes in the last hour" : "") + ".") : "The latest milestone has been reached.");
  return { ticker, board, report };
}

async function generate(f) {
  if (!ANTHROPIC_API_KEY) return templated(f);
  const sys = "You are Tita/Kuya, the warm and playful Filipino auntie-and-kuya voice hyping a live fan-demand campaign where people vote that they want " + BRAND.name + " to open in " + BRAND.city + ". "
    + "You have loving, familial, slightly cheeky energy: you cheer people on, you gently nag them to vote, and you tell them to pull their friends and family in too, like a Tita at a family party who will lovingly guilt you into helping. "
    + "From the FACTS JSON, return ONLY valid JSON with no code fences, an object with exactly these keys: ticker, board, report. "
    + "ticker is an array of 3 to 5 short punchy lines, max about 55 characters each, in the Tita/Kuya voice, each one egging people on to vote or to bring someone in. "
    + "board is one or two sentences of Tita/Kuya play-by-play that celebrates the momentum, names the next target, and tells people to act. "
    + "report is ONE professional, persuasive executive paragraph of 2 to 4 sentences for the brand decision-makers. The report is NOT in the Tita/Kuya voice: keep it warm but credible and data-forward, suitable for a marketing or real-estate team. "
    + "VOICE for ticker and board: warm Filipino Tita/Kuya energy; light Taglish is welcome but keep it understandable, occasional anak, na, ha, tara; always include a nudge to act such as tap, vote, bring a friend, or beat the rival city. "
    + "RULES: use ONLY the numbers and place names in FACTS, never invent figures or cities. Playful city rivalry is fine but never insult a place or a person, keep it family-friendly. No personal data, no individual names. Reference the next milestone and momentum to drive urgency.";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: sys, messages: [{ role: "user", content: "FACTS:\n" + JSON.stringify(f) }] })
    });
    if (!r.ok) return templated(f);
    const data = await r.json();
    let text = (Array.isArray(data.content) ? data.content : []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
    const out = JSON.parse(text);
    if (!out || !Array.isArray(out.ticker) || !out.board || !out.report) return templated(f);
    out.ticker = out.ticker.map(s => String(s).slice(0, 80)).slice(0, 6);
    out.board = String(out.board).slice(0, 400);
    out.report = String(out.report).slice(0, 900);
    return out;
  } catch (e) { return templated(f); }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(200).json({ ticker: [], board: "", report: "", skipped: "unconfigured" });

  try {
    const facts = await getFacts();

    // Serve cache if fresh enough (keeps Claude calls rare + cheap)
    const cacheRows = await sbGet("jollibee_announcer?id=eq.1&select=ticker,board,report,vote_count,updated_at");
    const cached = cacheRows && cacheRows[0];
    const fresh = cached
      && (Date.now() - new Date(cached.updated_at).getTime() < CACHE_TTL_MS)
      && (Math.abs((cached.vote_count || 0) - facts.count) < VOTE_DELTA);
    if (fresh) {
      res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
      return res.status(200).json({ ticker: cached.ticker || [], board: cached.board || "", report: cached.report || "", count: facts.count, nextMilestone: facts.nextMilestone, remaining: facts.remaining, cached: true });
    }

    // Regenerate (AI or templated), then persist for the next viewers
    const gen = await generate(facts);
    await sbUpsert("jollibee_announcer", { id: 1, ticker: gen.ticker, board: gen.board, report: gen.report, vote_count: facts.count, updated_at: new Date().toISOString() }, "id");
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json({ ticker: gen.ticker, board: gen.board, report: gen.report, count: facts.count, nextMilestone: facts.nextMilestone, remaining: facts.remaining, cached: false });
  } catch (e) {
    // Last-ditch: serve stale cache if any, else empty (card/board simply hide the ticker)
    const cacheRows = await sbGet("jollibee_announcer?id=eq.1&select=ticker,board,report");
    const c = cacheRows && cacheRows[0];
    return res.status(200).json({ ticker: (c && c.ticker) || [], board: (c && c.board) || "", report: (c && c.report) || "", skipped: "error" });
  }
}
