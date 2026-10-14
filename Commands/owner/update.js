'use strict';

/**
 * Update Command — GitHub-based auto-updater
 * ─────────────────────────────────────────────────────────────────────────
 * Source  : config.updateZipUrl (see utils/updateSource.js) — the repo name is never shown in chat
 *
 * PRESERVED (never overwritten):
 *   node_modules/  sessions/  session/  data/  tmp/  temp/
 *   config.js  .env  cookies.txt  package-lock.json
 */

const { exec }  = require('child_process');
const fs        = require('fs');
const path      = require('path');

// Case-insensitive path lookup (GitHub folder "Commands" vs manifest "commands" on Linux)
function _ciResolve(root, rel) {
  let cur = root;
  for (const seg of rel.split(/[\\/]/).filter(Boolean)) {
    let hit = null;
    try {
      const names = fs.readdirSync(cur);
      hit = names.includes(seg) ? seg : names.find(n => n.toLowerCase() === seg.toLowerCase());
    } catch (_) { return null; }
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

// ── Safety: backup → verify → rollback (one update touches EVERY bot, so it must never leave broken files) ──
let _journal = null;                       // { dir, items: [{ dest, backup|null }] }
let _updating = false;                     // only one update at a time (all bots share the same files)
let _lastOk = 0;                           // time of last successful update
const COOLDOWN_MS = 5 * 60 * 1000;

function _stage(dest) {
  if (!_journal) return;
  const it = { dest, backup: null };
  if (fs.existsSync(dest)) {
    it.backup = path.join(_journal.dir, String(_journal.items.length));
    fs.mkdirSync(_journal.dir, { recursive: true });
    fs.copyFileSync(dest, it.backup);
  }
  _journal.items.push(it);
}
function _rollback() {
  if (!_journal) return 0;
  let n = 0;
  for (const it of _journal.items.reverse()) {
    try {
      if (it.backup) fs.copyFileSync(it.backup, it.dest); else fs.unlinkSync(it.dest);
      n++;
    } catch (_) {}
  }
  return n;
}
function _verify(files) {
  const vm = require('vm'), Module = require('module');
  const bad = [];
  for (const f of files) {
    const full = path.join(process.cwd(), f);
    try {
      if (f.endsWith('.js'))        new vm.Script(Module.wrap(fs.readFileSync(full, 'utf8')), { filename: f });
      else if (f.endsWith('.json')) JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) { bad.push(`${f} (${String(e.message).split('\n')[0]})`); }
  }
  return bad;
}
function semverNewer(r, l) {
  const p = v => String(v || '0').replace(/[^0-9.]/g, '').split('.').map(n => parseInt(n, 10) || 0);
  const a = p(r), b = p(l);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}
const https     = require('https');
const http      = require('http');
const config    = require('../../config');

const src = require('../../utils/updateSource');
const GITHUB_ZIP_URL = src.zipUrl();
const VERSION_URL    = src.versionUrl();

// Folders / files that MUST NOT be overwritten by an update
const PRESERVE = new Set([
  'node_modules', 'sessions', 'session', 'data', 'database', 'tmp', 'temp',
  'config.js', '.env', 'cookies.txt', 'package-lock.json',
  '.git', 'bin',
]);

const MAX_REDIRECTS = 8;

function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true, timeout: 120_000, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message || '').toString().slice(0, 500)));
      resolve((stdout || '').toString().trim());
    });
  });
}

async function extractZip(zipPath, outDir) {
  if (process.platform === 'win32') {
    await run(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force"`);
    return;
  }
  const tools = [
    () => run(`unzip -o '${zipPath}' -d '${outDir}'`),
    () => run(`7z x -y '${zipPath}' -o'${outDir}'`),
    () => run(`busybox unzip -o '${zipPath}' -d '${outDir}'`),
    () => run(`python3 -c "import zipfile; zipfile.ZipFile('${zipPath}').extractall('${outDir}')"`),
  ];
  for (const tool of tools) {
    try { await tool(); return; } catch (_) {}
  }
  throw new Error('No extraction tool found (tried unzip, 7z, busybox, python3)');
}

function downloadFile(url, dest, visited = new Set()) {
  return new Promise((resolve, reject) => {
    if (visited.has(url) || visited.size > MAX_REDIRECTS)
      return reject(new Error('Too many redirects'));
    visited.add(url);

    const client = url.startsWith('https://') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'MuneebAliBot-Updater/2.0',
        'Accept'    : 'application/octet-stream, */*',
      },
      timeout: 60_000,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error(`HTTP ${res.statusCode} no Location`));
        res.resume();
        return downloadFile(new URL(loc, url).toString(), dest, visited).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode} from server`));

      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error',  err => { try { file.close(() => {}); } catch {} fs.unlink(dest, () => reject(err)); });
    });
    req.on('error',   err => { fs.unlink(dest, () => reject(err)); });
    req.on('timeout', ()  => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'MuneebAliBot-Updater/2.0', 'Accept': 'application/json' },
      timeout: 10_000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(String(data).replace(/^\uFEFF/, "").replace(/,(\s*[}\]])/g, "$1"))); }
        catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

function copyRecursive(src, dest, preserve, relPath = '', copied = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (preserve.has(entry)) continue;
    const srcPath  = path.join(src,  entry);
    const destPath = path.join(dest, entry);
    const stat     = fs.lstatSync(srcPath);
    if (stat.isDirectory()) {
      copyRecursive(srcPath, destPath, new Set(), path.join(relPath, entry), copied);
    } else {
      _stage(destPath);
      fs.copyFileSync(srcPath, destPath);
      copied.push(path.join(relPath, entry).replace(/\\/g, '/'));
    }
  }
  return copied;
}

/**
 * The update repo is public, so API keys are never stored in it. Before new files overwrite the old ones,
 * move any key still written inside the OLD code into data/aiKeys.json (never touched by updates).
 */
function rescueSecrets() {
  try {
    const root = process.cwd();
    const file = path.join(root, 'data', 'aiKeys.json');
    let store = {};
    try { store = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
    const add = (prov, key) => {
      if (!key || key.length < 12) return;
      const arr = (store[prov] = store[prov] || []);
      if (!arr.includes(key)) arr.push(key);
    };
    let changed = false;
    const before = JSON.stringify(store);
    try {   // utils/aiKeys.js  DEFAULTS
      const t = fs.readFileSync(path.join(root, 'utils', 'aiKeys.js'), 'utf8');
      const blk = t.match(/const DEFAULTS = \{([\s\S]*?)\};/);
      if (blk) for (const m of blk[1].matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)) for (const k of m[2].matchAll(/'([^']+)'/g)) add(m[1], k[1]);
    } catch (_) {}
    try {   // aiEngine.js  hard-coded constants
      const t = fs.readFileSync(path.join(root, 'aiEngine.js'), 'utf8');
      const map = { GROQ_KEY_1: 'groq', GROQ_KEY_2: 'groq', GEMINI_KEY_1: 'gemini', GEMINI_KEY_2: 'gemini', CEREBRAS_KEY: 'cerebras', OPENROUTER_KEY: 'openrouter', MISTRAL_KEY: 'mistral' };
      for (const m of t.matchAll(/const (\w+_KEY(?:_\d)?)\s*=\s*'([^']{12,})'/g)) if (map[m[1]]) add(map[m[1]], m[2]);
    } catch (_) {}
    if (JSON.stringify(store) !== before) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(store, null, 2));
      changed = true;
    }
    return changed;
  } catch (e) { console.warn('[Update] rescueSecrets:', e.message); return false; }
}

async function updateViaZip(zipUrl, statusFn) {
  _journal = { dir: path.join(process.cwd(), 'tmp', `update_backup_${Date.now()}`), items: [] };
  const cwd    = process.cwd();
  const tmpDir = path.join(cwd, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const zipPath   = path.join(tmpDir, `update_${Date.now()}.zip`);
  const extractTo = path.join(tmpDir, `update_extract_${Date.now()}`);

  await statusFn('⬇️ Latest update download ho raha hai…');
  await downloadFile(zipUrl, zipPath);

  await statusFn('📦 Extracting…');
  if (fs.existsSync(extractTo)) fs.rmSync(extractTo, { recursive: true, force: true });
  await extractZip(zipPath, extractTo);

  const entries       = fs.readdirSync(extractTo);
  const rootCandidate = entries.length === 1 ? path.join(extractTo, entries[0]) : extractTo;
  const srcRoot       = (fs.existsSync(rootCandidate) && fs.lstatSync(rootCandidate).isDirectory())
    ? rootCandidate : extractTo;

  rescueSecrets();
  await statusFn('📋 Copying new files (preserving your data)…');
  // AUTO mode — no manifest to maintain. Whatever the repo holds in commands/, utils/, Panel/ (any letter case)
  // plus handler.js, aiEngine.js, package.json is installed. New command file in the repo = new command here.
  const ROOT_FILES = new Set(['handler.js', 'aiEngine.js', 'package.json']);
  const CODE_DIRS  = { commands: 'commands', utils: 'utils', panel: 'Panel' };
  const copied = [];
  copied.created = [];
  const serverDir = (want) => {
    try { const hit = fs.readdirSync(cwd).find(n => n.toLowerCase() === want.toLowerCase() && fs.lstatSync(path.join(cwd, n)).isDirectory()); if (hit) return hit; } catch (_) {}
    return want;
  };
  const place = (from, relDest) => {
    const dest = path.join(cwd, relDest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const existed = fs.existsSync(dest);
    _stage(dest);
    fs.copyFileSync(from, dest);
    const rel = relDest.replace(/\\/g, '/');
    copied.push(rel);
    if (!existed) copied.created.push(rel);
  };
  const walk = (srcDir, relDir) => {
    for (const name of fs.readdirSync(srcDir)) {
      if (name.startsWith('.')) continue;
      const full = path.join(srcDir, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) { walk(full, path.join(relDir, name)); continue; }
      if (!st.isFile() || st.size === 0 || !/\.(js|json|html|css)$/i.test(name)) continue;
      place(full, path.join(relDir, name));
    }
  };
  for (const name of fs.readdirSync(srcRoot)) {
    const full = path.join(srcRoot, name);
    const st = fs.lstatSync(full);
    if (st.isFile() && ROOT_FILES.has(name)) place(full, name);
    else if (st.isDirectory() && CODE_DIRS[name.toLowerCase()]) walk(full, serverDir(CODE_DIRS[name.toLowerCase()]));
  }

  try { fs.rmSync(extractTo, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(zipPath); } catch {}

  if (!copied.length) throw new Error('Update package khaali / galat hai — kuch bhi nahi badla.');
  const bad = _verify(copied);
  if (bad.length) {
    _rollback();
    throw new Error('Nayi files mein error mili, isliye purani files wapas laga di (bot safe hai):\n• ' + bad.slice(0, 5).join('\n• '));
  }
  return copied;
}

module.exports = {
  _rescueSecrets: rescueSecrets,   // (exported for tests)
  name        : 'update',
  aliases     : ['upgrade', 'botupdate'],
  category    : 'owner',
  description : 'Bot ko latest version par update karo (owner only)',
  usage       : '.update   (Main Developer: .update force)',
  ownerOnly   : true,

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;
    const isSuper = !!(extra.isMainDeveloper || extra.isSuperAdmin);
    const force   = isSuper && (args[0] || '').toLowerCase() === 'force';
    // custom zip_url = arbitrary code → only the Main Developer may use it
    const customUrl = isSuper && args[0] && /^https?:\/\//i.test(args[0]) ? args[0] : null;
    const zipUrl = (customUrl || GITHUB_ZIP_URL).trim();

    if (_updating) return extra.reply('⏳ Update pehle se chal raha hai (saare bots ek hi code use karte hain). Thodi der ruko.');
    if (!force && Date.now() - _lastOk < COOLDOWN_MS)
      return extra.reply('✅ Abhi hi update ho chuka hai — saare bots ko naya code mil chuka hai. 5 minute baad dobara check karna.');

    const statusMsg = await extra.reply('🔄 *Starting update…*');
    const statusKey = statusMsg?.key;

    const statusFn = async (text) => {
      if (statusKey) {
        try { await sock.sendMessage(chatId, { text, edit: statusKey }); } catch (_) {}
      }
      console.log('[Update]', text);
    };

    try {
      let localVer  = '1.0.0';
      let remoteVer = null;
      let remoteInfo = null;
      try { localVer = require('../../package.json').version; } catch (_) {}
      try {
        const remote = await fetchJson(VERSION_URL);
        remoteInfo = remote || null;
        remoteVer = remote?.version;
      } catch (_) {}

      if (remoteVer && !force && !customUrl && !semverNewer(remoteVer, localVer)) {
        return await statusFn(`✅ *Bot already latest hai* (v${localVer}).\nNaya version aane par yahin se update kar lena.`);
      }

      _updating = true;
      if (remoteVer) {
        await statusFn(
          `📦 *Version check*\n• Local  : v${localVer}\n• Remote : v${remoteVer}\n\n⬇️ Downloading…`
        );
      }

      const copied = await updateViaZip(zipUrl, statusFn);

      // Version sync: package.json always follows version.json (nobody edits it by hand)
      if (remoteVer) {
        try {
          const pj = path.join(process.cwd(), 'package.json');
          const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
          if (j.version !== remoteVer) { j.version = String(remoteVer); fs.writeFileSync(pj, JSON.stringify(j, null, 2) + '\n'); }
        } catch (_) {}
      }

      // Install any new npm packages from the updated package.json
      try {
        await statusFn('📦 Installing dependencies…');
        await run('npm install --production --no-audit --no-fund', { cwd: process.cwd() });
      } catch (npmErr) {
        console.warn('[Update] npm install warning:', npmErr.message);
      }

      // ── Hot-reload: runs BEFORE success message so new commands are live ────
      const { loadCommands } = require('../../utils/commandLoader');

      // Snapshot of command names BEFORE reload (to detect what's new)
      const namesBefore = new Set();
      try { for (const [k, v] of loadCommands()) { if (v.name === k) namesBefore.add(k); } } catch (_) {}

      let reloadError = null;
      try {
        const { hotReloadCommands } = require('../../handler');
        hotReloadCommands();
        console.log('[Update] ✅ Hot-reload complete');
      } catch (hrErr) {
        reloadError = hrErr.message;
        try { _rollback(); require('../../handler').hotReloadCommands(); reloadError += ' (purani files wapas laga di)'; } catch (_) {}
        console.warn('[Update] ⚠️ Hot-reload error:', hrErr.message);
      }

      // Snapshot AFTER reload — detect new commands
      const namesAfter  = new Set();
      const newCmds     = [];
      try {
        for (const [k, v] of loadCommands()) {
          if (v.name === k) {
            namesAfter.add(k);
            if (!namesBefore.has(k)) newCmds.push(k);
          }
        }
      } catch (_) {}

      // Read version directly from disk (bypasses require.cache completely)
      let newVer = remoteVer;
      try {
        newVer = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version || newVer;
      } catch (_) {}

      // New commands: what version.json announces + whatever really appeared after the reload
      const pfx = config.prefix || '.';
      const cmdMap = (() => { try { return loadCommands(); } catch (_) { return new Map(); } })();
      const announced = (remoteInfo && Array.isArray(remoteInfo.newCommands)) ? remoteInfo.newCommands : [];
      const lines = new Map();
      const add = (name, desc) => {
        name = String(name || '').replace(/^[.!/#]/, '').trim();
        if (!name || lines.has(name)) return;
        const c = cmdMap.get(name);
        lines.set(name, `• *${pfx}${name}*${(desc || (c && c.description)) ? ' — ' + (desc || c.description) : ''}`);
      };
      for (const a of announced) typeof a === 'string' ? add(a.split(/\s+[—-]\s+/)[0], a.split(/\s+[—-]\s+/).slice(1).join(' — ')) : add(a && a.name, a && (a.desc || a.description));
      for (const k of newCmds) add(k);
      for (const rel of (copied.created || [])) {            // brand-new command FILES (auto-detected)
        if (!/^commands[\\/]/i.test(rel)) continue;
        try {
          const abs = path.join(process.cwd(), rel);
          delete require.cache[require.resolve(abs)];
          const m = require(abs);
          if (m && m.name) add(m.name, m.description);
        } catch (_) { add(path.basename(rel, '.js')); }
      }
      const newCmdLine = lines.size
        ? `\n\n🆕 *Naye commands aa gaye — ab use karo:*\n${[...lines.values()].join('\n')}`
        : '';
      const logLine = (remoteInfo && remoteInfo.changelog) ? `\n\n📋 *Kya naya hai:*\n${remoteInfo.changelog}` : '';
      const reloadLine = reloadError
        ? `\n⚠️ Reload warning: ${reloadError} — run .restart for full effect`
        : `\n⚡ *${namesAfter.size} commands active (hot-reloaded — NO restart needed)*`;

      const summary =
        `✅ *Update complete!*\n\n` +
        `📁 Files updated : *${copied.length}*\n` +
        (newVer ? `📦 Version       : *v${newVer}*\n` : '') +
        newCmdLine +
        logLine +
        reloadLine +
        `\n\n🔒 Safe rahe: sessions, data, config.js\n` +
        `✅ *Bot is still running — naye commands ABHI kaam kar rahe hain!*`;

      _lastOk = Date.now();
      await statusFn(summary);
      // NO process.exit — bot stays running with hot-reloaded commands.
      // Core-file changes (handler.js etc.) need a manual .restart

    } catch (error) {
      console.error('[Update] Failed:', error);
      try { _rollback(); } catch (_) {}
      await statusFn(`❌ *Update failed:*\n${src.scrub(error.message)}\n\n_Thodi der baad dobara try karo._`);
    } finally {
      _updating = false;
      try { if (_journal) fs.rmSync(_journal.dir, { recursive: true, force: true }); } catch (_) {}
      _journal = null;
    }
  },
};
