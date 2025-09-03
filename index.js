// index.js
import express from "express";
import crypto from "crypto";
import { readFile } from "fs/promises";
import { getContext, setContext } from "./chatMemory.js";

// ─── App ───────────────────────────────────────────────────────────────────────
const app = express(); // we'll attach raw parser only on /webhook

// ─── ENV ───────────────────────────────────────────────────────────────────────
const LINE_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || "").trim();
const LINE_ACCESS_TOKEN  = (process.env.LINE_ACCESS_TOKEN  || "").trim();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const MODEL = process.env.MODEL || "moonshotai/kimi-k2:free";

// small logger helpers (kept from original style)
const mask = s => (!s ? "(empty)" : s.replace(/\s+/g, "").slice(0, 4) + "..." + s.replace(/\s+/g, "").slice(-4));
console.log("ENV → LINE_ACCESS_TOKEN:", mask(LINE_ACCESS_TOKEN));

// ─── Text utils (from your original) ───────────────────────────────────────────
function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[ \t\r\n]/g, "")
    .replace(/[.,;:!?'""“”‘’(){}\[\]<>|/\\\-_=+]/g, "");
}
function tokens(s) {
  const t = (s || "").toLowerCase();
  const m = t.match(/[#]?\d+|[a-zA-Zก-๙]+/g);
  return m || [];
}

// ─── CSV load & product index (from your original) ────────────────────────────
let PRODUCTS = [];
let NAME_INDEX = new Map();

async function loadProducts() {
  let csv = await readFile(new URL("./products.csv", import.meta.url), "utf8");
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

  const header = rows[0].map(h => h.trim().toLowerCase());
  const nameIdx  = header.findIndex(h => ["name","product","title","สินค้า","รายการ","product_name"].includes(h));
  const priceIdx = header.findIndex(h => ["price","ราคา","amount","cost"].includes(h));

  PRODUCTS = [];
  NAME_INDEX = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const rawName  = (cols[nameIdx  !== -1 ? nameIdx  : 0] || "").trim();
    const rawPrice = (cols[priceIdx !== -1 ? priceIdx : 1] || "").trim();
    if (!rawName) continue;
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

// (Optional) fuzzy finder kept for future use (same logic as your file)
function findProduct(query) {
  const qn = norm(query);
  const qTokens = tokens(query);
  if (NAME_INDEX.has(qn)) return NAME_INDEX.get(qn);

  const num = (query.match(/#\s*(\d+)/) || [])[1];
  const must = qTokens.filter(t => t.length >= 2 && !/^#?\d+$/.test(t));
  let candidates = PRODUCTS;

  if (num) {
    candidates = candidates.filter(p => p.num === num || p.name.includes(`#${num}`));
  }
  if (must.length) {
    candidates = candidates.filter(p => must.every(t => norm(p.name).includes(norm(t))));
  }
  if (candidates.length > 1) {
    candidates.sort((a, b) => {
      const aScore = must.filter(t => norm(a.name).includes(norm(t))).length;
      const bScore = must.filter(t => norm(b.name).includes(norm(t))).length;
      if (aScore !== bScore) return bScore - aScore;
      if (num && a.num !== b.num) return (b.num === num) - (a.num === num);
      return a.name.length - b.name.length;
    });
  }
  return candidates[0] || null;
}

// ─── LLM call (same prompt structure as original) ─────────────────────────────
async function askOpenRouter(userText, history = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  const productList = PRODUCTS
    .map(p => `${p.name} = ${Number.isFinite(p.price) ? p.price + " บาท" : p.price}`)
    .join("\n");

  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/prestige959-tech/my-shop-prices",
        "X-Title": "my-shop-prices line-bot"
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
- Bold the product name and price.
- If a product isn't found, suggest similar products or ask for clarification
- Be helpful, polite, and use appropriate Thai politeness particles (ค่ะ, นะ, etc.)
- Handle variations in product names, codes, and customer questions flexibly
- If customers ask general questions not related to products, respond helpfully as a shop assistant would
- Keep responses concise but friendly
- If customers ask for delivery such as "ส่งไหม" or มีบริการส่งไหม, answer 
  "บริษัทเรามีบริการจัดส่งโดยใช้ Lalamove ในพื้นที่กรุงเทพฯ และปริมณฑลค่ะ
  ทางร้านจะเป็นผู้เรียกรถให้ ส่วน ค่าขนส่งลูกค้าชำระเองนะคะ
  เรื่อง ยกสินค้าลง ทางร้านไม่มีทีมบริการให้ค่ะ ลูกค้าต้อง จัดหาคนช่วยยกลงเอง นะคะ"`
          },
          ...history,
          { role: "user", content: userText }
        ]
      })
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

// ─── LINE helpers ─────────────────────────────────────────────────────────────
function isValidLineSignature(bodyBuffer, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET);
  hmac.update(bodyBuffer);
  const digest = hmac.digest("base64");
  // timing-safe compare
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function lineReply(replyToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text?.slice(0, 5000) || "" }]
    })
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`LINE reply error ${res.status}: ${err}`);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// Health
app.get("/", (_req, res) => res.send("LINE bot up"));

// Use raw body ONLY for LINE signature route
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.get("x-line-signature");
    if (!isValidLineSignature(req.body, signature)) {
      console.warn("Invalid LINE signature");
      return res.status(403).send("invalid signature");
    }

    // Ack first — LINE requires 200 quickly
    res.status(200).end();

    // Process events asynchronously
    let data = {};
    try { data = JSON.parse(req.body.toString("utf8")); } catch { data = {}; }
    const events = Array.isArray(data.events) ? data.events : [];

    for (const event of events) {
      try {
        if (event.type !== "message" || event.message?.type !== "text") continue;

        const userId = event.source?.userId || "unknown";
        const replyToken = event.replyToken;
        const userText = (event.message?.text || "").trim();

        console.log("IN:", { userId, userText });

        // Load memory
        const history = await getContext(userId); // per-user memory key (same as original FB psid)  :contentReference[oaicite:2]{index=2}

        // Ask model (same prompt/catalog flow as original)  :contentReference[oaicite:3]{index=3}
        let answer;
        try {
          answer = await askOpenRouter(userText, history);
        } catch (e) {
          console.error("OpenRouter error:", e?.message);
          answer = "ขอโทษค่ะ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง 🙏";
        }

        // Reply to LINE
        await lineReply(replyToken, answer);

        // Save conversation memory (keep last 10 turns, TTL is in chatMemory.js)
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: answer });
        await setContext(userId, history); // trims & TTL  :contentReference[oaicite:4]{index=4}
      } catch (err) {
        console.error("Event handling error:", err);
      }
    }
  }
);

// ─── Boot ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  try {
    await loadProducts(); // same loader as original
  } catch (err) {
    console.error("Failed to load products.csv:", err?.message);
  }
  console.log("Bot running on port", PORT);
});
