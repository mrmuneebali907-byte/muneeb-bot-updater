'use strict';
/**
 * utils/emojiFight.js — koi sirf emoji bheje to bot bhi emoji se jawab de ("emoji ki ladai").
 *
 *  • group-wise switch, HAR BOT ka alag:  .emojifight on | off      (owner) — apne prefix se; doosre bots par asar nahi
 *  • Emoji Roast (text reply) aur Emoji Fight (emoji reply) ek saath nahi chalte:
 *      emojifight ON  → emoji roast apne aap OFF
 *      emoji roast ON → emoji fight apne aap OFF  (aur roast on ho to fight kuch nahi karta)
 */
const database = require('../database');

// emoji → bot ka jawabi emoji (ek ya zyada, random)
const FIGHT = {
  '🙂': ['🙃', '😏', '🫠'], '🙃': ['🙂', '😏'], '😊': ['😒', '😏', '🥱'], '😁': ['😬', '🤨'], '😀': ['😐', '🤨'], '😄': ['😒', '🙄'],
  '😂': ['🤣', '😭', '💀'], '🤣': ['😂', '💀', '😭'], '😭': ['🤡', '🥲', '😂'], '🥲': ['🫂', '😏'], '😢': ['🤧', '🫂'],
  '😡': ['😈', '🧊', '😎'], '🤬': ['🧊', '😎', '🚑'], '😠': ['😏', '🧊'], '😤': ['🫡', '😮‍💨'],
  '😎': ['🤓', '🕶️', '😏'], '🤓': ['😎', '🥱'], '😏': ['🙄', '😒'], '😒': ['😏', '🥱'], '🙄': ['😏', '🤨'],
  '🤡': ['🪞', '🤝', '😂'], '💀': ['⚰️', '😂', '👻'], '👻': ['💀', '😱'], '😈': ['👼', '😇', '🔥'], '😇': ['😈', '🙂'],
  '🔥': ['🧯', '💧', '😎'], '💧': ['🔥', '🧊'], '❤️': ['💔', '🫶', '😍'], '💔': ['❤️‍🩹', '🫂'], '😍': ['🤢', '😘', '🥰'], '😘': ['🤭', '😳'],
  '🥰': ['🤮', '😍'], '🥱': ['😴', '🛌'], '😴': ['🔔', '⏰'], '🤔': ['💡', '🧠'], '🧠': ['🪫', '🧐'], '😳': ['🤭', '😏'],
  '🤭': ['👀', '😏'], '👀': ['🫣', '🧐'], '😱': ['🫨', '👻'], '🤯': ['🧠💥', '🚑'], '🤮': ['🧻', '🚑'], '🤢': ['🧻', '🏥'],
  '👍': ['👎', '🫡', '💪'], '👎': ['👍', '😏'], '👏': ['🙌', '🫡'], '🙏': ['🫡', '😇'], '💪': ['🦾', '😎'], '✌️': ['🤞', '😎'],
  '🖕': ['🚫', '🤡'], '🤝': ['🫱🏽‍🫲🏼', '😎'], '🫡': ['🫡'], '😅': ['😂', '🥲'], '😬': ['😅', '🫠'], '🥺': ['😏', '🫂'], '😔': ['🫂', '🍵'],
  '🤐': ['🔊', '😏'], '😶': ['🗣️', '👀'], '🤨': ['🧐', '🙂'], '🧐': ['🤨', '🔍'], '😪': ['🛌', '☕'], '😩': ['🎭', '😂'], '😞': ['☕', '🫂'],
  '🐒': ['🍌', '🙈'], '🙈': ['🙉', '🙊'], '🍕': ['😋', '🤤'], '☕': ['🍵', '😌'], '🎉': ['🥳', '🎊'], '🥳': ['🎉', '🎈'],
};

const seg = (str) => (typeof Intl !== 'undefined' && Intl.Segmenter
  ? [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(str)].map((x) => x.segment) : Array.from(str));
const isEmojiG = (g) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g);
const norm = (e) => String(e || '').trim().replace(/[️\u{1F3FB}-\u{1F3FF}]/gu, '');

// HAR BOT KA APNA switch (bot ke number ke hisaab se) — ek bot ka on/off doosre bots par asar nahi karta.
const bid = () => { try { return require('./botScope').id(); } catch (_) { return 'default'; } };
const isOn = (g) => { try { return database.getBotSetting(bid(), `emojiFight_${g}`, false) === true; } catch (_) { return false; } };
const roastOn = (g) => {
  try {
    const mine = database.getBotSetting(bid(), `emojiRoast_${g}`, null);       // is bot ka apna roast switch
    if (mine !== null) return mine !== false;
    return (database.getGroupSettings(g) || {}).emojiRoast !== false;          // warna group wala
  } catch (_) { return true; }
};

const _last = new Map();   // groupId → [timestamps]  (do bots ki ladai / spam ko rokne ke liye)
function allowed(g) {
  const now = Date.now(); const a = (_last.get(g) || []).filter((t) => now - t < 60000);
  if (a.length && now - a[a.length - 1] < 3000) return false;   // 3 sec mein ek se zyada nahi
  if (a.length >= 8) return false;                               // 1 min mein 8 se zyada nahi
  a.push(now); _last.set(g, a); return true;
}

/** emoji jawab (string) ya null — body sirf emoji(s) ho tabhi */
function replyFor(groupId, body) {
  if (!isOn(groupId) || roastOn(groupId)) return null;           // roast ON ho to fight kaam nahi karta
  const t = String(body || '').trim();
  if (!t || t.length > 24) return null;
  const parts = seg(t).filter((g) => g.trim());
  if (!parts.length || parts.length > 6 || !parts.every((g) => isEmojiG(g) || /^[‍️]$/.test(g))) return null;
  if (!allowed(groupId)) return null;
  const first = norm(parts[0]);
  const pool = FIGHT[first];
  if (pool && pool.length) return pool[Math.floor(Math.random() * pool.length)];
  return parts.length === 1 ? t + t : t;                         // anjaan emoji → jaisa aaya waisa (ya double) wapas
}

function setOn(groupId, on) {
  database.setBotSetting(bid(), `emojiFight_${groupId}`, !!on);
  if (on) database.setBotSetting(bid(), `emojiRoast_${groupId}`, false);    // sirf IS bot ka roast band, group/baaki bots ka nahi
}

module.exports = { replyFor, isOn, roastOn, setOn, count: () => Object.keys(FIGHT).length };
