'use strict';

/**
 * .mute — Per-user mute
 * Jis user ko mute karo uske saare messages auto-delete ho jaate hain.
 * Group lock nahi hota — sirf woh user ka message delete hota hai.
 */

const { channelInfo }  = require('../lib/messageConfig');
const isAdminLib        = require('../lib/isAdmin');
const isOwner           = require('../lib/isOwner');
const perm              = require('../lib/perm');
const { muteUser, isMuted } = require('../../database');
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

  // ── Admin / owner check ──────────────────────────────────────────────────
  let senderIsAdmin = extra.isAdmin ?? false;
  let botIsAdmin    = extra.isBotAdmin ?? false;

  if (!senderIsAdmin && !senderIsOwner) {
    return sock.sendMessage(chatId, {
      text: '🔒 *Permission Denied!*\n\nSirf group admin ya bot owner .mute use kar sakte hain.',
      ...channelInfo,
    }, { quoted: msg });
  }

  if (!botIsAdmin) {
    return sock.sendMessage(chatId, {
      text: '⚠️ *Bot ko admin banao!*\n\nMessage delete karne ke liye bot ka group admin hona zaroori hai.',
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
      text: '❌ *Kisi user ko @mention karo ya unke message pe reply karke .mute likho!*',
      ...channelInfo,
    }, { quoted: msg });
  }

  // Resolve ALL ids (phone + LID) of the target so the mute always matches
  const { ids, jid: tJid } = await perm.targetIds(sock, chatId, targetJid);
  targetJid = tJid || targetJid;
  const targetNum = normalizeNum(targetJid);

  // Bot / owners can never be muted
  if (perm.isProtectedTarget(sock, ids)) {
    return sock.sendMessage(chatId, { text: '❌ Bot ya owner ko mute nahi kar sakte!', ...channelInfo }, { quoted: msg });
  }

  if (ids.some(i => isMuted(chatId, i))) {
    return sock.sendMessage(chatId, {
      text: `ℹ️ @${targetNum} pehle se muted hai — unke messages already delete ho rahe hain.`,
      mentions: [targetJid],
      ...channelInfo,
    }, { quoted: msg });
  }

  for (const i of (ids.length ? ids : [targetNum])) muteUser(chatId, i);

  await sock.sendMessage(chatId, {
    text: `╭━━━❰ 🔇 𝙈𝙐𝙏𝙀 𝘼𝘾𝙏𝙄𝙊𝙉 ❱━━━╮\n┃\n┃ 🔇 Muted: @${targetNum}\n┃ 🗑️ Unke messages delete honge\n┃ ✅ Group mein rehenge\n┃ 📢 .unmute se wapas aao\n┃\n╰━━━━━━━━━━━━━━━━━━━━━━╯`,
    mentions: [targetJid],
    ...channelInfo,
  }, { quoted: msg });
}

module.exports = {
  name          : 'mute',
  aliases       : ['muteusr', 'silenceuser'],
  category      : 'admin',
  desc          : 'Mute a user — their messages will be auto-deleted',
  usage         : '.mute @user  or reply to their message',
  groupOnly     : true,
  adminOnly     : false,   // checked internally
  botAdminNeeded: false,   // checked internally
  execute,
};
