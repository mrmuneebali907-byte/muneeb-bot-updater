'use strict';

/**
 * Anti-Fake Account / Voice Verification System
 * .antifake on  — enable voice verification for new members
 * .antifake off — disable
 * Aliases: .antigay
 *
 * adminOnly: true  → handler.js does the owner/admin check with full LID support.
 *                    Owner (923329838699) is always allowed even without group admin role.
 */

const database = require('../../database');
const config   = require('../../config');
const { getPending } = require('../../utils/antifakeState');

module.exports = {
  name: 'antifake',
  aliases: ['antigay', 'antifakeaccount', 'fakeverify'],
  category: 'admin',
  description: 'Enable/disable voice verification system for new group members',
  usage: '.antifake on | .antifake off | .antifake status',
  groupOnly: true,
  adminOnly: true,   // handler.js checks this — owner bypass built in, LID-aware

  async execute(sock, msg, args, extra) {
    const { from, isBotAdmin, reply } = extra;

    const action = (args[0] || '').toLowerCase();

    // ── Status / no arg ────────────────────────────────────────────────────
    if (!action || action === 'status') {
      const gs      = database.getGroupSettings(from);
      const pending = getPending(from);
      const pendingList = pending.size > 0
        ? [...pending.entries()].map(([jid, d]) =>
            `• @${jid.split('@')[0].split(':')[0]}${d.voiceReceived ? ' ✅ voice bheja' : ' ⏳ awaiting voice'}`
          ).join('\n')
        : '• Koi nahi';

      return await sock.sendMessage(from, {
        text:
`🛡️ *Anti-Fake Account System*
━━━━━━━━━━━━━━━━━━━━
Status: ${gs.antifake ? '✅ *ON* — Verification Active' : '❌ *OFF* — Disabled'}

📋 *Pending Verifications (${pending.size}):*
${pendingList}

📌 *Commands:*
• \`.antifake on\` — Enable
• \`.antifake off\` — Disable
• \`.ok @user\` — Verify & accept user
• \`.kick @user\` — Remove fake account

> Powered by ${config.botName}`,
        mentions: [...pending.keys()]
      });
    }

    // ── on / off ───────────────────────────────────────────────────────────
    if (!['on', 'off'].includes(action)) {
      return reply(`❓ Invalid option. Use: .antifake on | .antifake off | .antifake status`);
    }

    const enable = action === 'on';
    database.updateGroupSettings(from, { antifake: enable });

    if (enable) {
      const botAdminWarn = isBotAdmin
        ? ''
        : '\n\n⚠️ *Warning:* Bot abhi is group ka admin nahi hai! Antifake properly kaam nahi karega jab tak bot ko admin na banao.';

      return await sock.sendMessage(from, {
        text:
`✅ *Anti-Fake Account System — ENABLED!*
━━━━━━━━━━━━━━━━━━━━
🔐 Ab yeh group fully protected hai!

🔄 *Flow:*
1️⃣ Naya member join kare ga
2️⃣ Bot unhe verification prompt bhejega
3️⃣ Member 5-second voice note bhejega: *"Main real hun"*
4️⃣ Admin ya Owner review karega

✅ *Accept:* \`.ok @user\`
❌ *Reject:* \`.kick @user\`${botAdminWarn}

> Powered by ${config.botName} 🛡️`
      });
    } else {
      return await sock.sendMessage(from, {
        text:
`❌ *Anti-Fake Account System — DISABLED!*
━━━━━━━━━━━━━━━━━━━━
Verification system band kar diya gaya.
Naye members ab bina verification ke join kar sakte hain.

> Powered by ${config.botName}`
      });
    }
  }
};
