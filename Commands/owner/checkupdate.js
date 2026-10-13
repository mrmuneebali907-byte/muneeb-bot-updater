'use strict';

const https  = require('https');
const config = require('../../config');

const src = require('../../utils/updateSource');
const VERSION_URL = src.versionUrl();

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'MuneebAliBot/1.0', 'Accept': 'application/json' },
      timeout: 10_000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid response from server')); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Request timed out')));
  });
}

function semverGt(a, b) {
  const pa = String(a || '0.0.0').split('.').map(Number);
  const pb = String(b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

module.exports = {
  name        : 'checkupdate',
  aliases     : ['vcheck', 'version', 'ver'],
  category    : 'owner',
  description : 'Check if a new bot update is available',
  usage       : '.checkupdate',
  ownerOnly   : true,

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;

    const statusMsg = await extra.reply('🔍 *Checking for updates…*');
    const editStatus = async (text) => {
      if (statusMsg?.key) {
        try { await sock.sendMessage(chatId, { text, edit: statusMsg.key }); } catch (_) {}
      }
    };

    try {
      let localVer = '1.0.0';
      let localDate = null;
      try {
        const pkg   = require('../../package.json');
        localVer    = pkg.version  || localVer;
        localDate   = pkg.releaseDate || null;
      } catch (_) {}

      await editStatus('📡 *Latest version check ho raha hai…*');
      const remote     = await fetchJson(VERSION_URL);
      const remoteVer  = remote?.version  || 'unknown';
      const remoteDate = remote?.releaseDate || remote?.date || null;
      const changelog  = remote?.changelog || remote?.changes || null;

      const hasUpdate  = semverGt(remoteVer, localVer);
      const isUpToDate = !hasUpdate && remoteVer === localVer;

      let text =
        `╭━━━❰ 🔍 *VERSION CHECK* ❱━━━╮\n` +
        `┃\n` +
        `┃ 📦 Local  : *v${localVer}*${localDate ? ` (${localDate})` : ''}\n` +
        `┃ 🌐 Remote : *v${remoteVer}*${remoteDate ? ` (${remoteDate})` : ''}\n` +
        `┃\n`;

      if (hasUpdate) {
        text +=
          `┃ 🚀 *NEW UPDATE AVAILABLE!*\n` +
          `┃\n`;
        if (changelog) {
          text += `┃ 📋 *Changelog:*\n`;
          const lines = String(changelog).split('\n').slice(0, 5);
          for (const l of lines) text += `┃  • ${l.trim()}\n`;
          text += `┃\n`;
        }
        text +=
          `┃ ⬇️ Update karne ke liye:\n` +
          `┃  *${extra.prefix || '.'}update*\n` +
          `┃\n`;
      } else if (isUpToDate) {
        text += `┃ ✅ *Already up to date!*\n┃\n`;
      } else {
        text += `┃ ⚠️ Version mismatch — check manually\n┃\n`;
      }

      text +=
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ${config.botName || 'Bot'}*`;

      await editStatus(text);

    } catch (err) {
      console.error('[checkupdate]', err.message);
      await editStatus(
        `❌ *Version check failed!*\n\n` +
        `Error: ${src.scrub(err.message)}\n\n` +
        `_Internet connection check karo, phir dobara try karo._`
      );
    }
  },
};
