/**
 * sttEngine.js — speech-to-text for the voice bot.
 *   1. Groq Whisper (owner keys, whisper-large-v3-turbo → whisper-large-v3)
 *   2. Google Gemini (inline audio) as the fallback
 * Keys come from utils/aiKeys.js (expired ones are skipped automatically).
 */
'use strict';

const keys = require('./aiKeys');

const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODELS  = ['whisper-large-v3-turbo', 'whisper-large-v3'];
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash'];
const TIMEOUT_MS = 25_000;

async function groqOnce(audioBuffer, apiKey, model, language) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg');
    form.append('model', model);
    // a language hint stops Whisper guessing Korean/Japanese on short Hindi-Urdu clips
    if (language && language !== 'auto') form.append('language', language);
    form.append('temperature', '0');
    // vocabulary hint: Pakistani/Indian Hindi-Urdu chat words, so greetings & common phrases are heard correctly
    if (language === 'hi' || language === 'ur') form.append('prompt', 'अस्सलाम वालेकुम भाई, क्या हाल है? मैं ठीक हूँ, आप सुनाओ। मुझे गाना चाहिए, मेनू दिखाओ।');
    const res = await fetch(GROQ_STT_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: ctrl.signal });
    if (!res.ok) { const e = new Error(`Groq STT HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`); e.status = res.status; throw e; }
    return ((await res.json()).text || '').trim();
  } finally { clearTimeout(t); }
}

async function geminiOnce(audioBuffer, apiKey, model, language) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const hint = language === 'ur' ? 'Urdu' : language === 'en' ? 'English' : 'Hindi/Urdu/Hinglish';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: `Transcribe this voice note exactly as spoken (${hint}). Hindi/Urdu speech → write in Devanagari script. Output ONLY the transcript, nothing else.` },
          { inline_data: { mime_type: 'audio/ogg', data: Buffer.from(audioBuffer).toString('base64') } },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 400 },
      }),
    });
    if (!res.ok) { const e = new Error(`Gemini STT HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`); e.status = res.status; throw e; }
    const d = await res.json();
    return (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  } finally { clearTimeout(t); }
}

async function transcribeAudio(audioBuffer, opts = {}) {
  const language = opts.language || 'hi';
  let lastErr;
  for (const model of GROQ_MODELS) {
    for (const key of keys.usable('groq', 'stt:' + model)) {
      try { const text = await groqOnce(audioBuffer, key, model, language); if (text) { keys.ok(key, 'stt:' + model); return text; } throw new Error('empty'); }
      catch (e) { lastErr = e; keys.report(key, 'stt:' + model, e.status || 0); console.log('[STT]', e.message); }
    }
  }
  for (const model of GEMINI_MODELS) {
    for (const key of keys.usable('gemini', 'stt:' + model)) {
      try { const text = await geminiOnce(audioBuffer, key, model, language); if (text) { keys.ok(key, 'stt:' + model); return text; } throw new Error('empty'); }
      catch (e) { lastErr = e; keys.report(key, 'stt:' + model, e.status || 0); console.log('[STT]', e.message); }
    }
  }
  throw new Error(`Speech-to-text failed. Last: ${lastErr?.message}`);
}

module.exports = { transcribeAudio };
