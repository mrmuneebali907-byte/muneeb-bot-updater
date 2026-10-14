/**
 * Bite Command - anime bite reaction with mention support
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

// Multiple independent sources tried in order — agar ek domain host pe
// resolve na ho (DNS/firewall issue) to agli source try hoti hai
const SOURCES = [
  {
    name: "nekos.best",
    url: "https://nekos.best/api/v2/bite",
    extract: (data) => data?.results?.[0]?.url
  },
  {
    name: "waifu.pics",
    url: "https://api.waifu.pics/sfw/bite",
    extract: (data) => data?.url
  },
  {
    name: "purrbot.site",
    url: "https://purrbot.site/api/img/sfw/bite/gif",
    extract: (data) => data?.link
  }
];

// ── Fetch Bite GIF ──
async function fetchBiteGif() {
  let lastErr;

  for (const src of SOURCES) {
    try {
      const response = await axios.get(src.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      const gifUrl = src.extract(response.data);

      if (gifUrl && typeof gifUrl === 'string') {
        console.log(`[bite] Using source: ${src.name}`);
        return gifUrl;
      }

      throw new Error(`Invalid response from ${src.name}`);

    } catch (e) {
      lastErr = e;
      console.log(`[bite] Source ${src.name} failed: ${e.message}`);
    }
  }

  throw new Error(
    `All bite GIF sources failed. Last: ${lastErr?.message || 'Unknown error'}`
  );
}

// ── Convert GIF Buffer → MP4 Buffer ──
function gifToMp4(gifBuffer) {
  return new Promise((resolve, reject) => {

    const id = `bite_${Date.now()}_${Math.random().toString(36).slice(2)}`;

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

// ── Captions ──
const CAPTIONS = [
  "{a} bites {b}! \ud83d\ude08\ud83e\uddb7",
  "{a} playfully bites {b}! \ud83d\ude08",
  "CHOMP! {a} just bit {b} \ud83d\ude08",
  "{a} \ud83d\ude08 {b} \u2014 ouch, that's a bite!"
];

module.exports = {
  name: 'bite',
  aliases: ["kaato"],
  category: 'fun',
  description: 'Bite a mentioned/replied user with a GIF.',
  usage: '.bite @user OR reply with .bite',
  groupOnly: false,

  async execute(sock, msg, args, extra) {
    try {
      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];

      let a = extra.sender;
      let b = null;

      // ── Mention support ──
      if (mentioned.length >= 1) {
        b = mentioned[0];

      // ── Reply support ──
      } else if (ctx.participant) {
        b = ctx.participant;

      // ── Random group member support ──
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
        return extra.reply('❌ Aap khud ko bite nahi kar sakte 😅');
      }

      // ── Fetch GIF ──
      const gifUrl = await fetchBiteGif();

      // ── Download GIF ──
      const gifResponse = await axios.get(gifUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'image/gif,image/*'
        },
        timeout: 30000
      });

      const gifBuffer = Buffer.from(gifResponse.data);

      if (!gifBuffer || gifBuffer.length === 0) {
        throw new Error('Empty GIF response');
      }

      // ── Convert GIF → MP4 ──
      const mp4Buffer = await gifToMp4(gifBuffer);

      const nameOf = id => `@${id.split('@')[0]}`;

      const template = CAPTIONS[Math.floor(Math.random() * CAPTIONS.length)];

      const caption = template
        .replace('{a}', nameOf(a))
        .replace('{b}', nameOf(b));

      // ── Send GIF-style video ──
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
      console.error('[bite] ERROR:', error);

      if (error.response?.status === 404) {
        await extra.reply('❌ Bite GIF not found. Please try again.');

      } else if (error.response?.status === 429) {
        await extra.reply('❌ GIF API rate limit exceeded. Please try again later.');

      } else if (error.code === 'ECONNABORTED' || error.message?.toLowerCase().includes('timeout')) {
        await extra.reply('❌ Request timed out. Please try again.');

      } else if (error.code === 'ENOTFOUND' || error.message?.includes('ENOTFOUND') || error.message?.includes('getaddrinfo')) {
        await extra.reply('❌ Network/DNS issue: bot ke server se GIF sources resolve nahi ho paa rahe. Yeh code ka bug nahi hai — server/host ka internet ya DNS check karo, ya thodi der baad try karo.');

      } else if (error.message?.toLowerCase().includes('ffmpeg')) {
        await extra.reply('❌ GIF conversion failed. Please check FFmpeg installation.');

      } else {
        await extra.reply(`❌ Failed to send bite: ${error.message}`);
      }
    }
  }
};
