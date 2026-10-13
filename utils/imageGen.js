'use strict';
/**
 * utils/imageGen.js — text → image with many free fallbacks. Never relies on a single API.
 *   generate(prompt, {onProgress}) → { buffer, api }
 * Order (fastest/most reliable first): Pollinations (flux / turbo / default / alt host) →
 * Gemini image models (owner key) → siputzx APIs (magicstudio / flux / stability) → Stable Horde (anonymous, slower).
 * Every result is verified to be a REAL image (PNG/JPEG/WEBP magic bytes, ≥ 4 KB) before it is accepted.
 */
const keys = require('./aiKeys');

const MIN_BYTES = 4096;
function isImage(b) {
  if (!b || b.length < MIN_BYTES) return false;
  return (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xFF && b[1] === 0xD8) || (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP');
}
async function ftimeout(url, opt, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opt, signal: c.signal }); } finally { clearTimeout(t); }
}
async function getImage(url, ms = 70000, headers = {}) {
  const r = await ftimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36', Accept: 'image/*,*/*', ...headers }, redirect: 'follow' }, ms);
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  const buf = Buffer.from(await r.arrayBuffer());
  if (!isImage(buf)) throw new Error('not an image (' + buf.length + ' bytes)');
  return buf;
}
const seed = () => Math.floor(Math.random() * 1e9);
const enc = encodeURIComponent;

async function geminiImage(prompt) {
  const models = ['gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image-generation', 'gemini-2.0-flash-exp-image-generation'];
  let last;
  for (const m of models) for (const k of keys.usable('gemini', 'img:' + m)) {
    try {
      const r = await ftimeout(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
        body: JSON.stringify({ contents: [{ parts: [{ text: `Generate an image: ${prompt}` }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
      }, 60000);
      if (!r.ok) { const e = new Error(`gemini ${m} HTTP ${r.status}`); e.status = r.status; throw e; }
      const d = await r.json();
      for (const p of d?.candidates?.[0]?.content?.parts || []) {
        const b64 = p.inlineData?.data || p.inline_data?.data;
        if (b64) { const buf = Buffer.from(b64, 'base64'); if (isImage(buf)) { keys.ok(k, 'img:' + m); return buf; } }
      }
      throw new Error('no image in response');
    } catch (e) { last = e; keys.report(k, 'img:' + m, e.status || 0); }
  }
  throw last || new Error('no gemini key');
}

async function hordeImage(prompt) {
  const H = { 'Content-Type': 'application/json', apikey: '0000000000', 'Client-Agent': 'muneeb-bot:1:anon' };
  const sub = await ftimeout('https://aihorde.net/api/v2/generate/async', { method: 'POST', headers: H,
    body: JSON.stringify({ prompt, params: { width: 512, height: 512, steps: 20, n: 1, sampler_name: 'k_euler_a' }, nsfw: false, censor_nsfw: true, r2: true, shared: true }) }, 20000);
  if (!sub.ok) throw new Error('horde submit HTTP ' + sub.status);
  const { id } = await sub.json(); if (!id) throw new Error('horde no id');
  const t0 = Date.now();
  while (Date.now() - t0 < 100000) {
    await new Promise(r => setTimeout(r, 4000));
    const st = await (await ftimeout(`https://aihorde.net/api/v2/generate/check/${id}`, { headers: H }, 15000)).json().catch(() => ({}));
    if (st.faulted) throw new Error('horde faulted');
    if (st.done) {
      const res = await (await ftimeout(`https://aihorde.net/api/v2/generate/status/${id}`, { headers: H }, 20000)).json();
      const g = res?.generations?.[0]; if (!g?.img) throw new Error('horde empty');
      return g.img.startsWith('http') ? await getImage(g.img, 40000) : Buffer.from(g.img, 'base64');
    }
  }
  throw new Error('horde timeout');
}

function sources(prompt, size = 1024) {
  const p = enc(prompt);
  const poll = (model) => () => getImage(`https://image.pollinations.ai/prompt/${p}?model=${model}&width=${size}&height=${size}&seed=${seed()}&nologo=true&private=true&enhance=false`);
  return [
    { api: 'pollinations/flux',  run: poll('flux') },
    { api: 'pollinations/turbo', run: poll('turbo') },
    { api: 'gemini-image',       run: () => geminiImage(prompt) },
    { api: 'pollinations/default', run: () => getImage(`https://image.pollinations.ai/prompt/${p}?width=${size}&height=${size}&seed=${seed()}&nologo=true`) },
    { api: 'pollinations/alt',   run: () => getImage(`https://pollinations.ai/p/${p}?width=${size}&height=${size}&seed=${seed()}&model=flux`) },
    { api: 'siputzx/flux',       run: () => getImage(`https://api.siputzx.my.id/api/ai/flux?prompt=${p}`) },
    { api: 'siputzx/magicstudio', run: () => getImage(`https://api.siputzx.my.id/api/ai/magicstudio?prompt=${p}`) },
    { api: 'siputzx/stability',  run: () => getImage(`https://api.siputzx.my.id/api/ai/stabilityai?prompt=${p}`) },
    { api: 'airforce',           run: () => getImage(`https://api.airforce/imagine2?prompt=${p}&size=1:1&seed=${seed()}`) },
    { api: 'stable-horde',       run: () => hordeImage(prompt) },
  ];
}

async function generate(prompt, opts = {}) {
  prompt = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!prompt) throw new Error('empty prompt');
  let last; const errs = [];
  for (const s of sources(prompt)) {
    try {
      if (opts.onProgress) try { opts.onProgress(s.api); } catch (_) {}
      const buffer = await s.run();
      if (isImage(buffer)) { console.log('[ImageGen] ✅', s.api, buffer.length + 'B'); return { buffer, api: s.api }; }
      throw new Error('invalid image');
    } catch (e) { last = e; errs.push(`${s.api}: ${e.message}`); console.log('[ImageGen] ❌', s.api, e.message); }
  }
  const e = new Error('all image APIs failed — ' + errs.slice(-3).join(' | ')); e.cause = last; throw e;
}

module.exports = { generate, isImage };
