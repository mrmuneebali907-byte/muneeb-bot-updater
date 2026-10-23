/**
 * .greeting on/off — Salam / Hi-Hello auto-replies (utils/islamicGreeting.js)
 *   group  : .greeting off          → sirf is group mein band      (group admin / owner)
 *   DM     : .greeting off          → private chats mein band      (owner)
 *   sab    : .greeting off all      → is bot ke SAB chats mein band (owner)
 */
const database = require('../../database');
const ig = require('../../utils/islamicGreeting');

module.exports = {
  name: 'greeting',
  aliases: ['islamicgreeting', 'salamreply', 'hireply', 'greet'],
  description: 'Salam / Hi-Hello auto-reply on/off',
  usage: '.greeting on | off | off all',
  category: 'admin',

  async execute(sock, msg, args, extra) {
    try {
      const sub = (args[0] || '').toLowerCase();
      const scope = (args[1] || '').toLowerCase();
      const botId = String(sock?.user?.id || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || 'default';
      const isGroup = !!extra.isGroup;

      if (sub !== 'on' && sub !== 'off') {
        const all = database.getBotSetting(botId, 'islamicGreetingAll', true) !== false;
        const here = ig.isEnabled(sock, extra.from);
        return extra.reply(
          `🤲 *Greeting Replies* (Salam / Hi-Hello)\n\n` +
          `▸ Is chat mein : *${here ? '✅ ON' : '❌ OFF'}*\n` +
          `▸ Poore bot mein: *${all ? '✅ ON' : '❌ OFF'}*\n\n` +
          `• *.greeting off* — is ${isGroup ? 'group' : 'chat'} mein band\n` +
          `• *.greeting on* — wapas chalu\n` +
          `• *.greeting off all* — is bot ke sab chats mein band (owner)\n` +
          `• *.greeting on all* — sab jagah chalu (owner)`
        );
      }
      const on = sub === 'on';

      if (scope === 'all') {
        if (!extra.isOwner) return extra.reply('👑 *all* sirf bot owner kar sakta hai.');
        database.setBotSetting(botId, 'islamicGreetingAll', on);
        return extra.reply(on ? '✅ Greeting replies poore bot mein *ON*' : '🙅 Greeting replies poore bot mein *OFF* (kisi chat mein nahi aayenge)');
      }
      if (isGroup) {
        if (!extra.isAdmin && !extra.isOwner) return extra.reply('🛡️ Ye sirf group admin ya owner kar sakta hai.');
        database.updateGroupSettings(extra.from, { islamicGreeting: on });
        return extra.reply(on ? '✅ Is group mein Salam/Hi-Hello replies *ON*' : '🙅 Is group mein Salam/Hi-Hello replies *OFF*');
      }
      if (!extra.isOwner) return extra.reply('👑 Ye sirf bot owner kar sakta hai.');
      database.setBotSetting(botId, 'islamicGreetingDM', on);
      return extra.reply(on ? '✅ Private chats mein replies *ON*' : '🙅 Private chats mein replies *OFF*');
    } catch (e) {
      console.error('[greeting]', e.message);
      return extra.reply('❌ Error aaya, dobara try karo.');
    }
  },
};
