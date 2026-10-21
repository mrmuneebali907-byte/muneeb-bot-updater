'use strict';
/**
 * utils/autostatusConfig.js — Per-bot isolated auto-status settings
 * Storage: database.js → botSettings[botId]['autoStatus'] / ['statusReact']
 * Legacy fallback: data/autoStatus.json (read-only, for migration)
 */

const fs   = require('fs');
const path = require('path');

let _db = null;
function _getDb() {
  if (!_db) { try { _db = require('../database'); } catch (_) {} }
  return _db;
}

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'autoStatus.json');

function _legacyRead() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}
  return { enabled: false, reactOn: false };
}
function _legacyWrite(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

const isAutoStatusEnabled = (botId) => {
  if (botId) {
    const db = _getDb();
    const v  = db ? db.getBotSetting(botId, 'autoStatus', null) : null;
    if (v !== null) return v === true;
  }
  return _legacyRead().enabled === true;
};

const isStatusReactEnabled = (botId) => {
  if (botId) {
    const db = _getDb();
    const v  = db ? db.getBotSetting(botId, 'statusReact', null) : null;
    if (v !== null) return v === true;
  }
  return _legacyRead().reactOn === true;
};

const setAutoStatus = (v, botId) => {
  if (botId) {
    const db = _getDb();
    if (db) { db.setBotSetting(botId, 'autoStatus', !!v); return; }
  }
  const d = _legacyRead(); d.enabled = !!v; _legacyWrite(d);
};

const setStatusReact = (v, botId) => {
  if (botId) {
    const db = _getDb();
    if (db) { db.setBotSetting(botId, 'statusReact', !!v); return; }
  }
  const d = _legacyRead(); d.reactOn = !!v; _legacyWrite(d);
};

// ── which emoji(s) to react with: [] = default 👀 | ['🔥','❤️'] = random one of them | ['random'] = any from a big list ──
const RANDOM_POOL = ['❤️','🔥','😍','😂','👍','💯','🥰','😎','🤩','👏','🙌','💙','💜','✨','😮','🎉','🥳','💀','🤣','👀'];

const getStatusEmojis = (botId) => {
  const db = _getDb();
  const v = botId && db ? db.getBotSetting(botId, 'statusReactEmoji', null) : null;
  return Array.isArray(v) ? v : [];
};
const setStatusEmojis = (list, botId) => {
  const db = _getDb();
  if (botId && db) db.setBotSetting(botId, 'statusReactEmoji', Array.isArray(list) ? list : []);
};
/** emoji to use for ONE status (random among the chosen ones) */
const pickStatusEmoji = (botId) => {
  const l = getStatusEmojis(botId);
  if (!l.length) return '👀';
  if (l.length === 1 && l[0] === 'random') return RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)];
  return l[Math.floor(Math.random() * l.length)];
};
/** "🔥❤️ 😂" / "random" → ['🔥','❤️','😂'] / ['random'] ; null if nothing usable */
const parseEmojis = (text) => {
  const t = String(text || '').trim();
  if (/^(random|any|sab|mix)$/i.test(t)) return ['random'];
  if (/^(default|reset|eyes)$/i.test(t)) return [];
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(t)].map(x => x.segment) : Array.from(t);
  const out = [];
  for (const g of seg) if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g) && !out.includes(g)) out.push(g);
  return out.length ? out.slice(0, 12) : null;
};

module.exports = { isAutoStatusEnabled, isStatusReactEnabled, setAutoStatus, setStatusReact, getStatusEmojis, setStatusEmojis, pickStatusEmoji, parseEmojis };
