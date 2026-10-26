'use strict';
/**
 * serverRegistry.js — multi-server support ("Server 1 = OptikLink", "Server 2 = Railway", …)
 *
 * Every host runs the SAME code. Each one tells the frontend: name, how many bots are connected, how many free slots.
 *
 *  Identity (env, all optional):
 *    SERVER_NAME     "Server 1"                     shown on the website
 *    MAX_BOTS        8                              capacity of THIS host (sessionManager enforces it)
 *    PUBLIC_URL      https://xxx.up.railway.app     (Railway: RAILWAY_PUBLIC_DOMAIN is picked up automatically)
 *
 *  How the list of servers gets together (fully automatic):
 *    1) A secondary host (Railway) sets  REGISTRY_SECRET=<same secret on both hosts>.  It finds the main server
 *       through the GitHub gist, and registers itself there (and re-registers every 5 min).
 *    2) Optional manual list on the main server:  data/servers.json  = [{ "name": "Server 2", "url": "https://…" }]
 *       or env  BOT_SERVERS="Server 2|https://a.up.railway.app,Server 3|https://b.example.com"
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const DATA_FILE = path.join(process.cwd(), 'data', 'servers.json');
const PING_TTL  = 15 * 1000;
const _cache    = new Map();     // url → { at, info }

const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
const validUrl = (u) => /^https?:\/\/[^\s/]+\.[^\s/]+/i.test(cleanUrl(u)) || /^https?:\/\/localhost(:\d+)?$/i.test(cleanUrl(u));

// config.js of THIS host may carry:  isSecondary: true,  serverName: 'Server 2 (Enzonic)',  maxBots: 3
// (so hosts without an env-variable editor can be set up by replacing config.js only)
function hostCfg() { try { return require('../config') || {}; } catch (_) { return {}; } }

function isSecondary() {
  if (process.env.IS_PRIMARY === '1') return false;
  if (process.env.IS_SECONDARY === '1') return true;
  if (hostCfg().isSecondary === true) return true;
  return !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL);
}

function ownPublicUrl(currentTunnelUrl) {
  if (process.env.PUBLIC_URL) return cleanUrl(process.env.PUBLIC_URL);
  const rw = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
  if (rw) return 'https://' + String(rw).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return cleanUrl(currentTunnelUrl);
}

function ownName() { return process.env.SERVER_NAME || hostCfg().serverName || (isSecondary() ? 'Server 2 (Railway)' : 'Server 1 (OptikLink)'); }

function loadStored() {
  let arr = [];
  try { const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); if (Array.isArray(j)) arr = j; } catch (_) {}
  for (const part of String(process.env.BOT_SERVERS || '').split(',')) {
    const [name, url] = part.split('|').map(s => (s || '').trim());
    if (name && validUrl(url)) arr.push({ name, url: cleanUrl(url) });
  }
  const seen = new Set();
  return arr.filter(s => s && validUrl(s.url) && !seen.has(cleanUrl(s.url)) && seen.add(cleanUrl(s.url)))
            .map(s => ({ name: String(s.name || 'Server').slice(0, 40), url: cleanUrl(s.url) }));
}

function saveStored(arr) {
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2)); } catch (_) {}
}

/** A secondary host registers itself on the main server. Needs the shared secret. */
function register(entry) {
  if (!process.env.REGISTRY_SECRET) return { ok: false, error: 'registry disabled' };
  if (!entry || !validUrl(entry.url)) return { ok: false, error: 'bad url' };
  // a host keeps its NAME but gets a new tunnel URL after every restart → the new URL REPLACES the old one (no stale "Offline" copies)
  const nm = String(entry.name || 'Server').trim().toLowerCase();
  const arr = loadStored().filter(s => s.url !== cleanUrl(entry.url) && String(s.name || '').trim().toLowerCase() !== nm);
  arr.push({ name: String(entry.name || 'Server').slice(0, 40), url: cleanUrl(entry.url) });
  saveStored(arr.slice(0, 10));
  return { ok: true };
}

function getJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'muneeb-bot-registry', Accept: 'application/json', 'Bypass-Tunnel-Reminder': 'true' }, timeout: timeoutMs }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function ping(entry) {
  const hit = _cache.get(entry.url);
  if (hit && Date.now() - hit.at < PING_TTL) return hit.info;
  let info;
  try {
    const j = await getJson(entry.url + '/api/public/server-info');
    info = { name: entry.name, url: entry.url, online: true, connected: j.connected | 0, total: j.total | 0, max: j.max | 0, free: Math.max(0, j.free | 0) };
  } catch (_) {
    info = { name: entry.name, url: entry.url, online: false, connected: 0, total: 0, max: 0, free: 0 };
  }
  _cache.set(entry.url, { at: Date.now(), info });
  return info;
}

/** Full list for the website: this server first, then every other known server (live numbers). */
async function listAll(selfInfo) {
  const me = cleanUrl(selfInfo.url);
  const base = (n) => String(n || '').replace(/\s*\(.*?\)\s*/g, ' ').trim().toLowerCase();   // "Server 1 (OptikLink)" == "Server 1"
  const myName = base(selfInfo.name);
  // never list another entry with MY OWN name (that is just an old URL of this very server)
  const others = loadStored().filter(s => s.url !== me && base(s.name) !== myName);
  const rest = await Promise.all(others.map(ping));
  return [Object.assign({ online: true }, selfInfo)].concat(rest);
}

/** Secondary host: find the main server (gist) and keep registering there. */
function startSelfRegistration(getOwnUrl) {
  if (!isSecondary() || !process.env.REGISTRY_SECRET) return;
  let cfg = {};
  try { cfg = require('../config'); } catch (_) {}
  const gistUrl = process.env.MAIN_URL_SOURCE ||
    (cfg.gistOwner && cfg.gistId ? `https://gist.githubusercontent.com/${cfg.gistOwner}/${cfg.gistId}/raw/${cfg.gistFilename || 'backend-url.txt'}` : '');
  if (!gistUrl && !process.env.MAIN_URL) return;

  const once = async () => {
    try {
      const own = getOwnUrl();
      if (!own) return;
      let main = cleanUrl(process.env.MAIN_URL || '');
      if (!main) {
        const txt = await new Promise((resolve, reject) => {
          https.get(gistUrl + '?t=' + Date.now(), { timeout: 6000 }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d.trim())); }).on('error', reject);
        });
        main = cleanUrl(txt);
      }
      if (!validUrl(main) || main === cleanUrl(own)) return;
      const body = JSON.stringify({ name: ownName(), url: own, secret: process.env.REGISTRY_SECRET });
      const lib = main.startsWith('https') ? https : http;
      await new Promise((resolve) => {
        const req = lib.request(main + '/api/servers/register', { method: 'POST', timeout: 8000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Bypass-Tunnel-Reminder': 'true' } }, (r) => { r.resume(); r.on('end', resolve); });
        req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
        req.end(body);
      });
      console.log('[Registry] ✅ Main server ko register kiya:', own);
    } catch (e) { console.log('[Registry] register failed (will retry):', e.message); }
  };
  setTimeout(once, 20 * 1000);
  setInterval(once, 5 * 60 * 1000).unref?.();
}

module.exports = { isSecondary, ownPublicUrl, ownName, register, listAll, startSelfRegistration, validUrl, cleanUrl };
