'use strict';

/**
 * .ok @user — Accept / verify a pending user in the Anti-Fake system.
 *
 * adminOnly: true  → handler.js does the owner/admin check with full LID support.
 *                    Owner is always allowed. Non-admin non-owner blocked.
 */

const config = require('../../config');
const { getPending, removePending, findKey } = require('../../utils/antifakeState');
const perm = require('../lib/perm');

module.exports = {
  name: 'ok',
  aliases: ['verify', 'afaccept', 'accept', 'afok'],
  category: 'admin',
  description: 'Accept and verify a pending user (Anti-Fake system)',
  usage: '.ok @user  |  reply to their message with .ok  |  .ok all',
  groupOnly: true,
  adminOnly: true,   // handler.js checks — owner bypass built in, LID-aware

  async execute(sock, msg, args, extra) {
    const { from, sender } = extra;
    const ctx = msg.message?.extendedTextMessage?.contextInfo;

    // targets: @mentions, or the person whose message is replied to, or "all"
    let targets = [...(ctx?.mentionedJid || [])];
    if (!targets.length && ctx?.participant) targets = [ctx.participant];

    const pendingMap = getPending(from);
    if ((args[0] || '').toLowerCase() === 'all') targets = [...pendingMap.keys()];

    if (!targets.length) {
      return await sock.sendMessage(from, {
        text: `👤 Kise verify karna hai?\n*.ok @user*  ya unke message par reply karke *.ok*\nSab ko ek saath: *.ok all*`
      });
    }

    const actorNum = sender.split('@')[0].split(':')[0];
    let done = 0;

    for (const userJid of targets) {
      const userNum = userJid.split('@')[0].split(':')[0];
      // match by every id (phone + LID) so the mention form never matters
      let key = findKey(from, userJid);
      if (!key) {
        try { const t = await perm.targetIds(sock, from, userJid); key = findKey(from, t.ids); } catch (_) {}
      }
      if (!key) {
        await sock.sendMessage(from, {
          text: `ℹ️ @${userNum} antifake verification queue mein nahi hai.`,
          mentions: [userJid]
        });
        continue;
      }

      removePending(from, key);
      done++;
      const shown = key.split('@')[0].split(':')[0];

      await sock.sendMessage(from, {
        text:
`✅ *Verification Complete!*
━━━━━━━━━━━━━━━━━━━━
👤 User: @${shown}
🛡️ Verified by: @${actorNum}

🎉 @${shown} ko verify kar diya gaya hai! Welcome to the group!
Ab aap freely message kar sakte hain. 🎊

> Powered by ${config.botName}`,
        mentions: [key, sender]
      });
    }
  }
};
