// index.js — LINE Official Account bot with Redis memory + OpenRouter
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getHistory, saveHistory } from "./chatMemory.js"; // ✅ match your exports

// ── ENV ───────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const LINE_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || "").trim();
const LINE_ACCESS_TOKEN  = (process.env.LINE_ACCESS_TOKEN  || "").trim();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const MODEL = process.env.MODEL || "moonshotai/kimi-k2";

// ── Basic logger ──────────────────────────────────────────────────────────────
const mask = (s) =>
  !s ? "(empty)" : s.replace(/\s+/g, "").slice(0, 4) + "..." + s.replace(/\s+/g, "").slice(-4);
console.log("ENV → LINE_ACCESS_TOKEN:", mask(LINE_ACCESS_TOKEN));

// ── Text utils (lightweight) ─────────────────────────────────────────────────
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

// ── Load products.csv (optional but kept from your original) ──────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRODUCTS_CSV = path.join(__dirname, "products.csv");

let PRODUCTS = [];
let NAME_INDEX = new Map();

function loadProductsSync() {
  if (!fs.existsSync(PRODUCTS_CSV)) {
    console.log("products.csv not found; continuing without product data");
    return;
  }
  const csv = fs.readFileSync(PRODUCTS_CSV, "utf8");

  // Tiny CSV splitter that supports quotes
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

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const nameIdx  = header.findIndex((h) => ["name","product","title","สินค้า","รายการ","product_name"].includes(h));
  const priceIdx = header.findIndex((h) => ["price","ราคา","amount","cost"].includes(h));

  PRODUCTS = [];
  NAME_INDEX = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const rawName  = (cols[nameIdx  !== -1 ? nameIdx  : 0] || "").trim();
    const rawPrice = (cols[priceIdx !== -1 ? priceIdx : 1] || "").trim();
    if (!rawName) continue;
    const price = Number(String(rawPrice).replace(/[^\d.]/g, ""));
    const codeMatch = rawName.match(/#\s*(\d+)/);
    const num = codeMatch ? codeMatch[1] : null;

    const item = { name: rawName, price, normName: norm(rawName), num, keywords: tokens(rawName) };
    PRODUCTS.push(item);
    if (!NAME_INDEX.has(item.normName)) NAME_INDEX.set(item.normName, item);
  }
  console.log(`Loaded ${PRODUCTS.length} products from CSV`);
}
loadProductsSync();

function findProduct(query) {
  const qn = norm(query);
  if (NAME_INDEX.has(qn)) return NAME_INDEX.get(qn);

  const qTokens = tokens(query).filter((t) => t.length >= 2 && !/^#?\d+$/.test(t));
  const num = (query.match(/#\s*(\d+)/) || [])[1];
  let candidates = PRODUCTS;

  if (num) candidates = candidates.filter((p) => p.num === num || p.name.includes(`#${num}`));
  if (qTokens.length) {
    candidates = candidates.filter((p) => qTokens.every((t) => p.normName.includes(norm(t))));
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.name.length - b.name.length);
  return candidates[0];
}

// ── LLM (OpenRouter) ─────────────────────────────────────────────────────────
async function callModel(history, userText) {
  const productList = PRODUCTS
    .map((p) => `${p.name} = ${Number.isFinite(p.price) ? p.price + " บาท" : p.price}`)
    .join("\n");

  const messages = [
    {
      role: "system",
      content: `You are a friendly Thai shop assistant chatbot. You help customers with product inquiries.

PRODUCT CATALOG:
${productList}

INSTRUCTIONS:
- Answer in Thai, naturally and concisely
- When customers ask about prices, provide the exact price from the catalog above
- **Bold** the product name and price
- If a product isn't found, suggest similar items or ask for clarification
- If asked about delivery ("ส่งไหม", etc.), reply:
  "บริษัทเรามีบริการจัดส่งโดยใช้ Lalamove ในพื้นที่กรุงเทพฯ และปริมณฑลค่ะ
  ทางร้านจะเป็นผู้เรียกรถให้ ส่วน ค่าขนส่งลูกค้าชำระเองนะคะ
  เรื่อง ยกสินค้าลง ทางร้านไม่มีทีมบริการให้ค่ะ ลูกค้าต้อง จัดหาคนช่วยยกลงเอง นะคะ"`
    },
    ...history,
    { role: "user", content: userText }
  ];

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://example.com",
      "X-Title": "my-shop-prices line-bot"
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.4 })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content?.trim() || "ขอโทษค่ะ ตอนนี้ระบบมีปัญหา ลองใหม่อีกครั้งนะคะ";
}

// ── LINE helpers ──────────────────────────────────────────────────────────────
function isValidLineSignature(bodyBuffer, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET);
  hmac.update(bodyBuffer);
  const digest = hmac.digest("base64");
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

// ── App + Routes ──────────────────────────────────────────────────────────────
const app = express();

// Health check
app.get("/", (_req, res) => res.send("LINE bot up"));

// webhook must use raw body for signature verification
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.get("x-line-signature");
  if (!isValidLineSignature(req.body, signature)) {
    console.warn("Invalid LINE signature");
    return res.status(403).send("invalid signature");
  }

  res.status(200).end(); // ACK quickly

  let payload = {};
  try { payload = JSON.parse(req.body.toString("utf8")); } catch {}
  const events = Array.isArray(payload.events) ? payload.events : [];

  for (const event of events) {
    try {
      if (event.type !== "message" || event.message?.type !== "text") continue;

      const userId = event.source?.userId || "unknown";
      const replyToken = event.replyToken;
      const userText = (event.message?.text || "").trim();

      // 1) Load memory
      const history = await getHistory(userId);

      // 2) Quick direct price answer if a product name is detected
      const p = findProduct(userText);
      if (p) {
        const reply = `ราคา **${p.name}** **${p.price} บาท**`;
        await lineReply(replyToken, reply);
        const updated = [...history, { role: "user", content: userText }, { role: "assistant", content: reply }];
        await saveHistory(userId, updated);
        continue;
      }

      // 3) Ask LLM with memory
      let answer;
      try {
        answer = await callModel(history, userText);
      } catch (e) {
        console.error("LLM error:", e);
        answer = "ขอโทษค่ะ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง 🙏";
      }

      // 4) Reply + persist memory
      await lineReply(replyToken, answer);
      const updated = [...history, { role: "user", content: userText }, { role: "assistant", content: answer }];
      await saveHistory(userId, updated);
    } catch (err) {
      console.error("Event handling error:", err);
    }
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Bot running on :${PORT}`);
});
