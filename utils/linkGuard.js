'use strict';
/**
 * utils/linkGuard.js — Anti-Link ke liye helper.
 *
 *  1. extractText(message): message ke ANDAR ki saari likhi cheezein nikalta hai — sirf text/caption nahi:
 *     payment-note, buttons, list, template, interactive, group-invite card, poll, contact, ad-preview, edited message ... sab.
 *     (Pehle sirf text/caption dekha jata tha, isliye "Payment message" ke andar chhupi link nikal jati thi.)
 *  2. hasLink(text): link / invite / t.me / wa.me / bit.ly waghera.
 *  3. burst(): ek spammer 150-200 link ek saath bheje to sirf PEHLE message par poori kaarwai (kick/warn),
 *     baaki sab par sirf tez delete — kick/warn/notice bar-bar nahi.
 *  4. deleteQueued(): deletes ek line mein, thodi gap se — taaki WhatsApp rate-limit na kare aur koi chhoote nahi.
 */
const SKIP = new Set(['jpegThumbnail', 'thumbnail', 'mediaKey', 'fileSha256', 'fileEncSha256', 'directPath', 'streamingSidecar', 'scansSidecar',
  'midQualityFileSha256', 'highQualityThumbnail', 'thumbnailDirectPath', 'thumbnailSha256', 'thumbnailEncSha256', 'quotedMessage', 'messageContextInfo',
  'senderKeyDistributionMessage', 'mediaKeyTimestamp', 'waveform']);

function extractText(message) {
  const out = [];
  let nodes = 0;
  const walk = (v, depth, key) => {
    if (v == null || depth > 14 || nodes++ > 600) return;
    if (typeof v === 'string') { if (v.length <= 4000) out.push(v); return; }
    if (typeof v !== 'object' || Buffer.isBuffer(v) || v instanceof Uint8Array) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1, key); return; }
    if (v.inviteCode) out.push(`https://chat.whatsapp.com/${v.inviteCode}`);          // groupInviteMessage = asli group link
    for (const k of Object.keys(v)) {
      if (SKIP.has(k)) continue;
      if (k === 'contextInfo') { if (v[k] && v[k].externalAdReply) walk(v[k].externalAdReply, depth + 1, 'externalAdReply'); continue; }
      walk(v[k], depth + 1, k);
    }
  };
  try { walk(message, 0, ''); } catch (_) {}
  return out.join(' \n ').replace(/\\\//g, '/').replace(/\\u0026/g, '&');
}

const LINK_RES = [
  /(?:https?:\/\/|www\.)\S{3,}/i,
  /chat\.whatsapp\.com\/[A-Za-z0-9]{5,}/i,
  /whatsapp\.com\/(?:channel|invite)\/[A-Za-z0-9]+/i,
  /\b(?:wa\.me|t\.me|telegram\.me|bit\.ly|tinyurl\.com|discord\.gg|youtu\.be)\/\S+/i,
];
const hasLink = (t) => !!t && LINK_RES.some((r) => r.test(t));
const hasInvite = (t) => !!t && /chat\.whatsapp\.com\/[A-Za-z0-9]{5,}/i.test(t);

// ---- burst / flood control ----
const _burst = new Map();   // group|sender → { t, n }
const BURST_MS = 20000;
function burst(from, ids) {
  const now = Date.now();
  const key = `${from}|${(ids.filter(Boolean)[0]) || ''}`;
  for (const k of ids) { const e = _burst.get(`${from}|${k}`); if (e && now - e.t < BURST_MS) { e.t = now; e.n++; return { first: false, n: e.n }; } }
  _burst.set(key, { t: now, n: 1 });
  if (_burst.size > 500) for (const [k, e] of _burst) if (now - e.t > BURST_MS * 3) _burst.delete(k);
  return { first: true, n: 1 };
}
const isOffender = (from, ids) => { const now = Date.now(); return ids.some((k) => { const e = _burst.get(`${from}|${k}`); return e && now - e.t < BURST_MS; }); };

// ---- delete queue per group: 3 ek saath, thodi gap se (WhatsApp rate-limit se bachne ke liye, par tez) ----
const _q = new Map();   // group → { items:[], active:n }
function deleteQueued(sock, key, gapMs = 45, workers = 3) {
  const g = key.remoteJid;
  let st = _q.get(g);
  if (!st) { st = { items: [], active: 0 }; _q.set(g, st); }
  return new Promise((resolve) => {
    st.items.push({ key, resolve });
    const run = async () => {
      st.active++;
      while (st.items.length) {
        const it = st.items.shift();
        try { await sock.sendMessage(g, { delete: it.key }); } catch (_) {}
        it.resolve();
        await new Promise((r) => setTimeout(r, gapMs));
      }
      st.active--;
      if (!st.active && !st.items.length) _q.delete(g);
    };
    if (st.active < workers) run();
  });
}

module.exports = { extractText, hasLink, hasInvite, burst, isOffender, deleteQueued };
