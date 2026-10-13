/**
 * ttsEngine.js — Reusable text-to-speech (Edge TTS → OGG/OPUS for WhatsApp PTT)
 * Extracted from the original .pair command's voice-note generator so any
 * command can reuse the same proven logic (voice fallback chain + ffmpeg
 * conversion) instead of duplicating it.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

// MALE voices only — the bot's voice must stay the same male voice every time.
// (Edge TTS sometimes answers 403 / closes the stream for a moment; we retry
// the SAME male voice instead of dropping to a female one.)
const DEFAULT_VOICES = [
  { voice: 'hi-IN-MadhurNeural', label: 'Hindi Madhur (male)' },
];

// ── Convert an MP3 Buffer → OGG/OPUS Buffer via FFmpeg temp files ────────────
function mp3ToOggOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const id     = `tts_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const tmpMp3 = path.join(os.tmpdir(), `${id}.mp3`);
    const tmpOgg = path.join(os.tmpdir(), `${id}.ogg`);

    const cleanup = () => {
      try { if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3); } catch (_) {}
      try { if (fs.existsSync(tmpOgg)) fs.unlinkSync(tmpOgg); } catch (_) {}
    };

    try {
      fs.writeFileSync(tmpMp3, mp3Buffer);
    } catch (e) {
      return reject(new Error(`Failed to write temp MP3: ${e.message}`));
    }

    ffmpeg(tmpMp3)
      .audioCodec('libopus')
      .audioFrequency(16000)
      .audioChannels(1)
      .audioBitrate('24k')
      .format('ogg')
      .on('error', (e) => { cleanup(); reject(new Error(`FFmpeg error: ${e.message}`)); })
      .on('end', () => {
        try {
          const buf = fs.readFileSync(tmpOgg);
          cleanup();
          resolve(buf);
        } catch (e) {
          cleanup();
          reject(new Error(`Failed to read converted OGG: ${e.message}`));
        }
      })
      .save(tmpOgg);
  });
}

function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data',  (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    readable.on('end',   ()  => resolve(Buffer.concat(chunks)));
    readable.on('error', (e) => reject(e));
  });
}

async function ttsChunkToMp3(voice, text) {
  // 1) own Edge client (handles the Sec-MS-GEC token → no 403)
  try { return await require('./edgeTts').synth(voice, text); }
  catch (e1) { console.log('[TTS] edgeTts:', e1.message); }
  // 2) old msedge-tts package as backup
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  let buf;
  try {
    const { audioStream } = tts.toStream(text);
    buf = await streamToBuffer(audioStream);
  } finally {
    try { if (typeof tts.close === 'function') tts.close(); } catch (_) {}
  }
  if (!buf || buf.length < 256) throw new Error(`Empty audio for: "${text.slice(0, 40)}"`);
  return buf;
}

// Edge TTS silently truncates long single requests — split on sentence
// boundaries so nothing gets cut off.
function splitIntoChunks(text, maxLen = 220) {
  const sentences = text.match(/[^.!?\u0964\u06D4\u061F\n]+[.!?\u0964\u06D4\u061F]+|[^.!?\u0964\u06D4\u061F\n]+$/g) || [text];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if ((current + ' ' + trimmed).length > maxLen && current) {
      chunks.push(current.trim());
      current = trimmed;
    } else {
      current = current ? `${current} ${trimmed}` : trimmed;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

/**
 * Convert text → a WhatsApp-ready OGG/OPUS voice-note Buffer.
 * Tries each voice in order until one works.
 */
function cleanForSpeech(input) {
  const raw = (input && typeof input === 'object' && typeof input.text === 'string') ? input.text : input;
  if (typeof raw !== 'string') throw new Error('TTS input must be a string');
  return raw
    .replace(/https?:\/\/\S+/g, ' ')            // links
    .replace(/[*_~`#>|]/g, ' ')                 // markdown symbols
    .replace(/\p{Extended_Pictographic}/gu, ' ') // emojis
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);                             // keep voice notes reasonably short
}

// Pick voices by the script of the text. A Hindi voice can't read Urdu/Arabic
// script (or Korean etc.) — it returns empty audio — so match voice to script.
const URDU_VOICES = [
  { voice: 'ur-PK-AsadNeural', label: 'Urdu Asad (male)' },
];
const ENGLISH_IN_VOICES = [
  { voice: 'en-IN-PrabhatNeural', label: 'English-India Prabhat (male)' },
];
function pickVoices(text) {
  const hasDeva = /[\u0900-\u097F]/.test(text);
  const hasArab = /[\u0600-\u06FF]/.test(text);
  if (hasDeva) return DEFAULT_VOICES;                     // Hindi voices
  if (hasArab) return URDU_VOICES;                        // Urdu voices
  return [...ENGLISH_IN_VOICES, ...DEFAULT_VOICES];       // Latin text
}

async function textToVoiceNote(text, opts = {}) {
  const cleaned = cleanForSpeech(text);
  const voices = opts.voices || pickVoices(cleaned);
  if (!cleaned) throw new Error('Nothing speakable in text');
  const chunks = splitIntoChunks(cleaned);
  let lastErr;

  const ATTEMPTS = 2;
  for (const { voice, label } of voices) {
   for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      console.log(`[TTS] Trying voice: ${label}${attempt > 1 ? ' (retry ' + attempt + ')' : ''}`);
      const mp3Parts = [];
      for (let i = 0; i < chunks.length; i++) {
        mp3Parts.push(await ttsChunkToMp3(voice, chunks[i]));
      }
      const mp3Buf = Buffer.concat(mp3Parts);
      const oggBuf = await mp3ToOggOpus(mp3Buf);
      if (!oggBuf || oggBuf.length < 512) throw new Error(`OGG empty (${oggBuf?.length ?? 0} bytes)`);
      return oggBuf;
    } catch (e) {
      lastErr = e;
      console.log(`[TTS] Voice ${label} failed: ${e.message}`);
      if (attempt < ATTEMPTS) await new Promise(r => setTimeout(r, 700 * attempt));
    }
   }
  }

  throw new Error(`All TTS voices failed. Last: ${lastErr?.message}`);
}

module.exports = { textToVoiceNote, splitIntoChunks };
