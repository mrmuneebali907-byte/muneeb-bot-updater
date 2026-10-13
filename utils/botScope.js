'use strict';
// Which panel bot is handling the current message? (AsyncLocalStorage — safe with 5+ bots in one process)
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const idOf = (sock) => String(sock?.user?.id || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || 'default';
module.exports = {
  run: (sock, fn) => als.run({ id: idOf(sock) }, fn),
  id: () => (als.getStore() || {}).id || 'default',
  key: (k) => `${(als.getStore() || {}).id || 'default'}|${k}`,
  idOf,
};
