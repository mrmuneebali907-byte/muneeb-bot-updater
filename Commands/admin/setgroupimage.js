/**
 * .setgroupimage — change the GROUP profile picture
 *   • reply to an image (or sticker) with  .setgroupimage
 *   • or send an image with the caption     .setgroupimage
 * Short: .setgpp  .sgi  .gpp  .setgrouppp        Example: (reply to a photo) .sgi
 */
const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');

const MAX_BYTES = 10 * 1024 * 1024;
const unwrap = (m) => m?.ephemeralMessage?.message || m?.viewOnceMessageV2?.message || m?.viewOnceMessage?.message ||
                      m?.documentWithCaptionMessage?.message || m;

module.exports = {
  name: 'setgroupimage',
  aliases: ['setgpp', 'sgi', 'gpp', 'setgrouppp', 'setgroupicon'],
  description: 'Group ki photo badlo (image par reply karke)',
  usage: '.setgroupimage  (image par reply)   |  short: .sgi',
  category: 'admin',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    let file = null;
    try {
      const own = unwrap(msg.message) || {};
      const ctx = own.extendedTextMessage?.contextInfo || own.imageMessage?.contextInfo || own.videoMessage?.contextInfo;
      const quoted = unwrap(ctx?.quotedMessage);
      const media = own.imageMessage || quoted?.imageMessage || quoted?.stickerMessage;
      if (!media) {
        return extra.reply('⚠️ Kisi *image* par reply karke likho: *.setgroupimage*\n(short: .sgi)\nYa image bhejte waqt caption me yeh command likho.\n\n📝 Example: photo par reply → .sgi');
      }
      const stream = await downloadContentFromMessage(media, 'image');
      let buf = Buffer.alloc(0);
      for await (const c of stream) { buf = Buffer.concat([buf, c]); if (buf.length > MAX_BYTES) break; }
      if (!buf.length) return extra.reply('❌ Image download nahi hui, dobara try karo.');
      if (buf.length > MAX_BYTES) return extra.reply('❌ Image bahut badi hai (max 10MB).');

      file = path.join(getTempDir(), `gpp_${Date.now()}.jpg`);
      fs.writeFileSync(file, buf);
      await sock.updateProfilePicture(extra.from, { url: file });
      return extra.reply('✅ *Group ki photo update ho gayi!*');
    } catch (e) {
      console.error('[setgroupimage]', e?.message || e);
      return extra.reply('❌ Group photo update nahi hui. Check karo ke bot *admin* hai aur image sahi hai.');
    } finally {
      if (file) deleteTempFile(file);
    }
  },
};
