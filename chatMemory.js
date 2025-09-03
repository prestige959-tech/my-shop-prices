import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });
client.on('error', err => console.error('Redis error:', err));
await client.connect();

const TTL = Number(process.env.CHAT_TTL_SECONDS || 86400);

export async function getContext(psid) {
  const raw = await client.get(`chat:${psid}`);
  return raw ? JSON.parse(raw) : [];
}

export async function setContext(psid, messages) {
  const trimmed = messages.slice(-10);
  await client.setEx(`chat:${psid}`, TTL, JSON.stringify(trimmed));
}

// <-- add this:
export default { getContext, setContext };
