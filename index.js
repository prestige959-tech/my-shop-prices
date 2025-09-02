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

async function askOpenRouter(messages) {
  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: 'moonshot/kimi-latest',   // ← explicit Kimi-K2
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
  return res.data.choices[0].message.content.trim();
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
  } catch {
    return res.sendStatus(200);
  }

  const prompt = `
You are a friendly Thai sales assistant named Bot-Kimi.
User: "${text}"

Available products:
${products.map(p => `- ${p.product_name} (${p.price} บาท)`).join('\n')}

Reply rules:
- If asking price → "{price} บาท/ชิ้น"
- If "สนใจ" → "สนใจสินค้าตัวไหนคะ? เช่น ซีลาย # 26 เบา"
- Keep answers short and in Thai.
`;

  let reply;
  try {
    reply = await askOpenRouter([{ role: 'user', content: prompt }]);
  } catch (e) {
    reply = 'ขอโทษค่ะ ระบบชั่วคราว กรุณาลองใหม่';
  }

  try {
    await axios.post(
      'https://graph.facebook.com/v19.0/me/messages',
      { recipient: { id: userId }, message: { text: reply } },
      { params: { access_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN } }
    );
  } catch {
    /* ignore FB errors */
  }

  res.sendStatus(200);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Bot listening on ${port}`));
