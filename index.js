import express from "express";
}


// ---------- One-turn size/bundle intent carry with topic switch guard ----------
const lastUserMsg = (frags[frags.length - 1] || "");
const lastGroup = detectProductGroup(lastUserMsg);
const askedSpecNow = SPEC_RE.test(lastUserMsg);
const askedBundleNow = BUNDLE_RE.test(lastUserMsg);


if (askedSpecNow || askedBundleNow) {
pendingIntent.set(psid, {
spec: askedSpecNow,
bundle: askedBundleNow,
group: lastGroup || detectProductGroup(mergedForAssistant) || null,
ts: Date.now()
});
} else {
const intent = pendingIntent.get(psid);
if (intent) {
const sameGroup = intent.group && lastGroup && intent.group === lastGroup;
if (looksLikeProductOnly(lastUserMsg) && sameGroup) {
if (intent.spec) mergedForAssistant = `${mergedForAssistant} / ขอขนาด`;
if (intent.bundle) mergedForAssistant = `${mergedForAssistant} / 1 มัดมีกี่หน่วย`;
}
pendingIntent.delete(psid);
}
}


let reply;
try {
reply = await askOpenRouter(mergedForAssistant, history);
} catch (e) {
console.error("OpenRouter error:", e?.message);
reply = "ขอโทษค่ะ ระบบขัดข้องชั่วคราว กรุณาโทร 088-277-0145 นะคะ 🙏";
}


for (const f of frags) history.push({ role: "user", content: f });
history.push({ role: "user", content: `(รวมข้อความ JSON): ${JSON.stringify(parsed)}` });
history.push({ role: "user", content: `(รวมข้อความพร้อมใช้งาน): ${mergedForAssistant}` });
history.push({ role: "assistant", content: reply });
await setContext(psid, history);


try { await sendFBMessage(psid, reply); }
catch (err) { console.warn("FB send error:", err?.message); }
}, 15000);
}
}
} catch (e) {
console.error("Webhook handler error:", e?.message);
}
});


// ---- Health check ----
app.get("/", (_req, res) => res.send("FB bot is running"));


// ---- Boot ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
await loadProducts().catch(err => {
console.error("Failed to load products.csv:", err?.message);
});
console.log("Bot running on port", PORT);
});
