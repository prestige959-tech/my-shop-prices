// index.js
import express from 'express';
import axios from 'axios';
import csv from 'csvtojson';

const app = express();
app.use(express.json());

const PRODUCTS_URL = 'https://raw.githubusercontent.com/<YOUR_USERNAME>/my-shop-prices/main/products.csv';

async function loadProducts() {
  const { data } = await axios.get(PRODUCTS_URL);
  return await csv().fromString(data);
}

async function askKimi(messages) {
  const res = await axios.post('https://api.moonshot.cn/v1/chat/completions', {
    model: 'kimi-latest',
    messages,
    temperature: 0.3
  }, {
    headers: { Authorization: `Bearer ${process.env.KIMI_API_KEY}` }
  });
  return res.data.choices[0].message.content;
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.FACEBOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const entry = req.body.entry?.[0];
  if (!entry) return res.sendStatus(200);
  const messaging = entry.messaging?.[0];
  if (!messaging?.message?.text) return res.sendStatus(200);

  const userId = messaging.sender.id;
  const text = messaging.message.text.trim();

  const products = await loadProducts();
  const productMap = new Map(products.map(p => [p.product_name, p.price]));

  const prompt = `
You are a Thai sales assistant.
The user just sent: "${text}"
Available product names:
${products.map(p => `- ${p.product_name}`).join('\n')}

Reply in Thai.
If the user asks for price, respond with:
"{price} บาท/ชิ้น"
If the user says something like "สนใจ", respond as a friendly seller:
"สนใจสินค้าตัวไหนคะ? รบกวนบอกชื่อสินค้า เช่น ซีลาย # 26 เบา"
If unclear, kindly ask for clarification.
`;

  const reply = await askKimi([
    { role: 'system', content: prompt },
    { role: 'user', content: text }
  ]);

  await axios.post(`https://graph.facebook.com/v19.0/me/messages`, {
    recipient: { id: userId },
    message: { text: reply }
  }, {
    params: { access_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN }
  });

  res.sendStatus(200);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
