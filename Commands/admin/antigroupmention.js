/**
 * .antigroupmention — stops members from posting a WhatsApp GROUP STATUS in the group
 * (or mentioning the group in a status) using another bot / their own phone.
 *
 *   warn   (default) 1st time → post deleted + English warning
 *                    2nd time → post deleted + user removed from the group
 *   delete           post is only deleted, nobody is warned or removed
 *   kick             post deleted + user removed immediately
 *
 * Group admins, bot owners and the bot accounts of this panel are never punished.
 * Logic lives in utils/antiGroupMention.js (hooked first thing in handler.js).
 */

const database = require('../../database');
const agm      = require('../../utils/antiGroupMention');

const MODES = ['warn', 'delete', 'kick'];

function describe(mode) {
  if (mode === 'delete') return 'Post sirf delete hogi (warning/kick nahi)';
  if (mode === 'kick')   return 'Post delete + user turant remove';
  return '1st baar: delete + warning ⚠️\n2nd baar: delete + user remove 🚫';
}

function statusText(gs) {
  const on   = !!gs.antigroupmention;
  const mode = (gs.antigroupmentionMode || 'warn').toLowerCase();
  return (
    `🛡️ *Anti Group Status*\n\n` +
    `Status : *${on ? '🟢 ON' : '🔴 OFF'}*\n` +
    `Mode   : *${mode}*\n${describe(mode)}\n\n` +
    `*Commands:*\n` +
    `• *.antigroupmention on*\n` +
    `• *.antigroupmention off*\n` +
    `• *.antigroupmention set warn | delete | kick*\n` +
    `• *.antigroupmention reset* — sabki warnings saaf\n\n` +
    `_Admins aur bot owner par kuch nahi lagta._`
  );
}

module.exports = {
  name: 'antigroupmention',
  aliases: ['agm', 'antigroupstatus', 'antigs'],
  category: 'admin',
  description: 'Block group-status posts (warn once, then remove)',
  usage: '.antigroupmention <on/off/set/get/reset>',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: false,   // still works (delete/warn need admin, but we tell the user instead of refusing)

  async execute(sock, msg, args, extra) {
    try {
      const from = extra.from;
      const gs   = database.getGroupSettings(from);
      const opt  = (args[0] || '').toLowerCase();

      if (!opt || opt === 'get' || opt === 'status') return extra.reply(statusText(gs));

      const adminNote = extra.isBotAdmin === false
        ? `\n\n⚠️ *Bot is group ka admin nahi hai!* Delete aur remove ke liye bot ko admin banayein.` : '';

      if (opt === 'on') {
        database.updateGroupSettings(from, {
          antigroupmention: true,
          antigroupmentionMode: gs.antigroupmentionMode || 'warn',
        });
        const mode = gs.antigroupmentionMode || 'warn';
        return extra.reply(`✅ *Anti Group Status ON*\n\nMode: *${mode}*\n${describe(mode)}${adminNote}`);
      }

      if (opt === 'off') {
        database.updateGroupSettings(from, { antigroupmention: false });
        return extra.reply('🔴 *Anti Group Status OFF*');
      }

      if (opt === 'set') {
        const mode = (args[1] || '').toLowerCase();
        if (!MODES.includes(mode)) return extra.reply('❌ Mode chunein: *.antigroupmention set warn | delete | kick*');
        const patch = { antigroupmention: true, antigroupmentionMode: mode };
        if (mode !== 'warn') patch.antigroupmentionAction = mode;   // keeps the old forwarded-message filter in step
        database.updateGroupSettings(from, patch);
        return extra.reply(`✅ *Mode set: ${mode}*\n${describe(mode)}\n\n(Anti Group Status ab *ON* hai)${adminNote}`);
      }

      if (opt === 'reset') {
        agm.resetGroup(from);
        return extra.reply('♻️ Is group ki saari group-status warnings saaf kar di gayi.');
      }

      return extra.reply(statusText(gs));
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  },
};
