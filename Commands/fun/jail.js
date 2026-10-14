/**
 * Jail Command
 * Mention/reply karke kisi ki DP ko jail bars ke andar daal deta hai.
 * Agar DP privacy ki wajah se access na ho paaye (ya user ki DP hi na ho),
 * to fallback me ek jail/prison-themed GIF bhej deta hai.
 *
 * DEPENDENCY: is command ke liye `sharp` chahiye — woh aapke package.json
 * me already installed hai, isliye kuch alag se install nahi karna.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
// Jimp v0.x aur v1.x dono ke saath kaam kare (v1 me export shape badal
// gaya hai: { Jimp } named export, isliye direct require se .read
// undefined aa sakta hai) — lekin humne asal me sharp use kar liya hai
// (already aapke project me installed aur stable), isliye jimp ki zarurat
// nahi rahi.
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

// ── Fallback GIF source (jab DP na mile) — Giphy search ──
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || 'vyYf8iZZyE6JI1LkCYwURqmINBj3svxb';
const FALLBACK_QUERIES = ['jail', 'prison', 'behind bars', 'arrested meme'];

async function fetchFallbackJailGif() {
  let lastErr;
  const shuffled = [...FALLBACK_QUERIES].sort(() => Math.random() - 0.5);

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
        headers: { 'User-Agent': 'MrMuneebAliBot/1.0 (https://github.com/mr-muneeb-ali-bot)' },
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
      console.log(`[jail] Giphy search "${query}" failed: ${e.message}`);
    }
  }

  throw new Error(`No fallback jail GIF found. Last: ${lastErr?.message}`);
}

// ── GIF Buffer → MP4 Buffer (fallback path ke liye) ──
function gifToMp4(gifBuffer) {
  return new Promise((resolve, reject) => {
    const id = `jail_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const tmpGif = path.join(os.tmpdir(), `${id}.gif`);
    const tmpMp4 = path.join(os.tmpdir(), `${id}.mp4`);

    const cleanup = () => {
      try { if (fs.existsSync(tmpGif)) fs.unlinkSync(tmpGif); } catch (_) {}
      try { if (fs.existsSync(tmpMp4)) fs.unlinkSync(tmpMp4); } catch (_) {}
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
          if (!buf || buf.length === 0) throw new Error('Converted MP4 is empty');
          resolve(buf);
        } catch (e) {
          cleanup();
          reject(e);
        }
      })
      .save(tmpMp4);
  });
}

// ── DP ko jail bars ke andar compose karo (sharp + SVG overlay) ──
async function createJailImage(profilePicBuffer) {
  const size = 600;
  const barWidth = 26;
  const gap = 70;
  const bannerHeight = 70;

  // Vertical bars + bottom "JAILED" banner ek SVG overlay ke taur par
  // banate hain, phir sharp se photo ke upar composite kar dete hain.
  let barsSvg = '';
  for (let x = 0; x < size; x += gap) {
    const w = Math.min(barWidth, size - x);
    if (w <= 0) continue;
    barsSvg += `<rect x="${x}" y="0" width="${w}" height="${size}" fill="#0c0c0c" fill-opacity="0.92" />`;
  }

  const overlaySvg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${size}" height="${size}" fill="#000000" fill-opacity="0.18" />
      ${barsSvg}
      <rect x="0" y="${size - bannerHeight}" width="${size}" height="${bannerHeight}" fill="#000000" fill-opacity="0.75" />
      <text x="${size / 2}" y="${size - bannerHeight / 2}" font-family="Arial, sans-serif"
        font-size="34" font-weight="bold" fill="#ffffff" text-anchor="middle"
        dominant-baseline="middle">JAILED 🔒</text>
    </svg>
  `;

  const resizedPhoto = await sharp(profilePicBuffer)
    .resize(size, size, { fit: 'cover' })
    .toBuffer();

  return sharp(resizedPhoto)
    .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

module.exports = {
  name: 'jail',
  aliases: ['jailed', 'jeel'],
  category: 'fun',
  description: 'Put a mentioned/replied user\'s DP behind jail bars. No target = jails yourself.',
  usage: '.jail @user OR reply with .jail OR just .jail (jails yourself)',
  groupOnly: false,

  async execute(sock, msg, args, extra) {
    try {
      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];

      // ── Target decide karo: mention > reply > khud (default) ──
      let target = extra.sender;

      if (mentioned.length >= 1) {
        target = mentioned[0];
      } else if (ctx.participant) {
        target = ctx.participant;
      }

      const nameOf = id => `@${id.split('@')[0]}`;

      // ── Target ki DP fetch karne ki koshish ──
      let profilePicUrl = null;
      try {
        profilePicUrl = await sock.profilePictureUrl(target, 'image');
      } catch (e) {
        // Privacy locked hai ya DP set nahi hai — fallback chalega
        profilePicUrl = null;
      }

      if (profilePicUrl) {
        // ── DP mil gayi: jail image banao ──
        const picResponse = await axios.get(profilePicUrl, {
          responseType: 'arraybuffer',
          timeout: 30000
        });

        const picBuffer = Buffer.from(picResponse.data);

        if (!picBuffer || picBuffer.length === 0) {
          throw new Error('Empty profile picture response');
        }

        const jailBuffer = await createJailImage(picBuffer);

        await sock.sendMessage(
          extra.from,
          {
            image: jailBuffer,
            caption: `${nameOf(target)} has been sent to JAIL 🔒👮`,
            mentions: [target]
          },
          { quoted: msg }
        );

      } else {
        // ── DP nahi mili (privacy/no-DP): fallback GIF bhejo ──
        const gifUrl = await fetchFallbackJailGif();

        const gifResponse = await axios.get(gifUrl, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'MrMuneebAliBot/1.0 (https://github.com/mr-muneeb-ali-bot)',
            'Accept': 'image/gif,image/*'
          },
          timeout: 30000
        });

        const gifBuffer = Buffer.from(gifResponse.data);

        if (!gifBuffer || gifBuffer.length === 0) {
          throw new Error('Empty GIF response');
        }

        const mp4Buffer = await gifToMp4(gifBuffer);

        await sock.sendMessage(
          extra.from,
          {
            video: mp4Buffer,
            gifPlayback: true,
            caption: `${nameOf(target)}'s DP privacy se protected hai, isliye yeh le lo 🔒👮`,
            mentions: [target]
          },
          { quoted: msg }
        );
      }

    } catch (error) {
      console.error('[jail] ERROR:', error);

      if (error.message?.includes('GIPHY_KEY_INVALID')) {
        await extra.reply('❌ Giphy API key invalid/blocked hai. Apni free key developers.giphy.com se banao aur GIPHY_API_KEY env var me set karo.');

      } else if (error.code === 'ECONNABORTED' || error.message?.toLowerCase().includes('timeout')) {
        await extra.reply('❌ Request timed out. Please try again.');

      } else if (error.code === 'ENOTFOUND' || error.message?.includes('ENOTFOUND') || error.message?.includes('getaddrinfo')) {
        await extra.reply('❌ Network/DNS issue: bot ke server se GIF sources resolve nahi ho paa rahe. Yeh code ka bug nahi hai — server/host ka internet ya DNS check karo, ya thodi der baad try karo.');

      } else if (error.message?.toLowerCase().includes('ffmpeg')) {
        await extra.reply('❌ GIF conversion failed. Please check FFmpeg installation.');

      } else if (error.message?.toLowerCase().includes('sharp') || error.code === 'MODULE_NOT_FOUND') {
        await extra.reply('❌ Image processing library (sharp) me issue hai. Server pe `npm install sharp` chala ke bot restart karo.');

      } else {
        await extra.reply(`❌ Failed to send jail: ${error.message}`);
      }
    }
  }
};
