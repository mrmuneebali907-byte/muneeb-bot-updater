'use strict';
/**
 * utils/aiKeys.js — one place for every AI API key.
 *
 *  • The owner's keys are built in (below); more can be added at any time with
 *    `.aikey add groq <key>` (stored in data/aiKeys.json — no code edit, no re-upload).
 *  • A key that answers 401/403 is parked for 6 h (expired / revoked); a 429 only
 *    parks that key+model for a minute. Parked keys are skipped so the next one is used at once.
 *  • Keys rotate round-robin so one key's free quota is not burnt first.
 */
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'aiKeys.json');

// Built-in keys (owner's current ones). Old expired keys were removed.
const DEFAULTS = {
  // keys are NOT stored in code (the update repo is public) — use `.aikey add <provider> <key>` or env vars
  groq: [], gemini: [], mistral: [],
};
const PROVIDERS = ['groq', 'gemini', 'mistral', 'openrouter', 'cerebras'];

function readFile() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (_) { return {}; } }
function writeFile(o) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(o, null, 2)); } catch (_) {} }

function envKeys(p) {
  const v = process.env[`${p.toUpperCase()}_API_KEY`] || process.env[`${p.toUpperCase()}_KEYS`] || '';
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

/** all keys of a provider: file first (newest), then env, then built-in; no duplicates */
function all(provider) {
  const f = readFile();
  const removed = new Set(f._removed?.[provider] || []);
  const list = [...(f[provider] || []), ...envKeys(provider), ...(DEFAULTS[provider] || [])];
  return [...new Set(list)].filter(k => k && !removed.has(k));
}

// ── health / rotation ───────────────────────────────────────────────────────────
const _parked = new Map();   // `${key}|${model||''}` → until ts
const _cursor = {};          // provider → rr index
const now = () => Date.now();

function isParked(key, model) {
  const t1 = _parked.get(key + '|'), t2 = model ? _parked.get(key + '|' + model) : 0;
  return Math.max(t1 || 0, t2 || 0) > now();
}
function park(key, model, ms) { _parked.set(key + '|' + (model || ''), now() + ms); }
/** report an HTTP status for a key → returns the kind of problem */
function report(key, model, status) {
  if (status === 401 || status === 403) { park(key, '', 6 * 3600_000); return 'dead'; }
  if (status === 429 || status === 503) { park(key, model, 60_000); return 'limited'; }
  if (status === 404 || status === 400) { park(key, model, 10 * 60_000); return 'badmodel'; }
  return 'error';
}
function ok(key, model) { _parked.delete(key + '|'); if (model) _parked.delete(key + '|' + model); }

/** usable keys for a provider/model, rotated so load is spread */
function usable(provider, model) {
  const list = all(provider).filter(k => !isParked(k, model));
  if (!list.length) return [];
  const i = (_cursor[provider] = ((_cursor[provider] ?? -1) + 1) % list.length);
  return [...list.slice(i), ...list.slice(0, i)];
}

// ── management (.aikey) ─────────────────────────────────────────────────────────
function add(provider, key) {
  if (!PROVIDERS.includes(provider)) throw new Error('provider: ' + PROVIDERS.join(' | '));
  const f = readFile();
  f[provider] = [key, ...(f[provider] || []).filter(k => k !== key)];
  if (f._removed?.[provider]) f._removed[provider] = f._removed[provider].filter(k => k !== key);
  writeFile(f); _parked.clear();
}
function remove(provider, keyOrTail) {
  const f = readFile();
  const hit = all(provider).filter(k => k === keyOrTail || k.endsWith(keyOrTail));
  if (!hit.length) return 0;
  f[provider] = (f[provider] || []).filter(k => !hit.includes(k));
  f._removed = f._removed || {}; f._removed[provider] = [...new Set([...(f._removed[provider] || []), ...hit])];
  writeFile(f); return hit.length;
}
const mask = (k) => k.slice(0, 5) + '…' + k.slice(-4);
function summary() {
  return PROVIDERS.map(p => ({ provider: p, keys: all(p).map(k => ({ key: mask(k), parked: isParked(k) })) })).filter(x => x.keys.length);
}

module.exports = { all, usable, report, ok, park, add, remove, summary, PROVIDERS };
