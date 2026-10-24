/**
 * Song Downloader — v3 (5-tier fallback system)
 *
 * FALLBACK CHAIN:
 *   Tier 1 — YouTube yt-dlp (android_vr client — default)
 *   Tier 2 — YouTube yt-dlp (android client)
 *   Tier 3 — YouTube yt-dlp (tv_embedded client — bypasses bot check on many videos)
 *   Tier 4 — SoundCloud search via yt-dlp  (scsearch1:<title>)
 *   Tier 5 — SoundCloud broader search    (scsearch1:<simplified title>)
 *
 * WHY 5 TIERS:
 *   YouTube blocks audio-only streams (bestaudio) for popular/viral songs
 *   with "Sign in to confirm you're not a bot" even with all clients.
 *   SoundCloud has millions of tracks and yt-dlp SoundCloud extractor
 *   is NOT blocked from Replit — confirmed working.
 *
 * SIZE RULES:
 *   ≤ 200 MB → send as audio message
 *   > 200 MB → reject (WhatsApp audio limit)
 */

'use strict';

const yts    = require('yt-search');
const fs     = require('fs');
const https  = require('https');
const config = require('../../config');
const ytdlp  = require('../../utils/ytdlp');
const { deleteTempFile } = require('../../utils/mediaDownloader');
const freeDl = require('../../utils/freeDl');

const AUDIO_MAX_MB = 200;

// ── Wrong-song protection ────────────────────────────────────────────────────
// Title-search fallbacks (SoundCloud / JioSaavn) can return a different song, cover or remix.
// We only accept their result when its length matches the real YouTube video's length.
function probeDurationSec(file) {
  return new Promise(resolve => {
    try {
      require('child_process').execFile(ytdlp.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-i', file], { timeout: 20000 }, (_e, _o, stderr) => {
        const m = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0);
      });
    } catch (_) { resolve(0); }
  });
}
function durationOk(actual, expected) {
  if (!actual || !expected) return false;
  return Math.abs(actual - expected) <= Math.max(15, expected * 0.12);
}

// ── Edit status message ────────────────────────────────────────────────────────
async function editStatus(sock, chatId, key, text) {
  if (!key) return;
  try { await sock.sendMessage(chatId, { text, edit: key }); } catch (_) {}
}

// ── Build SoundCloud search URL from a song title ────────────────────────────
function scSearch(title, simplified = false) {
  if (simplified) {
    // Strip featured artists, remix tags, year — keep core title + main artist
    const clean = title
      .replace(/\(.*?\)/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/feat\.?.*/i, '')
      .replace(/ft\.?.*/i, '')
      .trim()
      .split(' ').slice(0, 5).join(' ');
    return `scsearch1:${clean}`;
  }
  return `scsearch1:${title}`;
}

// YouTube's oEmbed endpoint still returns the title when yt-dlp is blocked by
// an IP challenge. That title enables the SoundCloud fallback for direct URLs.
function youtubeOembedTitle(url) {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return resolve(''); }
    const req = https.get({
      hostname: 'www.youtube.com',
      path: `/oembed?url=${encodeURIComponent(parsed.toString())}&format=json`,
      timeout: 12_000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body).title || ''); } catch (_) { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}


// ── WhatsApp can only play mp3 / m4a (AAC) / ogg-opus ───────────────────────────────────────────
// Piped/Invidious and SoundCloud routes often give .webm / .opus. Sending that as "audio/webm" makes WhatsApp hang on
// "Uploading audio..." (log said "Sent" but nothing arrives). So anything else is converted to AAC .m4a first.
const WA_AUDIO_OK = new Set(['mp3', 'm4a', 'aac']);
function ffmpegBin() {
  if (ytdlp.FFMPEG_PATH) return ytdlp.FFMPEG_PATH;
  try { return require('ffmpeg-static') || 'ffmpeg'; } catch (_) { return 'ffmpeg'; }
}
async function toWhatsAppAudio(inFile) {
  const ext = inFile.split('.').pop().toLowerCase();
  if (WA_AUDIO_OK.has(ext)) return { file: inFile, converted: false };
  const out = inFile.replace(/\.\w+$/, '') + '_wa.m4a';
  await new Promise((resolve, reject) => {
    require('child_process').execFile(ffmpegBin(),
      ['-y', '-i', inFile, '-vn', '-map_metadata', '-1', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out],
      { timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
      (e, _o, se) => (e ? reject(new Error('audio convert failed: ' + String(se || e.message).slice(-150))) : resolve()));
  });
  if (!fs.existsSync(out) || fs.statSync(out).size < 1000) throw new Error('audio convert produced empty file');
  console.log(`[SONG] converted ${ext} → m4a for WhatsApp (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
  return { file: out, converted: true };
}

// ── Download + send audio ─────────────────────────────────────────────────────
async function sendAudio(sock, chatId, outFile, title, quotedMsg) {
  const botName  = config.botName || 'Bot';
  const sizeMB   = fs.existsSync(outFile)
    ? +(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)
    : 0;

  if (sizeMB === 0) throw new Error('Download produced empty file');
  if (sizeMB > AUDIO_MAX_MB) throw new Error(`File too large (${sizeMB.toFixed(0)} MB)`);

  const conv     = await toWhatsAppAudio(outFile);            // webm/opus → m4a (WhatsApp can't play webm)
  const sendFile = conv.file;
  try {
    const ext      = sendFile.split('.').pop().toLowerCase();
    const mimeMap  = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac' };
    const mimetype = mimeMap[ext] || 'audio/mp4';
    const safeTitle = title.replace(/[^\w\s\-]/g, '').trim().slice(0, 60) || 'song';
    const fileName  = `${safeTitle}.${ext}`;

    await sock.sendMessage(chatId, {
      audio   : { url: sendFile }, // streamed from disk, not loaded into RAM
      mimetype,
      fileName,
      ptt     : false,
    }, { quoted: quotedMsg });
  } finally {
    if (conv.converted) { try { fs.unlinkSync(conv.file); } catch (_) {} }
  }

  await sock.sendMessage(chatId, { react: { text: '✅', key: quotedMsg.key } }).catch(() => {});
  console.log(`[SONG] ✅ Sent: ${title} (${sizeMB} MB, ${conv.converted ? 'm4a (converted)' : outFile.split('.').pop().toLowerCase()})`);
}

// ── Tier definitions ──────────────────────────────────────────────────────────
function getTiers(ytUrl, searchTitle, expectedSec = 0) {
  const AF = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best';
  const yt = (name, extractorArgs, noCookies = false, useWarp = false) => ({ name, url: ytUrl, format: AF, extractorArgs, noCookies, useWarp });
  const vid = freeDl.videoIdOf(ytUrl);
  return [
    // FREE route #1: YouTube through the Cloudflare WARP tunnel (different IP, not blocked)
    yt('YouTube via WARP', null, true, true),
    yt('YouTube via WARP (cookies)', null, false, true),
    yt('YouTube via WARP (ios)', 'youtube:player_client=ios', true, true),
    yt('YouTube (default client)', null),
    // ── FREE route: public Piped / Invidious servers fetch it with THEIR IP ──
    {
      name: 'Piped/Invidious (free proxy)',
      fn: async (tmpOut) => {
        const r = await freeDl.resolveYoutube(vid, { audio: true });
        const out = freeDl.streamToFile(r.url, tmpOut.replace(/\.\w+$/, '.' + r.ext), { maxMB: AUDIO_MAX_MB });
        return { ...(await out), title: r.title };
      },
    },
    ...(process.env.COBALT_API_URL ? [{
      name: 'Cobalt',
      fn: async (tmpOut) => {
        const r = await freeDl.resolveCobalt(ytUrl, { audio: true });
        const out = await freeDl.streamToFile(r.url, tmpOut.replace(/\.\w+$/, '.mp3'), { maxMB: AUDIO_MAX_MB });
        return { ...out, title: r.title };
      },
    }] : []),
    ...(process.env.RAPIDAPI_KEY ? [{
      name: 'RapidAPI',
      fn: async (tmpOut) => {
        const r = await freeDl.resolveRapidAudio(vid);
        const out = await freeDl.streamToFile(r.url, tmpOut.replace(/\.\w+$/, '.mp3'), { maxMB: AUDIO_MAX_MB });
        return { ...out, title: r.title };
      },
    }] : []),
    // ── FREE route: JioSaavn (320 kbps, best for Hindi/Urdu/Punjabi songs) ───
    ...(searchTitle && expectedSec ? [{
      name: 'JioSaavn (320kbps)', verify: true,
      fn: async (tmpOut) => {
        const r = await freeDl.resolveSaavn(searchTitle);
        const out = await freeDl.streamToFile(r.url, tmpOut.replace(/\.\w+$/, '.m4a'), { maxMB: AUDIO_MAX_MB });
        return { ...out, title: r.title };
      },
    }] : []),
    // ── SoundCloud (only when we have a title to search) ─────────────────────
    ...(searchTitle && expectedSec ? [
      { name: 'SoundCloud (exact search)',      verify: true, url: scSearch(searchTitle),       format: 'bestaudio/best', extractorArgs: null },
      { name: 'SoundCloud (simplified search)', verify: true, url: scSearch(searchTitle, true), format: 'bestaudio/best', extractorArgs: null },
    ] : []),
    // ── More YouTube clients as a last attempt ───────────────────────────────
    yt('YouTube (ios)', 'youtube:player_client=ios'),
    yt('YouTube (mweb, no cookies)', 'youtube:player_client=mweb', true),
    yt('YouTube (android)', 'youtube:player_client=android'),
    yt('YouTube (tv_embedded)', 'youtube:player_client=tv_embedded'),
    yt('YouTube (web_safari)', 'youtube:player_client=web_safari', true),
  ];
}

// ── Core cascading downloader ─────────────────────────────────────────────────
async function downloadAudioWithFallback(sock, chatId, ytUrl, searchTitle, statusKey, quotedMsg, expectedSec = 0) {
  const tiers  = getTiers(ytUrl, searchTitle, expectedSec);
  let   lastErr = null;

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const label = `Tier ${i + 1}/${tiers.length}: ${tier.name}`;
    const tmpOut = ytdlp.tmpPath('song', '.m4a');

    console.log(`[SONG] Trying ${label}`);

    try {
      const result = tier.fn
        ? await tier.fn(tmpOut)
        : await ytdlp.download(tier.url, tmpOut, {
            format       : tier.format,
            extractorArgs: tier.extractorArgs,
            noCookies    : !!tier.noCookies,
            useWarp      : !!tier.useWarp,
            maxFilesizeMB: AUDIO_MAX_MB,
            audioOnly    : true,
            timeout      : 180_000,
          });

      const outFile    = result.outputPath;
      const finalTitle = result.title || searchTitle || 'Audio';
      console.log(`[SONG] ${label} → ${result.sizeMB} MB`);

      // title-search sources must match the real song's length, otherwise it is the wrong track
      if (tier.verify) {
        const got = await probeDurationSec(outFile);
        if (!durationOk(got, expectedSec)) {
          deleteTempFile(outFile);
          throw new Error(`wrong track (got ${Math.round(got)}s, expected ${expectedSec}s)`);
        }
      }

      try {
        await editStatus(sock, chatId, statusKey, '📤 *Uploading audio...*');
        await sendAudio(sock, chatId, outFile, finalTitle, quotedMsg);
        return; // ✅ success
      } finally {
        deleteTempFile(outFile);
        // clean up temp base variations
        const base = tmpOut.replace(/\.\w+$/, '');
        for (const ext of ['mp3', 'm4a', 'webm', 'opus', 'ogg', 'aac', 'part', 'ytdl']) {
          deleteTempFile(`${base}.${ext}`);
        }
      }

    } catch (err) {
      lastErr = err;
      console.warn(`[SONG] ${label} failed: ${err.message}`);

      // Show intermediate status (not on last tier)
      if (i < tiers.length - 1) {
        const shown = Math.min(3, Math.floor((i + 1) * 3 / tiers.length) + 1); // users only see Method 1/2/3
        await editStatus(sock, chatId, statusKey, `🔄 *Method ${shown} try ho raha hai...*`);
        await new Promise(r => setTimeout(r, 800));
      }

      // Clean up any partial temp files
      const base = tmpOut.replace(/\.\w+$/, '');
      for (const ext of ['mp3', 'm4a', 'webm', 'opus', 'ogg', 'aac', 'part', 'ytdl']) {
        deleteTempFile(`${base}.${ext}`);
      }
    }
  }

  // All tiers exhausted
  throw new Error('Ye gaana is waqt download nahi ho saka. Thori der baad dobara try karein ya title/artist ke saath likhein.');
}

// ── Command ───────────────────────────────────────────────────────────────────
module.exports = {
  _toWhatsAppAudio: toWhatsAppAudio,
  name    : 'song',
  aliases : ['play', 'music', 'yta', 'mp3'],
  category: 'media',
  description: 'Download songs / audio',
  usage   : '.song <song name or YouTube link>',

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    try {
      const text = args.join(' ').trim();
      if (!text) {
        return await sock.sendMessage(chatId, {
          text: [
            '🎵 *Song Downloader*',
            '',
            'Usage: *.song <song name or YouTube URL>*',
            '',
            'Examples:',
            '• .song Pasoori Ali Sethi',
            '• .song Tere Bin Waris Baig',
            '• .song Shape of You Ed Sheeran',
            '• .song https://youtu.be/abc123',
            '',
            '_Bas gaane ka naam likhein — baaki bot khud kar leta hai_',
          ].join('\n'),
        }, { quoted: msg });
      }

      await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } });

      const isUrl = text.includes('youtube.com') || text.includes('youtu.be');

      if (!isUrl) {
        // ── Search flow ───────────────────────────────────────────────────────
        const statusMsg = await sock.sendMessage(chatId, {
          text: `🔍 *Searching:* _${text}_`,
        }, { quoted: msg });

        setImmediate(async () => {
          try {
            const search = await yts(text);
            const video  = search?.videos?.[0];
            if (!video) {
              return await editStatus(sock, chatId, statusMsg.key,
                `❌ *No results found for:* _${text}_\n\nTry a more specific search.`
              );
            }

            try {
              await sock.sendMessage(chatId, {
                image  : { url: video.thumbnail },
                caption: `🎵 *${video.title}*\n⬇️ Downloading audio...`,
              }, { quoted: msg });
            } catch (_) {}

            await editStatus(sock, chatId, statusMsg.key,
              `🎵 *Downloading:* _${video.title}_`
            );

            await downloadAudioWithFallback(
              sock, chatId, video.url, video.title, statusMsg.key, msg, video.seconds || 0
            );

          } catch (err) {
            console.error('[SONG] search+dl error:', err.message);
            await editStatus(sock, chatId, statusMsg.key,
              `❌ *Download failed*\n\n${err.message}`
            );
            await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }).catch(() => {});
          }
        });

      } else {
        // ── Direct URL flow ───────────────────────────────────────────────────
        const statusMsg = await sock.sendMessage(chatId, {
          text: '🎵 *Downloading audio...*',
        }, { quoted: msg });

        setImmediate(async () => {
          try {
            const directTitle = await youtubeOembedTitle(text.trim());
            let directSec = 0;
            try { const vid = freeDl.videoIdOf(text.trim()); if (vid) directSec = (await yts({ videoId: vid }))?.seconds || 0; } catch (_) {}
            await downloadAudioWithFallback(
              sock, chatId, text.trim(), directTitle, statusMsg.key, msg, directSec
            );
          } catch (err) {
            console.error('[SONG] url dl error:', err.message);
            await editStatus(sock, chatId, statusMsg.key,
              `❌ *Download failed*\n\n${err.message}`
            );
            await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }).catch(() => {});
          }
        });
      }

    } catch (err) {
      console.error('[SONG] Unexpected error:', err.message);
      await sock.sendMessage(chatId, { text: `❌ Unexpected error: ${err.message}` }, { quoted: msg });
    }
  },
};
