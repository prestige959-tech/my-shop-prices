// index.js
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { redis, getHistory, saveHistory } from "./chatMemory.js";

const PORT = process.env.PORT || 3000;

// ---- LINE credentials ----
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

// ---- OpenRouter creds/model ----
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL || "moonshotai/kimi-k2";

// ---- (Optional) load products.csv for price lookups ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRODUCTS_CSV = path.join(__dirname, "products.csv");

let products = [];
try {
  if (fs.existsSync(PRODUCTS_CSV)) {
    const csv = fs.readFileSync(PRODUCTS_CSV, "utf8").trim();
    products = csv
      .split("\n")
      .slice(1)
      .map((line) => {
        const [name, price, unit, notes] = line.split(",");
        return { name: name?.trim(), price: price?.trim(), unit: unit?.trim(), notes: (notes || "").trim() };
      })
      .filter((x) => x.name);
    console.log(`Loaded ${products.length} products from CSV`);
  } else {
    console.log("products.csv not found; continuing without product data");
  }
} catch (e) {
  console.warn("Error loading products.csv:", e.message);
}

// ---- Tiny product helper (optional) ----
function findProduct(text) {
  const t = text.toLowerCase();
  return products.find((p) => t.includes(p.name.toLowerCase()));
}

// ---- Build LINE signature and compare ----
function isValidLineSignature(bodyBuffer, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET);
  hmac.update(bodyBuffer);
  const digest = hmac.digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

// ---- LLM call via OpenRouter ----
async function callModel(history, userText) {
  const system = {
    role: "system",
    content:
      "You are a helpful shop assistant. Keep replies concise. If the user asks for prices, use any provided product data. If uncertain, ask a clarifying question.",
  };

  const messages = [system, ...history, { role: "user", content: userText }];

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://example.com",
      "X-Title": "my-shop-chatbot"
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.4
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const json = await res.json();
  return json?.choices?.[0]?.message?.content?.trim() || "ขอโทษค่ะ ตอนนี้ระบบมีปัญหา ลองใหม่อีกครั้งนะคะ";
}

// ---- LINE reply API ----
async function lineReply(replyToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`LINE reply error ${res.status}: ${err}`);
  }
}

const app = express();

// IMPORTANT: For signature validation, we need the raw body buffer.
app.post("/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.get("x-line-signature");
      if (!isValidLineSignature(req.body, signature)) {
        console.warn("Invalid LINE signature");
        return res.status(403).send("invalid signature");
      }

      const body = JSON.parse(req.body.toString("utf8"));
      if (!body.events || !Array.isArray(body.events)) {
        return res.status(200).end(); // nothing to do
      }

      // Ack LINE quickly; handle events async
      res.status(200).end();

      for (const event of body.events) {
        if (event.type !== "message" || event.message?.type !== "text") continue;

        const userId = event.source?.userId || "unknown";
        const replyToken = event.replyToken;
        const userText = (event.message?.text || "").trim();

        // Load memory
        const history = await getHistory(userId);

        // Optional: short-circuit if a product name is mentioned
        const p = findProduct(userText);
        if (p) {
          const reply = `ราคา ${p.name} ${p.price}${p.unit ? " / " + p.unit : ""}${p.notes ? " — " + p.notes : ""}`;
          await lineReply(replyToken, reply);
          // Save this turn to memory as well
          const updated = [...history, { role: "user", content: userText }, { role: "assistant", content: reply }];
          await saveHistory(userId, updated);
          continue;
        }

        // Ask the LLM
        let answer;
        try {
          answer = await callModel(history, userText);
        } catch (e) {
          console.error(e);
          answer = "ขอโทษค่ะ ระบบตอบช้า ลองพิมพ์อีกครั้งได้ไหมคะ";
        }

        // Reply to LINE
        await lineReply(replyToken, answer);

        // Persist memory
        const updated = [...history, { role: "user", content: userText }, { role: "assistant", content: answer }];
        await saveHistory(userId, updated);
      }
    } catch (e) {
      console.error("Webhook handler error:", e);
      // If we haven't responded yet, send a 200 to avoid LINE retries storm
      try { res.status(200).end(); } catch {}
    }
  }
);

// Health check
app.get("/", (_req, res) => res.send("LINE bot up"));

(async () => {
  await redis.connect().catch((e) => {
    console.error("Failed to connect Redis:", e);
    process.exit(1);
  });
  app.listen(PORT, () => console.log(`Bot running on :${PORT}`));
})();
