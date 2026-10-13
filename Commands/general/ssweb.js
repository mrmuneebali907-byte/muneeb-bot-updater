/**
 * .ssweb <url>   (aliases: .ss  .screenshot  .webss)
 * Website screenshot through a chain of FREE, key-less services — the next one is tried
 * automatically when one is down, blocked or returns a placeholder instead of the page.
 */
const axios = require('axios');

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// real image? (PNG / JPEG / WEBP magic bytes) and not a tiny placeholder
function isRealImage(buf, minBytes = 8000) {
  if (!buf || buf.length < minBytes) return false;
  const h = buf.subarray(0, 12);
  const png  = h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47;
  const jpg  = h[0] === 0xff && h[1] === 0xd8;
  const webp = h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WEBP';
  return png || jpg || webp;
}

async function getImage(url, opts = {}) {
  const r = await axios.get(url, {
    responseType: 'arraybuffer', timeout: opts.timeout || 25000, maxRedirects: 5,
    headers: { 'User-Agent': UA, Accept: 'image/*,*/*' }, validateStatus: s => s >= 200 && s < 400,
  });
  return Buffer.from(r.data);
}

const SERVICES = [
  // 1. thum.io
  async (u) => getImage(`https://image.thum.io/get/width/1280/crop/900/noanimate/${u}`, { timeout: 30000 }),

  // 2. WordPress mshots (answers with a placeholder while it renders → retry a few times)
  async (u) => {
    for (let i = 0; i < 4; i++) {
      const b = await getImage(`https://s0.wp.com/mshots/v1/${encodeURIComponent(u)}?w=1280&h=900`, { timeout: 20000 });
      if (isRealImage(b, 15000)) return b;
      await sleep(4000);
    }
    throw new Error('mshots still rendering');
  },

  // 3. microlink
  async (u) => {
    const r = await axios.get(`https://api.microlink.io/?url=${encodeURIComponent(u)}&screenshot=true&meta=false&viewport.width=1280&viewport.height=900`,
      { timeout: 40000, headers: { 'User-Agent': UA } });
    const link = r.data?.data?.screenshot?.url;
    if (!link) throw new Error('microlink: no screenshot');
    return getImage(link, { timeout: 25000 });
  },

  // 4. Google PageSpeed (returns the rendered page as a base64 screenshot; slow but dependable)
  async (u) => {
    const r = await axios.get(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(u)}&category=performance&strategy=desktop`,
      { timeout: 60000, headers: { 'User-Agent': UA } });
    const data = r.data?.lighthouseResult?.audits?.['final-screenshot']?.details?.data
              || r.data?.lighthouseResult?.fullPageScreenshot?.screenshot?.data;
    if (!data) throw new Error('pagespeed: no screenshot');
    return Buffer.from(String(data).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  },

  // 5. old API of this bot (last, short timeout)
  async (u) => {
    const r = await axios.get(`https://eliteprotech-apis.zone.id/ssweb?url=${encodeURIComponent(u)}`, { timeout: 12000, responseType: 'arraybuffer', headers: { 'User-Agent': UA } });
    return Buffer.from(r.data);
  },
];

async function screenshot(url) {
  const errors = [];
  for (let i = 0; i < SERVICES.length; i++) {
    try {
      const buf = await SERVICES[i](url);
      if (isRealImage(buf, i === 1 ? 15000 : 6000)) return buf;
      errors.push(`#${i + 1}: not an image`);
    } catch (e) { errors.push(`#${i + 1}: ${e.message}`); }
  }
  console.error('[ssweb] all services failed →', errors.join(' | '));
  throw new Error('Is website ka screenshot abhi nahi mil paya (site block kar rahi hai ya services busy hain). Thodi der baad dobara try karein.');
}

function normalizeUrl(raw) {
  let u = String(raw || '').trim().replace(/^<|>$/g, '');
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const x = new URL(u);
    if (!x.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(x.hostname)) return null;
    return x.href;
  } catch (_) { return null; }
}

module.exports = {
  name: 'ssweb',
  aliases: ['screenshot', 'ss', 'webss'],
  category: 'general',
  description: 'Take a screenshot of a website',
  usage: '.ssweb <url>   e.g. .ssweb google.com',
  screenshot, normalizeUrl,

  async execute(sock, msg, args, extra) {
    try {
      // ".ss web https://…" → ignore the word "web"
      if (args[0] && /^(web|site|website)$/i.test(args[0])) args = args.slice(1);
      if (!args.length) return extra.reply('❌ Website ka link dein.\n\nExample: *.ssweb google.com*');

      const url = normalizeUrl(args.join(''));
      if (!url) return extra.reply('❌ Valid website link dein.\n\nExample: *.ssweb https://github.com*');

      try { await sock.sendMessage(extra.from, { react: { text: '📸', key: msg.key } }); } catch (_) {}
      const buf = await screenshot(url);
      await sock.sendMessage(extra.from, { image: buf, caption: `🌐 ${url}` }, { quoted: msg });
      try { await sock.sendMessage(extra.from, { react: { text: '✅', key: msg.key } }); } catch (_) {}
    } catch (error) {
      console.error('SSWeb command error:', error.message);
      try { await sock.sendMessage(extra.from, { react: { text: '❌', key: msg.key } }); } catch (_) {}
      await extra.reply(`❌ ${error.message}`);
    }
  }
};
