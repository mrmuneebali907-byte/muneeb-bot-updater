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
        try { resolve(JSON.parse(data)); }
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
  // If the update package carries `update-manifest.json`, ONLY the files listed there are copied
  // (everything else on the server is left exactly as it is). Without a manifest: classic full copy.
  let copied;
  const manifestPath = path.join(srcRoot, 'update-manifest.json');
  if (fs.existsSync(manifestPath)) {
    const list = (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files || []);
    copied = [];
    for (const rel of list) {
      const clean = path.normalize(String(rel)).replace(/^([/\\]|\.\.[/\\])+/, '');
      const top = clean.split(/[/\\]/)[0];
      if (!clean || clean.includes('..') || PRESERVE.has(top) || PRESERVE.has(path.basename(clean))) continue;
      const from = path.join(srcRoot, clean);
      if (!fs.existsSync(from) || !fs.lstatSync(from).isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(cwd, clean)), { recursive: true });
      fs.copyFileSync(from, path.join(cwd, clean));
      copied.push(clean.replace(/\\/g, '/'));
    }
  } else {
    copied = copyRecursive(srcRoot, cwd, PRESERVE);
  }

  try { fs.rmSync(extractTo, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(zipPath); } catch {}

  return copied;
}

module.exports = {
  _rescueSecrets: rescueSecrets,   // (exported for tests)
  name        : 'update',
  aliases     : ['upgrade', 'botupdate'],
  category    : 'owner',
  description : 'Bot ko latest version par update karo (owner only)',
  usage       : '.update [zip_url]',
  ownerOnly   : true,

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;
    const zipUrl = (args[0] || GITHUB_ZIP_URL).trim();   // (a custom zip_url is still accepted, but never echoed back)

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
      try { localVer = require('../../package.json').version; } catch (_) {}
      try {
        const remote = await fetchJson(VERSION_URL);
        remoteVer = remote?.version;
      } catch (_) {}

      if (remoteVer) {
        await statusFn(
          `📦 *Version check*\n• Local  : v${localVer}\n• Remote : v${remoteVer}\n\n⬇️ Downloading…`
        );
      }

      const copied = await updateViaZip(zipUrl, statusFn);

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

      const newCmdLine = newCmds.length
        ? `\n🆕 New commands: *${newCmds.join(', ')}*`
        : '';
      const reloadLine = reloadError
        ? `\n⚠️ Reload warning: ${reloadError} — run .restart for full effect`
        : `\n⚡ *${namesAfter.size} commands active (hot-reloaded — NO restart needed)*`;

      const summary =
        `✅ *Update complete!*\n\n` +
        `📁 Files updated : *${copied.length}*\n` +
        (newVer ? `📦 Version       : *v${newVer}*\n` : '') +
        newCmdLine +
        reloadLine +
        `\n\n🔒 Safe rahe: sessions, data, config.js\n` +
        `✅ *Bot is still running — naye commands ABHI kaam kar rahe hain!*`;

      await statusFn(summary);
      // NO process.exit — bot stays running with hot-reloaded commands.
      // Core-file changes (handler.js etc.) need a manual .restart

    } catch (error) {
      console.error('[Update] Failed:', error);
      await statusFn(`❌ *Update failed:*\n${src.scrub(error.message)}\n\n_Thodi der baad dobara try karo._`);
    }
  },
};
