/**
 * .list — every command, grouped by category (nothing is skipped).
 *  - uses the UNIQUE command objects (an alias that clashes with another command's name can no longer hide it)
 *  - Channel / Facebook / Instagram / TikTok / YouTube link buttons are attached to the list message (the WHOLE list is ONE message)
 */
const config = require('../../config');
const { loadCommands } = require('../../utils/commandLoader');

// Social / channel link buttons — they are attached to the LAST message of the list itself.
const LINK_BUTTONS = [
  { text: '🙋 𝐁𝐨𝐭 𝐂𝐡𝐚𝐧𝐧𝐞𝐥', url: 'https://whatsapp.com/channel/0029VbCYOAaGpLHUfkR9A92W' },
  { text: '📘 Facebook',      url: 'https://www.facebook.com/share/1EC249FVZz/' },
  { text: '📸 Instagram',     url: 'https://www.instagram.com/mr.muneeb.ali.786?xtok=MjV6OTgyOTAyZm85' },
  { text: '🎵 TikTok',        url: 'https://tiktok.com/@its.muneeb.king09' },
  { text: '▶️ YouTube',       url: 'https://www.youtube.com/@Mr.MuneebAli-Abbasi' },
];

/** send ONE interactive message: `bodyText` + the link buttons (so buttons are part of the list). */
async function sendWithLinkButtons(sock, chatId, msg, bodyText) {
  const { generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
  const btn = (b) => ({ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: b.text, url: b.url, merchant_url: b.url }) });
  const content = {
    viewOnceMessage: { message: {
      messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
      interactiveMessage: proto.Message.InteractiveMessage.create({
        body:   proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
        footer: proto.Message.InteractiveMessage.Footer.create({ text: config.botName || 'Bot' }),
        header: proto.Message.InteractiveMessage.Header.create({ title: '', hasMediaAttachment: false }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: LINK_BUTTONS.map(btn) }),
      }),
    } },
  };
  const m = generateWAMessageFromContent(chatId, content, { quoted: msg, userJid: sock.user?.id });
  await sock.relayMessage(chatId, m.message, {
    messageId: m.key.id,
    additionalNodes: [{ tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }] }],
  });
}

module.exports = {
  name: 'list',
  aliases: ['cmds', 'allcmds'],
  description: 'List all commands with descriptions',
  usage: '.list',
  category: 'general',

  async execute(sock, msg, args, extra) {
    try {
      const prefix = config.prefix;
      const commands = loadCommands();
      const unique = [...new Set(commands.values())].filter(c => c && c.name);
      const categories = {};
      for (const cmd of unique) {
        const category = String(cmd.category || 'other').toLowerCase();
        (categories[category] = categories[category] || []).push(cmd);
      }

      // ONE message with EVERY command: short forms (aliases), description and usage example.
      // (WhatsApp folds long messages behind "Read more", so length is no problem — hard cap 60k chars.)
      const sorted = Object.keys(categories).sort();
      const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();
      const withPrefix = (u) => { u = oneLine(u); if (!u) return ''; return u.startsWith(prefix) ? u : (/^[a-z0-9]/i.test(u) ? prefix + u : u); };
      const build = (level) => {
        const out = [];
        for (const cat of sorted) {
          const list = categories[cat].sort((x, y) => x.name.localeCompare(y.name));
          const rows = list.map((c) => {
            const short = [...new Set(c.aliases || [])].map(n => `${prefix}${n}`).join(', ');
            let r = `• *${prefix}${c.name}*` + (short ? `  _(${short})_` : '');
            const d = oneLine(c.description || c.desc);
            if (d) r += `\n   ${level >= 1 ? d : d.slice(0, 40)}`;
            if (level >= 1) {
              const ex = c.example || (Array.isArray(c.examples) ? c.examples[0] : '') || c.usage;
              const e = withPrefix(ex);
              if (e) r += `\n   📌 ${e}`;
            }
            return r;
          });
          out.push(`*📂 ${cat.toUpperCase()}* (${list.length})\n${rows.join('\n')}`);
        }
        return `*${config.botName} - Commands List*\nPrefix: *${prefix}* | Total: *${unique.length}* commands\n\n` + out.join('\n\n');
      };
      let full = build(1);
      if (full.length > 60000) full = build(0);

      const chatId = msg.key.remoteJid;
      try {
        await sendWithLinkButtons(sock, chatId, msg, full.trimEnd());
      } catch (e) {
        console.log('[list] buttons skipped:', e.message);
        const linksText = '\n\n' + LINK_BUTTONS.map(b => `${b.text}\n${b.url}`).join('\n');
        await sock.sendMessage(chatId, { text: full.trimEnd() + linksText }, { quoted: msg });   // links still reach the user as text
      }
    } catch (err) {
      console.error('list.js error:', err);
      try { await extra.reply('❌ Failed to load commands list.'); } catch {}
    }
  },
};
