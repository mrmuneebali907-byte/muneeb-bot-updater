'use strict';
/**
 * utils/netAxios.js — axios jaisa hi, par restricted hosting (OptikLink / Enzonic) ke liye mazboot:
 *   1) seedha: IPv4 + backup DNS (1.1.1.1 / 8.8.8.8)
 *   2) fail ho (503 / 403 / 429 / timeout / DNS) to wahi request WARP tunnel se dobara
 * Use: const axios = require('./netAxios');  axios.get(...), axios.post(...), axios.head(...), axios({...})
 */
const axios = require('axios');
const A     = require('./animeImg');

async function request(cfg) {
  const url     = String(cfg.url || '');
  const isHttps = /^https:/i.test(url);
  const base    = { ...cfg, __viaWarp: true };   // global interceptor ko is request par dobara retry nahi karna
  if (isHttps && !base.httpsAgent) base.httpsAgent = A.directAgent;
  try {
    return await axios.request(base);
  } catch (e) {
    const p = A.warpProxy();
    if (!isHttps || !p || !A.retryable(e)) throw e;
    try {
      const r = await axios.request({ ...cfg, __viaWarp: true, httpsAgent: A.socksAgent(p), proxy: false });
      console.log(`[netAxios] via WARP ok: ${new URL(url).hostname}`);
      return r;
    } catch (_) { throw e; }          // asli (pehli) error dikhao
  }
}

const netAxios = (cfg) => request(cfg);
netAxios.request = request;
netAxios.get     = (url, cfg = {})       => request({ ...cfg, method: 'get',  url });
netAxios.head    = (url, cfg = {})       => request({ ...cfg, method: 'head', url });
netAxios.post    = (url, data, cfg = {}) => request({ ...cfg, method: 'post', url, data });
netAxios.create  = (...a) => axios.create(...a);     // custom instance: waise hi (koi badlaav nahi)
netAxios.isAxiosError = axios.isAxiosError;
/**
 * install() — bot ke SAARE axios.get/post (api.js, mediaDownloader.js, commands...) ko ek saath mazboot bana deta hai,
 * kisi file me line badle bina:  IPv4 + backup DNS, aur 503/403/timeout par WARP se dobara. Ek hi baar chalta hai.
 */
netAxios.install = function install() {
  if (axios.__netAxiosInstalled) return false;
  axios.__netAxiosInstalled = true;
  if (!axios.defaults.httpsAgent) axios.defaults.httpsAgent = A.directAgent;
  axios.interceptors.response.use((r) => r, async (e) => {
    const cfg = e && e.config;
    const p   = A.warpProxy();
    if (!cfg || cfg.__viaWarp || !p || !A.retryable(e)) throw e;
    const full = (cfg.baseURL && !/^https?:/i.test(cfg.url || '') ? cfg.baseURL : '') + (cfg.url || '');
    if (!/^https:/i.test(full)) throw e;
    try {
      const r = await axios.request({ ...cfg, __viaWarp: true, httpsAgent: A.socksAgent(p), proxy: false });
      console.log(`[netAxios] via WARP ok: ${new URL(full).hostname}`);
      return r;
    } catch (_) { throw e; }          // asli (pehli) error dikhao
  });
  console.log('[netAxios] installed (all axios calls: IPv4 + backup DNS + WARP retry)');
  return true;
};

module.exports = netAxios;
