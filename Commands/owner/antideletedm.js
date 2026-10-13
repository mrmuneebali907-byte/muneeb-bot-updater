/**
 * .antideleteDM — PERSONAL chat anti-delete (per bot)
 *   .antideleteDM on | off | status     short: .addm  .adm
 * If someone deletes a message in a private chat with this bot's number, the deleted message
 * is sent privately to this bot's OWN chat ("Message yourself"). Default OFF. Other bots are not affected.
 */
const database = require('../../database');

module.exports = {
  name: 'antideletedm',
  aliases: ['addm', 'adm', 'antideldm'],
  description: 'Personal (DM) anti-delete on/off — deleted DM messages aapko mil jayenge',
  usage: '.antideleteDM on | off | status   (short: .addm on)',
  category: 'owner',
  ownerOnly: true,   // bot owner (who connected it) or main developer

  async execute(sock, msg, args, extra) {
    try {
      const botId = extra.botId || sock.user?.id;
      const on  = !!database.getBotSetting(botId, 'antidelete_dm', false);
      const opt = (args[0] || '').toLowerCase();

      if (['on', 'enable', '1', 'true'].includes(opt)) {
        database.setBotSetting(botId, 'antidelete_dm', true);
        return extra.reply('✅ *Anti-Delete DM ON*\nAb koi personal chat mein message delete karega to wo aapke apne chat (Message yourself) mein aa jayega.\n\n_Note: sirf ON hone ke baad aaye messages save hote hain._');
      }
      if (['off', 'disable', '0', 'false'].includes(opt)) {
        database.setBotSetting(botId, 'antidelete_dm', false);
        return extra.reply('❌ *Anti-Delete DM OFF*');
      }
      return extra.reply(
        `🗑️ *Anti-Delete (Personal/DM):* ${on ? 'ON ✅' : 'OFF ❌'}\n\n` +
        `📌 *Use:*\n` +
        `• .antideleteDM on   → short: .addm on\n` +
        `• .antideleteDM off  → short: .addm off\n` +
        `• .antideleteDM status → short: .addm\n\n` +
        `📝 *Example:* .addm on\n` +
        `_Group ke liye:_ .antidelete on  (short: .ad on)`
      );
    } catch (e) { await extra.reply(`❌ Error: ${e.message}`); }
  },
};
