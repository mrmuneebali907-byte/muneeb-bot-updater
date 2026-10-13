/**
 * .antidelete — GROUP anti-delete on/off (default ON, as before)
 *   .antidelete on | off | status      short: .ad  .adel  .antidel
 * When a member deletes a message the bot re-posts it in the group (admins/owner deleting are ignored).
 */
const database = require('../../database');

module.exports = {
  name: 'antidelete',
  aliases: ['ad', 'adel', 'antidel'],
  description: 'Group anti-delete on/off (deleted messages wapas dikhao)',
  usage: '.antidelete on | off | status   (short: .ad on)',
  category: 'admin',
  groupOnly: true,
  adminOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const gs  = database.getGroupSettings(extra.from);
      const on  = !gs.antiDeleteDisabled;
      const opt = (args[0] || '').toLowerCase();

      if (['on', 'enable', '1', 'true'].includes(opt)) {
        database.updateGroupSettings(extra.from, { antiDeleteDisabled: false });
        return extra.reply('✅ *Anti-Delete ON*\nAb is group mein koi member message delete karega to bot wapas dikha dega.');
      }
      if (['off', 'disable', '0', 'false'].includes(opt)) {
        database.updateGroupSettings(extra.from, { antiDeleteDisabled: true });
        return extra.reply('❌ *Anti-Delete OFF*\nAb deleted messages wapas nahi dikhaye jayenge.');
      }
      return extra.reply(
        `🗑️ *Anti-Delete (Group):* ${on ? 'ON ✅' : 'OFF ❌'}\n\n` +
        `📌 *Use:*\n` +
        `• .antidelete on   → short: .ad on\n` +
        `• .antidelete off  → short: .ad off\n` +
        `• .antidelete status → short: .ad\n\n` +
        `📝 *Example:* .ad off\n` +
        `_Personal chat ke liye:_ .antideleteDM on  (short: .addm on)`
      );
    } catch (e) { await extra.reply(`❌ Error: ${e.message}`); }
  },
};
