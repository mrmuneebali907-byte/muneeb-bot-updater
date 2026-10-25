/**
 * .emojifight — koi sirf emoji bheje to bot bhi emoji se jawab de (is group ke liye)
 */
const ef = require('../../utils/emojiFight');

module.exports = {
  name: 'emojifight',
  aliases: ['emojiwar', 'emojilado', 'ef'],
  description: 'Emoji ka jawab emoji se (emoji fight) on/off — emoji roast ke saath ek time par ek hi chalta hai',
  usage: '.emojifight on | off',
  category: 'owner',
  groupOnly: true,
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'on') {
        ef.setOn(extra.from, true);
        return extra.reply('⚔️ *Emoji Fight ON*\nAb koi sirf emoji bhejega to bot bhi emoji se jawab dega 😎\n\n🔥 _Emoji Roast apne aap OFF ho gaya (dono ek saath nahi chalte)._');
      }
      if (sub === 'off') {
        ef.setOn(extra.from, false);
        return extra.reply('🕊️ *Emoji Fight OFF*\nEmoji ka jawab ab nahi aayega.\n_Emoji Roast wapas chahiye to: *.emojiroast on*_');
      }
      return extra.reply(
        `⚔️ *Emoji Fight*: ${ef.isOn(extra.from) ? '✅ ON' : '❌ OFF'}\n🔥 Emoji Roast: ${ef.roastOn(extra.from) ? '✅ ON' : '❌ OFF'}\n\n` +
        '*.emojifight on*  — emoji ke badle emoji\n*.emojifight off*\n\n_Ek time par ek hi chalta hai: fight ON → roast OFF, roast ON → fight OFF._');
    } catch (e) {
      console.error('[emojifight]', e.message);
      return extra.reply('❌ Error aaya.');
    }
  },
};
