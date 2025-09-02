// index.js
import express from "express";

const app = express();
app.use(express.json());

// === ENV ===
// match Railway variable names
const PAGE_TOKEN = (process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "").trim();
const VERIFY_TOKEN = (process.env.FACEBOOK_VERIFY_TOKEN || "").trim();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const MODEL = process.env.MODEL || "openai/gpt-3.5-turbo";


// Track delivery/dedup within a short window
const seenDelivery = new Set();
const seenExpireMs = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const k of seenDelivery) {
    const [id, ts] = k.split(":");
    if (now - Number(ts) > seenExpireMs) seenDelivery.delete(k);
  }
}, 60_000);

// Helper: send a message back to Messenger
async function sendFBMessage(psid, text) {
  const url = `https://graph.facebook.com/v16.0/me/messages?access_token=${PAGE_TOKEN}`;
  const body = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: { text: text?.slice(0, 2000) || "" }, // Messenger text limit
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

// Helper: call OpenRouter
async function askOpenRouter(userText, threadId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000); // 25s safety
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
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful Thai customer support assistant for a Facebook shop. " +
              "ตอบเป็นภาษาไทยสุภาพ กระชับ ช่วยถามต่อเมื่อข้อมูลไม่พอ " +
              "If user asks for prices or stock, ask for the product code if missing."
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

    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      null;

    if (!content || typeof content !== "string") {
      throw new Error("No content in OpenRouter response");
    }
    return content.trim();
  } finally {
    clearTimeout(timeout);
  }
}

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook receiver
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    res.sendStatus(200); // Always 200 quickly

    if (body.object !== "page" || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      const messaging = entry.messaging || entry.standby || [];
      for (const event of messaging) {
        const psid = event?.sender?.id;
        const mid = event?.message?.mid || event?.delivery?.mids?.[0] || "no-mid";
        const dedupKey = `${mid}:${Date.now()}`;

        if (!psid || !event.message || !event.message.text) continue;

        if ([...seenDelivery].some(k => k.startsWith(mid + ":"))) continue;
        seenDelivery.add(dedupKey);

        const userText = (event.message.text || "").trim();
        console.log("IN:", { psid, userText });

        // Typing indicator
        fetch(`https://graph.facebook.com/v16.0/me/messages?access_token=${PAGE_TOKEN}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipient: { id: psid }, sender_action: "typing_on" }),
        }).catch(() => {});

        let reply;
        try {
          reply = await askOpenRouter(userText, psid);
        } catch (err) {
          console.error("OpenRouter error:", err?.message);
          reply = "ขอโทษค่ะ ระบบขัดข้องชั่วคราว กรุณาลองพิมพ์อีกครั้ง หรือแจ้งรหัสสินค้า/คำถามให้ละเอียดขึ้น 🙏";
        }

        try {
          await sendFBMessage(psid, reply);
        } catch (err) {
          console.error("FB send error:", err?.message);
        }
      }
    }
  } catch (e) {
    console.error("Webhook handler error:", e?.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot running on port", PORT);
});
