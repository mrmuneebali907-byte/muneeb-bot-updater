/**
 * yt-dlp integration — reliable media downloads for YouTube, TikTok, Instagram, Twitter
 *
 * Binary: bin/yt-dlp (persisted in project root)
 * ffmpeg: auto-detected from PATH or Replit Nix store
 *
 * Exports:
 *   getUrl(url, format)                            → [videoUrl, audioUrl?]
 *   getInfo(url)                                   → JSON metadata
 *   download(url, outputPath, opts)                → { title, sizeMB, outputPath }
 *   YTDLP_PATH, FFMPEG_PATH
 *
 * BUGS FIXED vs old version:
 *  1. stderr was NOT piped in parseLine — error lines were never caught → "yt-dlp extraction failed"
 *  2. friendlyYtdlpError: errLines filter was checking line.startsWith('[') on STDERR which
 *     yt-dlp always prefixes with [ExtractorName] — so errLines stayed EMPTY → fallback generic msg
 *  3. --cookies-from-browser removed (crashes on headless/Replit — no browser available)
 *  4. Added --extractor-retries 3 + --fragment-retries 5 for network flakiness
 *  5. Added proper User-Agent to bypass bot blocks
 *  6. getUrl format improved — YouTube now needs bestvideo+bestaudio merge
 *  7. download() format selector fixed — was missing fallback for non-mp4 sites (TikTok/IG)
 *  8. Added auto-update check logic (stale binary = most common cause of extraction fail)
 */

'use strict';

const { execFile, execFileSync, spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const warp = require('./warp'); // free Cloudflare WARP tunnel (starts itself in background)

// ── Paths ─────────────────────────────────────────────────────────────────────
const YTDLP_PATH = path.join(__dirname, '..', 'bin', 'yt-dlp');
// Optional Netscape cookies file. Never create or print this file; when the
// owner supplies it, yt-dlp can use an authenticated YouTube session instead
// of being blocked by YouTube's IP challenge.
const COOKIES_PATH = process.env.YTDLP_COOKIES_FILE
  ? path.resolve(process.env.YTDLP_COOKIES_FILE)
  : path.join(__dirname, '..', 'cookies.txt');

// Auto-detect ffmpeg
let FFMPEG_PATH = null;
try {
  FFMPEG_PATH = execFileSync('which', ['ffmpeg'], { timeout: 3000 }).toString().trim();
} catch {
  const nixPaths = [
    '/nix/store/inqkj79vydizl6ja0d8af99qlxbmyr84-replit-runtime-path/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  for (const p of nixPaths) {
    if (fs.existsSync(p)) { FFMPEG_PATH = p; break; }
  }
}
console.log(`[ytdlp] binary: ${YTDLP_PATH} | ffmpeg: ${FFMPEG_PATH || 'NOT FOUND — merging disabled'}`);
console.log(`[ytdlp] cookies: ${fs.existsSync(COOKIES_PATH) ? 'loaded' : 'not found (direct YouTube may be blocked)'}`);

// yt-dlp needs a JS runtime to solve YouTube's challenges. Node is already here,
// so hand it over — but only if this yt-dlp build knows the flag (old builds would error).
let JS_RUNTIME_ARGS = [];
try {
  if (fs.existsSync(YTDLP_PATH)) {
    const help = execFileSync(YTDLP_PATH, ['--help'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }).toString();
    if (help.includes('--js-runtimes')) JS_RUNTIME_ARGS = ['--js-runtimes', `node:${process.execPath}`];
  }
} catch (_) {}
console.log(`[ytdlp] js-runtime: ${JS_RUNTIME_ARGS.length ? 'node enabled' : 'not supported by this yt-dlp build'}`);

// ── Ensure binary is present ──────────────────────────────────────────────────
function ensureBinary() {
  if (!fs.existsSync(YTDLP_PATH)) {
    throw new Error(
      'yt-dlp binary missing.\nRun: mkdir -p bin && curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp && chmod +x bin/yt-dlp'
    );
  }
}

// ── Base args used in every call ─────────────────────────────────────────────
function baseArgs(noCookies = false, proxy = null) {
  const a = [
    '--no-playlist',
    '--no-check-certificates',
    '--geo-bypass',
    '--no-warnings',
    '--extractor-retries', '3',          // FIX: retry on extractor fail
    '--fragment-retries',  '5',          // FIX: retry fragments on network hiccup
    '--socket-timeout',    '30',         // FIX: don't hang forever
    '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    // yt-dlp's official remote EJS component helps with current YouTube
    // JavaScript challenges when the host has no browser runtime configured.
    '--remote-components', 'ejs:github',
  ];
  a.push(...JS_RUNTIME_ARGS);
  if (proxy) a.push('--proxy', proxy);
  if (!noCookies && fs.existsSync(COOKIES_PATH)) a.push('--cookies', COOKIES_PATH);
  if (FFMPEG_PATH) a.push('--ffmpeg-location', FFMPEG_PATH);
  return a;
}

// ── BUG FIX: friendlyYtdlpError ──────────────────────────────────────────────
// OLD CODE BUG: errLines filter used !line.startsWith('[') which skips ALL yt-dlp error
// lines because yt-dlp formats errors as "[youtube] ERROR: ..." or "[ExtractorName] ..."
// Result: errLines was always EMPTY → fallback "yt-dlp extraction failed" every time!
//
// FIX: Capture lines that contain "ERROR" keyword (case-insensitive) regardless of prefix
function friendlyYtdlpError(stderr) {
  if (!stderr) return 'yt-dlp extraction failed (no error output)';
  const s = stderr.toLowerCase();

  // Known friendly messages
  if (/not a bot|confirm you.re not/i.test(s))            return 'YouTube bot-check (server IP is flagged)';
  if (/private|login required|sign in/i.test(s))          return 'Video is private or requires login';
  if (/not available|removed|deleted|not found/i.test(s)) return 'Video not found or deleted';
  if (/geo.?block|not available in your country/i.test(s)) return 'Video is geo-blocked (region locked)';
  if (/age.?restrict/i.test(s))                           return 'Video is age-restricted';
  if (/copyright/i.test(s))                               return 'Video blocked due to copyright';
  if (/too many requests|rate.?limit/i.test(s))           return 'Rate limited — try again in a few minutes';
  if (/http error 403|403 forbidden/i.test(s))            return 'YouTube media stream rejected (403) — refresh the cookies file and try again';
  if (/network|connection|timed? ?out|unreachable/i.test(s)) return 'Network error — check internet connection';
  if (/unsupported url/i.test(s))                         return 'Unsupported URL — this site is not supported';

  // FIX: Collect actual ERROR lines (yt-dlp outputs "[SiteName] ERROR: reason")
  // OLD: was filtering OUT lines starting with '[' — that removed ALL yt-dlp errors!
  // NEW: filter FOR lines that contain ERROR keyword
  const errorLines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && /error/i.test(l) && !/^WARNING/i.test(l))
    .slice(0, 3)
    .join(' ')
    .trim();

  if (errorLines) return errorLines.slice(0, 300);

  // Last resort: first non-empty, non-warning line
  const firstLine = stderr
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !/^WARNING/i.test(l));

  return (firstLine || 'yt-dlp extraction failed').slice(0, 300);
}

// ── getUrl ────────────────────────────────────────────────────────────────────
/**
 * Get direct streaming URL(s) for a media URL.
 * @param {string} url
 * @param {string} format
 * @returns {Promise<string[]>}
 */
function getUrl(url, format = null) {
  ensureBinary();
  // FIX: Better format selector — YouTube needs bestvideo+bestaudio but TikTok/IG don't
  // Old format broke on non-YouTube sites that don't have separate audio streams
  const fmt = format || [
    'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
    'bestvideo[height<=720]+bestaudio',
    'best[height<=720][ext=mp4]',
    'best[height<=720]',
    'best',
  ].join('/');

  return new Promise((resolve, reject) => {
    const args = [...baseArgs(), '--get-url', '-f', fmt, '--', url];
    execFile(YTDLP_PATH, args, { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(friendlyYtdlpError(stderr || err.message)));
      const urls = stdout.trim().split('\n').filter(Boolean);
      if (!urls.length) return reject(new Error('yt-dlp returned no streaming URL'));
      resolve(urls);
    });
  });
}

// ── getInfo ───────────────────────────────────────────────────────────────────
function getInfo(url) {
  ensureBinary();
  return new Promise((resolve, reject) => {
    const args = [...baseArgs(), '-j', '--', url];
    execFile(YTDLP_PATH, args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(friendlyYtdlpError(stderr || err.message)));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('Failed to parse yt-dlp metadata JSON')); }
    });
  });
}

// ── download ──────────────────────────────────────────────────────────────────
/**
 * Download media to outputPath. Merges video+audio via ffmpeg when needed.
 * @param {string} url
 * @param {string} outputPath
 * @param {object} opts
 * @returns {Promise<{title, sizeMB, outputPath}>}
 */
function download(url, outputPath, opts = {}) {
  ensureBinary();
  const {
    // FIX: Old format was too strict — TikTok/IG/Twitter don't have mp4+m4a combos
    // Added broader fallbacks so non-YouTube sites don't fail
    format     = FFMPEG_PATH
      ? 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720][ext=mp4]/best[height<=720]/best'
      : 'best[height<=720][ext=mp4]/best[height<=720]/best',
    onProgress  = null,
    timeout     = 300_000,
    audioOnly   = false,
    extractorArgs = null,   // e.g. 'youtube:player_client=tv_embedded'
    noCookies     = false,  // some clients work better WITHOUT the account cookies
    maxFilesizeMB = 0,      // abort early (before downloading) if the file is bigger
    useWarp       = false,  // route through the free Cloudflare WARP tunnel (different IP)
  } = opts;

  // Audio-only override
  const finalFormat = audioOnly
    ? 'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best'
    : format;

  const proxy = useWarp ? warp.getProxy() : null;
  if (useWarp && !proxy) return Promise.reject(new Error('WARP tunnel not active'));

  return new Promise((resolve, reject) => {
    const args = [
      ...baseArgs(noCookies, proxy),
      ...(maxFilesizeMB ? ['--max-filesize', `${maxFilesizeMB}M`] : []),
      ...(extractorArgs ? ['--extractor-args', extractorArgs] : []),
      '--print', 'title',
      '--no-simulate',
      '-f', finalFormat, '--merge-output-format', 'mp4',
      '-o', outputPath,
      '--newline',
      '--progress',
      '--',
      url,
    ];

    const proc = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let lastTitle   = '';
    let errLines    = [];
    let stderrLines = [];   // FIX: was missing separate stderr collection
    let resolved    = false;
    let lastPct     = -1;
    let titleCaught = false;
    let tooLarge    = false;
    const sawLarge  = (l) => { if (/larger than max-filesize/i.test(l)) tooLarge = true; };

    // FIX: Separate parsers for stdout and stderr
    // OLD: proc.stderr data was also going through parseLine which only caught
    //      progress/title — stderr ERROR lines were silently dropped!
    const parseStdoutLine = (line) => {
      line = line.trim();
      if (!line) return;
      sawLarge(line);

      // First plain-text line = title (from --print title)
      if (!titleCaught && !line.startsWith('[') && !/^WARNING|^ERROR/i.test(line)) {
        lastTitle   = line;
        titleCaught = true;
        return;
      }

      // Progress: [download]  45.2% of   25.00MiB at   5.00MiB/s ETA 00:03
      const progM = line.match(/\[download\]\s+(\d+\.?\d*)%/);
      if (progM) {
        const pct = parseFloat(progM[1]);
        if (pct !== lastPct && onProgress) {
          lastPct = pct;
          try { onProgress(pct); } catch (_) {}
        }
      }
    };

    // FIX: stderr lines go to their own collector for proper error reporting
    const parseStderrLine = (line) => {
      line = line.trim();
      sawLarge(line);
      if (!line || /^WARNING/i.test(line)) return;
      stderrLines.push(line);
    };

    proc.stdout.on('data', d => d.toString().split('\n').forEach(parseStdoutLine));
    proc.stderr.on('data', d => d.toString().split('\n').forEach(parseStderrLine));  // FIX

    // Hard timeout
    const timer = setTimeout(() => {
      if (!resolved) {
        proc.kill('SIGKILL');
        resolved = true;
        reject(new Error('Download timed out (5 min limit)'));
      }
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;

      if (tooLarge) return reject(Object.assign(new Error('FILE_TOO_LARGE'), { code: 'FILE_TOO_LARGE' }));

      if (code !== 0) {
        // FIX: now uses stderrLines (properly collected) instead of errLines (was always empty)
        const errMsg = friendlyYtdlpError(stderrLines.join('\n')) || `yt-dlp exit code ${code}`;
        return reject(new Error(errMsg));
      }

      // Resolve actual output path (yt-dlp may rename after merge)
      let actualPath = outputPath;
      if (!fs.existsSync(actualPath)) {
        const base = outputPath.replace(/\.\w+$/, '');
        for (const ext of ['mp4', 'mkv', 'webm', 'm4v', 'm4a', 'mp3', 'opus', 'ogg']) {
          const alt = `${base}.${ext}`;
          if (fs.existsSync(alt)) { actualPath = alt; break; }
        }
      }

      const sizeMB = fs.existsSync(actualPath)
        ? +(fs.statSync(actualPath).size / 1024 / 1024).toFixed(1)
        : 0;

      resolve({
        title: lastTitle || path.basename(outputPath, path.extname(outputPath)),
        sizeMB,
        outputPath: actualPath,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!resolved) { resolved = true; reject(err); }
    });
  });
}

// ── Temp path helper ──────────────────────────────────────────────────────────
function tmpPath(prefix = 'dl', ext = '.mp4') {
  return path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`);
}

// ── Binary version check (run once at startup) ────────────────────────────────
// Stale yt-dlp binary is the #1 cause of "extraction failed" for YouTube
// yt-dlp updates its extractors weekly — old binary = broken
function checkBinaryAge() {
  try {
    if (!fs.existsSync(YTDLP_PATH)) return;
    const stats     = fs.statSync(YTDLP_PATH);
    const ageDays   = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageDays > 30) {
      console.warn(
        `[ytdlp] ⚠️  WARNING: yt-dlp binary is ${Math.floor(ageDays)} days old!\n` +
        `         YouTube extraction WILL fail with old binaries.\n` +
        `         Update: curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${YTDLP_PATH} && chmod +x ${YTDLP_PATH}`
      );
    } else {
      console.log(`[ytdlp] Binary age: ${Math.floor(ageDays)} days — OK`);
    }
  } catch (_) {}
}
checkBinaryAge();

module.exports = { getUrl, getInfo, download, tmpPath, YTDLP_PATH, FFMPEG_PATH };
