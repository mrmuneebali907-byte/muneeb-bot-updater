'use strict';
/**
 * utils/groupStatusSend.js — WhatsApp GROUP STATUS ko sahi tareeke se bhejna.
 *
 * Problem: aam @whiskeysockets/baileys me group status bhejne ka rasta hi nahi hai. relayMessage chal jata hai aur
 * server "ok" bhi deta hai, lekin WhatsApp us message ko GROUP STATUS tab hi maanta hai jab:
 *   1) message group ke JID par jaye aur groupStatusMessageV2 me lipta ho,
 *   2) andar wale message ke contextInfo me isGroupStatus = true ho,
 *   3) stanza me ek  <meta is_group_status="true"/>  node ho   ← mainline Baileys ye khud nahi lagata.
 * Teesra node na ho to status "posted" dikhta hai par group me kahin nazar nahi aata.
 *
 * Kuch Baileys forks (itsliaaa wagairah) teesra node khud lagate hain. Isliye pehle jaanch hoti hai: lib me
 * 'is_group_status' likha ho to hum dobara nahi lagate (duplicate node se bachne ke liye), warna hum khud lagate hain.
 */
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { generateWAMessageFromContent } = require('@whiskeysockets/baileys');

let _libAdds = null;
function libAddsMeta() {
  if (_libAdds !== null) return _libAdds;
  _libAdds = false;
  try {
    const dir = path.dirname(require.resolve('@whiskeysockets/baileys'));
    for (const f of ['Socket/messages-send.js', 'Utils/messages.js', 'Socket/socket.js']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('is_group_status')) { _libAdds = true; break; }
    }
  } catch (_) {}
  return _libAdds;
}


// ── Server ka jawab console me dikhao (group status "posted" par dikhta kyun nahi — iska saboot) ───────────
// ack = WhatsApp server ne message qubool kiya ya reject (error code).  receipts = kitne devices ko pahuncha.
function traceDelivery(sock, id, jid) {
  const grp = String(jid).split('@')[0];
  let receipts = 0, gotAck = false;
  const onAck = (node) => {
    try {
      if (node?.attrs?.id !== id) return;
      gotAck = true;
      const err = node.attrs.error;
      console.log(`[groupstatus] 📨 server ack: ${err ? '❌ REJECT error=' + err : '✅ accepted (no error)'}  attrs=${JSON.stringify(node.attrs)}`);
    } catch (_) {}
  };
  const onReceipt = (list) => {
    try { for (const r of list || []) if (r?.key?.id === id && r?.receipt) receipts++; } catch (_) {}
  };
  try { sock.ws?.on?.('CB:ack,class:message', onAck); } catch (_) {}
  try { sock.ev?.on?.('message-receipt.update', onReceipt); } catch (_) {}
  setTimeout(() => {
    try { sock.ws?.off?.('CB:ack,class:message', onAck); } catch (_) {}
    try { sock.ev?.off?.('message-receipt.update', onReceipt); } catch (_) {}
    console.log(`[groupstatus] 🧾 30s report: server ack ${gotAck ? 'aaya' : 'NAHI aaya'}, delivery receipts=${receipts}  group=${grp}`);
  }, 30000).unref?.();
}

// ── Mainline Baileys me ek chhoti kami: media wale group status ke enc node par mediatype nahi lagta ──────────
// relayMessage:  getMediaType(message)  → message groupStatusMessageV2 me lipta hai, isliye imageMessage/videoMessage dikhta hi nahi.
// Patch sirf group status wale message par asar karta hai (baaki sab messages jaise the waise).
const PATCH_FROM = 'const mediaType = getMediaType(message);';
const PATCH_TO   = 'const mediaType = getMediaType(message.groupStatusMessageV2 ? (normalizeMessageContent(message) || message) : message); /* groupstatus-patch */';
function libFile() {
  const dir = path.dirname(require.resolve('@whiskeysockets/baileys'));
  return path.join(dir, 'Socket', 'messages-send.js');
}
function patchState() {
  try {
    const t = fs.readFileSync(libFile(), 'utf8');
    if (t.includes('groupstatus-patch')) return 'patched';
    if (t.includes(PATCH_FROM)) return 'unpatched';
    return 'unknown';           // alag Baileys (fork) — wo khud sambhalta hoga
  } catch (_) { return 'unknown'; }
}
function applyPatch() {
  const f = libFile();
  const t = fs.readFileSync(f, 'utf8');
  if (t.includes('groupstatus-patch')) return { ok: true, already: true };
  if (!t.includes(PATCH_FROM)) return { ok: false, why: 'Is Baileys me wo line nahi mili (alag version / fork).' };
  try { if (!fs.existsSync(f + '.bak')) fs.writeFileSync(f + '.bak', t); } catch (_) {}
  fs.writeFileSync(f, t.replace(PATCH_FROM, PATCH_TO));
  return { ok: true, already: false };
}
function revertPatch() {
  const f = libFile();
  if (fs.existsSync(f + '.bak')) { fs.writeFileSync(f, fs.readFileSync(f + '.bak', 'utf8')); return true; }
  return false;
}

/** `inside` = generateWAMessageContent(...) ka natija. Group JID par group status relay karta hai, message wapas deta hai. */
async function relayGroupStatus(sock, jid, inside, { onId } = {}) {
  const secret = crypto.randomBytes(32);
  const inner  = { ...inside };

  // text-only content → extendedTextMessage (contextInfo wahin lagta hai)
  if (typeof inner.conversation === 'string') { inner.extendedTextMessage = { text: inner.conversation }; delete inner.conversation; }

  // contextInfo.isGroupStatus = true on the real content node
  const kind = Object.keys(inner).find((k) => !/context/i.test(k) && inner[k] && typeof inner[k] === 'object');
  if (kind) inner[kind] = { ...inner[kind], contextInfo: { ...(inner[kind].contextInfo || {}), isGroupStatus: true } };

  const msg = generateWAMessageFromContent(jid, {
    messageContextInfo: { messageSecret: secret },
    groupStatusMessageV2: { message: { ...inner, messageContextInfo: { messageSecret: secret } } },
  }, {});

  if (typeof onId === 'function') { try { onId(msg.key.id); } catch (_) {} }   // relay se PEHLE id batao (echo jaldi aa jata hai)
  const opts = { messageId: msg.key.id };
  const lib  = libAddsMeta();
  if (!lib) opts.additionalNodes = [{ tag: 'meta', attrs: { is_group_status: 'true' }, content: undefined }];

  // mediatype fix (bina Baileys ki file badle): Baileys enc node par mediatype "message.imageMessage" jaise TOP-level field se nikalta hai,
  // par group status me wo groupStatusMessageV2 ke andar chhupa hai → mediatype lagta hi nahi tha (image/video/audio status nahi dikhte).
  // Hum message ke PROTOTYPE par wahi media object rakh dete hain: Baileys usse padh leta hai, lekin protobuf sirf OWN fields bhejta hai,
  // isliye wire par message bilkul wahi rehta hai (koi duplicate nahi).
  let wire = msg.message;
  if (/^(image|video|audio|document|sticker)Message$/.test(kind || '')) {
    try {
      const { proto } = require('@whiskeysockets/baileys');
      const hint = msg.message.groupStatusMessageV2 && msg.message.groupStatusMessageV2.message && msg.message.groupStatusMessageV2.message[kind];
      if (hint) {
        const P = Object.create(proto.Message.prototype); P[kind] = hint;
        wire = Object.create(P); Object.assign(wire, msg.message);
      }
    } catch (_) { wire = msg.message; }
  }

  traceDelivery(sock, msg.key.id, jid);
  await sock.relayMessage(jid, wire, opts);
  return { msg, kind: kind || '?', meta: lib ? 'lib' : 'added' };
}

module.exports = { relayGroupStatus, libAddsMeta, patchState, applyPatch, revertPatch, traceDelivery };
