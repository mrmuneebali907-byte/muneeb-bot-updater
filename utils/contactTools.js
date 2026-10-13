'use strict';
/**
 * utils/contactTools.js — save / block / report helpers for the panel bots (Baileys v7, LID aware).
 *  - nameBook   : remembers the WhatsApp profile name (pushName) of everybody this bot sees
 *  - resolve()  : message → { pn, lid, name, msgId, groupJid }
 *  - saveContact(), blockUser(), reportUser(), autoSaveDM()
 * Everything is per bot (keyed by the bot's own number).
 */
const fs = require('fs');
const path = require('path');
const database = require('../database');

const botIdOf = (sock) => String(sock?.user?.id || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || 'default';
const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
const isLid = (j) => /@lid$/.test(String(j || ''));
const isPn  = (j) => /@s\.whatsapp\.net$/.test(String(j || ''));
const norm  = (j) => { const s = String(j || ''); return s.includes('@') ? s.replace(/:\d+@/, '@') : s; };

// every network step gets a hard timeout so nothing can hang a command (or the bot)
const T = (p, ms, label = 'timeout') => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(label)), ms);
  Promise.resolve(p).then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
});

// ── name book + "already in phone book" tracker (per bot, in memory) ─────────────────────────────
const names = new Map();     // `${bot}|${digits}` → pushName
const known = new Set();     // `${bot}|${digits}` → already a saved contact (has an address-book name)
const attached = new WeakSet();
const cap = (m, n) => { if (m.size > n) m.delete(m.keys().next().value); };

function attach(sock) {
  if (!sock?.ev || attached.has(sock)) return;
  attached.add(sock);
  const bot = botIdOf(sock);
  const onC = (list) => {
    for (const c of list || []) {
      const ids = [c.id, c.lid, c.phoneNumber].filter(Boolean).map(digits).filter(Boolean);
      for (const d of ids) {
        if (c.notify) { names.set(`${bot}|${d}`, c.notify); cap(names, 20000); }
        if (c.name)   { known.add(`${bot}|${d}`); }
      }
    }
  };
  sock.ev.on('contacts.upsert', onC);
  sock.ev.on('contacts.update', onC);
}

function noteMsg(sock, msg) {
  try {
    if (!msg?.pushName || msg.key?.fromMe) return;
    const bot = botIdOf(sock);
    const who = msg.key.participant || msg.key.remoteJid;
    for (const j of [who, msg.key.participantAlt, msg.key.remoteJidAlt]) {
      const d = digits(j); if (d) names.set(`${bot}|${d}`, msg.pushName);
    }
    cap(names, 20000);
  } catch (_) {}
}
const nameOf = (sock, jid) => names.get(`${botIdOf(sock)}|${digits(jid)}`) || null;

// ── persistent "auto-saved" list (so a number is saved only once) ────────────────────────────────
const FILE = path.join(__dirname, '..', 'data', 'savedContacts.json');
let _saved = null;
const loadSaved = () => { if (!_saved) { try { _saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { _saved = {}; } } return _saved; };
const persist = () => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(_saved || {})); } catch (_) {} };
const wasSaved = (bot, d) => !!loadSaved()[bot]?.[d];
const markSaved = (bot, d, name) => { const s = loadSaved(); (s[bot] ||= {})[d] = name; persist(); };

// ── LID <-> PN resolution ───────────────────────────────────────────────────────────────────────
async function pair(sock, jid, altJid) {
  let pn = null, lid = null;
  for (const j of [jid, altJid]) { if (isPn(j)) pn = pn || norm(j); else if (isLid(j)) lid = lid || norm(j); }
  const lm = sock?.signalRepository?.lidMapping;
  try { if (lid && !pn && lm?.getPNForLID) pn = await T(lm.getPNForLID(lid), 6000); } catch (_) {}
  try { if (pn && !lid && lm?.getLIDForPN) lid = await T(lm.getLIDForPN(pn), 8000); } catch (_) {}
  if (pn) pn = norm(pn); if (lid) lid = norm(lid);
  // make sure Baileys knows the pair (updateBlockStatus needs BOTH)
  try { if (pn && lid && lm?.storeLIDPNMappings) await lm.storeLIDPNMappings([{ lid, pn }]); } catch (_) {}
  return { pn, lid };
}

/** Who does this command point at?  reply → that person · mention → first mention · DM → the chat · else args number */
async function resolve(sock, msg, args = []) {
  const from = msg.key.remoteJid;
  const isGroup = String(from).endsWith('@g.us');
  const m = msg.message?.ephemeralMessage?.message || msg.message || {};
  const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo || null;
  let jid = null, alt = null, msgId = null;
  if (ctx?.quotedMessage && ctx.participant) { jid = ctx.participant; msgId = ctx.stanzaId; }
  else if (ctx?.mentionedJid?.length) jid = ctx.mentionedJid[0];
  else {
    const d = (args || []).join('').replace(/[^0-9]/g, '');
    if (d.length >= 8 && !/[a-z]/i.test((args || []).join(''))) jid = `${d}@s.whatsapp.net`;
    else if (!isGroup) { jid = from; alt = msg.key.remoteJidAlt; if (ctx?.stanzaId && ctx.quotedMessage) msgId = ctx.stanzaId; }
  }
  if (!jid) return null;
  const { pn, lid } = await pair(sock, jid, alt);
  return { jid, pn, lid, msgId, isGroup, groupJid: isGroup ? from : null, name: nameOf(sock, jid) || nameOf(sock, pn) || nameOf(sock, lid), digits: digits(pn || jid) };
}

const isProtected = (sock, t, config) => {
  const me = botIdOf(sock);
  const owners = [].concat(config?.ownerNumber || []).map(digits);
  return [t.digits, digits(t.pn), digits(t.lid)].some(d => d && (d === me || owners.includes(d)));
};

// ── actions ─────────────────────────────────────────────────────────────────────────────────────
async function saveContact(sock, t, name) {
  const jid = t.pn || t.jid;
  const full = String(name || t.name || '').trim() || `+${t.digits}`;
  const body = { fullName: full, firstName: full.split(/\s+/)[0], saveOnPrimaryAddressbook: false };
  if (t.lid) body.lidJid = t.lid;
  if (t.pn)  body.pnJid  = t.pn;
  await T(sock.addOrEditContact(jid, body), 20000, 'save timeout');
  markSaved(botIdOf(sock), t.digits, full);
  return full;
}

/** ask the server for the LID of a phone number (needed by the new block API) */
async function lookupLid(sock, pn) {
  try {
    const bz = require('@whiskeysockets/baileys');
    if (bz.USyncQuery && bz.USyncUser && sock.executeUSyncQuery) {
      const q = new bz.USyncQuery().withContactProtocol();
      if (q.withLIDProtocol) q.withLIDProtocol();
      q.withUser(new bz.USyncUser().withPhone('+' + digits(pn)));
      const r = await T(sock.executeUSyncQuery(q), 10000);
      const it = r?.list?.[0];
      const lid = it?.lid || it?.id && isLid(it.id) && it.id;
      if (lid) return norm(lid);
    }
  } catch (_) {}
  try {
    const r = await T(sock.onWhatsApp(digits(pn)), 8000);
    if (r?.[0]?.lid) return norm(r[0].lid);
  } catch (_) {}
  return null;
}

/**
 * Block via the blocklist IQ. WhatsApp's new API wants  <item action="block" jid="LID" pn_jid="PN"/>
 * (old Baileys sent only the PN → "bad-request"), so we resolve BOTH and send the IQ ourselves.
 */
async function blockUser(sock, t) {
  let { pn, lid } = t;
  if (pn && !lid) { lid = await lookupLid(sock, pn); t.lid = lid || t.lid; }
  const tries = [];
  if (lid && pn) tries.push({ action: 'block', jid: lid, pn_jid: pn });
  if (pn) tries.push({ action: 'block', jid: pn });
  if (lid && !pn) tries.push({ action: 'block', jid: lid });
  if (!tries.length) throw new Error('number resolve nahi hua');
  let last = null;
  for (const attrs of tries) {
    try {
      await sock.query({ tag: 'iq', attrs: { xmlns: 'blocklist', to: 's.whatsapp.net', type: 'set' }, content: [{ tag: 'item', attrs }] }, 15000);
      return true;
    } catch (e) { last = e; }
  }
  throw new Error(`${last?.message || last}${lid ? '' : ' (LID nahi mili)'}`);
}

/** WhatsApp has no public "report" call in Baileys → raw `spam` IQ. Tries a few node layouts, remembers the one that works. */
let _reportShape = 0;
async function reportUser(sock, t) {
  const now = String(Math.floor(Date.now() / 1000));
  const who = t.jid;
  const shapes = [
    () => t.msgId
      ? { spam_flow: 'MessageMenu', jid: t.groupJid || who, kids: [{ tag: 'message', attrs: { id: t.msgId, t: now, from: who, type: 'text', ...(t.groupJid ? { participant: who } : {}) } }] }
      : { spam_flow: 'ContactInfo', jid: t.lid || who },
    () => ({ spam_flow: 'ContactInfo', jid: t.lid || who }),
    () => ({ spam_flow: 'ContactInfo', jid: t.pn || who }),
  ];
  let last = null;
  for (let k = 0; k < shapes.length; k++) {
    const idx = (_reportShape + k) % shapes.length;
    const sh = shapes[idx]();
    try {
      await sock.query({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'spam' },
        content: [{ tag: 'spam_list', attrs: { spam_flow: sh.spam_flow, jid: sh.jid }, content: sh.kids }] }, 15000);
      _reportShape = idx;
      return true;
    } catch (e) { last = e; }
  }
  throw last || new Error('report failed');
}

/** N reports — first now, then one per minute (background). Stops early if WhatsApp rejects the very first ones. */
const _active = new Set();   // `${bot}|${digits}` — one running campaign per target (no parallel duplicates)
const campaignActive = (sock, t) => _active.has(`${botIdOf(sock)}|${t.digits}`);
const reserve = (sock, t) => { const k = `${botIdOf(sock)}|${t.digits}`; if (_active.has(k)) return false; _active.add(k); return true; };
function reportCampaign(sock, t, { times = 10, everyMs = 60000, onDone, reserved = false } = {}) {
  const ak = `${botIdOf(sock)}|${t.digits}`;
  if (!reserved) { if (_active.has(ak)) return null; _active.add(ak); }
  const finish = (st) => { _active.delete(ak); if (onDone) { try { onDone(st); } catch (_) {} } };
  const stat = { ok: 0, fail: 0, lastErr: '', times };
  let i = 0;
  const step = async () => {
    i++;
    try { await reportUser(sock, t); stat.ok++; } catch (e) { stat.fail++; stat.lastErr = String(e?.message || e).slice(0, 120); console.log(`[REPORT] #${i} failed:`, stat.lastErr); }
    if (i === 2 && stat.ok === 0) return finish(stat);   // not accepted at all → don't keep hammering
    if (i < times) setTimeout(step, everyMs); else finish(stat);
  };
  step();
  return stat;
}

/** auto-save a new private-chat sender with his own profile name (per bot, once) */
const _skipAuto = new Map();   // `${bot}|${chat}` → ts   (don't retry unresolved numbers on every message)
let _autoBusy = 0;
async function autoSaveDM(sock, msg, config) {
  if (_autoBusy >= 2) return;
  try {
    _autoBusy++;
    const from = msg.key.remoteJid;
    if (msg.key.fromMe || !/@(s\.whatsapp\.net|lid)$/.test(String(from))) return;
    const bot = botIdOf(sock);
    if (!database.getBotSetting(bot, 'autosave_dm', true)) return;
    const name = msg.pushName; if (!name) return;
    const sk = `${bot}|${from}`;
    if (Date.now() - (_skipAuto.get(sk) || 0) < 10 * 60 * 1000) return;
    const { pn, lid } = await pair(sock, from, msg.key.remoteJidAlt);
    const d = digits(pn || from);
    if (!d || wasSaved(bot, d) || known.has(`${bot}|${d}`) || known.has(`${bot}|${digits(lid)}`)) return;
    const t = { jid: from, pn, lid, digits: d };
    if (isProtected(sock, t, config)) return;
    if (!pn) { _skipAuto.set(sk, Date.now()); cap(_skipAuto, 5000); return; }   // can't save without a real number
    await saveContact(sock, t, name);
    console.log(`[AUTOSAVE] ${bot} saved ${d} as "${name}"`);
  } catch (e) { console.log('[AUTOSAVE] failed:', String(e?.message || e).slice(0, 100)); }
  finally { _autoBusy--; }
}

module.exports = { attach, noteMsg, nameOf, resolve, isProtected, saveContact, blockUser, reportUser, reportCampaign, campaignActive, reserve, autoSaveDM, botIdOf, digits };
