/**
 * .respectguard — bot / owner ke khilaf gali-galoch par warning → remove → session disconnect
 */
const rg = require('../../utils/respectGuard');

module.exports = {
  name: 'respectguard',
  aliases: ['rguard', 'respect', 'galiguard'],
  description: 'Bot/owner ko gali dene walon par 3 warning, phir group se remove (connector ka session disconnect)',
  usage: '.respectguard on | off | ai on|off | status | strikes | addword <word> | delword <word> | reset <number|@mention|all>',
  category: 'owner',
  ownerOnly: true,
  superAdminOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'on' || sub === 'off') {
        rg.setEnabled(sub === 'on');
        return extra.reply(sub === 'on' ? '✅ Respect Guard *ON* — bot/owner ko gali dene par warning + action.' : '⏸️ Respect Guard *OFF*.');
      }
      if (sub === 'ai' && (args[1] === 'on' || args[1] === 'off')) {
        rg.setAi(args[1] === 'on');
        return extra.reply(args[1] === 'on' ? '🧠 AI judge *ON* — AI khud message padhke faisla karega.' : '📋 AI judge *OFF* — sirf word-list se kaam.');
      }
      if (sub === 'addword' && args[1]) { rg.addWord(args.slice(1).join(' ')); return extra.reply(`✅ Word add: *${args.slice(1).join(' ')}*`); }
      if (sub === 'delword' && args[1]) { rg.delWord(args.slice(1).join(' ')); return extra.reply(`🗑️ Word hata diya: *${args.slice(1).join(' ')}*`); }
      if (sub === 'reset') {
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const ids = [];
        if (args[1] && args[1].toLowerCase() === 'all') {
          return extra.reply(`♻️ Sabki warnings saaf: *${rg.resetBy('all')}* record.`);
        }
        for (const a of args.slice(1)) { const d = a.replace(/[^0-9]/g, ''); if (d.length >= 6) ids.push(d); }
        for (const m of (ctx?.mentionedJid || [])) ids.push(m);
        if (ctx?.participant) ids.push(ctx.participant);
        if (!ids.length) return extra.reply('Use: *.respectguard reset <number>*  ya  kisi ko @mention karo  ya  uske message ko reply karo  ya  *.respectguard reset all*');
        const c1 = rg.resetBy(ids);
        return extra.reply(c1 ? `♻️ Warnings saaf: *${c1}* record.` : '🤷 Is banday ka koi warning record nahi mila (shayad pehle hi expire ho gaya).');
      }
      if (sub === 'strikes' || sub === 'list') {
        const st = Object.entries(rg.status().strikes);
        if (!st.length) return extra.reply('✅ Abhi kisi par koi warning nahi.');
        return extra.reply('📋 *Warnings*\n' + st.slice(0, 25).map(([k, v]) => `• ${(v.ids || [k.split(':').pop()])[0]} — ${v.n}/${rg.WARN_LIMIT}`).join('\n'));
      }
      if (sub === 'test' && args[1]) {
        const t = args.slice(1).join(' ');
        const v = await rg.judge(t, 'test');
        if (v) return extra.reply(`🧠 AI faisla: *${v.abusive ? 'ABUSIVE' : 'theek hai'}*${v.reply ? `\n💬 ${v.reply}` : ''}`);
        return extra.reply(`🔎 Gali detect: *${rg.hasAbuse(t) ? 'HAAN' : 'NAHI'}*\n🎯 Bot/owner ki taraf: *${rg.hasTargetWord(t) ? 'HAAN' : 'NAHI'}*\n(dono HAAN hon tabhi warning aati hai)`);
      }
      const s = rg.status();
      return extra.reply(
        `🛡️ *Respect Guard* — ${s.enabled ? '✅ ON' : '⏸️ OFF'}   🧠 AI: ${s.ai ? 'ON' : 'OFF'}\n\n` +
        `• Bot/owner ki taraf wala message AI padhta hai aur khud faisla karta hai\n` +
        `• Gali + bot/owner ki taraf → warning 1/${rg.WARN_LIMIT}, 2/${rg.WARN_LIMIT}, 3/${rg.WARN_LIMIT}\n` +
        `• Uske baad: member *ya admin* → *remove* (bot admin ho)\n` +
        `• Connector khud gali de → *session disconnect* + aapko report\n` +
        `• Aap (super owner) hamesha exempt\n\n` +
        `Built-in words: ${s.builtin}  |  Extra: ${s.extra.length}\nActive strikes: ${Object.keys(s.strikes).length}\n\n` +
        `*.respectguard on | off*\n*.respectguard ai on | off*\n*.respectguard addword <word>* / *delword <word>*\n*.respectguard reset <number>* (ya @mention / reply / all)\n*.respectguard strikes* — kis par kitni warning\n*.respectguard test <text>* — check karo`);
    } catch (e) {
      console.error('[respectguard]', e.message);
      return extra.reply('❌ Error aaya.');
    }
  },
};
