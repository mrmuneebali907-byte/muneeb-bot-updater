'use strict';

/**
 * antiGroupMention — blocks WhatsApp "Group Status" posts / group-mention-in-status notices
 * that members push into the group with ANOTHER bot.
 *
 *   1st time  → message deleted + English warning
 *   2nd time  → message deleted + user removed from the group (English notice)
 *
 * Modes (per group, `.antigroupmention set <mode>`):
 *   warn   (default)  1st = warning, 2nd = remove
 *   delete            only delete the message
 *   kick              delete + remove immediately
 *
 * Never punished: group admins, bot owners, the bot's own account, and and posts made by .allgroupstatus.
 * Other accounts of the same panel ARE checked like any member.
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'antiGroupMention.json');

// Message-type fields WhatsApp uses for group status / group mentions
const STATUS_KEYS = [
  'groupStatusMentionMessage',   // "X mentioned this group in their status"
  'groupStatusMessageV2',        // a Group Status post
  'groupStatusMessage',          // older form of the same
  'statusMentionMessage',        // status mention
  'groupMentionedMessage',
];
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage', 'deviceSentMessage'];
const STATUS_MENTION_PROTO = 25;   // proto.Message.ProtocolMessage.Type.STATUS_MENTION_MESSAGE

const COOLDOWN_MS = 20_000;        // one post can arrive as 2 events → count it once
const _recent = new Map();         // `${group}:${id}` → ts
const _seenMsg = new Map();        // msgId → ts

const digits = (v) => String(v || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

// ── detection ────────────────────────────────────────────────────────────────
function detectGroupStatus(msg) {
  let m = msg?.message;
  for (let depth = 0; m && typeof m === 'object' && depth < 6; depth++) {
    for (const k of STATUS_KEYS) if (m[k]) return k;
    const pm = m.protocolMessage;
    if (pm && (pm.type === STATUS_MENTION_PROTO || pm.type === 'STATUS_MENTION_MESSAGE')) return 'protocol:STATUS_MENTION_MESSAGE';
    let next = null;
    for (const w of WRAPPERS) if (m[w]?.message) { next = m[w].message; break; }
    if (!next) break;
    m = next;
  }
  return null;
}

// ── offense storage ──────────────────────────────────────────────────────────
function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; } }
function writeAll(d) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); }
  catch (e) { console.error('[AntiGroupMention] save failed:', e.message); }
}
function getCount(group, ids) {
  const g = readAll()[group] || {};
  return Math.max(0, ...ids.map(i => g[i] || 0));
}
function setCount(group, ids, n) {
  const all = readAll(); all[group] = all[group] || {};
  for (const i of ids) { if (n > 0) all[group][i] = n; else delete all[group][i]; }
  writeAll(all);
}
function resetGroup(group) { const all = readAll(); delete all[group]; writeAll(all); }

/** Phone numbers of every bot account running in this panel (never punished). */
function ownBotAccounts() {
  const out = new Set();
  try {
    const sm = require('../Panel/sessionManager');
    for (const s of sm.sessions.values()) {
      const u = s?.sock?.user;
      for (const v of [u?.id, u?.lid]) { const d = digits(v); if (d) out.add(d); }
    }
  } catch (_) {}
  return out;
}

const tag = (jid) => `@${digits(jid)}`;

/**
 * @param {object} ctx { senderIsAdmin, senderIsOwner, botIsAdmin, mode }
 */
async function enforce(sock, msg, ctx) {
  const kind = detectGroupStatus(msg);
  if (!kind) return false;

  const from = msg.key.remoteJid;
  const participant = msg.key.participant || null;
  if (!from?.endsWith('@g.us') || !participant) return false;
  if (msg.key.fromMe) return false;

  // de-dupe the very same message
  const now = Date.now();
  if (_seenMsg.has(msg.key.id)) return true;
  _seenMsg.set(msg.key.id, now);
  if (_seenMsg.size > 500) for (const [k, t] of _seenMsg) if (now - t > 120_000) _seenMsg.delete(k);

  const ids = [...new Set([digits(participant), digits(msg.key.participantPn), digits(msg.key.senderPn)].filter(Boolean))];
  if (ctx.senderIsOwner || ctx.senderIsAdmin) { console.log(`[AntiGroupMention] ${kind} by exempt ${ids[0]} — ignored`); return true; }
  if (global.__agsIds && global.__agsIds.has(msg.key.id)) { console.log(`[AntiGroupMention] ${kind} posted by .allgroupstatus — ignored`); return true; }

  console.log(`[AntiGroupMention] ${kind} by ${ids[0]} in ${from.split('@')[0]} (mode=${ctx.mode})`);

  // 1) always remove the post itself
  if (!ctx.botIsAdmin) console.log('[AntiGroupMention] bot is NOT admin here — cannot delete/remove');
  if (ctx.botIsAdmin) { try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {} }

  const mode = ctx.mode;
  if (mode === 'delete') return true;

  // same user, same moment → already handled (one post can produce two events)
  const rk = `${from}:${ids[0]}`;
  if (_recent.has(rk) && now - _recent.get(rk) < COOLDOWN_MS) return true;
  _recent.set(rk, now);
  if (_recent.size > 500) for (const [k, t] of _recent) if (now - t > 120_000) _recent.delete(k);

  const prev  = getCount(from, ids);
  const count = prev + 1;
  const kick  = mode === 'kick' || count >= 2;

  if (!kick) {
    setCount(from, ids, count);
    await sock.sendMessage(from, {
      text:
        `⚠️ *GROUP STATUS WARNING*\n\n` +
        `${tag(participant)}, posting a *group status* (or mentioning this group in a status) with another bot is *NOT allowed* in this group.\n\n` +
        `🗑️ Your message was deleted.\n` +
        `📌 Warning *1/2* — if you do it again you will be *removed* from the group.\n\n` +
        `> Powered by 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭`,
      mentions: [participant],
    }).catch(() => {});
    return true;
  }

  let removed = false;
  if (ctx.botIsAdmin) {
    try { await sock.groupParticipantsUpdate(from, [participant], 'remove'); removed = true; } catch (e) { console.log(`[AntiGroupMention] remove failed: ${e.message}`); }
  }
  setCount(from, ids, 0);
  await sock.sendMessage(from, {
    text: removed
      ? `🚫 *USER REMOVED*\n\n${tag(participant)} was removed from the group.\n\n📌 Reason: posted a group status again after a warning.\n> Group status posting is *not allowed* here.\n\n> Powered by 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭`
      : `🚫 *FINAL WARNING*\n\n${tag(participant)} posted a group status again after a warning.\n> Group status posting is *not allowed* here.\n⚠️ I need *admin rights* to remove members — please make me admin.`,
    mentions: [participant],
  }).catch(() => {});
  return true;
}

module.exports = { detectGroupStatus, enforce, resetGroup, getCount };
