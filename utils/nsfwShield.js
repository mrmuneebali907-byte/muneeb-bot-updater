'use strict';
/**
 * nsfwShield — runs ONLY when `.nsfw on` is set for that group (the old code ran in every group).
 *
 *  • Text / captions / links : whole-word match of clearly sexual words and adult sites.
 *      1st hit → message deleted + warning,   2nd hit (within 24 h) → deleted + removed.
 *  • Images (and video thumbnails): checked by a real moderation API *if one is configured*
 *      (Sightengine free plan — `.nsfw api <user> <secret>`). Confirmed explicit → deleted + removed.
 *      With no API key images are NOT judged: the old "skin-colour pixel" guess flagged beaches,
 *      sand, wood and faces. A wrong guess is worse than no guess.
 *  • Stickers : never judged (the old emoji rule flagged 🍑 💦 stickers that were harmless).
 *  Never touched: admins, owners, the bot itself. Any error → allow.
 */
const fs = require('fs');
const path = require('path');

const API_FILE    = path.join(__dirname, '..', 'data', 'nsfwApi.json');
const STRIKE_FILE = path.join(__dirname, '..', 'data', 'nsfwStrikes.json');
const STRIKE_TTL  = 24 * 3600 * 1000;
const IMG_MAX     = 5 * 1024 * 1024;
const VID_MAX     = 30 * 1024 * 1024;   // bigger videos: only their embedded thumbnail is checked

const digits = (v) => String(v || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const writeJson = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch (_) {} };

// ── API credentials (set by the owner with .nsfw api <user> <secret>) ────────────
// Owner's own Sightengine key (used only when no data/nsfwApi.json / env var is set)
const DEFAULT_API = { user: '', secret: '' };   // public repo: key lives in data/nsfwApi.json (or .nsfw api <user> <secret>)
function getApi() {
  const j = readJson(API_FILE, null);
  if (j?.user && j?.secret) return j;
  const u = process.env.SIGHTENGINE_USER, s = process.env.SIGHTENGINE_SECRET;
  if (u && s) return { user: u, secret: s };
  return DEFAULT_API.user && DEFAULT_API.secret ? DEFAULT_API : null;   // not configured -> no image judgement
}
function getApiRaw() { return readJson(API_FILE, null) || DEFAULT_API; }
/** setApi(null) removes it; setApi(user) keeps the stored secret; setApi(user, secret) replaces both */
function setApi(user, secret) {
  if (!user) { try { fs.unlinkSync(API_FILE); } catch (_) {} return; }
  const old = getApiRaw();
  writeJson(API_FILE, { user, secret: secret || old.secret || '' });
}

// ── text rules (whole words only: "cocktail", "Dickens", "Essex", "كسر" are safe) ──
const ADULT_DOMAINS = ['xnxx.com', 'xvideos.com', 'pornhub.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'brazzers.com',
  'onlyfans.com', 'fapello.com', 'thothub.tv', 'nudostar.com', 'nudogram.com', 'sexvid.xxx', 'beeg.com', 'hclips.com',
  'hdzog.com', 'drtuber.com', 'ah-me.com', 'rule34.xxx', 'nhentai.net', 'hentaihaven.xxx', 'hentai.tv', 'spankbang.com', 'eporner.com'];
const ADULT_WORDS = ['porn', 'porno', 'pornhub', 'xnxx', 'xvideos', 'xhamster', 'xxx', 'onlyfans', 'hentai', 'blowjob', 'handjob',
  'nudes', 'camgirl', 'sexting', 'sex video', 'sex videos', 'sex clip', 'sex tape', 'nude video', 'nude photo', 'nude pic',
  'nude pics', 'blue film', 'chudai', 'سكس', 'نيك', 'اباحي', 'إباحي'];
const WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${ADULT_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'iu');

function textHit(text) {
  if (!text) return null;
  const t = String(text).replace(/[\u200b-\u200f\u2060\ufeff]/g, '').toLowerCase();
  const d = ADULT_DOMAINS.find(x => t.includes(x));
  if (d) return `adult website link (${d})`;
  const m = t.match(WORD_RE);
  return m ? `explicit word "${m[0].trim()}"` : null;
}

// ── strikes ─────────────────────────────────────────────────────────────────
function addStrike(group, id) {
  const all = readJson(STRIKE_FILE, {}); const now = Date.now();
  const g = all[group] = all[group] || {};
  const cur = g[id] && now - g[id].ts < STRIKE_TTL ? g[id].n : 0;
  g[id] = { n: cur + 1, ts: now };
  for (const k of Object.keys(g)) if (now - g[k].ts > STRIKE_TTL) delete g[k];
  writeJson(STRIKE_FILE, all);
  return cur + 1;
}
function clearStrikes(group, id) {
  const all = readJson(STRIKE_FILE, {});
  if (all[group]) { if (id) delete all[group][id]; else delete all[group]; writeJson(STRIKE_FILE, all); }
}

// ── Sightengine ───────────────────────────────────────────────────────────────
let _lastApiErr = 0;
async function apiExplicit(buf) {
  const api = getApi();
  if (!api) return null;                       // not configured → no judgement
  try {
    const fd = new FormData();
    fd.append('media', new Blob([buf]), 'img.jpg');
    fd.append('models', 'nudity-2.1');
    fd.append('api_user', api.user);
    fd.append('api_secret', api.secret);
    const res = await fetch('https://api.sightengine.com/1.0/check.json', { method: 'POST', body: fd, signal: AbortSignal.timeout(10000) });
    const j = await res.json();
    if (j.status !== 'success') throw new Error(j.error?.message || `api status ${j.status}`);
    const n = j.nudity || {};
    const score = Math.max(n.sexual_activity || 0, n.sexual_display || 0, n.erotica || 0);
    return score >= 0.85 ? `explicit nudity (${Math.round(score * 100)}% confidence)` : false;
  } catch (e) {
    if (Date.now() - _lastApiErr > 3600_000) { _lastApiErr = Date.now(); console.log('[NSFW] image API unavailable:', e.message); }
    return null;                               // fail-open
  }
}


// ── video: 4 frames (one every 3 s) via ffmpeg → API; runs in a serial background queue ──
let _vq = Promise.resolve();
function extractFrames(videoPath, outDir) {
  return new Promise((resolve) => {
    let ff; try { ff = require('ffmpeg-static'); } catch (_) { ff = 'ffmpeg'; }
    require('child_process').execFile(ff,
      ['-y', '-v', 'error', '-t', '30', '-i', videoPath, '-vf', 'fps=1/3,scale=640:-2', '-frames:v', '4', '-q:v', '5', path.join(outDir, 'f_%d.jpg')],
      { timeout: 40000 },
      () => { try { resolve(fs.readdirSync(outDir).filter(f => f.endsWith('.jpg')).sort().map(f => path.join(outDir, f))); } catch (_) { resolve([]); } });
  });
}
async function scanVideo(msg, v, ctx) {
  const len = Number(v.fileLength || 0);
  const dir = path.join(process.cwd(), 'temp', 'nsfw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  try {
    // big / undownloadable video → thumbnail only
    if (len > VID_MAX) {
      const t = v.jpegThumbnail ? Buffer.from(v.jpegThumbnail) : null;
      return t && t.length > 800 ? await apiExplicit(t) : null;
    }
    const buf = await ctx.download(msg).catch(() => null);
    if (!buf || !buf.length) return null;
    fs.mkdirSync(dir, { recursive: true });
    const vp = path.join(dir, 'v.mp4'); fs.writeFileSync(vp, buf);
    const frames = await extractFrames(vp, dir);
    for (const f of frames) {
      const r = await apiExplicit(fs.readFileSync(f));
      if (r) return r;
    }
    return false;
  } catch (e) { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

const unwrap = (message) => {
  let m = message;
  for (let i = 0; m && i < 5; i++) {
    const w = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'].find(k => m[k]?.message);
    if (!w) break; m = m[w].message;
  }
  return m || {};
};

async function punish(sock, msg, ctx, reason, instant) {
  const { from, sender, botIsAdmin } = ctx;
  const target = msg.key.participant || sender;
  const mode = require('./punish').normMode(require('../database').getGroupSettings(from).nsfwMode, 'warn');   // .nsfw set warn | delete | kick
  const id = digits(target);
  if (mode === 'warn') {
    // 1st hit → delete + warning, 2nd hit (within 24 h) → delete + removed
    try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
    const strikes = addStrike(from, id);
    if (strikes < 2) {
      try {
        await sock.sendMessage(from, {
          text: `⚠️ *NSFW Warning*\n\n@${id}, adult content is not allowed in this group.\n📌 ${reason}\n🗑️ Message deleted. Next time you will be *removed*.`,
          mentions: [target],
        });
      } catch (_) {}
      return true;
    }
    clearStrikes(from, id);
    await require('./punish').apply(sock, msg, { from, target, botIsAdmin, mode: 'kick', label: 'NSFW', reason, deleteKey: null });
    return true;
  }
  await require('./punish').apply(sock, msg, { from, target, botIsAdmin, mode, label: 'NSFW', reason });
  return true;
}

/**
 * @param ctx { from, sender, senderIsAdmin, senderIsOwner, botIsAdmin, download:(msg)=>Promise<Buffer> }
 * @returns {Promise<boolean>} true if the message was handled (deleted)
 */
async function inspect(sock, msg, ctx) {
  try {
    if (!msg.message || msg.key.fromMe || ctx.senderIsAdmin || ctx.senderIsOwner) return false;
    const m = unwrap(msg.message);

    // text, captions, links
    const text = [m.conversation, m.extendedTextMessage?.text, m.imageMessage?.caption, m.videoMessage?.caption, m.documentMessage?.caption]
      .filter(Boolean).join(' ');
    const hit = textHit(text);
    if (hit) return await punish(sock, msg, ctx, `🔞 ${hit}`, false);

    // images → API only
    if (m.imageMessage && getApi()) {
      const len = Number(m.imageMessage.fileLength || 0);
      if (len && (len < 15_000 || len > IMG_MAX)) return false;
      const buf = await ctx.download(msg).catch(() => null);
      if (buf && buf.length >= 15_000 && buf.length <= IMG_MAX) {
        const r = await apiExplicit(buf);
        if (r) return await punish(sock, msg, ctx, `🔞 ${r}`, true);
      }
    } else if (m.videoMessage && getApi()) {
      // background: never delays the chat; one video at a time to protect RAM
      const vm = m.videoMessage;
      _vq = _vq.then(async () => {
        const r = await scanVideo(msg, vm, ctx);
        if (r) { console.log('[NSFW] adult video:', r); await punish(sock, msg, ctx, `🔞 ${r} (video)`, true); }
      }).catch(() => {});
    }
  } catch (e) { console.error('[NSFW]', e.message); }
  return false;
}

module.exports = { inspect, textHit, getApi, getApiRaw, setApi, clearStrikes };
