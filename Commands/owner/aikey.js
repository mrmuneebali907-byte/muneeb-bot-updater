'use strict';
/**
 * .aikey — manage the AI API keys used by the chatbot / voice bot (main owner only)
 *   .aikey list
 *   .aikey add <groq|gemini|mistral|openrouter|cerebras> <key>
 *   .aikey remove <provider> <key or its last 4+ characters>
 *   .aikey test            → asks the AI one question and tells which provider answered
 * The message that contains a key is deleted right away.
 */
const keys = require('../../utils/aiKeys');

module.exports = {
  name: 'aikey',
  aliases: ['aikeys', 'apikey'],
  category: 'owner',
  description: 'Add / remove / test AI API keys (chatbot & voice bot)',
  usage: '.aikey list | add <provider> <key> | remove <provider> <key> | test',
  superAdminOnly: true,

  async execute(sock, msg, args, extra) {
    const from = msg.key.remoteJid;
    const sub = String(args[0] || 'list').toLowerCase();
    const say = (text) => sock.sendMessage(from, { text }, { quoted: msg });

    if (sub === 'add' || sub === 'remove') {
      try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}   // never leave a key in the chat
      const provider = String(args[1] || '').toLowerCase();
      const key = String(args[2] || '').trim();
      if (!provider || !key) return sock.sendMessage(from, { text: `Use: *.aikey ${sub} <${keys.PROVIDERS.join('|')}> <key>*` });
      try {
        if (sub === 'add') { keys.add(provider, key); return sock.sendMessage(from, { text: `✅ ${provider} key save ho gayi (…${key.slice(-4)}). Turant active.` }); }
        const n = keys.remove(provider, key);
        return sock.sendMessage(from, { text: n ? `🗑️ ${provider}: ${n} key hata di.` : `❌ ${provider} mein aisi key nahi mili.` });
      } catch (e) { return sock.sendMessage(from, { text: `❌ ${e.message}` }); }
    }

    if (sub === 'test') {
      const { askAI } = require('../../utils/aiEngine');
      const t0 = Date.now();
      const r = await askAI({ system: 'Short jawab do.', user: 'Ek chhota salam bolo.', maxTokens: 40, userId: 'aikey-test' });
      return say(r ? `✅ AI chal raha hai\nProvider: *${r.api}*\nTime: ${Date.now() - t0}ms` : '❌ Koi bhi AI provider jawab nahi de raha. Console mein [AI-Engine] lines dekhein.');
    }

    const rows = keys.summary();
    return say('🔑 *AI Keys*\n\n' + (rows.length ? rows.map(r => `*${r.provider}*\n` + r.keys.map(k => `  • ${k.key}${k.parked ? ' ⏸️ (abhi band/limit)' : ''}`).join('\n')).join('\n\n') : 'Koi key nahi.') +
      '\n\n.aikey add <provider> <key>\n.aikey remove <provider> <key>\n.aikey test');
  },
};
