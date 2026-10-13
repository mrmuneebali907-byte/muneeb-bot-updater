'use strict';

const {
  DEFAULT_EMOJI, DEFAULT_MIX, parseEmojis,
  normalizeJid,
  get,
  set,
  remove,
  list,
  globalSet, globalRemove, globalList,
  isOptedOut, setOptOut, effective,
} = require('../../utils/channelReact');

const CHANNEL_LINK_RE = /(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i;
const NEWSLETTER_JID_RE = /^\d+@newsletter$/;

function help(isMain) {
  return [
    '📣 *Channel Auto-React*',
    '',
    '✅ Enable:',
    '`.channelreact <channel-link> on`   (har bot alag emoji — 16 ka mix)',
    '`.channelreact <channel-link> on ❤️🔥😍👏`   (in mein se har bot ek)',
    isMain ? '   _(Aap main owner ho: ye *panel ke saare bots* par lagta hai — har bot apne account se 1 react karega)_' : '   _(sirf aapke apne bot par)_',
    '',
    '❌ Disable:  `.channelreact <channel-link> off`',
    '📋 Status:   `.channelreact <channel-link> status`',
    '📋 List:     `.channelreact list`',
    '🚫 Mere bot par panel-wale channel react band:  `.channelreact optout`',
    '✅ Wapas chalu:  `.channelreact optin`',
    '',
    '_Har bot ek post par sirf ek reaction lagata hai (apne number se)._',
  ].join('\n');
}

function cleanEmoji(value) {
  const emoji = String(value || '').trim();
  if (!emoji || /^\d+$/.test(emoji) || emoji.length > 16 || /https?:\/\//i.test(emoji)) {
    return '';
  }
  return emoji;
}

async function resolveChannel(sock, input) {
  const raw = String(input || '').trim();
  if (NEWSLETTER_JID_RE.test(raw)) {
    return { jid: raw, name: raw };
  }

  const match = raw.match(CHANNEL_LINK_RE);
  if (!match) throw new Error('Valid WhatsApp Channel link ya newsletter JID dein.');
  if (typeof sock.newsletterMetadata !== 'function') {
    throw new Error('Is Baileys connection mein channel metadata support available nahi hai.');
  }

  const metadata = await sock.newsletterMetadata('invite', match[1]);
  const jid = normalizeJid(metadata?.id);
  if (!jid) throw new Error('Channel link resolve nahi hua ya channel unavailable hai.');
  return { jid, name: metadata?.name || metadata?.subject || jid };
}

module.exports = {
  name: 'channelreact',
  aliases: ['creact', 'newsletterreact'],
  category: 'owner',
  description: 'Auto-react on a WhatsApp Channel (main owner: all panel bots)',
  usage: '.channelreact <channel-link> on ❤️ | off | status | list | optout | optin',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const botId = extra.botId || sock.user?.id;
      const isMain = !!(extra.isSuperAdmin || extra.isMainDeveloper);
      const first = String(args?.[0] || '').toLowerCase();

      if (!args?.length || ['help', '?'].includes(first)) return extra.reply(help(isMain));

      if (first === 'optout') { setOptOut(botId, true);  return extra.reply('🚫 Is bot par panel-wale channel auto-react band. (Aapke apne channels chalte rahenge.)'); }
      if (first === 'optin')  { setOptOut(botId, false); return extra.reply('✅ Panel-wale channel auto-react dobara chalu.'); }

      if (first === 'list') {
        const own = list(botId);
        const glob = globalList();
        if (!own.length && !glob.length) return extra.reply('📋 Koi channel auto-react configured nahi hai.');
        const lines = [];
        if (glob.length) lines.push(`🌐 *Panel-wide* ${isOptedOut(botId) ? '(is bot par OPT-OUT)' : ''}`, ...glob.map((c, i) => `${i + 1}. ${c.name || c.jid} — ${(c.emojis && c.emojis.length ? c.emojis.join('') : c.emoji)}`), '');
        if (own.length) lines.push('🤖 *Is bot ke*', ...own.map((c, i) => `${i + 1}. ${c.name || c.jid} — ${(c.emojis && c.emojis.length ? c.emojis.join('') : c.emoji)}`));
        return extra.reply('📋 *Channel Auto-Reacts*\n\n' + lines.join('\n'));
      }

      const channel = await resolveChannel(sock, args[0]);
      const action = String(args[1] || '').toLowerCase();

      if (action === 'status') {
        const cfg = effective(botId, channel.jid);
        return extra.reply(
          `📣 *${channel.name}*\n\nJID: ${channel.jid}\n` +
          `Auto-react: ${cfg ? 'ON ✅' : 'OFF ❌'}${cfg ? ` (${cfg.scope === 'global' ? 'panel-wide' : 'sirf is bot'})` : ''}\n` +
          `Emoji: ${(cfg?.emojis?.length ? cfg.emojis.join(' ') : cfg?.emoji) || 'Not set'}`
        );
      }

      if (['off', 'disable', 'stop'].includes(action)) {
        remove(botId, channel.jid);
        let g = false;
        if (isMain) g = globalRemove(channel.jid);
        return extra.reply(`❌ Channel auto-react OFF:\n*${channel.name}*${g ? '\n(panel ke saare bots par band)' : ''}`);
      }

      if (!['on', 'enable', 'start', 'set'].includes(action)) return extra.reply(help(isMain));

      // emojis: ".. on"  or ".. on mix" → every bot uses a different emoji from a big mix
      //         ".. on ❤️🔥😍👏" → every bot picks one of these
      const rest = args.slice(2).join(' ');
      let emojis = /^(mix|random|all)$/i.test(rest.trim()) || !rest.trim() ? [...DEFAULT_MIX] : parseEmojis(rest);
      if (!emojis.length) emojis = [...DEFAULT_MIX];
      const emoji = emojis[0];
      if (isMain) {
        globalSet(channel.jid, { emoji, emojis, name: channel.name });
        // this bot starts right away; the others pick it up on their next sync (within ~2 min)
        try { require('../../utils/channelReact').startSync(sock); } catch (_) {}
        return extra.reply(
          `✅ *Channel auto-react ON — saare bots par*\n\n📣 Channel: *${channel.name}*\n🎭 Reactions: ${emojis.join(' ')}\n(har bot alag emoji lagayega)\n\n` +
          `Panel ka har connected bot channel ko follow karega aur har nayi post par apne number se 1 react lagayega.\n` +
          `⏱️ Naye bots ko 1–2 minute lagte hain.\n\nBand: \`.channelreact ${args[0]} off\``
        );
      }
      set(botId, channel.jid, { enabled: true, emoji, emojis, name: channel.name });
      try { require('../../utils/channelReact').startSync(sock); } catch (_) {}
      return extra.reply(`✅ *Channel auto-react ON*\n\n📣 *${channel.name}*\n🎭 ${emojis.join(' ')}\n(sirf is bot par)\n\nBand: \`.channelreact ${args[0]} off\``);
    } catch (error) {
      console.error('[channelreact] error:', error.message);
      return extra.reply(`❌ Channel auto-react setup failed: ${error.message}`);
    }
  },
};
