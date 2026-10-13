'use strict';

/**
 * Islamic Greeting Handler — utils/islamicGreeting.js
 *
 * Handles two non-command auto-reply behaviors:
 *
 *  1. SALAM REPLY
 *     Trigger: salam / assalamualaikum / aslam o alikum / slm / aoa / aslm
 *     Response: Stylish Walekum Salam reply (5 random variations)
 *     Cooldown: 15 s per user — prevents spam in busy groups
 *
 *  2. HI / HELLO CORRECTION
 *     Trigger: hi / hello / hey / hlo / helo / heya (exact or leading word)
 *     Response: Polite, friendly Islamic-greeting guidance (5 variations)
 *     Cooldown: 20 s per user
 *
 * Both systems:
 *  ✔ Work in private + group chats
 *  ✔ Case-insensitive
 *  ✔ Random variation so replies never feel robotic
 *  ✔ Never fire on bot's own messages (msg.key.fromMe guard in handler)
 *  ✔ Never crash — all errors silently swallowed
 *
 * Exported:
 *  handleGreeting(sock, msg, body, sender, from) → Promise<boolean>
 *    Returns true if a greeting was handled (handler should return early).
 */

// ── Cooldown maps (per sender, milliseconds) ───────────────────────────────────
const _bs = require('./botScope');
const salamCooldown  = new Map();   // senderJid → lastRepliedAt
const hiCooldown     = new Map();   // senderJid → lastRepliedAt
const SALAM_CD_MS    = 15_000;      // 15 s
const HI_CD_MS       = 20_000;      // 20 s

// Auto-cleanup: prevent these maps from growing forever
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of salamCooldown) if (now - t > SALAM_CD_MS * 4)  salamCooldown.delete(k);
  for (const [k, t] of hiCooldown)    if (now - t > HI_CD_MS   * 4)  hiCooldown.delete(k);
}, 5 * 60 * 1000).unref();

// ── Trigger patterns ───────────────────────────────────────────────────────────
// Salam: exact word (or the whole message IS a salam phrase)
const SALAM_RE = /^(assalamu?\s*alaikum|assalam\s*o\s*alaikum|aslam\s*o\s*alikum|salam\s*alaikum|salam|slm|aoa|aslm|as salam|asalam|as-salam)[\s!.✨🤲]*$/i;

// Hi/Hello: leading word only (so "hi bhai" also triggers, but "bahishti" doesn't)
// Anchored at start, word-boundary checked on the keyword
const HI_RE = /^(hi|hello|hey|hlo|helo|heya)\b[\s!.,?😊🙂]*/i;

// ── Salam reply pool (5 unique styles) ────────────────────────────────────────
const SALAM_REPLIES = [
  `✨ *Walekum Salam Janab!* ✨\n\nKya haal hain? 😊\nAllah aapko khush rakhe 🤲\nAur tamam musibaton se bachaye! 🌹`,

  `🌙 *Wa Alaikum Salam!* 🌙\n\nAapka salam qubool ho janab! 😌\nAllah aapke dil ko sukoon de 🤲\nKhush aabad rahein! ✨`,

  `☀️ *Walekum Assalam wa Rahmatullahi wa Barakatuh!* ☀️\n\nSubhan Allah — kya pyara salam bheja! 🥰\nAllah aap par apni rehmat nazil farmaye 🌹\nKhairiyat hai na? 😊`,

  `🤝 *Wa Alaikum Salam Janab!* 🤝\n\nBahut khoob — Salam ek sunnat hai! 🌟\nAllah aapko sehat aur khushiyan de 🤲\nHar pal khair ho aapki! 💫`,

  `💚 *Walekum Salam wa Rahmatullah!* 💚\n\nMasha Allah — Salam ki Sunnat ada ki! 😊\nAllah aapko duniya aur aakhirat mein kamyab kare 🤲\nKhush rahein, aabaad rahein! 🌷`,
];

// ── Hi/Hello correction pool (5 unique polite variations) ─────────────────────
const HI_REPLIES = [
  `😊 *Janab!*\n\n"Hi / Hello" ki jagah *"Assalamu Alaikum"* kehna\nbahut zyada behtareen hai! 🌟\n\nYe ek sunnat bhi hai aur dono ke liye\ndua bhi ban jaati hai 🤲\n\nAap bhi zaroor azmaein! 💚`,

  `🌹 *Bhai/Baji,* salam ke fayde suniye!\n\n"Assalamu Alaikum" kehne se:\n✅ Ek naya silsila-e-dua shuru hota hai\n✅ Dono ke liye kher ki dua hoti hai\n✅ Sunnat e Nabi ﷺ ada hoti hai 🤲\n\nAb se "Hi" ki jagah *Salam* dein! 😊`,

  `✨ *Pehle Salam to Karen!* ✨\n\nJanab, "Hi" ya "Hello" kehne ki\nbajaye *"Assalamu Alaikum"* farmaein 🌙\n\nYe hamari pehchaan hai —\nMusalmano ka khoobsurat tareeqa! 💚\n\nAllah bless kare! 🤲`,

  `😌 *Ek Chhoti Si Guzarish:*\n\n"Hi/Hello" ki jagah\n*Assalamu Alaikum* kahein toh\n\n— Sunnah ada hogi ✅\n— Farishte Ameen kahenge 🌟\n— Barakah milegi insha'Allah 🤲\n\nShukriya — Jazak Allah Khair! 💚`,

  `🌙 *Pyari Baat:*\n\n"Hello" se nahi,\n*"As-Salamu Alaykum"* se shuru karo! 😊\n\nAllah ke Nabi ﷺ ne farmaya:\n_"Salam ko aam karo"_ 🤲\n\nChota sa amal, bara ajar! ✨\nAllah aap ko taufeeq de! 💚`,
];

// ── Random picker ──────────────────────────────────────────────────────────────
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ── Main exported function ─────────────────────────────────────────────────────
/**
 * @param {object} sock    — Baileys socket
 * @param {object} msg     — raw message object
 * @param {string} body    — extracted text body (already trimmed)
 * @param {string} sender  — sender JID
 * @param {string} from    — chat JID (group or private)
 * @returns {Promise<boolean>}  true = handled (caller should return early)
 */
async function handleGreeting(sock, msg, body, sender, from) {
  if (!body) return false;
  const now  = Date.now();
  const text = body.trim();

  // ── 1. Salam reply ───────────────────────────────────────────────────────────
  if (SALAM_RE.test(text)) {
    const last = salamCooldown.get(_bs.key(sender)) || 0;
    if (now - last < SALAM_CD_MS) return false;   // still in cooldown — skip silently
    salamCooldown.set(_bs.key(sender), now);

    try {
      await sock.sendMessage(from, { text: pick(SALAM_REPLIES) }, { quoted: msg });
    } catch (_) {}
    return true;
  }

  // ── 2. Hi / Hello correction ─────────────────────────────────────────────────
  if (HI_RE.test(text)) {
    const last = hiCooldown.get(_bs.key(sender)) || 0;
    if (now - last < HI_CD_MS) return false;
    hiCooldown.set(_bs.key(sender), now);

    try {
      await sock.sendMessage(from, { text: pick(HI_REPLIES) }, { quoted: msg });
    } catch (_) {}
    return true;
  }

  return false;
}

module.exports = { handleGreeting };
