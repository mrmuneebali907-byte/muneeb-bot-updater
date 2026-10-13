/**
 * GPT Image Command
 * Multi-API fallback system for image analysis
 * By 𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢
 */

const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { webp2png } = require('../../utils/webp2mp4');
const sharp = require('sharp');

const { describe } = require('../../utils/vision');

async function callGeminiWithFallback(base64Image, prompt) {
  const { text } = await describe(Buffer.from(base64Image, 'base64'), prompt + '\n\n(Jawab usi zaban/lehje mein do jis mein sawaal poochha gaya hai.)');
  return text;
}

module.exports = {
  name: 'gptimage',
  aliases: ['gptimg', 'editimage', 'vision', 'gi'],
  category: 'ai',
  description: 'Analyze image using Gemini Vision AI',
  usage: '.gptimage <prompt> (reply to image/sticker)',

  async execute(sock, msg, args, extra) {
    try {

      // ── 1. Reply check ──
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      if (!ctxInfo?.quotedMessage) {
        return await extra.reply(
          '📷 *GPT Image Editor*\n\n' +
          'Kisi *image* ya *sticker* ko reply karo apne prompt ke saath.\n\n' +
          `Usage: ${extra.prefix || '.'}gptimage <tumhara prompt>\n\n` +
          'Example:\n' +
          `${extra.prefix || '.'}gptimage is image mein kya hai?`
        );
      }

      // ── 2. Prompt check ──
      const prompt = args.join(' ').trim() || 'Is image mein kya hai? Detail mein batao.';

      // ── 3. Image ya sticker check ──
      const quotedMsg = ctxInfo.quotedMessage;
      const isImage = !!quotedMsg.imageMessage;
      const isSticker = !!quotedMsg.stickerMessage;

      if (!isImage && !isSticker) {
        return await extra.reply('❌ Sirf *image* ya *sticker* ko reply karo!');
      }

      // ── 4. Animated sticker check ──
      if (isSticker) {
        const stickerMsg = quotedMsg.stickerMessage;
        const isAnimated = stickerMsg.isAnimated || stickerMsg.mimetype?.includes('animated');
        if (isAnimated) {
          return await extra.reply('❌ Animated sticker support nahi. Static image use karo.');
        }
      }

      // ── 5. Processing message ──
      await extra.reply('⏳ Image analyze ho rahi hai...');

      // ── 6. Target message ──
      const targetMessage = {
        key: {
          remoteJid: extra.from,
          id: ctxInfo.stanzaId,
          participant: ctxInfo.participant,
        },
        message: ctxInfo.quotedMessage,
      };

      // ── 7. Download image ──
      let mediaBuffer = await downloadMediaMessage(
        targetMessage,
        'buffer',
        {},
        { logger: undefined, reuploadRequest: sock.updateMediaMessage }
      );

      if (!mediaBuffer) {
        return await extra.reply('❌ Image download nahi hui. Dobara try karo.');
      }

      // ── 8. Sticker to PNG convert ──
      if (isSticker) {
        try {
          mediaBuffer = await webp2png(mediaBuffer);
        } catch (err) {
          console.error('Sticker convert error:', err);
          return await extra.reply('❌ Sticker convert nahi hua. Regular image use karo.');
        }
      }

      // ── 9. JPEG convert ──
      let finalBuffer;
      try {
        finalBuffer = await sharp(mediaBuffer)
          .jpeg({ quality: 85 })
          .toBuffer();
      } catch (err) {
        console.error('Sharp error:', err);
        finalBuffer = mediaBuffer;
      }

      // ── 10. Base64 convert ──
      const base64Image = finalBuffer.toString('base64');

      // ── 11. Multi-API call with fallback ──
      const result = await callGeminiWithFallback(base64Image, prompt);

      // ── 12. Result send karo (clean, no extra caption) ──
      await sock.sendMessage(
        extra.from,
        {
          text: `✨ *Vision Result*\n\n${result}`
        },
        { quoted: msg }
      );

    } catch (error) {
      console.error('Gptimage command error:', error);

      return await extra.reply('❌ Abhi image analyze nahi ho saki (saari AI services busy hain). Thodi der baad dobara try karo.');
    }
  },
};
