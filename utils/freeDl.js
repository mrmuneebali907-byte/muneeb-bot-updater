/**
 * freeDl — extra FREE download routes that don't depend on yt-dlp / YouTube cookies.
 *   • Piped + Invidious public instances (YouTube video/audio through THEIR IP, not ours)
 *   • Cobalt (only if COBALT_API_URL [+ COBALT_API_KEY] env is set)
 *   • JioSaavn public API (320 kbps songs — great for Hindi/Urdu/Punjabi)
 * Every function throws on failure so callers can fall through to the next tier.
 */
'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TOO_LARGE = () => Object.assign(new Error('FILE_TOO_LARGE'), { code: 'FILE_TOO_LARGE' });

const envList = (k) => (process.env[k] || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);

const PIPED_FALLBACK = [
  'https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de', 'https://api.piped.private.coffee',
  'https://pipedapi.leptons.xyz', 'https://pipedapi.nosebs.ru', 'https://piped-api.privacy.com.de',
];
const INVIDIOUS_FALLBACK = [
  'https://inv.nadeko.net', 'https://yewtu.be', 'https://invidious.nerdvpn.de',
  'https://invidious.privacyredirect.com', 'https://inv.tux.pizza',
];
const SAAVN_APIS = [...envList('SAAVN_APIS'),
  'https://saavn.dev/api', 'https://jiosaavn-api-privatecvc2.vercel.app', 'https://saavn.me',
];

// ── tiny HTTP helpers ────────────────────────────────────────────────────────
function request(url, { method = 'GET', headers = {}, body = null, timeout = 12000, redirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method, headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, timeout }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(request(new URL(res.headers.location, u).toString(), { method, headers, body, timeout, redirects: redirects - 1 }));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getJson(url, opts = {}) {
  const res = await request(url, opts);
  if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
  const chunks = []; let n = 0;
  for await (const c of res) { n += c.length; if (n > 4 * 1048576) throw new Error('response too big'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Stream a URL straight to disk (no RAM buffering). Rejects FILE_TOO_LARGE early. */
async function streamToFile(url, dest, { maxMB = 0, onProgress = null, stallMs = 45000, totalMs = 2400000 } = {}) {
  const res = await request(url, { timeout: 20000 });
  if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
  const type = String(res.headers['content-type'] || '');
  if (/text\/html|application\/json/i.test(type)) { res.resume(); throw new Error('not a media response'); }
  const total = +res.headers['content-length'] || 0;
  if (maxMB && total > maxMB * 1048576) { res.destroy(); throw TOO_LARGE(); }

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    let got = 0, lastPct = -1, done = false;
    const fail = (e) => { if (done) return; done = true; clearTimeout(stall); clearTimeout(hard); res.destroy(); out.destroy(); try { fs.unlinkSync(dest); } catch (_) {} reject(e); };
    let stall = setTimeout(() => fail(new Error('download stalled')), stallMs);
    const hard = setTimeout(() => fail(new Error('download timed out')), totalMs);
    res.on('data', c => {
      got += c.length;
      clearTimeout(stall); stall = setTimeout(() => fail(new Error('download stalled')), stallMs);
      if (maxMB && got > maxMB * 1048576) return fail(TOO_LARGE());
      if (onProgress && total) { const p = Math.floor(got / total * 100); if (p !== lastPct) { lastPct = p; try { onProgress(p); } catch (_) {} } }
    });
    res.on('error', fail);
    res.on('aborted', () => fail(new Error('connection aborted')));
    out.on('error', fail);
    out.on('finish', () => { if (done) return; done = true; clearTimeout(stall); clearTimeout(hard); resolve(); });
    res.pipe(out);
  });
  const size = fs.statSync(dest).size;
  if (size < 10 * 1024) { try { fs.unlinkSync(dest); } catch (_) {} throw new Error('downloaded file too small'); }
  return { sizeMB: +(size / 1048576).toFixed(1), outputPath: dest };
}

// ── instance discovery (cached) ──────────────────────────────────────────────
let cache = { t: 0, piped: null, inv: null };
async function instances() {
  if (cache.piped && Date.now() - cache.t < 30 * 60 * 1000) return cache;
  let piped = envList('PIPED_INSTANCES'), inv = envList('INVIDIOUS_INSTANCES');
  if (!piped.length) {
    try {
      const list = await getJson('https://piped-instances.kavin.rocks/', { timeout: 8000 });
      piped = list.filter(i => i.api_url).map(i => String(i.api_url).replace(/\/+$/, '')).slice(0, 8);
    } catch (_) {}
    piped = [...new Set([...piped, ...PIPED_FALLBACK])];
  }
  if (!inv.length) {
    try {
      const list = await getJson('https://api.invidious.io/instances.json?sort_by=health', { timeout: 8000 });
      inv = list.filter(([, i]) => i && i.api && i.type === 'https' && i.uri).map(([, i]) => String(i.uri).replace(/\/+$/, '')).slice(0, 6);
    } catch (_) {}
    inv = [...new Set([...inv, ...INVIDIOUS_FALLBACK])];
  }
  cache = { t: Date.now(), piped, inv };
  return cache;
}

function videoIdOf(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/))([\w-]{11})/i);
  return m ? m[1] : null;
}

/**
 * Resolve a downloadable (proxied) YouTube stream via Piped / Invidious.
 * @returns {{url:string, title:string, ext:string, source:string}}
 */
async function resolveYoutube(videoId, { audio = false, maxHeight = 360 } = {}) {
  if (!videoId) throw new Error('no video id');
  const { piped, inv } = await instances();
  const errors = [];

  for (const base of piped) {
    try {
      const j = await getJson(`${base}/streams/${videoId}`, { timeout: 10000 });
      if (audio) {
        const a = (j.audioStreams || []).filter(s => s.url && /mp4|m4a/i.test(s.mimeType || s.format || '')).sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0))[0]
               || (j.audioStreams || []).filter(s => s.url).sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0))[0];
        if (a) return { url: a.url, title: j.title || '', ext: /webm|opus/i.test(a.mimeType || '') ? 'webm' : 'm4a', source: `Piped (${new URL(base).host})` };
      } else {
        const v = (j.videoStreams || []).filter(s => s.url && s.videoOnly === false && /mp4/i.test(s.mimeType || s.format || ''))
          .sort((x, y) => (y.height || 0) - (x.height || 0));
        const pick = v.find(s => (s.height || 0) <= maxHeight) || v[v.length - 1];
        if (pick) return { url: pick.url, title: j.title || '', ext: 'mp4', source: `Piped (${new URL(base).host})` };
      }
      errors.push(`${base}: no usable stream`);
    } catch (e) { errors.push(`${base}: ${e.message}`); }
  }

  for (const base of inv) {
    try {
      const j = await getJson(`${base}/api/v1/videos/${videoId}?local=true&fields=title,formatStreams,adaptiveFormats`, { timeout: 10000 });
      const abs = (u) => (u && u.startsWith('/') ? base + u : u);
      if (audio) {
        const a = (j.adaptiveFormats || []).filter(f => /^audio\/(mp4|webm)/i.test(f.type || '') && f.url).sort((x, y) => (+y.bitrate || 0) - (+x.bitrate || 0))[0];
        if (a) return { url: abs(a.url), title: j.title || '', ext: /webm/i.test(a.type) ? 'webm' : 'm4a', source: `Invidious (${new URL(base).host})` };
      } else {
        const v = (j.formatStreams || []).filter(f => f.url && /mp4/i.test(f.type || '')).sort((x, y) => (parseInt(y.qualityLabel) || 0) - (parseInt(x.qualityLabel) || 0));
        const pick = v.find(f => (parseInt(f.qualityLabel) || 360) <= maxHeight) || v[v.length - 1];
        if (pick) return { url: abs(pick.url), title: j.title || '', ext: 'mp4', source: `Invidious (${new URL(base).host})` };
      }
      errors.push(`${base}: no usable stream`);
    } catch (e) { errors.push(`${base}: ${e.message}`); }
  }
  throw new Error(`Piped/Invidious: all instances failed (${errors.length})`);
}

/** Cobalt — only active when the owner supplies an API (self-hosted or with key). */
async function resolveCobalt(ytUrl, { audio = false, maxHeight = 360 } = {}) {
  const api = (process.env.COBALT_API_URL || '').replace(/\/+$/, '');
  if (!api) throw new Error('Cobalt not configured');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.COBALT_API_KEY) headers.Authorization = `Api-Key ${process.env.COBALT_API_KEY}`;
  const body = JSON.stringify({ url: ytUrl, downloadMode: audio ? 'audio' : 'auto', audioFormat: 'mp3', videoQuality: String(maxHeight), filenameStyle: 'basic' });
  const res = await request(`${api}/`, { method: 'POST', headers, body, timeout: 20000 });
  const chunks = []; for await (const c of res) chunks.push(c);
  const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!['tunnel', 'redirect', 'stream'].includes(j.status) || !j.url) throw new Error(`Cobalt: ${j.status || 'no answer'}${j.error?.code ? ' ' + j.error.code : ''}`);
  return { url: j.url, title: j.filename || '', ext: audio ? 'mp3' : 'mp4', source: 'Cobalt' };
}

/** Optional: RapidAPI "youtube-mp36" (free plan). Active only when RAPIDAPI_KEY is set. Audio only. */
async function resolveRapidAudio(videoId) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) throw new Error('RapidAPI not configured');
  if (!videoId) throw new Error('no video id');
  const host = process.env.RAPIDAPI_AUDIO_HOST || 'youtube-mp36.p.rapidapi.com';
  for (let i = 0; i < 8; i++) {
    const j = await getJson(`https://${host}/dl?id=${videoId}`, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host }, timeout: 20000 });
    if (j.link) return { url: j.link, title: j.title || '', ext: 'mp3', source: 'RapidAPI' };
    if (j.status === 'fail' || j.status === 'error') throw new Error(`RapidAPI: ${j.msg || j.status}`);
    await new Promise(r => setTimeout(r, 3000)); // status "processing" → poll again
  }
  throw new Error('RapidAPI: timed out');
}

// ── JioSaavn ─────────────────────────────────────────────────────────────────
const tokens = (v) => String(v || '').toLowerCase().replace(/&quot;|&amp;/g, ' ').match(/[\p{L}\p{N}]+/gu) || [];
const NOISE = new Set(['official', 'video', 'audio', 'lyrics', 'lyrical', 'song', 'full', 'hd', '4k', 'new', 'music', 'ft', 'feat', 'the', 'and', 'with']);

async function resolveSaavn(query) {
  const q = tokens(query).filter(t => !NOISE.has(t));
  if (!q.length) throw new Error('empty query');
  const qset = new Set(q);
  const errors = [];
  for (const api of SAAVN_APIS) {
    try {
      const j = await getJson(`${api}/search/songs?query=${encodeURIComponent(q.slice(0, 8).join(' '))}&limit=8`, { timeout: 10000 });
      const results = j?.data?.results || [];
      let best = null;
      for (const r of results) {
        const nameT = tokens(r.name || r.title).filter(t => !NOISE.has(t));
        if (!nameT.length) continue;
        const hit = nameT.filter(t => qset.has(t)).length / nameT.length;
        if (hit < 0.99) continue; // every word of the song name must appear in what the user asked for
        const links = Array.isArray(r.downloadUrl) ? r.downloadUrl : [];
        const link = links.find(l => /320/.test(l.quality)) || links.find(l => /160/.test(l.quality)) || links[links.length - 1];
        const url = link && (link.url || link.link);
        if (!url) continue;
        const score = hit + nameT.length * 0.01;
        if (!best || score > best.score) best = { score, url, title: `${r.name || r.title}${r.artists?.primary?.[0]?.name ? ' - ' + r.artists.primary[0].name : ''}` };
      }
      if (best) return { url: best.url, title: best.title.replace(/&quot;/g, '"').replace(/&amp;/g, '&'), ext: 'm4a', source: 'JioSaavn' };
      errors.push(`${api}: no match`);
    } catch (e) { errors.push(`${api}: ${e.message}`); }
  }
  throw new Error(`JioSaavn: ${errors[0] || 'no match'}`);
}

module.exports = { videoIdOf, streamToFile, resolveYoutube, resolveCobalt, resolveRapidAudio, resolveSaavn, TOO_LARGE };
