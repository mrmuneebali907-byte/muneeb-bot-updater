'use strict';
/**
 * Anime image fetcher — FREE APIs, no key needed, with automatic fallback.
 * Pehle waifu.pics, na chale to nekos.best / nekosia / konachan / safebooru (sab SFW).
 * Ek API band ho jaye to agli khud try hoti hai, isliye command fail nahi hota.
 */
const axios = require('axios');

const UA   = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36', Accept: 'application/json,image/*,*/*' };

// ── Network hardening for restricted hosting panels ──────────────────────────
// Kuch panels par: (1) host ka DNS kuch sites ko resolve nahi karta (ENOTFOUND), (2) IPv6 chalta nahi (ENETUNREACH),
// (3) kuch sites server ki IP ko 403/503 deti hain. Isliye: IPv4 + backup DNS, aur phir WARP tunnel se retry.
const dns   = require('dns');
const net   = require('net');
const tls   = require('tls');
const https = require('https');

const backupDns = new dns.Resolver();
try { backupDns.setServers(['1.1.1.1', '8.8.8.8', '9.9.9.9']); } catch (_) {}

function lookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  const done = (addr) => (options && options.all) ? cb(null, [{ address: addr, family: 4 }]) : cb(null, addr, 4);
  dns.lookup(hostname, { family: 4 }, (err, addr) => {
    if (!err && addr) return done(addr);
    backupDns.resolve4(hostname, (e2, list) => (e2 || !list?.length) ? cb(err || e2) : done(list[0]));
  });
}
const directAgent = new https.Agent({ lookup, keepAlive: true, maxSockets: 8 });

/** Chhota SOCKS5 agent (koi extra package nahi chahiye). Domain proxy ko dete hain → DNS bhi wahin hota hai. */
function socksAgent(proxyUrl, tlsOpts = {}) {
  const u = new URL(proxyUrl);
  const pHost = u.hostname, pPort = +u.port || 1080;
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (opts, cb) => {
    const host = opts.host || opts.hostname, port = +opts.port || 443;
    const sock = net.connect(pPort, pHost);
    let stage = 0, buf = Buffer.alloc(0), finished = false;
    const fail = (e) => { if (finished) return; finished = true; try { sock.destroy(); } catch (_) {} cb(e instanceof Error ? e : new Error(String(e))); };
    sock.setTimeout(15000, () => fail(new Error('socks timeout')));
    sock.once('error', fail);
    sock.once('connect', () => sock.write(Buffer.from([5, 1, 0])));
    sock.on('data', (d) => {
      if (finished) return;
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('socks auth refused'));
        buf = buf.slice(2); stage = 1;
        const h = Buffer.from(host);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return fail(new Error(`socks connect failed (code ${buf[1]})`));
        const need = 4 + (buf[3] === 1 ? 4 : buf[3] === 4 ? 16 : 1 + buf[4]) + 2;
        if (buf.length < need) return;
        finished = true; stage = 2; sock.removeAllListeners('data'); sock.setTimeout(0); sock.removeListener('error', fail);
        const t = tls.connect({ ...tlsOpts, socket: sock, servername: host });
        t.once('error', (e) => { try { sock.destroy(); } catch (_) {} });
        cb(null, t);
      }
    });
  };
  return agent;
}

const warpProxy = () => { try { return require('./warp').getProxy(); } catch (_) { return null; } };
const retryable = (e) => !e.response || [403, 408, 429, 500, 502, 503, 504].includes(e.response.status);

/** GET: seedha (IPv4 + backup DNS) → fail ho to WARP ke through */
async function http(url, opt = {}) {
  const base = { timeout: 15000, headers: UA, ...opt };
  try {
    return await axios.get(url, { ...base, httpsAgent: directAgent });
  } catch (e) {
    const p = warpProxy();
    if (!p) { console.log(`[AnimeImg] WARP proxy active nahi hai → retry nahi hoga (${e.code || e.response?.status || e.message})`); throw e; }
    if (!retryable(e)) throw e;
    try {
      const r = await axios.get(url, { ...base, httpsAgent: socksAgent(p), proxy: false });
      console.log(`[AnimeImg] via WARP ok: ${new URL(url).hostname}`);
      return r;
    } catch (e2) { throw e; }          // asli (pehli) error hi dikhao
  }
}
/** POST (AniList wagairah) — same tareeka */
async function httpPost(url, data, opt = {}) {
  const base = { timeout: 15000, headers: UA, ...opt };
  try {
    return await axios.post(url, data, { ...base, httpsAgent: directAgent });
  } catch (e) {
    const p = warpProxy();
    if (!p || !retryable(e)) throw e;
    try { return await axios.post(url, data, { ...base, httpsAgent: socksAgent(p), proxy: false }); }
    catch (e2) { throw e; }
  }
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const fixUrl = (u) => (u ? (String(u).startsWith('//') ? 'https:' + u : String(u)) : '');

// ── providers: har ek ek image URL deta hai ──────────────────────────────────
const P = {
  wpics: (cat) => async () => (await http(`https://api.waifu.pics/sfw/${cat}`)).data?.url,

  nekosbest: (cat) => async () => (await http(`https://nekos.best/api/v2/${cat}`)).data?.results?.[0]?.url,

  nekosia: (cat) => async () => {
    const d = (await http(`https://api.nekosia.cat/api/v1/images/${cat}?count=1&rating=safe`)).data;
    return d?.image?.original?.url || d?.image?.compressed?.url || d?.images?.[0]?.image?.original?.url;
  },

  waifuim: (tag) => async () => {
    const d = (await http(`https://api.waifu.im/search?included_tags=${tag}&is_nsfw=false`)).data;
    return d?.images?.[0]?.url;
  },

  konachan: (tag = '') => async () => {
    const q = encodeURIComponent(`order:random rating:safe${tag ? ' ' + tag : ''}`);
    const list = (await http(`https://konachan.net/post.json?limit=30&tags=${q}`)).data;
    const it = pick((list || []).filter(p => p && (p.sample_url || p.file_url)));
    return fixUrl(it?.sample_url || it?.file_url);
  },

  safebooru: (tag) => async () => {
    const list = (await http(`https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=50&tags=${encodeURIComponent(tag)}`)).data;
    const it = pick((Array.isArray(list) ? list : []).filter(p => p && p.directory && p.image));
    return it ? `https://safebooru.org/images/${it.directory}/${it.image}` : '';
  },
};

const KINDS = {
  waifu   : [P.wpics('waifu'), P.nekosbest('waifu'), P.waifuim('waifu'), P.konachan('long_hair')],
  neko    : [P.wpics('neko'), P.nekosbest('neko'), P.nekosia('catgirl'), P.konachan('catgirl')],
  megumin : [P.wpics('megumin'), P.safebooru('megumin'), P.konachan('megumin')],
  konachan: [P.konachan(''), P.safebooru('1girl'), P.wpics('waifu')],
};

const MAX_BYTES = 10 * 1024 * 1024;

/** kind ('waifu' | 'neko' | 'megumin' | 'konachan') → { buffer, url } — ya error */
async function getAnimeImage(kind) {
  const chain = KINDS[kind];
  if (!chain) throw new Error(`unknown kind ${kind}`);
  const errs = [];
  for (let i = 0; i < chain.length; i++) {
    try {
      const url = fixUrl(await chain[i]());
      if (!/^https?:\/\//i.test(url)) throw new Error('no image url');
      const r   = await http(url, { responseType: 'arraybuffer', headers: { ...UA, Accept: 'image/*' } });
      const buf = Buffer.from(r.data);
      if (buf.length < 1000)       throw new Error('image too small');
      if (buf.length > MAX_BYTES)  throw new Error('image too large');
      return { buffer: buf, url, source: i };
    } catch (e) {
      errs.push(`#${i + 1}: ${e.message}`);
      console.log(`[AnimeImg] ${kind} source ${i + 1} failed: ${e.message}`);
    }
  }
  throw new Error('all sources failed — ' + errs.join(' | '));
}

/** thin command factory — har anime command isi se banta hai */
function makeCommand({ name, aliases = [], desc, kind }) {
  return {
    name, aliases, category: 'anime', desc, usage: name,
    execute: async (sock, msg, args, extra) => {
      try {
        const { buffer } = await getAnimeImage(kind);
        await sock.sendMessage(extra.from, { image: buffer }, { quoted: msg });
      } catch (e) {
        console.error(`[${name}] failed:`, e.message);
        await extra.reply('❌ Abhi image nahi mil saki, thodi der baad dobara try karo.');
      }
    },
  };
}

console.log('[AnimeImg] v2 loaded (IPv4 + backup DNS + WARP retry)');
module.exports = { getAnimeImage, makeCommand, http, httpPost, _socksAgent: socksAgent, directAgent, socksAgent, warpProxy, retryable };
