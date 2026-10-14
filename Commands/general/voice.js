/**
 * .voice on|off|status — Voice Bot mode for the current chat.
 * ON: jo bhi is chat mein voice note bheje, bot usse sunkar (speech-to-text) AI se samajhta hai
 *     aur jawab voice note mein deta hai. Group mein sirf bot ke message par reply kiye gaye voice note ka jawab.
 * Short: .vb  .voicebot        Example: .voice on
 * Group mein sirf admin/owner on-off kar sakte hain; personal chat mein koi bhi.
 */
const database = require('../../database');

module.exports = {
  name: 'voice',
  aliases: ['voicebot', 'vb'],
  category: 'general',
  description: 'Voice bot — voice note bhejo, bot voice mein jawab de',
  usage: '.voice on | off | status',
  async execute(sock, msg, args, extra) {
    const from = extra.from || msg.key.remoteJid;
    const botId = extra.botId || sock.user?.id;
    const key = `voicebot_${from}`;
    const opt = String(args[0] || '').toLowerCase();

    const isOn = !!database.getBotSetting(botId, key, false);
    const where = from.endsWith('@g.us') ? 'is group' : 'is chat';

    if (!opt || ['status', 'check'].includes(opt)) {
      return extra.reply(
        `🎙️ *Voice Bot:* ${isOn ? 'ON ✅' : 'OFF ❌'} (${where} mein)\n\n` +
        `• ${extra.prefix || '.'}voice on — chalu\n• ${extra.prefix || '.'}voice off — band\n\n` +
        `_Voice note bhejo, bot voice note mein jawab dega.${from.endsWith('@g.us') ? ' Group mein bot ke kisi message par *reply* karke voice note bhejo.' : ''}_`
      );
    }

    const turnOn = ['on', '1', 'true', 'enable', 'start'].includes(opt);
    const turnOff = ['off', '0', 'false', 'disable', 'stop'].includes(opt);
    if (!turnOn && !turnOff) {
      return extra.reply(`❓ Aise likho: *${extra.prefix || '.'}voice on* ya *${extra.prefix || '.'}voice off*`);
    }

    if (from.endsWith('@g.us') && !extra.isAdmin && !extra.isOwner) {
      return extra.reply('🔒 Group mein voice bot sirf *admin* ya bot owner on/off kar sakta hai.');
    }

    database.setBotSetting(botId, key, turnOn);
    return extra.reply(turnOn
      ? `✅ *Voice Bot ON*\n🎙️ Ab ${where} mein voice note bhejo, main voice mein jawab dunga.${from.endsWith('@g.us') ? '\n_Group mein mere kisi message par reply karke voice note bhejna._' : ''}`
      : '❌ *Voice Bot OFF*');
  },
};
