/**
 * Message Handler — v5 FINAL EDITION
 *
 * OWNER  : 923196615238 (hard-coded, never dynamic)
 * STATUS : Auto-read + 👀 react + log to data/status_log.json — ALWAYS ON
 * NSFW   : Delete + Kick on image/video/sticker — ALWAYS ON, owner exempt
 *
 * Performance:
 *  1. isAdmin/isBotAdmin use cached metadata — zero live fetches per message
 *  2. Shields only trigger on image/video/sticker/text (skip audio/doc/reaction)
 *  3. MAX_CONCURRENT = 8 (Render Free: 512 MB / 1 vCPU)
 *  4. API timeouts = 4 s with instant text fallback
 *  5. Cache cleanup every 5 min — lidMappingCache capped at 2000
 */

process.on('uncaughtException',   (err)    => console.error('[FATAL] UncaughtException:', err));
process.on('unhandledRejection',  (reason) => console.error('[FATAL] UnhandledRejection:', reason));

const config   = require('./config');
const database = require('./database');
const { loadCommands }         = require('./utils/commandLoader');
const { addMessage }           = require('./utils/groupstats');
const { jidDecode, jidEncode, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { scanImageBuffer }      = require('./utils/nsfwScanner');
const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const _strictGuard = require('./utils/strictGuard');
const _antiGM = require('./utils/antiGroupMention');
const _antiUB = require('./utils/antiUserbot');
const _nsfwShield = require('./utils/nsfwShield');
const { isAutoStatusEnabled, isStatusReactEnabled, pickStatusEmoji } = require('./utils/autostatusConfig');
const channelReact = require('./utils/channelReact');
const {
  getPending: getAntifakePending,
  addPending: addAntifakePending,
  setVoiceReceived: setAntifakeVoiceReceived,
  findKey: _antifakeFindKey,
  removePending: _antifakeRemove,
} = require('./utils/antifakeState');

// ── PERF #3: Concurrency tuned for Render Free (512 MB / 1 vCPU) ──────────────
const MAX_CONCURRENT = 16;  // balanced for speed without thrashing
const QUEUE_CAP      = 80;  // higher cap for burst handling
let   activeHandlers = 0;
const pendingQueue   = [];

// ── Auto Re-Add: anti-loop cooldown (60 s per user per group) ─────────────────
// Key = "groupId:userJid", Value = timestamp of last re-add attempt
const reAddCooldown = new Map();

// Hard ceiling on a single message's processing time. Without this, if any
// command's network call hangs forever (no timeout of its own), it
// permanently occupies one of the MAX_CONCURRENT slots — and over enough
// hours, enough such hangs can exhaust ALL slots, leaving the bot connected
// to WhatsApp (socket fine) but silently unresponsive to every command.
const TASK_HARD_TIMEOUT_MS = 90_000; // 90s — generous for even slow downloads

function runWithQueue(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      activeHandlers++;
      let slotReleased = false;
      const releaseSlot = () => {
        if (slotReleased) return; // never release the same slot twice
        slotReleased = true;
        activeHandlers--;
        if (pendingQueue.length > 0) pendingQueue.shift()();
      };

      const timeoutTimer = setTimeout(() => {
        console.error('[Queue] ⏱️ Task exceeded 90s hard timeout — releasing its slot');
        releaseSlot();
        reject(new Error('Task timed out after 90s'));
      }, TASK_HARD_TIMEOUT_MS);

      Promise.resolve()
        .then(fn)
        .then((val) => { clearTimeout(timeoutTimer); if (!slotReleased) { releaseSlot(); resolve(val); } })
        .catch((err) => { clearTimeout(timeoutTimer); if (!slotReleased) { releaseSlot(); reject(err); } });
    };
    if (activeHandlers < MAX_CONCURRENT) {
      task();
    } else {
      if (pendingQueue.length >= QUEUE_CAP) pendingQueue.shift(); // drop oldest
      pendingQueue.push(task);
    }
  });
}

// ── PERF #5: Tightened cache constants ────────────────────────────────────────
const CACHE_TTL         = 300_000;   // 5 min — fewer live fetches, faster responses
const MAX_CACHE_SZ      = 400;
const MAX_WARN_SZ       = 500;
const MSG_CACHE_TTL     = 25 * 60 * 1000;
const MAX_MSG_CACHE     = 3000;
const RESTORED_TTL      = 40 * 60 * 1000;
const MAX_RESTORED_SZ   = 4000;
const MAX_LID_CACHE_SZ  = 3000;
const AUTO_REACT_COOLDOWN = 3000;    // faster emoji reactions
const CHANNEL_REACT_SEEN_TTL = 30 * 60 * 1000;

const groupMetadataCache   = new Map();
const linkWarnings         = new Map();
const middleFingerWarnings = new Map();
const userMsgRate          = new Map();
const userRepeatMsg        = new Map();
const msgCache             = new Map();
const restoredMessages     = new Map();
const autoReactLastSent    = new Map();
const channelReactSeen     = new Map();
const lidMappingCache      = new Map();

// ── PERF #5: Cleanup runs every 5 min (was 10) — keeps RAM lean ───────────────
setInterval(() => {
  try {
    const now = Date.now();
    const evict = (map, maxSz) => {
      if (map.size > maxSz) {
        const overflow = map.size - maxSz;
        let n = 0;
        for (const k of map.keys()) { if (n++ >= overflow) break; map.delete(k); }
      }
    };

    for (const [k, v] of groupMetadataCache) if (now - v.timestamp > CACHE_TTL * 4) groupMetadataCache.delete(k);
    evict(groupMetadataCache, MAX_CACHE_SZ);

    for (const map of [linkWarnings, middleFingerWarnings]) evict(map, MAX_WARN_SZ);

    for (const [k, ts] of autoReactLastSent) if (now - ts > AUTO_REACT_COOLDOWN * 10) autoReactLastSent.delete(k);
    for (const [k, ts] of channelReactSeen) if (now - ts > CHANNEL_REACT_SEEN_TTL) channelReactSeen.delete(k);

    for (const [k, v] of userMsgRate)   if (now - v.windowStart > 30_000) userMsgRate.delete(k);
    for (const [k, v] of userRepeatMsg) if (now - (v.lastTime || 0) > 60_000) userRepeatMsg.delete(k);

    for (const [k, v] of msgCache) if (now - v.timestamp > MSG_CACHE_TTL) msgCache.delete(k);
    evict(msgCache, MAX_MSG_CACHE);

    for (const [k, ts] of restoredMessages) if (now - ts > RESTORED_TTL) restoredMessages.delete(k);
    evict(restoredMessages, MAX_RESTORED_SZ);

    evict(lidMappingCache, MAX_LID_CACHE_SZ);

    // Clean up bot-admin cache (groups where bot is no longer present)
    for (const [k, v] of _botAdminCache) if (now - v.ts > BOT_ADMIN_TTL * 10) _botAdminCache.delete(k);

    // Invalidate banned users cache so it reloads fresh next command
    if (_bannedCache && now - _bannedCacheTs > BANNED_CACHE_TTL) { _bannedCache = null; _bannedCacheTs = 0; }
  } catch (_) {}
}, 5 * 60 * 1000).unref();

const commands = loadCommands();

const { handleCompetitorBot } = require('./utils/antiBot');
// handleNsfwShield intentionally NOT used — inline always-on NSFW shield handles this fully

const ANTIUSERBOT_VIDEO_PATH = path.join(__dirname, 'data', 'antiuserbot-alert.mp4');

// ── Module-level requires for hot-path modules (Node caches, but avoid repeated lookups) ──
let _autoReactModule = null;
const getAutoReact = (botId) => {
  try {
    if (!_autoReactModule) _autoReactModule = require('./utils/autoReact');
    return _autoReactModule.load ? _autoReactModule.load(botId) : null;
  } catch { return null; }
};

let _chatbotModule = null;
const getChatbot = () => {
  try {
    if (!_chatbotModule) _chatbotModule = require('./commands/admin/chatbot');
    return _chatbotModule;
  } catch { return null; }
};

let _bombModule = null;
const getBomb = () => {
  try {
    if (!_bombModule) _bombModule = require('./commands/fun/bomb');
    return _bombModule;
  } catch { return null; }
};

let _tttModule = null;
const getTtt = () => {
  try {
    if (!_tttModule) _tttModule = require('./commands/fun/tictactoe');
    return _tttModule;
  } catch { return null; }
};

// ── Banned users cache — avoid per-command synchronous file reads ──────────────
let _bannedCache = null;
let _bannedCacheTs = 0;
const BANNED_CACHE_TTL = 60_000; // refresh every 60 s
const getBannedUsers = () => {
  const now = Date.now();
  if (_bannedCache && now - _bannedCacheTs < BANNED_CACHE_TTL) return _bannedCache;
  try {
    const p = path.join(__dirname, 'data', 'banned.json');
    _bannedCache = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  } catch { _bannedCache = []; }
  _bannedCacheTs = now;
  return _bannedCache;
};

// ── HARD-LOCKED owner — only 923196615238 is ever the owner ──────────────────
// No dynamic session logic. No .map(). No config array traversal per message.
const OWNER_NUMBER = '923196615238';

const isOwnerNumber   = (n) => String(n).replace(/[^0-9]/g, '') === OWNER_NUMBER;
const getOwnerPhone   = () => OWNER_NUMBER;
const getOwnerPhones  = () => [OWNER_NUMBER];
const getOwnerJid     = () => `${OWNER_NUMBER}@s.whatsapp.net`;
const getOwnerJids    = () => [`${OWNER_NUMBER}@s.whatsapp.net`];

const OWNER_ONLINE_TTL = 5 * 60 * 1000;
let ownerLastSeenOnline = 0;

// ── Message content unwrapper ─────────────────────────────────────────────────
const getMessageContent = (msg) => {
  if (!msg?.message) return null;
  let m = msg.message;
  if (m.ephemeralMessage)           m = m.ephemeralMessage.message;
  if (m.viewOnceMessageV2)          m = m.viewOnceMessageV2.message;
  if (m.viewOnceMessage)            m = m.viewOnceMessage.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  return m;
};

// ── PERF #1: Group metadata — always cached first ─────────────────────────────
const getCachedGroupMetadata = async (sock, groupId) => {
  if (!groupId?.endsWith('@g.us')) return null;
  const cached = groupMetadataCache.get(groupId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  try {
    const metadata = await sock.groupMetadata(groupId);
    groupMetadataCache.set(groupId, { data: metadata, timestamp: Date.now() });
    return metadata;
  } catch (err) {
    const is403 = err.message?.includes('forbidden') || err.message?.includes('403') ||
                  err.statusCode === 403 || err.data === 403;
    if (is403) { groupMetadataCache.set(groupId, { data: null, timestamp: Date.now() }); return null; }
    return cached?.data ?? null;
  }
};

// getLiveGroupMetadata only used when we MUST have fresh admin list (bot admin check, once per msg)
const getLiveGroupMetadata = async (sock, groupId) => {
  try {
    const metadata = await sock.groupMetadata(groupId);
    groupMetadataCache.set(groupId, { data: metadata, timestamp: Date.now() });
    return metadata;
  } catch {
    return groupMetadataCache.get(groupId)?.data ?? null;
  }
};

const getGroupMetadata = getCachedGroupMetadata;

const isMod = (sender) => database.isModerator(sender.split('@')[0]);

// ── LID utilities ─────────────────────────────────────────────────────────────
const getLidMappingValue = (user, direction) => {
  if (!user) return null;
  const cacheKey = `${direction}:${user}`;
  if (lidMappingCache.has(cacheKey)) return lidMappingCache.get(cacheKey);

  const suffix   = direction === 'pnToLid' ? '.json' : '_reverse.json';
  const filename = `lid-mapping-${user}${suffix}`;
  const searchDirs = [];

  const sessionsBase = path.join(__dirname, 'sessions');
  try {
    if (fs.existsSync(sessionsBase)) {
      for (const entry of fs.readdirSync(sessionsBase)) {
        if (entry.startsWith('session_')) searchDirs.push(path.join(sessionsBase, entry));
      }
    }
  } catch (_) {}
  searchDirs.push(path.join(__dirname, config.sessionName || 'session'));

  for (const dir of searchDirs) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw   = fs.readFileSync(filePath, 'utf8').trim();
      const value = raw ? JSON.parse(raw) : null;
      if (value != null) { lidMappingCache.set(cacheKey, value); return value; }
    } catch (_) {}
  }
  lidMappingCache.set(cacheKey, null);
  return null;
};

const normalizeJidWithLid = (jid) => {
  if (!jid) return jid;
  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) return `${jid.split(':')[0].split('@')[0]}@s.whatsapp.net`;
    let user   = decoded.user;
    let server = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
    const mapToPn = () => {
      const pnUser = getLidMappingValue(user, 'lidToPn');
      if (pnUser) { user = pnUser; server = server === 'hosted.lid' ? 'hosted' : 's.whatsapp.net'; return true; }
      return false;
    };
    if (server === 'lid' || server === 'hosted.lid') mapToPn();
    else if (server === 's.whatsapp.net' || server === 'hosted') mapToPn();
    return server === 'hosted' ? jidEncode(user, 'hosted') : jidEncode(user, 's.whatsapp.net');
  } catch { return jid; }
};

const buildComparableIds = (jid) => {
  if (!jid) return [];
  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) return [normalizeJidWithLid(jid)].filter(Boolean);
    const variants = new Set();
    const ns = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
    variants.add(jidEncode(decoded.user, ns));
    if (ns === 's.whatsapp.net' || ns === 'hosted') {
      const lidUser = getLidMappingValue(decoded.user, 'pnToLid');
      if (lidUser) variants.add(jidEncode(lidUser, ns === 'hosted' ? 'hosted.lid' : 'lid'));
    } else if (ns === 'lid' || ns === 'hosted.lid') {
      const pnUser = getLidMappingValue(decoded.user, 'lidToPn');
      if (pnUser) variants.add(jidEncode(pnUser, ns === 'hosted.lid' ? 'hosted' : 's.whatsapp.net'));
    }
    return Array.from(variants);
  } catch { return [jid]; }
};

const findParticipant = (participants = [], userIds) => {
  const targets = (Array.isArray(userIds) ? userIds : [userIds])
    .filter(Boolean)
    .flatMap(id => buildComparableIds(id));
  if (!targets.length) return null;
  return participants.find(p => {
    if (!p) return false;
    const pIds = [p.id, p.lid, p.userJid].filter(Boolean).flatMap(id => buildComparableIds(id));
    return pIds.some(id => targets.includes(id));
  }) || null;
};

// ── PERF #1: isAdmin — uses passed-in metadata (cached). NO live fetch. ───────
const isAdmin = async (sock, participant, groupId, groupMetadata = null) => {
  if (!participant || !groupId?.endsWith('@g.us')) return false;

  // Use whatever metadata was passed in; if missing, fetch cached (not live).
  const meta = groupMetadata?.participants
    ? groupMetadata
    : await getCachedGroupMetadata(sock, groupId);
  if (!meta?.participants) return false;

  const found = findParticipant(meta.participants, participant);
  if (found) return found.admin === 'admin' || found.admin === 'superadmin';

  const senderUser = participant.split('@')[0].split(':')[0];
  let senderPhone = senderUser;
  if (participant.includes('@lid') || participant.includes('@hosted.lid')) {
    const resolved = getLidMappingValue(senderUser, 'lidToPn');
    if (resolved) senderPhone = String(resolved);
  }

  const fallback = meta.participants.find(p => {
    const pid = (p.id || '').split('@')[0].split(':')[0];
    if (!pid) return false;
    if (pid === senderPhone || pid === senderUser) return true;
    if ((p.id || '').includes('@lid')) {
      const rp = getLidMappingValue(pid, 'lidToPn');
      if (rp && String(rp) === senderPhone) return true;
    }
    return false;
  });

  return fallback ? fallback.admin === 'admin' || fallback.admin === 'superadmin' : false;
};

// ── PERF #1: isBotAdmin — live fetch with short-lived cache ──────────────────
const _botAdminCache = new Map(); // `${botNumber}|${groupId}` → { result, ts }   (PER BOT — bots must never share this)
const _baKey = (sock, groupId) => `${String(sock?.user?.id || '').split(':')[0].split('@')[0]}|${groupId}`;
const BOT_ADMIN_TTL  = 120_000;  // 2 min — balanced: fast enough without hammering WhatsApp API

// Forcibly expire a group's bot-admin cache entry (call on promote/demote events)
const invalidateBotAdminCache = (groupId) => { for (const k of [..._botAdminCache.keys()]) if (k.endsWith('|' + groupId)) _botAdminCache.delete(k); };

const _leader = require('./utils/groupLeader');
_leader.init({ findParticipant, eligible: (s) => !database.getBotSetting(s.user?.id, 'selfMode', config.selfMode || false) });
const isBotAdmin = async (sock, groupId, _groupMetadata = null) => {
  // _groupMetadata parameter is intentionally IGNORED here.
  // We never trust a passed-in (potentially stale) metadata for the bot's own
  // admin status — we always hit the live API (then cache for 20 s).
  if (!sock.user || !groupId?.endsWith('@g.us')) return false;

  const _k = _baKey(sock, groupId);
  const cached = _botAdminCache.get(_k);
  if (cached && Date.now() - cached.ts < BOT_ADMIN_TTL) return cached.result;

  try {
    const botRawId = sock.user.id;
    if (!botRawId) return false;
    const botNum   = botRawId.split(':')[0].split('@')[0];   // pure phone number
    const botPnId  = botNum + '@s.whatsapp.net';
    const botJids  = [botRawId, botPnId];
    if (sock.user.lid) botJids.push(sock.user.lid);

    // ALWAYS fetch live — this is the only way to get the current admin status.
    // getLiveGroupMetadata also refreshes the groupMetadataCache as a side-effect.
    const meta = await getLiveGroupMetadata(sock, groupId);
    if (!meta?.participants) {
      _botAdminCache.set(_k, { result: false, ts: Date.now() });
      return false;
    }

    // Pass 1: use the full findParticipant (handles LID ↔ phone mapping)
    let p = findParticipant(meta.participants, botJids);

    // Pass 2: numeric fallback — strip everything after @ and : then compare
    if (!p) {
      p = meta.participants.find(p2 => {
        const pid = (p2.id || '').split(':')[0].split('@')[0];
        if (pid === botNum) return true;
        // Try resolving LID to phone number
        if ((p2.id || '').includes('@lid')) {
          const resolved = getLidMappingValue(pid, 'lidToPn');
          if (resolved && String(resolved) === botNum) return true;
        }
        return false;
      });
    }

    // Pass 3: if sock.user.lid exists compare that too
    if (!p && sock.user.lid) {
      const lidNum = sock.user.lid.split(':')[0].split('@')[0];
      p = meta.participants.find(p2 => {
        const pid = (p2.id || '').split(':')[0].split('@')[0];
        return pid === lidNum;
      });
    }

    const result = !!(p && (p.admin === 'admin' || p.admin === 'superadmin'));
    _botAdminCache.set(_k, { result, ts: Date.now() });
    console.log(`[BOTADMIN] ${groupId.split('@')[0]} → bot admin=${result} (participant=${p?.id ?? 'not found'})`);
    return result;
  } catch (err) {
    console.error('[BOTADMIN] Error:', err.message);
    return false;
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const isSystemJid = (jid) => {
  if (!jid) return true;
  return jid.includes('@broadcast') || jid.includes('status.broadcast') ||
         jid.includes('@newsletter') || jid.includes('@newsletter.');
};

// ── NSFW enforcement — delete + immediate kick, owner hard-coded exception ────
const enforceNsfw = async (sock, msg, from, sender, groupMetadata, reason) => {
  // Step 1: Delete the message immediately, no matter what
  try {
    await sock.sendMessage(from, {
      delete: { remoteJid: from, fromMe: false, id: msg.key.id, participant: msg.key.participant || sender }
    });
  } catch (_) {}

  // Step 2: Hard-coded owner guard — NEVER kick 923196615238
  const _resolvedSender = normalizeJidWithLid(sender);
  const senderNum = _resolvedSender.split('@')[0].split(':')[0];
  const rawSenderNum = sender.split('@')[0].split(':')[0];
  if (senderNum === '923196615238' || rawSenderNum === '923196615238') return;

  const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
  if (botIsAdmin) {
    try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {}
    try {
      await sock.sendMessage(from, {
        text: `🚫 *NSFW Content — User Removed*\n\n@${sender.split('@')[0]} has been removed.\n\n📌 Reason: ${reason}\n🛡️ NSFW protection active.`,
        mentions: [sender]
      });
    } catch (_) {}
  } else {
    try {
      await sock.sendMessage(from, {
        text: `⚠️ *NSFW Content Detected & Deleted*\n\n@${sender.split('@')[0]}\n📌 Reason: ${reason}\n⚠️ Bot needs admin rights to remove the user.`,
        mentions: [sender]
      });
    } catch (_) {}
  }
};

// ── Bot signature patterns ────────────────────────────────────────────────────
const BOT_SIGNATURES = _antiUB.BOT_SIGNATURES;

// ── Rate tracker ──────────────────────────────────────────────────────────────
const RATE_WINDOW_MS = 5_000;   // 10s → 5s: tighter flood window
const RATE_MAX_MSG   = 4;       // 8 → 4: fewer msgs allowed before flag
const REPEAT_MAX     = 2;       // 5 → 2: 2 identical msgs = instant flag

const updateAndCheckRate = (sender, textBody) => {
  const now  = Date.now();
  const rate = userMsgRate.get(sender) || { count: 0, windowStart: now };
  if (now - rate.windowStart > RATE_WINDOW_MS) { rate.count = 1; rate.windowStart = now; }
  else rate.count++;
  userMsgRate.set(sender, rate);
  if (rate.count > RATE_MAX_MSG) return { flagged: true, reason: 'Message flood (spam bot)' };

  if (textBody?.length > 5) {
    const rep = userRepeatMsg.get(sender) || { lastText: '', count: 0, lastTime: 0 };
    rep.count  = rep.lastText === textBody ? rep.count + 1 : 1;
    rep.lastText = textBody;
    rep.lastTime = now;
    userRepeatMsg.set(sender, rep);
    if (rep.count >= REPEAT_MAX) return { flagged: true, reason: 'Repeated identical messages (bot pattern)' };
  }
  return { flagged: false, reason: '' };
};

// ── Main message handler ──────────────────────────────────────────────────────
// ── PER-BOT PREFIX ────────────────────────────────────────────────────────────
// `config.prefix` becomes a getter that answers with THIS bot's prefix while it handles a message
// (AsyncLocalStorage keeps the 5 bots from seeing each other's value). `.setprefix` stores it per bot.
const { AsyncLocalStorage } = require('async_hooks');
const _prefixALS  = new AsyncLocalStorage();
const _basePrefix = config.prefix || '.';
try {
  Object.defineProperty(config, 'prefix', {
    configurable: true, enumerable: true,
    get() { const s = _prefixALS.getStore(); return (s && s.prefix) || _basePrefix; },
    set() { /* prefix is per bot now — use .setprefix */ },
  });
} catch (_) {}
const getBotPrefix = (sock) => {
  try { const v = database.getBotSetting(sock?.user?.id, 'prefix', null); return (v && String(v).length <= 3) ? String(v) : _basePrefix; }
  catch (_) { return _basePrefix; }
};

const _botScope = require('./utils/botScope');
// one claim per (group, message): returns true only for the FIRST bot that claims it
const _cmdClaims = new Map();
const _claimCmd = (key) => {
  if (_cmdClaims.has(key)) return false;
  _cmdClaims.set(key, Date.now());
  if (_cmdClaims.size > 800) { const cut = Date.now() - 120000; for (const [k, t] of _cmdClaims) { if (t < cut) _cmdClaims.delete(k); } }
  return true;
};
const handleMessage = (sock, msg) => _botScope.run(sock, () => _prefixALS.run({ prefix: getBotPrefix(sock) }, () => _handleMessageInner(sock, msg)));
const _handleMessageInner = async (sock, msg) => {
  _leader.register(sock);
  try { require('./utils/channelTag').install(sock, config); } catch (_) {}   // channel tag sirf media par, text se hata do
  try { require('./utils/replyStyle').install(sock, config.botName); } catch (_) {}   // .replystyle: DP card on every quoted reply
  try {
    const MAIN_DEV_NUM = config.mainDeveloper || '923196615238';

    // ── Level 1: Main Developer (global super-admin) ─────────────────────────
    const isMainDeveloper = (sender) => {
      if (!sender) return false;
      const resolved = normalizeJidWithLid(sender);
      const num1 = resolved.split('@')[0].split(':')[0];
      const num2 = sender.split('@')[0].split(':')[0];
      return num1 === MAIN_DEV_NUM || num2 === MAIN_DEV_NUM;
    };

    // ── Level 2: Connected Bot Owner (phone whose session is running this bot) ─
    // The person who scanned QR / used pairing code — their digits == sock.user.id digits
    const isConnectedOwner = (sender) => {
      if (!sender || !sock.user?.id) return false;
      const botNum = String(sock.user.id).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      if (!botNum || botNum === MAIN_DEV_NUM) return false;
      const resolved   = normalizeJidWithLid(sender);
      const senderNum  = (resolved || sender).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      return senderNum === botNum;
    };

    // isOwner  = Level 1 OR Level 2  (regular ownerOnly commands)
    const isOwner     = (sender) => isMainDeveloper(sender) || isConnectedOwner(sender);
    // isSuperAdmin = Level 1 ONLY   (super-admin commands like broadcast, restart, etc.)
    const isSuperAdmin = (sender) => isMainDeveloper(sender);

    if (!msg.message) return;
    const from = msg.key.remoteJid;

    // ── Voice Bot mode: incoming voice note → transcribe → AI → voice reply ───
    // Fully self-contained and returns early, so it can't interfere with any
    // other message-handling logic below.
    if (from !== 'status@broadcast' && !msg.key.fromMe) {
      try {
        const content = getMessageContent(msg);
        const audioMsg = content?.audioMessage;
        if (audioMsg) {
          const botId = String(sock.user?.id || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || 'default';
          const voiceBotOn = database.getBotSetting(botId, `voicebot_${from}`, false);

          // In groups, respond only when the voice note is a reply to one of
          // the bot's own messages (otherwise every voice note in the group
          // would trigger a reply). In DMs, always respond.
          let shouldRespond = true;
          if (from.endsWith('@g.us')) {
            const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            const quotedParticipant = digits(audioMsg.contextInfo?.participant);
            const myIds = [digits(sock.user?.id), digits(sock.user?.lid)].filter(Boolean);
            shouldRespond = !!quotedParticipant && myIds.includes(quotedParticipant);
          }

          if (voiceBotOn && shouldRespond) {
            (async () => {
              // speak a short notice as a voice note (male voice); text only if TTS is down
              const _speakOrText = async (spoken, fallbackText) => {
                try {
                  const b = await require('./utils/ttsEngine').textToVoiceNote(spoken);
                  await sock.sendMessage(from, { audio: b, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
                } catch (_) {
                  try { await sock.sendMessage(from, { text: fallbackText }, { quoted: msg }); } catch (__) {}
                }
              };
              try {
                const audioBuffer = await downloadMediaMessage(msg, 'buffer', {});
                try { await sock.sendPresenceUpdate('recording', from); } catch (_) {}
                const stt = require('./utils/sttEngine');
                const transcript = await stt.transcribeAudio(audioBuffer, { language: config.voiceLanguage || 'hi' });
                console.log(`[VoiceBot] Heard: "${(transcript || '').slice(0, 80)}"`);
                // CJK / Hangul in the transcript means the language was misdetected
                if (!transcript || /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(transcript)) {
                  await _speakOrText('भाई, मुझे आपकी आवाज़ ठीक से समझ नहीं आई, ज़रा दोबारा बोलना।', '🎙️ Samajh nahi aaya, dobara bolein.');
                  return;
                }

                const _vSender = msg.key.participant || msg.key.remoteJid;
                const voiceRouter = require('./utils/voiceRouter');
                const aiEngine = require('./utils/aiEngine');
                const out = await voiceRouter.handleTranscript(transcript, _vSender, {
                  commands, askAI: aiEngine.askAI, isOwner: isOwner(_vSender),
                });

                if (out.type === 'command') {
                  // Run the real command exactly as if the person had typed it (permissions stay as usual).
                  console.log(`[VoiceBot] → ${config.prefix}${out.command} ${out.args}`);
                  try { await sock.sendMessage(from, { text: `🎙️ Samajh gaya → *${config.prefix}${out.command}${out.args ? ' ' + out.args : ''}*` }, { quoted: msg }); } catch (_) {}
                  const fake = {
                    key: { ...msg.key, id: 'VB' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), fromMe: false },
                    message: { conversation: `${config.prefix}${out.command}${out.args ? ' ' + out.args : ''}` },
                    pushName: msg.pushName,
                    messageTimestamp: Math.floor(Date.now() / 1000),
                  };
                  await handleMessageQueued(sock, fake);
                  return;
                }
                if (out.type !== 'speak') {
                  await _speakOrText('भाई, अभी थोड़ा busy हूँ, कुछ देर बाद दोबारा बोलना।', '😔 Abhi busy hoon, thodi der baad dobara voice bhejein.');
                  return;
                }

                const tts = require('./utils/ttsEngine');
                let voiceBuf = null;
                try { voiceBuf = await tts.textToVoiceNote(out.text); }
                catch (te) { console.error('[VoiceBot] TTS failed (male voice unavailable):', te.message); }
                if (voiceBuf) {
                  await sock.sendMessage(from, { audio: voiceBuf, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
                } else {
                  // never fall back to a female voice — send the answer as text instead
                  await sock.sendMessage(from, { text: out.text }, { quoted: msg });
                }
              } catch (e) {
                console.error('[VoiceBot] Error:', e.stack || e.message);
                try { await _speakOrText('भाई, कुछ गड़बड़ हो गई, ज़रा दोबारा बोलना।', '❌ Dobara try karein.'); } catch (_) {}
              }
            })();
            return; // don't fall through to normal text/command handling for this message
          }
        }
      } catch (e) {
        console.error('[VoiceBot] Pre-check error:', e.message);
      }
    }

    // ── Auto-status: view + react + log ──────────────────────────────────────
    if (from === 'status@broadcast') {
      const statusSender = msg.key.participant || msg.key.remoteJid;
      const _statusBotId = String(sock?.user?.id || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || null;

      // Only process if auto-status is enabled (via .autostatus on command)
      if (!isAutoStatusEnabled(_statusBotId)) return;

      try {
        // Mark status as SEEN (shows the blue eye to the sender)
        await sock.readMessages([{
          remoteJid  : 'status@broadcast',
          id         : msg.key.id,
          participant: statusSender,
          fromMe     : false
        }]);
      } catch (_) {}

      // React with 👀 only if react is enabled
      if (isStatusReactEnabled(_statusBotId)) {
        try {
          await sock.sendMessage('status@broadcast', {
            react: { text: pickStatusEmoji(_statusBotId), key: msg.key }
          }, { statusJidList: [statusSender] });
        } catch (_) {}
      }

      // Log for panel / admin review
      try {
        const statusContent = getMessageContent(msg);
        const statusText    = statusContent?.conversation ||
                              statusContent?.extendedTextMessage?.text ||
                              statusContent?.imageMessage?.caption ||
                              statusContent?.videoMessage?.caption || '';
        console.log(`[STATUS-VIEW] ${statusSender}: ${statusText.substring(0, 80) || '(media)'}`);

        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        const logPath = path.join(dataDir, 'status_log.json');
        let log = [];
        try { if (fs.existsSync(logPath)) log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch (_) {}
        log.push({
          sender   : statusSender,
          timestamp: Date.now(),
          text     : statusText || null,
          hasMedia : !!(statusContent?.imageMessage || statusContent?.videoMessage || statusContent?.audioMessage)
        });
        if (log.length > 500) log = log.slice(-500);
        fs.writeFile(logPath, JSON.stringify(log, null, 2), () => {});
      } catch (e) { console.error('[STATUS-VIEW]', e.message); }
      return;
    }

    // ── Configured Channel auto-react ────────────────────────────────────────
    // Newsletter posts are system messages and must never enter the normal
    // command/automation pipeline. Handle the explicitly configured reaction
    // before that guard, then stop processing this event.
    if (from?.includes('@newsletter')) {
      channelReact.handlePost(sock, msg);   // follows/reacts through the newsletter API
      return;
    }

    if (isSystemJid(from)) return;

    // ── Anti-delete: deletion events ──────────────────────────────────────────
    if (msg.message?.protocolMessage?.type === 0 && from.endsWith('@g.us')) {
      try {
        const deletedKey = msg.message.protocolMessage.key;
        const deletedId  = deletedKey?.id;
        if (deletedId && msgCache.has(deletedId)) {
          if (restoredMessages.has(deletedId)) { msgCache.delete(deletedId); return; }
          // `.antidelete off` in this group → don't restore anything (default = ON, as before)
          if (database.getGroupSettings(from).antiDeleteDisabled) { msgCache.delete(deletedId); return; }

          const groupMeta    = await getCachedGroupMetadata(sock, from).catch(() => null);
          const deleterJid   = msg.key.participant || msg.key.remoteJid;
          const deleterAdmin = groupMeta ? await isAdmin(sock, deleterJid, from, groupMeta).catch(() => false) : false;
          const deleterOwner = isOwner(deleterJid);

          if (deleterAdmin || deleterOwner) { msgCache.delete(deletedId); return; }

          restoredMessages.set(deletedId, Date.now());
          const cached = msgCache.get(deletedId);
          msgCache.delete(deletedId);

          const groupName = groupMeta?.subject || from.split('@')[0];
          const userName  = deleterJid.split('@')[0].split(':')[0];
          const cachedMsg = cached.msg;
          const cachedContent = cachedMsg.message?.ephemeralMessage?.message ||
                                cachedMsg.message?.viewOnceMessageV2?.message ||
                                cachedMsg.message?.viewOnceMessage?.message ||
                                cachedMsg.message?.documentWithCaptionMessage?.message ||
                                cachedMsg.message;

          const skip    = ['messageContextInfo', 'senderKeyDistributionMessage', 'protocolMessage'];
          const typeKey = cachedContent ? Object.keys(cachedContent).find(k => !skip.includes(k)) : null;

          const isImage   = typeKey === 'imageMessage';
          const isVideo   = typeKey === 'videoMessage';
          const isSticker = typeKey === 'stickerMessage';
          const isAudio   = typeKey === 'audioMessage';
          const isDoc     = typeKey === 'documentMessage';
          const isText    = typeKey === 'conversation' || typeKey === 'extendedTextMessage';

          const label = isImage ? 'Image' : isVideo ? 'Video' : isSticker ? 'Sticker' :
                        isAudio ? 'Audio' : isDoc ? 'Document' : 'Text';

          const textContent = cachedContent?.conversation ||
                              cachedContent?.extendedTextMessage?.text ||
                              cachedContent?.imageMessage?.caption ||
                              cachedContent?.videoMessage?.caption ||
                              cachedContent?.documentMessage?.caption || '';

          const header = `╔═══「 Anti Delete Alert 」═══╗\n👥 Group: ${groupName}\n👤 User: @${userName}\n📩 Type: ${label}\n`;
          const footer = `╚═══════════════════════╝\n\n⚡ Powered by 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭`;

          if (isText) {
            await sock.sendMessage(from, { text: `${header}📝 Message: ${textContent || '(empty)'}\n${footer}`, mentions: [deleterJid] });
          } else if (isImage || isVideo || isSticker || isAudio || isDoc) {
            let buf = null;
            try { buf = await downloadMediaMessage(cachedMsg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage }); } catch (_) {}
            const cap = `${header}${textContent ? `📝 Caption: ${textContent}\n` : ''}${footer}`;
            if (buf?.length > 0) {
              if (isImage)   await sock.sendMessage(from, { image: buf, caption: cap, mentions: [deleterJid] });
              else if (isVideo)   await sock.sendMessage(from, { video: buf, caption: cap, mentions: [deleterJid] });
              else if (isSticker) { await sock.sendMessage(from, { sticker: buf }); await sock.sendMessage(from, { text: cap, mentions: [deleterJid] }); }
              else if (isAudio)   { await sock.sendMessage(from, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true }); await sock.sendMessage(from, { text: cap, mentions: [deleterJid] }); }
              else if (isDoc) {
                const fn = cachedContent?.documentMessage?.fileName || 'document';
                const mt = cachedContent?.documentMessage?.mimetype || 'application/octet-stream';
                await sock.sendMessage(from, { document: buf, fileName: fn, mimetype: mt, caption: cap, mentions: [deleterJid] });
              }
            } else {
              await sock.sendMessage(from, { text: `${header}📝 Message: ⚠️ Media not available, but message was deleted.\n${footer}`, mentions: [deleterJid] });
            }
          }
        }
      } catch (e) { console.error('[AntiDelete]', e.message); }
      return;
    }

    // ── Auto-react (rate-limited, fire-and-forget) ────────────────────────────
    try {
      const jid = msg.key.remoteJid;
      const isNewsletter = jid?.includes('@newsletter');

      // Newsletter/channel posts are handled separately. A configured channel
      // gets one reaction per unique post; global auto-react never spills into
      // every channel by accident.
      if (isNewsletter && msg.message && !msg.key.fromMe) {
        channelReact.handlePost(sock, msg);
      } else {
        const arCfg = getAutoReact(sock.user?.id);
        if (arCfg?.enabled && msg.message && !msg.key.fromMe) {
          // cooldown is PER BOT (a shared key made only the first bot react)
          const _arKey   = `${String(sock.user?.id || '').split(':')[0].split('@')[0]}|${jid}`;
          const lastSent = autoReactLastSent.get(_arKey) || 0;
          const now      = Date.now();
          if (now - lastSent >= AUTO_REACT_COOLDOWN) {
            autoReactLastSent.set(_arKey, now);
            const c = msg.message.ephemeralMessage?.message || msg.message;
            const text = c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || c.documentMessage?.caption || '';
            const emojis = ['❤️','🖤','🤍','💛','💚','💙','💜','🧡','❤️‍🔥','💗','🔥','⚡','💥','💫','✨','🌟','💀','🦅','🦁','🐺','💎','👑','🏆','⚔️','🛡️','🔮','🪐','🚀','😎','🥶','😈','👿','🤯','😏'];
            const mode       = arCfg.mode || 'all';
            const fixedEmoji = arCfg.emoji || null;
            const rand       = emojis[Math.floor(Math.random() * emojis.length)];
            const isCmd      = ['.', '/', '!', '#'].includes(text?.trim()?.[0]);
            // If owner set a fixed emoji, always use it; otherwise fall back to mode logic
            const reactText  = fixedEmoji
              ? fixedEmoji
              : (mode === 'bot') ? (isCmd ? '⏳' : rand) : rand;
            sock.sendMessage(jid, { react: { text: reactText, key: msg.key } }).catch(() => {});
          }
        }
      }
    } catch (_) {}

    const content = getMessageContent(msg);
    let actualMessageTypes = [];
    if (content) {
      const skip = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
      actualMessageTypes = Object.keys(content).filter(k => !skip.includes(k));
    }

    // WhatsApp may deliver one-to-one chats with a LID JID (@lid) while also
    // providing the real phone JID in senderPn/participantPn. Prefer that
    // phone JID so public/private mode and owner checks behave consistently
    // for every contact, not only contacts using the legacy PN format.
    const incomingSender = msg.key.senderPn
      || msg.key.participantPn
      || msg.key.participant
      || msg.key.remoteJid;
    const sender = msg.key.fromMe
      ? sock.user.id.split(':')[0] + '@s.whatsapp.net'
      : incomingSender;
    const isGroup = from.endsWith('@g.us');

    // ── Anti-fake: a new member stays MUTED until an admin verifies with .ok ──
    // Only a voice note is allowed through (admins need to hear it); everything else
    // from a pending member is deleted. Admins/owners are never in the queue.
    if (isGroup && !msg.key.fromMe && content && database.getGroupSettings(from).antifake) {
      const _afIds = [sender, msg.key.participant, msg.key.participantPn, msg.key.senderPn];
      const _afKey = _antifakeFindKey(from, _afIds);
      if (_afKey) {
        if (content.audioMessage) {
          setAntifakeVoiceReceived(from, _afIds);
          try {
            await sock.sendMessage(from, {
              text: `🎙️ @${sender.split('@')[0]} ka verification voice note receive ho gaya. Admin *.ok @user* se verify karein.`,
              mentions: [sender],
            });
          } catch (_) {}
          return;   // voice stays visible for admins; nothing else to do
        }
        try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
        const _now = Date.now();
        global.__afNotice = global.__afNotice || new Map();
        const _nk = from + ':' + _afKey;
        if (_now - (global.__afNotice.get(_nk) || 0) > 60_000) {
          global.__afNotice.set(_nk, _now);
          try {
            await sock.sendMessage(from, {
              text: `🔇 @${sender.split('@')[0]}, aap abhi *verify nahi hue*. Jab tak admin verify na kare aap message nahi bhej sakte.\n🎙️ Pehle ek chhota *voice note* bhejein.`,
              mentions: [sender],
            });
          } catch (_) {}
        }
        return;
      }
    }

    // PERF #1: Single cached fetch for the whole message lifecycle
    const groupMetadata = isGroup ? await getCachedGroupMetadata(sock, from) : null;
    // Several panel bots in one group → only ONE (the admin bot) acts on shared things (see utils/groupLeader.js)
    const _isLeader = isGroup ? _leader.isLeader(sock, from, groupMetadata) : true;
    // Resolve bot-admin status ONCE per message — use cache aggressively to avoid live fetches
    // Only fetch if cache is truly empty (first time for this group)
    const _msgBotAdmin = isGroup ? (() => {
      const cached = _botAdminCache.get(_baKey(sock, from));
      if (cached) return cached.result; // use cache without await — instant
      return false; // if no cache yet, assume false; watchdog/next message will warm it
    })() : false;

    // ── Anti-group-status — runs FIRST so a group-status post is always caught ──
    // (warning on the 1st post, removal on the 2nd; English notices. See utils/antiGroupMention.js)
    if (isGroup && !msg.key.fromMe) {
      try {
        if (_antiGM.detectGroupStatus(msg)) {
          const _consumed = await handleAntigroupmention(sock, msg, groupMetadata, { sender, senderIsOwner: isOwner(sender) });
          if (_consumed) return;
        }
      } catch (e) { console.error('[AntiGroupMention]', e); }
    }

    // ── Anti-delete (PERSONAL / DM): `.antideleteDM on` → deleted DM messages are sent to THIS bot's own chat ──
    if (msg.message?.protocolMessage?.type === 0 && !isGroup && !msg.key.fromMe) {
      try {
        const _dmBot = _botScope.id();
        const deletedId = msg.message.protocolMessage.key?.id;
        const cached = deletedId ? msgCache.get(deletedId) : null;
        if (cached && cached.dm && cached.bot === _dmBot) {
          msgCache.delete(deletedId);
          if (database.getBotSetting(_dmBot, 'antidelete_dm', false)) {
            const me = `${_dmBot}@s.whatsapp.net`;
            const who = String(cached.from || from).split('@')[0].split(':')[0];
            const cm = cached.msg;
            const cc = cm.message?.ephemeralMessage?.message || cm.message?.viewOnceMessageV2?.message ||
                       cm.message?.viewOnceMessage?.message || cm.message?.documentWithCaptionMessage?.message || cm.message;
            const skipK = ['messageContextInfo', 'senderKeyDistributionMessage', 'protocolMessage'];
            const tk = cc ? Object.keys(cc).find(k => !skipK.includes(k)) : null;
            const label = { imageMessage: 'Image', videoMessage: 'Video', stickerMessage: 'Sticker', audioMessage: 'Audio', documentMessage: 'Document' }[tk] || 'Text';
            const text = cc?.conversation || cc?.extendedTextMessage?.text || cc?.imageMessage?.caption ||
                         cc?.videoMessage?.caption || cc?.documentMessage?.caption || '';
            const name = cm.pushName ? `${cm.pushName} (+${who})` : `+${who}`;
            const head = `╔═══「 Anti Delete (DM) 」═══╗\n👤 From: ${name}\n📩 Type: ${label}\n`;
            const foot = `╚═══════════════════════╝\n\n⚡ Powered by 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭`;
            if (label === 'Text') {
              await sock.sendMessage(me, { text: `${head}📝 Message: ${text || '(empty)'}\n${foot}` });
            } else {
              let buf = null;
              try { buf = await downloadMediaMessage(cm, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage }); } catch (_) {}
              const cap = `${head}${text ? `📝 Caption: ${text}\n` : ''}${foot}`;
              if (buf?.length > 0) {
                if (tk === 'imageMessage') await sock.sendMessage(me, { image: buf, caption: cap });
                else if (tk === 'videoMessage') await sock.sendMessage(me, { video: buf, caption: cap });
                else if (tk === 'stickerMessage') { await sock.sendMessage(me, { sticker: buf }); await sock.sendMessage(me, { text: cap }); }
                else if (tk === 'audioMessage') { await sock.sendMessage(me, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true }); await sock.sendMessage(me, { text: cap }); }
                else await sock.sendMessage(me, { document: buf, fileName: cc?.documentMessage?.fileName || 'document', mimetype: cc?.documentMessage?.mimetype || 'application/octet-stream', caption: cap });
              } else {
                await sock.sendMessage(me, { text: `${head}📝 Message: ⚠️ Media not available, but message was deleted.\n${foot}` });
              }
            }
          }
        }
      } catch (e) { console.error('[AntiDeleteDM]', e.message); }
    }

    // ── Anti-delete: cache incoming messages ──────────────────────────────────
    if (isGroup && !msg.key.fromMe && msg.key.id) {
      try {
        const skip   = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
        const hasReal = Object.keys(msg.message || {}).some(k => !skip.includes(k));
        if (hasReal) msgCache.set(msg.key.id, { msg, from, sender, timestamp: Date.now() });
      } catch (_) {}
    }
    // remember profile names (for `.save`) + auto-save new private-chat senders (`.autosave`, per bot)
    try {
      const _ct = require('./utils/contactTools');
      _ct.noteMsg(sock, msg);
      if (!isGroup && !msg.key.fromMe && from !== 'status@broadcast') _ct.autoSaveDM(sock, msg, config);   // fire & forget
    } catch (_) {}

    // DM cache — only when this bot has `.antideleteDM on`
    if (!isGroup && !msg.key.fromMe && msg.key.id && from !== 'status@broadcast') {
      try {
        const _b = _botScope.id();
        if (database.getBotSetting(_b, 'antidelete_dm', false)) {
          const skip = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
          if (Object.keys(msg.message || {}).some(k => !skip.includes(k)))
            msgCache.set(msg.key.id, { msg, from, sender, timestamp: Date.now(), dm: true, bot: _b });
        }
      } catch (_) {}
    }

    // ── NSFW SHIELD — only when `.nsfw on` is set for this group (see utils/nsfwShield.js) ──
    try {
      if (isGroup && _isLeader && groupMetadata && !msg.key.fromMe && database.getGroupSettings(from).nsfw) {
        const _nsOwner = isOwner(sender) || isOwnerNumber(normalizeJidWithLid(sender).split('@')[0].split(':')[0]);
        const _nsAdmin = _nsOwner ? false : await isAdmin(sock, sender, from, groupMetadata);
        if (!_nsOwner && !_nsAdmin) {
          const _handled = await _nsfwShield.inspect(sock, msg, {
            from, sender, senderIsAdmin: _nsAdmin, senderIsOwner: _nsOwner,
            botIsAdmin: await isBotAdmin(sock, from, groupMetadata),
            download: (m) => downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage }),
          });
          if (_handled) return;
        }
      }
    } catch (e) { console.error('[NSFW]', e.message); }

    // ── Anti-UserBot — removes real bot accounts only (see utils/antiUserbot.js) ──
    try {
      if (isGroup && _isLeader && groupMetadata && !msg.key.fromMe && database.getGroupSettings(from).antiuserbot) {
        const _ubOwner = isOwner(sender);
        const _ubAdmin = _ubOwner ? false : await isAdmin(sock, sender, from, groupMetadata);
        if (!_ubOwner && !_ubAdmin) {
          const _gone = await _antiUB.inspect(sock, msg, {
            from, sender, senderIsAdmin: _ubAdmin, senderIsOwner: _ubOwner,
            botIsAdmin: await isBotAdmin(sock, from, groupMetadata),
          });
          if (_gone) return;
        }
      }
    } catch (e) { console.error('[BotDetector]', e.message); }

    // ── Anti-spam ─────────────────────────────────────────────────────────────
    try {
      if (isGroup && _isLeader && groupMetadata && !msg.key.fromMe) {
        const gs = database.getGroupSettings(from);
        if (gs.antiSpam) {
          const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
          const senderIsOwner = isOwner(sender);

          if (!senderIsAdmin && !senderIsOwner && _msgBotAdmin) {
            const rc = msg.message?.ephemeralMessage?.message || msg.message || {};
            const tb = [rc?.conversation, rc?.extendedTextMessage?.text, rc?.imageMessage?.caption, rc?.videoMessage?.caption]
                       .filter(Boolean).join(' ').trim();
            const { flagged, reason } = updateAndCheckRate(sender, tb);
            if (flagged) {
              try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
              try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {}
              try { await sock.sendMessage(from, { text: `🚫 *Spam Detected — User Removed*\n\n@${sender.split('@')[0]} removed.\n📌 ${reason}`, mentions: [sender] }); } catch (_) {}
            }
          }
        }
      }
    } catch (e) { console.error('[AntiSpam]', e.message); }

    // ── PERF #2: Competitor-bot shield — only for text/link message types ─────
    // NSFW is already handled above (inline always-on). handleNsfwShield removed.
    if (isGroup && groupMetadata && !msg.key.fromMe) {
      const compTypes = new Set(['extendedTextMessage','conversation']);
      if (actualMessageTypes.some(t => compTypes.has(t))) {
        try {
          const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
          handleCompetitorBot(sock, msg, groupMetadata, {
            sender, from, senderIsAdmin, senderIsOwner: isOwner(sender), botIsAdmin: _msgBotAdmin
          }).catch(() => {});
        } catch (_) {}
      }
    }

    // Anti-group mention
    if (isGroup) {
      try { await handleAntigroupmention(sock, msg, groupMetadata); }
      catch (e) { console.error('[AntiGroupMention]', e); }
    }

    if (isGroup) addMessage(from, sender);

    if (!content || actualMessageTypes.length === 0) return;

    // Button response (legacy buttons, template buttons, and native-flow quick replies)
    {
      const _bm = content.buttonsResponseMessage || msg.message?.buttonsResponseMessage;
      const _tb = content.templateButtonReplyMessage || msg.message?.templateButtonReplyMessage;
      const _ir = content.interactiveResponseMessage || msg.message?.interactiveResponseMessage;
      let buttonId = _bm?.selectedButtonId || _tb?.selectedId || null;
      if (!buttonId && _ir) { try { buttonId = JSON.parse(_ir.nativeFlowResponseMessage?.paramsJson || '{}').id || null; } catch (_) {} }
      if (buttonId) {
        const buildCtx = async () => ({
          from, sender, isGroup, groupMetadata,
          isOwner:    isOwner(sender),
          isAdmin:    await isAdmin(sock, sender, from, groupMetadata),
          isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
          isMod:      isMod(sender),
          prefix: config.prefix,
          reply:  (text)  => sock.sendMessage(from, { text }, { quoted: msg }),
          react:  (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
        });
        const cmdName = ({ btn_menu: 'menu', btn_ping: 'ping', btn_help: 'list', btn_list: 'list', btn_owner: 'owner' })[buttonId] || null;
        if (cmdName) { const cmd = commands.get(cmdName); if (cmd) await cmd.execute(sock, msg, [], await buildCtx()); return; }
      }
    }

    let body = (content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '').trim();

    // ── MAIN DEVELOPER bypass: his commands work on EVERY bot, whatever prefix that bot uses ──
    // accepted: the default prefix ('.'), this bot's own prefix, or NO prefix at all (first word = a real command, short message)
    if (body && !msg.key.fromMe && isSuperAdmin(sender) && !body.startsWith(config.prefix)) {
      try {
        const _first = body.split(/\s+/)[0].toLowerCase();
        if (body.startsWith(_basePrefix) && commands.has(body.slice(_basePrefix.length).split(/\s+/)[0].toLowerCase())) {
          body = config.prefix + body.slice(_basePrefix.length);                 // ".menu"  → this bot's prefix + menu
        } else if (commands.has(_first) && body.split(/\s+/).length <= 8) {
          body = config.prefix + body;                                           // "menu"   → prefix + menu
        }
      } catch (_) {}
    }

    // ── Strict Guard Layer 2 — message security (spam/command abuse) ──────────
    if (isGroup && _isLeader && !msg.key.fromMe) {   // leader only: the shared counters must count each message ONCE, not once per bot
      try {
        const _sgAdmin  = await isAdmin(sock, sender, from, groupMetadata);
        const _sgOwner  = isOwner(sender);
        const _sgResult = _strictGuard.checkStrictGuardMessage(from, sender, body, _sgAdmin, _sgOwner);
        if (_sgResult.blocked) {
          const _botAdm = await isBotAdmin(sock, from, groupMetadata);
          try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
          if (_sgResult.action === 'delete') return;   // already warned a moment ago → silent delete, no warning spam
          if (_sgResult.action === 'remove' && _botAdm) {
            try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {}
            try { await sock.sendMessage(from, { text: `🚫 *Strict Guard*\n@${sender.split('@')[0]} removed!\n📌 ${_sgResult.reason}`, mentions: [sender] }); } catch (_) {}
          } else {
            try { await sock.sendMessage(from, { text: `⚠️ *Strict Guard Warning*\n@${sender.split('@')[0]}\n📌 ${_sgResult.reason}`, mentions: [sender] }); } catch (_) {}
          }
          return;
        }
      } catch (_) {}
    }

    // ── Middle finger control ─────────────────────────────────────────────────
    if (isGroup && _isLeader && !msg.key.fromMe) {
      try {
        const mfEmojis = ['🖕','🖕🏻','🖕🏼','🖕🏽','🖕🏾','🖕🏿'];
        let hasMF = body ? mfEmojis.some(e => body.includes(e)) : false;
        if (!hasMF && content?.stickerMessage) {
          hasMF = mfEmojis.some(e => (content.stickerMessage.associatedEmoji || '').includes(e));
        }
        if (hasMF) {
          const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
          const senderIsOwner = isOwner(sender);
          if (!senderIsAdmin && !senderIsOwner) {
            try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
            const mfKey   = `${_botScope.id()}|${from}_${sender}`;
            const mfCount = (middleFingerWarnings.get(mfKey) || 0) + 1;
            middleFingerWarnings.set(mfKey, mfCount);
            if (mfCount === 1) {
              await sock.sendMessage(from, { text: `⚠️ @${sender.split('@')[0]} This emoji is not allowed here.`, mentions: [sender] }, { quoted: msg });
            } else {
              const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
              if (botIsAdmin) { try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {} }
              middleFingerWarnings.delete(mfKey);
              await sock.sendMessage(from, { text: `🚫 @${sender.split('@')[0]} removed for repeated use of prohibited emoji 🖕`, mentions: [sender] });
              await sock.sendMessage(from, { text: `❌ This emoji is NOT allowed while 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭 is active.` });
            }
            return;
          }
        }
      } catch (_) {}
    }

    // ── Muted-user: auto-delete their messages ───────────────────────────────
    if (isGroup && !msg.key.fromMe && !isOwner(sender)) {
      try {
        if (database.isMuted(from, sender)) {
          try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
          return; // silent delete — no warning message
        }
      } catch (_) {}
    }
    // ── Anti-all / anti-tag ───────────────────────────────────────────────────
    if (isGroup) {
      const gs = database.getGroupSettings(from);

      if (gs.antiall) {
        const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
        if (!senderIsAdmin && !isOwner(sender)) {
          if (await isBotAdmin(sock, from, groupMetadata)) {
            try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
            return;
          }
        }
      }

      if (gs.antitag && _isLeader && !msg.key.fromMe) {
        const ctx           = content.extendedTextMessage?.contextInfo;
        const mentioned     = ctx?.mentionedJid || [];
        const msgText       = body || content.imageMessage?.caption || content.videoMessage?.caption || '';
        const numericM      = msgText.match(/@\d{10,}/g) || [];
        const uniqueNumeric = new Set(numericM.map(m => m.replace('@', '')));
        const total         = Math.max(mentioned.length, uniqueNumeric.size);

        if (total >= 3) {
          try {
            const parts     = groupMetadata.participants || [];
            const threshold = Math.max(3, Math.ceil(parts.length * 0.5));
            const manyNum   = uniqueNumeric.size >= 10 || (uniqueNumeric.size >= 5 && uniqueNumeric.size >= threshold);
            if (total >= threshold || manyNum) {
              const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
              if (!senderIsAdmin && !isOwner(sender)) {
                const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
                // action chosen with `.antitag set warn | delete | kick`  (default: delete)
                await require('./utils/punish').apply(sock, msg, {
                  from, target: sender, botIsAdmin,
                  mode: gs.antitagAction || 'delete',
                  label: 'Anti-Tag', reason: 'Mass tagging (tagall) is not allowed',
                });
                return;
              }
            }
          } catch (e) { console.error('[AntiTag]', e); }
        }
      }
    }

    // ── AutoSticker ───────────────────────────────────────────────────────────
    if (isGroup) {
      const gs = database.getGroupSettings(from);
      if (gs.autosticker && (content?.imageMessage || content?.videoMessage) && !body.startsWith(config.prefix)) {
        try {
          const cmd = commands.get('sticker');
          if (cmd) {
            await cmd.execute(sock, msg, [], {
              from, sender, isGroup, groupMetadata,
              isOwner:    isOwner(sender),
              isAdmin:    await isAdmin(sock, sender, from, groupMetadata),
              isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
              isMod:      isMod(sender),
              reply:  (text)  => sock.sendMessage(from, { text }, { quoted: msg }),
              react:  (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
            });
            return;
          }
        } catch (e) { console.error('[AutoSticker]', e); }
      }
    }

    // ── Active game checks ────────────────────────────────────────────────────
    try {
      const bombModule = getBomb();
      if (bombModule?.gameState?.has(sender)) {
        const cmd = commands.get('bomb');
        if (cmd?.execute) {
          await cmd.execute(sock, msg, [], {
            from, sender, isGroup, groupMetadata,
            isOwner:    isOwner(sender),
            isAdmin:    await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod:      isMod(sender),
            reply:  (text)  => sock.sendMessage(from, { text }, { quoted: msg }),
            react:  (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
          return;
        }
      }
    } catch (_) {}

    try {
      const ttt = getTtt();
      if (ttt?.handleTicTacToeMove) {
        const inGame = Object.values(ttt.games || {}).some(r =>
          r.id.startsWith('tictactoe') && [r.game.playerX, r.game.playerO].includes(sender) && r.state === 'PLAYING'
        );
        if (inGame) {
          const handled = await ttt.handleTicTacToeMove(sock, msg, {
            from, sender, isGroup, groupMetadata,
            isOwner:    isOwner(sender),
            isAdmin:    await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod:      isMod(sender),
            reply:  (text)  => sock.sendMessage(from, { text }, { quoted: msg }),
            react:  (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
          if (handled) return;
        }
      }
    } catch (_) {}

    // ── Non-command branch ────────────────────────────────────────────────────
    if (!body.startsWith(config.prefix)) {
      // Yahan declare karein taaki dono jagah kaam kare
      const _msgCtx = content?.extendedTextMessage?.contextInfo || content?.imageMessage?.contextInfo || {};
      const isReplyMsg = !!(_msgCtx?.stanzaId || _msgCtx?.quotedMessage);

      if (isGroup && !msg.key.fromMe) {
        try {
          const _sn = sender.split('@')[0];
          const tb = body.trim();
          // Emoji reply fires for BOTH plain emoji sends AND emoji-in-reply — GROUP ONLY
          const _roast = require('./utils/emojiRoast').replyFor(from, tb, _sn);   // per-group on/off: .emojiroast
          if (_roast) {
            await sock.sendMessage(from, { text: _roast, mentions: [sender] }, { quoted: msg });
            return;
          }
        } catch (_) {}
      }
      // ── Islamic greeting: Salam auto-reply + Hi/Hello polite correction ────
      // Only fires when the message is a reply (quoted message context)
      if (isReplyMsg && !msg.key.fromMe) {
        try {
          const ig      = require('./utils/islamicGreeting');
          const handled = await ig.handleGreeting(sock, msg, body, sender, from);
          if (handled) return;
        } catch (_) {}
      }
      if (isGroup && _isLeader) { try { await handleAntilink(sock, msg, groupMetadata); } catch (e) { console.error('[AntiLink]', e); } }
      try {
        const chatbot = getChatbot();
        if (chatbot?.handleChatbotResponse) {
          await chatbot.handleChatbotResponse(sock, from, msg, body, sender, isOwner(sender));
        }
      } catch (cbErr) {
        console.error('[Chatbot] Error in handleChatbotResponse:', cbErr.message);
      }
      return;
    }

    // ── Command parsing ───────────────────────────────────────────────────────
    const args        = body.slice(config.prefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();
    let   command     = commands.get(commandName);

    // ── Inline .close / .open fallback (group lock/unlock) ───────────────────
    // If command loader didn't pick these up, handle them here directly
    if (!command && (commandName === 'close' || commandName === 'open')) {
      try {
        if (!isGroup) return sock.sendMessage(from, { text: '❌ Yeh command sirf group mein use ho sakta hai.' }, { quoted: msg });
        const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
        if (!senderIsAdmin && !isOwner(sender))
          return sock.sendMessage(from, { text: '❌ Sirf admins ya owner yeh command use kar sakte hain.' }, { quoted: msg });
        const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
        if (!botIsAdmin)
          return sock.sendMessage(from, { text: '❌ Bot ko admin banana parhega pehle.' }, { quoted: msg });
        const setting = commandName === 'close' ? 'announcement' : 'not_announcement';
        await sock.groupSettingUpdate(from, setting);
        const msg2 = commandName === 'close'
          ? '🔒 *Group Closed!*\n\nAb sirf admins message bhej sakte hain.\n\n> _𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭_'
          : '🔓 *Group Opened!*\n\nAb sab members message bhej sakte hain.\n\n> _𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 𝐁𝐨𝐭_';
        return sock.sendMessage(from, { text: msg2 }, { quoted: msg });
      } catch (e) {
        return sock.sendMessage(from, { text: `❌ Error: ${e.message}` }, { quoted: msg });
      }
    }

    if (!command) return;

    try {
      if (!isOwner(sender) && database.isBanned(sender)) {
        return sock.sendMessage(from, {
          text: `🚫 *Tum ban ho!*\n\nTumhein bot commands use karne se ban kar diya gaya hai.\nOwner se contact karo unban ke liye.`,
        }, { quoted: msg });
      }
    } catch (_) {}

    // Per-session selfMode — each bot session has its own private/public setting
    const _sessionSelfMode = database.getBotSetting(sock.user?.id, 'selfMode', config.selfMode || false);
    if (_sessionSelfMode && !isOwner(sender)) return;
    if (command.superAdminOnly && !isSuperAdmin(sender))
      return sock.sendMessage(from, { text: '❌ *This command is reserved for Main Developer only.*' }, { quoted: msg });
    if (command.ownerOnly && !isOwner(sender))
      return sock.sendMessage(from, { text: config.messages.ownerOnly }, { quoted: msg });
    if (command.modOnly && !isMod(sender) && !isOwner(sender)) return sock.sendMessage(from, { text: '🔒 This command is only for moderators!' }, { quoted: msg });
    if (command.groupOnly && !isGroup)  return sock.sendMessage(from, { text: config.messages.groupOnly }, { quoted: msg });
    if (command.privateOnly && isGroup) return sock.sendMessage(from, { text: config.messages.privateOnly }, { quoted: msg });
    // Admin-type group commands: only the leader bot (the admin one) answers — the other bots stay silent.
    // Safety net: if the leader never answered (different prefix, self-mode, lagging socket …) the next bot takes over
    // after 2.5 s — so "only for group admins" / "Bot needs to be admin" is ALWAYS shown, exactly once.
    if (isGroup && (command.adminOnly || command.botAdminNeeded)) {
      const _ck = from + '|' + (msg.key.id || '');
      const _cmdLeader = _leader.isLeader(sock, from, groupMetadata, (s) => String(body).startsWith(getBotPrefix(s)));
      if (_cmdLeader) { _claimCmd(_ck); }
      else {
        await new Promise((r) => setTimeout(r, 2500));
        if (!_claimCmd(_ck)) return;          // the leader (or another bot) already handled it
      }
    }
    if (command.adminOnly && !(await isAdmin(sock, sender, from, groupMetadata)) && !isOwner(sender))
      return sock.sendMessage(from, { text: config.messages.adminOnly }, { quoted: msg });
    if (command.botAdminNeeded && !(await isBotAdmin(sock, from, groupMetadata)))
      return sock.sendMessage(from, { text: config.messages.botAdminNeeded }, { quoted: msg });

    if (config.autoTyping) sock.sendPresenceUpdate('composing', from).catch(() => {});

    const cmdCtx = {
      from, sender, isGroup, groupMetadata,
      isOwner:         isOwner(sender),
      isSuperAdmin:    isSuperAdmin(sender),
      isMainDeveloper: isMainDeveloper(sender),
      isConnectedOwner:isConnectedOwner(sender),
      botId:           sock.user?.id || null,
      isAdmin:    await isAdmin(sock, sender, from, groupMetadata),
      isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
      isMod:      isMod(sender),
      prefix:     config.prefix,
      downloadMedia: (m, type, opts) => downloadMediaMessage(m || msg, type || 'buffer', opts || {}, { reuploadRequest: sock.updateMediaMessage }),
      reply: (text)  => sock.sendMessage(from, { text }, { quoted: require('./utils/replyStyle').quoteFor(sock, msg, sender, config.botName) }),   // .replystyle: DP card on top of replies
      react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
    };

    console.log(`[CMD] ${commandName} ← ${sender}`);
    await command.execute(sock, msg, args, cmdCtx);

  } catch (error) {
    console.error('[Handler]', error);
    if (error.message?.includes('rate-overlimit')) return;
    try {
      // Jarvis monitor: log (redacted), auto-repair agent commands, and never show internals to normal users
      let _userText = `${config.messages.error}\n\nThodi der baad dobara try karo.`;   // no internals for users (monitor, when present, adds owner contact)
      try {
        const _jm = require('./utils/jarvisMonitor');
        const _isDev = (() => { try { const s = msg.key.participant || msg.key.remoteJid; const n = normalizeJidWithLid(s).split('@')[0].split(':')[0]; return n === (config.mainDeveloper || '923196615238'); } catch (_) { return false; } })();
        const _cmdName = (() => { try { const b = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''; return b.trim().slice(1).split(/\s+/)[0].toLowerCase(); } catch (_) { return ''; } })();
        const _safe = _jm.onCommandError({ commandName: _cmdName, error, sock, senderIsOwner: _isDev });
        if (_safe) _userText = _safe;
      } catch (_) {}
      await sock.sendMessage(msg.key.remoteJid, { text: _userText }, { quoted: msg });
    } catch (e) { if (!e.message?.includes('rate-overlimit')) console.error('[Handler send-error]', e); }
  }
};

// ── Group participant update handler ──────────────────────────────────────────
const handleGroupUpdate = async (sock, update) => {
  _leader.register(sock);
  try {
    const { id, participants, action } = update;
    if (!id?.endsWith('@g.us')) return;

    // Invalidate bot-admin cache whenever admin roster changes in this group
    if (action === 'promote' || action === 'demote' || action === 'add' || action === 'remove') {
      invalidateBotAdminCache(id);
    }

    // ── Strict Guard Layer 1 — role protection + KickAll detection ────────────
    if ((action === 'promote' || action === 'demote' || action === 'remove') && _leader.isLeader(sock, id)) {
      _strictGuard.handleStrictGuardEvent(sock, update).catch(() => {});
    }

    const gs = database.getGroupSettings(id);
    const groupMetadata = await getCachedGroupMetadata(sock, id);
    if (!groupMetadata) return;
    // welcome / goodbye / anti-fake notice / re-add: ONE bot per group (the admin one), not every bot
    if (!_leader.isLeader(sock, id, groupMetadata)) return;

    const getJid = (p) => typeof p === 'string' ? p : p?.id || p?.jid || p?.participant || null;

    const getDisplayName = async (pJid, pNum) => {
      let name = pNum;
      const info = groupMetadata.participants.find(p => {
        const pid = p.id || p.jid || p.participant;
        return pid === pJid || pid?.split('@')[0] === pNum;
      });
      let phoneJid = null;
      if (info?.phoneNumber) phoneJid = info.phoneNumber;
      else {
        try {
          const norm = normalizeJidWithLid(pJid);
          if (norm?.includes('@s.whatsapp.net')) phoneJid = norm;
        } catch (_) { if (pJid.includes('@s.whatsapp.net')) phoneJid = pJid; }
      }
      if (phoneJid && sock.store?.contacts?.[phoneJid]) {
        const c = sock.store.contacts[phoneJid];
        if (c.notify?.trim() && !c.notify.match(/^\d+$/)) name = c.notify.trim();
        else if (c.name?.trim() && !c.name.match(/^\d+$/)) name = c.name.trim();
      }
      if (name === pNum && info) {
        if (info.notify?.trim() && !info.notify.match(/^\d+$/)) name = info.notify.trim();
        else if (info.name?.trim() && !info.name.match(/^\d+$/)) name = info.name.trim();
      }
      return name;
    };

    for (const participant of participants) {
      const pJid = getJid(participant);
      if (!pJid) { console.warn('[GroupUpdate] missing JID:', participant); continue; }
      const pNum = pJid.split('@')[0];

      // ── Anti-fake voice verification queue ────────────────────────────────
      // Queue new non-owner members for explicit admin approval. This does
      // not delete normal messages or automatically kick genuine users.
      if (action === 'add' && gs.antifake && !isOwnerNumber(pNum)) {
        try {
          const _r = _strictGuard.resolveParticipant(groupMetadata, participant);
          let _ids = new Set([..._r.ids, pNum]);
          try { _ids = await _strictGuard.expandWithStore(sock, _ids); } catch (_) {}
          const _isAdm = _r.participant && (_r.participant.admin === 'admin' || _r.participant.admin === 'superadmin');
          if (!_isAdm) {
            addAntifakePending(id, pJid, { ids: [..._ids] });
            const botCanModerate = await isBotAdmin(sock, id, groupMetadata);
            await sock.sendMessage(id, {
              text:
                `🛡️ *Anti-Fake Verification*\n\n` +
                `@${pNum}, group mein welcome!\n` +
                `🔇 Jab tak verify nahi hote aap *muted* rahenge — aapke messages delete honge.\n` +
                `🎙️ Please ek short *voice note* bhejein. Admin sunkar *.ok @user* se verify karega.` +
                (botCanModerate ? '' : `\n\n⚠️ Bot admin nahi hai, isliye messages delete nahi ho sakte.`),
              mentions: [pJid],
            });
          }
        } catch (error) {
          console.warn(`[AntiFake] Could not queue ${pJid}: ${error.message}`);
        }
      }
      // member left / removed / became admin → no longer pending
      if (action === 'remove' || action === 'promote') {
        try {
          let _ids = new Set([pNum, pJid]);
          const _r2 = _strictGuard.resolveParticipant(groupMetadata, participant);
          _r2.ids.forEach(i => _ids.add(i));
          _antifakeRemove(id, [..._ids]);
        } catch (_) {}
      }

      // Bot-screen new joins
      if (action === 'add' && (gs.antibot || gs.antiuserbot) && !isOwnerNumber(pNum)) {
        try {
          const botIsAdmin = await isBotAdmin(sock, id, groupMetadata);
          if (botIsAdmin) {
            let isSuspect = false;
            let suspectReason = '';
            try {
              const status = await sock.fetchStatus(pJid);
              if (BOT_SIGNATURES.some(r => r.test(status?.status || ''))) {
                isSuspect = true; suspectReason = 'Bot signature in WhatsApp status';
              }
            } catch (_) {}
            if (isSuspect) {
              try { await sock.groupParticipantsUpdate(id, [pJid], 'remove'); } catch (_) {}
              try { await sock.sendMessage(id, { text: `🤖 *Bot Removed on Join*\n\n@${pNum} removed.\n📌 ${suspectReason}`, mentions: [pJid] }); } catch (_) {}
              continue;
            }
          }
        } catch (_) {}
      }

      if (action === 'add' && gs.welcome) {
        try {
          const name     = await getDisplayName(pJid, pNum);
          let   picUrl   = 'https://img.pyrocdn.com/dbKUgahg.png';
          try { picUrl = await sock.profilePictureUrl(pJid, 'image'); } catch (_) {}
          const gName    = groupMetadata.subject || 'the group';
          const gDesc    = groupMetadata.desc || 'No description';
          const time     = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
          const wMsg     = `╭╼━≪•𝙽𝙴𝚆 𝙼𝙴𝙼𝙱𝙴𝚁•≫━╾╮\n┃𝚆𝙴𝙻𝙲𝙾𝙼𝙴: @${name} 👋\n┃Member count: #${groupMetadata.participants.length}\n┃𝚃𝙸𝙼𝙴: ${time}⏰\n╰━━━━━━━━━━━━━━━╯\n\n*@${name}* Welcome to *${gName}*! 🎉\n*Group 𝙳𝙴𝚂𝙲𝚁𝙸𝙿𝚃𝙸𝙾𝙽*\n${gDesc}\n\n> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ${config.botName}*`;
          const apiUrl   = `https://api.some-random-api.com/welcome/img/7/gaming4?type=join&textcolor=white&username=${encodeURIComponent(name)}&guildName=${encodeURIComponent(gName)}&memberCount=${groupMetadata.participants.length}&avatar=${encodeURIComponent(picUrl)}`;

          // PERF #4: Hard 4 s timeout on external image API
          const imgRes = await axios.get(apiUrl, { responseType: 'arraybuffer', timeout: 4000 });
          await sock.sendMessage(id, { image: Buffer.from(imgRes.data), caption: wMsg, mentions: [pJid] });
        } catch (_) {
          const fallback = (gs.welcomeMessage || 'Welcome @user to @group! 👋')
            .replace('@user', `@${pNum}`).replace('@group', groupMetadata.subject || 'the group');
          try { await sock.sendMessage(id, { text: fallback, mentions: [pJid] }); } catch (_) {}
        }

      } else if (action === 'remove') {

        // ── Auto Re-Add ────────────────────────────────────────────────────────
        console.log(`[RE-ADD] remove event — group=${id.split('@')[0]} user=${pNum} readd=${gs.readd}`);
        if (gs.readd) {
          // ① Anti-loop guard: skip if this exact user was processed < 60 s ago
          const loopKey = `${id}:${pJid}`;
          const nowMs   = Date.now();
          if (reAddCooldown.has(loopKey) && nowMs - reAddCooldown.get(loopKey) < 60_000) {
            console.log(`[RE-ADD] Cooldown active for ${pNum} in ${id} — skipping`);
          } else {
            reAddCooldown.set(loopKey, nowMs);

            // Prune stale entries (older than 2 min) so the Map never grows unbounded
            if (reAddCooldown.size > 300) {
              const cutoff = nowMs - 120_000;
              for (const [k, t] of reAddCooldown.entries()) {
                if (t < cutoff) reAddCooldown.delete(k);
              }
            }

            // ② Bot must be admin to re-add anyone
            const botCanAdd = await isBotAdmin(sock, id, groupMetadata);
            if (!botCanAdd) {
              console.log(`[RE-ADD] Bot is not admin in ${id} — skipping`);
            } else {
              // ③ Wait 2–3 seconds (random) before re-adding
              await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));

              let reAddSuccess = false;
              try {
                const result = await sock.groupParticipantsUpdate(id, [pJid], 'add');
                // Baileys returns an array of { status, jid } — 200 means success
                reAddSuccess = Array.isArray(result) &&
                  result.some(r => String(r.status) === '200');
              } catch (_) {
                reAddSuccess = false;
              }

              if (reAddSuccess) {
                // ✅ SUCCESS — exact message as specified (do NOT change)
                try {
                  await sock.sendMessage(id, {
                    text:
                      `Bhagne Ke Liye Nahi Bola @${pNum} 😛 ,🥀𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 🌴 Ke 𝐏𝐞𝐫𝐦𝐢𝐬𝐬𝐢𝐨𝐧 Bagair Tum Kahin Nahi Ja Sakte 😄\n` +
                      `Dekho Maine Tumhe Phir C Add Kar Diya Hai 😄\n` +
                      `Baby meRe Hote Hue Tum Bagh Nahi Sakte 😂🤣`,
                    mentions: [pJid]
                  });
                } catch (_) {}
              } else {
                // ❌ FAIL — exact message as specified (do NOT change)
                try {
                  await sock.sendMessage(id, {
                    text:
                      `😏 @${pNum} bhaagne ki koshish to ki…\n` +
                      `Lekin system ne allow nahi kiya 😅\n` +
                      `Lagta hai tumhari privacy settings strong hain ya WhatsApp ne rok diya 😂\n` +
                      `Phir bhi yaad rakhna… yahan se bhaagna itna aasaan nahi 😛`,
                    mentions: [pJid]
                  });
                } catch (_) {}
              }
            }
          }
        } else if (gs.goodbye) {
          // ── Goodbye message (only when readd is OFF) ─────────────────────────
          try {
            const name   = await getDisplayName(pJid, pNum);
            let   picUrl = 'https://img.pyrocdn.com/dbKUgahg.png';
            try { picUrl = await sock.profilePictureUrl(pJid, 'image'); } catch (_) {}
            const gName  = groupMetadata.subject || 'the group';
            const apiUrl = `https://api.some-random-api.com/welcome/img/7/gaming4?type=leave&textcolor=white&username=${encodeURIComponent(name)}&guildName=${encodeURIComponent(gName)}&memberCount=${groupMetadata.participants.length}&avatar=${encodeURIComponent(picUrl)}`;
            const imgRes = await axios.get(apiUrl, { responseType: 'arraybuffer', timeout: 4000 });
            await sock.sendMessage(id, { image: Buffer.from(imgRes.data), caption: `Goodbye @${name} 👋 We will never miss you!`, mentions: [pJid] });
          } catch (_) {
            try { await sock.sendMessage(id, { text: `Goodbye @${pNum} 👋 We will never miss you! 💀`, mentions: [pJid] }); } catch (_) {}
          }
        }
      }
    }
  } catch (error) {
    const is403 = error.message?.includes('forbidden') || error.message?.includes('403') || error.statusCode === 403 || error.data === 403;
    if (!is403) console.error('[GroupUpdate]', error);
  }
};

// ── Anti-link ─────────────────────────────────────────────────────────────────
const handleAntilink = async (sock, msg, groupMetadata) => {
  try {
    const from   = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const gs     = database.getGroupSettings(from);
    if (!gs.antilink) return;

    const body = [msg.message?.conversation, msg.message?.extendedTextMessage?.text,
      msg.message?.imageMessage?.caption, msg.message?.videoMessage?.caption, msg.message?.documentMessage?.caption,
      msg.message?.ephemeralMessage?.message?.conversation, msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text,
    ].filter(Boolean).join(' ').trim();

    if (!body) return;
    if (!/chat\.whatsapp\.com\/[A-Za-z0-9]{5,}/i.test(body) && !/https?:\/\/[^\s]{4,}/i.test(body)) return;

    const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
    if (senderIsAdmin || isOwnerNumber(normalizeJidWithLid(sender).split('@')[0].split(':')[0]) || isOwnerNumber(sender.split('@')[0].split(':')[0])) return;

    const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
    // action chosen with `.antilink set warn | delete | kick`  (default: delete)
    await require('./utils/punish').apply(sock, msg, {
      from, target: sender, botIsAdmin,
      mode: gs.antilinkAction || 'delete',
      label: 'Anti-Link', reason: 'Links are not allowed in this group',
    });
  } catch (e) { console.error('[AntiLink]', e); }
};

// ── Anti-group mention ────────────────────────────────────────────────────────
const handleAntigroupmention = async (sock, msg, groupMetadata, opts = {}) => {
  try {
    const from   = msg.key.remoteJid;
    const sender = opts.sender || msg.key.participant || msg.key.remoteJid;
    const gs     = database.getGroupSettings(from);
    if (!gs.antigroupmention) return false;
    if (!_leader.isLeader(sock, from, groupMetadata)) return false;   // another panel bot in this group handles it

    // ── Group-status posts / group-status mentions → warn (1st) / remove (2nd) ──
    if (_antiGM.detectGroupStatus(msg)) {
      const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
      const senderIsOwner = typeof opts.senderIsOwner === 'boolean'
        ? opts.senderIsOwner
        : (isOwnerNumber(normalizeJidWithLid(sender).split('@')[0].split(':')[0]) || isOwnerNumber(sender.split('@')[0].split(':')[0]));
      const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
      return await _antiGM.enforce(sock, msg, {
        senderIsAdmin, senderIsOwner, botIsAdmin,
        mode: (gs.antigroupmentionMode || 'warn').toLowerCase(),
      });
    }

    // ── Legacy: forwarded-message detection (unchanged) ──

    let isForwarded = false;
    if (msg.message) {
      const m = msg.message;
      isForwarded = !!(m.groupStatusMentionMessage ||
        (m.protocolMessage?.type === 25) ||
        m.extendedTextMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
        m.imageMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
        m.videoMessage?.contextInfo?.forwardedNewsletterMessageInfo ||
        m.contextInfo?.forwardedNewsletterMessageInfo ||
        m.contextInfo?.isForwarded || m.contextInfo?.forwardingScore || m.contextInfo?.quotedMessageTimestamp ||
        m.extendedTextMessage?.contextInfo?.isForwarded || m.extendedTextMessage?.contextInfo?.forwardingScore);
    }
    if (!isForwarded) return false;

    const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
    if (senderIsAdmin || isOwnerNumber(normalizeJidWithLid(sender).split('@')[0].split(':')[0]) || isOwnerNumber(sender.split('@')[0].split(':')[0])) return false;

    const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
    const action     = (gs.antigroupmentionAction || 'delete').toLowerCase();

    if (action === 'kick' && botIsAdmin) {
      try { await sock.sendMessage(from, { delete: msg.key }); await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {}
    } else {
      try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
    }
  } catch (e) { console.error('[AntiGroupMention]', e); }
};

// ── Owner presence tracker ────────────────────────────────────────────────────
const initializeOwnerPresenceTracker = async (sock) => {
  for (const jid of getOwnerJids()) { try { await sock.presenceSubscribe(jid); } catch (_) {} }
  sock.ev.on('presence.update', ({ presences }) => {
    try {
      if (!presences) return;
      const phones = getOwnerPhones();
      for (const [jid, presence] of Object.entries(presences)) {
        const num = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        if (!phones.includes(num)) continue;
        const s = presence.lastKnownPresence;
        if (s === 'available' || s === 'composing' || s === 'recording') ownerLastSeenOnline = Date.now();
      }
    } catch (_) {}
  });
};

// ── Anti-call ─────────────────────────────────────────────────────────────────
// Runtime flag — can be toggled without restarting the bot.
// Default: read from config.js; the .anticall on/off command updates this live.
let _antiCallEnabled = !!(config.anticall);

const setAntiCall = (val) => {
  _antiCallEnabled = !!val;
  console.log(`[ANTICALL] ${_antiCallEnabled ? '✅ Enabled' : '❌ Disabled'} at runtime`);
};

const initializeAntiCall = (sock) => {
  try { require('./utils/contactTools').attach(sock); } catch (e) { console.warn('[contactTools] attach:', e.message); }
  // every connected bot follows the panel-wide channels and reacts with its own account
  try { require('./utils/versionChecker').watch(sock); } catch (e) { console.warn('[versionChecker] watch:', e.message); }
  try { channelReact.startSync(sock); } catch (e) { console.warn('[channelreact] startSync:', e.message); }
  sock.ev.on('call', async (calls) => {
    // Check live runtime flag — updated instantly by .anticall on/off command
    if (!_antiCallEnabled) return;
    try {
      for (const call of calls) {
        if (call.status === 'offer') {
          try { await sock.rejectCall(call.id, call.from); } catch (_) {}
          try {
            await sock.sendMessage(call.from, {
              text: '📵 *Calls are not allowed on this bot.*\n\nPlease use text commands instead.'
            });
          } catch (_) {}
        }
      }
    } catch (e) { console.error('[ANTICALL]', e); }
  });
};

// ── Queued entry point ────────────────────────────────────────────────────────
const handleMessageQueued = (sock, msg) =>
  runWithQueue(() => handleMessage(sock, msg));

// ── Hot-reload: rebuild the commands Map in the running process ───────────────
// Called by update.js after new files are downloaded so new commands work
// immediately — before the process even restarts.
const hotReloadCommands = () => {
  try {
    const fresh = loadCommands(true);   // hotReload=true clears require.cache first
    commands.clear();
    for (const [k, v] of fresh) commands.set(k, v);
    console.log(`[Handler] 🔄 Hot-reload complete — ${commands.size} commands registered`);
  } catch (e) {
    console.error('[Handler] Hot-reload error:', e.message);
  }
};

module.exports = {
  handleMessage: handleMessageQueued,
  handleGroupUpdate,
  handleAntilink,
  handleAntigroupmention,
  initializeAntiCall,
  setAntiCall,
  initializeOwnerPresenceTracker,
  hotReloadCommands,
  // HARD-LOCKED: only 923196615238 is the owner — sessionConfig is intentionally ignored
  isOwner: (sender) => isOwnerNumber(normalizeJidWithLid(sender).split('@')[0].split(':')[0]) || isOwnerNumber(sender.split('@')[0].split(':')[0]),
  isAdmin,
  isBotAdmin,
  isMod,
  getGroupMetadata,
  findParticipant
};
