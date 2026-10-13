/**
 * .autosave on|off — new private-chat senders are saved automatically with their profile name (per bot).
 * Short: .as  .asave        Example: .autosave off
 */
const database = require('../../database');
module.exports = {
  name: 'autosave',
  aliases: ['asave', 'autosavedm'],
  category: 'owner',
  description: 'Personal chat me naye banday ka number uske profile naam se auto-save',
  usage: '.autosave on | off | status',
  ownerOnly: true,
  async execute(sock, msg, args, extra) {
    const botId = extra.botId || sock.user?.id;
    const opt = (args[0] || '').toLowerCase();
    if (['on', '1', 'true', 'enable'].includes(opt)) { database.setBotSetting(botId, 'autosave_dm', true); return extra.reply('✅ *Auto-Save ON*\nAb jo bhi personal me message karega uska number uske profile naam se save ho jayega.'); }
    if (['off', '0', 'false', 'disable'].includes(opt)) { database.setBotSetting(botId, 'autosave_dm', false); return extra.reply('❌ *Auto-Save OFF*'); }
    const on = !!database.getBotSetting(botId, 'autosave_dm', true);
    return extra.reply(`📇 *Auto-Save:* ${on ? 'ON ✅' : 'OFF ❌'}\n\n• .autosave on / off\n• Example: .autosave off\n_Manual save:_ .save (reply)`);
  },
};
