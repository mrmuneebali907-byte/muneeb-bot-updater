/**
 * YouTube Video Downloader — v7
 *
 * FORMAT STRATEGY:
 *   Format 18 = pre-merged 360p MP4 (video+audio in one stream, no ffmpeg needed)
 *   Avoids adaptive streams (720p=429MB + audio=101MB = 530MB crash risk)
 *
 * SIZE RULES:
 *   < 50 MB   → WhatsApp video message (plays inline)
 *   50 MB – ~1.5 GB (disk permitting) → WhatsApp document (WhatsApp allows 2 GB)
 *   bigger than that → direct stream link
 *
 * FALLBACK CHAIN:
 *   Tier 1 — YouTube yt-dlp android_vr (default)
 *   Tier 2 — YouTube yt-dlp android client
 *   Tier 3 — YouTube yt-dlp tv_embedded client
 *   Tier 4 — YouTube yt-dlp any format
 *   Tier 5 — Dailymotion: API search → yt-dlp --get-url → ffmpeg download
 *
 * WHY DAILYMOTION:
 *   YouTube blocks popular South Asian music videos from Replit IPs ("Sign in
 *   to confirm you're not a bot"). Dailymotion has the same content and
 *   yt-dlp can extract the m3u8 URL; ffmpeg downloads it cleanly.
 */

'use strict';

const yts        = require('yt-search');
const fs         = require('fs');
const https      = require('https');
const os         = require('os');
const path       = require('path');
const { execFile, spawn } = require('child_process');
const config     = require('../../config');
const ytdlp      = require('../../utils/ytdlp');
const { deleteTempFile } = require('../../utils/mediaDownloader');
const freeDl     = require('../../utils/freeDl');
const waVideo    = require('../../utils/waVideo');

// ── Size limits ───────────────────────────────────────────────────────────────
const VIDEO_MSG_MAX_MB = 50;    // inline video
// WhatsApp lets a DOCUMENT be up to 2 GB, so even a full movie can be sent as a file.
// Real limit here = what the server can hold: the file + Baileys' encrypted copy ≈ 2.3× size on disk.
const MAX_DOC_ENV = +process.env.MAX_DOC_MB || 1500;
function docMax() {
  let freeMB = 2000;
  try { const st = fs.statfsSync(os.tmpdir()); freeMB = st.bavail * st.bsize / 1048576; } catch (_) {}
  return Math.max(60, Math.min(MAX_DOC_ENV, Math.floor(freeMB / 2.3)));
}
// Limit is fixed once per command, otherwise the growing temp file would shrink it mid-download.
let ACTIVE_LIMIT = 0;
const limitMB = () => ACTIVE_LIMIT || docMax();
const LONG_VIDEO_SEC   = 400 * 60; // > 6h40m can't fit even at 240p → straight to link

// ── Download strategies — tried in order until one succeeds ───────────────────
// Quality adapts to length so a long clip still fits under the 200 MB cap.
const heightFor = (sec) => (sec > 200 * 60 ? 240 : 360);
const fmt = (h) => `bestvideo[height<=${h}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/18/best[height<=${h}][ext=mp4]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;

const DOWNLOAD_STRATEGIES = [
  // OWNER'S OWN PROXY (env YT_PROXY=http://user:pass@host:port) — a residential/home-IP proxy is the most reliable route
  ...(process.env.YT_PROXY ? [
    { name: 'YouTube via PROXY',              format: fmt, extractorArgs: null, useProxy: true },
    { name: 'YouTube via PROXY (no cookies)', format: fmt, extractorArgs: null, useProxy: true, noCookies: true },
  ] : []),
  // FREE route #1: same YouTube download but through the Cloudflare WARP tunnel (different IP)
  { name: 'YouTube via WARP',            format: fmt, extractorArgs: null, noCookies: true, useWarp: true },
  { name: 'YouTube via WARP (cookies)',  format: fmt, extractorArgs: null, useWarp: true },
  { name: 'YouTube via WARP (ios)',      format: fmt, extractorArgs: 'youtube:player_client=ios', noCookies: true, useWarp: true },
  // FREE route #3: Cobalt — only when COBALT_API_URL is set in env
  ...(process.env.COBALT_API_URL ? [{
    name: 'Cobalt',
    fn: async (tmpOut, { h, onProgress, ytUrl }) => {
      const r = await freeDl.resolveCobalt(ytUrl, { maxHeight: h });
      const out = await freeDl.streamToFile(r.url, tmpOut, { maxMB: limitMB(), onProgress, totalMs: 3 * 3600 * 1000 });
      return { ...out, title: r.title };
    },
  }] : []),
  { name: 'YouTube (default client)', format: fmt, extractorArgs: null },
  // FREE route #2: Piped / Invidious public servers download it with THEIR IP (no YouTube block)
  {
    name: 'Piped/Invidious (free proxy)',
    fn: async (tmpOut, { h, onProgress, ytUrl }) => {
      const r = await freeDl.resolveYoutube(freeDl.videoIdOf(ytUrl), { maxHeight: h });
      const out = await freeDl.streamToFile(r.url, tmpOut, { maxMB: limitMB(), onProgress, totalMs: 3 * 3600 * 1000 });
      return { ...out, title: r.title };
    },
  },
  { name: 'YouTube (ios client)',        format: fmt, extractorArgs: 'youtube:player_client=ios' },
  { name: 'YouTube (mweb, no cookies)',  format: fmt, extractorArgs: 'youtube:player_client=mweb', noCookies: true },
  { name: 'YouTube (android client)',    format: fmt, extractorArgs: 'youtube:player_client=android' },
  { name: 'YouTube (tv_embedded)',       format: fmt, extractorArgs: 'youtube:player_client=tv_embedded' },
  { name: 'YouTube (web_safari)',        format: fmt, extractorArgs: 'youtube:player_client=web_safari', noCookies: true },
];

// ── Dailymotion fallback helpers ──────────────────────────────────────────────

/** Search Dailymotion API, return array of {id, title, url}. */
function dmSearch(query) {
  return new Promise(resolve => {
    const q = encodeURIComponent(String(query || '').trim());
    if (!q) return resolve([]);
    https.get({
      hostname: 'api.dailymotion.com',
      path    : `/videos?search=${q}&limit=10&fields=id,title,url,duration&sort=relevance`,
      timeout : 12_000,
      headers : { 'User-Agent': 'Mozilla/5.0' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const body = JSON.parse(d);
          resolve(Array.isArray(body.list) ? body.list.filter(v => v?.id) : []);
        }
        catch { resolve([]); }
      });
    })
    .on('error', () => resolve([]))
    .on('timeout', function () { this.destroy(); resolve([]); });
  });
}

/**
 * YouTube titles often contain search-hostile decorations such as emoji,
 * "[Official Video]", "(4K Remaster)", artist separators, and long metadata.
 * Dailymotion search is more reliable with short meaningful variants.
 */
function dailymotionQueries(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];

  const withoutDecorations = raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(official|officially|music|video|audio|lyrics?|visualizer|4k|8k|hd|full|remaster(?:ed)?)\b/gi, ' ')
    .replace(/[|•·]/g, ' ')
    .replace(/[^\p{L}\p{N}\s'&-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const beforeSeparator = raw.split(/\s+[|:]\s+|\s+-\s+/)[0].trim();
  const words = withoutDecorations.split(/\s+/).filter(Boolean);

  return [...new Set([
    raw.slice(0, 140),
    withoutDecorations.slice(0, 120),
    beforeSeparator.slice(0, 120),
    words.slice(0, 9).join(' '),
    words.slice(0, 6).join(' '),
  ].filter(q => q.length >= 2))];
}

function titleTokens(value) {
  return String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function minimumTitleScore(tokenCount) {
  if (tokenCount <= 2) return tokenCount;
  return Math.max(2, Math.ceil(tokenCount * 0.6));   // was 0.35 → picked unrelated videos
}

/** Search normalized variants and rank results by token overlap. */
async function searchDailymotion(title) {
  const queries = dailymotionQueries(title);
  let best = [];
  let bestQuery = '';

  for (const query of queries) {
    const results = await dmSearch(query);
    if (!results.length) continue;

    const wanted = new Set(titleTokens(query).filter(token => token.length > 1));
    const minimumScore = minimumTitleScore(wanted.size);
    const ranked = results
      .map(video => {
        const candidate = new Set(titleTokens(video.title));
        const score = [...wanted].reduce((n, token) => n + (candidate.has(token) ? 1 : 0), 0);
        return {
          video,
          score,
          ratio: wanted.size ? score / wanted.size : 0,
        };
      })
      .filter(item => item.score >= minimumScore)
      .sort((a, b) => b.score - a.score || b.ratio - a.ratio)
      .map(item => item.video);

    if (ranked.length > best.length) {
      best = ranked;
      bestQuery = query;
    }

    if (ranked.length) {
      return { results: ranked, query };
    }
  }

  return { results: best, query: bestQuery };
}

/** Resolve a YouTube title without using the blocked media extractor. */
function youtubeOembedTitle(url) {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return resolve(''); }
    const endpoints = [
      {
        hostname: 'www.youtube.com',
        path: `/oembed?url=${encodeURIComponent(parsed.toString())}&format=json`,
      },
      {
        hostname: 'noembed.com',
        path: `/embed?url=${encodeURIComponent(parsed.toString())}`,
      },
    ];

    const next = (index) => {
      if (index >= endpoints.length) return resolve('');
      const req = https.get({
        ...endpoints[index],
        timeout: 12_000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const title = JSON.parse(body).title || '';
            if (title) return resolve(title);
          } catch (_) {}
          next(index + 1);
        });
      });
      req.on('error', () => next(index + 1));
      req.on('timeout', () => { req.destroy(); next(index + 1); });
    };

    next(0);
  });
}

/** Get direct video/audio m3u8 URLs from Dailymotion via yt-dlp --get-url. */
function dmGetUrl(dmUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '--no-check-certificates', '--geo-bypass',
      '--no-warnings', '--get-url',
      '-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]/best',
      '--', dmUrl,
    ];
    execFile(ytdlp.YTDLP_PATH, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`DM url-extract: ${stderr?.trim().slice(0, 120) || err.message}`));
      const urls = stdout.trim().split(/\r?\n/).filter(l => l.startsWith('http'));
      if (!urls.length) return reject(new Error('DM: no URL returned'));
      resolve(urls);
    });
  });
}

/** Download one or separate video/audio URLs to destPath using ffmpeg (crash-safe: tries another ffmpeg binary). */
async function ffmpegDownload(streamUrl, destPath) {
  const urls = Array.isArray(streamUrl) ? streamUrl : [streamUrl];
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
  for (const url of urls) args.push('-i', url);
  if (urls.length >= 2) args.push('-map', '0:v:0?', '-map', '1:a:0?', '-c:v', 'copy', '-c:a', 'copy');
  else args.push('-c', 'copy');
  args.push('-movflags', '+faststart', destPath);
  const r = await require('../../utils/ffmpegBin').runAny(args, { timeoutMs: 1_800_000 });
  if (r.code === 0 && fs.existsSync(destPath)) return;
  throw new Error(`ffmpeg exit ${r.code}${r.bin ? ' (' + path.basename(r.bin) + ')' : ''}: ${String(r.err || '').trim().slice(-250)}`);
}

/** Full Dailymotion search → download → send pipeline */
async function downloadAndSendViaDailymotion(sock, chatId, searchTitle, statusKey, quotedMsg, expectedSec = 0) {
  const botName = config.botName || 'Bot';
  console.log(`[VIDEO] [DM] Searching Dailymotion for: "${searchTitle}"`);

  const search = await searchDailymotion(searchTitle);
  let results = search.results;
  // Only accept a copy whose length matches the real YouTube video (±12%, min 15s); no length known → don't guess
  if (!expectedSec) results = [];
  else results = results.filter(v => v.duration && Math.abs(v.duration - expectedSec) <= Math.max(15, expectedSec * 0.12));
  if (!results.length) {
    throw new Error(
      `Dailymotion: no matching copy found after ${dailymotionQueries(searchTitle).length || 1} search variants`
    );
  }

  // Pick first result
  const dmVideo = results[0];
  const title   = dmVideo.title || searchTitle;
  const dmUrl   = dmVideo.url || `https://www.dailymotion.com/video/${dmVideo.id}`;
  console.log(`[VIDEO] [DM] Found via "${search.query}": "${title}" → ${dmUrl}`);

  await editStatus(sock, chatId, statusKey,
    `🎬 *Found:* _${title}_\n⬇️ Downloading...`
  );

  const tmpFile0 = path.join(os.tmpdir(), `dm_${Date.now()}.mp4`);
  let tmpFile = tmpFile0;
  let dmFixed = null;
  try {
    // 1) yt-dlp itself (own HLS downloader, no ffmpeg needed for single-stream formats)
    let got = false;
    try {
      const r = await ytdlp.download(dmUrl, tmpFile0, {
        format: 'best[height<=480]/best[height<=720]/best', maxFilesizeMB: limitMB(), timeout: 900_000,
      });
      if (r && r.outputPath && fs.existsSync(r.outputPath)) { tmpFile = r.outputPath; got = true; console.log('[VIDEO] [DM] downloaded by yt-dlp'); }
    } catch (e) { console.log('[VIDEO] [DM] yt-dlp download failed:', e.message.slice(0, 120), '→ ffmpeg'); }

    // 2) ffmpeg on the stream URLs (fallback)
    if (!got) {
      const streamUrl = await dmGetUrl(dmUrl);
      console.log('[VIDEO] [DM] Stream URL extracted, downloading via ffmpeg...');
      await ffmpegDownload(streamUrl, tmpFile0);
    }

    let sizeMB = fs.existsSync(tmpFile)
      ? +(fs.statSync(tmpFile).size / 1024 / 1024).toFixed(1)
      : 0;
    console.log(`[VIDEO] [DM] Downloaded: ${sizeMB} MB`);

    if (sizeMB === 0) throw new Error('Dailymotion: download produced empty file');
    if (sizeMB > limitMB()) throw new Error(`Dailymotion: file too large (${sizeMB.toFixed(0)} MB)`);

    const dmPrep = await waVideo.prepare(tmpFile, { onStatus: (t) => editStatus(sock, chatId, statusKey, t) });
    if (dmPrep.path !== tmpFile) { dmFixed = dmPrep.path; }
    sizeMB = dmPrep.sizeMB || sizeMB;

    const safeFile = title.replace(/[^\w\s\-]/g, '').trim().slice(0, 80) || 'video';
    const caption  = `*${title}*\n\n> *_Downloaded by Mr. Muneeb Ali_*`;

    await editStatus(sock, chatId, statusKey, '📤 *Uploading to WhatsApp...*');

    const buf = { url: dmFixed || tmpFile }; // streamed from disk
    if (sizeMB > VIDEO_MSG_MAX_MB) {
      await sock.sendMessage(chatId, {
        document : buf, mimetype: 'video/mp4',
        fileName : `${safeFile}.mp4`,
        caption  : `${caption}\n\n📁 *Sent as file* (${sizeMB.toFixed(0)} MB)\n_Tap to download / play_`,
      }, { quoted: quotedMsg });
    } else {
      await sock.sendMessage(chatId, {
        video: buf, mimetype: 'video/mp4', fileName: `${safeFile}.mp4`, caption,
      }, { quoted: quotedMsg });
    }
    await sock.sendMessage(chatId, { react: { text: '✅', key: quotedMsg.key } }).catch(() => {});
    console.log(`[VIDEO] [DM] ✅ Sent: "${title}"`);
  } finally {
    deleteTempFile(tmpFile);
    if (dmFixed) deleteTempFile(dmFixed);
  }
}

// ── Progress bar helper ───────────────────────────────────────────────────────
function bar(pct) {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '█'.repeat(n) + '░'.repeat(10 - n) + ` ${Math.round(pct)}%`;
}

// Edit the status message (silently fails if edit not supported)
async function editStatus(sock, chatId, key, text) {
  if (!key) return;
  try { await sock.sendMessage(chatId, { text, edit: key }); } catch (_) {}
}

// ── Get best stream URL (for link fallback on very large videos) ──────────────
async function getStreamUrl(ytUrl) {
  try {
    const urls = await ytdlp.getUrl(ytUrl, '18/best[height<=360][ext=mp4]/best[height<=480][ext=mp4]/best[ext=mp4]/best');
    return urls?.[0] || null;
  } catch { return null; }
}

// ── Big video → friendly message with working links ────────────────────────────
async function sendLargeLink(sock, chatId, ytUrl, statusKey, quotedMsg, title, sizeMB) {
  let stream = null;
  try {
    const r = await freeDl.resolveYoutube(freeDl.videoIdOf(ytUrl), { maxHeight: 360 });
    stream = r.url;                       // proxied URL — opens from any phone
  } catch (_) {}
  const text =
    `📦 *Video bohot bari hai${sizeMB ? ` (${Math.round(sizeMB)} MB)` : ''}* — file ke taur par bhejna mumkin nahi, ye link use karein.\n\n` +
    `🎬 *${title || 'Video'}*\n\n` +
    `▶️ *YouTube link:*\n${ytUrl}` +
    (stream ? `\n\n🔗 *Direct stream link:*\n${stream}` : '');
  await editStatus(sock, chatId, statusKey, text);
  await sock.sendMessage(chatId, { react: { text: '🔗', key: quotedMsg.key } }).catch(() => {});
}

// ── Core download + send (one strategy attempt) ───────────────────────────────
async function downloadAndSend(sock, chatId, ytUrl, knownTitle, statusMsgKey, quotedMsg, strategy, meta = {}) {
  const botName = config.botName || 'Bot';

  const tmpOut = ytdlp.tmpPath('ytv', '.mp4');
  let outFile  = null;
  let lastPct  = -1;
  let lastEdit = 0;

  const onProgress = async (pct) => {
    if (pct - lastPct < 5 || Date.now() - lastEdit < 4000) return;
    lastPct  = pct;
    lastEdit = Date.now();
    await editStatus(sock, chatId, statusMsgKey,
      `⬇️ *Downloading...*\n\n${bar(pct)}\n💬 Bot stays responsive while downloading!`
    );
  };

  try {
    console.log(`[VIDEO] [${strategy.name}] yt-dlp → ${ytUrl}`);

    const h = heightFor(meta.seconds || 0);
    // Long videos / movies need more time: 40 min minimum, up to 3 h (≈ 0.6 s of waiting per second of video)
    const dlTimeout = Math.min(3 * 3600 * 1000, Math.max(2_400_000, (meta.seconds || 0) * 600));
    const result = strategy.fn
      ? await strategy.fn(tmpOut, { h, onProgress, ytUrl })
      : await ytdlp.download(ytUrl, tmpOut, {
          format       : strategy.format(h),
          extractorArgs: strategy.extractorArgs,
          noCookies    : !!strategy.noCookies,
          useWarp      : !!strategy.useWarp,
          useProxy     : !!strategy.useProxy,
          maxFilesizeMB: limitMB(),       // abort BEFORE downloading if it can't fit
          onProgress,
          fragments    : (meta.seconds || 0) > 1800 ? 4 : 0,   // movies: download 4 pieces in parallel
          timeout      : dlTimeout,
        });

    outFile = result.outputPath;
    const title  = result.title || knownTitle || 'YouTube Video';
    let sizeMB = result.sizeMB;

    // ── Make sure the file is REAL WhatsApp-playable MP4 (H.264 + AAC, faststart) ──
    await editStatus(sock, chatId, statusMsgKey, '🛠️ *Checking / fixing video format...*');
    const prep = await waVideo.prepare(outFile, {
      onStatus: (t) => editStatus(sock, chatId, statusMsgKey, t),
    });
    outFile = prep.path;
    sizeMB  = prep.sizeMB || sizeMB;
    console.log(`[VIDEO] [${strategy.name}] format fix: ok=${prep.ok} transcoded=${prep.transcoded} → ${sizeMB} MB`);
    console.log(`[VIDEO] [${strategy.name}] Done: ${sizeMB} MB → "${title}"`);

    // ── Too large for WhatsApp: send link instead of file ────────────────────
    if (sizeMB > limitMB()) {
      await sendLargeLink(sock, chatId, ytUrl, statusMsgKey, quotedMsg, title, sizeMB);
      return;
    }

    const safeFile = title.replace(/[^\w\s\-]/g, '').trim().slice(0, 80) || 'video';
    const caption  = `*${title}*\n\n> *_Downloaded by Mr. Muneeb Ali_*`;

    await editStatus(sock, chatId, statusMsgKey, '📤 *Uploading to WhatsApp...*');

    const buf = { url: outFile }; // streamed from disk

    if (sizeMB > VIDEO_MSG_MAX_MB) {
      await sock.sendMessage(chatId, {
        document : buf,
        mimetype : 'video/mp4',
        fileName : `${safeFile}.mp4`,
        caption  : `${caption}\n\n📁 *Sent as file* (${sizeMB.toFixed(0)} MB)\n_Tap to download / play_`,
      }, { quoted: quotedMsg });
    } else {
      await sock.sendMessage(chatId, {
        video   : buf,
        mimetype: 'video/mp4',
        fileName: `${safeFile}.mp4`,
        caption,
      }, { quoted: quotedMsg });
    }

    await sock.sendMessage(chatId, { react: { text: '✅', key: quotedMsg.key } }).catch(() => {});

  } finally {
    if (outFile) deleteTempFile(outFile);
    const base = tmpOut.replace(/\.\w+$/, '');
    for (const x of ['mp4', 'mkv', 'webm', 'm4v', 'part', 'ytdl']) {
      deleteTempFile(`${base}.${x}`);
    }
  }
}

// Users only ever see "Method 1 / 2 / 3" — never the real source names or how many exist.
const shownMethod = (n, total) => Math.min(3, Math.floor((n - 1) * 3 / total) + 1);

// ── Multi-strategy cascading downloader ──────────────────────────────────────
// YouTube yt-dlp → Piped/Invidious (free proxy) → Cobalt (optional) → more YouTube
// clients → Dailymotion. A file that is too big short-circuits to the link message.
async function downloadWithFallback(sock, chatId, ytUrl, title, statusKey, quotedMsg, opts = {}) {
  const seconds = opts.seconds || 0;
  ACTIVE_LIMIT = docMax();
  const TOTAL = DOWNLOAD_STRATEGIES.length + 1; // +1 for Dailymotion
  let lastErr;
  const errs = [];

  // Movies / very long videos can never fit in 200 MB → don't waste time downloading
  if (seconds > LONG_VIDEO_SEC) {
    return sendLargeLink(sock, chatId, ytUrl, statusKey, quotedMsg, title, 0);
  }

  // YouTube says THIS video is blocked/unavailable for our region (not an IP/bot problem).
  // Trying more yt-dlp clients is pointless, so we skip them and let the caller pick another upload.
  const UNAVAILABLE_RE = /video unavailable|not made this video available|in your country|has been removed|private video|account associated|copyright grounds|blocked it/i;
  let unavailable = false;
  let botChecks   = 0;   // yt-dlp tiers that hit YouTube's "confirm you're not a bot" wall

  for (let i = 0; i < DOWNLOAD_STRATEGIES.length; i++) {
    const strategy   = DOWNLOAD_STRATEGIES[i];
    const stratLabel = `Tier ${i + 1}/${TOTAL}: ${strategy.name}`;
    // blocked video, or our IP is flagged (3 clients already failed the same way) → more yt-dlp clients are pointless;
    // only the tiers that use another route (Cobalt / Piped / proxy) are still worth trying
    if ((unavailable || botChecks >= 3) && !strategy.fn && !strategy.useProxy) continue;
    try {
      console.log(`[VIDEO] Trying ${stratLabel}`);
      return await downloadAndSend(sock, chatId, ytUrl, title, statusKey, quotedMsg, strategy, { seconds });
    } catch (err) {
      if (err.code === 'FILE_TOO_LARGE') {
        console.log(`[VIDEO] ${stratLabel} → file exceeds ${limitMB()} MB, sending link`);
        return sendLargeLink(sock, chatId, ytUrl, statusKey, quotedMsg, title, 0);
      }
      lastErr = err;
      errs.push(`${strategy.name}: ${err.message.slice(0, 60)}`);
      console.warn(`[VIDEO] ${stratLabel} failed: ${err.message}`);
      if (/bot-check|not a bot/i.test(err.message)) botChecks++;
      if (UNAVAILABLE_RE.test(err.message) && !/bot-check|sign in/i.test(err.message)) unavailable = true;
      await editStatus(sock, chatId, statusKey, `🔄 *Method ${shownMethod(i + 1, TOTAL)} try ho raha hai...*`);
      await new Promise(r => setTimeout(r, 800));
    }
  }

  if (unavailable && opts.tryNext) {
    console.warn('[VIDEO] this upload is unavailable here → trying the next search result');
    throw Object.assign(new Error('UNAVAILABLE'), { code: 'UNAVAILABLE' });
  }

  const searchTitle = title || '';
  if (searchTitle.trim()) {
    try {
      console.log(`[VIDEO] Trying Tier ${TOTAL}/${TOTAL}: Dailymotion`);
      await editStatus(sock, chatId, statusKey, '🔄 *Method 3 try ho raha hai...*');
      return await downloadAndSendViaDailymotion(sock, chatId, searchTitle, statusKey, quotedMsg, seconds || 0);
    } catch (dmErr) {
      lastErr = dmErr;
      errs.push(`Dailymotion: ${dmErr.message.slice(0, 60)}`);
      console.warn(`[VIDEO] Tier ${TOTAL} Dailymotion failed: ${dmErr.message}`);
    }
  }

  // Last resort: at least give the user something usable — the link
  console.warn('[VIDEO] All methods failed:\n  ' + errs.join('\n  '));
  throw new Error(
    `Is waqt ye video download nahi ho saki.\n\n` +
    `▶️ Video yahan dekh sakte hain: ${ytUrl}\n` +
    `_Thori der baad dobara try karein ya doosra title/link dein._`
  );
}

// ── Command definition ────────────────────────────────────────────────────────
module.exports = {
  name    : 'ytvideo',
  aliases : ['ytv', 'ytmp4', 'ytvid', 'video'],
  category: 'media',
  description: 'Download videos & movies (search or direct URL)',
  usage   : '.video <song/movie name or YouTube URL>',

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    try {
      const text = (args || []).join(' ').trim();

      if (!text) {
        return await sock.sendMessage(chatId, {
          text: [
            '📹 *Video Downloader*',
            '',
            '*Usage:* .video <name or URL>',
            '',
            '*Examples:*',
            '• .video Despacito',
            '• .video Rowdy Rathore full movie',
            '• .video https://youtu.be/abc123',
            '',
            '_Small clips (< 50 MB) → sent as video_',
            '_Under 50 MB → playable video_',
            '_Bigger (movies etc.) → sent as document file_',
          ].join('\n'),
        }, { quoted: msg });
      }

      await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } });

      const isUrl = /^https?:\/\//i.test(text);

      // ── Search flow ─────────────────────────────────────────────────────────
      if (!isUrl) {
        const statusMsg = await sock.sendMessage(chatId, {
          text: `🔍 *Searching...*\n_${text}_\n\n💬 Bot stays responsive!`,
        }, { quoted: msg });

        setImmediate(async () => {
          try {
            const { videos } = await yts(text);
            if (!videos?.length) {
              return await sock.sendMessage(chatId, {
                text: `❌ No results found for: *${text}*\n\nTry a more specific search term.`,
              }, { quoted: msg });
            }
            // Same search, up to 5 uploads: if one is blocked for our region, quietly try the next.
            const cands = videos.slice(0, 5);
            for (let ci = 0; ci < cands.length; ci++) {
              const v    = cands[ci];
              const last = ci === cands.length - 1;

              // Thumbnail preview only once (retries with the next upload stay invisible in the chat)
              if (ci === 0) {
                try {
                  await sock.sendMessage(chatId, {
                    image  : { url: v.thumbnail },
                    caption: `*${v.title}*\n⬇️ Downloading...`,
                  }, { quoted: msg });
                } catch (_) {}
              }

              await editStatus(sock, chatId, statusMsg.key,
                `⬇️ *Downloading:* _${v.title}_`
              );

              try {
                await downloadWithFallback(sock, chatId, v.url, v.title, statusMsg.key, msg,
                  { seconds: v.seconds || 0, tryNext: !last });
                return;
              } catch (e) {
                if (e.code === 'UNAVAILABLE' && !last) continue;   // next upload, no message to the user
                throw e;
              }
            }

          } catch (err) {
            console.error('[VIDEO] search+dl error:', err.message);
            await editStatus(sock, chatId, statusMsg.key,
              `❌ *Download failed*\n${err.message}`
            );
            await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }).catch(() => {});
          }
        });

        return;

      // ── Direct URL flow ─────────────────────────────────────────────────────
      } else {
        const ytMatch = text.match(
          /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/i
        );
        if (!ytMatch) {
          return await sock.sendMessage(chatId, {
            text: '❌ Not a valid YouTube link!\n\nExample: https://youtu.be/dQw4w9WgXcQ\n\nFor searches, just type the title without a URL.',
          }, { quoted: msg });
        }
        const ytId = ytMatch[1];

        let statusMsg = null;
        try {
          statusMsg = await sock.sendMessage(chatId, {
            image  : { url: `https://i.ytimg.com/vi/${ytId}/sddefault.jpg` },
            caption: `⬇️ *Starting download...*\n💬 Keep chatting — bot stays responsive!`,
          }, { quoted: msg });
        } catch (_) {
          statusMsg = await sock.sendMessage(chatId, {
            text: '⬇️ *Starting download...*\n💬 Keep chatting!',
          }, { quoted: msg });
        }

        setImmediate(async () => {
          try {
            // oEmbed remains available even when yt-dlp is challenged. The
            // title lets the Dailymotion fallback search for an equivalent
            // public copy instead of silently skipping that tier.
            const directTitle = await youtubeOembedTitle(text.trim());
            let directSec = 0;
            try { directSec = (await require('yt-search')({ videoId: ytId }))?.seconds || 0; } catch (_) {}
            await downloadWithFallback(sock, chatId, text.trim(), directTitle, statusMsg?.key, msg, { seconds: directSec });
          } catch (err) {
            console.error('[VIDEO] dl error:', err.message);
            await editStatus(sock, chatId, statusMsg?.key,
              `❌ *Download failed*\n${err.message}`
            );
            await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }).catch(() => {});
          }
        });
      }

    } catch (err) {
      console.error('[VIDEO] Unexpected:', err.message);
      await sock.sendMessage(chatId, {
        text: `❌ Unexpected error: ${err.message}`,
      }, { quoted: msg });
    }
  },
};
