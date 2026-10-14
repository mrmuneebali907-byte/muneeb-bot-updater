/**
 * Goodnight Command - stylish good night GIF with mention support
 * Giphy search based (no dedicated reaction-gif API exists for this one).
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

// Apni Giphy key env var se set karo (GIPHY_API_KEY). Neeche wali key
// aapki khud ki hai — king.js me bhi wahi use ho rahi hai.
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || 'vyYf8iZZyE6JI1LkCYwURqmINBj3svxb';

const SEARCHES = ["good night", "sweet dreams", "sleep tight", "goodnight anime"];

async function fetchGoodnightGif() {
  let lastErr;

  const shuffled = [...SEARCHES].sort(() => Math.random() - 0.5);

  for (const query of shuffled) {
    try {
      const randomOffset = Math.floor(Math.random() * 50);

      const response = await axios.get('https://api.giphy.com/v1/gifs/search', {
        params: {
          api_key: GIPHY_API_KEY,
          q: query,
          limit: 25,
          offset: randomOffset,
          rating: 'pg-13',
          lang: 'en'
        },
        headers: { 'User-Agent': 'Mr-Muneeb-Ali-AI-Bot/1.0' },
        timeout: 15000
      });

      const results = Array.isArray(response.data?.data) ? response.data.data : [];

      const gifs = results
        .map(item =>
          item?.images?.original?.url ||
          item?.images?.downsized_large?.url ||
          null
        )
        .filter(url => typeof url === 'string' && /\.gif(?:\?|$)/i.test(url));

      if (gifs.length > 0) {
        return gifs[Math.floor(Math.random() * gifs.length)];
      }

      throw new Error(`No GIF results for "${query}"`);
    } catch (e) {
      if (e.response?.status === 403) {
        throw new Error(
          'GIPHY_KEY_INVALID: Giphy API key invalid ya blocked hai (403). developers.giphy.com se apni free key banao aur GIPHY_API_KEY env var me set karo.'
        );
      }

      lastErr = e;
      console.log(`[goodnight] Giphy search "${query}" failed: ${e.message}`);
    }
  }

  throw new Error(`No Goodnight GIF found. Last: ${lastErr?.message}`);
}

// ── Convert GIF Buffer → MP4 Buffer ──
function gifToMp4(gifBuffer) {
  return new Promise((resolve, reject) => {
    const id = `goodnight_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const tmpGif = path.join(os.tmpdir(), `${id}.gif`);
    const tmpMp4 = path.join(os.tmpdir(), `${id}.mp4`);

    const cleanup = () => {
      try {
        if (fs.existsSync(tmpGif)) fs.unlinkSync(tmpGif);
      } catch (_) {}
      try {
        if (fs.existsSync(tmpMp4)) fs.unlinkSync(tmpMp4);
      } catch (_) {}
    };

    try {
      fs.writeFileSync(tmpGif, gifBuffer);
    } catch (e) {
      return reject(new Error(`Failed to write temp GIF: ${e.message}`));
    }

    ffmpeg(tmpGif)
      .videoCodec('libx264')
      .outputOptions([
        '-movflags', 'faststart',
        '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
      ])
      .format('mp4')
      .on('error', (e) => {
        cleanup();
        reject(new Error(`FFmpeg error: ${e.message}`));
      })
      .on('end', () => {
        try {
          const buf = fs.readFileSync(tmpMp4);
          cleanup();
          if (!buf || buf.length === 0) {
            throw new Error('Converted MP4 is empty');
          }
          resolve(buf);
        } catch (e) {
          cleanup();
          reject(e);
        }
      })
      .save(tmpMp4);
  });
}

const CAPTIONS = [
  "{a} wishes {b} a peaceful Good Night! \ud83c\udf19\u2728",
  "{a} tucks {b} in and says Good Night \ud83c\udf19\ud83d\ude34",
  "Sweet dreams, {b}! - {a} \ud83c\udf19\ud83d\udca4",
  "{a} \ud83c\udf19 {b} \u2014 Good Night, sleep tight!"
];

module.exports = {
  name: 'goodnight',
  aliases: ["gn", "shubhratri"],
  category: 'fun',
  description: 'Wish a mentioned/replied user Good Night with a GIF.',
  usage: '.goodnight @user OR reply with .goodnight',
  groupOnly: false,

  async execute(sock, msg, args, extra) {
    try {
      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];

      let a = extra.sender;
      let b = null;

      if (mentioned.length >= 1) {
        b = mentioned[0];
      } else if (ctx.participant) {
        b = ctx.participant;
      } else if (extra.isGroup && extra.groupMetadata?.participants) {
        const participants = extra.groupMetadata.participants
          .map(p => p.id)
          .filter(id => id !== extra.sender && id !== sock.user.id);

        if (participants.length > 0) {
          b = participants[Math.floor(Math.random() * participants.length)];
        }
      }

      if (!b) {
        return extra.reply(
          '❌ Mention someone, reply to their message, or use this in a group with other members.'
        );
      }

      if (b === extra.sender) {
        return extra.reply('❌ Khud ko goodnight bolne ka koi matlab nahi 😅 Bas so jao!');
      }

      const gifUrl = await fetchGoodnightGif();

      const gifResponse = await axios.get(gifUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mr-Muneeb-Ali-AI-Bot/1.0',
          'Accept': 'image/gif,image/*'
        },
        timeout: 30000
      });

      const gifBuffer = Buffer.from(gifResponse.data);

      if (!gifBuffer || gifBuffer.length === 0) {
        throw new Error('Empty GIF response');
      }

      const mp4Buffer = await gifToMp4(gifBuffer);

      const nameOf = id => `@${id.split('@')[0]}`;

      const template = CAPTIONS[Math.floor(Math.random() * CAPTIONS.length)];

      const caption = template
        .replace('{a}', nameOf(a))
        .replace('{b}', nameOf(b));

      await sock.sendMessage(
        extra.from,
        {
          video: mp4Buffer,
          gifPlayback: true,
          caption,
          mentions: [a, b]
        },
        { quoted: msg }
      );

    } catch (error) {
      console.error('[goodnight] ERROR:', error);

      if (error.response?.status === 404) {
        await extra.reply('❌ Goodnight GIF source not found. Please try again.');

      } else if (error.response?.status === 429) {
        await extra.reply('❌ GIF service rate limit reached. Please try again later.');

      } else if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        await extra.reply('❌ Goodnight GIF request timed out. Please try again.');

      } else if (error.message?.includes('GIPHY_KEY_INVALID')) {
        await extra.reply('❌ Giphy API key invalid/blocked hai. Apni free key developers.giphy.com se banao aur GIPHY_API_KEY env var me set karo.');

      } else if (error.message?.includes('No Goodnight GIF found')) {
        await extra.reply('❌ No Goodnight GIF is currently available from the GIF source.');

      } else {
        await extra.reply(`❌ Failed to send Goodnight GIF: ${error.message}`);
      }
    }
  }
};
