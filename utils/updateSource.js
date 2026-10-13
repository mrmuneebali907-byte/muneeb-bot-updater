'use strict';
/**
 * utils/updateSource.js — where `.update` / `.checkupdate` get their files from (one place, no repo names in chat).
 *   zip of the update repo + version.json of the SAME repo/branch (derived from the zip URL)
 */

// ONE update repo for both the version check and the download (config.updateZipUrl is deliberately NOT used any more:
// it pointed to a different repo than the version check). Override with env UPDATE_ZIP_URL if ever needed.
const DEFAULT_ZIP = 'https://github.com/mrmuneebali907-byte/muneeb-bot-updater/archive/refs/heads/main.zip';

function zipUrl() { return process.env.UPDATE_ZIP_URL || DEFAULT_ZIP; }

function versionUrl() {
  const m = String(zipUrl()).match(/github\.com\/([^/]+)\/([^/]+)\/archive\/refs\/heads\/(.+?)\.zip/i);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/version.json`;
  const a = String(zipUrl()).match(/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/zipball\/(.+)$/i);
  if (a) return `https://raw.githubusercontent.com/${a[1]}/${a[2]}/${a[3]}/version.json`;
  return null;
}

/** remove anything that looks like a repo / url from text that is shown in chat */
function scrub(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '[server]')
    .replace(/github(usercontent)?\.com\S*/gi, '[server]')
    .replace(/mrmuneebali907-byte\S*/gi, '[server]')
    .slice(0, 300);
}

module.exports = { zipUrl, versionUrl, scrub };
