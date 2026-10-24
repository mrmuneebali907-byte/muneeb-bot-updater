'use strict';
/**
 * utils/ffmpegBin.js — ffmpeg chalane ka ek jagah, "crash ho to doosra binary" ke saath.
 *
 * Kuch servers par ek ffmpeg binary chalte hi signal se mar jata hai (exit code null).
 * Isliye: ffmpeg-static → yt-dlp wala ffmpeg → system ffmpeg, jo pehla theek chale wahi (yaad rakh leta hai).
 * Sirf "signal se mara / start hi nahi hua" par agla binary try hota hai. Normal error (galat file wagairah) par nahi.
 */
const { spawn } = require('child_process');

let _override = null, _good = null;

function candidates() {
  if (_override) return _override;
  const out = [];
  const add = (p) => { if (p && typeof p === 'string' && !out.includes(p)) out.push(p); };
  add(_good);
  try { add(require('ffmpeg-static')); } catch (_) {}
  try { add(require('./ytdlp').FFMPEG_PATH); } catch (_) {}
  add('ffmpeg');
  return out;
}

/** → { code, signal, err, bin }.  code === -9 = timeout, -1 = koi binary start nahi hua */
function runAny(args, { timeoutMs = 600000, capture = true } = {}) {
  const list = candidates();
  return new Promise((resolve) => {
    let i = 0, lastErr = '';
    const next = () => {
      if (i >= list.length) return resolve({ code: -1, signal: null, err: lastErr || 'no working ffmpeg binary', bin: null });
      const bin = list[i++];
      let err = '', done = false;
      let p;
      try { p = spawn(bin, ['-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch (e) { lastErr = `${bin}: ${e.message}`; return next(); }
      const fin = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} fin({ code: -9, signal: 'SIGKILL', err: err + '\ntimeout', bin }); }, timeoutMs);
      p.stderr.on('data', (d) => { if (capture) { err += d.toString(); if (err.length > 60000) err = err.slice(-30000); } });
      p.on('error', (e) => { if (done) return; done = true; clearTimeout(t); lastErr = `${bin}: ${e.message}`; console.log(`[ffmpeg] ${bin} start nahi hua: ${e.message}`); next(); });
      p.on('close', (code, signal) => {
        if (done) return;
        if (code === null) {                                   // signal se mara → doosra binary
          done = true; clearTimeout(t); lastErr = `${bin} killed by ${signal}`;
          console.log(`[ffmpeg] ${bin} crashed (${signal}) → agla binary try`);
          return next();
        }
        _good = bin;
        fin({ code, signal: null, err, bin });
      });
    };
    next();
  });
}

module.exports = { runAny, candidates, _setCandidates: (l) => { _override = l; _good = null; } };
