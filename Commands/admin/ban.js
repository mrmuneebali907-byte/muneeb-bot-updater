'use strict';

const { channelInfo }         = require('../lib/messageConfig');
const isAdminLib               = require('../lib/isAdmin');
const { isSudo }               = require('../lib/index');
const { banUser, isBanned }    = require('../../database');
const { normalizeJidWithLid }  = require('../../utils/jidHelper');
const isOwner                  = require('../lib/isOwner');   // exports fn directly
const perm                     = require('../lib/perm');

// Normalize any JID / LID to digits-only phone number
function normalizeNumber(jid) {
  let resolved = jid;
  try { resolved = normalizeJidWithLid(jid) || jid; } catch (_) {}
  return String(resolved || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

async function banCommand(sock, chatId, message, extra) {
  const isGroup       = chatId.endsWith('@g.us');
  const senderId      = message.key.participant || message.key.remoteJid;
  const senderIsOwner = perm.isPrivileged(sock, message, extra) || isOwner(senderId);

  if (isGroup) {
    // ── Use handler's pre-computed isBotAdmin when available (most accurate) ──
    // extra.isBotAdmin comes from handler.js's sophisticated multi-format check.
    // Fall back to our own lib only when called outside the command pipeline.
    let botIsAdmin;
    let senderIsAdmin;

    if (extra && typeof extra.isBotAdmin === 'boolean') {
      // Handler already resolved these — use directly, no extra API call
      botIsAdmin    = extra.isBotAdmin;
      senderIsAdmin = extra.isAdmin ?? senderIsOwner;
    } else {
      const res = await isAdminLib(sock, chatId, senderId).catch(() => ({ isBotAdmin: false, isSenderAdmin: false }));
      botIsAdmin    = res.isBotAdmin;
      senderIsAdmin = res.isSenderAdmin;
    }

    if (!senderIsAdmin && !senderIsOwner) {
      await sock.sendMessage(chatId, {
        text: '🔒 *Permission Denied!*\n\nSirf *group admin* ya *bot owner* .ban use kar sakte hain.',
        ...channelInfo,
      }, { quoted: message });
      return;
    }

  } else {
    // Private chat — only owner / sudo
    const senderIsSudo = await isSudo(senderId).catch(() => false);
    if (!senderIsOwner && !senderIsSudo) {
      await sock.sendMessage(chatId, {
        text: '🔒 *Permission Denied!*\n\nSirf owner/sudo .ban use kar sakte hain private chat mein.',
        ...channelInfo,
      }, { quoted: message });
      return;
    }
  }

  // ── Resolve target user ────────────────────────────────────────────────────
  let userToBan = null;

  // Priority 1: @mention
  const mentionedJids = (
    message.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
    message.message?.imageMessage?.contextInfo?.mentionedJid        ||
    []
  );
  if (mentionedJids.length > 0) userToBan = mentionedJids[0];

  // Priority 2: reply-to participant
  if (!userToBan) {
    const ctxPart = (
      message.message?.extendedTextMessage?.contextInfo?.participant ||
      message.message?.imageMessage?.contextInfo?.participant
    );
    if (ctxPart) userToBan = ctxPart;
  }

  if (!userToBan) {
    await sock.sendMessage(chatId, {
      text: '❌ *Kisi user ko @mention karo ya unke message pe reply karo!*\n\nUsage: *.ban @user*  ya kisi ke message ko quote karke *.ban* likho',
      ...channelInfo,
    }, { quoted: message });
    return;
  }

  // Resolve ALL ids (phone + LID) so the ban holds whichever form WhatsApp shows later
  const { ids, jid: tJid } = await perm.targetIds(sock, chatId, userToBan);
  userToBan = tJid || userToBan;
  const userNum = normalizeNumber(userToBan);
  if (!userNum) {
    await sock.sendMessage(chatId, { text: '❌ Invalid user JID.', ...channelInfo }, { quoted: message });
    return;
  }

  // Bot itself and every owner are protected
  if (perm.isProtectedTarget(sock, ids.length ? ids : [userNum])) {
    await sock.sendMessage(chatId, { text: '❌ Bot ya owner ko ban nahi kar sakte!', ...channelInfo }, { quoted: message });
    return;
  }

  // ── Perform ban (commands blocked only — NOT removed from group) ──────────
  for (const i of new Set([...ids, userNum])) banUser(i);

  await sock.sendMessage(chatId, {
    text: `╭━━━❰ ⚠️ 𝘽𝘼𝙉 𝘼𝘾𝙏𝙄𝙊𝙉 ❱━━━╮\n┃\n┃ 🔒 Banned: @${userNum}\n┃ ✅ Bot commands blocked\n┃ ℹ️ Group mein rehne diya gaya\n┃\n╰━━━━━━━━━━━━━━━━━━━━━━╯`,
    mentions: [userToBan],
    ...channelInfo,
  }, { quoted: message });
}

module.exports = {
  name     : 'ban',
  aliases  : ['botban'],
  category : 'owner',
  desc     : 'Ban a user from using the bot (group admin or bot owner)',
  usage    : '.ban @user  or reply to their message',
  ownerOnly: false,   // permission checked inside: group admin OR any bot owner
  execute  : async (sock, msg, args, extra) => banCommand(sock, msg.key.remoteJid, msg, extra),
};
