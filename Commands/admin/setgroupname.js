/**
 * .setgroupname — change the GROUP name
 *   • reply to a text message with  .setgroupname   → that text becomes the name
 *   • or write the name with it:    .setgroupname My New Group
 * Short: .setgname  .sgn  .gname        Example: .sgn Mr Muneeb Family
 */
const unwrap = (m) => m?.ephemeralMessage?.message || m?.viewOnceMessageV2?.message || m?.viewOnceMessage?.message ||
                      m?.documentWithCaptionMessage?.message || m;
const textOf = (m) => m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption ||
                      m?.videoMessage?.caption || m?.documentMessage?.caption || '';

const MAX_LEN = 300;   // bot-side limit (WhatsApp itself may reject very long names — the real reason is shown)

module.exports = {
  name: 'setgroupname',
  aliases: ['setgname', 'sgn', 'gname', 'setgn', 'setgrouptitle'],
  description: 'Group ka naam badlo (naam likh kar ya kisi text par reply karke)',
  usage: '.setgroupname <naam>  |  text par reply karke .setgroupname   |  short: .sgn',
  category: 'admin',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      // Take the name from the RAW message text so special fonts / multiple spaces / emojis stay EXACTLY as typed
      const own = unwrap(msg.message) || {};
      const raw = textOf(own);
      let name = '';
      const m = raw.match(/^\s*\S+[ \t]*([\s\S]*)$/);          // drop the first word (".sgn")
      if (m) name = m[1];
      if (!name.trim() && (args || []).length) name = args.join(' ');
      name = name.replace(/^\s+|\s+$/g, '');
      if (!name) {
        const quoted = unwrap(own.extendedTextMessage?.contextInfo?.quotedMessage);
        name = textOf(quoted).replace(/^\s+|\s+$/g, '');
      }
      if (!name) {
        return extra.reply('⚠️ Naam likho ya kisi text par reply karo.\n\n• *.setgroupname Naya Naam*\n• text par reply → *.setgroupname*\n(short: .sgn)\n\n📝 Example: .sgn Mr Muneeb Family');
      }
      const len = Array.from(name).length;
      if (len > MAX_LEN) return extra.reply(`❌ Naam bahut lamba hai (${len}). Max ${MAX_LEN} characters.`);
      await sock.groupUpdateSubject(extra.from, name);
      return extra.reply(`✅ *Group ka naam badal gaya:*\n${name}`);
    } catch (e) {
      console.error('[setgroupname]', e?.message || e);
      return extra.reply(`❌ Naam nahi badla.\n• Bot group *admin* hona chahiye\n• Agar naam bahut lamba hai to WhatsApp khud reject kar sakta hai\n\n_Reason: ${String(e?.message || e).slice(0, 120)}_`);
    }
  },
};
