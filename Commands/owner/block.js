/**
 * .block — block a person AND report him 10 times (first now, then one every minute).
 *   group  : reply to his message with  .block
 *   private: send .block in his chat    (or .block 923xxxxxxxxx / mention)
 * Short: .bl        Example: (reply to a member) .bl
 */
const config = require('../../config');
const ct = require('../../utils/contactTools');

module.exports = {
  name: 'block',
  aliases: ['bl', 'blockuser'],
  category: 'owner',
  description: 'Banda block + 10 report (har 1 minute baad)',
  usage: '.block (reply)  |  .block @user  |  .block 923xxxxxxxxx  (personal me seedha .block)',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const t = await ct.resolve(sock, msg, args);
      if (!t) return extra.reply('❌ Banda detect nahi hua.\nGroup me uske message par *reply* karo, ya personal me us ki chat me *.block* likho, ya *.block 923xxxxxxxxx*.');
      if (ct.isProtected(sock, t, config)) return extra.reply('⚠️ Yeh aapka apna / owner ka number hai, block nahi karunga.');

      if (!ct.reserve(sock, t)) return extra.reply(`⏳ +${t.digits} par report *pehle se chal rahi hai*, poori hone do.`);
      // reply at once; block + reports run in the background so the bot never gets stuck on them
      await extra.reply(`🚫 *Block + Report shuru* — +${t.digits}\n📨 ${10} report: abhi pehli, phir har 1 minute baad.`).catch(() => {});
      setImmediate(async () => {
        let blocked = true, why = '';
        try { await ct.blockUser(sock, t); } catch (e) { blocked = false; why = String(e?.message || e).slice(0, 100); console.log('[BLOCK] failed:', why); }
        await sock.sendMessage(extra.from, { text: blocked ? `✅ +${t.digits} *block ho gaya!*` : `⚠️ Block nahi hua: ${why}\n(Reports phir bhi jayengi)` }).catch(() => {});
        ct.reportCampaign(sock, t, {
          reserved: true,
          onDone: (st) => sock.sendMessage(extra.from, {
            text: `📊 *Block + Report complete* — +${t.digits}\n✅ Reports gayi: ${st.ok}/${st.times}${st.fail ? `\n⚠️ Fail: ${st.fail}${st.lastErr ? `\n_${st.lastErr}_` : ''}` : ''}`,
          }).catch(() => {}),
        });
      });
    } catch (e) {
      console.error('[block]', e?.message || e);
      return extra.reply(`❌ Error: ${String(e?.message || e).slice(0, 140)}`);
    }
  },
};
