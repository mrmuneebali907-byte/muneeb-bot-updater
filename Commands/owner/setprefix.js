/**
 * .setprefix — each bot has ITS OWN prefix.
 *   .setprefix !        → this bot now answers to "!"   (other bots are not touched)
 *   .setprefix reset    → back to the default prefix
 * The person who connected a bot (and the main developer) can change that bot's prefix.
 * The main developer's commands always work on every bot — with the default prefix, the bot's own prefix, or no prefix.
 */
const config   = require('../../config');
const database = require('../../database');

module.exports = {
  name: 'setprefix',
  aliases: ['prefix'],
  category: 'owner',
  description: 'Change THIS bot\'s command prefix (other bots keep theirs)',
  usage: '.setprefix <new prefix>  |  .setprefix reset',
  ownerOnly: true,   // bot owner (the one who connected it) or main developer

  async execute(sock, msg, args, extra) {
    try {
      const botId = extra.botId || sock.user?.id;
      const stored = database.getBotSetting(botId, 'prefix', null);
      const current = config.prefix;   // this bot's prefix (per-bot getter)

      if (args.length === 0) {
        return extra.reply(
          `📌 *Is bot ka prefix:* ${current}${stored ? '' : ' (default)'}\n\n` +
          `Badalne ke liye: .setprefix <naya prefix>\nDefault pe wapas: .setprefix reset\n\n` +
          `_Sirf isi bot ka prefix badlega, doosre bots ka nahi._`
        );
      }

      const val = args[0];
      if (['reset', 'default'].includes(val.toLowerCase())) {
        database.updateBotSettings(botId, { prefix: null });
        return extra.reply(`✅ Is bot ka prefix default pe wapas aa gaya.\nAb commands: ${config.prefix}command`);
      }

      if (val.length > 3) return extra.reply('❌ Prefix 1-3 characters ka hona chahiye!');
      if (/\s/.test(val)) return extra.reply('❌ Prefix mein space nahi ho sakta.');

      database.updateBotSettings(botId, { prefix: val });
      await extra.reply(`✅ *Is bot ka prefix:* ${val}\n\nAb commands: ${val}command\n_(Sirf yahi bot badla hai, baaki bots ka prefix wahi hai jo pehle tha.)_`);
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
