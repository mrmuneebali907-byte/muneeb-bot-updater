'use strict';

/**
 * Strict Owner Guard — Full Security Control System
 *
 * Layer 1 — Admin role protection (promote/demote events):
 *   • Monitors all promote/demote events
 *   • Only the designated group owner (+ global bot owner) may change admin roles
 *   • Instantly reverses any unauthorized role changes
 *   • Punishes offenders: demote on 1st offense, remove on 2nd+
 *   • Anti-loop: tracks bot-initiated actions to prevent re-trigger
 *
 * Layer 2 — Message-level security (called from handleMessage in handler.js):
 *   • Anti-spam     : per-group per-user message rate limit (12 msgs / 15 s)
 *   • Command abuse : per-group per-user command rate limit (7 cmds / 20 s)
 *   • Repeat abuse  : same command ≥ 4 times → remove
 *   • Mass URL spam : ≥ 4 URLs in one message → remove
 *   • Mention flood : ≥ 8 @mentions in one message → remove
 *   • Admins and bot owner ALWAYS bypassed
 *
 * Performance:
 *   • checkStrictGuardMessage() is 100% synchronous — zero I/O, zero awaits
 *   • Config read from in-memory cache (30 s TTL) — no JSON on every message
 *   • All Maps are bounded — no unbounded memory growth
 *
 * State: persisted in data/strictGuard.json (survives restarts)
 */

const fs   = require('fs');
const path = require('path');

// ── Data file ─────────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, '..', 'data', 'strictGuard.json');

// ── Global bot owner (hard-locked) ────────────────────────────────────────────
const GLOBAL_OWNER = '923196615238';

// ─────────────────────────────────────────────────────────────────────────────
// Config cache — avoids JSON reads on every message
// Map<groupId, { cfg: object, ts: number }>
// ─────────────────────────────────────────────────────────────────────────────
const _cfgCache     = new Map();
const CFG_CACHE_TTL = 30_000;   // 30 s — short enough to catch fresh on/off toggles

// ─────────────────────────────────────────────────────────────────────────────
// Anti-loop tracker (Layer 1)
// key = `groupId:phone`  →  timestamp of last bot action
// ─────────────────────────────────────────────────────────────────────────────
const _botActions    = new Map();
const BOT_ACTION_TTL = 20_000;   // 20 s

// ── KickAll / mass-remove detection tracker ───────────────────────────────────
// key = `groupId:actorPhone`  →  { count, windowStart }
const _removeTracker    = new Map();
const KICKALL_WINDOW_MS = 30_000;   // 30-second window
const KICKALL_THRESHOLD = 3;        // 3+ removes in window = KickAll attack

// ─────────────────────────────────────────────────────────────────────────────
// Per-group per-user message tracker (Layer 2)
// key = `groupId:senderPhone`
// value = {
//   msgCount, msgWindowStart,          ← total message rate
//   cmdCount, cmdWindowStart,          ← command rate
//   lastCmdText, cmdRepeat, cmdRepeatStart  ← repeated-command abuse
// }
// ─────────────────────────────────────────────────────────────────────────────
const _sgTracker     = new Map();
const MAX_TRACKER_SZ = 3000;

// ── Security thresholds ───────────────────────────────────────────────────────
const SG_MSG_WINDOW  = 15_000;   // 15 s window for message flood
const SG_MSG_MAX     = 12;       // max messages per window
const SG_CMD_WINDOW  = 20_000;   // 20 s window for command spam
const SG_CMD_MAX     = 7;        // max command messages per window
const SG_REPEAT_MAX  = 4;        // same command ≥ N times → abuse
const SG_URL_MAX     = 4;        // URLs per single message → spam
const SG_MENTION_MAX = 8;        // @mentions per single message → flood

// ── URL regex (safe — no catastrophic backtracking) ───────────────────────────
const URL_RE = /https?:\/\/[^\s]{4,}|(?:^|\s)(?:www\.|t\.me\/|bit\.ly\/|wa\.me\/)[^\s]{3,}/gi;

// ── Helpers ───────────────────────────────────────────────────────────────────
const getPhone = (jid) =>
  String(jid || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');

const toSWNet = (jid) => {
  const num = getPhone(jid);
  return num ? `${num}@s.whatsapp.net` : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Identity helpers — WhatsApp now uses BOTH phone JIDs (92...@s.whatsapp.net) and
// LIDs (1234...@lid). Participants / authors can arrive in either form, and in
// Baileys v7 `participants` are OBJECTS ({id, lid, phoneNumber, admin}), not strings.
// Every person is therefore represented as a SET of numeric ids and compared by overlap.
// ─────────────────────────────────────────────────────────────────────────────
const digitsOf = (v) => String(v || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');

function idsOf(x) {
  const out = new Set();
  if (!x) return out;
  if (typeof x === 'string') { const d = digitsOf(x); if (d) out.add(d); return out; }
  for (const k of ['id', 'jid', 'lid', 'phoneNumber', 'participant', 'pn']) {
    if (x[k]) { const d = digitsOf(x[k]); if (d) out.add(d); }
  }
  return out;
}
const intersects = (a, b) => { for (const v of a) if (b.has(v)) return true; return false; };

/** Grow an id-set with every other id (lid/phone) the group metadata knows for that person. */
function expandIds(ids, meta) {
  const out = new Set(ids);
  for (const p of (meta?.participants || [])) {
    const pi = idsOf(p);
    if (intersects(pi, out)) for (const v of pi) out.add(v);
  }
  return out;
}
const findParticipant = (meta, ids) =>
  (meta?.participants || []).find(p => intersects(idsOf(p), ids)) || null;
const isAdminP = (p) => !!p && (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true);

/** Resolve a mentioned/quoted JID to { participant, ids, jid } using fresh group metadata. */
function resolveParticipant(meta, jid) {
  const ids = expandIds(idsOf(jid), meta);
  const participant = findParticipant(meta, ids);
  return { participant, ids: [...ids], jid: participant?.id || (typeof jid === 'string' ? jid : jid?.id) || null };
}

/** Ask Baileys' own LID<->phone mapping store (async). Safe: every call is try/caught. */
async function expandWithStore(sock, ids) {
  const out = new Set(ids);
  const add = (v) => { const d = digitsOf(v); if (d) out.add(d); };
  const lm = sock?.signalRepository?.lidMapping;
  const keys = sock?.authState?.keys;
  for (const id of [...ids]) {
    try { const v = await lm?.getPNForLID?.(`${id}@lid`);            if (v) add(v); } catch (_) {}
    try { const v = await lm?.getLIDForPN?.(`${id}@s.whatsapp.net`); if (v) add(v); } catch (_) {}
    try {
      if (keys?.get) {
        const a = await keys.get('lid-mapping', [id, `${id}_reverse`]);
        if (a?.[id]) add(a[id]);
        if (a?.[`${id}_reverse`]) add(a[`${id}_reverse`]);
      }
    } catch (_) {}
  }
  return out;
}

function globalOwnerIds() {
  const set = new Set([GLOBAL_OWNER]);
  try {
    const cfg = require('../config');
    for (const n of [].concat(cfg.ownerNumber || [])) { const d = digitsOf(n); if (d) set.add(d); }
  } catch (_) {}
  return set;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistent data I/O
// ─────────────────────────────────────────────────────────────────────────────
function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function writeData(data) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[StrictGuard] writeData error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config cache helpers
// ─────────────────────────────────────────────────────────────────────────────
function _readCachedConfig(groupId) {
  const cached = _cfgCache.get(groupId);
  if (cached && Date.now() - cached.ts < CFG_CACHE_TTL) return cached.cfg;
  // Cache miss or expired → read from disk
  const data = readData();
  const cfg  = data[groupId] || { enabled: false, owner: null, offenses: {} };
  _cfgCache.set(groupId, { cfg, ts: Date.now() });
  return cfg;
}

function _invalidateCache(groupId) {
  _cfgCache.delete(groupId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public config API  (used by .strictguard and .setgowner command handlers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns { enabled, owner, offenses } for a group.
 * Always reads fresh from disk so command handlers see current state.
 */
function getGuardConfig(groupId) {
  _invalidateCache(groupId);   // force fresh read
  const data = readData();
  return data[groupId] || { enabled: false, owner: null, offenses: {} };
}

function setGuardEnabled(groupId, enabled) {
  const data = readData();
  if (!data[groupId]) data[groupId] = { enabled: false, owner: null, offenses: {} };
  data[groupId].enabled = !!enabled;
  if (enabled) data[groupId].offenses = {};   // every activation starts clean
  writeData(data);
  _invalidateCache(groupId);   // flush cache — handler picks up new state instantly
  // Also reset all per-user trackers for this group when toggling
  for (const key of _sgTracker.keys()) {
    if (key.startsWith(groupId + ':')) _sgTracker.delete(key);
  }
  console.log(`[StrictGuard] ${groupId.split('@')[0]}: guard ${enabled ? 'ENABLED 🟢' : 'DISABLED 🔴'}`);
}

/**
 * @param {string}   groupId  - group JID
 * @param {string}   ownerJid - participant JID of the designated group owner
 * @param {string[]} allIds   - every known id (phone + lid) of that person
 */
function setGroupOwner(groupId, ownerJid, allIds = []) {
  const data = readData();
  if (!data[groupId]) data[groupId] = { enabled: false, owner: null, offenses: {} };
  const ids = new Set([...allIds.map(digitsOf), ...idsOf(ownerJid)].filter(Boolean));
  data[groupId].owner    = getPhone(ownerJid);
  data[groupId].ownerJid = (typeof ownerJid === 'string' ? ownerJid : ownerJid?.id) || null;   // exact JID → correct @mention rendering
  data[groupId].ownerIds = [...ids];
  // fresh start: forget any earlier (possibly wrong) offenses of the owner
  if (data[groupId].offenses) for (const k of Object.keys(data[groupId].offenses)) if (ids.has(k)) delete data[groupId].offenses[k];
  writeData(data);
  _invalidateCache(groupId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Anti-loop helpers (Layer 1)
// ─────────────────────────────────────────────────────────────────────────────
function markBotAction(groupId, who) {
  const now = Date.now();
  for (const id of idsOf(who)) _botActions.set(`${groupId}:${id}`, now);
  if (_botActions.size > 500) {
    const cutoff = now - BOT_ACTION_TTL * 3;
    for (const [k, ts] of _botActions.entries()) if (ts < cutoff) _botActions.delete(k);
  }
}

function isBotAction(groupId, who) {
  for (const id of (who instanceof Set ? who : idsOf(who))) {
    const key = `${groupId}:${id}`;
    const ts  = _botActions.get(key);
    if (!ts) continue;
    if (Date.now() - ts < BOT_ACTION_TTL) return true;
    _botActions.delete(key);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Offense counter (Layer 1)
// ─────────────────────────────────────────────────────────────────────────────
function recordOffense(groupId, phone) {
  const data = readData();
  if (!data[groupId]) data[groupId] = { enabled: false, owner: null, offenses: {} };
  if (!data[groupId].offenses) data[groupId].offenses = {};
  data[groupId].offenses[phone] = (data[groupId].offenses[phone] || 0) + 1;
  writeData(data);
  _invalidateCache(groupId);
  return data[groupId].offenses[phone];
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — Message-level security check
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Synchronous — zero I/O, zero awaits. Safe to call on EVERY group message.
 * Uses config cache (30 s TTL) and in-memory per-user trackers.
 *
 * @param {string}  groupId       - group JID  (e.g. "12345@g.us")
 * @param {string}  senderJid     - sender JID
 * @param {string}  textBody      - raw message text (or '' for media-only)
 * @param {boolean} senderIsAdmin - true if sender is a group admin
 * @param {boolean} senderIsOwner - true if sender is the global bot owner
 * @returns {{ blocked: boolean, reason: string, action: 'warn'|'remove' }}
 */
// ── Warn ONCE, then silently delete (no warning spam) ─────────────────────────
// 1st violation → visible warning. Further violations of the same kind within 60 s → message deleted silently.
// 3 separate warned violations within 10 minutes → user is removed.
const SG_WARN_COOLDOWN = 60_000;
const SG_STRIKE_WINDOW = 600_000;
const SG_STRIKES_MAX   = 3;
function _warnOnce(t, kind, now) {
  t.warn = t.warn || {};
  const w = t.warn[kind] || (t.warn[kind] = { at: 0, strikes: 0, strikeAt: 0 });
  if (now - w.at < SG_WARN_COOLDOWN) return 'delete';          // already warned a moment ago → silent delete
  w.strikes = (now - w.strikeAt < SG_STRIKE_WINDOW) ? w.strikes + 1 : 1;
  w.strikeAt = now; w.at = now;
  if (w.strikes >= SG_STRIKES_MAX) { w.strikes = 0; return 'remove'; }
  return 'warn';
}

function checkStrictGuardMessage(groupId, senderJid, textBody, senderIsAdmin, senderIsOwner) {
  try {
    // ── 1. Fast-exit: is strict guard enabled for this group? ─────────────────
    const cfg = _readCachedConfig(groupId);
    if (!cfg.enabled) return { blocked: false, reason: '', action: 'warn' };

    // ── 2. Admins, bot owner and the DESIGNATED GROUP OWNER are ALWAYS bypassed ─
    const _isDesignated = intersects(idsOf(senderJid), new Set([...(cfg.ownerIds || []), cfg.owner].filter(Boolean)));
    if (senderIsAdmin || senderIsOwner || _isDesignated) {
      console.log(`[StrictGuard] BYPASS (${_isDesignated ? 'group-owner' : senderIsOwner ? 'owner' : 'admin'}): ${getPhone(senderJid)} in ${groupId.split('@')[0]}`);
      return { blocked: false, reason: '', action: 'warn' };
    }

    const now         = Date.now();
    const senderPhone = getPhone(senderJid);
    const trackerKey  = `${groupId}:${senderPhone}`;

    // ── 3. Prune tracker Map if too large (memory safety) ─────────────────────
    if (_sgTracker.size > MAX_TRACKER_SZ) {
      const cutoff = now - Math.max(SG_MSG_WINDOW, SG_CMD_WINDOW) * 2;
      for (const [k, v] of _sgTracker.entries()) {
        if (v.msgWindowStart < cutoff && v.cmdWindowStart < cutoff) _sgTracker.delete(k);
      }
    }

    // ── 4. Get/init tracker for this user in this group ───────────────────────
    const t = _sgTracker.get(trackerKey) || {
      msgCount: 0,     msgWindowStart: now,
      cmdCount: 0,     cmdWindowStart: now,
      lastCmdText: '', cmdRepeat: 0, cmdRepeatStart: now,
    };

    const text  = (textBody || '').trim();
    const isCmd = text.length > 0 && ['.', '/', '!', '#'].includes(text[0]);

    // ── 5. Total message rate limit ───────────────────────────────────────────
    if (now - t.msgWindowStart > SG_MSG_WINDOW) {
      t.msgCount = 1; t.msgWindowStart = now;
    } else {
      t.msgCount++;
    }
    if (t.msgCount > SG_MSG_MAX) {
      _sgTracker.set(trackerKey, t);
      const reason = `Message flood (${t.msgCount} msgs / ${SG_MSG_WINDOW / 1000}s — limit ${SG_MSG_MAX})`;
      const _act = _warnOnce(t, 'flood', now);
      if (_act !== 'delete') console.log(`[StrictGuard] BLOCKED ${senderPhone} in ${groupId.split('@')[0]}: ${reason} → ${_act}`);
      return { blocked: true, reason, action: _act };
    }

    // ── 6. Command rate limit ─────────────────────────────────────────────────
    if (isCmd) {
      if (now - t.cmdWindowStart > SG_CMD_WINDOW) {
        t.cmdCount = 1; t.cmdWindowStart = now;
      } else {
        t.cmdCount++;
      }
      if (t.cmdCount > SG_CMD_MAX) {
        _sgTracker.set(trackerKey, t);
        const reason = `Command spam (${t.cmdCount} commands / ${SG_CMD_WINDOW / 1000}s — limit ${SG_CMD_MAX})`;
        const _act = _warnOnce(t, 'cmd', now);
        if (_act !== 'delete') console.log(`[StrictGuard] BLOCKED ${senderPhone} in ${groupId.split('@')[0]}: ${reason} → ${_act}`);
        return { blocked: true, reason, action: _act };
      }

      // ── 7. Repeated command abuse ──────────────────────────────────────────
      // Take the first word of the command (e.g. ".sticker" from ".sticker foo bar")
      const cmdWord = text.split(/\s+/)[0].toLowerCase();
      if (now - t.cmdRepeatStart > SG_CMD_WINDOW) {
        t.cmdRepeat = 1; t.lastCmdText = cmdWord; t.cmdRepeatStart = now;
      } else if (cmdWord === t.lastCmdText) {
        t.cmdRepeat++;
      } else {
        t.cmdRepeat = 1; t.lastCmdText = cmdWord;
      }
      if (t.cmdRepeat >= SG_REPEAT_MAX) {
        _sgTracker.set(trackerKey, t);
        const reason = `Repeated command abuse ("${cmdWord}" × ${t.cmdRepeat} times)`;
        console.log(`[StrictGuard] BLOCKED ${senderPhone} in ${groupId.split('@')[0]}: ${reason}`);
        return { blocked: true, reason, action: 'remove' };
      }
    }

    // ── 8. Mass URL / link spam ───────────────────────────────────────────────
    if (text.length > 0) {
      const urlMatches = text.match(URL_RE);
      if (urlMatches && urlMatches.length >= SG_URL_MAX) {
        _sgTracker.set(trackerKey, t);
        const reason = `Mass link spam (${urlMatches.length} URLs — limit ${SG_URL_MAX})`;
        console.log(`[StrictGuard] BLOCKED ${senderPhone} in ${groupId.split('@')[0]}: ${reason}`);
        return { blocked: true, reason, action: 'remove' };
      }
    }

    // ── 9. Mention flood ──────────────────────────────────────────────────────
    const mentionCount = (text.match(/@\d{6,}/g) || []).length;
    if (mentionCount >= SG_MENTION_MAX) {
      _sgTracker.set(trackerKey, t);
      const reason = `Mention flood (${mentionCount} @mentions — limit ${SG_MENTION_MAX})`;
      console.log(`[StrictGuard] BLOCKED ${senderPhone} in ${groupId.split('@')[0]}: ${reason}`);
      return { blocked: true, reason, action: 'remove' };
    }

    // ── 10. Save updated tracker and allow ────────────────────────────────────
    _sgTracker.set(trackerKey, t);
    return { blocked: false, reason: '', action: 'warn' };

  } catch (e) {
    // Fail-open: NEVER crash the handler
    console.error('[StrictGuard] checkStrictGuardMessage error:', e.message);
    return { blocked: false, reason: '', action: 'warn' };
  }
}

/**
 * Reset per-user tracker for a group (e.g. after a remove action clears their slate).
 */
function resetUserTracker(groupId, senderJid) {
  _sgTracker.delete(`${groupId}:${getPhone(senderJid)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — Core guard engine  (promote / demote / remove events)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * RULE: in a guarded group only (a) the designated group owner (.setgowner), (b) the bot
 * owner(s) and (c) the bot's own account may promote / demote admins.
 * Anyone else who does it → the change is reversed IMMEDIATELY, the offender gets a
 * warning and is demoted on the spot (repeat offender → removed).
 *
 * Called by handleGroupUpdate in handler.js. Async — never throws to the caller.
 */
async function handleStrictGuardEvent(sock, update) {
  try {
    const { id: groupId, participants, action } = update;
    if (!participants?.length) return;
    if (action !== 'promote' && action !== 'demote' && action !== 'remove') return;

    const cfg = _readCachedConfig(groupId);
    if (!cfg.enabled || !cfg.owner) return;

    let meta;
    try { meta = await sock.groupMetadata(groupId); } catch (e) { console.log(`[StrictGuard] metadata failed: ${e.message}`); return; }
    if (!meta?.participants) return;

    // ── Identify everyone. Cheap pass first (group metadata only) ─────────────
    const base       = (set) => expandIds(set, meta);
    const authorSet  = () => new Set([...idsOf(update.author), ...idsOf(update.authorPn), ...idsOf(update.by)]);
    let botIds     = base(new Set([...idsOf(sock.user?.id), ...idsOf(sock.user?.lid)]));
    if (!botIds.size) return;
    if (!isAdminP(findParticipant(meta, botIds))) {
      console.log(`[StrictGuard] ${groupId.split('@')[0]}: bot is NOT admin — cannot enforce`);
      return;
    }
    let globalIds  = base(globalOwnerIds());
    let designated = base(new Set([...(cfg.ownerIds || []), cfg.owner].filter(Boolean)));
    let actorIds   = base(authorSet());
    const actorKnown = actorIds.size > 0;

    /**
     * Decide ONLY on positive evidence:
     *   allowed        → actor is the designated owner / bot owner / the bot itself
     *   unauthorized   → actor is a real participant who is clearly a DIFFERENT person than the owner
     *   inconclusive   → ids could not be tied together (lid/phone mismatch) → never punish
     */
    const evaluate = () => {
      if (!actorKnown) return 'allowed';
      const allowedSet = new Set([...designated, ...globalIds, ...botIds]);
      if (intersects(actorIds, allowedSet)) return 'allowed';
      const dP = findParticipant(meta, designated);
      const aP = findParticipant(meta, actorIds);
      if (dP && aP) return digitsOf(dP.id) === digitsOf(aP.id) ? 'allowed' : 'unauthorized';
      return 'inconclusive';
    };

    let verdict = evaluate();
    if (verdict === 'inconclusive') {
      // Second pass: Baileys' LID<->phone mapping store
      const X = async (set) => base(await expandWithStore(sock, base(set)));
      botIds = await X(botIds); globalIds = await X(globalIds); designated = await X(designated); actorIds = await X(authorSet());
      verdict = evaluate();
      if (verdict === 'inconclusive') {
        console.log(`[StrictGuard] ${action}: cannot tie author ${[...actorIds].join('/')} to owner ${[...designated].join('/')} — allowing (no punishment on doubt)`);
        verdict = 'allowed';
      }
    }
    const actorIsAllowed = verdict === 'allowed';
    const actorP    = actorKnown ? findParticipant(meta, actorIds) : null;
    const actorJid  = actorP?.id || update.author || update.authorPn || null;
    const actorKey  = actorJid ? digitsOf(actorJid) : null;
    const tag       = (jid) => `@${digitsOf(jid)}`;

    if (!actorKnown) console.log(`[StrictGuard] ${action}: author unknown — allowing`);

    for (const raw of participants) {
      const tIds = expandIds(idsOf(raw), meta);
      if (!tIds.size) continue;
      if (intersects(tIds, botIds)) continue;           // never touch the bot itself
      if (intersects(tIds, globalIds)) continue;        // never touch the bot owner

      const tP        = findParticipant(meta, tIds);
      const targetJid = tP?.id || (typeof raw === 'string' ? raw : raw?.id);
      if (!targetJid) continue;
      const targetIsOwner = intersects(tIds, designated);

      if (isBotAction(groupId, tIds)) {
        console.log(`[StrictGuard] Anti-loop: skipping bot-initiated ${action} for ${digitsOf(targetJid)}`);
        continue;
      }

      // ── PROMOTE / DEMOTE ──────────────────────────────────────────────────
      if (action === 'promote' || action === 'demote') {
        if (actorIsAllowed) {
          console.log(`[StrictGuard] Legitimate ${action}: ${digitsOf(targetJid)} by ${actorKey || 'unknown'}`);
          continue;
        }
        console.log(`[StrictGuard] UNAUTHORIZED ${action}: target=${digitsOf(targetJid)} actor=${actorKey} in ${groupId.split('@')[0]}`);

        const offenses = actorKey ? recordOffense(groupId, actorKey) : 0;
        const removeIt = offenses >= 2;

        // Reverse the change + punish the offender AT THE SAME TIME (instant)
        markBotAction(groupId, tIds);
        if (actorJid) markBotAction(groupId, actorIds.size ? actorIds : actorJid);
        const jobs = [
          sock.groupParticipantsUpdate(groupId, [targetJid], action === 'promote' ? 'demote' : 'promote'),
        ];
        if (actorJid) jobs.push(sock.groupParticipantsUpdate(groupId, [actorJid], removeIt ? 'remove' : 'demote'));
        const res = await Promise.allSettled(jobs);
        res.forEach((r, i) => { if (r.status === 'rejected') console.log(`[StrictGuard] ${i ? 'punish' : 'revert'} failed: ${r.reason?.message || r.reason}`); });

        const mentions = [targetJid, ...(actorJid ? [actorJid] : [])];
        const punish = !actorJid ? '' : (removeIt
          ? `🔴 *${tag(actorJid)} ko group se remove kar diya* (baar baar ki ghalti — ${offenses}x)\n`
          : `⚠️ *Warning:* ${tag(actorJid)} ko *admin se hata diya gaya* (offense #${offenses})\n`);
        const victim = targetIsOwner ? `⚠️ *Group Owner ko target kiya gaya — MAXIMUM SEVERITY*\n\n` : '';

        try {
          await sock.sendMessage(groupId, {
            text:
              `🚨 *[ STRICT GUARD ALERT ]*\n\n` +
              (action === 'promote'
                ? `🔒 *Unauthorized admin promotion blocked!*\n\n`
                : `🔒 *Unauthorized admin removal blocked!*\n\n`) +
              victim +
              `👤 ${action === 'promote' ? 'Promoter' : 'Offender'} : ${actorJid ? tag(actorJid) : 'Unknown'}\n` +
              `👤 Target   : ${tag(targetJid)}\n\n` +
              punish +
              (action === 'promote'
                ? `✅ ${tag(targetJid)} ko wapas *admin se hata diya gaya.*\n\n`
                : `✅ ${tag(targetJid)} ko wapas *admin bana diya gaya.*\n\n`) +
              `> *Sirf designated group owner hi admin bana ya hata sakta hai.*\n` +
              `> ᴘᴏᴡᴇʀᴇᴅ ʙʏ 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭`,
            mentions,
          });
        } catch (_) {}

      // ── REMOVE event — KickAll / mass-remove protection ───────────────────
      } else if (action === 'remove') {
        if (!actorKnown || actorIsAllowed) continue;

        const _rmKey = `${groupId}:${actorKey}`;
        const _rmNow = Date.now();
        const _rt    = _removeTracker.get(_rmKey) || { count: 0, windowStart: _rmNow };
        if (_rmNow - _rt.windowStart > KICKALL_WINDOW_MS) { _rt.count = 1; _rt.windowStart = _rmNow; } else { _rt.count++; }
        _removeTracker.set(_rmKey, _rt);

        if (_rt.count >= KICKALL_THRESHOLD && actorJid) {
          _removeTracker.delete(_rmKey);
          markBotAction(groupId, actorIds);
          try { await sock.groupParticipantsUpdate(groupId, [actorJid], 'remove'); } catch (e) { console.log(`[StrictGuard] kickall punish failed: ${e.message}`); }
          try {
            await sock.sendMessage(groupId, {
              text:
                `🚨 *[ STRICT GUARD — KICKALL ALERT ]*\n\n` +
                `⚠️ *Unauthorized admin dangerous action perform kar raha tha!*\n\n` +
                `👤 Attacker : ${tag(actorJid)}\n` +
                `📊 Removed  : *${_rt.count} members* in ${KICKALL_WINDOW_MS / 1000}s\n\n` +
                `🔴 *${tag(actorJid)} ko Strict Guard ne group se remove kar diya.*\n\n` +
                `> ✅ Group hijack/KickAll attempt blocked.\n` +
                `> ᴘᴏᴡᴇʀᴇᴅ ʙʏ 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭`,
              mentions: [actorJid],
            });
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    console.error('[StrictGuard] handleStrictGuardEvent error:', e.message);
  }
}

module.exports = {
  // Config API (used by command handlers)
  getGuardConfig,
  setGuardEnabled,
  setGroupOwner,
  resolveParticipant,
  expandWithStore,
  isAdminP,

  // Layer 1: promote/demote event enforcement
  handleStrictGuardEvent,

  // Layer 2: message-level security (synchronous, zero I/O)
  checkStrictGuardMessage,
  resetUserTracker,
};
