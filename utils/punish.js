'use strict';
/**
 * utils/punish.js — ONE place that applies the action a group admin chose for an "anti" feature.
 *
 *   warn   → message deleted + a visible warning with a counter (1/3, 2/3 …); at the limit the user is removed
 *   delete → message deleted, nothing else (silent)
 *   kick   → message deleted + user removed right away
 *
 * Used by: antilink, antitag, nsfw  (antigroupmention has its own warn/delete/kick logic).
 */
const database = require('../database');
const config   = require('../config');

const MODES = ['warn', 'delete', 'kick'];
const normMode = (m, def = 'delete') => { m = String(m || '').toLowerCase(); return MODES.includes(m) ? m : def; };
const num = (jid) => String(jid || '').split('@')[0].split(':')[0];

/**
 * @param o { from, target, mode, reason, label, botIsAdmin, deleteKey?: msg.key|null }
 * @returns {Promise<'warned'|'deleted'|'removed'|'remove_failed'>}
 */
async function apply(sock, msg, o) {
  const { from, target, reason, label, botIsAdmin } = o;
  const mode = normMode(o.mode);
  const id = num(target);

  // the offending message always goes
  if (o.deleteKey !== null) { try { await sock.sendMessage(from, { delete: o.deleteKey || msg.key }); } catch (_) {} }

  if (mode === 'delete') return 'deleted';

  const kick = async (text) => {
    if (!botIsAdmin) {
      try { await sock.sendMessage(from, { text: `⚠️ *${label}*\n@${id} should be removed (${reason}) but I am not an admin. Make me admin.`, mentions: [target] }); } catch (_) {}
      return 'remove_failed';
    }
    let ok = false;
    try { await sock.groupParticipantsUpdate(from, [target], 'remove'); ok = true; } catch (e) { console.log('[Punish] remove failed:', e.message); }
    try { await sock.sendMessage(from, { text: ok ? text : `⚠️ Could not remove @${id}.`, mentions: [target] }); } catch (_) {}
    return ok ? 'removed' : 'remove_failed';
  };

  if (mode === 'kick') return kick(`🚫 *${label}*\n\n@${id} has been removed.\n📌 ${reason}`);

  // warn
  const max = Number(config.maxWarnings) || 3;
  const w = database.addWarning(from, target, `${label}: ${reason}`);
  if (w.count >= max) {
    const r = await kick(`🚫 *${label}*\n\n@${id} reached ${max}/${max} warnings and has been removed.\n📌 ${reason}`);
    if (r === 'removed' || !botIsAdmin) { try { database.clearWarnings(from, target); } catch (_) {} }
    return r;
  }
  try {
    await sock.sendMessage(from, {
      text: `⚠️ *WARNING — ${label}*\n\n👤 @${id}\n📌 ${reason}\n⚠️ Warnings: *${w.count}/${max}*\n🗑️ Your message was deleted.\n\n_At ${max} warnings you will be removed._`,
      mentions: [target],
    });
  } catch (_) {}
  return 'warned';
}

module.exports = { apply, normMode, MODES };
