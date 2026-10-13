'use strict';
/**
 * antiUserbot — removes real BOT accounts only. A normal person must never be hit.
 *
 * Removed instantly ONLY on strong evidence a human cannot produce:
 *   1. an interactive / buttons / list / template message (WhatsApp users can't send these;
 *      bots relay them). Button *responses* are normal and ignored.
 *   2. a known bot signature ("Powered by Xeon bot", "Baileys-MD" …) in a message that is
 *      NOT forwarded (a forwarded menu is a person sharing, not a bot)
 *   3. inhuman flood: 12+ messages inside 6 seconds, or the same text 6× in 20 s
 *
 * Never touched: admins, owners, the bot itself and the other accounts of this panel.
 * What was removed from the old version (it kicked normal people): 2 identical messages,
 * 5 messages in 5 s, forwarded-many-times memes, "!"/"/" prefixes, separator lines,
 * "md pro", bot-like display names, odd JIDs.
 */
const fs = require('fs');
const path = require('path');

const ALERT_VIDEO = path.join(__dirname, '..', 'data', 'antiuserbot-alert.mp4');

const BOT_SIGNATURES = [
  /powered\s+by\s+xeon/i, /xeon\s*bot/i, /cheems[\s\-_]*bot/i, /ᴄʜᴇᴇᴍs/i,
  /mr[\.\s\-]*perfect\s*bot/i, /zaira[\s\-_]*(bot|md)/i, /whatsapp\s*bot\s*md/i,
  /wamellow/i, /\b(miki|pika|kitsune|rika|naze|ryo|suki)\s*bot\b/i,
  /baileys[\s\-]*bot/i, /baileys[\s\-]*md/i, /©\s*\w+\s*bot\b/i,
  /\bprimebotmd\b/i, /\bwhatsapp\s*md\b/i, /\bstarkbot\b/i, /\baxibot\b/i,
  /\bneonbot\b/i, /\bcyberbot\b/i, /\bnexusbot\b/i, /\bstealthbot\b/i,
  /this\s+(is\s+an?\s+)?(automated|auto)\s+(reply|message|response)/i,
  /sent\s+via\s+\w+\s*bot/i, /bot\s*made\s*by/i,
  /^(auto[\s\-_]?reply|autoresponder|bot\s*reply)[:：]/i,
];

const BOT_ONLY_TYPES = ['buttonsMessage', 'templateMessage', 'listMessage', 'interactiveMessage', 'highlyStructuredMessage'];
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'deviceSentMessage'];

const FLOOD_N = 12, FLOOD_MS = 6000;
const REPEAT_N = 6, REPEAT_MS = 20000;
const _rate = new Map();   // `${group}:${sender}` → { ts:[], texts:[{t,at}] }

const digits = (v) => String(v || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

function unwrap(message) {
  let m = message;
  for (let i = 0; m && i < 5; i++) {
    const w = WRAPPERS.find(k => m[k]?.message);
    if (!w) break;
    m = m[w].message;
  }
  return m || {};
}

function textOf(m) {
  return [m.conversation, m.extendedTextMessage?.text, m.imageMessage?.caption, m.videoMessage?.caption, m.documentMessage?.caption]
    .filter(Boolean).join(' ').trim();
}

function isForwarded(m) {
  for (const k of Object.keys(m)) {
    const ci = m[k]?.contextInfo;
    if (ci && (ci.isForwarded || (ci.forwardingScore || 0) > 0)) return true;
  }
  return false;
}

function ownBotAccounts() {
  const out = new Set();
  try {
    const sm = require('../Panel/sessionManager');
    for (const s of sm.sessions.values()) for (const v of [s?.sock?.user?.id, s?.sock?.user?.lid]) { const d = digits(v); if (d) out.add(d); }
  } catch (_) {}
  return out;
}

/** → reason string when this message is clearly from a bot, else null */
function verdict(msg, key) {
  const m = unwrap(msg.message);
  const fwd = isForwarded(m);

  if (!fwd) {
    const t = Object.keys(m).find(k => BOT_ONLY_TYPES.includes(k));
    if (t) return `Sent a bot-only message (${t})`;
  }
  const text = textOf(m);
  if (text && !fwd && BOT_SIGNATURES.some(r => r.test(text))) return 'Bot signature in message';

  const now = Date.now();
  const r = _rate.get(key) || { ts: [], texts: [] };
  r.ts = r.ts.filter(t => now - t < FLOOD_MS); r.ts.push(now);
  if (r.ts.length >= FLOOD_N) { _rate.delete(key); return `Inhuman message flood (${FLOOD_N}+ in ${FLOOD_MS / 1000}s)`; }
  if (text.length >= 4) {
    r.texts = r.texts.filter(x => now - x.at < REPEAT_MS); r.texts.push({ t: text, at: now });
    if (r.texts.filter(x => x.t === text).length >= REPEAT_N) { _rate.delete(key); return `Same message repeated ${REPEAT_N}× (spam bot)`; }
  }
  _rate.set(key, r);
  if (_rate.size > 2000) for (const [k, v] of _rate) if (!v.ts.length || now - v.ts[v.ts.length - 1] > 60_000) _rate.delete(k);
  return null;
}

/**
 * @returns {Promise<boolean>} true when the sender was removed (caller should stop processing)
 */
async function inspect(sock, msg, ctx) {
  const { from, sender, senderIsAdmin, senderIsOwner, botIsAdmin } = ctx;
  if (!msg.message || msg.key.fromMe) return false;
  if (senderIsAdmin || senderIsOwner) return false;
  const ids = [digits(sender), digits(msg.key.participant), digits(msg.key.participantPn), digits(msg.key.senderPn)].filter(Boolean);
  const own = ownBotAccounts();
  if (ids.some(i => own.has(i))) return false;

  const reason = verdict(msg, `${from}:${ids[0]}`);
  if (!reason) return false;

  console.log(`[AntiUserbot] ${ids[0]} in ${from.split('@')[0]} → ${reason} (botAdmin=${!!botIsAdmin})`);
  if (!botIsAdmin) return false;   // cannot act without admin rights

  try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
  let removed = false;
  try { await sock.groupParticipantsUpdate(from, [msg.key.participant || sender], 'remove'); removed = true; } catch (e) { console.log('[AntiUserbot] remove failed:', e.message); }
  if (!removed) return true;

  const text =
    `*[ 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 ]*\n\n🚫 *Bot Removed!*\n\n👤 @${digits(sender)}\n📋 Reason: ${reason}\n\n🛡️ _Anti-UserBot is active_`;
  try {
    if (fs.existsSync(ALERT_VIDEO)) await sock.sendMessage(from, { video: fs.readFileSync(ALERT_VIDEO), mimetype: 'video/mp4', caption: text, mentions: [sender] });
    else await sock.sendMessage(from, { text, mentions: [sender] });
  } catch (_) {}
  return true;
}

module.exports = { inspect, verdict, BOT_SIGNATURES };
