const crypto = require('crypto');
const {
  generateWAMessageContent,
  generateWAMessageFromContent,
  downloadContentFromMessage,
} = require('@whiskeysockets/baileys');
const { PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const mediaFix = require('../../utils/mediaFix');

// Single default color for text statuses (purple)
const PURPLE_COLOR = '#9C27B0';

// WhatsApp wraps messages (disappearing chats, view-once, edits...) and puts meta keys first.
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage', 'deviceSentMessage'];
const META_KEYS = ['messageContextInfo', 'senderKeyDistributionMessage', 'protocolMessage'];

function unwrap(m) {
  for (let i = 0; m && typeof m === 'object' && i < 6; i++) {
    const w = WRAPPERS.find((k) => m[k] && m[k].message);
    if (!w) break;
    m = m[w].message;
  }
  return m || null;
}
function typeOf(m) {
  return m ? (Object.keys(m).find((k) => !META_KEYS.includes(k) && m[k]) || '') : '';
}

module.exports = {
  name: 'groupstatus',
  aliases: ['togstatus', 'swgc', 'gs', 'gstatus'],
  description: 'Post replied media or text as a WhatsApp group status (new Group Status feature).',
  usage: '.groupstatus [caption]  (reply to image/video/audio) OR .groupstatus your text',
  category: 'admin',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const from = extra.from;

      // Only inside groups
      if (!extra.isGroup) {
        return extra.reply('👥 This command can only be used in groups.');
      }

      // .groupstatus check | patch | unpatch
      if (/^(check|debug|info|patch|unpatch)$/i.test(String(args[0] || ''))) {
        const gs  = require('../../utils/groupStatusSend');
        const sub = String(args[0]).toLowerCase();
        const senderId = msg.key.participant || msg.key.remoteJid;
        const isOwnerUser = require('../lib/isOwner')(senderId) || require('../lib/perm').isPrivileged(sock, msg, extra);
        if ((sub === 'patch' || sub === 'unpatch') && !isOwnerUser) return extra.reply('🔒 Ye sirf bot owner kar sakta hai.');
        if (sub === 'patch') {
          try { const r = gs.applyPatch(); return extra.reply(r.ok ? (r.already ? '✅ Patch pehle se laga hai.' : '✅ Patch laga diya (media group status ke liye mediatype).\n\n🔁 *Bot Restart karo*, tabhi asar hoga.') : `⚠️ ${r.why}`); }
          catch (e) { return extra.reply('❌ Patch nahi lag saka: ' + e.message); }
        }
        if (sub === 'unpatch') { try { return extra.reply(gs.revertPatch() ? '✅ Patch hata diya. Bot Restart karo.' : 'ℹ️ Backup nahi mila, patch laga hi nahi tha.'); } catch (e) { return extra.reply('❌ ' + e.message); } }
        let bv = '?'; try { bv = require('@whiskeysockets/baileys/package.json').version; } catch (_) {}
        let sh = 'ok'; try { require('sharp'); } catch (e) { sh = 'FAILED'; }
        const me = String(sock.user?.id || '').split('@')[0].split(':')[0];
        return extra.reply(
          `🔎 *GROUP STATUS CHECK*\n\n` +
          `Bot number: *${me}*\n` +
          `Baileys: *${bv}*\n` +
          `Meta node (is_group_status): *${gs.libAddsMeta() ? 'lib khud lagata hai' : 'bot lagata hai'}*\n` +
          `mediatype fix: *automatic (bot khud lagata hai)*  | lib patch: *${gs.patchState()}*\n` +
          `sharp: *${sh}*\n` +
          `Bot admin: *${extra.isBotAdmin ? 'haan' : 'nahi'}*\n\n` +
          `Test: pehle text, phir image par reply karke *.groupstatus*. 30 second baad console me *[groupstatus] 🧾 30s report* dekho.`);
      }

      const caption = (args.join(' ') || '').trim();

      const own = unwrap(msg.message);
      const ownType = typeOf(own);
      const ctxInfo = own?.extendedTextMessage?.contextInfo || own?.[ownType]?.contextInfo;
      const hasQuoted = !!ctxInfo?.quotedMessage;

      // Media sent WITH the command as its caption (no reply needed)
      const ownMedia = /^(image|video|audio)Message$/.test(ownType) && !hasQuoted;

      // CASE 1: No quoted message -> treat as TEXT group status
      if (!hasQuoted && !ownMedia) {
        if (!caption) {
          return extra.reply(
            '📝 *Group Status Usage*\n\n' +
            '• Reply to image/video/audio with:\n' +
            '  `.groupstatus [optional caption]`\n' +
            '• Or send text status only:\n' +
            '  `.groupstatus Your text here`\n\n' +
            'Text statuses use a single purple background color by default.'
          );
        }

        await extra.reply('⏳ Posting text group status...');

        try {
          await groupStatus(sock, from, {
            _notify: extra.reply,
            text: caption,
            backgroundColor: PURPLE_COLOR,
          });
          return extra.reply('✅ Text group status posted!');
        } catch (e) {
          console.error('groupstatus text error:', e);
          return extra.reply('❌ Failed to post text group status: ' + (e.message || e));
        }
      }

      // CASE 2: Quoted media -> image/video/audio group status
      const targetMessage = {
        key: {
          remoteJid: from,
          id: ctxInfo?.stanzaId,
          participant: ctxInfo?.participant,
        },
        message: ownMedia ? own : unwrap(ctxInfo.quotedMessage),
      };

      const mtype = typeOf(targetMessage.message);

      // Reply to a TEXT message -> post that text as a text status
      if (/^(conversation|extendedTextMessage)$/.test(mtype)) {
        const qt = targetMessage.message.conversation || targetMessage.message.extendedTextMessage?.text || '';
        const finalText = (caption || qt).trim();
        if (!finalText) return extra.reply('❌ Is message mein text nahi hai.');
        await extra.reply('⏳ Posting text group status...');
        try {
          await groupStatus(sock, from, {
            _notify: extra.reply, text: finalText, backgroundColor: PURPLE_COLOR });
          return extra.reply('✅ Text group status posted!');
        } catch (e) {
          console.error('groupstatus text error:', e);
          return extra.reply('❌ Failed to post text group status: ' + (e.message || e));
        }
      }

      const downloadBuf = async () => {
        const qmsg = targetMessage.message;
        if (/image/i.test(mtype))   return await downloadMedia(qmsg, 'image');
        if (/video/i.test(mtype))   return await downloadMedia(qmsg, 'video');
        if (/audio/i.test(mtype))   return await downloadMedia(qmsg, 'audio');
        if (/sticker/i.test(mtype)) return await downloadMedia(qmsg, 'sticker'); // download sticker correctly
        return null;
      };

      // IMAGE (also handles stickers)
      if (/image|sticker/i.test(mtype)) {
        await extra.reply('⏳ Posting image group status...');
        let buf;
        try {
          buf = await downloadBuf();
        } catch {
          return extra.reply('❌ Failed to download image');
        }
        if (!buf) return extra.reply('❌ Could not download image');

        try {
          await groupStatus(sock, from, {
            _notify: extra.reply,
            image: buf,
            caption: caption || '',
          });
          return extra.reply('✅ Image group status posted!');
        } catch (e) {
          console.error('groupstatus image error:', e);
          return extra.reply('❌ Failed to post image group status: ' + (e.message || e));
        }
      }

      // VIDEO
      if (/video/i.test(mtype)) {
        await extra.reply('⏳ Posting video group status...');
        let buf;
        try {
          buf = await downloadBuf();
        } catch {
          return extra.reply('❌ Failed to download video');
        }
        if (!buf) return extra.reply('❌ Could not download video');

        try {
          await groupStatus(sock, from, {
            _notify: extra.reply,
            video: buf,
            caption: caption || '',
          });
          return extra.reply('✅ Video group status posted!');
        } catch (e) {
          console.error('groupstatus video error:', e);
          return extra.reply('❌ Failed to post video group status: ' + (e.message || e));
        }
      }

      // AUDIO (voice-style group status)
      if (/audio/i.test(mtype)) {
        await extra.reply('⏳ Posting audio group status...');
        let buf;
        try {
          buf = await downloadBuf();
        } catch {
          return extra.reply('❌ Failed to download audio');
        }
        if (!buf) return extra.reply('❌ Could not download audio');

        let vn;
        try {
          vn = await toVN(buf);
        } catch {
          vn = buf;
        }

        let waveform;
        try {
          waveform = await generateWaveform(buf);
        } catch {
          waveform = undefined;
        }

        try {
          await groupStatus(sock, from, {
            _notify: extra.reply,
            audio: vn,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            waveform,
          });
          return extra.reply('✅ Audio group status posted!');
        } catch (e) {
          console.error('groupstatus audio error:', e);
          return extra.reply('❌ Failed to post audio group status: ' + (e.message || e));
        }
      }

      return extra.reply('❌ Ye type support nahi hai. Image, video, audio ya text par reply karo.');
    } catch (e) {
      console.error('groupstatus command error (outer):', e);
      return extra.reply('❌ Error: ' + (e.message || e));
    }
  },
};

// ---- Helpers ----

async function downloadMedia(msg, type) {
  const mediaMsg = msg[`${type}Message`] || msg;
  const stream = await downloadContentFromMessage(mediaMsg, type);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function groupStatus(sock, jid, content) {
  const { backgroundColor, _notify } = content;
  delete content.backgroundColor;
  delete content._notify;

  const imgBuf = content.image;
  const inside = await generateWAMessageContent(content, {
    upload: sock.waUploadToServer,
    backgroundColor: backgroundColor || PURPLE_COLOR,
  });
  // images need thumbnail + width/height or WhatsApp silently drops a group status (hosts without working sharp)
  let thumb = 'n/a';
  try { thumb = await mediaFix.fixImageInner(inside, imgBuf); } catch (e) { thumb = 'error ' + e.message; }

  // Group Status = groupStatusMessageV2 + contextInfo.isGroupStatus + <meta is_group_status="true"/> (utils/groupStatusSend.js)
  const sent = await require('../../utils/groupStatusSend').relayGroupStatus(sock, jid, inside);
  const msg  = sent.msg;
  watchAck(sock, msg.key.id, _notify, jid);
  console.log(`[groupstatus] relayed kind=${sent.kind} meta=${sent.meta} thumb=${thumb} group=${String(jid).split('@')[0]}`);
  return msg;
}

/**
 * WhatsApp's server answers every message with an ack. A REJECTED group status (account / group not allowed,
 * restricted account, bad stanza…) only shows up there — relayMessage itself still "succeeds".
 * Baileys turns an error ack into a messages.update with status 0 (ERROR) and the error code.
 */
function watchAck(sock, id, notify, jid) {
  try {
    if (!sock?.ev?.on || !id) return;
    const grp = String(jid).split('@')[0];
    const h = (updates) => {
      for (const u of updates || []) {
        if (u?.key?.id !== id) continue;
        const st = u.update?.status;
        if (st === 0) {
          const code = (u.update.messageStubParameters || [])[0] || '?';
          console.log(`[groupstatus] ❌ server ne REJECT kiya  error=${code}  group=${grp}`);
          if (typeof notify === 'function') {
            Promise.resolve(notify(`⚠️ WhatsApp server ne group status reject kar diya (error ${code}).\nYe bot ka code nahi, is number / group par WhatsApp ki pabandi hai.`)).catch(() => {});
          }
        } else if (st >= 2) {
          console.log(`[groupstatus] ✅ server ack/delivery status=${st}  group=${grp}`);
        }
      }
    };
    sock.ev.on('messages.update', h);
    setTimeout(() => { try { sock.ev.off('messages.update', h); } catch (_) {} }, 30000).unref?.();
  } catch (_) {}
}

function toVN(buffer) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];

    input.end(buffer);

    ffmpeg(input)
      .noVideo()
      .audioCodec('libopus')
      .format('ogg')
      .audioChannels(1)
      .audioFrequency(48000)
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks)))
      .pipe(output);

    output.on('data', (c) => chunks.push(c));
  });
}

function generateWaveform(buffer, bars = 64) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    input.end(buffer);

    const chunks = [];

    ffmpeg(input)
      .audioChannels(1)
      .audioFrequency(16000)
      .format('s16le')
      .on('error', reject)
      .on('end', () => {
        const raw = Buffer.concat(chunks);
        const samples = raw.length / 2;
        const amps = [];

        for (let i = 0; i < samples; i++) {
          amps.push(Math.abs(raw.readInt16LE(i * 2)) / 32768);
        }

        const size = Math.floor(amps.length / bars);
        if (size === 0) return resolve(undefined);

        const avg = Array.from({ length: bars }, (_, i) =>
          amps
            .slice(i * size, (i + 1) * size)
            .reduce((a, b) => a + b, 0) / size
        );

        const max = Math.max(...avg);
        if (max === 0) return resolve(undefined);

        resolve(
          Buffer.from(
            avg.map((v) => Math.floor((v / max) * 100))
          ).toString('base64')
        );
      })
      .pipe()
      .on('data', (c) => chunks.push(c));
  });
}