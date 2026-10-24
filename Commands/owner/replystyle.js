/**
 * .replystyle — bot ke har reply ke upar user ki apni DP wala card (circle) lagao
 */
const rs = require('../../utils/replyStyle');

module.exports = {
  name: 'replystyle',
  aliases: ['rstyle', 'quotestyle', 'dpstyle'],
  description: 'Reply ke upar user ki DP wala card on/off + style chuno',
  usage: '.replystyle brand | neon | gold | royal | fire | matrix | off',
  category: 'owner',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const want = (args[0] || '').toLowerCase();
      if (want === 'label') {
        const text = args.slice(1).join(' ').trim();
        if (/^(reset|default)$/i.test(text)) { rs.setLabel(sock, ''); return extra.reply('✅ Label default par aa gaya:\n' + rs.getLabel(sock)); }
        if (!text) return extra.reply(`🏷️ Abhi card par likha hai:\n${rs.getLabel(sock, extra.botName || 'Mr.Muneeb Ali Bot')}\n\nBadalne ke liye:\n*.replystyle label Naam | Doosri line*\nWapas default: *.replystyle label reset*`);
        rs.setLabel(sock, text); return extra.reply(`✅ Label set:\n${rs.getLabel(sock)}`);
      }
      if (want === 'size' || want === 'thumb') {
        const v = parseFloat(String(args[1] || '').replace(',', '.'));
        if (!(v >= 5 && v <= 20)) return extra.reply(`📏 Card thumbnail limit abhi: *${rs.getThumbKB(sock)} KB*\n\nAgar DP *khali / gayab* dikhe to ye chhota karo: *.replystyle size 8*\nAgar saaf nahi hai aur DP dikh rahi hai to dheere dheere badhao: *.replystyle size 14*, *16*...\n(5 se 20 tak, default 11)`);
        rs.setThumbKB(sock, v);
        return extra.reply(`✅ Thumbnail limit: *${v} KB*. Naya card dikhne me kuch minute lag sakte hain (purana cache me rehta hai) — ya bot restart karo.`);
      }
      if (want === 'shape') {
        const v = (args[1] || '').toLowerCase();
        if (v !== 'square' && v !== 'tall') return extra.reply(`🔲 Card ka shape abhi: *${rs.getShape(sock)}*\n\n*.replystyle shape square* — chauras (default, pakka dikhta hai)\n*.replystyle shape tall* — lamba 4:5 (kinare nahi katte, par kuch phones par nahi dikhta)`);
        rs.setShape(sock, v);
        return extra.reply(`✅ Card shape: *${v}*.`);
      }
      if (want === 'zoom') {
        const v = parseFloat(String(args[1] || '').replace(',', '.'));
        if (!(v >= 1 && v <= 1.8)) return extra.reply(`🔍 DP zoom abhi: *${rs.getZoom(sock)}*\n\n*.replystyle zoom 1.0* — poori photo\n*.replystyle zoom 1.35* — default (chehra bada)\n*.replystyle zoom 1.6* — bahut close-up\n(1.0 se 1.8 tak)`);
        rs.setZoom(sock, v);
        return extra.reply(`✅ DP zoom: *${v}* — gol card me chehra ${v > 1.35 ? 'aur bada' : v < 1.35 ? 'thoda chhota' : 'default size'} dikhega.`);
      }
      if (want === 'cardmode' || want === 'mode') {
        const v = (args[1] || '').toLowerCase();
        if (v !== 'full' && v !== 'ring') return extra.reply(`🖼️ Card ka look abhi: *${rs.getCardMode(sock)}*\n\n*.replystyle cardmode ring* — gol DP + chamakti ring (default)\n*.replystyle cardmode full* — DP poore card me`);
        rs.setCardMode(sock, v);
        return extra.reply(v === 'full' ? '✅ Card: *full* — DP poore card me, sabse saaf.' : '✅ Card: *ring* — gol DP ring ke andar.');
      }
      if (want === 'header') {
        const v = (args[1] || '').toLowerCase();
        if (v !== 'bot' && v !== 'user') return extra.reply(`🪪 Card ke upar wali line abhi: *${rs.getHeader(sock)}*\n\n*.replystyle header bot* — bot ka naam (number nahi dikhta)\n*.replystyle header user* — command dene wale ka naam / number`);
        rs.setHeader(sock, v);
        return extra.reply(v === 'bot' ? '✅ Header: *bot* — ab card ke upar number nahi, bot ka naam dikhega.' : '✅ Header: *user* — ab command dene wale ka naam / number dikhega.');
      }
      const cur = rs.getStyle(sock);
      if (!want || !rs.STYLES.includes(want)) {
        return extra.reply(
          `🎴 *Reply Style*  — abhi: *${cur}*\n` +
          `🔧 Hook: ${sock.__rsInstalled ? '✅ chalu' : '❌ band — handler.js purani hai, naya handler.js daalo + .restart'}\n\n` +
          `⭐ *Stylish DP cards* (user ki DP, na mile to owner ki DP):\n` +
          `• *.replystyle brand*  — crimson + gold 👑\n` +
          `• *.replystyle neon*   — cyan/pink ⚡\n` +
          `• *.replystyle gold*   — black + gold 👑\n` +
          `• *.replystyle royal*  — purple 💎\n` +
          `• *.replystyle fire*   — orange 🔥\n` +
          `• *.replystyle matrix* — green ⭐\n` +
          `• *.replystyle label Naam | Line2* — card ka text (reset = default)\n` +
          `• *.replystyle header bot|user* — upar number ya bot ka naam\n` +
          `• *.replystyle zoom 1.0-1.8* — gol card me chehra kitna bada dikhe\n` +
          `• *.replystyle cardmode ring|full* — gol ring (default) ya poori photo\n` +
          `• *.replystyle size 5-20* — thumbnail KB limit (DP khali dikhe to chhota karo)\n` +
          `• *.replystyle shape square|tall* — chauras (pakka) ya lamba\n\n` +
          `Purane styles:\n` +
          `• *.replystyle circle*  — payment-request jaisa card\n` +
          `• *.replystyle payment* — payment-note card\n` +
          `• *.replystyle contact* — contact card (DP + naam)\n` +
          `• *.replystyle order*   — order card\n` +
          `• *.replystyle off*     — normal reply\n\n` +
          `_Har style WhatsApp ke version par thoda alag dikh sakta hai — jo pasand aaye wo rakho._`
        );
      }
      rs.setStyle(sock, want);
      if (!sock.__rsInstalled) return extra.reply('⚠️ Style save ho gaya, par *handler.js purani hai* — isliye card nahi dikhega. Naya handler.js replace karo aur *.restart* karo.');
      return extra.reply(want === 'off' ? '✅ Reply style *OFF* — normal reply.' : `✅ Reply style *${want}* set — ab ye command chala ke dekho (replies ke upar DP card dikhega).`);
    } catch (e) {
      console.error('[replystyle]', e.message);
      return extra.reply('❌ Error aaya, dobara try karo.');
    }
  },
};
