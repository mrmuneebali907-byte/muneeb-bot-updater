'use strict';

const { channelInfo }           = require('../lib/messageConfig');
const isAdminLib                 = require('../lib/isAdmin');
const { isSudo }                 = require('../lib/index');
const { unbanUser, isBanned }    = require('../../database');
const { normalizeJidWithLid }    = require('../../utils/jidHelper');
const isOwner                    = require('../lib/isOwner');   // exports fn directly
const perm                       = require('../lib/perm');

// Normalize any JID / LID to digits-only phone number
function normalizeNumber(jid) {
  let resolved = jid;
  try { resolved = normalizeJidWithLid(jid) || jid; } catch (_) {}
  return String(resolved || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

async function unbanCommand(sock, chatId, message, extra) {
  const isGroup       = chatId.endsWith('@g.us');
  const senderId      = message.key.participant || message.key.remoteJid;
  const senderIsOwner = perm.isPrivileged(sock, message, extra) || isOwner(senderId);

  if (isGroup) {
    let senderIsAdmin;

    if (extra && typeof extra.isAdmin === 'boolean') {
      senderIsAdmin = extra.isAdmin ?? senderIsOwner;
    } else {
      const res = await isAdminLib(sock, chatId, senderId).catch(() => ({ isSenderAdmin: false }));
      senderIsAdmin = res.isSenderAdmin;
    }

    if (!senderIsAdmin && !senderIsOwner) {
      await sock.sendMessage(chatId, {
        text: '🔒 *Permission Denied!*\n\nSirf *group admin* ya *bot owner* .unban use kar sakte hain.',
        ...channelInfo,
      }, { quoted: message });
      return;
    }

  } else {
    const senderIsSudo = await isSudo(senderId).catch(() => false);
    if (!senderIsOwner && !senderIsSudo) {
      await sock.sendMessage(chatId, {
        text: '🔒 *Permission Denied!*\n\nSirf owner/sudo .unban use kar sakte hain private chat mein.',
        ...channelInfo,
      }, { quoted: message });
      return;
    }
  }

  // ── Resolve target user ────────────────────────────────────────────────────
  let userToUnban = null;

  const mentionedJids = (
    message.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
    message.message?.imageMessage?.contextInfo?.mentionedJid        ||
    []
  );
  if (mentionedJids.length > 0) userToUnban = mentionedJids[0];

  if (!userToUnban) {
    const ctxPart = (
      message.message?.extendedTextMessage?.contextInfo?.participant ||
      message.message?.imageMessage?.contextInfo?.participant
    );
    if (ctxPart) userToUnban = ctxPart;
  }

  if (!userToUnban) {
    await sock.sendMessage(chatId, {
      text: '❌ *Kisi user ko @mention karo ya unke message pe reply karo!*\n\nUsage: *.unban @user*  ya kisi ke message ko quote karke *.unban* likho',
      ...channelInfo,
    }, { quoted: message });
    return;
  }

  const { ids, jid: tJid } = await perm.targetIds(sock, chatId, userToUnban);
  userToUnban = tJid || userToUnban;
  const userNum = normalizeNumber(userToUnban);
  if (!userNum) {
    await sock.sendMessage(chatId, { text: '❌ Invalid user JID.', ...channelInfo }, { quoted: message });
    return;
  }

  if (!ids.some(i => isBanned(i)) && !isBanned(userNum)) {
    await sock.sendMessage(chatId, {
      text: `ℹ️ @${userNum} already unban hai — yeh user pehle se bot use kar sakta hai.`,
      mentions: [userToUnban],
      ...channelInfo,
    }, { quoted: message });
    return;
  }

  // ── Perform unban (every id of that person) ───────────────────────────────
  for (const i of new Set([...ids, userNum])) unbanUser(i);

  await sock.sendMessage(chatId, {
    text: `╭━━━❰ ✅ 𝙐𝙉𝘽𝘼𝙉 𝘼𝘾𝙏𝙄𝙊𝙉 ❱━━━╮\n┃\n┃ 🔓 Unbanned: @${userNum}\n┃ ✅ Bot use allowed again\n┃\n╰━━━━━━━━━━━━━━━━━━━━━━╯`,
    mentions: [userToUnban],
    ...channelInfo,
  }, { quoted: message });
}

module.exports = {
  name     : 'unban',
  aliases  : ['botunban'],
  category : 'admin',
  desc     : 'Unban a previously banned user',
  usage    : '.unban @user  or reply to their message',
  ownerOnly: false,   // permission checked inside: group admin OR any bot owner
  execute  : async (sock, msg, args, extra) => unbanCommand(sock, msg.key.remoteJid, msg, extra),
};
