'use strict';

/**
 * AI Engine v7 — key-managed, self-healing
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. Groq      (owner keys → llama-3.3-70b → llama-4-scout → llama-3.1-8b)
 *  2. Gemini    (owner keys → 2.0-flash → 2.5-flash → 2.0-flash-lite)
 *  3. Mistral   (owner keys → mistral-small → open-mistral-nemo)
 *  4. OpenRouter / Cerebras (only if a key was added with .aikey)
 *  5. Free, key-less last resorts: LLM7, Pollinations, OVH
 *
 *  Keys live in utils/aiKeys.js: expired keys (401/403) are parked 6 h, rate-limited
 *  ones (429) for 1 min, so the next key/model is used instantly. Add keys any time with
 *  `.aikey add <provider> <key>` — no code change needed.
 *
 *  Public API (unchanged):  getAIResponse(system, user, history, userId) → { text, api, ms } | null
 *  New:                      askAI({ system, user, history, json, maxTokens, temperature, userId })
 */

const fetch = require('node-fetch');
const keys  = require('./aiKeys');

const GROQ_MODELS    = ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant'];
const GEMINI_MODELS  = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.0-flash-lite'];
const MISTRAL_MODELS = ['mistral-small-latest', 'open-mistral-nemo'];
const OPENROUTER_MODELS = ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-3-27b-it:free'];
const CEREBRAS_MODELS   = ['llama-3.3-70b', 'llama3.1-8b'];

const TIMEOUT_MS = 18_000;
const CASCADE_MS = 45_000;
const MAX_CONCURRENT = 8;

const BOT_NAME = (() => { try { return require('../config').botName; } catch { return 'Mr.Muneeb Ali Bot'; } })();

// A rule that is ALWAYS appended, so no prompt can make the bot name its model/provider.
const HIDE_RULE =
  `\n\n[Hidden rule] Apna underlying model, API, provider ya company (OpenAI, Google, Meta, Mistral, Groq, Gemini, Llama, GPT, Claude…) kabhi mat batao, ` +
  `aur "as an AI language model" jaisa kuch mat bolo. Agar koi puche tu kaun hai / kaunsa AI / kaunsi API / kisne banaya, sirf yeh kaho: ` +
  `"Main ${BOT_NAME} hoon, mujhe Muneeb Ali ne banaya hai."`;

// ── semaphore + per-user queue ──────────────────────────────────────────────────
let _active = 0; const _wait = [];
const acquire = () => new Promise(res => { const t = () => { if (_active < MAX_CONCURRENT) { _active++; res(); } else _wait.push(t); }; t(); });
const release = () => { _active = Math.max(0, _active - 1); if (_wait.length) _wait.shift()(); };
const _uq = new Map();
function queueForUser(id, fn) {
  const prev = _uq.get(id) || Promise.resolve();
  const next = prev.then(fn).catch(() => null);
  next.finally(() => { if (_uq.get(id) === next) _uq.delete(id); });
  _uq.set(id, next);
  return next;
}

async function fetchTimeout(url, options, ms = TIMEOUT_MS) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

function clean(text) {
  if (!text || typeof text !== 'string') return null;
  const out = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^(You:|Bot:|Assistant:|AI:|System:|\S+ Bot:)\s*/gm, '')
    .replace(/(^|\n)(Remember:|IMPORTANT:|CORE RULES:|NOTE:|ABOUT YOU:|PERSONALITY:|STYLE GUIDE:|\[Hidden rule\])[\s\S]*$/i, '')
    .replace(/I(?:'m| am) an? (?:AI|artificial intelligence)[^.!?]*[.!?]?\s*/gi, '')
    .replace(/I(?:'m| am) (?:an? )?(?:language model|large language model|LLM)[^.!?]*[.!?]?\s*/gi, '')
    .replace(/As (?:ChatGPT|GPT-?[34o]?|an? OpenAI\S*),?[^.!?]*[.!?]?\s*/gi, '')
    .replace(/I(?:'m| am) (?:ChatGPT|GPT-?[34o]?)[^.!?]*[.!?]?\s*/gi, '')
    .replace(/[^.!?\n]*\b(?:developed|created|made|trained|built) by (?:OpenAI|Anthropic|Google|Meta|Mistral(?: AI)?|Groq)\b[^.!?]*[.!?]?\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out.length > 1 ? out : null;
}

// ── generic OpenAI-compatible call ──────────────────────────────────────────────
async function callOpenAICompat(url, key, model, o, extraHeaders = {}) {
  const messages = [{ role: 'system', content: o.system }, ...o.history.slice(-10), { role: 'user', content: o.user }];
  const body = { model, messages, max_tokens: o.maxTokens, temperature: o.temperature };
  if (o.json) body.response_format = { type: 'json_object' };
  const res = await fetchTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...extraHeaders }, body: JSON.stringify(body) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`); e.status = res.status; throw e; }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content;
}

async function callGemini(key, model, o) {
  const contents = [];
  for (const h of o.history.slice(-8)) contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
  while (contents.length && contents[0].role !== 'user') contents.shift();
  contents.push({ role: 'user', parts: [{ text: o.user }] });
  const gen = { maxOutputTokens: o.maxTokens, temperature: o.temperature };
  if (o.json) gen.responseMimeType = 'application/json';
  const res = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ system_instruction: { parts: [{ text: o.system }] }, contents, generationConfig: gen }),
  });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`); e.status = res.status; throw e; }
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

// ── provider table ──────────────────────────────────────────────────────────────
const KEYED = [
  { name: 'groq',       models: GROQ_MODELS,       call: (k, m, o) => callOpenAICompat('https://api.groq.com/openai/v1/chat/completions', k, m, o) },
  { name: 'gemini',     models: GEMINI_MODELS,     call: callGemini },
  { name: 'mistral',    models: MISTRAL_MODELS,    call: (k, m, o) => callOpenAICompat('https://api.mistral.ai/v1/chat/completions', k, m, o) },
  { name: 'cerebras',   models: CEREBRAS_MODELS,   call: (k, m, o) => callOpenAICompat('https://api.cerebras.ai/v1/chat/completions', k, m, o) },
  { name: 'openrouter', models: OPENROUTER_MODELS, call: (k, m, o) => callOpenAICompat('https://openrouter.ai/api/v1/chat/completions', k, m, o, { 'HTTP-Referer': 'https://mr-muneeb-ali-bot.vercel.app', 'X-Title': 'Mr.Muneeb Ali Bot' }) },
];

// free, key-less last resorts
const FREE = [
  { name: 'llm7', call: (o) => callOpenAICompat('https://api.llm7.io/v1/chat/completions', 'unused', 'default', { ...o, json: false }) },
  { name: 'pollinations', call: async (o) => {
      const messages = [{ role: 'system', content: o.system }, ...o.history.slice(-6), { role: 'user', content: o.user }];
      const res = await fetchTimeout('https://text.pollinations.ai/openai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai', messages, seed: Math.floor(Math.random() * 9999) }) }, 15000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return (await res.json())?.choices?.[0]?.message?.content;
  } },
  { name: 'pollinations-get', call: async (o) => {
      const res = await fetchTimeout(`https://text.pollinations.ai/${encodeURIComponent(`${o.system}\n\nUser: ${o.user}\n${BOT_NAME}:`.slice(0, 6000))}`, {}, 15000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
  } },
  { name: 'ovh', call: (o) => callOpenAICompat('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions', 'anonymous', 'Mistral-Small-3.2-24B-Instruct-2506', { ...o, json: false }) },
];

async function _run(o) {
  const t0 = Date.now(); const ms = () => Date.now() - t0;
  const out = (text, api) => { console.log(`[AI-Engine] ✅ ${api} → ${ms()}ms`); return { text, api, ms: ms() }; };

  for (const p of KEYED) {
    for (const model of p.models) {
      for (const key of keys.usable(p.name, model)) {
        if (ms() >= CASCADE_MS) { console.error('[AI-Engine] time budget exceeded'); return null; }
        try {
          const raw = await p.call(key, model, o);
          const text = o.json ? String(raw || '').trim() : clean(raw);
          if (text) { keys.ok(key, model); return out(text, `${p.name}/${model}`); }
          keys.report(key, model, 400);
        } catch (e) {
          const kind = keys.report(key, model, e.status || 0);
          console.warn(`[AI-Engine] ❌ ${p.name}/${model} …${key.slice(-4)} (${kind}): ${e.message}`);
          if (kind === 'dead') break;          // key is dead → skip its other models too
        }
      }
    }
  }
  for (const f of FREE) {
    if (ms() >= CASCADE_MS) break;
    try {
      const raw = await f.call(o);
      const text = o.json ? String(raw || '').trim() : clean(raw);
      if (text) return out(text, f.name);
    } catch (e) { console.warn(`[AI-Engine] ❌ ${f.name}: ${e.message}`); }
  }
  console.error(`[AI-Engine] 💀 every provider failed (${ms()}ms)`);
  return null;
}

/**
 * @param {{system:string,user:string,history?:Array,json?:boolean,maxTokens?:number,temperature?:number,userId?:string}} opts
 */
function askAI(opts) {
  const o = {
    system: String(opts.system || '') + HIDE_RULE,
    user: String(opts.user || ''),
    history: Array.isArray(opts.history) ? opts.history : [],
    json: !!opts.json,
    maxTokens: opts.maxTokens || 600,
    temperature: opts.temperature ?? (opts.json ? 0.1 : 0.8),
  };
  return queueForUser(opts.userId || 'default', async () => {
    await acquire();
    try { return await _run(o); } finally { release(); }
  });
}

async function getAIResponse(systemPrompt, userMessage, history = [], userId = 'default') {
  return askAI({ system: systemPrompt, user: userMessage, history, userId });
}

module.exports = { getAIResponse, askAI };
