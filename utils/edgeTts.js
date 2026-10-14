'use strict';
/**
 * edgeTts.js — own Microsoft Edge "Read Aloud" client (WebSocket).
 * The old `msedge-tts` package gets HTTP 403 because Microsoft now requires the
 * rotating `Sec-MS-GEC` token. This client generates it itself (and corrects for
 * clock skew using the server's Date header), so it keeps working.
 *   synth(voice, text, {rate, pitch}) → Promise<Buffer(mp3)>
 */
const crypto = require('crypto');
let WS; try { WS = require('ws'); } catch (_) { WS = null; }

const TOKEN   = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROME  = '143.0.3650.75';
const HOST    = process.env.EDGE_TTS_HOST || 'wss://speech.platform.bing.com';
const BASE    = '/consumer/speech/synthesize/readaloud/edge/v1';
let skewSec = 0;     // server time − local time


// ── optional route through the local SOCKS5 proxy (Cloudflare WARP) — only used when the direct connection fails ──
function socks5Tunnel(proxyUrl, host, port, timeoutMs = 8000) {
  const net = require('net'), tls = require('tls');
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(proxyUrl); } catch (e) { return reject(new Error('bad proxy url')); }
    const sock = net.connect({ host: u.hostname, port: parseInt(u.port, 10) || 1080 });
    let buf = Buffer.alloc(0), step = 0, done = false;
    const fail = (e) => { if (done) return; done = true; clearTimeout(t); try { sock.destroy(); } catch (_) {} reject(e instanceof Error ? e : new Error(String(e))); };
    const t = setTimeout(() => fail(new Error('socks5 timeout')), timeoutMs);
    sock.on('error', fail);
    sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
    sock.on('data', (d) => {
      if (done) return;
      buf = Buffer.concat([buf, d]);
      if (step === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('socks5 auth refused'));
        buf = buf.slice(2); step = 1;
        const h = Buffer.from(host, 'ascii');
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
      }
      if (step === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return fail(new Error('socks5 connect failed (code ' + buf[1] + ')'));
        const need = 4 + (buf[3] === 1 ? 4 : buf[3] === 4 ? 16 : 1 + buf[4]) + 2;
        if (buf.length < need) return;
        done = true; clearTimeout(t);
        sock.removeAllListeners('data'); sock.removeAllListeners('error');
        resolve(tls.connect({ socket: sock, servername: host }));
      }
    });
  });
}

function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000 + skewSec) + 11644473600;
  ticks -= ticks % 300;
  ticks = Math.floor(ticks * 1e7);
  return crypto.createHash('sha256').update(`${ticks}${TOKEN}`, 'ascii').digest('hex').toUpperCase();
}
const uuid = () => crypto.randomUUID().replace(/-/g, '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const ts = () => new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');

function once(voice, text, opts = {}, agent = null) {
  return new Promise((resolve, reject) => {
    if (!WS) return reject(new Error('ws module missing'));
    const url = `${HOST}${BASE}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROME}&ConnectionId=${uuid()}`;
    const ws = new WS(url, {
      headers: {
        'Pragma': 'no-cache', 'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROME.split('.')[0]}.0.0.0`,
      },
      handshakeTimeout: 10000,
      ...(agent ? { agent } : {}),
    });
    const chunks = []; let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch (_) {} err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('Edge TTS timeout')), 25000);

    ws.on('unexpected-response', (_req, res) => {
      try { const d = Date.parse(res.headers?.date); if (d) skewSec = d / 1000 - Date.now() / 1000; } catch (_) {}
      const e = new Error(`Edge TTS handshake HTTP ${res.statusCode}`); e.status = res.statusCode; finish(e);
    });
    ws.on('error', (e) => finish(e));
    ws.on('close', () => finish(chunks.length ? null : new Error('Edge TTS closed before audio'), Buffer.concat(chunks)));
    ws.on('open', () => {
      ws.send(`X-Timestamp:${ts()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-96kbitrate-mono-mp3' } } } }));
      const lang = voice.split('-').slice(0, 2).join('-');
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${voice}'><prosody pitch='${opts.pitch || '+0Hz'}' rate='${opts.rate || '+0%'}' volume='+0%'>${esc(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { if (String(data).includes('Path:turn.end')) finish(null, Buffer.concat(chunks)); return; }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 2) return;
      const hl = buf.readUInt16BE(0);
      if (buf.slice(2, 2 + hl).toString().includes('Path:audio')) chunks.push(buf.slice(2 + hl));
    });
  });
}

async function synth(voice, text, opts = {}) {
  let last;
  for (let i = 0; i < 2; i++) {                       // 2nd try uses the corrected clock after a 403
    try { const b = await once(voice, text, opts); if (b && b.length > 256) return b; throw new Error('Edge TTS empty audio'); }
    catch (e) { last = e; if (e.status !== 403) break; }
  }
  // Direct connection failed (some hosting IPs are blocked by Microsoft) → retry through the local WARP proxy if it is running
  try {
    const proxy = require('./warp').getProxy && require('./warp').getProxy();
    if (proxy) {
      const h = new URL(HOST.replace(/^wss/, 'https')).hostname;
      const https = require('https');
      const tun = await socks5Tunnel(proxy, h, 443);
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => tun;
      const b = await once(voice, text, opts, agent);
      if (b && b.length > 256) { console.log('[TTS] edgeTts OK via WARP'); return b; }
      throw new Error('Edge TTS empty audio (WARP)');
    }
  } catch (e2) { console.log('[TTS] edgeTts via WARP:', e2.message); }
  throw last;
}

module.exports = { synth, _secMsGec: secMsGec, _socks5Tunnel: socks5Tunnel };
