'use strict';
/**
 * utils/vision.js — "look at this image and answer my prompt" with many fallbacks.
 *   describe(jpegBuffer, prompt) → { text, api }
 * Order: Gemini (2.0-flash, 2.5-flash, 2.0-flash-lite) → Groq vision (llama-4-scout/maverick)
 *        → Mistral vision (pixtral / mistral-small) → key-less Pollinations vision.
 * Keys come from utils/aiKeys.js (dead/limited keys are skipped & rotated automatically).
 */
const keys = require('./aiKeys');

async function ftimeout(url, opt, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opt, signal: c.signal }); } finally { clearTimeout(t); }
}
const fail = (provider, status, body) => { const e = new Error(`${provider} HTTP ${status}: ${String(body || '').slice(0, 100)}`); e.status = status; return e; };

async function gemini(key, model, b64, prompt) {
  const r = await ftimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 1200 } }),
  }, 30000);
  if (!r.ok) throw fail('gemini', r.status, await r.text().catch(() => ''));
  const d = await r.json();
  return (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
}
async function openaiVision(url, key, model, b64, prompt, ms = 30000) {
  const r = await ftimeout(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, max_tokens: 1200, temperature: 0.4, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }] }),
  }, ms);
  if (!r.ok) throw fail(model, r.status, await r.text().catch(() => ''));
  const d = await r.json();
  return String(d?.choices?.[0]?.message?.content || '').trim();
}

async function describe(buffer, prompt) {
  const b64 = Buffer.from(buffer).toString('base64');
  const steps = [];
  for (const m of ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.0-flash-lite'])
    steps.push({ api: 'gemini/' + m, provider: 'gemini', model: m, run: (k) => gemini(k, m, b64, prompt) });
  for (const m of ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct'])
    steps.push({ api: 'groq/' + m, provider: 'groq', model: m, run: (k) => openaiVision('https://api.groq.com/openai/v1/chat/completions', k, m, b64, prompt) });
  for (const m of ['mistral-small-latest', 'pixtral-12b-2409'])
    steps.push({ api: 'mistral/' + m, provider: 'mistral', model: m, run: (k) => openaiVision('https://api.mistral.ai/v1/chat/completions', k, m, b64, prompt) });

  let last;
  for (const s of steps) {
    for (const k of keys.usable(s.provider, 'vision:' + s.model)) {
      try { const t = await s.run(k); if (t) { keys.ok(k, 'vision:' + s.model); console.log('[Vision] ✅', s.api); return { text: t, api: s.api }; } throw new Error('empty'); }
      catch (e) { last = e; keys.report(k, 'vision:' + s.model, e.status || 0); console.log('[Vision] ❌', s.api, e.message); }
    }
  }
  // key-less fallbacks
  for (const f of [
    { api: 'pollinations/openai', run: () => openaiVision('https://text.pollinations.ai/openai', null, 'openai', b64, prompt, 40000) },
    { api: 'pollinations/openai-large', run: () => openaiVision('https://text.pollinations.ai/openai', null, 'openai-large', b64, prompt, 40000) },
  ]) {
    try { const t = await f.run(); if (t) { console.log('[Vision] ✅', f.api); return { text: t, api: f.api }; } } catch (e) { last = e; console.log('[Vision] ❌', f.api, e.message); }
  }
  throw last || new Error('all vision APIs failed');
}

module.exports = { describe };
