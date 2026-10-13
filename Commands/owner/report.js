/**
 * .report — report a spammer: BLOCK him, then send 10 reports (first now, then one every minute).
 *   group  : reply to his message with  .report
 *   private: send .report in his chat   (or .report 923xxxxxxxxx)
 * Short: .rp  .rep        Example: (reply to spam) .rp
 */
const config = require('../../config');
const ct = require('../../utils/contactTools');

module.exports = {
  name: 'report',
  aliases: ['rp', 'rep', 'spamreport'],
  category: 'owner',
  description: 'Banda spam kare to block + 10 report (har 1 minute baad)',
  usage: '.report (spam message par reply)  |  .report 923xxxxxxxxx',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const t = await ct.resolve(sock, msg, args);
      if (!t) return extra.reply('⚠️ Spammer ke *message par reply* karke likho: *.report*\n(short: .rp)\nPersonal me us ki chat me hi *.rp* likh do.');
      if (ct.isProtected(sock, t, config)) return extra.reply('⚠️ Yeh aapka apna / owner ka number hai, report nahi karunga.');

      if (!ct.reserve(sock, t)) return extra.reply(`⏳ +${t.digits} par report *pehle se chal rahi hai*, poori hone do.`);
      await extra.reply(`🚨 *Report shuru*\n👤 +${t.digits}\n📨 10 report: abhi pehli, phir har 1 minute baad (~9 min)\n🚫 Block bhi saath me ho raha hai...`).catch(() => {});
      setImmediate(async () => {
        let blocked = true, why = '';
        try { await ct.blockUser(sock, t); } catch (e) { blocked = false; why = String(e?.message || e).slice(0, 100); console.log('[REPORT] block failed:', why); }
        await sock.sendMessage(extra.from, { text: blocked ? `🚫 +${t.digits} *block ho gaya ✅*` : `⚠️ Block nahi hua: ${why}` }).catch(() => {});
        ct.reportCampaign(sock, t, {
          reserved: true,
          onDone: (st) => sock.sendMessage(extra.from, {
            text: `📊 *Report complete* — +${t.digits}\n✅ Gayi: ${st.ok}/${st.times}${st.fail ? `\n⚠️ Fail: ${st.fail}${st.lastErr ? `\n_${st.lastErr}_` : ''}` : ''}`,
          }).catch(() => {}),
        });
      });
    } catch (e) {
      console.error('[report]', e?.message || e);
      return extra.reply(`❌ Report nahi hui: ${String(e?.message || e).slice(0, 120)}`);
    }
  },
};
