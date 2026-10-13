'use strict';
/**
 * .antiuserbot on | off | status
 * Removes real bot accounts only (see utils/antiUserbot.js). Normal members are never touched.
 */
const database = require('../../database');

module.exports = {
  name          : 'antiuserbot',
  aliases       : ['antibots', 'antibot2'],
  category      : 'admin',
  description   : 'Remove other bots / userbots from the group',
  usage         : '.antiuserbot on | .antiuserbot off',
  groupOnly     : true,
  adminOnly     : true,
  botAdminNeeded: false,

  async execute(sock, msg, args, extra) {
    const { from, reply, isBotAdmin } = extra;
    const gs  = database.getGroupSettings(from);
    const opt = (args[0] || '').toLowerCase();

    if (opt === 'on') {
      database.updateGroupSettings(from, { antiuserbot: true });
      return reply(`✅ *Anti-UserBot ON*` + (isBotAdmin ? '' : `\n\n⚠️ Bot admin nahi hai — admin banao warna bots remove nahi honge.`));
    }
    if (opt === 'off') {
      database.updateGroupSettings(from, { antiuserbot: false });
      return reply(`❌ *Anti-UserBot OFF*`);
    }
    return reply(`🛡️ Anti-UserBot: *${gs.antiuserbot ? 'ON ✅' : 'OFF ❌'}*\n\n.antiuserbot on\n.antiuserbot off`);
  }
};
