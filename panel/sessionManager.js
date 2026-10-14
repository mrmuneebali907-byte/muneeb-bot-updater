/**
 * Session Manager - Manages up to 50 independent WhatsApp bot sessions
 */

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const config = require('../config');
const handler = require('../handler');

const MAX_SESSIONS = Math.max(1, parseInt(process.env.MAX_BOTS, 10) || 8);   // OptikLink 1 GB: 8 bots is the safe limit (env MAX_BOTS overrides, e.g. on Railway)
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

// ── Cached Baileys version (fetch once, reuse for all sessions) ─────────────
let _cachedVersion = null;
let _versionFetchPromise = null;
async function getBaileysVersion() {
  if (_cachedVersion) return _cachedVersion;
  if (_versionFetchPromise) return _versionFetchPromise;
  _versionFetchPromise = (async () => {
    try {
      const { version } = await fetchLatestBaileysVersion();
      _cachedVersion = version;
      // Refresh the cache once every 6 hours in the background
      setTimeout(() => { _cachedVersion = null; _versionFetchPromise = null; }, 6 * 60 * 60 * 1000).unref();
      return version;
    } catch (e) {
      _versionFetchPromise = null;
      // Safe known-good fallback if the GitHub endpoint is rate-limited or down
      return [2, 3000, 1015901307];
    }
  })();
  return _versionFetchPromise;
}

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const SESSION_STATUS = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  QR_READY: 'qr_ready',
  PAIRING: 'pairing',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error'
};

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.MAX_SESSIONS = MAX_SESSIONS;
    this._loadPersistedSessions();
  }

  _loadPersistedSessions() {
    try {
      const metaFile = path.join(SESSIONS_DIR, 'sessions.json');
      if (fs.existsSync(metaFile)) {
        const data = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        for (const s of data) {
          this.sessions.set(s.id, {
            id: s.id,
            name: s.name || `Session ${s.id}`,
            status: SESSION_STATUS.IDLE,
            sock: null,
            qrData: null,
            qrImage: null,
            connectedNumber: s.connectedNumber || null,
            ownerNumber: s.ownerNumber || config.ownerNumber[0] || '',
            sessionPath: path.join(SESSIONS_DIR, `session_${s.id}`),
            createdAt: s.createdAt || Date.now(),
            autoRestart: s.autoRestart !== false,
            restartCount: 0,
            _pairingActive: false
          });
        }
        console.log(`[SessionManager] Loaded ${this.sessions.size} persisted sessions`);
      }
    } catch (e) {
      console.error('[SessionManager] Error loading sessions:', e.message);
    }
  }

  _persistSessions() {
    try {
      const metaFile = path.join(SESSIONS_DIR, 'sessions.json');
      const data = Array.from(this.sessions.values()).map(s => ({
        id: s.id,
        name: s.name,
        connectedNumber: s.connectedNumber,
        ownerNumber: s.ownerNumber,
        createdAt: s.createdAt,
        autoRestart: s.autoRestart
      }));
      fs.writeFileSync(metaFile, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[SessionManager] Error persisting sessions:', e.message);
    }
  }

  getSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      connectedNumber: s.connectedNumber,
      ownerNumber: s.ownerNumber,
      createdAt: s.createdAt,
      hasSession: fs.existsSync(path.join(s.sessionPath, 'creds.json'))
    }));
  }

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  createSession(name, ownerNumber) {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum ${MAX_SESSIONS} sessions reached`);
    }

    let id = 1;
    while (this.sessions.has(id)) id++;

    const session = {
      id,
      name: name || `Session ${id}`,
      status: SESSION_STATUS.IDLE,
      sock: null,
      qrData: null,
      qrImage: null,
      connectedNumber: null,
      ownerNumber: ownerNumber || config.ownerNumber[0] || '',
      sessionPath: path.join(SESSIONS_DIR, `session_${id}`),
      createdAt: Date.now(),
      autoRestart: true,
      restartCount: 0,
      _pairingActive: false
    };

    fs.mkdirSync(session.sessionPath, { recursive: true });
    this.sessions.set(id, session);
    this._persistSessions();
    this.emit('session:created', { id, name: session.name });
    return session;
  }

  async deleteSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');

    await this.stopSession(id);

    try {
      if (fs.existsSync(session.sessionPath)) {
        fs.rmSync(session.sessionPath, { recursive: true, force: true });
      }
    } catch (e) {
      console.error('[SessionManager] Error deleting session files:', e.message);
    }

    this.sessions.delete(id);
    this._persistSessions();
    this.emit('session:deleted', { id });
  }

  async stopSession(id) {
    const session = this.sessions.get(id);
    if (!session) return;

    session.autoRestart = false;
    session._pairingActive = false;

    if (session.sock) {
      try { session.sock.end(undefined); } catch (_) {}
      session.sock = null;
    }

    session.status = SESSION_STATUS.IDLE;
    session.qrData = null;
    session.qrImage = null;
    this.emit('session:status', { id, status: session.status });
  }

  async startSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');

    if (session.sock && session.status === SESSION_STATUS.CONNECTED) {
      return;
    }

    // Don't interrupt an active pairing attempt
    if (session._pairingActive) return;

    // Kill any existing socket cleanly before starting
    if (session.sock) {
      try { session.sock.end(undefined); } catch (_) {}
      session.sock = null;
    }

    session.autoRestart = true;
    session.status = SESSION_STATUS.CONNECTING;
    this.emit('session:status', { id, status: session.status });

    await this._connectSession(id);
  }

  /**
   * Request a pairing code for the given phone number.
   * Returns a Promise that resolves with the formatted code once Baileys delivers it.
   */
  requestPairCode(id, phoneNumber) {
    return new Promise(async (resolve, reject) => {
      const session = this.sessions.get(id);
      if (!session) return reject(new Error('Session not found'));

      const clean = phoneNumber.replace(/[^0-9]/g, '');
      if (!clean || clean.length < 7) return reject(new Error('Invalid phone number'));

      // Mark session as in pairing mode
      session._pairingActive = true;

      // Kill any existing socket so we start fresh
      if (session.sock) {
        try { session.sock.end(undefined); } catch (_) {}
        session.sock = null;
      }

      // Clear old session credentials so pairing doesn't get interrupted
      // by an existing registered session
      const credsFile = path.join(session.sessionPath, 'creds.json');
      if (fs.existsSync(credsFile)) {
        try {
          fs.rmSync(session.sessionPath, { recursive: true, force: true });
          fs.mkdirSync(session.sessionPath, { recursive: true });
        } catch (_) {}
      }

      // 30-second timeout
      const timer = setTimeout(() => {
        session._pairingActive = false;
        reject(new Error('Pairing code timed out. Please try again.'));
      }, 30000);

      try {
        await this._connectSessionForPairing(id, clean, (err, code) => {
          clearTimeout(timer);
          session._pairingActive = false;
          if (err) {
            reject(err);
          } else {
            resolve(code);
          }
        });
      } catch (e) {
        clearTimeout(timer);
        session._pairingActive = false;
        reject(e);
      }
    });
  }

  /**
   * Create a Baileys socket specifically for the pairing code flow.
   * The callback is fired with (err, code) once the code is available.
   */
  async _connectSessionForPairing(id, phoneNumber, callback) {
    const session = this.sessions.get(id);
    if (!session) return callback(new Error('Session not found'));

    try {
      fs.mkdirSync(session.sessionPath, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(session.sessionPath);
      const version = await getBaileysVersion();

      const logger = pino({ level: 'silent' });

      const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        // Browser tuple that works well with pairing code
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        auth: state,
        syncFullHistory: false,
        downloadHistory: false,
        markOnlineOnConnect: false,
        getMessage: async () => undefined
      });

      session.sock = sock;
      session.status = SESSION_STATUS.CONNECTING;
      this.emit('session:status', { id, status: session.status });

      let codeDelivered = false;

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ── QR event is the RIGHT moment to call requestPairingCode ──────────
        if (qr && !codeDelivered) {
          try {
            console.log(`[Session ${id}] 🔢 Requesting pairing code for ${phoneNumber}...`);
            const rawCode = await sock.requestPairingCode(phoneNumber);
            if (!rawCode) throw new Error('Empty code returned');

            codeDelivered = true;
            const formatted = rawCode.match(/.{1,4}/g)?.join('-') || rawCode;
            console.log(`[Session ${id}] ✅ Pairing code: ${formatted}`);

            session.status = SESSION_STATUS.PAIRING;
            this.emit('session:status', { id, status: session.status });
            this.emit('session:paircode', { id, code: formatted });
            callback(null, formatted);
          } catch (e) {
            console.error(`[Session ${id}] ❌ Pairing code error:`, e.message);
            if (!codeDelivered) {
              codeDelivered = true;
              callback(new Error('Failed to get pairing code: ' + e.message));
            }
          }
          return; // Don't process QR image when in pairing mode
        }

        // ── Successfully connected after pairing ─────────────────────────────
        if (connection === 'open') {
          session._pairingActive = false;
          session.status = SESSION_STATUS.CONNECTED;
          session.qrData = null;
          session.qrImage = null;
          session.restartCount = 0;
          session._downSince = null;
          session._connectingSince = null;

          const phoneNum = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || '';
          session.connectedNumber = phoneNum;
          // Never auto-assign connected number as owner — owner is fixed in config

          this._persistSessions();
          this.emit('session:connected', { id, number: phoneNum, name: sock.user?.name || '' });
          this.emit('session:status', { id, status: session.status });
          console.log(`[Session ${id}] ✅ Connected as ${phoneNum}`);

          try { handler.initializeAntiCall(sock); } catch (_) {}

          // Wire up message handling now that we're connected
          sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
              if (!msg.message || !msg.key?.id) continue;
              const from = msg.key.remoteJid;
              // Allow status@broadcast and newsletter posts. The handler only
              // performs the explicitly configured per-channel reaction for
              // newsletters; normal commands/automation remain blocked there.
              if (!from || (from.includes('@broadcast') && from !== 'status@broadcast')) continue;
              const age = msg.messageTimestamp ? Date.now() - (msg.messageTimestamp * 1000) : 0;
              if (age > 5 * 60 * 1000) continue;
              handler.handleMessage(sock, msg, this._getSessionConfig(session)).catch(e => {
                if (!e.message?.includes('rate-overlimit') && !e.message?.includes('not-authorized')) {
                  console.error(`[Session ${id}] Message error:`, e.message);
                }
              });
            }
          });

          sock.ev.on('group-participants.update', async (update) => {
            try { await handler.handleGroupUpdate(sock, update); } catch (_) {}
          });

          return;
        }

        // ── Connection closed ─────────────────────────────────────────────────
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          session.sock = null;

          if (codeDelivered) {
            // After the user enters the code in WhatsApp, the server:
            //   1. Sends credentials via creds.update (saveCreds saves them to disk)
            //   2. Closes the pairing WebSocket
            // We MUST reconnect with the new credentials to complete login.
            const credsFile = path.join(session.sessionPath, 'creds.json');
            if (fs.existsSync(credsFile)) {
              console.log(`[Session ${id}] 🔄 Code accepted — reconnecting with saved credentials...`);
              session._pairingActive = false;
              session.status = SESSION_STATUS.CONNECTING;
              this.emit('session:status', { id, status: session.status });
              setTimeout(() => {
                this._connectSession(id).catch(e =>
                  console.error(`[Session ${id}] Post-pairing reconnect error:`, e.message)
                );
              }, 1500);
            } else {
              // Credentials not saved yet — user hasn't entered the code yet or
              // WhatsApp hasn't sent them. Stay in PAIRING state and wait.
              console.log(`[Session ${id}] Connection closed (awaiting code entry, no creds yet)`);
              session.status = SESSION_STATUS.PAIRING;
              this.emit('session:status', { id, status: session.status });
            }
            return;
          }

          // Code was never delivered — genuine failure
          session.status = SESSION_STATUS.DISCONNECTED;
          this.emit('session:status', { id, status: session.status });
          this.emit('session:disconnected', { id, statusCode });
          codeDelivered = true; // prevent double-call
          callback(new Error('Connection closed before pairing code. Please try again.'));
        }
      });

      sock.ev.on('creds.update', saveCreds);

    } catch (e) {
      console.error(`[Session ${id}] Pairing setup error:`, e.message);
      callback(e);
    }
  }

  // ── Normal QR-based connection ─────────────────────────────────────────────

  async _connectSession(id) {
    const session = this.sessions.get(id);
    if (!session) return;

    // Never start a normal connection while pairing is active
    if (session._pairingActive) return;

    try {
      fs.mkdirSync(session.sessionPath, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(session.sessionPath);
      const version = await getBaileysVersion();

      const logger = pino({ level: 'silent' });

      const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        auth: state,
        syncFullHistory: false,
        downloadHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined
      });

      // Track which "generation" of socket this is, so stale callbacks can self-detect
      session._socketGen = (session._socketGen || 0) + 1;
      const gen = session._socketGen;

      session.sock = sock;
      session.status = SESSION_STATUS.CONNECTING;

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          session.status = SESSION_STATUS.QR_READY;
          session.qrData = qr;
          try {
            session.qrImage = await QRCode.toDataURL(qr, {
              errorCorrectionLevel: 'M',
              type: 'image/png',
              margin: 2,
              scale: 6
            });
          } catch (_) {
            session.qrImage = null;
          }
          this.emit('session:qr', { id, qr: session.qrImage });
          this.emit('session:status', { id, status: session.status });
        }

        if (connection === 'open') {
          session.status = SESSION_STATUS.CONNECTED;
          session.qrData = null;
          session.qrImage = null;
          session.restartCount = 0;
          session._downSince = null;
          session._connectingSince = null;

          const phoneNum = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || '';
          session.connectedNumber = phoneNum;
          // Never auto-assign connected number as owner — owner is fixed in config

          this._persistSessions();
          this.emit('session:connected', { id, number: phoneNum, name: sock.user?.name || '' });
          this.emit('session:status', { id, status: session.status });
          console.log(`[Session ${id}] ✅ Connected as ${phoneNum}`);

          try { handler.initializeAntiCall(sock); } catch (_) {}

          // ── Wire up message handling ──────────────────────────────────────
          sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
              if (!msg.message || !msg.key?.id) continue;
              const from = msg.key.remoteJid;
              // Allow status@broadcast and newsletter posts. The handler only
              // performs the explicitly configured per-channel reaction for
              // newsletters; normal commands/automation remain blocked there.
              if (!from || (from.includes('@broadcast') && from !== 'status@broadcast')) continue;
              const age = msg.messageTimestamp ? Date.now() - (msg.messageTimestamp * 1000) : 0;
              if (age > 5 * 60 * 1000) continue;
              handler.handleMessage(sock, msg, this._getSessionConfig(session)).catch(e => {
                if (!e.message?.includes('rate-overlimit') && !e.message?.includes('not-authorized')) {
                  console.error(`[Session ${id}] Message error:`, e.message);
                }
              });
            }
          });

          // Pre-warm group metadata cache — eliminates 300ms cold-start on first group message
          setTimeout(async () => {
            try {
              const groups = await sock.groupFetchAllParticipating();
              if (handler.preWarmGroupCache) handler.preWarmGroupCache(groups);
              console.log(`[Session ${id}] ♨️ Pre-warmed ${Object.keys(groups).length} group(s)`);
            } catch (_) {}
          }, 3000);
        }

        if (connection === 'close') {
          // Stale-callback guard: if a newer socket has been created for this
          // session, ignore close events from the old one to prevent reconnect storms.
          if (gen !== session._socketGen) return;

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isTerminal = statusCode === DisconnectReason.loggedOut || statusCode === 403;

          session.status = SESSION_STATUS.DISCONNECTED;
          session.sock = null;
          this.emit('session:status', { id, status: session.status });
          this.emit('session:disconnected', { id, statusCode });

          console.log(`[Session ${id}] Connection closed (${statusCode})`);

          if (isTerminal) {
            session.connectedNumber = null;

            // ── Clear stale/invalid credentials ────────────────────────────
            // Without this, the watchdog sees hasCreds===true forever and
            // keeps force-reconnecting every 90s, which immediately gets
            // another 401 → infinite loop (idle → reconnect → 401 → idle...).
            // Wiping the creds makes hasCreds===false, so the watchdog's own
            // "never auto-start sessions that have never been paired" guard
            // permanently skips this session until the user re-pairs it.
            try {
              fs.rmSync(session.sessionPath, { recursive: true, force: true });
              fs.mkdirSync(session.sessionPath, { recursive: true });
              console.log(`[Session ${id}] 🗑️ Terminal disconnect (${statusCode}) — cleared stale credentials, needs fresh QR/pairing to reconnect`);
            } catch (e) {
              console.error(`[Session ${id}] Failed to clear stale credentials:`, e.message);
            }

            session.status = SESSION_STATUS.IDLE;
            this._persistSessions();
            this.emit('session:status', { id, status: session.status });
            return;
          }

          // Reconnect with REAL capped exponential backoff — prevents hammering
          // the server/network when a session keeps failing rapidly (e.g. 408
          // timeouts). Without this, a persistently-failing session retries
          // every 1.5-3s forever, which can overload the process enough to
          // make the tunnel's own health-check fail too.
          if (session.autoRestart && !session._pairingActive) {
            session.restartCount = (session.restartCount || 0) + 1;
            const isStreamError = statusCode === 515;
            const baseDelay = isStreamError ? 1500 : 3000;
            const maxDelay  = 60000; // never wait longer than 60s between attempts
            const delay = Math.min(baseDelay * Math.pow(2, session.restartCount - 1), maxDelay);
            console.log(`[Session ${id}] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt #${session.restartCount})...`);
            setTimeout(() => {
              if (session.autoRestart && !session._pairingActive && session._socketGen === gen) {
                this._connectSession(id).catch(e =>
                  console.error(`[Session ${id}] Reconnect error:`, e.message)
                );
              }
            }, delay);
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);
sock.ev.on('group-participants.update', async (update) => {
        try { await handler.handleGroupUpdate(sock, update); } catch (_) {}
      });

    } catch (e) {
      console.error(`[Session ${id}] Connection setup error:`, e.message);
      session.status = SESSION_STATUS.ERROR;
      this.emit('session:error', { id, error: e.message });
      this.emit('session:status', { id, status: session.status });
    }
  }

  _getSessionConfig(session) {
    // Cache per-session — avoid spreading the full config object on every message
    if (!session._configCache) {
      session._configCache = { ...config, sessionPath: session.sessionPath };
    }
    return session._configCache;
  }

  autoStartSessions() {
    for (const [id, session] of this.sessions.entries()) {
      const hasCredentials = fs.existsSync(path.join(session.sessionPath, 'creds.json'));
      if (hasCredentials && session.autoRestart) {
        console.log(`[SessionManager] Auto-starting session ${id} (${session.name})`);
        setTimeout(() => {
          this.startSession(id).catch(e =>
            console.error(`[SessionManager] Auto-start error for ${id}:`, e.message)
          );
        }, id * 2000);
      }
    }

    // Start the global watchdog once (auto-recovery)
    this.startWatchdog();
  }

  /**
   * Watchdog — runs every 60 s and auto-heals broken sessions.
   *  - Sessions with creds.json that report DISCONNECTED/ERROR but autoRestart is on
   *    are forced back online.
   *  - Sessions stuck in CONNECTING for >5 min are force-restarted.
   *  - Sessions whose socket WebSocket has died but status still says CONNECTED
   *    are reset and reconnected.
   */
  startWatchdog() {
    if (this._watchdogTimer) return;
    console.log('[SessionManager] 🐕 Watchdog started (60 s interval)');

    this._watchdogTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions.entries()) {
        try {
          if (!session.autoRestart) continue;
          if (session._pairingActive) continue;

          const hasCreds = fs.existsSync(path.join(session.sessionPath, 'creds.json'));
          if (!hasCreds) continue; // never auto-start sessions that have never been paired

          const status = session.status;
          const sock   = session.sock;

          // Case 1: status DISCONNECTED/ERROR/IDLE for >90 s with saved creds → reconnect
          // (gives the close handler's own timer time to run first; this is the
          // second-line recovery only)
          if ([SESSION_STATUS.DISCONNECTED, SESSION_STATUS.ERROR, SESSION_STATUS.IDLE].includes(status)) {
            session._downSince = session._downSince || now;
            if (now - session._downSince > 90 * 1000) {
              console.log(`[Watchdog] Session ${id} has been ${status} >90s → forcing reconnect`);
              session._downSince = null;
              this._connectSession(id).catch(e =>
                console.error(`[Watchdog] Session ${id} reconnect error:`, e.message)
              );
            }
            continue;
          }
          session._downSince = null;

          // Case 2: CONNECTED — Baileys manages its own keepalive and will emit
          // 'connection.update' with connection:'close' if the socket dies.
          // We do NOT prod it here to avoid spurious reconnect storms.
          if (status === SESSION_STATUS.CONNECTED) continue;

          // Case 3: stuck in CONNECTING for >5 min → force restart
          if (status === SESSION_STATUS.CONNECTING) {
            session._connectingSince = session._connectingSince || now;
            if (now - session._connectingSince > 5 * 60 * 1000) {
              console.log(`[Watchdog] Session ${id} stuck in CONNECTING for >5min → forcing reset`);
              try { sock?.end?.(undefined); } catch (_) {}
              session.sock = null;
              session.status = SESSION_STATUS.DISCONNECTED;
              session._connectingSince = null;
              this._connectSession(id).catch(e =>
                console.error(`[Watchdog] Session ${id} reconnect error:`, e.message)
              );
            }
          } else {
            session._connectingSince = null;
          }
        } catch (e) {
          console.error(`[Watchdog] Error checking session ${id}:`, e.message);
        }
      }
    }, 60 * 1000).unref();
  }
}

module.exports = new SessionManager();
module.exports.SESSION_STATUS = SESSION_STATUS;
