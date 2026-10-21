'use strict';

const { isAutoStatusEnabled, isStatusReactEnabled, setAutoStatus, setStatusReact, getStatusEmojis, setStatusEmojis, parseEmojis } = require('../../utils/autostatusConfig');

module.exports = {
  name       : 'autostatus',
  aliases    : ['statusview', 'autoview'],
  category   : 'owner',
  description: 'Toggle automatic status viewing and reactions (per-bot isolated)',
  usage      : '.autostatus on/off',
  ownerOnly  : true,

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;
    const botId  = String(sock?.user?.id || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || null;

    const safeReply = async (text) => {
      if (extra && typeof extra.reply === 'function') return extra.reply(text);
      return sock.sendMessage(chatId, { text }, { quoted: msg });
    };

    try {
      const cmd = (args[0] || '').toLowerCase();
      const sub = (args[1] || '').toLowerCase();

      if (!cmd || !['on', 'off', 'react', 'emoji'].includes(cmd)) {
        const viewStatus  = isAutoStatusEnabled(botId)  ? '✅ ON' : '❌ OFF';
        const reactStatus = isStatusReactEnabled(botId) ? '✅ ON' : '❌ OFF';
        const em = getStatusEmojis(botId);
        const emText = !em.length ? '👀 (default)' : (em[0] === 'random' ? '🎲 random' : em.join(' '));
        return safeReply(
          `📱 *Auto Status Settings*\n\n` +
          `▸ Auto View  : *${viewStatus}*\n` +
          `▸ Auto React : *${reactStatus}*\n` +
          `▸ React emoji: *${emText}*\n\n` +
          `Commands:\n` +
          `• *.autostatus on*        — Enable auto view\n` +
          `• *.autostatus off*       — Disable auto view\n` +
          `• *.autostatus react on*  — Enable 👀 reactions\n` +
          `• *.autostatus react off* — Disable reactions\n` +
          `• *.autostatus react 🔥* — apni marzi ka emoji (react bhi ON ho jata hai)\n` +
          `• *.autostatus react 🔥 ❤️ 😂* — kai emoji, har status par random ek\n` +
          `• *.autostatus react random* — alag alag emoji\n` +
          `• *.autostatus react default* — wapas 👀\n\n` +
          `> *Powered by 🥀𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 🌴*`
        );
      }

      if (cmd === 'on') {
        setAutoStatus(true, botId);
        return safeReply(`✅ *Auto Status View: ENABLED*\n\nBot will now automatically view all contact statuses.\n\n> *Powered by 🥀𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 🌴*`);
      }

      if (cmd === 'off') {
        setAutoStatus(false, botId);
        return safeReply(`❌ *Auto Status View: DISABLED*\n\nBot will no longer view statuses automatically.\n\n> *Powered by 🥀𝐌𝐫.𝐌𝐮𝐧𝐞𝐞𝐛 𝐀𝐥𝐢 🌴*`);
      }

      if (cmd === 'react') {
        if (!sub) return safeReply('Usage: .autostatus react on/off  |  .autostatus react 🔥 ❤️  |  .autostatus react random');
        if (sub !== 'on' && sub !== 'off') {
          const list = parseEmojis(args.slice(1).join(' '));
          if (list === null) return safeReply('❌ Emoji samajh nahi aaya. Example: *.autostatus react 🔥 ❤️*');
          setStatusEmojis(list, botId);
          setStatusReact(true, botId);
          const t = !list.length ? '👀' : (list[0] === 'random' ? '🎲 random emojis' : list.join(' '));
          return safeReply(`✅ *Status React ON* — ab har status par: ${t}`);
        }
        setStatusReact(sub === 'on', botId);
        const em = getStatusEmojis(botId);
        const shown = !em.length ? '👀' : (em[0] === 'random' ? '🎲 random' : em.join(' '));
        return safeReply(
          sub === 'on'
            ? `✅ *Status Reactions: ENABLED* — Bot ${shown} react karega.`
            : `❌ *Status Reactions: DISABLED*`
        );
      }

      if (cmd === 'emoji') return safeReply('Emoji badalne ke liye: *.autostatus react 🔥 ❤️*');

    } catch (err) {
      console.error('[AUTOSTATUS] Error:', err.message);
      await safeReply('❌ Error processing autostatus command. Please try again.');
    }
  },
};
