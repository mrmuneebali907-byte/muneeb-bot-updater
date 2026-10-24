'use strict';
/**
 * utils/replyStyle.js — "profile-picture card" on top of every bot reply.
 *
 * WhatsApp shows the message you REPLY to as a small preview above the answer. The bot decides what that preview is,
 * so instead of the user's plain text we quote a (fake) card whose avatar WhatsApp fills with the DP of the person
 * who ran the command — each user sees his own picture. Only the preview changes; the real message id stays.
 *
 *   .replystyle              → list styles
 *   .replystyle circle       → DP circle card ("Request successful / View details" look)
 *   .replystyle payment|contact|order|off
 */
// brand = crimson+gold crown | neon = cyan/magenta bolt | gold = black+gold | royal = purple diamond | fire = orange flame | matrix = green star
const THEMES = {
  brand : { bg: ['#0b1030', '#2a0a2e', '#7a0f22'], ring: ['#fff3b0', '#f5b82e', '#c77d0a'], glow: '#ff3b5c', star: '#ffe9a8', badge: 'crown'   },
  neon  : { bg: ['#04061a', '#0a1a3a', '#2a0647'], ring: ['#00f5ff', '#7a5cff', '#ff2bd6'], glow: '#00e5ff', star: '#b9f6ff', badge: 'bolt'    },
  gold  : { bg: ['#080808', '#1c1507', '#3d2c06'], ring: ['#fff6c8', '#ffd24a', '#b8860b'], glow: '#ffcc33', star: '#fff0b3', badge: 'crown'   },
  royal : { bg: ['#0d0630', '#2b0f6b', '#5b21b6'], ring: ['#ffffff', '#c4b5fd', '#8b5cf6'], glow: '#a78bfa', star: '#e9e3ff', badge: 'diamond' },
  fire  : { bg: ['#1a0500', '#5a1000', '#b32a00'], ring: ['#ffe29a', '#ff9d00', '#ff3d00'], glow: '#ff6a00', star: '#ffd8a0', badge: 'bolt'    },
  matrix: { bg: ['#00110a', '#022b1a', '#044d2e'], ring: ['#b6ffd9', '#2bff88', '#00a651'], glow: '#00ff88', star: '#c9ffe4', badge: 'star'    },
};
const STYLES = ['off', ...Object.keys(THEMES), 'circle', 'payment', 'contact', 'order'];
const LABEL = 'Request successful';   // only for the old payment-look styles
const fs = require('fs'), path = require('path');

const botIdOf = (sock) => String(sock?.user?.id || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || 'default';
const db = () => require('../database');

const DEFAULT_LABEL = '𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢\n⚡ 𝐀𝐈 𝐖𝐡𝐚𝐭𝐬𝐀𝐩𝐩 𝐁𝐨𝐭 ⚡';   // card ka naam (2 lines)
function getLabel(sock, botName) {
  try { const v = db().getBotSetting(botIdOf(sock), 'replyLabel', ''); if (v) return String(v).replace(/\s*\|\s*/g, '\n').slice(0, 80); } catch (_) {}
  return DEFAULT_LABEL;
}
function setLabel(sock, text) { try { db().setBotSetting(botIdOf(sock), 'replyLabel', String(text || '').slice(0, 80)); return true; } catch (_) { return false; } }

// ── DP → stylish branded card ─────────────────────────────────────────────────────────────────
// Order: user's own DP → OWNER's DP (config.ownerNumber[0]) → bot logo.  Result is cached 30 min per person.
let _logoRaw;     // bot_image.jpg (read once)
function logoRaw() {
  if (_logoRaw !== undefined) return _logoRaw;
  try { _logoRaw = fs.readFileSync(path.join(__dirname, 'bot_image.jpg')); } catch (_) { _logoRaw = null; }
  return _logoRaw;
}
let _logoThumb;   // old small logo thumb — last-resort fallback if sharp fails
async function smallLogo() {
  if (_logoThumb !== undefined) return _logoThumb;
  _logoThumb = null;
  try {
    const raw = logoRaw();
    if (raw) _logoThumb = await require('sharp')(raw, { failOn: 'none' }).resize(96, 96, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
  } catch (_) {}
  return _logoThumb;
}
function httpGet(url, ms = 6000) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('http:') ? require('http') : require('https');
      const req = lib.get(url, { timeout: ms, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const c = []; let n = 0;
        res.on('data', (d) => { n += d.length; if (n > 4 * 1024 * 1024) { req.destroy(); return resolve(null); } c.push(d); });
        res.on('end', () => resolve(Buffer.concat(c))); res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch (_) { resolve(null); }
  });
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

/** raw DP image: tries every jid in the list (real number first, LID last), full size first then the small preview */
async function rawDp(sock, jids) {
  const list = [...new Set([].concat(jids).filter(Boolean))];
  for (const kind of ['image', 'preview']) {
    for (const jid of list) {
      try {
        const url = await withTimeout(sock.profilePictureUrl(jid, kind), 3000);
        if (!url) continue;
        const b = await httpGet(url);
        if (b && b.length > 300) return b;
      } catch (_) {}
    }
  }
  return null;
}

let _ownerDp = { at: 0, buf: null };
function ownerJid() {
  try { const n = digits([].concat(require('../config').ownerNumber || [])[0]); return n ? `${n}@s.whatsapp.net` : null; } catch (_) { return null; }
}
async function ownerDp(sock) {
  const ttl = _ownerDp.buf ? 6 * 3600 * 1000 : 10 * 60 * 1000;      // not found → retry every 10 min
  if (Date.now() - _ownerDp.at < ttl) return _ownerDp.buf;
  const j = ownerJid();
  const buf = j ? await rawDp(sock, j) : null;
  _ownerDp = { at: Date.now(), buf };
  return buf;
}

/** DP (any image buffer) → stylish 320x400 (4:5) JPEG card: themed gradient, glowing ring, VERY BIG round DP, badge, sparkles.
 *  WhatsApp shows this as the small thumbnail inside the quote (it never loads a bigger image there), so:
 *   • the DP fills ~86% of the width (biggest possible face in that tiny box)
 *   • 4:5 canvas = the same shape WhatsApp shows → nothing gets cropped at the sides
 *   • all important parts sit in the middle square, so a square thumbnail box (older WhatsApp) crops only decoration
 *   • high-quality JPEG (q90, auto-reduced only if it would exceed ~30 KB)
 *  No text inside (server fonts differ) — the name goes in the caption. */
// Card shape: 'square' (256-class, the size that is KNOWN to show on WhatsApp) or 'tall' (4:5, fits WhatsApp's tall quote box)
const SHAPES = { square: { W: 288, H: 288, R: 112 }, tall: { W: 320, H: 400, R: 138 } };
const CARD_W = 320, CARD_H = 400;   // (tall) kept for fallbacks
/** WhatsApp only shows an inline quote thumbnail up to ~20,000 bytes — bigger ones silently disappear.
 *  Take the lossless card (PNG buffer) and find the sharpest JPEG that stays ≤ THUMB_MAX bytes:
 *  first lower the quality, then (if still too big) shrink the size a little. Width/height are kept on the buffer. */
async function encodeCard(pngBuf, W, H, maxBytes) {
  const sharp = require('sharp');
  let last = null;
  for (const k of [1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58, 0.5]) {
    const w = Math.round(W * k), h = Math.round(H * k);
    const src = k === 1 ? sharp(pngBuf) : sharp(pngBuf).resize(w, h, { kernel: 'lanczos3' });
    for (const q of [88, 84, 80, 76, 72, 68, 64, 60, 55]) {
      const out = await src.clone().jpeg({ quality: q, mozjpeg: true }).toBuffer();   // 4:2:0 = smaller than 4:4:4
      last = { out, w, h };
      if (out.length <= maxBytes) { out.__w = w; out.__h = h; return out; }
    }
  }
  last.out.__w = last.w; last.out.__h = last.h;
  return last.out;
}


/** 'full' card: the DP fills the WHOLE card (biggest, clearest face possible in WhatsApp's tiny quote thumbnail),
 *  branding = thin themed frame + soft colour fade at the bottom + small badge. */
async function composeFull(dpBuf, T, G, maxBytes) {
  const sharp = require('sharp');
  const W = G.W, H = G.H;
  const photo = await sharp(dpBuf, { failOn: 'none' }).resize(W, H, { fit: 'cover', position: 'attention', kernel: 'lanczos3' }).sharpen({ sigma: 0.8 }).png().toBuffer();
  const mask  = Buffer.from(`<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="38" fill="#fff"/></svg>`);
  const round = await sharp(photo).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();

  const grad = (id, c) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset=".5" stop-color="${c[1]}"/><stop offset="1" stop-color="${c[2]}"/></linearGradient>`;
  const BADGES = {
    crown  : '<path d="M-11,7 L-9,-4 L-4,2 L0,-8 L4,2 L9,-4 L11,7 Z"/><rect x="-11" y="9" width="22" height="3" rx="1.5"/>',
    bolt   : '<path d="M2,-11 L-8,2 L-1,2 L-3,11 L8,-3 L1,-3 Z"/>',
    diamond: '<path d="M-10,-3 L-5,-9 L5,-9 L10,-3 L0,11 Z"/>',
    star   : '<path d="M0,-11 L3.2,-3.4 L11,-3 L5,2.4 L7,10 L0,5.8 L-7,10 L-5,2.4 L-11,-3 L-3.2,-3.4 Z"/>',
  };
  const bx = W - 42, by = H - 42;
  const over = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>${grad('ring', T.ring)}
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${T.bg[0]}" stop-opacity="0"/><stop offset="1" stop-color="${T.bg[2]}" stop-opacity=".78"/></linearGradient></defs>
    <rect x="0" y="${H - 130}" width="${W}" height="130" rx="38" fill="url(#fade)"/>
    <rect x="3.5" y="3.5" width="${W - 7}" height="${H - 7}" rx="35" fill="none" stroke="url(#ring)" stroke-width="7"/>
    <circle cx="${bx}" cy="${by}" r="27" fill="#0c0714" stroke="url(#ring)" stroke-width="4"/>
    <g transform="translate(${bx} ${by}) scale(1.15)" fill="url(#ring)">${BADGES[T.badge] || BADGES.crown}</g>
  </svg>`);
  return encodeCard(await sharp(round).composite([{ input: over }]).png().toBuffer(), W, H, maxBytes);
}

async function composeCard(dpBuf, theme = 'brand', mode = 'ring', zoom = 1.35, opts = {}) {
  const sharp = require('sharp');
  const T = THEMES[theme] || THEMES.brand;
  const G = SHAPES[opts.shape] || SHAPES.square;
  const maxBytes = Math.round((Number(opts.kb) > 0 ? Number(opts.kb) : 11) * 1000);
  if (mode !== 'ring') return composeFull(dpBuf, T, G, maxBytes);
  const W = G.W, H = G.H, R = G.R, CX = W / 2, CY = H / 2;
  // Same round style — but the photo is zoomed in (face fills the circle instead of a tiny face + lots of background).
  // Crop is centred on the busiest area, nudged upwards because faces sit in the upper half of profile photos.
  const D = R * 2, Z = Math.min(1.8, Math.max(1, Number(zoom) || 1));
  const big  = Math.round(D * Z);
  const zoomed = await sharp(dpBuf, { failOn: 'none' }).resize(big, big, { fit: 'cover', position: 'attention', kernel: 'lanczos3' }).png().toBuffer();
  const dp = await sharp(zoomed).extract({ left: Math.round((big - D) / 2), top: Math.round((big - D) * 0.36), width: D, height: D })
    .modulate({ brightness: 1.03, saturation: 1.08 }).sharpen({ sigma: 0.9 }).png().toBuffer();
  const circle = Buffer.from(`<svg width="${D}" height="${D}"><circle cx="${R}" cy="${R}" r="${R}" fill="#fff"/></svg>`);
  const dpRound = await sharp(dp).composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer();

  const grad = (id, c) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset=".5" stop-color="${c[1]}"/><stop offset="1" stop-color="${c[2]}"/></linearGradient>`;
  const base = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>${grad('bg', T.bg)}${grad('ring', T.ring)}
      <radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset=".6" stop-color="${T.glow}" stop-opacity=".65"/><stop offset="1" stop-color="${T.glow}" stop-opacity="0"/></radialGradient></defs>
    <rect width="${W}" height="${H}" rx="40" fill="url(#bg)"/>
    <circle cx="${CX}" cy="${CY}" r="${R + 42}" fill="url(#glow)"/>
    <circle cx="${CX}" cy="${CY}" r="${R + 8}" fill="none" stroke="url(#ring)" stroke-width="7"/>
    <rect x="5" y="5" width="${W - 10}" height="${H - 10}" rx="36" fill="none" stroke="url(#ring)" stroke-opacity=".85" stroke-width="3"/>
  </svg>`);

  const star = (x, y, k, o) => `<path transform="translate(${x} ${y}) scale(${k})" fill="${T.star}" fill-opacity="${o}" d="M0,-6 L1.6,-1.6 L6,0 L1.6,1.6 L0,6 L-1.6,1.6 L-6,0 L-1.6,-1.6 Z"/>`;
  const BADGES = {
    crown  : '<path d="M-11,7 L-9,-4 L-4,2 L0,-8 L4,2 L9,-4 L11,7 Z"/><rect x="-11" y="9" width="22" height="3" rx="1.5"/>',
    bolt   : '<path d="M2,-11 L-8,2 L-1,2 L-3,11 L8,-3 L1,-3 Z"/>',
    diamond: '<path d="M-10,-3 L-5,-9 L5,-9 L10,-3 L0,11 Z"/>',
    star   : '<path d="M0,-11 L3.2,-3.4 L11,-3 L5,2.4 L7,10 L0,5.8 L-7,10 L-5,2.4 L-11,-3 L-3.2,-3.4 Z"/>',
  };
  const bx = CX, by = CY + R + 4;          // badge sits on the bottom edge of the ring, centred (stays inside a square crop)
  const over = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>${grad('ring', T.ring)}</defs>
    ${star(W * 0.11, H * 0.095, 1.5, 0.95)}${star(W * 0.89, H * 0.11, 1.1, 0.8)}${star(W * 0.105, H * 0.91, 1.0, 0.7)}${star(W * 0.9, H * 0.9, 1.3, 0.9)}${star(W * 0.5, H * 0.06, 0.8, 0.75)}
    <circle cx="${bx}" cy="${by}" r="24" fill="#0c0714" stroke="url(#ring)" stroke-width="4"/>
    <g transform="translate(${bx} ${by}) scale(1.05)" fill="url(#ring)">${BADGES[T.badge] || BADGES.crown}</g>
  </svg>`);

  return encodeCard(await sharp(base).composite([{ input: dpRound, left: CX - R, top: CY - R }, { input: over }]).png().toBuffer(), W, H, maxBytes);
}

const _cardCache = new Map();   // theme|jid → { at, buf }
async function cardFor(sock, jid, theme = 'brand', altJid = null, mode = 'ring', zoom = 1.35, opts = {}) {
  const key = `${theme}|${mode}|${zoom}|${opts.shape}|${opts.kb}|${cleanJid(jid)}`, hit = _cardCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.buf;
  let dp = await rawDp(sock, [cleanJid(jid), altJid && cleanJid(altJid)]);
  if (!dp) dp = await ownerDp(sock);        // his DP is private / missing → OWNER's DP
  if (!dp) dp = logoRaw();                  // owner's DP also not visible → bot logo
  let buf = null;
  if (dp) { try { buf = await composeCard(dp, theme, mode, zoom, opts); } catch (e) { console.log('[replyStyle] card compose failed:', e.message); } }
  if (!buf) buf = await smallLogo();
  _cardCache.set(key, { at: Date.now(), buf });
  if (_cardCache.size > 300) _cardCache.delete(_cardCache.keys().next().value);
  return buf;
}

/** the sender's REAL phone jid straight from the message key (Baileys 7 gives it for @lid senders) — most reliable */
function pnFromKey(key) {
  const k = key || {};
  return [k.senderPn, k.participantPn, k.participantAlt, k.remoteJidAlt, k.participant, k.remoteJid]
    .find((x) => typeof x === 'string' && x.endsWith('@s.whatsapp.net')) || null;
}

// LID → real phone JID (a raw @lid made WhatsApp show a bogus "+84 0188…" number)
const _pn = new Map();
async function resolvePN(sock, jid) {
  const x = String(jid || '');
  if (!x.endsWith('@lid')) return x;
  const hit = _pn.get(x); if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.v || x;
  let pn = null;
  try { const r = require('./jidHelper').normalizeJidWithLid(x); if (r && !String(r).endsWith('@lid')) pn = r; } catch (_) {}
  if (!pn) {
    try {
      const m = sock && sock.signalRepository && sock.signalRepository.lidMapping;
      if (m && m.getPNForLID) { const r = await withTimeout(m.getPNForLID(x), 2000); if (r) pn = String(r).includes('@') ? r : `${r}@s.whatsapp.net`; }
    } catch (_) {}
  }
  _pn.set(x, { at: Date.now(), v: pn });
  return pn || x;
}

// Quote header line: 'bot' = the bot's own name (no phone number shown)  |  'user' = the person who ran the command
function getHeader(sock) { try { return db().getBotSetting(botIdOf(sock), 'replyHeader', 'bot') === 'user' ? 'user' : 'bot'; } catch (_) { return 'bot'; } }
function setHeader(sock, v) { try { db().setBotSetting(botIdOf(sock), 'replyHeader', v === 'user' ? 'user' : 'bot'); return true; } catch (_) { return false; } }

// Card look: 'ring' = round DP inside the glowing ring (DEFAULT, the original style)  |  'full' = photo fills the whole card (optional)
function getCardMode(sock) { try { return db().getBotSetting(botIdOf(sock), 'replyCardMode', 'ring') === 'full' ? 'full' : 'ring'; } catch (_) { return 'ring'; } }
function setCardMode(sock, v) { try { db().setBotSetting(botIdOf(sock), 'replyCardMode', v === 'full' ? 'full' : 'ring'); return true; } catch (_) { return false; } }

// How much the DP is zoomed inside the round card (1 = whole photo, 1.35 = default, up to 1.8 = very close-up on the face)
function getZoom(sock) { try { const v = Number(db().getBotSetting(botIdOf(sock), 'replyZoom', 1.35)); return v >= 1 && v <= 1.8 ? v : 1.35; } catch (_) { return 1.35; } }
function setZoom(sock, v) { try { db().setBotSetting(botIdOf(sock), 'replyZoom', Math.min(1.8, Math.max(1, Number(v) || 1.35))); return true; } catch (_) { return false; } }

// Thumbnail size limit in KB (WhatsApp silently drops / blanks thumbnails that are too big for ITS quote box) + shape.
// Defaults = the size/shape that was proven to show up. Raise step by step to find your phone's maximum.
function getThumbKB(sock) { try { const v = Number(db().getBotSetting(botIdOf(sock), 'replyThumbKB', 11)); return v >= 5 && v <= 20 ? v : 11; } catch (_) { return 11; } }
function setThumbKB(sock, v) { try { db().setBotSetting(botIdOf(sock), 'replyThumbKB', Math.min(20, Math.max(5, Number(v) || 11))); return true; } catch (_) { return false; } }
function getShape(sock) { try { return db().getBotSetting(botIdOf(sock), 'replyThumbShape', 'square') === 'tall' ? 'tall' : 'square'; } catch (_) { return 'square'; } }
function setShape(sock, v) { try { db().setBotSetting(botIdOf(sock), 'replyThumbShape', v === 'tall' ? 'tall' : 'square'); return true; } catch (_) { return false; } }

const _cache = new Map();   // botId → { at, v }  (the setting is read on every reply — keep it cheap)
function getStyle(sock) {
  try {
    const id = botIdOf(sock), hit = _cache.get(id);
    if (hit && Date.now() - hit.at < 3000) return hit.v;
    const v0 = db().getBotSetting(id, 'replyStyle', 'off'), v = STYLES.includes(v0) ? v0 : 'off';
    _cache.set(id, { at: Date.now(), v }); return v;
  } catch (_) { return 'off'; }
}
function setStyle(sock, style) { try { db().setBotSetting(botIdOf(sock), 'replyStyle', style); _cache.delete(botIdOf(sock)); return true; } catch (_) { return false; } }

const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
/** user@server without the device part. A @lid sender stays @lid (turning LID digits into "@s.whatsapp.net" gave a bogus +84 0188… number);
 *  if the LID is known, the real phone JID is used. */
function cleanJid(j) {
  let x = String(j || '');
  try { const r = require('./jidHelper').normalizeJidWithLid(x); if (r) x = r; } catch (_) {}
  const [user, server] = x.split('@'); const u = String(user || '').split(':')[0];
  return u ? `${u}@${server || 's.whatsapp.net'}` : x;
}

/** the message object WhatsApp will show as the quoted preview */
function fakeMessage(style, senderJid, name, botName, extra) {
  const jid = cleanJid(senderJid);
  const num = digits(jid);
  if (THEMES[style]) {   // a quoted PICTURE: the themed DP card as the thumbnail + the bot's name / label as the caption
    const m = { mimetype: 'image/jpeg', caption: (extra && extra.label) || DEFAULT_LABEL };
    if (extra && extra.thumb) { m.jpegThumbnail = extra.thumb; m.width = extra.thumb.__w || CARD_W; m.height = extra.thumb.__h || CARD_H; }
    return { imageMessage: m };
  }
  switch (style) {
    case 'circle':   // payment request "from" the user → WhatsApp draws the user's DP in a circle with a check badge
      return { requestPaymentMessage: {
        currencyCodeIso4217: 'INR', amount1000: 1000, requestFrom: jid, expiryTimestamp: 0,
        amount: { value: 1000, offset: 1000, currencyCode: 'INR' },
        noteMessage: { extendedTextMessage: { text: LABEL } } } };
    case 'payment':
      return { sendPaymentMessage: { noteMessage: { extendedTextMessage: { text: LABEL } } } };
    case 'contact':  // contact card — avatar comes from the waid
      return { contactMessage: { displayName: name || botName || 'Mr.Muneeb Ali',
        vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${name || botName || 'Mr.Muneeb Ali'}\nTEL;type=CELL;type=VOICE;waid=${num}:+${num}\nEND:VCARD` } };
    case 'order':
      return { orderMessage: { itemCount: 1, status: 1, surface: 1, message: LABEL, orderTitle: botName || 'Mr.Muneeb Ali Bot', sellerJid: jid } };
    default: return null;
  }
}

/**
 * WhatsApp draws the preview from ITS OWN copy of the quoted message when the id exists in the chat — then our card is ignored
 * and the user's real text shows. So the card must carry a NEW id (one WhatsApp has never seen); only then the payload is shown.
 */
function fakeKey(key, senderJid) {
  return {
    remoteJid: key?.remoteJid, fromMe: false,
    id: 'FAKE' + require('crypto').randomBytes(8).toString('hex').toUpperCase(),
    participant: cleanJid(senderJid || key?.participant || key?.remoteJid),
  };
}

/** the `quoted` option for sock.sendMessage — the original message when the style is off */
function quoteFor(sock, msg, sender, botName) {
  try {
    if (sock && sock.__rsInstalled) return msg;   // the hook below styles every quoted reply (async: LID→number, DP card)
    const style = getStyle(sock);
    if (style === 'off' || THEMES[style]) return msg;
    const fake = fakeMessage(style, sender || msg?.key?.participant || msg?.key?.remoteJid, msg?.pushName, botName);
    if (!fake) return msg;
    return { key: fakeKey(msg.key, sender), message: fake, pushName: msg.pushName, __rsFake: true };
  } catch (_) { return msg; }
}

/**
 * Hook sock.sendMessage ONCE: every reply that quotes a message (ping, menu, stickers, errors … not only extra.reply)
 * gets the styled preview. react / delete / forward / edit are left alone.
 */
function install(sock, botName) {
  if (!sock || sock.__rsInstalled || typeof sock.sendMessage !== 'function') return;
  sock.__rsInstalled = true;
  const orig = sock.sendMessage.bind(sock);
  sock.sendMessage = async function (jid, content, opts) {
    try {
      const q = opts && opts.quoted;
      if (q && !q.__rsFake && q.key && q.message && content && !content.react && !content.delete && !content.forward && !content.edit) {
        const style = getStyle(sock);
        if (style !== 'off') {
          const rawWho = q.key.participant || q.key.remoteJid;
          const who    = pnFromKey(q.key) || await resolvePN(sock, rawWho);      // real number if we can find it
          const card   = !!THEMES[style];
          const botJid = `${digits(sock.user && sock.user.id)}@s.whatsapp.net`;
          const head   = card && getHeader(sock) === 'bot' ? botJid : who;       // header: bot's name instead of a phone number
          const extra  = card ? { thumb: await cardFor(sock, who, style, rawWho, getCardMode(sock), getZoom(sock), { kb: getThumbKB(sock), shape: getShape(sock) }), label: getLabel(sock, botName) } : null;
          const fake   = fakeMessage(style, who, q.pushName, botName, extra);
          if (fake) opts = Object.assign({}, opts, { quoted: { key: fakeKey(q.key, head), message: fake, pushName: q.pushName, __rsFake: true } });
        }
      }
    } catch (_) {}
    return orig(jid, content, opts);
  };
}

module.exports = { install, getLabel, setLabel, STYLES, THEMES, getStyle, setStyle, getHeader, setHeader, getCardMode, setCardMode, getZoom, setZoom, getThumbKB, setThumbKB, getShape, setShape, fakeMessage, quoteFor, composeCard, cardFor, resolvePN, pnFromKey };
