'use strict';

/**
 * commands/lib/perm.js — one reliable place for "who is allowed?" in moderation commands.
 *
 * Why: commands used their own owner check that knew ONE hard-coded number, so the
 * super owner / bot owner / connected owner were treated like normal members and only
 * group admins could use .mute / .ban. Here the handler's own verdicts (extra.isOwner,
 * extra.isMainDeveloper, extra.isConnectedOwner) are trusted first, then the numbers
 * in config, then messages sent from the bot's own account.
 */

const strictGuard = require('../../utils/strictGuard');

const digits = (v) => String(v || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

function configOwnerDigits() {
  const set = new Set(['923196615238']);
  try {
    const cfg = require('../../config');
    for (const n of [].concat(cfg.ownerNumber || [], cfg.mainDeveloper || [])) { const d = digits(n); if (d) set.add(d); }
  } catch (_) {}
  return set;
}

/** Is the person who sent this command a bot owner of any kind? */
function isPrivileged(sock, msg, extra = {}) {
  if (extra.isOwner || extra.isMainDeveloper || extra.isSuperAdmin || extra.isConnectedOwner) return true;
  if (msg?.key?.fromMe) return true;                       // typed from the bot's own phone
  const owners = configOwnerDigits();
  const cand = [extra.sender, msg?.key?.senderPn, msg?.key?.participantPn, msg?.key?.participant, msg?.key?.remoteJid];
  if (cand.some(j => owners.has(digits(j)))) return true;
  const botNum = digits(sock?.user?.id);
  if (botNum && cand.some(j => digits(j) === botNum)) return true;   // the account that runs this bot
  return false;
}

/**
 * Every id (phone + LID) of a target person, so a ban/mute written today still matches
 * when WhatsApp shows the same person under the other id tomorrow.
 * @returns {{ ids: string[], jid: string }}
 */
async function targetIds(sock, chatId, jid) {
  let meta = null;
  if (chatId && chatId.endsWith('@g.us')) { try { meta = await sock.groupMetadata(chatId); } catch (_) {} }
  const r = strictGuard.resolveParticipant(meta, jid);
  let ids = new Set(r.ids);
  try { ids = await strictGuard.expandWithStore(sock, ids); } catch (_) {}
  return { ids: [...ids].filter(Boolean), jid: r.jid || jid };
}

/** Bot itself or any owner — these must never be banned / muted. */
function isProtectedTarget(sock, ids) {
  const owners = configOwnerDigits();
  const bot = new Set([digits(sock?.user?.id), digits(sock?.user?.lid)].filter(Boolean));
  return ids.some(i => owners.has(i) || bot.has(i));
}

module.exports = { isPrivileged, targetIds, isProtectedTarget, digits };
