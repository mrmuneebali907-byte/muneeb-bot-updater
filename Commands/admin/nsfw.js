'use strict';
/**
 * .nsfw on | off | status
 * .nsfw api <user> <secret>   (owner only) — Sightengine free key, enables image checking
 * .nsfw api off               (owner only)
 */
const database = require('../../database');
const perm     = require('../lib/perm');
const shield   = require('../../utils/nsfwShield');

module.exports = {
  name       : 'nsfw',
  aliases    : ['nsfwshield', 'nsfwfilter'],
  category   : 'admin',
  description: 'Adult-content filter (text/links always, images with a free API key)',
  usage      : '.nsfw on | off | set warn|delete|kick | status   •   .nsfw api <user> <secret>',
  groupOnly  : false,
  adminOnly  : false,          // checked below
  botAdminNeeded: false,

  async execute(sock, msg, args, extra) {
    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const opt = (args[0] || '').toLowerCase();
    const privileged = perm.isPrivileged(sock, msg, extra);

    // ── API key (owner only, any chat; the message is deleted right away) ──
    if (opt === 'api') {
      if (!privileged) return extra.reply('❌ Sirf bot owner.');
      try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
      if ((args[1] || '').toLowerCase() === 'off') { shield.setApi(null); return sock.sendMessage(from, { text: '✅ NSFW image API hata di gayi.' }); }
      if (!args[1]) return sock.sendMessage(from, { text: 'Use: *.nsfw api <api_user>*  (secret already saved)\nya: *.nsfw api <api_user> <api_secret>*' });
      shield.setApi(args[1], args[2]);
      return sock.sendMessage(from, { text: '✅ NSFW image API save ho gayi. Ab *.nsfw on* wale groups mein images bhi check hongi.\n_(Aapka key wala message delete kar diya.)_' });
    }

    if (!isGroup) return extra.reply('❌ Ye command group mein chalta hai.');
    if (!extra.isAdmin && !privileged) return extra.reply('❌ Sirf group admin.');

    const gs = database.getGroupSettings(from);
    const hasApi = !!shield.getApi();
    const raw = shield.getApiRaw();
    const apiLine = hasApi ? 'active ✅' : (raw.secret ? 'secret saved, *api_user missing* — .nsfw api <api_user>' : 'not set');

    if (opt === 'set') {
      const mode = (args[1] || '').toLowerCase();
      if (!['warn', 'delete', 'kick'].includes(mode)) return extra.reply('❌ Use: *.nsfw set warn | delete | kick*');
      database.updateGroupSettings(from, { nsfw: true, nsfwMode: mode });
      const d = { warn: '1st baar: delete + warning ⚠️\n2nd baar: delete + user remove 🚫', delete: 'Content sirf delete (silent)', kick: 'Content delete + user turant remove' }[mode];
      return extra.reply(`✅ *NSFW action set: ${mode}*\n${d}\n\n(NSFW Filter ab *ON* hai)`);
    }

    if (opt === 'on' || opt === 'off') {
      database.updateGroupSettings(from, { nsfw: opt === 'on' });
      return extra.reply(opt === 'on'
        ? `✅ *NSFW Filter ON*\n\n📝 Action: *${gs.nsfwMode || 'warn'}* (.nsfw set warn | delete | kick)\n🖼️🎬 Images & videos: ${hasApi ? 'checked (API active)' : 'check nahi honge (API incomplete)'}\n🎭 Stickers: allowed`
        : `❌ *NSFW Filter OFF*`);
    }
    return extra.reply(`🔞 *NSFW Filter:* ${gs.nsfw ? 'ON ✅' : 'OFF ❌'}\n🖼️🎬 Image/Video API: ${apiLine}\n⚙️ Action: *${gs.nsfwMode || 'warn'}*\n\n.nsfw on\n.nsfw off\n.nsfw set warn | delete | kick`);
  }
};
