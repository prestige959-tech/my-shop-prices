// chatMemory.js
import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL;
const CHAT_TTL_SECONDS = Number(process.env.CHAT_TTL_SECONDS || 86400); // 24h
const HISTORY_TURNS = Number(process.env.HISTORY_TURNS || 10);

export const redis = createClient({ url: REDIS_URL });
redis.on("error", (err) => console.error("Redis error:", err));

export async function getHistory(userId) {
  const raw = await redis.get(`chat:${userId}`);
  return raw ? JSON.parse(raw) : [];
}

export async function saveHistory(userId, history) {
  const keep = history.slice(-HISTORY_TURNS);
  await redis.setEx(`chat:${userId}`, CHAT_TTL_SECONDS, JSON.stringify(keep));
}
