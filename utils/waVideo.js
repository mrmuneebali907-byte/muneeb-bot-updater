'use strict';
/**
 * utils/waVideo.js — make ANY downloaded video playable on WhatsApp.
 *
 * WhatsApp only plays:  MP4 container · H.264 (yuv420p, even width/height) · AAC audio · moov atom at the front.
 * yt-dlp / proxies often deliver VP9/AV1/Opus (webm/mkv content inside a ".mp4" name) → "This video is not
 * available because something is wrong with the video file" / "unusual format… cannot be opened".
 *
 *   prepare(file, {onStatus}) → { path, transcoded, sizeMB }   (the input file is deleted when a new file is made)
 *
 *   • already H.264 + AAC + yuv420p → fast REMUX only (-c copy +faststart): seconds, no quality loss
 *   • anything else                 → transcode to H.264/AAC (veryfast; long movies → ultrafast + 480p so a small panel can finish)
 *   • if everything fails           → returns the original file with ok:false (caller sends it as a document)
 */
const fs = require('fs');
const { spawn } = require('child_process');
const ytdlp = require('./ytdlp');

const FFMPEG = () => ytdlp.FFMPEG_PATH || 'ffmpeg';

function run(args, { timeoutMs = 600000, capture = true } = {}) {
  // shared runner: agar ek ffmpeg binary crash kare to doosra try hota hai (utils/ffmpegBin.js)
  return require('./ffmpegBin').runAny(args, { timeoutMs, capture }).then(r => ({ code: r.code, err: r.err }));
}

/** codec info from `ffmpeg -i` (works without ffprobe) */
async function probe(file) {
  const { err } = await run(['-hide_banner', '-i', file], { timeoutMs: 30000 });
  const v = err.match(/Stream #\d+:\d+[^\n]*?: Video: (\w+)[^\n]*?(?:,\s*(yuv\w+|gbrp\w*|nv\d+|p\d+\w*)[^,\n]*)?,\s*(\d{2,5})x(\d{2,5})/);
  const a = err.match(/Stream #\d+:\d+[^\n]*?: Audio: (\w+)/);
  const d = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return {
    vcodec: v?.[1] || null, pix: v?.[2] || null, w: v ? +v[3] : 0, h: v ? +v[4] : 0,
    acodec: a?.[1] || null,
    seconds: d ? (+d[1] * 3600 + +d[2] * 60 + +d[3]) : 0,
    brokenMoov: /moov atom not found|Invalid data found/i.test(err),
  };
}

const sizeMB = (f) => { try { return +(fs.statSync(f).size / 1048576).toFixed(1); } catch (_) { return 0; } };
const bytes = (f) => { try { return fs.statSync(f).size; } catch (_) { return 0; } };
const rm = (f) => { try { fs.unlinkSync(f); } catch (_) {} };

async function prepare(file, opts = {}) {
  const onStatus = opts.onStatus || (() => {});
  const out = file.replace(/\.\w+$/, '') + '_wa.mp4';
  const info = await probe(file);
  console.log('[waVideo] probe:', JSON.stringify(info));

  const h264ok = info.vcodec === 'h264' && (!info.pix || info.pix === 'yuv420p') && info.w % 2 === 0 && info.h % 2 === 0;
  const aacok  = !info.acodec || info.acodec === 'aac';

  // 1) already compatible → remux with faststart (fixes wrong container / moov at the end)
  if (h264ok && aacok) {
    const r = await run(['-y', '-hide_banner', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', out], { timeoutMs: 900000 });
    if (r.code === 0 && bytes(out) > 1000) { if (out !== file) rm(file); return { path: out, transcoded: false, ok: true, sizeMB: sizeMB(out) }; }
    rm(out);
  }

  // 2) transcode to H.264 + AAC
  try { onStatus('🛠️ *Video ko WhatsApp format me convert kiya ja raha hai...*'); } catch (_) {}
  const long = info.seconds > 1500;                       // > 25 min → light settings so a small panel can finish
  const vf = long ? "scale=trunc(min(854\\,iw)/2)*2:-2:flags=fast_bilinear,format=yuv420p" : "scale=trunc(min(1280\\,iw)/2)*2:-2,format=yuv420p";
  const args = [
    '-y', '-hide_banner', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', vf,
    '-c:v', 'libx264', '-preset', long ? 'ultrafast' : 'veryfast', '-crf', long ? '28' : '25',
    '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p', '-threads', '2',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', '-max_muxing_queue_size', '2048',
    out,
  ];
  const timeoutMs = Math.min(4 * 3600 * 1000, Math.max(300000, (info.seconds || 600) * (long ? 700 : 1500)));
  const r = await run(args, { timeoutMs });
  if (r.code === 0 && bytes(out) > 1000) {
    const chk = await probe(out);
    if (chk.vcodec === 'h264') { if (out !== file) rm(file); return { path: out, transcoded: true, ok: true, sizeMB: sizeMB(out) }; }
  }
  console.log('[waVideo] transcode failed:', (r.err || '').slice(-300));
  rm(out);
  return { path: file, transcoded: false, ok: false, sizeMB: sizeMB(file) };
}

module.exports = { prepare, probe };
