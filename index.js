// index.js
import express from "express";
import { readFile } from "fs/promises";

const app = express();
app.use(express.json());

// ---- ENV (Railway names) ----
const PAGE_TOKEN = (process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "").trim();
const VERIFY_TOKEN = (process.env.FACEBOOK_VERIFY_TOKEN || "").trim();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const MODEL = process.env.MODEL || "moonshotai/kimi-k2";


// ---- Small helpers ----
const encode = encodeURIComponent;
const mask = s => (!s ? "(empty)" : (s.replace(/\s+/g, "")).slice(0,4) + "..." + (s.replace(/\s+/g, "")).slice(-4));
console.log("ENV → PAGE_TOKEN:", mask(PAGE_TOKEN));

function norm(s) {
  // normalize Thai/ASCII, remove spaces and punctuation for fuzzy match
  return (s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[ \t\r\n]/g, "")
    .replace(/[.,;:!?'\"“”‘’(){}\[\]<>|/\\\-_=+]/g, "");
}
function tokens(s) {
  // keep Thai words & numbers & #numbers as tokens
  const t = (s || "").toLowerCase();
  const m = t.match(/[#]?\d+|[a-zA-Zก-๙]+/g);
  return m || [];
}

// ---- CSV load & product index ----
let PRODUCTS = [];           // [{name, price, normName, num, keywords[]}]
let NAME_INDEX = new Map();  // normName -> product

async function loadProducts() {
  // Reads ./products.csv from repo root
  let csv = await readFile(new URL("./products.csv", import.meta.url), "utf8");

  // Simple CSV parser (handles quoted fields)
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  while (i < csv.length) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      } else { field += c; i++; continue; }
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      field += c; i++; continue;
    }
  }
  row.push(field); rows.push(row);

  // detect header
  const header = rows[0].map(h => h.trim().toLowerCase());
  const nameIdx =
    header.findIndex(h => ["name","product","title","สินค้า","รายการ","product_name"].includes(h));
  const priceIdx =
    header.findIndex(h => ["price","ราคา","amount","cost"].includes(h));

  if (nameIdx === -1 || priceIdx === -1) {
    console.warn("CSV header not recognized. Assuming 1st col=name, 2nd col=price.");
  }

  PRODUCTS = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const rawName = (cols[nameIdx !== -1 ? nameIdx : 0] || "").trim();
    const rawPrice = (cols[priceIdx !== -1 ? priceIdx : 1] || "").trim();
    if (!rawName) continue;

    // price to number
    const price = Number(String(rawPrice).replace(/[^\d.]/g, ""));
    const n = norm(rawName);
    const kw = tokens(rawName);
    const codeMatch = rawName.match(/#\s*(\d+)/);
    const num = codeMatch ? codeMatch[1] : null;

    const item = { name: rawName, price, normName: n, num, keywords: kw };
    PRODUCTS.push(item);
    if (!NAME_INDEX.has(n)) NAME_INDEX.set(n, item);
  }

  console.log(`Loaded ${PRODUCTS.length} products from CSV.`);
}

function findProduct(query) {
  const qn = norm(query);
  const qTokens = tokens(query);

  // Try exact normalized name
  if (NAME_INDEX.has(qn)) return NAME_INDEX.get(qn);

  // Extract number like # 26
  const num = (query.match(/#\s*(\d+)/) || [])[1];

  // Heuristic 1: must contain all non-trivial tokens
  const must = qTokens.filter(t => t.length >= 2 && !/^#?\d+$/.test(t)); // words only
  let candidates = PRODUCTS;

  if (num) {
    candidates = candidates.filter(p => p.num === num || p.name.includes(`#${num}`));
  }
  if (must.length) {
    candidates = candidates.filter(p => {
      const pn = norm(p.name);
      return must.every(t => pn.includes(norm(t)));
    });
  }

  // If still many, pick the one with highest token overlap
  if (candidates.length > 1) {
    candidates.sort((a,b) => {
      const aScore = must.filter(t => norm(a.name).includes(norm(t))).length;
      const bScore = must.filter(t => norm(b.name).includes(norm(t))).length;
      if (aScore !== bScore) return bScore - aScore;
      // Prefer exact number match
      if (num && a.num !== b.num) return (b.num === num) - (a.num === num);
      return a.name.length - b.name.length; // shorter usually more specific
    });
  }
  return candidates[0] || null;
}


// ---- Facebook send ----
async function sendFBMessage(psid, text) {
  const url = `https://graph.facebook.com/v16.0/me/messages?access_token=${encode(PAGE_TOKEN)}`;
  const body = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: { text: text?.slice(0,2000) || "" }
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`FB send failed ${r.status}: ${t}`);
  }
}

// ---- OpenRouter chat with product knowledge ----
async function askOpenRouter(userText) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  
  // Build product list for context
  const productList = PRODUCTS.map(p => 
    `${p.name} = ${Number.isFinite(p.price) ? p.price + ' บาท' : p.price}`
  ).join('\n');
  
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/prestige959-tech/my-shop-prices",
        "X-Title": "my-shop-prices fb-bot"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content: `You are a friendly Thai shop assistant chatbot. You help customers with product inquiries in a natural, conversational way.

PRODUCT CATALOG:
${productList}

INSTRUCTIONS:
- Answer in Thai language naturally and conversationally
- When customers ask about prices, provide the exact price from the catalog above
- If a product isn't found, suggest similar products or ask for clarification
- Be helpful, polite, and use appropriate Thai politeness particles (ครับ/ค่ะ, นะ, etc.)
- Handle variations in product names, codes, and customer questions flexibly
- If customers ask general questions not related to products, respond helpfully as a shop assistant would
- Keep responses concise but friendly

Remember: You have access to the complete product catalog above. Use it to provide accurate pricing and product information.`
          },
          { role: "user", content: userText }
        ]
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`OpenRouter ${r.status}: ${text}`);
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? null;
    if (!content) throw new Error("No content from OpenRouter");
    return content.trim();
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Webhook verify ----
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ---- Webhook receiver ----
app.post("/webhook", async (req, res) => {
  try {
    res.sendStatus(200); // ack fast
    const body = req.body;
    if (body.object !== "page" || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      const msgs = entry.messaging || [];
      for (const ev of msgs) {
        const psid = ev?.sender?.id;
        const text = ev?.message?.text?.trim();
        if (!psid || !text) continue;

        console.log("IN:", { psid, text });

        // Always use OpenRouter with full product catalog as knowledge base
        let reply;
        try {
          reply = await askOpenRouter(text);
        } catch (e) {
          console.error("OpenRouter error:", e?.message);
          reply = "ขอโทษค่ะ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง 🙏";
        }

        // 3) Send reply
        try {
          await sendFBMessage(psid, reply);
        } catch (e) {
          console.error("FB send error:", e?.message);
        }
      }
    }
  } catch (e) {
    console.error("Webhook handler error:", e?.message);
  }
});

// ---- Boot ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await loadProducts().catch(err => {
    console.error("Failed to load products.csv:", err?.message);
  });
  console.log("Bot running on port", PORT);
});
