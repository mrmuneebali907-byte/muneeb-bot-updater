'use strict';

/**
 * .unmute — Remove per-user mute
 * User ke messages dobara allow ho jaate hain.
 */

const { channelInfo }   = require('../lib/messageConfig');
const isOwner            = require('../lib/isOwner');
const perm               = require('../lib/perm');
const { unmuteUser, isMuted } = require('../../database');
const { normalizeJidWithLid } = require('../../utils/jidHelper');

function normalizeNum(jid) {
  let r = jid;
  try { r = normalizeJidWithLid(jid) || jid; } catch (_) {}
  return String(r || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

async function execute(sock, msg, args, extra) {
  const chatId        = extra.from;
  const senderId      = msg.key.participant || msg.key.remoteJid;
  const senderIsOwner = perm.isPrivileged(sock, msg, extra) || isOwner(senderId);
  const senderIsAdmin = extra.isAdmin ?? false;

  if (!senderIsAdmin && !senderIsOwner) {
    return sock.sendMessage(chatId, {
      text: '🔒 *Permission Denied!*\n\nSirf group admin ya bot owner .unmute use kar sakte hain.',
      ...channelInfo,
    }, { quoted: msg });
  }

  // ── Resolve target ───────────────────────────────────────────────────────
  let targetJid = null;

  const mentioned = (
    msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
    msg.message?.imageMessage?.contextInfo?.mentionedJid ||
    []
  );
  if (mentioned.length > 0) targetJid = mentioned[0];

  if (!targetJid) {
    const ctxPart = (
      msg.message?.extendedTextMessage?.contextInfo?.participant ||
      msg.message?.imageMessage?.contextInfo?.participant
    );
    if (ctxPart) targetJid = ctxPart;
  }

  if (!targetJid) {
    return sock.sendMessage(chatId, {
      text: '❌ *Kisi user ko @mention karo ya unke message pe reply karke .unmute likho!*',
      ...channelInfo,
    }, { quoted: msg });
  }

  const { ids, jid: tJid } = await perm.targetIds(sock, chatId, targetJid);
  targetJid = tJid || targetJid;
  const targetNum = normalizeNum(targetJid);

  if (!ids.some(i => isMuted(chatId, i)) && !isMuted(chatId, targetNum)) {
    return sock.sendMessage(chatId, {
      text: `ℹ️ @${targetNum} muted nahi hai.`,
      mentions: [targetJid],
      ...channelInfo,
    }, { quoted: msg });
  }

  for (const i of new Set([...ids, targetNum])) unmuteUser(chatId, i);

  await sock.sendMessage(chatId, {
    text: `╭━━━❰ 🔊 𝙐𝙉𝙈𝙐𝙏𝙀 𝘼𝘾𝙏𝙄𝙊𝙉 ❱━━━╮\n┃\n┃ 🔊 Unmuted: @${targetNum}\n┃ ✅ Ab messages delete nahi honge\n┃\n╰━━━━━━━━━━━━━━━━━━━━━━╯`,
    mentions: [targetJid],
    ...channelInfo,
  }, { quoted: msg });
}

module.exports = {
  name    : 'unmute',
  aliases : ['unmuteuser', 'unsilence'],
  category: 'admin',
  desc    : 'Unmute a user — their messages will no longer be deleted',
  usage   : '.unmute @user  or reply to their message',
  groupOnly: true,
  execute,
};
