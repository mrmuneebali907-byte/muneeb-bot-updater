'use strict';
/**
 * utils/mediaFix.js — keeps media tools alive on hosts whose `npm install` was partial / blocked.
 *
 *  1. ffmpeg  : node_modules/ffmpeg-static/ffmpeg is downloaded by an npm *install script*. Some hosts skip it
 *               (Enzonic: "spawn .../ffmpeg-static/ffmpeg ENOENT") → stickers, hug/slap/kiss…, tts, video tools die.
 *               We check it at boot and, if it is missing, (a) reuse a system ffmpeg or (b) download the same static
 *               build from its GitHub release, then put it where every command looks for it (+ bin/ffmpeg on PATH).
 *  2. images  : Baileys makes the thumbnail / width / height of an image with `sharp` (or jimp). When neither works
 *               the image goes out WITHOUT them and WhatsApp silently drops a *group status*. fixImageInner() adds them
 *               (sharp → ffmpeg fallback) before the status is relayed.
 *  3. one diagnostic line at boot:  [media] ffmpeg=… | sharp=… | baileys=…
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN  = path.join(ROOT, 'bin');

let _ffmpeg = null;          // path of a working ffmpeg (once known)
let _initP  = null;

function staticPath() { try { return require('ffmpeg-static') || null; } catch (_) { return null; } }
function works(p) {
  try { if (!p || !fs.existsSync(p)) return false; execFileSync(p, ['-version'], { timeout: 8000, stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}
function systemFfmpeg() {
  try { const p = execFileSync('which', ['ffmpeg'], { timeout: 3000 }).toString().trim(); if (p && works(p)) return p; } catch (_) {}
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) if (works(p)) return p;
  return null;
}
function link(src, dest) {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.unlinkSync(dest); } catch (_) {}
    try { fs.symlinkSync(src, dest); if (works(dest)) return true; fs.unlinkSync(dest); } catch (_) {}
    fs.copyFileSync(src, dest); fs.chmodSync(dest, 0o755);
    return works(dest);
  } catch (_) { return false; }
}

/** GET url (follows redirects), gunzip → dest.part → dest. Resolves true/false, never throws. */
function downloadGz(url, dest, hops = 0) {
  return new Promise((resolve) => {
    if (hops > 6) return resolve(false);
    const req = (url.startsWith('http:') ? http : https).get(url, { headers: { 'User-Agent': 'muneeb-bot' }, timeout: 90_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadGz(new URL(res.headers.location, url).toString(), dest, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) {}
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      const fail = () => { try { out.destroy(); } catch (_) {} try { fs.unlinkSync(tmp); } catch (_) {} resolve(false); };
      const gunzip = zlib.createGunzip();
      res.on('error', fail); gunzip.on('error', fail); out.on('error', fail);
      res.pipe(gunzip).pipe(out);
      out.on('finish', () => out.close(() => {
        try {
          if (fs.statSync(tmp).size < 5e6) throw new Error('too small');
          fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, dest); resolve(true);
        } catch (_) { try { fs.unlinkSync(tmp); } catch (__) {} resolve(false); }
      }));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function releaseTags() {
  const tags = [];
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'ffmpeg-static', 'package.json'), 'utf8'));
    const t = pj['ffmpeg-static'] && pj['ffmpeg-static']['binary-release-tag'];
    if (t) tags.push(t);
  } catch (_) {}
  for (const t of ['b6.1.1', 'b6.0']) if (!tags.includes(t)) tags.push(t);
  return tags;
}

/** Make sure a working ffmpeg exists where the commands look for it. opts only for tests. */
async function ensureFfmpeg(opts = {}) {
  if (process.platform === 'win32') return null;
  const st = staticPath();
  let good = works(st) ? st : null;

  if (!good && !opts.skipSystem) {
    const sys = systemFfmpeg();
    if (sys) { good = sys; if (st) link(sys, st); }
  }
  if (!good) {
    const target = st || path.join(BIN, 'ffmpeg');
    const asset = `ffmpeg-${process.platform}-${process.arch}.gz`;
    for (const tag of releaseTags()) {
      const url = opts.baseUrl ? `${opts.baseUrl}/${asset}` : `https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}/${asset}`;
      console.log(`[media] ffmpeg nahi mila — ${asset} (${tag}) download ho raha hai…`);
      if (await downloadGz(url, target) && works(target)) { good = target; console.log('[media] ✅ ffmpeg download ho gaya'); break; }
      if (opts.baseUrl) break;
    }
  }
  if (!good) { console.log('[media] ⚠️ ffmpeg available nahi — sticker/video/audio commands kaam nahi karengi'); return null; }

  // every command that just calls "ffmpeg" (Baileys video thumbnails, shell helpers) finds it through PATH
  const binLink = path.join(BIN, 'ffmpeg');
  if (good !== binLink && !works(binLink)) link(good, binLink);
  if (!String(process.env.PATH || '').split(path.delimiter).includes(BIN)) process.env.PATH = BIN + path.delimiter + (process.env.PATH || '');
  process.env.FFMPEG_PATH = good;
  _ffmpeg = good;
  return good;
}

function ffmpegPath() { return _ffmpeg || process.env.FFMPEG_PATH || staticPath() || 'ffmpeg'; }

/** boot: heal ffmpeg + print one diagnostic line (never throws, never blocks start-up) */
function init() {
  if (_initP) return _initP;
  _initP = (async () => {
    let ff = null;
    try { ff = await ensureFfmpeg(); } catch (e) { console.log('[media] ffmpeg check error:', e.message); }
    let ver = '';
    try { if (ff) ver = String(execFileSync(ff, ['-version'], { timeout: 8000 })).split('\n')[0].replace(/^ffmpeg version\s*/i, '').split(' ')[0]; } catch (_) {}
    let sharpState = 'ok';
    try { require('sharp'); } catch (e) { sharpState = 'FAILED (' + String(e.message).split('\n')[0].slice(0, 70) + ')'; }
    let bv = '?';
    try { bv = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@whiskeysockets', 'baileys', 'package.json'), 'utf8')).version; } catch (_) {}
    console.log(`[media] ffmpeg=${ff ? ff + (ver ? ' v' + ver : '') : 'MISSING'} | sharp=${sharpState} | baileys=${bv}`);
  })().catch(() => {});
  return _initP;
}

// ── image helpers ───────────────────────────────────────────────────────────────
/** width/height from the file header (PNG / JPEG / GIF / WEBP) — no library needed */
function imageSize(b) {
  try {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const t = b.toString('ascii', 12, 16);
      if (t === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (t === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
      if (t === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch (_) {}
  return null;
}

function ffmpegThumb(buf) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn(ffmpegPath(), ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', 'scale=32:32:force_original_aspect_ratio=decrease',
        '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '8', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks = [];
      p.stdout.on('data', (c) => chunks.push(c));
      p.on('error', () => finish(null));
      p.on('close', () => { const o = Buffer.concat(chunks); finish(o.length > 100 && o[0] === 0xff && o[1] === 0xd8 ? o : null); });
      p.stdin.on('error', () => {});
      p.stdin.end(buf);
      setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} finish(null); }, 15000).unref?.();
    } catch (_) { finish(null); }
  });
}

/** { jpegThumbnail, width, height } for an image buffer, or null */
async function thumbFor(buf) {
  try {
    const sharp = require('sharp');
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    const jpegThumbnail = await sharp(buf, { failOn: 'none' }).resize(32, 32, { fit: 'inside' }).jpeg({ quality: 50 }).toBuffer();
    if (meta.width && meta.height) return { jpegThumbnail, width: meta.width, height: meta.height };
  } catch (_) { /* sharp missing / broken → ffmpeg */ }
  const size = imageSize(buf);
  const jpegThumbnail = await ffmpegThumb(buf);
  if (jpegThumbnail && size) return { jpegThumbnail, width: size.width, height: size.height };
  return null;
}

/**
 * Fill the thumbnail / width / height of an uploaded imageMessage when Baileys could not.
 * @returns 'had' | 'added' | 'MISSING' | 'n/a'
 */
async function fixImageInner(inner, buf) {
  const im = inner && inner.imageMessage;
  if (!im || !buf) return 'n/a';
  if (im.jpegThumbnail && im.jpegThumbnail.length && im.width && im.height) return 'had';
  const t = await thumbFor(buf);
  if (!t) return 'MISSING';
  if (!im.jpegThumbnail || !im.jpegThumbnail.length) im.jpegThumbnail = t.jpegThumbnail;
  if (!im.width) im.width = t.width;
  if (!im.height) im.height = t.height;
  return 'added';
}

module.exports = { init, ensureFfmpeg, ffmpegPath, imageSize, thumbFor, fixImageInner };
