// Batched, on-demand translation of listing text (subcategory + description) into one
// target language. The client calls this when a non-English language is selected and
// caches the result on the device, so each listing is translated once. This is what
// lets the tool cover the 2026 roster automatically: whatever text is in the app gets
// translated here, with nothing to hand-maintain.
//
// Same Gemini model and key (AI_API_KEY) as /api/discover. Thinking is disabled so the
// whole token budget goes to the answer (see api/discover.js for the full explanation).
//
// LAUNCH UPGRADE (not needed for the demo): for a public event with many devices, add a
// shared cache (Upstash Redis / Vercel KV) keyed by id+lang+source-hash so the first
// device to view a language warms it for everyone, instead of each device paying to
// translate. The hooks are marked below.

const LANG_NAMES = {
  es: "Spanish",
  zh: "Simplified Chinese",
  ko: "Korean",
  vi: "Vietnamese",
  ja: "Japanese",
};

// Best-effort in-memory per-IP rate limit. Resets when the instance cycles. The client
// only ever translates listings it has not already cached, so normal use stays well
// under this; the limit just guards against a stuck client looping.
const RATE = { max: 30, windowMs: 60000, hits: new Map() };
function rateLimited(ip) {
  const now = Date.now();
  const arr = (RATE.hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  arr.push(now);
  RATE.hits.set(ip, arr);
  return arr.length > RATE.max;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
    if (rateLimited(ip)) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const lang = body.lang;
    const items = Array.isArray(body.items) ? body.items : [];
    const targetName = LANG_NAMES[lang];

    if (!targetName || items.length === 0) {
      res.status(400).json({ error: "Bad request" });
      return;
    }
    if (items.length > 40) {
      res.status(400).json({ error: "Too many items in one batch" });
      return;
    }

    const key = process.env.AI_API_KEY;
    if (!key) {
      res.status(500).json({ error: "Missing AI_API_KEY" });
      return;
    }

    // (Launch upgrade) check shared cache here for already-translated ids, and only send
    // the misses to the model. Skipped in this version; client-side cache handles dedupe.

    const payload = items.map(it => ({
      id: it.id,
      subcategory: String(it.subcategory || ""),
      description: String(it.description || ""),
    }));

    const prompt =
      'Translate the "subcategory" and "description" fields of these night market ' +
      "listings into " + targetName + ". Keep it natural and concise, in the warm tone " +
      "of a friendly community event guide. Do NOT translate brand names, proper nouns, " +
      "dish names that are usually left untranslated, or prices. Return ONLY strict JSON: " +
      "an object whose keys are the listing ids as strings and whose values are objects " +
      'with "subcategory" and "description" in ' + targetName + ". No commentary, no markdown.\n\n" +
      "Listings:\n" + JSON.stringify(payload);

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + key;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 6144,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error("Provider error", r.status, detail);
      res.status(502).json({ error: "AI provider error" });
      return;
    }

    const data = await r.json();
    const text =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    let translations = {};
    if (text) {
      try { translations = JSON.parse(text); } catch (e) { translations = {}; }
    }

    // (Launch upgrade) write the new translations back to the shared cache here.

    res.status(200).json({ translations });
  } catch (e) {
    console.error("translate error", e && e.message);
    res.status(500).json({ error: "Server error" });
  }
}
