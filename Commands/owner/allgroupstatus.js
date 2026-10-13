'use strict';

/**
 * .allgroupstatus — post ONE group status into EVERY group this bot is in.
 *
 *   • reply to an image / video / audio  →  .allgroupstatus [caption]
 *   • or plain text                       →  .allgroupstatus your text here
 *   • .allgroupstatus stop                →  cancel a run that is in progress
 *
 * How it stays light on a 1 GB server:
 *   – the media is downloaded and uploaded to WhatsApp ONCE; the same uploaded content
 *     is then wrapped per group (own secret each) — no re-upload for every group.
 *   – groups are processed one after another with a short random pause (looks human,
 *     avoids WhatsApp rate limits) and each group has its own timeout + one retry.
 *   – runs in the background; the bot keeps answering commands meanwhile.
 *
 * Owner / connected-owner only (every member's bot posts to ITS OWN groups).
 */

const crypto = require('crypto');
const { PassThrough } = require('stream');
const {
  generateWAMessageContent,
  generateWAMessageFromContent,
  downloadContentFromMessage,
} = require('@whiskeysockets/baileys');

const PURPLE = '#9C27B0';
const PAUSE_MIN_MS  = 2500;      // pause between two groups (random between MIN and MAX)
const PAUSE_MAX_MS  = 5000;
const PER_GROUP_MS  = 40_000;    // give up on a single group after this long
const PROGRESS_EVERY = 10;       // edit the progress message every N groups

const running = new Map();       // botId → { stop:boolean }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label || 'timeout'} (${ms / 1000}s)`)), ms)),
]);
const botKey = (sock) => String(sock.user?.id || 'bot').split(':')[0].split('@')[0];

async function download(qmsg, type) {
  const node = qmsg[`${type}Message`] || qmsg;
  const stream = await downloadContentFromMessage(node, type);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

function toVN(buffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = require('fluent-ffmpeg');
    const input = new PassThrough(), output = new PassThrough(), chunks = [];
    input.end(buffer);
    ffmpeg(input).noVideo().audioCodec('libopus').format('ogg').audioChannels(1).audioFrequency(48000)
      .on('error', reject).on('end', () => resolve(Buffer.concat(chunks))).pipe(output);
    output.on('data', c => chunks.push(c));
  });
}

/** Upload the content ONCE → reusable "inner" message. */
async function buildInner(sock, content) {
  const { backgroundColor } = content;
  const clean = { ...content }; delete clean.backgroundColor;
  return generateWAMessageContent(clean, { upload: sock.waUploadToServer, backgroundColor: backgroundColor || PURPLE });
}

/** Wrap the already-uploaded inner message for one group and relay it. */
async function postToGroup(sock, jid, inner) {
  const secret = crypto.randomBytes(32);
  const wrapped = generateWAMessageFromContent(jid, {
    messageContextInfo: { messageSecret: secret },
    groupStatusMessageV2: { message: { ...inner, messageContextInfo: { messageSecret: secret } } },
  }, {});
  // tell antiGroupMention this id is our own post (never punish it)
  try { (global.__agsIds = global.__agsIds || new Set()).add(wrapped.key.id); setTimeout(() => global.__agsIds.delete(wrapped.key.id), 10 * 60 * 1000).unref?.(); } catch (_) {}
  await sock.relayMessage(jid, wrapped.message, { messageId: wrapped.key.id });
}

async function execute(sock, msg, args, extra) {
  const chatId = msg.key.remoteJid;
  const reply  = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
  const key    = botKey(sock);
  const arg0   = (args[0] || '').toLowerCase();

  // ── stop ───────────────────────────────────────────────────────────────────
  if (arg0 === 'stop' || arg0 === 'cancel') {
    const job = running.get(key);
    if (!job) return reply('ℹ️ Abhi koi *allgroupstatus* run nahi chal raha.');
    job.stop = true;
    return reply('🛑 Rok raha hun… jo group chal raha hai uske baad band ho jayega.');
  }

  if (running.has(key)) {
    return reply('⏳ Pehle se ek *allgroupstatus* chal raha hai. Rokne ke liye: *.allgroupstatus stop*');
  }

  // ── what to post ───────────────────────────────────────────────────────────
  const caption = args.join(' ').trim();
  const ctx = msg.message?.extendedTextMessage?.contextInfo
           || msg.message?.imageMessage?.contextInfo
           || msg.message?.videoMessage?.contextInfo;
  const quoted = ctx?.quotedMessage || null;

  if (!quoted && !caption) {
    return reply(
      '📢 *All Group Status*\n\n' +
      'Bot ke *saare groups* mein ek saath group status lagata hai.\n\n' +
      '• Image/Video/Audio pe reply karke:\n  *.allgroupstatus [caption]*\n' +
      '• Ya sirf text:\n  *.allgroupstatus Aapka text*\n' +
      '• Rokne ke liye: *.allgroupstatus stop*\n\n' +
      '_Har group ke beech thoda gap hota hai (WhatsApp limit se bachne ke liye), isliye zyada groups mein time lagta hai._'
    );
  }

  const job = { stop: false };
  running.set(key, job);
  let handedOff = false;   // true once the background loop owns the 'running' flag

  try {
    await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } }).catch(() => {});

    // ── build content + upload once ──────────────────────────────────────────
    let content;
    if (!quoted) {
      content = { text: caption, backgroundColor: PURPLE };
    } else {
      const type = Object.keys(quoted)[0] || '';
      if (/image/i.test(type))        content = { image: await download(quoted, 'image'), caption };
      else if (/sticker/i.test(type)) content = { image: await download(quoted, 'sticker'), caption };
      else if (/video/i.test(type))   content = { video: await download(quoted, 'video'), caption };
      else if (/audio/i.test(type)) {
        const raw = await download(quoted, 'audio');
        let vn = raw; try { vn = await toVN(raw); } catch (_) {}
        content = { audio: vn, mimetype: 'audio/ogg; codecs=opus', ptt: true };
      } else if (/conversation|extendedText/i.test(type)) {
        const t = quoted.conversation || quoted.extendedTextMessage?.text || '';
        content = { text: caption || t, backgroundColor: PURPLE };
      } else {
        running.delete(key);
        return reply('❌ Ye type support nahi hai. Image, video, audio ya text use karein.');
      }
    }

    const inner = await buildInner(sock, content);

    // ── all groups ───────────────────────────────────────────────────────────
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all || {}).filter(g => g?.id?.endsWith('@g.us'));
    if (!groups.length) { running.delete(key); return reply('❌ Bot kisi group mein nahi hai.'); }

    const estMin = Math.ceil(groups.length * ((PAUSE_MIN_MS + PAUSE_MAX_MS) / 2 + 1500) / 60000);
    const status = await sock.sendMessage(chatId, {
      text: `📢 *All Group Status shuru*\n\n👥 Groups: *${groups.length}*\n⏱️ Andaza: ~${estMin} min\n\n💬 Bot is dauran bhi chalta rahega.\nRokne ke liye: *.allgroupstatus stop*`,
    }, { quoted: msg });
    const editStatus = (text) => sock.sendMessage(chatId, { text, edit: status.key }).catch(() => {});

    // ── post one by one — in the BACKGROUND so the command returns immediately ─
    handedOff = true;
    (async () => {
      try {
      // ── post one by one ──────────────────────────────────────────────────────
      let ok = 0; const failed = [];
      for (let i = 0; i < groups.length; i++) {
        if (job.stop) break;
        const g = groups[i];
        let done = false, lastErr = null;
        for (let attempt = 1; attempt <= 2 && !done && !job.stop; attempt++) {
          try { await withTimeout(postToGroup(sock, g.id, inner), PER_GROUP_MS, 'timeout'); done = true; }
          catch (e) { lastErr = e; if (attempt < 2) await sleep(6000); }
        }
        if (done) ok++; else failed.push({ name: g.subject || g.id.split('@')[0], err: (lastErr?.message || 'error').slice(0, 60) });
        console.log(`[AllGroupStatus] ${i + 1}/${groups.length} ${done ? '✅' : '❌ ' + (lastErr?.message || '')} ${g.subject || g.id}`);

        if ((i + 1) % PROGRESS_EVERY === 0 && i + 1 < groups.length) {
          await editStatus(`📢 *All Group Status*\n\n${bar(i + 1, groups.length)}\n✅ Posted: ${ok}   ❌ Failed: ${failed.length}`);
        }
        if (i + 1 < groups.length && !job.stop) await sleep(rand(PAUSE_MIN_MS, PAUSE_MAX_MS));
      }

      const stopped = job.stop;
      const lines = [
        `${stopped ? '🛑 *Roka gaya*' : '✅ *All Group Status complete*'}`, '',
        `✅ Posted : *${ok}* / ${groups.length}`,
        `❌ Failed : *${failed.length}*`,
      ];
      if (stopped) lines.push(`⏭️ Baaki : *${groups.length - ok - failed.length}* groups reh gaye`);
      if (failed.length) {
        lines.push('', '*Fail hue groups:*');
        failed.slice(0, 8).forEach(f => lines.push(`• ${f.name} — _${f.err}_`));
        if (failed.length > 8) lines.push(`• …aur ${failed.length - 8}`);
      }
      await editStatus(lines.join('\n'));
      await sock.sendMessage(chatId, { react: { text: stopped ? '🛑' : '✅', key: msg.key } }).catch(() => {});
      } catch (e) {
        console.error('[AllGroupStatus] loop error:', e);
        await editStatus(`❌ Beech mein error aaya: ${e.message}`);
      } finally {
        running.delete(key);
      }
    })();
  } catch (e) {
    console.error('[AllGroupStatus]', e);
    await reply(`❌ Error: ${e.message}`).catch(() => {});
  } finally {
    if (!handedOff) running.delete(key);
  }
}

function bar(n, total) {
  const p = Math.round((n / total) * 10);
  return '█'.repeat(p) + '░'.repeat(10 - p) + ` ${n}/${total}`;
}

module.exports = {
  name       : 'allgroupstatus',
  aliases    : ['allgs', 'allgstatus', 'gsall'],
  category   : 'owner',
  description: 'Post a group status in ALL groups at once',
  usage      : '.allgroupstatus [caption]  (reply to media) | .allgroupstatus text | .allgroupstatus stop',
  ownerOnly  : true,
  execute,
};
