'use strict';
/**
 * Command Loader — loads all commands from commands/ subdirectories.
 * Supports hot-reload: clears require.cache before re-loading (used after GitHub update).
 */

const fs   = require('fs');
const path = require('path');

const COMMANDS_PATH = path.join(__dirname, '..', 'commands');
const SKIP_DIRS     = new Set(['lib', 'data']);

// ── Hot-reload: kaun si utils/ files .reload par dobara load hoti hain ───────────────────────────
// Sirf wo "helper" files jinme koi chalta hua timer / connection / zaroori yaad-dasht nahi hai.
// Naye files (commands/ ya utils/ me) apne aap load ho jate hain — yahan likhne ki zaroorat nahi.
// NAHI chhuti (restart se hi badlengi): handler.js, Panel/, config.js, database.js, utils/warp, keepAlive, memoryGuard,
// cleanup, sendQueue, downloadQueue, channelReact, islamicGreeting, aiEngine, contactTools, strictGuard,
// groupLeader, antiBot, nsfwShield ... (inme timers / live state hai, dobara load karne se duplicate ho jate).
const UTILS_PATH = __dirname;
const REFRESH_UTILS = new Set([
  'animeImg', 'freeDl', 'ytdlp', 'mediaDownloader', 'helpers', 'converter', 'sticker', 'stickerConverter',
  'exif', 'imageGen', 'vision', 'waVideo', 'webp2mp4', 'time',
  'ttsEngine', 'sttEngine', 'edgeTts', 'voiceRouter', 'punish', 'autoReact', 'emojiRoast', 'netAxios',
]);
let _lastRefresh = { utils: [] };

function _clearCommandCache() {
  const prefix = COMMANDS_PATH + path.sep;
  const utilsDone = [];
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) { delete require.cache[key]; continue; }
    if (path.dirname(key) === UTILS_PATH) {
      const base = path.basename(key, '.js');
      if (REFRESH_UTILS.has(base)) { delete require.cache[key]; utilsDone.push(base); }
    }
  }
  _lastRefresh = { utils: utilsDone.sort() };
}

function loadCommands(hotReload = false) {
  if (hotReload) _clearCommandCache();

  const commands = new Map();

  if (!fs.existsSync(COMMANDS_PATH)) {
    console.warn('[CommandLoader] commands/ directory not found:', COMMANDS_PATH);
    return commands;
  }

  let loaded = 0, failed = 0;

  for (const category of fs.readdirSync(COMMANDS_PATH)) {
    if (SKIP_DIRS.has(category)) continue;
    const categoryPath = path.join(COMMANDS_PATH, category);
    let stat;
    try { stat = fs.statSync(categoryPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    for (const file of fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'))) {
      const filePath = path.join(categoryPath, file);
      try {
        const cmd = require(filePath);
        if (!cmd || !cmd.name) continue;
        commands.set(cmd.name, cmd);
        if (Array.isArray(cmd.aliases)) {
          for (const alias of cmd.aliases) commands.set(alias, cmd);
        }
        loaded++;
      } catch (err) {
        console.error(`[CommandLoader] ❌ ${category}/${file}:`, err.message);
        try { require('./jarvisMonitor').onLoadFailure(category, file, err); } catch (_) {}
        failed++;
      }
    }
  }

  console.log(`[CommandLoader] ✅ ${loaded} commands loaded${failed ? ` (${failed} failed)` : ''}`);
  return commands;
}

module.exports = { loadCommands, getLastRefresh: () => _lastRefresh };
