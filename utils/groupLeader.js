'use strict';
/**
 * utils/groupLeader.js — when SEVERAL bots of this panel sit in the same group, only ONE of them
 * should act on shared things (welcome / goodbye, warnings, admin commands, anti-* enforcement).
 * Otherwise every bot repeats the same welcome, adds the same warning five times, and replies
 * "Bot needs to be admin" while the admin bot has already done the job.
 *
 * Election (per group, deterministic — every bot computes the same answer):
 *   candidates = panel bots that are members of the group (connected, not in private/self mode)
 *   pool       = the candidates that are ADMIN in that group (if none: all candidates)
 *   leader     = the lowest bot number in the pool
 */
const bots = new Set();          // sock objects of every panel session
const metaCache = new Map();     // groupId → participants (last seen)
let finder = null;               // (participants, ids[]) → participant   (handler's findParticipant)
let eligible = () => true;       // (sock) → boolean  (e.g. not in self-mode)

const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

function init(opts = {}) { if (opts.findParticipant) finder = opts.findParticipant; if (opts.eligible) eligible = opts.eligible; }
function register(sock) { if (sock) bots.add(sock); }
function noteMeta(groupId, meta) { if (meta?.participants?.length) { metaCache.set(groupId, meta.participants); if (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value); } }

const alive = (s) => {
  if (!s?.user?.id) return false;
  const ws = s.ws;
  if (ws && (ws.isClosed === true || ws.isClosing === true)) return false;
  return true;
};

function findMe(participants, s) {
  const ids = [s.user.id, s.user.lid, digits(s.user.id) + '@s.whatsapp.net'].filter(Boolean);
  if (finder) { try { const p = finder(participants, ids); if (p) return p; } catch (_) {} }
  const nums = new Set(ids.map(digits));
  return participants.find(p => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).some(x => nums.has(digits(x)))) || null;
}

/** true when THIS sock is the one that must act in `groupId` */
function isLeader(sock, groupId, meta) {
  try {
    if (!sock?.user?.id || !groupId?.endsWith('@g.us')) return true;
    register(sock);
    const participants = meta?.participants || metaCache.get(groupId);
    if (meta?.participants) noteMeta(groupId, meta);
    if (!participants?.length) return true;                       // unknown → do not block anything

    const byNum = new Map();                                       // botNum → { sock, admin }
    for (const s of [...bots]) {
      if (!alive(s)) { if (s !== sock && s.ws && (s.ws.isClosed === true)) bots.delete(s); continue; }
      if (s !== sock && !eligible(s)) continue;
      const p = findMe(participants, s);
      if (!p) continue;
      byNum.set(digits(s.user.id), { sock: s, admin: p.admin === 'admin' || p.admin === 'superadmin' });
    }
    const me = digits(sock.user.id);
    if (!byNum.has(me)) return true;                               // I am not recognised → act (safe default)
    const all = [...byNum.entries()];
    const admins = all.filter(([, v]) => v.admin);
    const pool = (admins.length ? admins : all).map(([n]) => n).sort();
    return pool[0] === me;
  } catch (_) { return true; }
}

module.exports = { init, register, noteMeta, isLeader };
