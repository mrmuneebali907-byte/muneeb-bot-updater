/**
 * .imagine — AI image generation from a text prompt.
 * Many free fallbacks (utils/imageGen.js): never depends on a single API.
 */
const { generate } = require('../../utils/imageGen');

module.exports = {
  name: 'imagine',
  aliases: ['magic', 'magicai', 'aiimage', 'generate'],
  category: 'ai',
  description: 'Generate AI image from a text prompt',
  desc: 'Generate AI image from a text prompt',
  usage: '.imagine <prompt>',
  execute: async (sock, msg, args, extra) => {
    const prefix = extra?.prefix || '.';
    const prompt = args.join(' ').trim();
    if (!prompt) {
      return extra.reply(`🎨 *Imagine*\n\nUsage: ${prefix}imagine <prompt>\nExample: ${prefix}imagine a cyberpunk city at night`);
    }
    try { await sock.sendPresenceUpdate('composing', extra.from); } catch (_) {}
    let waitMsg; try { waitMsg = await sock.sendMessage(extra.from, { text: '🎨 Image ban rahi hai, 10-60 second lag sakte hain...' }, { quoted: msg }); } catch (_) {}
    try {
      const { buffer, api } = await generate(prompt);
      let out = buffer;
      if (out.length > 5 * 1024 * 1024) {
        try { out = await require('sharp')(out).jpeg({ quality: 82 }).toBuffer(); } catch (_) {}
      }
      await sock.sendMessage(extra.from, { image: out, caption: `🎨 ${prompt.slice(0, 150)}` }, { quoted: msg });
      if (waitMsg?.key) { try { await sock.sendMessage(extra.from, { delete: waitMsg.key }); } catch (_) {} }
    } catch (error) {
      console.error('[imagine]', error.message);
      await extra.reply('❌ Abhi saari image services busy hain. Thodi der baad dobara try karo, ya prompt chhota/saaf likho (English me behtar chalta hai).');
    }
  },
};
