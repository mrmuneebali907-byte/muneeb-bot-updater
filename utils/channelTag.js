'use strict';
/**
 * utils/channelTag.js — channel header sirf MEDIA par.
 *
 *  - image / video / sticker / gif / document / audio (voice note nahi) jo bot bheje:
 *    upar "Forwarded from <channel>" + "View channel" aata hai (status par bhi).
 *  - sirf-text messages se channel ka forward-tag hata diya jata hai (ban/mute/etc ke
 *    channelInfo wale replies par channel button nahi dikhega).
 *  - Menu apni image ke saath apna tag khud bhejta hai, to wahan bana rehta hai.
 *
 * Band karne ke liye: config.channelTag = false
 */
const MEDIA_KEYS = ['image', 'video', 'sticker', 'document', 'audio'];
const FALLBACK_JID = '120363406636688300@newsletter';

function tagFor(config) {
  return {
    newsletterJid: (config && config.newsletterJid) || FALLBACK_JID,
    newsletterName: (config && config.botName) || 'Mr.Muneeb Ali Bot',
    serverMessageId: -1,
  };
}

function transform(jid, content, config) {
  if (!content || typeof content !== 'object') return content;
  if (typeof jid === 'string' && jid.endsWith('@newsletter')) return content;
  // react / delete / poll / edit etc. ko haath mat lagao
  if (content.react || content.delete || content.poll || content.edit || content.forward || content.groupStatusMessage) return content;

  const mediaKey = MEDIA_KEYS.find((k) => content[k]);
  if (mediaKey) {
    if (mediaKey === 'audio' && content.ptt) return content;      // voice note: saaf rakho
    const ci = content.contextInfo || {};
    if (ci.forwardedNewsletterMessageInfo) return content;         // menu jaisa already tagged
    return {
      ...content,
      contextInfo: { ...ci, forwardingScore: ci.forwardingScore || 1, isForwarded: true, forwardedNewsletterMessageInfo: tagFor(config) },
    };
  }
  if (typeof content.text === 'string' && content.contextInfo && content.contextInfo.forwardedNewsletterMessageInfo) {
    const { forwardedNewsletterMessageInfo, isForwarded, forwardingScore, ...rest } = content.contextInfo;
    const out = { ...content };
    if (Object.keys(rest).length) out.contextInfo = rest; else delete out.contextInfo;
    return out;
  }
  return content;
}

function install(sock, config) {
  if (!sock || sock.__ctInstalled || typeof sock.sendMessage !== 'function') return;
  if (config && config.channelTag === false) return;
  sock.__ctInstalled = true;
  const orig = sock.sendMessage.bind(sock);
  sock.sendMessage = (jid, content, ...rest) => {
    let c = content;
    try { c = transform(jid, content, config); } catch (_) {}
    return orig(jid, c, ...rest);
  };
}

module.exports = { install, transform };
