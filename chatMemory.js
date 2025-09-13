import { createClient } from "redis";

const client = createClient({ url: process.env.REDIS_URL });
client.on("error", (err) => console.error("Redis error:", err));
await client.connect(); // Node 18+ ESM: top-level await OK

const TTL = Number(process.env.CHAT_TTL_SECONDS || 86400); // 1 day default

export async function getContext(psid) {
  const raw = await client.get(`chat:${psid}`);
  return raw ? JSON.parse(raw) : [];
}

export async function setContext(psid, messages) {
  const trimmed = messages.slice(-20); // keep last 20 turns
  await client.setEx(`chat:${psid}`, TTL, JSON.stringify(trimmed));
}
