/**
 * warp.js — FREE Cloudflare WARP tunnel for yt-dlp.
 * YouTube blocks the hosting server's datacenter IP ("Sign in to confirm you're not a bot").
 * WARP gives the bot a Cloudflare IP instead. Fully automatic, no account/signup by you:
 *   1. downloads `wgcf` + `wireproxy` (from GitHub) into bin/
 *   2. registers a free WARP identity once (data/warp/)
 *   3. runs wireproxy → local SOCKS5 proxy on 127.0.0.1:40000
 *   4. verifies with Cloudflare's trace; yt-dlp tiers then use --proxy socks5://127.0.0.1:40000
 * Disable with env WARP_DISABLE=1. Everything is best-effort: failure never breaks the bot.
 */
'use strict';

const fs    = require('fs');
const path  = require('path');
const net   = require('net');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN  = path.join(ROOT, 'bin');
const DIR  = path.join(ROOT, 'data', 'warp');
const PORT = +process.env.WARP_PORT || 40000;
const WGCF = path.join(BIN, 'wgcf');
const WIREPROXY = path.join(BIN, 'wireproxy');

let proxyUrl = null;
let child = null;
let starting = false;
let failures = 0;
const log  = (m) => console.log(`[WARP] ${m}`);

const arch = () => (process.arch === 'arm64' ? 'arm64' : 'amd64');

function getBuf(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'muneeb-bot', Accept: '*/*' }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(getBuf(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

async function assetUrl(repo, re) {
  const rel = JSON.parse((await getBuf(`https://api.github.com/repos/${repo}/releases/latest`)).toString());
  const a = (rel.assets || []).find(x => re.test(x.name));
  if (!a) throw new Error(`no release asset for ${repo}`);
  return a.browser_download_url;
}

async function ensureBinaries() {
  fs.mkdirSync(BIN, { recursive: true });
  if (!fs.existsSync(WGCF)) {
    log('downloading wgcf…');
    const url = await assetUrl('ViRb3/wgcf', new RegExp(`linux_${arch()}$`));
    fs.writeFileSync(WGCF, await getBuf(url)); fs.chmodSync(WGCF, 0o755);
  }
  if (!fs.existsSync(WIREPROXY)) {
    log('downloading wireproxy…');
    const url = await assetUrl('pufferffish/wireproxy', new RegExp(`linux_${arch()}\\.tar\\.gz$`));
    const tgz = path.join(BIN, 'wireproxy.tar.gz');
    fs.writeFileSync(tgz, await getBuf(url));
    execFileSync('tar', ['-xzf', tgz, '-C', BIN, 'wireproxy'], { timeout: 30000 });
    try { fs.unlinkSync(tgz); } catch (_) {}
    fs.chmodSync(WIREPROXY, 0o755);
  }
}

function ensureProfile() {
  fs.mkdirSync(DIR, { recursive: true });
  const profile = path.join(DIR, 'wgcf-profile.conf');
  if (!fs.existsSync(profile)) {
    log('registering free WARP identity…');
    if (!fs.existsSync(path.join(DIR, 'wgcf-account.toml'))) {
      execFileSync(WGCF, ['register', '--accept-tos'], { cwd: DIR, timeout: 60000, stdio: 'ignore' });
    }
    execFileSync(WGCF, ['generate'], { cwd: DIR, timeout: 30000, stdio: 'ignore' });
  }
  let conf = fs.readFileSync(profile, 'utf8');
  conf = conf.replace(/\n?\[Socks5\][\s\S]*$/, '');
  conf += `\n[Socks5]\nBindAddress = 127.0.0.1:${PORT}\n`;
  const out = path.join(DIR, 'wireproxy.conf');
  fs.writeFileSync(out, conf);
  return out;
}

/** Ask Cloudflare (through the SOCKS5 proxy) whether traffic really leaves via WARP. */
function checkTrace() {
  return new Promise(resolve => {
    const s = net.connect(PORT, '127.0.0.1');
    let step = 0, text = '';
    const done = (v) => { try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(10000, () => done(false));
    s.on('error', () => done(false));
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', d => {
      if (step === 0) {
        if (d[0] !== 5 || d[1] !== 0) return done(false);
        step = 1;
        const host = Buffer.from('www.cloudflare.com');
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0, 80])]));
      } else if (step === 1) {
        if (d[1] !== 0) return done(false);
        step = 2;
        s.write('GET /cdn-cgi/trace HTTP/1.1\r\nHost: www.cloudflare.com\r\nConnection: close\r\n\r\n');
        if (d.length > 10) text += d.slice(10).toString();
      } else {
        text += d.toString();
        if (/warp=/.test(text)) done(/warp=(on|plus)/.test(text));
      }
    });
    s.on('close', () => resolve(/warp=(on|plus)/.test(text)));
  });
}

function stopChild() { if (child) { try { child.kill('SIGKILL'); } catch (_) {} child = null; } }
process.on('exit', stopChild);

async function start() {
  if (starting || proxyUrl || process.env.WARP_DISABLE === '1' || process.platform !== 'linux') return;
  starting = true;
  try {
    await ensureBinaries();
    const conf = ensureProfile();
    try { execFileSync('pkill', ['-f', 'bin/wireproxy'], { stdio: 'ignore' }); } catch (_) {}
    child = spawn(WIREPROXY, ['-c', conf], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('exit', (code) => {
      child = null;
      if (proxyUrl) log(`tunnel stopped (code ${code}) — will restart`);
      proxyUrl = null; starting = false;
      setTimeout(() => start().catch(() => {}), 15000).unref();
    });
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      if (await checkTrace()) { proxyUrl = `socks5://127.0.0.1:${PORT}`; failures = 0; log(`✅ active — YouTube traffic now leaves via Cloudflare WARP (${proxyUrl})`); return; }
    }
    throw new Error('tunnel did not come up (UDP blocked by host?)');
  } catch (e) {
    failures++;
    stopChild();
    log(`⚠️ not available: ${e.message}${failures < 4 ? ' — retrying in 10 min' : ''}`);
    if (failures < 4) setTimeout(() => { starting = false; start().catch(() => {}); }, 10 * 60 * 1000).unref();
  } finally {
    if (!proxyUrl && failures >= 4) starting = false;
    if (proxyUrl) starting = false;
  }
}

module.exports = { start, getProxy: () => proxyUrl };

// kick off in the background, never block or crash the bot
setTimeout(() => { start().catch(e => log(`start error: ${e.message}`)); }, 5000).unref();
