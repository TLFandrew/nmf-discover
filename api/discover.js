// NightMarket.fun Discover - serverless proxy
// Deploy target: Vercel (a Node serverless function at /api/discover).
//
// WHY THIS EXISTS
// The page cannot call the AI provider directly from a phone browser without
// exposing the secret API key to everyone. This function sits in the middle:
// the page sends a plain question, this function adds the key server-side,
// calls the provider, and returns the answer.
//
// PLATFORM-AGNOSTIC BY DESIGN
// This file is the ONLY place the AI provider appears. Swapping providers is a
// change to this one file. The page never changes, and your grant narrative
// never has to name a vendor. The OpenAI variant is sketched at the bottom.

// Same-origin deploy (page + function on the same Vercel project) needs no CORS.
// If you ever host the page on a different domain than the function, list the
// page's origin(s) here.
const ALLOWED_ORIGINS = [
  "https://nightmarket.fun",
  "https://www.nightmarket.fun",
];

// RATE LIMITING
// Caps how many searches one phone (IP) can make in a short window, so nobody
// can hammer the endpoint and run up your bill.
//
// Default: in-memory. Works with zero setup, but on serverless it only counts
// requests within a single warm server instance, so treat it as a soft guard.
// For real limiting across every instance, create a free database at upstash.com
// and set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel. The code
// below detects those and switches to Redis automatically. No code change needed.
const RATE_LIMIT = 12;          // max requests
const RATE_WINDOW_MS = 60000;   // per 60 seconds, per IP

const hits = new Map(); // ip -> [timestamps], used only for the in-memory path
function inMemoryAllowed(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) {
    hits.set(ip, arr);
    return false;
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) { // keep the map from growing without bound
    for (const [k, v] of hits) {
      if (v.every(t => now - t >= RATE_WINDOW_MS)) hits.delete(k);
    }
  }
  return true;
}

async function upstashAllowed(ip) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const windowSec = Math.floor(RATE_WINDOW_MS / 1000);
  const bucket = Math.floor(Date.now() / RATE_WINDOW_MS);
  const key = `rl:${ip}:${bucket}`;
  const r = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["INCR", key], ["EXPIRE", key, windowSec]]),
  });
  const data = await r.json();
  const count = Array.isArray(data) ? (data[0]?.result ?? 1) : 1;
  return count <= RATE_LIMIT;
}

async function isAllowed(ip) {
  try {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      return await upstashAllowed(ip);
    }
  } catch (err) {
    // If the rate-limit store is down, don't block attendees. Fail open to the
    // in-memory guard rather than breaking search on event night.
    console.error("Upstash rate-limit error, falling back to in-memory", err);
  }
  return inMemoryAllowed(ip);
}

function buildSystemPrompt(vendorSummary) {
  return `You are a friendly guide for NightMarket.fun, an AANHPI cultural night market festival in Cedar Park, Texas. You help attendees discover food vendors, artists, performers, and activities based on what they're looking for.

Given the attendee's question, return ONLY a JSON object with:
- "ids": array of vendor IDs (numbers) that genuinely match, ordered by relevance (max 8)
- "message": a brief, warm 1-2 sentence recommendation (conversational, like a friend who knows the event)

Your guiding principle: generous interpretation, strict inclusion. Work hard to understand what the attendee actually wants, then return only listings that genuinely deliver it. Generosity belongs in how you read the request, never in padding the results.

First, silently read the query as one of three types:

SPECIFIC: the attendee names a particular item, dish, cuisine, vendor, performer, or activity (e.g. "bao", "matcha", "taiko", "where do I get a lantern"). Include ONLY listings that actually offer that exact thing. One result is a great answer. Zero results is acceptable: return an empty ids array and use the message to warmly point them to the closest real alternative instead (e.g. "No bao this year, but Momo House's steamed dumplings are the next best thing").

BROWSE: the attendee describes a category, mood, or open-ended need (e.g. "Korean food", "something spicy", "what's good for kids", "fun stuff to do"). Return up to 8 varied matches, spreading recommendations across different vendors and categories so smaller vendors get discovered too.

STATE: the attendee describes how they feel rather than what they want, physically or emotionally (e.g. "I'm hot", "I'm cold", "I'm tired", "I'm stressed", "I'm in love", "I feel like dancing"). Infer what would genuinely help and match to it, using the context: this is an outdoor evening festival in Cedar Park, Texas, in mid-November, so evenings are cool. Examples of good inference: "I'm cold" points to hot chai, a matcha latte, or hot street food, not shaved ice. "I'm stressed" points to the Boba Garden Lounge, a calming craft like lantern decorating, or a meditative performance. "I'm in love" points to something shared and memorable: the photo station, a lantern to decorate together, a romantic spot to watch a performance. "I feel like dancing" points to the K-pop crew or the DJ set. Lead the message by gently naming what you inferred, so the attendee feels understood.

Never pad results. A listing belongs in ids only if the attendee would agree it answers their need. For SPECIFIC queries, do not include "close enough" items in ids; mention them in the message instead.

Return ONLY valid JSON. No markdown, no backticks, no preamble.

Here are all the vendors, artists, performers, and activities at the event:
${vendorSummary}`;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.headers["x-real-ip"]
    || "unknown";
  if (!(await isAllowed(ip))) {
    return res.status(429).json({ error: "Too many searches in a short time. Please wait a moment." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { query, vendorSummary } = body;

    if (typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ error: "Missing query" });
    }
    if (query.length > 300) {
      return res.status(400).json({ error: "Query too long" });
    }
    if (typeof vendorSummary !== "string" || !vendorSummary) {
      return res.status(400).json({ error: "Missing vendor data" });
    }

    // Google Gemini (free tier via Google AI Studio). No credit card required.
    // Get a key at https://aistudio.google.com/apikey and set it in Vercel as
    // AI_API_KEY. The model below is a fast, free-tier model; if Google renames
    // its free models, change the model name in the URL only.
    const MODEL = "gemini-2.0-flash";
    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.AI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt(vendorSummary) }] },
          contents: [{ role: "user", parts: [{ text: query }] }],
          generationConfig: {
            maxOutputTokens: 1000,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    if (!apiRes.ok) {
      const detail = await apiRes.text();
      console.error("Provider error", apiRes.status, detail);
      return res.status(502).json({ error: "AI provider error" });
    }

    const data = await apiRes.json();
    const text = (data.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || "")
      .join("");
    return res.status(200).json({ text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "AI request failed" });
  }
}

// ----------------------------------------------------------------------------
// PROVIDER NOTE
// This proxy currently uses Google Gemini's free tier (no card required), which
// is ideal while you build stakeholder support. The page never needs to know.
// To move to a paid provider later, replace ONLY the fetch block above.
//
// Anthropic (Claude):
//   const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "x-api-key": process.env.AI_API_KEY,
//       "anthropic-version": "2023-06-01",
//     },
//     body: JSON.stringify({
//       model: "claude-sonnet-4-6",
//       max_tokens: 1000,
//       system: buildSystemPrompt(vendorSummary),
//       messages: [{ role: "user", content: query }],
//     }),
//   });
//   const data = await apiRes.json();
//   const text = (data.content || []).map(i => i.text || "").join("");
//
// OpenAI:
//   const apiRes = await fetch("https://api.openai.com/v1/chat/completions", {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "Authorization": `Bearer ${process.env.AI_API_KEY}`,
//     },
//     body: JSON.stringify({
//       model: "gpt-4o-mini",
//       max_tokens: 1000,
//       messages: [
//         { role: "system", content: buildSystemPrompt(vendorSummary) },
//         { role: "user", content: query },
//       ],
//     }),
//   });
//   const data = await apiRes.json();
//   const text = data.choices?.[0]?.message?.content || "";
//
// The page contract (it sends {query, vendorSummary}, expects {text}) stays
// identical, so nothing on the page changes when you switch.
// ----------------------------------------------------------------------------
