// Ensure debug flags and logger exist immediately
window.DEBUG_DOWNLOADS = window.DEBUG_DOWNLOADS || false;
window.DEBUG_SUBTITLES = true;
window.dlog = window.dlog || function(...args) {
  if (window.DEBUG_DOWNLOADS) console.log(...args);
};
window.slog = function(...args) {
  if (window.DEBUG_SUBTITLES) console.log(`%c[TEXTTRACK]`, 'color: #ff00ff; font-weight: bold;', ...args);
};
var dlog = window.dlog;
var slog = window.slog;

// ── Persistent Logger ─────────────────────────────────────
const PersistentLogger = {
  logs: [],
  maxLogs: 500,
  storageKey: 'download_debug_logs',

  init() {
    const stored = localStorage.getItem(this.storageKey);
    if (stored) {
      try { this.logs = JSON.parse(stored); } catch (e) { this.logs = []; }
    }
    this.interceptNavigation();
  },

  log(message, data = null) {
    const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
    const entry = `[${timestamp}] ${message}`;
    const logObj = { timestamp, message, data };
    console.log(`%c${entry}`, 'color: #00ff00; font-weight: bold;', data || '');
    this.logs.push(logObj);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.logs)); } catch (e) {}
  },

  interceptNavigation() {
    const self = this;
    const originalReload = window.location.reload;
    window.location.reload = function(...args) {
      self.log('NAVIGATION ATTEMPT: window.location.reload');
      return originalReload.apply(window.location, args);
    };
    // Other interceptions (assign, replace, etc) can be added here if needed
  },

  dump() {
    return this.logs.map(l => `[${l.timestamp}] ${l.message} ${l.data ? JSON.stringify(l.data) : ''}`).join('\n');
  }
};

window.PersistentLogger = PersistentLogger;
window.dumpDebugLog = () => console.log(PersistentLogger.dump());
PersistentLogger.init();

// --- Backend Log Forwarding ---
if (window.electronAPI && window.electronAPI.onLogBatch) {
    window.electronAPI.onLogBatch((logs) => {
        logs.forEach(msg => {
            console.log("%c[MAIN]", 'color: #00ffff; font-weight: bold;', msg);
        });
    });
}
