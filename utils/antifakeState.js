'use strict';
/**
 * utils/antifakeState.js — Anti-Fake verification queue (persistent, LID + phone aware)
 *
 * groupJid → Map<primaryJid, { ids:[digits…], voiceReceived, joinedAt }>
 * A pending member is MUTED (every non-voice message is deleted) until an admin runs `.ok`.
 * State is saved to data/antifakePending.json so a bot restart never frees pending members.
 */
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'antifakePending.json');
const _pending = new Map();

const digits = (v) => String(v || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [g, users] of Object.entries(raw)) _pending.set(g, new Map(Object.entries(users)));
  } catch (_) {}
}
function save() {
  try {
    const o = {};
    for (const [g, m] of _pending) o[g] = Object.fromEntries(m);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(o));
  } catch (_) {}
}
load();

const idsOfList = (list) => [...new Set([].concat(list || []).map(digits).filter(Boolean))];

/** primary key of the pending entry matching ANY of these ids/jids, else null */
function findKey(groupJid, jidsOrIds) {
  const m = _pending.get(groupJid);
  if (!m) return null;
  const want = new Set(idsOfList(jidsOrIds));
  for (const [k, d] of m) {
    if (want.has(digits(k)) || (d.ids || []).some(i => want.has(i))) return k;
  }
  return null;
}

const getPending = (groupJid) => _pending.get(groupJid) || new Map();
const isPending  = (groupJid, userJid) => !!findKey(groupJid, userJid);

const addPending = (groupJid, userJid, data = {}) => {
  if (!_pending.has(groupJid)) _pending.set(groupJid, new Map());
  const ids = idsOfList([userJid, ...(data.ids || [])]);
  _pending.get(groupJid).set(userJid, { voiceReceived: false, joinedAt: Date.now(), ...data, ids });
  save();
};

const removePending = (groupJid, userJidOrIds) => {
  const m = _pending.get(groupJid);
  if (!m) return false;
  const k = findKey(groupJid, userJidOrIds);
  if (!k) return false;
  m.delete(k);
  if (m.size === 0) _pending.delete(groupJid);
  save();
  return true;
};

const setVoiceReceived = (groupJid, userJidOrIds) => {
  const k = findKey(groupJid, userJidOrIds);
  if (k) { _pending.get(groupJid).get(k).voiceReceived = true; save(); }
};

const clearGroup = (groupJid) => { _pending.delete(groupJid); save(); };

module.exports = { getPending, isPending, addPending, removePending, setVoiceReceived, clearGroup, findKey };
