/**
 * EmojiRoast — group par koi sirf ek emoji bheje to bot funny roast reply deta hai.
 * Har group apna switch rakhta hai (default ON).
 */
const database = require('../../database');
const er = require('../../utils/emojiRoast');

module.exports = {
  name: 'emojiroast',
  aliases: ['roastemoji', 'emojireply', 'er'],
  description: 'Emoji roast replies on/off karo + apne roast add karo (is group ke liye)',
  usage: '.emojiroast on/off | add 🍕 reply | remove 🍕 | list',
  category: 'admin',
  groupOnly: true,
  adminOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const from = extra.from;
      const sub = (args[0] || '').toLowerCase();
      const gs = database.getGroupSettings(from);
      const on = gs.emojiRoast !== false;
      const cust = { ...(gs.emojiRoastCustom || {}) };

      if (sub === 'on' || sub === 'off') {
        database.updateGroupSettings(from, { emojiRoast: sub === 'on' });
        return extra.reply(sub === 'on'
          ? '🔥 *Emoji Roast ON* — ab koi sirf emoji bhejega to funny roast aayega 😎'
          : '🙅 *Emoji Roast OFF* — is group mein emoji par ab koi roast reply nahi aayega.');
      }

      if (sub === 'add') {
        const emoji = er.norm(args[1]);
        const text = args.slice(2).join(' ').trim();
        if (!emoji || emoji.length > 12 || !text) return extra.reply('Usage: *.emojiroast add 🍕 tumhari line*\n_@tag ke liye {n} likho (optional)_');
        const line = text.includes('{n}') ? text : '{n} ' + text;
        cust[emoji] = [...(cust[emoji] || []), line].slice(-10);
        database.updateGroupSettings(from, { emojiRoastCustom: cust });
        return extra.reply(`✅ ${emoji} ke liye roast add ho gaya (is group mein ye default se pehle chalega).`);
      }

      if (sub === 'remove' || sub === 'del') {
        const emoji = er.norm(args[1]);
        if (!emoji || !cust[emoji]) return extra.reply('❌ Is emoji ka koi custom roast nahi hai. *.emojiroast list* dekho.');
        delete cust[emoji];
        database.updateGroupSettings(from, { emojiRoastCustom: cust });
        return extra.reply(`🗑️ ${emoji} ke custom roast hata diye (default wapas chalega).`);
      }

      if (sub === 'list') {
        const keys = Object.keys(cust);
        return extra.reply(keys.length
          ? `📝 *Custom roasts:*\n${keys.map(k => `${k} — ${cust[k].length} line`).join('\n')}`
          : '📝 Is group mein koi custom roast nahi hai.\nAdd karo: *.emojiroast add 🍕 line*');
      }

      return extra.reply(
        `🔥 *Emoji Roast* : ${on ? '✅ ON' : '❌ OFF'}\n` +
        `😂 ${er.count()} emojis ke funny replies built-in\n\n` +
        `• *.emojiroast on* / *off*\n` +
        `• *.emojiroast add 🍕 tumhari line*\n` +
        `• *.emojiroast remove 🍕*\n` +
        `• *.emojiroast list*`
      );
    } catch (e) {
      console.error('[emojiroast]', e.message);
      return extra.reply('❌ Error aaya, dobara try karo.');
    }
  },
};
