/**
 * .save — save a person's number in this bot's WhatsApp contacts with HIS profile name
 *   group  : reply to any member's message with  .save            (or .save Custom Name)
 *   private: send .save in the chat (or reply)                      (or .save Custom Name)
 * Short: .sv  .savecontact        Example: (reply to a member) .sv
 */
const config = require('../../config');
const ct = require('../../utils/contactTools');
const mafia = require('../../utils/mafiaGame');

module.exports = {
  name: 'save',
  aliases: ['sv', 'savecontact', 'savenum', 'protect'],
  category: 'owner',
  description: 'Reply wale banday ka number uske profile naam se save karo',
  usage: '.save (kisi ke message par reply)  |  .save <custom naam>',
  // owner check is done inside (the Mafia game's Doctor also uses .save in DM)

  async execute(sock, msg, args, extra) {
    try {
      // ── Mafia Doctor (private chat, player of a running game) keeps working exactly as before ──
      const dig = (j) => String(j || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      if (!extra.isGroup && mafia.playerPhoneMap.has(dig(extra.sender)) && (!extra.isOwner || (args || []).length)) {
        const res = await mafia.nightSave(sock, extra.sender, args, msg);
        if (!res.ok) return extra.reply(`❌ ${res.error}`);
        return;
      }
      if (!extra.isOwner) return extra.reply('❌ Yeh command sirf *owner* ke liye hai.');

      const m = msg.message?.ephemeralMessage?.message || msg.message || {};
      const hasReply = !!(m.extendedTextMessage?.contextInfo?.quotedMessage);
      const isGroup = String(extra.from).endsWith('@g.us');
      if (isGroup && !hasReply && !(m.extendedTextMessage?.contextInfo?.mentionedJid || []).length) {
        return extra.reply('⚠️ Group me kisi member ke *message par reply* karke likho: *.save*\n(short: .sv)\n\n📝 Example: us ke message par reply → .sv\nCustom naam: .sv Ali Bhai');
      }
      // args may contain a custom name; digits-only args are treated as a number by resolve()
      const t = await ct.resolve(sock, msg, hasReply || !isGroup ? [] : args);
      if (!t) return extra.reply('❌ Banda detect nahi hua. Message par reply karo.');
      let custom = (args || []).join(' ').trim();
      if (/^[+\d\s-]{8,}$/.test(custom)) custom = '';
      if (!t.pn) return extra.reply('❌ Is banday ka asli number WhatsApp ne abhi hide rakha hai (privacy ID), isliye save nahi ho sakta. Thodi der baad dobara try karo.');
      if (ct.isProtected(sock, t, config)) return extra.reply('⚠️ Yeh aapka apna / owner ka number hai.');
      const name = custom || t.name;
      if (!name) {
        return extra.reply(`⚠️ Is banday ka profile naam abhi bot ne nahi dekha.\nNaam khud likho: *.save Ali Bhai*\n(Number: +${t.digits})`);
      }
      const saved = await ct.saveContact(sock, t, name);
      return extra.reply(`✅ *Contact save ho gaya*\n👤 ${saved}\n📞 +${t.digits}`);
    } catch (e) {
      console.error('[save]', e?.message || e);
      return extra.reply(`❌ Save nahi hua: ${String(e?.message || e).slice(0, 120)}`);
    }
  },
};
