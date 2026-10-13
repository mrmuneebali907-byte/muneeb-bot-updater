'use strict';
/**
 * voiceRouter — what the voice bot does with a transcribed voice note.
 *
 *   1. "tu kaun hai / kaunsi API / kisne banaya"  → fixed answer (never reaches an AI provider)
 *   2. a spoken COMMAND ("menu dikhao", "mujhe tum hi ho gana chahiye", "ping")
 *        → the real command is run (public commands only; owner/admin/mod commands are never obeyed by voice)
 *   3. anything else → chat reply in the same personality as the text chatbot, spoken back as a voice note
 */
const { isIdentityQuestion, identityAnswer, voicePrompt, smallTalk } = require('./aiPersona');

// never runnable by voice, whatever their flags say
const HARD_BLOCK = new Set(['ban', 'unban', 'kick', 'kickall', 'promote', 'demote', 'mute', 'unmute', 'warn', 'resetwarn', 'delete', 'del',
  'restart', 'reboot', 'shutdown', 'broadcast', 'bc', 'antilink', 'setprefix', 'setbotname', 'eval', 'exec', 'shell', 'join', 'leave',
  'block', 'unblock', 'update', 'setgowner', 'strictguard', 'chatbot', 'voice', 'allgroupstatus', 'channelreact', 'aikey', 'nsfw',
  'antiuserbot', 'antigroupmention', 'antifake', 'ok', 'tagall', 'hidetag', 'clean', 'pair', 'addowner', 'delowner', 'sudo']);

const CUE_RE = /\b(chahiye|chahie|chahiye|do|dena|de|dikhao|dikha|bhejo|bhej|bajao|baja|sunao|suna|play|show|send|download|batao|bata|khol|open|kar\s*do|karo|nikalo|laao|la\s*do|lagao)\b|चाहिए|दिखाओ|दिखा|भेजो|भेज|बजाओ|सुनाओ|सुना|दो\b|बताओ|खोलो|लगाओ|चाहिये|دکھاؤ|بھیجو|چاہیے|سناؤ|بجاؤ|دو\b/i;

const FILLERS = new RegExp('\\b(mujhe|muje|mera|meri|mere|ye|yeh|yah|wala|wali|wale|chahiye|chahie|chahiye|dena|dedo|bhejo|bhej|bajao|baja|sunao|suna|play|send|download|karo|kar|dikhao|dikha|batao|bata|please|plz|pls|ek|ye\\s*wala|zara|jaldi|abhi|bot|hey|hello|song|songs|gana|gaana|gaane|gane|music|video|videos|youtube)\\b|मुझे|मेरा|मेरी|ये|यह|वाला|वाली|वाले|चाहिए|चाहिये|दो|दीजिए|भेजो|भेज|बजाओ|सुनाओ|सुना|कर|करो|दिखाओ|बताओ|प्लीज|का|की|के|को|से|एक|ज़रा|जल्दी|अभी|गाना|गाने|गीत|सॉन्ग|सोंग|वीडियो|म्यूजिक|मुझ[े]|چاہیے|دو|بھیجو|سناؤ|بجاؤ|گانا|ویڈیو|کا|کی|کے|کو|سے|ایک|مجھے|یہ|والا|والی', 'gi');

function cleanQuery(text) {
  return String(text || '').replace(FILLERS, ' ').replace(/[.,!?।؟"'،]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
}

/** public commands that may be started by voice */
function allowedCommands(commandsMap) {
  const seen = new Map();
  for (const m of commandsMap.values()) {
    if (!m?.name || seen.has(m.name)) continue;
    if (m.ownerOnly || m.adminOnly || m.superAdminOnly || m.modOnly) continue;
    if (['owner', 'admin', 'developer', 'dev'].includes(String(m.category || '').toLowerCase())) continue;
    if (HARD_BLOCK.has(m.name) || (m.aliases || []).some(a => HARD_BLOCK.has(a))) continue;
    seen.set(m.name, m);
  }
  return seen;
}

// ultra-common requests, handled without any AI call (fast + works even if every API is down)
function quickRoute(text, allowed) {
  const t = text.toLowerCase();
  const has = (n) => allowed.has(n);
  if (has('menu') && /\b(menu|help|commands?\s*(list|dikhao|batao)?|list)\b|मेन्यू|मेनू|मैन्यू|منیو|मینو|कमांड/.test(t)) return { command: 'menu', args: '' };
  if (has('ping') && /\b(ping|alive|zinda)\b|पिंग|पींग|पिंग|زندہ|پنگ/.test(t) && t.length < 40) return { command: 'ping', args: '' };
  if (has('uptime') && /\buptime\b|अपटाइम/.test(t)) return { command: 'uptime', args: '' };
  const song = /\b(song|songs|gana|gaana|gaane|gane|music|mp3)\b|गाना|गाने|गीत|सॉन्ग|सोंग|म्यूजिक|گانا|گانے|سانگ/.test(t);
  const video = /\b(video|videos|youtube|yt)\b|वीडियो|यूट्यूब|ویڈیو|یوٹیوب/.test(t);
  if (song && has('song') && CUE_RE.test(t)) { const q = cleanQuery(text); if (q.length >= 2) return { command: 'song', args: q }; }
  if (video && !song && has('video') && CUE_RE.test(t)) { const q = cleanQuery(text); if (q.length >= 2) return { command: 'video', args: q }; }
  return null;
}

const GREET_RE = /(assalam|assalaam|asalam|salam|salaam|namaste|hello|\bhi\b|\bhey\b|सलाम|असलाम|नमस्ते|हैलो|हेलो|السلام|سلام|ہیلو)/i;
const LEADING_GREET = /^\s*(["'“”]?\s*)?((अस्सलाम|असलाम|अस्सलामु|सलाम)\s*(वालेकुम|अलैकुम|वालैकुम|अलैकुम)?(\s*(अस्सलाम|सलाम))?|वालेकुम\s*(अस्सलाम|सलाम)|नमस्ते|नमस्कार|हैलो|हेलो|हेल्लो|assalam[ -]?o?[ -]?alaikum|assalamualaikum|assalam\s*walekum|assalam\s*o\s*alaikum|walaikum\s*assalam|salam|hello|hi)(?=[\s,!.।-]|$)[\s,!.।-]*(?:(?:bhai|भाई|janab|जनाब|yaar|यार)(?=[\s,!.।-]|$)[\s,!.।-]*)?/i;

/** make the reply safe & short for a voice note */
function sanitizeReply(reply, userText) {
  let r = String(reply || '')
    .replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ')
    .replace(/^[\s>•\-*#\d.)]+(?=\S)/gm, '')       // bullets / numbering
    .replace(/[*_~`#>|"“”]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  // greeting only when the user greeted
  if (!GREET_RE.test(String(userText || ''))) {
    const stripped = r.replace(LEADING_GREET, '').trim();
    if (stripped.length >= 3) r = stripped.replace(/^[,!.।\s-]+/, '').replace(/\s+/g, ' ');
  }
  // at most 2 sentences / ~260 chars
  const sents = r.match(/[^.!?।؟\n]+[.!?।؟]*/g) || [r];
  r = sents.slice(0, 2).join(' ').trim();
  if (r.length > 260) r = r.slice(0, 260).replace(/\s+\S*$/, '') + '।';
  return r;
}

const _bsc = require('./botScope');
const _hist = new Map();   // per user, last turns (spoken chat memory)
function pushHist(userId, userText, reply) {
  const hist = _hist.get(_bsc.key(userId)) || [];
  hist.push({ role: 'user', content: userText }, { role: 'assistant', content: reply });
  if (hist.length > 10) hist.splice(0, hist.length - 10);
  _hist.set(_bsc.key(userId), hist);
  if (_hist.size > 300) _hist.delete(_hist.keys().next().value);
}

/** ONE AI call that decides: run a command, or just talk back. */
async function think(text, allowed, deps, userId) {
  const list = [...allowed.values()].map(m => `${m.name}${m.description ? ': ' + String(m.description).slice(0, 40) : ''}`).join('\n');
  const system = voicePrompt({ isOwner: deps.isOwner }) +
    `\n\n═══ COMMAND MODE ═══\nAgar user CLEARLY bot se in commands mein se koi chalwane ko keh raha hai (jaise "mera menu dikhao", "ye gana chahiye", "mausam batao", "sticker bana do"), to command chuno. Sirf yeh commands allowed hain:\n${list}\n\n` +
    `OUTPUT: sirf ek JSON object:\n{"command":"<exact command name ya null>","args":"<arguments jaise gaane/video ka naam, shehar, ya khali>","reply":"<agar command null hai to teri bolne wali chhoti baat (upar ke rules ke mutabiq); command ho to khali>"}\n` +
    `Normal baat-cheet, sawaal, mazaak, salam → command null aur reply mein jawab.`;
  const hist = _hist.get(_bsc.key(userId)) || [];
  const r = await deps.askAI({ system, user: text, history: hist, json: true, maxTokens: 260, temperature: 0.7, userId });
  if (!r?.text) return null;
  try {
    const j = JSON.parse(r.text.replace(/^```(?:json)?|```$/g, '').trim());
    const name = j?.command && String(j.command).toLowerCase().replace(/^[.!/]/, '');
    if (name && allowed.has(name)) {
      const args = String(j.args || '').replace(/[\r\n]+/g, ' ').replace(/^[.!/#]+/, '').trim().slice(0, 200);
      return { command: name, args };
    }
    if (j?.reply) return { reply: String(j.reply) };
  } catch (_) { /* not JSON → plain chat below */ }
  return null;
}

/**
 * @param deps { commands:Map, askAI, isOwner:boolean }
 * @returns {Promise<{type:'command',command,args}|{type:'speak',text}|{type:'fail'}>}
 */
async function handleTranscript(transcript, userId, deps) {
  const text = String(transcript || '').trim();

  if (isIdentityQuestion(text)) return { type: 'speak', text: identityAnswer('voice', text) };

  const allowed = allowedCommands(deps.commands);

  // instant, AI-free routes (work even when every API is down)
  const quick = quickRoute(text, allowed);
  if (quick) return { type: 'command', ...quick };

  const _st = smallTalk(text);
  if (_st) { pushHist(userId, text, _st); return { type: 'speak', text: _st }; }

  // one smart call: command or chat
  const t = await think(text, allowed, deps, userId).catch(() => null);
  if (t?.command) return { type: 'command', command: t.command, args: t.args };
  let reply = t?.reply ? sanitizeReply(t.reply, text) : '';

  if (!reply) {   // plain chat fallback (model did not return JSON)
    const r = await deps.askAI({ system: voicePrompt({ isOwner: deps.isOwner }), user: text, history: _hist.get(_bsc.key(userId)) || [], maxTokens: 140, temperature: 0.7, userId });
    reply = sanitizeReply(r?.text, text);
  }
  if (!reply) return { type: 'fail' };
  pushHist(userId, text, reply);
  return { type: 'speak', text: reply };
}

module.exports = { handleTranscript, allowedCommands, quickRoute, cleanQuery, sanitizeReply };
