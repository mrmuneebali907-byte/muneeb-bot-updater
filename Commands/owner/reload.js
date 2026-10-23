'use strict';
/**
 * Reload Command — manually hot-reload all commands without restarting the bot.
 * Use after directly editing a command file on Replit, or to verify update loaded.
 */

module.exports = {
  name      : 'reload',
  aliases   : ['hotreload', 'reloadcmds'],
  category  : 'owner',
  description: 'Hot-reload all commands without restarting the bot',
  usage     : '.reload',
  ownerOnly : true,

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;

    const reply = async (text) => {
      try { await sock.sendMessage(chatId, { text }, { quoted: msg }); } catch (_) {}
    };

    try {
      const { loadCommands, getLastRefresh } = require('../../utils/commandLoader');
      const fs   = require('fs');
      const path = require('path');

      // Snapshot before
      const namesBefore = new Set();
      try {
        for (const [k, v] of loadCommands()) { if (v.name === k) namesBefore.add(k); }
      } catch (_) {}

      // Hot-reload
      const { hotReloadCommands } = require('../../handler');
      hotReloadCommands();

      // Snapshot after
      const namesAfter = new Set();
      const newCmds    = [];
      const removed    = [];
      try {
        for (const [k, v] of loadCommands()) {
          if (v.name === k) {
            namesAfter.add(k);
            if (!namesBefore.has(k)) newCmds.push(k);
          }
        }
        for (const k of namesBefore) {
          if (!namesAfter.has(k)) removed.push(k);
        }
      } catch (_) {}

      // Read version fresh from disk
      let ver = '';
      try {
        ver = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version || '';
      } catch (_) {}

      let out = `🔄 *Commands Reloaded!*\n\n`;
      out += `⚡ Total commands : *${namesAfter.size}*\n`;
      if (ver) out += `📦 Version        : *v${ver}*\n`;
      let refreshed = [];
      try { refreshed = getLastRefresh().utils || []; } catch (_) {}
      out += `🔧 Utils refreshed: *${refreshed.length}*\n`;
      if (newCmds.length)  out += `\n🆕 New: *${newCmds.join(', ')}*`;
      if (removed.length)  out += `\n🗑️ Removed: *${removed.join(', ')}*`;
      if (!newCmds.length && !removed.length) out += `\n✅ No changes detected (all commands up to date)`;

      out += `\n\nℹ️ _handler.js, Panel, config ya islamicGreeting badla ho to bot *Restart* karo._`;
      await reply(out);
      console.log(`[Reload] utils refreshed: ${refreshed.join(', ') || '-'}`);
      console.log(`[Reload] ✅ ${namesAfter.size} commands | +${newCmds.length} new | -${removed.length} removed`);

    } catch (err) {
      console.error('[Reload] Error:', err);
      await reply(`❌ Reload failed: ${err.message}`);
    }
  },
};
