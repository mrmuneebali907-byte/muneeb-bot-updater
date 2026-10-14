/**
 * .pair command
 * Redirects users to the official WhatsApp Newsletter / Channel.
 * NO pairing code. NO QR. NO phone number. NO auth.
 * Sends: video (with premium message as caption + View Channel newsletter button) + Urdu/Hindi PTT voice note.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const ffmpeg  = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

// ── Constants ────────────────────────────────────────────────────────────────
const NEWSLETTER_JID  = '120363427895437605@newsletter';
const NEWSLETTER_NAME = 'Mr.Muneeb Ali Bot';
const SETUP_VIDEO_URL = 'https://github.com/mrmuneebali907-byte/Muneeb-Bot-videos-/raw/refs/heads/main/mr.muneeb.ali.bot.pair.video.mp4';

// Sentences split — Edge TTS silently truncates long single requests.
const TTS_CHUNKS = [
  'Assalamualaikum dost.',
  'Agar aap bot connect karna chahte hain, to sabse pehle niche diye gaye View Channel button par click karein.',
  'Hamare official channel mein complete setup guide, video tutorials, aur latest updates maujood hain.',
  'Channel ko follow karne ke baad, latest setup post open karein, aur usmein diye gaye instructions follow karein.',
  'Agar phir bhi koi problem aaye, to dot owner command use karke owner se rabta karein.',
  'Allah Hafiz.'
];

const MESSAGE_TEXT =
`╔═══━━━─── • ───━━━═══╗
⚡ 𝐁𝐎𝐓 𝐂𝐎𝐍𝐍𝐄𝐂𝐓 𝐂𝐄𝐍𝐓𝐄𝐑 ⚡
╚═══━━━─── • ───━━━═══╝

👋 𝐖𝐞𝐥𝐜𝐨𝐦𝐞 𝐓𝐨 𝐎𝐮𝐫 𝐎𝐟𝐟𝐢𝐜𝐢𝐚𝐥 𝐒𝐞𝐭𝐮𝐩 𝐒𝐲𝐬𝐭𝐞𝐦

╭───────────────⭓
│ 📡 𝐒𝐓𝐀𝐓𝐔𝐒 : ONLINE
│ 🛡️ 𝐒𝐄𝐂𝐔𝐑𝐈𝐓𝐘 : ACTIVE
│ 🚀 𝐒𝐄𝐑𝐕𝐄𝐑 : STABLE
│ 💎 𝐕𝐄𝐑𝐒𝐈𝐎𝐍 : PREMIUM
╰───────────────⭓

⚠️ 𝐃𝐢𝐫𝐞𝐜𝐭 𝐩𝐚𝐢𝐫𝐢𝐧𝐠 𝐢𝐬 𝐧𝐨𝐭 𝐚𝐯𝐚𝐢𝐥𝐚𝐛𝐥𝐞.

✨ 𝐓𝐨 𝐜𝐨𝐧𝐧𝐞𝐜𝐭 𝐲𝐨𝐮𝐫 𝐛𝐨𝐭, 𝐯𝐢𝐬𝐢𝐭 𝐨𝐮𝐫 𝐨𝐟𝐟𝐢𝐜𝐢𝐚𝐥 𝐜𝐡𝐚𝐧𝐧𝐞𝐥 𝐚𝐧𝐝 𝐟𝐨𝐥𝐥𝐨𝐰 𝐭𝐡𝐞 𝐬𝐞𝐭𝐮𝐩 𝐠𝐮𝐢𝐝𝐞.

╭───────────────⭓
│ 🎥 Video Tutorials
│ 📢 Latest Updates
│ 🆕 New Commands
│ 🔧 Bug Fixes
│ 💎 Premium Features
│ 🤝 Community Support
╰───────────────⭓

📌 𝐒𝐓𝐄𝐏 𝟎𝟏
Tap the "View Channel" button.

📌 𝐒𝐓𝐄𝐏 𝟎𝟐
Follow the official channel.

📌 𝐒𝐓𝐄𝐏 𝟎𝟑
Open the latest setup post.

📌 𝐒𝐓𝐄𝐏 𝟎𝟒
Follow the instructions carefully.

╭───────────────⭓
│ ❓ Need Help?
│ Type: .owner
╰───────────────⭓

💖 𝐓𝐡𝐚𝐧𝐤 𝐘𝐨𝐮 𝐅𝐨𝐫 𝐒𝐮𝐩𝐩𝐨𝐫𝐭𝐢𝐧𝐠 𝐎𝐮𝐫 𝐂𝐨𝐦𝐦𝐮𝐧𝐢𝐭𝐲`;

// ── TTS audio cache (regenerated if null) ────────────────────────────────────
let _ttsCache = null; // Buffer | null

// ── Convert an MP3 Buffer → OGG/OPUS Buffer via FFmpeg temp files ─────────────
function mp3ToOggOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const id     = `pair_tts_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const tmpMp3 = path.join(os.tmpdir(), `${id}.mp3`);
    const tmpOgg = path.join(os.tmpdir(), `${id}.ogg`);

    const cleanup = () => {
      try { if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3); } catch (_) {}
      try { if (fs.existsSync(tmpOgg)) fs.unlinkSync(tmpOgg); } catch (_) {}
    };

    try {
      fs.writeFileSync(tmpMp3, mp3Buffer);
    } catch (e) {
      return reject(new Error(`Failed to write temp MP3: ${e.message}`));
    }

    ffmpeg(tmpMp3)
      .audioCodec('libopus')
      .audioFrequency(16000)
      .audioChannels(1)
      .audioBitrate('24k')
      .format('ogg')
      .on('error', (e) => { cleanup(); reject(new Error(`FFmpeg error: ${e.message}`)); })
      .on('end', () => {
        try {
          const buf = fs.readFileSync(tmpOgg);
          cleanup();
          resolve(buf);
        } catch (e) {
          cleanup();
          reject(new Error(`Failed to read converted OGG: ${e.message}`));
        }
      })
      .save(tmpOgg);
  });
}

// ── Collect a readable stream into a Buffer ───────────────────────────────────
function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data',  (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    readable.on('end',   ()  => resolve(Buffer.concat(chunks)));
    readable.on('error', (e) => reject(e));
  });
}

// ── Generate one MP3 chunk via Edge TTS ──────────────────────────────────────
async function ttsChunkToMp3(voice, text) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);
  const buf = await streamToBuffer(audioStream);
  if (!buf || buf.length < 256) throw new Error(`Empty audio for: "${text.slice(0, 40)}"`);
  return buf;
}

// ── Generate full TTS — chunks → concat MP3 → OGG/OPUS ───────────────────────
async function generateTTS() {
  if (_ttsCache) return _ttsCache;

  const voices = [
    { voice: 'hi-IN-MadhurNeural', label: 'Hindi Madhur (male)'  },
    { voice: 'hi-IN-SwaraNeural',  label: 'Hindi Swara (female)' },
    { voice: 'hi-IN-NeerjaNeural', label: 'Hindi Neerja (female)'},
  ];

  let lastErr;

  for (const { voice, label } of voices) {
    try {
      console.log(`[pair] Trying TTS voice: ${label}`);

      const mp3Parts = [];
      for (let i = 0; i < TTS_CHUNKS.length; i++) {
        const part = await ttsChunkToMp3(voice, TTS_CHUNKS[i]);
        console.log(`[pair]   chunk ${i + 1}/${TTS_CHUNKS.length} — ${part.length} bytes`);
        mp3Parts.push(part);
      }

      const mp3Buf = Buffer.concat(mp3Parts);
      console.log(`[pair] Total MP3: ${mp3Buf.length} bytes — converting to OGG/OPUS`);

      const oggBuf = await mp3ToOggOpus(mp3Buf);
      if (!oggBuf || oggBuf.length < 512) throw new Error(`OGG empty (${oggBuf?.length ?? 0} bytes)`);

      console.log(`[pair] OGG/OPUS ready: ${oggBuf.length} bytes`);
      _ttsCache = oggBuf;
      return oggBuf;

    } catch (e) {
      lastErr = e;
      console.log(`[pair] Voice ${label} failed: ${e.message}`);
    }
  }

  throw new Error(`All TTS voices failed. Last: ${lastErr?.message}`);
}

// ── Command export ────────────────────────────────────────────────────────────
// ── Direct connect: `.pair 923001234567` → this server makes a pairing code for that number ──────────
// (same flow as the website: create session → start → request pairing code; abandoned ones are removed)
const _pending   = new Map();   // sessionId → { at, t }
const _lastTry   = new Map();   // sender → ts
const PAIR_WAIT_MS = 3 * 60 * 1000;

async function directPair(sock, msg, phone, extra) {
  const reply = (t) => sock.sendMessage(extra.from, { text: t }, { quoted: msg });
  let sm, ST;
  try { sm = require('../../Panel/sessionManager'); ST = sm.SESSION_STATUS; }
  catch (e) { return reply('❌ Is server par direct connect available nahi hai. Website se connect karo.'); }

  const sender = extra.sender || extra.from;
  const now = Date.now();
  if (!extra.isOwner && now - (_lastTry.get(sender) || 0) < 60000)
    return reply('⏳ Thoda ruko — 1 minute baad dobara try karo.');
  _lastTry.set(sender, now);

  let sessions = sm.getSessions();
  if (sessions.some(s => String(s.connectedNumber || '').replace(/\D/g, '') === phone && s.status === ST.CONNECTED))
    return reply('✅ Ye number pehle se is server par connected hai.');

  // free slots held by abandoned (never paired) sessions before saying "full"
  if (sessions.length >= sm.MAX_SESSIONS) {
    for (const [id, p] of _pending) {
      if (now - p.at < 60000) continue;                         // give a fresh pairing at least 60 s
      const ss = sm.getSession(id);
      if (!ss || ss.status !== ST.CONNECTED) { clearTimeout(p.t); _pending.delete(id); try { await sm.deleteSession(id); } catch (_) {} }
    }
    sessions = sm.getSessions();
  }
  if (sessions.length >= sm.MAX_SESSIONS)
    return reply(`🔴 Ye server full hai (${sm.MAX_SESSIONS}/${sm.MAX_SESSIONS}). Website par jaakar dusra server select karo.`);

  await reply('⏳ Pairing code bana raha hun… (10-20 second)');
  let session;
  try {
    session = sm.createSession(`Bot_${Math.random().toString(36).slice(2, 10)}`, '');
    await sm.startSession(session.id);
    const code = await sm.requestPairCode(session.id, phone);
    const sid = session.id;
    _pending.set(sid, { at: Date.now(), t: setTimeout(async () => {
      _pending.delete(sid);
      const ss = sm.getSession(sid);
      if (ss && ss.status !== ST.CONNECTED) { try { await sm.deleteSession(sid); } catch (_) {} }
    }, PAIR_WAIT_MS) });
    return reply(
      `🔑 *Aapka Pairing Code:*\n\n*${code}*\n\n` +
      `1️⃣ WhatsApp kholo → ⋮ / Settings → *Linked Devices*\n` +
      `2️⃣ *Link a Device* → *Link with phone number instead*\n` +
      `3️⃣ Ye code enter karo\n\n⏱️ Code 3 minute tak chalega. Connect hote hi bot aapke number par chalu ho jayega.`
    );
  } catch (e) {
    if (session) { try { await sm.deleteSession(session.id); } catch (_) {} }
    return reply(`❌ Pairing code nahi ban saka: ${e.message}\nThodi der baad dobara try karo.`);
  }
}

module.exports = {
  name: 'pair',
  aliases: ['connect', 'setup', 'botsetup'],
  category: 'general',
  description: 'Apna bot connect karo — .pair <number> se pairing code milega',
  usage: '.pair 923001234567   |   .pair channel',
  ownerOnly: false,
  groupOnly: false,
  privateOnly: false,

  async execute(sock, msg, args, extra) {
    const chatId = extra.from;
    const first = String(args[0] || '').toLowerCase();

    // direct connect: .pair <number>
    const digits = args.join('').replace(/[^0-9]/g, '');
    if (first !== 'channel' && first !== 'info') {
      if (digits.length >= 10 && digits.length <= 15) return directPair(sock, msg, digits, extra);
      return sock.sendMessage(chatId, { text:
        `🔗 *Bot connect karo (direct)*\n\nApna number country code ke saath likho:\n*${extra.prefix || '.'}pair 923001234567*\n\n` +
        `Bot aapko pairing code dega, WhatsApp → Linked Devices mein enter karo.\n\n_Channel/setup guide ke liye:_ *${extra.prefix || '.'}pair channel*` }, { quoted: msg });
    }

    // ── Step 1: Send video with the full message as its caption (View Channel button) ──
    try {
      await sock.sendMessage(chatId, {
        video:   { url: SETUP_VIDEO_URL },
        caption: MESSAGE_TEXT,
        contextInfo: {
          forwardingScore: 999,
          isForwarded: true,
          forwardedNewsletterMessageInfo: {
            newsletterJid:   NEWSLETTER_JID,
            newsletterName:  NEWSLETTER_NAME,
            serverMessageId: -1
          }
        }
      }, { quoted: msg });
      console.log('[pair] Video + caption sent successfully');
    } catch (e) {
      console.error('[pair] Video + caption send failed:', e.message);
      try {
        await sock.sendMessage(chatId, { text: MESSAGE_TEXT }, { quoted: msg });
      } catch (e2) {
        console.error('[pair] Plain text fallback also failed:', e2.message);
      }
    }

    // ── Step 2: Generate and send Edge TTS as WhatsApp PTT voice note ─────────
    try {
      const audioBuffer = await generateTTS();
      await sock.sendMessage(chatId, {
        audio:    audioBuffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt:      true
      }, { quoted: msg });
      console.log('[pair] PTT voice note sent successfully');
    } catch (e) {
      console.error('[pair] Voice note failed:', e.message);
      _ttsCache = null; // reset so next call retries
    }
  }
};
