// index.js
import express from 'express';
import axios from 'axios';
import csv from 'csvtojson';

const app = express();
app.use(express.json());

const PRODUCTS_URL = `https://raw.githubusercontent.com/${process.env.GITHUB_USERNAME}/my-shop-prices/main/products.csv`;

async function loadProducts() {
  const { data } = await axios.get(PRODUCTS_URL);
  return await csv().fromString(data);
}

/* ---------- OpenRouter + Kimi-K2 ---------- */
async function askOpenRouter(messages) {
  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: 'moonshot/kimi-latest',
      messages,
      temperature: 0.3,
      max_tokens: 150
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://railway.app',
        'X-Title': 'Facebook Price Bot'
      },
      timeout: 4000
    }
  );
  return res.data.choices[0].message.content;
}

/* ---------- Facebook Webhooks ---------- */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  return (mode === 'subscribe' && token === process.env.FACEBOOK_VERIFY_TOKEN)
    ? res.status(200).send(challenge)
    : res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  const entry = req.body.entry?.[0];
  if (!entry) return res.sendStatus(200);
  const messaging = entry.messaging?.[0];
  if (!messaging?.message?.text) return res.sendStatus(200);

  const userId = messaging.sender.id;
  const text = messaging.message.text.trim();

  let products;
  try {
    products = await loadProducts();
  } catch (e) {
    return res.sendStatus(200); // fail silently, FB will retry
  }

  const prompt = `
You are a Thai sales assistant.
User: "${text}"
Available products (exact names):
${products.map(p => `- ${p.product_name} (${p.price} บาท)`).join('\n')}

Reply in Thai.
- If asking price → "{price} บาท/ชิ้น"
- If "สนใจ" → "สนใจสินค้าตัวไหนคะ? รบกวนบอกชื่อสินค้า เช่น ซีลาย # 26 เบา"
- Otherwise → politely ask for clarification.
`;

  let reply;
  try {
    reply = await askOpenRouter([
      { role: 'system', content: prompt },
      { role: 'user', content: text }
    ]);
  } catch (e) {
    reply = 'ขอโทษค่ะ ระบบชั่วคราว กรุณาลองใหม่';
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: userId },
        message: { text: reply }
      },
      {
        params: { access_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN }
      }
    );
  } catch (_) {
    /* ignore FB errors */
  }

  res.sendStatus(200);
});

/* ---------- Start server ---------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Bot listening on ${port}`));
