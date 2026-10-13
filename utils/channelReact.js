'use strict';

/**
 * Per-bot, per-WhatsApp-Channel auto-reaction settings.
 *
 * A WhatsApp account can add only one reaction to one channel post. The
 * command intentionally stores one emoji per channel; it does not attempt
 * bulk/multi-account reactions.
 */

const db = require('../database');

const DEFAULT_EMOJI = '❤️';
// used when the owner gives no emoji (or says "mix"): every bot picks a different one
const DEFAULT_MIX = ['❤️', '🔥', '😍', '👏', '😂', '😮', '🙏', '👍', '🤩', '💯', '😎', '🥰', '✨', '💖', '🫶', '🎉'];

/** "❤️🔥😍" or ["❤️","🔥"] → ['❤️','🔥','😍'] (only real emoji, max 12, no duplicates) */
function parseEmojis(input) {
  const text = Array.isArray(input) ? input.join('') : String(input || '');
  let parts;
  try { parts = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map(x => x.segment); }
  catch (_) { parts = Array.from(text); }
  const out = [];
  for (const g of parts) if (/\p{Extended_Pictographic}/u.test(g) && !out.includes(g)) out.push(g);
  return out.slice(0, 12);
}
/**
 * Every bot of the panel runs in this one process, so they can share a counter per post:
 * bot #1 gets the first emoji of a shuffled pool, bot #2 the second … (no repeats until the pool is used up).
 */
const _postCounter = new Map();   // postKey → how many bots already picked
function pickEmoji(cfg, postKey) {
  const pool = Array.isArray(cfg?.emojis) && cfg.emojis.length ? cfg.emojis : (cfg?.emoji ? [cfg.emoji] : [DEFAULT_EMOJI]);
  if (!postKey) return pool[Math.floor(Math.random() * pool.length)];
  const n = _postCounter.get(postKey) || 0;
  _postCounter.set(postKey, n + 1);
  if (_postCounter.size > 500) for (const k of [..._postCounter.keys()].slice(0, 200)) _postCounter.delete(k);
  // shuffle the pool the same way for everyone on this post (seeded by the post key)
  let h = 2166136261; for (const ch of String(postKey)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i--) { h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; const j = h % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr[n % arr.length];
}
const MAX_CHANNELS = 100;

function normalizeJid(jid) {
  const value = String(jid || '').trim();
  return /^\d+@newsletter$/.test(value) ? value : '';
}

function load(botId) {
  const value = botId ? db.getBotSetting(botId, 'channelAutoReact', {}) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function get(botId, jid) {
  const key = normalizeJid(jid);
  if (!key) return null;
  const cfg = load(botId)[key];
  if (!cfg || cfg.enabled !== true) return null;
  return {
    enabled: true,
    emoji: typeof cfg.emoji === 'string' && cfg.emoji.trim()
      ? cfg.emoji.trim()
      : DEFAULT_EMOJI,
    name: cfg.name || key,
  };
}

function set(botId, jid, updates) {
  const key = normalizeJid(jid);
  if (!botId || !key) throw new Error('Invalid bot or channel JID');

  const all = load(botId);
  all[key] = {
    ...(all[key] || {}),
    ...updates,
    jid: key,
    updatedAt: new Date().toISOString(),
  };

  const keys = Object.keys(all);
  if (keys.length > MAX_CHANNELS) {
    delete all[keys[0]];
  }
  db.setBotSetting(botId, 'channelAutoReact', all);
  return all[key];
}

function remove(botId, jid) {
  const key = normalizeJid(jid);
  if (!botId || !key) return;
  const all = load(botId);
  delete all[key];
  db.setBotSetting(botId, 'channelAutoReact', all);
}

function list(botId) {
  return Object.values(load(botId))
    .filter(cfg => cfg && cfg.enabled === true && /^\d+@newsletter$/.test(cfg.jid))
    .map(cfg => ({ ...cfg }));
}

// ═══════════════════════════════════════════════════════════════════════════
//  GLOBAL channels (set by the main developer): every bot of the panel follows
//  the channel and reacts to each new post with its OWN account, one reaction
//  per post. A member can opt out for their own bot: `.channelreact optout`.
// ═══════════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');
const GLOBAL_FILE = path.join(__dirname, '..', 'data', 'channelReactGlobal.json');

function readGlobal() { try { return JSON.parse(fs.readFileSync(GLOBAL_FILE, 'utf8')) || {}; } catch (_) { return {}; } }
function writeGlobal(o) { try { fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true }); fs.writeFileSync(GLOBAL_FILE, JSON.stringify(o, null, 2)); } catch (_) {} }

function globalList() { return Object.values(readGlobal()).filter(c => c && c.enabled && normalizeJid(c.jid)); }
function globalSet(jid, cfg) {
  const key = normalizeJid(jid); if (!key) throw new Error('Invalid channel JID');
  const all = readGlobal(); all[key] = { ...(all[key] || {}), ...cfg, jid: key, enabled: true, updatedAt: new Date().toISOString() }; writeGlobal(all);
  return all[key];
}
function globalRemove(jid) { const key = normalizeJid(jid); const all = readGlobal(); if (all[key]) { delete all[key]; writeGlobal(all); return true; } return false; }

const isOptedOut  = (botId) => !!(botId && db.getBotSetting(botId, 'channelReactOptOut', false));
const setOptOut   = (botId, v) => db.setBotSetting(botId, 'channelReactOptOut', !!v);

/** every channel this bot should react in: its own + the panel-wide ones (unless opted out) */
function effectiveList(botId) {
  const out = new Map();
  if (!isOptedOut(botId)) for (const g of globalList()) out.set(g.jid, { jid: g.jid, emoji: g.emoji || DEFAULT_EMOJI, emojis: g.emojis, name: g.name || g.jid, scope: 'global' });
  for (const c of list(botId)) out.set(c.jid, { jid: c.jid, emoji: c.emoji || DEFAULT_EMOJI, emojis: c.emojis, name: c.name || c.jid, scope: 'own' });
  return [...out.values()];
}
function effective(botId, jid) {
  const key = normalizeJid(jid); if (!key) return null;
  return effectiveList(botId).find(c => c.jid === key) || null;
}

// ── reacting ─────────────────────────────────────────────────────────────────
const _seen = new Map();   // `${botNum}:${jid}:${serverId}` → ts
const botNum = (sock) => String(sock?.user?.id || '').split(':')[0].split('@')[0];

function serverIdOf(msg) {
  const v = msg?.key?.server_id ?? msg?.key?.serverId ?? msg?.server_id ?? msg?.newsletter_server_id ?? msg?.serverId;
  return v == null ? null : String(v);
}

async function reactTo(sock, jid, serverId, emoji, msg) {
  // WhatsApp Channels are reacted to through the newsletter API (needs the post's server id);
  // a normal sendMessage({react}) is ignored for channels.
  if (serverId && typeof sock.newsletterReactMessage === 'function') {
    await sock.newsletterReactMessage(jid, String(serverId), emoji);
    return 'newsletterReactMessage';
  }
  if (msg?.key) { await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }); return 'sendMessage'; }
  throw new Error('no server id for this post');
}

/** called for every incoming channel post (live path) */
function handlePost(sock, msg) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid?.endsWith('@newsletter') || msg.key.fromMe) return;
    const cfg = effective(sock.user?.id, jid);
    if (!cfg) return;
    const sid = serverIdOf(msg);
    const k = `${botNum(sock)}:${jid}:${sid || msg.key.id}`;
    if (_seen.has(k)) return;
    _seen.set(k, Date.now());
    if (_seen.size > 3000) { const cut = Date.now() - 3600_000; for (const [kk, t] of _seen) if (t < cut) _seen.delete(kk); }
    // small random delay so 10 accounts do not hit the same millisecond
    setTimeout(() => {
      const em = pickEmoji(cfg, `${jid}:${sid || msg.key.id}`);
      reactTo(sock, jid, sid, em, msg)
        .then(how => console.log(`[channelreact] ${botNum(sock)} ${em} → ${cfg.name} (${how})`))
        .catch(e => { _seen.delete(k); console.warn(`[channelreact] ${botNum(sock)} failed on ${cfg.name}: ${e.message}`); });
    }, 1500 + Math.floor(Math.random() * 6000));
  } catch (e) { console.warn('[channelreact] handlePost:', e.message); }
}

// ── follow + catch-up polling (works even if live channel posts are not pushed) ─────────
const _synced = new WeakSet();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const POLL_MS = 120_000;

function startSync(sock) {
  if (!sock || _synced.has(sock)) return;
  _synced.add(sock);
  const followed = new Set();
  const baseline = new Map();   // jid → highest server id already seen
  let stopped = false, timer = null;

  const items = (res) => Array.isArray(res) ? res : (res?.messages || res?.data || []);
  const sidOf = (it) => it?.server_id ?? it?.serverId ?? it?.id ?? null;

  async function tick(first) {
    if (stopped) return;
    const botId = sock.user?.id;
    for (const ch of effectiveList(botId)) {
      try {
        if (!followed.has(ch.jid)) {
          followed.add(ch.jid);
          try { await sock.newsletterFollow?.(ch.jid); } catch (_) { /* already following / not allowed */ }
          try { await sock.subscribeNewsletterUpdates?.(ch.jid); } catch (_) {}
          await sleep(1000 + Math.random() * 3000);
        }
        if (typeof sock.newsletterFetchMessages !== 'function') continue;
        let res; 
        try { res = await sock.newsletterFetchMessages(ch.jid, 5); } catch (_) { res = null; }
        let arr = items(res);
        if (!arr.length) { try { arr = items(await sock.newsletterFetchMessages('jid', ch.jid, 5)); } catch (_) {} }
        if (!arr.length) continue;
        const ids = arr.map(sidOf).filter(v => v != null).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        if (!ids.length) continue;
        const top = ids[ids.length - 1];
        if (!baseline.has(ch.jid)) { baseline.set(ch.jid, top); continue; }   // first look: remember, never react to old posts
        const base = baseline.get(ch.jid);
        for (const id of ids.filter(i => i > base)) {
          const k = `${botNum(sock)}:${ch.jid}:${id}`;
          if (_seen.has(k)) continue;
          _seen.set(k, Date.now());
          await sleep(1500 + Math.random() * 4000);
          try { const em = pickEmoji(ch, `${ch.jid}:${id}`); const how = await reactTo(sock, ch.jid, id, em); console.log(`[channelreact] ${botNum(sock)} ${em} → ${ch.name} (poll/${how})`); }
          catch (e) { _seen.delete(k); console.warn(`[channelreact] ${botNum(sock)} poll react failed: ${e.message}`); }
        }
        baseline.set(ch.jid, Math.max(base, top));
      } catch (e) { console.warn('[channelreact] sync:', e.message); }
    }
  }

  try { sock.ev.on('connection.update', (u) => { if (u?.connection === 'close') { stopped = true; if (timer) clearInterval(timer); } }); } catch (_) {}
  // first pass after the session has settled, then regularly (random offset per bot)
  setTimeout(() => { tick(true); timer = setInterval(() => tick(false), POLL_MS); }, 15_000 + Math.floor(Math.random() * 45_000));
}

module.exports = {
  DEFAULT_EMOJI, DEFAULT_MIX, parseEmojis, pickEmoji,
  normalizeJid,
  load,
  get,
  set,
  remove,
  list,
  globalList, globalSet, globalRemove,
  isOptedOut, setOptOut,
  effectiveList, effective,
  handlePost, startSync, reactTo, serverIdOf,
};