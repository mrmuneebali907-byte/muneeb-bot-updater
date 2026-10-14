/**
 * .left — bot is group ko pyaara sa good-bye bol kar chhod deta hai.
 * Sirf owner (bot owner ya Main Developer). Group mein hi chalta hai.
 * Aliases: .leave  .bye  .exitgroup
 * Note: Main Developer ke .left par us group ka sirf EK bot (leader) nikalta hai, baqi bots rehte hain.
 *       Bot ka apna owner .left chalaye to wohi bot nikalta hai.
 */
const config = require('../../config');

module.exports = {
  name: 'left',
  aliases: ['bye', 'exitgroup', 'leavegroup'],
  category: 'owner',
  description: 'Bot group ko good-bye bol kar left kar deta hai (owner only)',
  usage: '.left',
  ownerOnly: true,
  groupOnly: true,

  async execute(sock, msg, args, extra) {
    const from = msg.key.remoteJid;
    try {
      // Main Developer ke command par multiple bots ek saath na nikal jayein
      if (extra.isMainDeveloper && !extra.isConnectedOwner) {
        try {
          const leader = require('../../utils/groupLeader');
          if (!leader.isLeader(sock, from, extra.groupMetadata)) return;
        } catch (_) {}
      }

      let name = '';
      try { name = (extra.groupMetadata || await sock.groupMetadata(from))?.subject || ''; } catch (_) {}
      const bot = config.botName || 'Mr.Muneeb Ali Bot';

      await sock.sendMessage(from, {
        text:
          `👋 *Allah Hafiz${name ? ' — ' + name : ''}!*\n\n` +
          `Aap sab ke saath waqt bohat pyara guzra 🥹💐\n` +
          `Agar mujhse kabhi koi galti hui ho to maaf kar dena 🙏\n` +
          `Dua mein yaad rakhna, phir milenge InshaAllah ✨\n\n` +
          `> _${bot}_`,
      }, { quoted: msg });

      await new Promise(r => setTimeout(r, 2500));
      await sock.groupLeave(from);
    } catch (e) {
      console.error('[left]', e.message);
      try { await sock.sendMessage(from, { text: `❌ Group chhod nahi paya: ${e.message}` }, { quoted: msg }); } catch (_) {}
    }
  },
};
