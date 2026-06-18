'use strict';

/**
 * .ok @user — Accept / verify a pending user in the Anti-Fake system.
 *
 * adminOnly: true  → handler.js does the owner/admin check with full LID support.
 *                    Owner (923329838699) always allowed. Non-admin non-owner blocked.
 */

const config = require('../../config');
const { isPending, removePending } = require('../../utils/antifakeState');

module.exports = {
  name: 'ok',
  aliases: ['verify', 'afaccept', 'accept', 'afok'],
  category: 'admin',
  description: 'Accept and verify a pending user (Anti-Fake system)',
  usage: '.ok @user',
  groupOnly: true,
  adminOnly: true,   // handler.js checks — owner bypass built in, LID-aware

  async execute(sock, msg, args, extra) {
    const { from, sender } = extra;

    // ── Resolve mentioned users ─────────────────────────────────────────────
    const ctx       = msg.message?.extendedTextMessage?.contextInfo;
    const mentioned = ctx?.mentionedJid || [];

    if (mentioned.length === 0) {
      return await sock.sendMessage(from, {
        text: `👤 Kise verify karna hai? Mention karo:\n*.ok @user*`
      });
    }

    const actorNum = sender.split('@')[0].split(':')[0];

    for (const userJid of mentioned) {
      const userNum = userJid.split('@')[0].split(':')[0];

      if (!isPending(from, userJid)) {
        await sock.sendMessage(from, {
          text: `ℹ️ @${userNum} antifake verification queue mein nahi hai.`,
          mentions: [userJid]
        });
        continue;
      }

      removePending(from, userJid);

      await sock.sendMessage(from, {
        text:
`✅ *Verification Complete!*
━━━━━━━━━━━━━━━━━━━━
👤 User: @${userNum}
🛡️ Verified by: @${actorNum}

🎉 @${userNum} ko verify kar diya gaya hai! Welcome to the group!
Ab aap freely message kar sakte hain. 🎊

> Powered by ${config.botName}`,
        mentions: [userJid, sender]
      });
    }
  }
};
