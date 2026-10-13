'use strict';

/**
 * versionChecker.js
 * Har connected bot ke owner ko (apne hi number par, personal message) "Update Available" bhejta hai
 * jab repo ke version.json ka version local package.json se bada ho.
 *
 *  - Har bot session connect hone par check + har 6 ghante baad dobara
 *  - Har number ko ek version ka notice sirf EK baar (data/updateNotified.json me yaad rehta hai)
 *  - Remote: config.updateVersionUrl  ya  muneeb-bot-updater/main/version.json
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
let config = {};
try { config = require('../config'); } catch (_) {}

const VERSION_URL = config.updateVersionUrl ||
  'https://raw.githubusercontent.com/mrmuneebali907-byte/muneeb-bot-updater/main/version.json';

const STATE_FILE = path.join(process.cwd(), 'data', 'updateNotified.json');
const EVERY_MS   = 6 * 60 * 60 * 1000;
const _timers = new WeakSet();

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; } }
function saveState(s) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (_) {}
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), {
      headers: { 'User-Agent': 'MuneebAliBot-VersionChecker/2.0', 'Accept': 'application/json' },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON from version endpoint')); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Timeout')); });
  });
}

function semverGt(remoteVer, localVer) {
  const parse = v => String(v || '0').replace(/[^0-9.]/g, '').split('.').map(n => parseInt(n, 10) || 0);
  const r = parse(remoteVer), l = parse(localVer);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) !== (l[i] || 0)) return (r[i] || 0) > (l[i] || 0);
  }
  return false;
}


function fetchText(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: Object.assign({ 'User-Agent': 'MuneebAliBot-VersionChecker/2.0' }, extraHeaders || {}), timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300) ? resolve(data) : reject(new Error('HTTP ' + res.statusCode)));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Timeout')); });
  });
}

function existsCI(rel) {                     // does this path exist on the server, ignoring letter case?
  let cur = process.cwd();
  for (const seg of rel.split('/').filter(Boolean)) {
    let hit = null;
    try { hit = fs.readdirSync(cur).find(n => n.toLowerCase() === seg.toLowerCase()); } catch (_) { return false; }
    if (!hit) return false;
    cur = path.join(cur, hit);
  }
  return true;
}

// Command files that exist in the update repo but not on this server yet (fully automatic — nothing to write by hand)
let _newCmdCache = { at: 0, list: [] };
async function detectNewCommands() {
  if (Date.now() - _newCmdCache.at < 10 * 60 * 1000) return _newCmdCache.list;
  const out = [];
  try {
    const m = VERSION_URL.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//);
    if (!m) return out;
    const [, owner, repo, branch] = m;
    const tree = JSON.parse(await fetchText(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { Accept: 'application/vnd.github+json' }));
    const files = (tree.tree || []).filter(t => t.type === 'blob' && /^commands\/.+\.js$/i.test(t.path) && !/\/lib\//i.test(t.path) && t.size > 0);
    for (const f of files) {
      if (existsCI(f.path)) continue;
      if (out.length >= 10) break;
      let name = path.basename(f.path, '.js'), desc = '';
      try {
        const src = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${f.path.split('/').map(encodeURIComponent).join('/')}`);
        const n = src.match(/\bname\s*:\s*['"]([^'"]+)['"]/); if (n) name = n[1];
        const d = src.match(/\bdescription\s*:\s*['"`]([^'"`\n]+)['"`]/); if (d) desc = d[1];
      } catch (_) {}
      out.push({ name, desc });
    }
  } catch (_) {}
  _newCmdCache = { at: Date.now(), list: out };
  return out;
}

async function checkOnce(sock) {
  try {
    const remote = await fetchJson(VERSION_URL);
    const remoteVersion = remote && remote.version;
    if (!remoteVersion) return;

    let localVersion = '1.0.0';
    try { delete require.cache[require.resolve('../package.json')]; localVersion = require('../package.json').version; } catch (_) {}
    if (!semverGt(remoteVersion, localVersion)) return;

    const num = sock.user && sock.user.id ? sock.user.id.split(':')[0].split('@')[0].replace(/[^0-9]/g, '') : '';
    if (!num) return;

    const state = loadState();
    if (state[num] === String(remoteVersion)) return;   // is number ko ye version pehle bata diya

    const text = remote.changelog || remote.changes || remote.news || '';
    const changes = text ? `\n\n📋 *Kya naya hai:*\n${text}` : '';
    const pfx = config.prefix || '.';
    const listed = (Array.isArray(remote.newCommands) ? remote.newCommands : []).map(a =>
      typeof a === 'string' ? { name: a.split(/\s+[—-]\s+/)[0], desc: a.split(/\s+[—-]\s+/).slice(1).join(' — ') } : a);
    const found = await detectNewCommands();
    const seen = new Set();
    const cmds = [...listed, ...found].map(c => {
      const n = c && String(c.name || '').replace(/^[.!/#]/, '');
      if (!n || seen.has(n)) return null;
      seen.add(n);
      const d = c.desc || c.description || '';
      return `• *${pfx}${n}*${d ? ' — ' + d : ''}`;
    }).filter(Boolean);
    const cmdText = cmds.length ? `\n\n🆕 *Naye commands:*\n${cmds.join('\n')}` : '';
    await sock.sendMessage(`${num}@s.whatsapp.net`, {
      text:
        `🔔 *Bot Update Available!*\n\n` +
        `📦 Current version : *v${localVersion}*\n` +
        `🆕 New version     : *v${remoteVersion}*${cmdText}${changes}\n\n` +
        `💡 Update karne ke liye *.update* likhein.\n\n` +
        `> _Auto-check by ${config.botName || 'Mr.Muneeb Ali Bot'}_`,
    });
    state[num] = String(remoteVersion);
    saveState(state);
    console.log(`[VersionChecker] 📩 v${remoteVersion} notice bheja → ${num}`);
  } catch (e) {
    console.warn('[VersionChecker] check failed (non-critical):', e.message);
  }
}

/** Har connected session ke liye ek baar lagao (handler.initializeAntiCall se). */
function watch(sock) {
  if (!sock || _timers.has(sock)) return;
  _timers.add(sock);
  setTimeout(() => checkOnce(sock), 15000 + Math.floor(Math.random() * 10000));
  const t = setInterval(() => {
    if (sock.ws && (sock.ws.isClosed || sock.ws.isClosing)) return clearInterval(t);
    checkOnce(sock);
  }, EVERY_MS);
  if (t.unref) t.unref();
}

module.exports = { watch, checkOnce, checkForUpdate: checkOnce };
