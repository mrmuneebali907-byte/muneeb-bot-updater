'use strict';

/**
 * AI Engine v6 — 12-API System
 * ──────────────────────────────────────────
 * Priority Order:
 *   API  1 — Groq Key 1        (llama-3.3-70b)       ← fastest
 *   API  2 — Groq Key 2        (llama-3.3-70b)       ← groq backup
 *   API  3 — Cerebras          (llama-3.3-70b)       ← very fast
 *   API  4 — OpenRouter        (meta-llama/llama-3.3-70b-instruct:free)
 *   API  5 — Mistral           (mistral-small-latest)
 *   API  6 — Google Gemini Key 1 (gemini-1.5-flash)
 *   API  7 — Google Gemini Key 2 (gemini-1.5-flash)
 *   API  8 — LLM7.io           (no signup / anonymous)
 *   API  9 — pollinations POST (no signup)
 *   API 10 — pollinations GET  (no signup)
 *   API 11 — pollinations OAI  (no signup)
 *   API 12 — OVH AI Endpoints  (no signup, anonymous, 2 req/min — last resort)
 *
 * Architecture:
 *   - Per-user queue     → same user ke requests queue hotey hain
 *   - Global semaphore   → max 8 parallel calls, APIs overload nahi hoti
 *   - Retry x2 per API  → ek fail to dobara try
 *   - AbortController   → proper timeout (node-fetch .timeout unreliable)
 */

const fetch = require('node-fetch');

// ── API Keys ── (public repo: no keys here. The live keys are in data/aiKeys.json on each server — see utils/aiKeys.js)
const GROQ_KEY_1       = '';
const GROQ_KEY_2       = '';
const OPENROUTER_KEY   = '';
const GEMINI_KEY_1     = '';
const GEMINI_KEY_2     = '';
const CEREBRAS_KEY     = '';
const MISTRAL_KEY      = '';

// ── Models ────────────────────────────────────────────────────────────────────
const GROQ_MODEL       = 'llama-3.3-70b-versatile';
const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const GEMINI_MODEL     = 'gemini-1.5-flash';
const CEREBRAS_MODEL   = 'llama-3.3-70b';
const MISTRAL_MODEL    = 'mistral-small-latest';

// ── Timeouts ──────────────────────────────────────────────────────────────────
const GROQ_TIMEOUT     = 20_000;
const OR_TIMEOUT       = 20_000;
const GEMINI_TIMEOUT   = 20_000;
const POLL_TIMEOUT     = 15_000;
const CEREBRAS_TIMEOUT = 15_000;
const MISTRAL_TIMEOUT  = 20_000;
const LLM7_TIMEOUT     = 15_000;
const OVH_TIMEOUT      = 15_000;

// ── Concurrency ───────────────────────────────────────────────────────────────
const MAX_CONCURRENT   = 8;

// ── Overall cascade cap ─────────────────────────────────────────────────────
// Worst case (all 8 APIs, 2 retries each, ~20s timeout each) could otherwise
// take 5+ minutes before giving up — which just looks like "bot not
// replying" from the user's side. Cap the whole chain so it fails fast.
const TOTAL_CASCADE_TIMEOUT = 40_000;

const BOT_NAME = (() => {
  try { return require('../config').botName; } catch { return 'Mr.Muneeb Ali Bot'; }
})();

// ── Global Semaphore ──────────────────────────────────────────────────────────
let _activeCount = 0;
const _waitQueue = [];

function acquireSemaphore() {
  return new Promise(resolve => {
    const tryAcquire = () => {
      if (_activeCount < MAX_CONCURRENT) { _activeCount++; resolve(); }
      else _waitQueue.push(tryAcquire);
    };
    tryAcquire();
  });
}

function releaseSemaphore() {
  _activeCount = Math.max(0, _activeCount - 1);
  if (_waitQueue.length > 0) _waitQueue.shift()();
}

// ── Per-user Queue ────────────────────────────────────────────────────────────
const _userQueues = new Map();

function queueForUser(userId, fn) {
  const prev = _userQueues.get(userId) || Promise.resolve();
  const next = prev.then(fn).catch(() => null);
  next.finally(() => { if (_userQueues.get(userId) === next) _userQueues.delete(userId); });
  _userQueues.set(userId, next);
  return next;
}

// ── Fetch with proper AbortController timeout ─────────────────────────────────
async function fetchTimeout(url, options, ms) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────
async function withRetry(name, fn, retries = 2) {
  for (let i = 1; i <= retries; i++) {
    try {
      const result = await fn();
      if (result) return result;
      console.warn(`[AI-Engine] ⚠️  ${name} attempt ${i}/${retries}: empty`);
    } catch (e) {
      console.warn(`[AI-Engine] ❌ ${name} attempt ${i}/${retries}: ${e.message}`);
      if (i < retries) await new Promise(r => setTimeout(r, 800 * i));
    }
  }
  return null;
}

// ── Response cleaner ──────────────────────────────────────────────────────────
function clean(text) {
  if (!text || typeof text !== 'string') return null;
  const out = text
    .replace(/^(You:|Bot:|Assistant:|AI:|System:|\S+ Bot:)\s*/gm, '')
    .replace(/(^|\n)(Remember:|IMPORTANT:|CORE RULES:|NOTE:|ABOUT YOU:|PERSONALITY:|STYLE GUIDE:)[\s\S]*$/i, '')
    .replace(/I(?:'m| am) an? (?:AI|artificial intelligence)[^.!?]*[.!?]?\s*/gi, '')
    .replace(/I(?:'m| am) (?:an? )?(?:language model|large language model|LLM)[^.!?]*[.!?]?\s*/gi, '')
    .replace(/As (?:ChatGPT|GPT-?[34o]?|an? OpenAI\S*),?[^.!?]*[.!?]?\s*/gi, '')
    .replace(/I(?:'m| am) (?:ChatGPT|GPT-?[34o]?)[^.!?]*[.!?]?\s*/gi, '')
    .replace(/[^.!?\n]*\b(?:developed|created|made|trained|built) by (?:OpenAI|Anthropic|Google|Meta)\b[^.!?]*[.!?]?\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out.length > 2 ? out : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual API functions
// ─────────────────────────────────────────────────────────────────────────────

// ── Groq (shared logic, different keys) ──────────────────────────────────────
async function callGroq(apiKey, keyNum, systemPrompt, userMessage, history) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10),
    { role: 'user',   content: userMessage  },
  ];
  const res = await fetchTimeout(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 600, temperature: 0.8 }),
    },
    GROQ_TIMEOUT
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Groq-${keyNum} HTTP ${res.status}: ${err.slice(0, 100)}`);
  }
  const data = await res.json();
  return clean(data?.choices?.[0]?.message?.content);
}

// ── OpenRouter ────────────────────────────────────────────────────────────────
async function callOpenRouter(systemPrompt, userMessage, history) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10),
    { role: 'user',   content: userMessage  },
  ];
  const res = await fetchTimeout(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer' : 'https://github.com/MrMuneebAliBot',
        'X-Title'      : 'Mr.Muneeb Ali Bot',
      },
      body: JSON.stringify({ model: OPENROUTER_MODEL, messages, max_tokens: 600, temperature: 0.8 }),
    },
    OR_TIMEOUT
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status}: ${err.slice(0, 100)}`);
  }
  const data = await res.json();
  return clean(data?.choices?.[0]?.message?.content);
}

// ── Google Gemini (shared logic, different keys) ──────────────────────────────
async function callGemini(apiKey, keyNum, systemPrompt, userMessage, history) {
  // Build contents from history
  const contents = [];
  for (const h of history.slice(-8)) {
    contents.push({
      role : h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const res = await fetchTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig  : { maxOutputTokens: 600, temperature: 0.8 },
      }),
    },
    GEMINI_TIMEOUT
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gemini-${keyNum} HTTP ${res.status}: ${err.slice(0, 100)}`);
  }
  const data = await res.json();
  return clean(data?.candidates?.[0]?.content?.parts?.[0]?.text);
}

// ── Cerebras (OpenAI-compatible) ───────────────────────────────────────────────
async function callCerebras(systemPrompt, userMessage, history) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10),
    { role: 'user',   content: userMessage  },
  ];
  const res = await fetchTimeout(
    'https://api.cerebras.ai/v1/chat/completions',
    {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${CEREBRAS_KEY}`,
      },
      body: JSON.stringify({ model: CEREBRAS_MODEL, messages, max_tokens: 600, temperature: 0.8 }),
    },
    CEREBRAS_TIMEOUT
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Cerebras HTTP ${res.status}: ${err.slice(0, 100)}`);
  }
  const data = await res.json();
  return clean(data?.choices?.[0]?.message?.content);
}

// ── Mistral (OpenAI-compatible) ────────────────────────────────────────────────
async function callMistral(systemPrompt, userMessage, history) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10),
    { role: 'user',   content: userMessage  },
  ];
  const res = await fetchTimeout(
    'https://api.mistral.ai/v1/chat/completions',
    {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${MISTRAL_KEY}`,
      },
      body: JSON.stringify({ model: MISTRAL_MODEL, messages, max_tokens: 600, temperature: 0.8 }),
    },
    MISTRAL_TIMEOUT
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Mistral HTTP ${res.status}: ${err.slice(0, 100)}`);
  }
  const data = await res.json();
  return clean(data?.choices?.[0]?.message?.content);
}

// ── LLM7.io (anonymous, OpenAI-compatible, no signup needed) ─────────────────
async function callLlm7(systemPrompt, userMessage, history) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-8),
    { role: 'user',   content: userMessage  },
  ];
  const res = await fetchTimeout(
    'https://api.llm7.io/v1/chat/completions',
    {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': 'Bearer unused', // "unused" = anonymous tier, no signup needed
      },
      body: JSON.stringify({ model: 'default', messages, max_tokens: 600, temperature: 0.8 }),
    },
    LLM7_TIMEOUT
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`LLM7 HTTP ${res.status}: ${err.slice(0, 100)}`);
  }
  const data = await res.json();
  return clean(data?.choices?.[0]?.message?.content);
}

// ── OVH AI Endpoints (anonymous, EU-hosted, very low rate limit — last resort) ─
async function callOvh(systemPrompt, userMessage, history) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user',   content: userMessage  },
  ];
  const res = await fetchTimeout(
    'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
    {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': 'Bearer anonymous', // anonymous tier: 2 req/min per IP per model
      },
      body: JSON.stringify({ model: 'Mistral-Small-3.2-24B-Instruct-2506', messages, max_tokens: 600, temperature: 0.8 }),
    },
    OVH_TIMEOUT
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`OVH HTTP ${res.status}: ${err.slice(0, 100)}`);
  }
  const data = await res.json();
  return clean(data?.choices?.[0]?.message?.content);
}

// ── pollinations POST ─────────────────────────────────────────────────────────
async function callPollinationsPost(systemPrompt, userMessage, history) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user',   content: userMessage  },
  ];
  const res = await fetchTimeout(
    'https://text.pollinations.ai/',
    {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ messages, model: 'openai', seed: Math.floor(Math.random() * 9999) }),
    },
    POLL_TIMEOUT
  );
  if (!res.ok) throw new Error(`pollinations-post HTTP ${res.status}`);
  return clean(await res.text());
}

// ── pollinations GET ──────────────────────────────────────────────────────────
async function callPollinationsGet(systemPrompt, userMessage) {
  const prompt = `${systemPrompt}\n\nUser: ${userMessage}\n${BOT_NAME}:`;
  const res = await fetchTimeout(
    `https://text.pollinations.ai/${encodeURIComponent(prompt)}`,
    {},
    POLL_TIMEOUT
  );
  if (!res.ok) throw new Error(`pollinations-get HTTP ${res.status}`);
  return clean(await res.text());
}

// ── pollinations OAI-compat ───────────────────────────────────────────────────
async function callPollinationsOai(systemPrompt, userMessage, history) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user',   content: userMessage  },
  ];
  const res = await fetchTimeout(
    'https://text.pollinations.ai/openai',
    {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ model: 'openai', messages, seed: Math.floor(Math.random() * 9999) }),
    },
    POLL_TIMEOUT
  );
  if (!res.ok) throw new Error(`pollinations-oai HTTP ${res.status}`);
  const data = await res.json();
  return clean(data?.choices?.[0]?.message?.content);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core runner — tries all 8 APIs in order
// ─────────────────────────────────────────────────────────────────────────────
async function _runAIRequest(systemPrompt, userMessage, history) {
  const start = Date.now();
  const ms = () => Date.now() - start;

  const apis = [
    { name: 'groq-1',       fn: () => callGroq(GROQ_KEY_1, 1, systemPrompt, userMessage, history) },
    { name: 'groq-2',       fn: () => callGroq(GROQ_KEY_2, 2, systemPrompt, userMessage, history) },
    { name: 'cerebras',     fn: () => callCerebras(systemPrompt, userMessage, history) },
    { name: 'openrouter',   fn: () => callOpenRouter(systemPrompt, userMessage, history) },
    { name: 'mistral',      fn: () => callMistral(systemPrompt, userMessage, history) },
    { name: 'gemini-1',     fn: () => callGemini(GEMINI_KEY_1, 1, systemPrompt, userMessage, history) },
    { name: 'gemini-2',     fn: () => callGemini(GEMINI_KEY_2, 2, systemPrompt, userMessage, history) },
    { name: 'llm7',         fn: () => callLlm7(systemPrompt, userMessage, history) },
    { name: 'poll-post',    fn: () => callPollinationsPost(systemPrompt, userMessage, history) },
    { name: 'poll-get',     fn: () => callPollinationsGet(systemPrompt, userMessage) },
    { name: 'poll-oai',     fn: () => callPollinationsOai(systemPrompt, userMessage, history) },
    { name: 'ovh',          fn: () => callOvh(systemPrompt, userMessage, history) },
  ];

  for (const { name, fn } of apis) {
    // Stop trying further APIs once we've blown the overall time budget,
    // instead of silently grinding through the remaining ones for minutes.
    if (ms() >= TOTAL_CASCADE_TIMEOUT) {
      console.error(`[AI-Engine] ⏱️ Cascade time budget (${TOTAL_CASCADE_TIMEOUT}ms) exceeded before ${name} — giving up early (${ms()}ms)`);
      break;
    }
    const result = await withRetry(name, fn, 2);
    if (result) {
      console.log(`[AI-Engine] ✅ ${name} → ${ms()}ms`);
      return { text: result, api: name, ms: ms() };
    }
  }

  console.error(`[AI-Engine] 💀 All APIs failed or time budget exceeded (${ms()}ms)`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported main function
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {Array}  history      [{role, content}]
 * @param {string} [userId]     sender JID for per-user queue
 * @returns {Promise<{text:string, api:string, ms:number}|null>}
 */
async function getAIResponse(systemPrompt, userMessage, history = [], userId = 'default') {
  return queueForUser(userId, async () => {
    await acquireSemaphore();
    try {
      return await _runAIRequest(systemPrompt, userMessage, history);
    } finally {
      releaseSemaphore();
    }
  });
}

module.exports = { getAIResponse };