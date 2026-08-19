if (typeof window.DEBUG_DOWNLOADS === 'undefined') {
  window.DEBUG_DOWNLOADS = true;
}

// Define dlog globally
window.dlog = window.dlog || function(...args) {
  if (window.DEBUG_DOWNLOADS) console.log(...args);
};
var dlog = window.dlog;

// Initialize Download Manager EARLY to prevent "undefined" errors during loading
window.activeDownloads = new Map();
window.downloadManager = window.activeDownloads;
const downloadManager = window.activeDownloads;

// ── Logging Layer ─────────────────────────────────────────
// Persistence logic moved to js/core/persistence.js

/**
 * NORMALIZE TASK: Converts legacy task structure to new sectioned model.
 */
function normalizeTask(item) {
    if (!item) return null;
    if (item.taskId && item.discovery && item.media && item.progress) {
        // Ensure runtime transients are initialized
        if (item.startTime === undefined) item.startTime = Date.now();
        if (item.speed === undefined) item.speed = 0;
        if (item.eta === undefined) item.eta = 0;
        if (item.pendingWrites === undefined) item.pendingWrites = 0;
        return item;
    }

    const persistentOffset = (item.diskBytes !== undefined) ? item.diskBytes : (item.lastOffset || 0);
    const safeState = item.state === 'completed' ? 'completed' : (item.state === 'error' ? 'error' : 'paused');

    return {
        taskId: item.taskId || item.uniqueId || `vault_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`,
        discovery: {
            providerId: item.chatId || item.discovery?.providerId || "0",
            providerName: item.addon || item.discovery?.providerName || "Unknown",
            lookupToken: item.startParameter || item.lookupToken || item.discovery?.lookupToken || null,
            chatId: item.chatId || item.discovery?.chatId || "0",
            messageId: item.itemId || item.discovery?.messageId || "0",
            botUsername: item.botUsername || item.discovery?.botUsername || null
        },
        telegram: {
            fileId: item.fileId || item.telegram?.fileId || null,
            remoteId: item.remoteId || item.telegram?.remoteId || null,
            telegramUniqueId: item.uniqueId || item.telegram?.telegramUniqueId || null,
            originalFileId: item.originalFileId || item.telegram?.originalFileId || null
        },
        media: {
            tmdbId: item.tmdbId || item.media?.tmdbId || null,
            season: item.season || item.media?.season || null,
            episode: item.episode || item.media?.episode || null,
            fileName: item.fileName || item.media?.fileName || "video.mp4",
            totalSize: item.totalSize || item.media?.totalSize || 0,
            type: item.type || item.media?.type || "movie",
            poster: item.poster || item.media?.poster || null,
            backdrop: item.backdrop || item.media?.backdrop || null,
            sub: item.sub || item.media?.sub || null,
            g: item.g || item.media?.g || null
        },
        progress: {
            networkBytes: item.networkBytes || item.progress?.networkBytes || 0,
            diskBytes: item.diskBytes || item.progress?.diskBytes || 0,
            lastOffset: persistentOffset,
            state: safeState,
            identityStatus: item.identityStatus || 'RESTORED',
            lastVerified: item.lastVerified || Date.now(),
            savePath: item.savePath || item.progress?.savePath || null,
            fileHandle: item.fileHandle || item.progress?.fileHandle || null
        },
        startTime: item.startTime || Date.now(),
        speed: 0,
        eta: 0,
        pendingWrites: 0
    };
}

window.normalizeTask = normalizeTask;

async function loadDownloadsFromStorage() {
  const data = window.DownloadPersistence ? window.DownloadPersistence.loadRawDownloads() : [];
  if (data.length === 0) return;

  try {
    data.forEach(item => {
      const entry = normalizeTask(item);
      const existing = Array.from(window.downloadManager.values()).find(e => e.taskId === entry.taskId);
      if (existing) return;

      const safeChatId = entry.discovery.chatId;
      const safeItemId = entry.discovery.messageId;
      const fileId = entry.telegram.fileId;
      const uniqueId = entry.telegram.telegramUniqueId;
      const lookupToken = entry.discovery.lookupToken;

      const taskIdentity = window.getTaskIdentity(safeChatId, lookupToken);

      if (taskIdentity) window.downloadManager.set(taskIdentity, entry);
      if (lookupToken) window.downloadManager.set(String(lookupToken), entry);

      const key = `${safeChatId}_${safeItemId}_${fileId}`;
      if (!window.downloadManager.has(key)) window.downloadManager.set(key, entry);

      if (fileId) window.downloadManager.set(String(fileId), entry);
      if (uniqueId) window.downloadManager.set(String(uniqueId), entry);
      if (entry.telegram.originalFileId) window.downloadManager.set(String(entry.telegram.originalFileId), entry);
      if (entry.taskId) window.downloadManager.set(String(entry.taskId), entry);

      if (entry.media.fileName && entry.media.totalSize) {
          const fingerprint = `${entry.media.fileName}_${entry.media.totalSize}`;
          window.downloadManager.set(fingerprint, entry);
      }
    });

    const syncState = async () => {
        if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
            setTimeout(syncState, 500);
            return;
        }

        const channel = new MessageChannel();
        const swCheckPromise = new Promise(resolve => {
            const timeout = setTimeout(() => resolve({}), 1000);
            channel.port1.onmessage = (e) => {
                clearTimeout(timeout);
                if (e.data.type === 'ALIVE_STREAMS_VERBOSE') resolve(e.data.streams || {});
            };
            navigator.serviceWorker.controller.postMessage({ type: 'CHECK_STREAMS_VERBOSE' }, [channel.port2]);
        });

        const activeStreamsMap = await swCheckPromise;

        for (const entry of new Set(window.downloadManager.values())) {
            if (entry.progress.state === 'completed') continue;

            const numericId = Number(entry.telegram.fileId);
            const isValidId = !isNaN(numericId) && numericId !== 0;

            if (window.electronAPI && entry.progress.savePath) {
                try {
                    const verification = await window.electronAPI.verifyAndResumeFile({
                        fileId: entry.telegram.fileId,
                        savePath: entry.progress.savePath,
                        lastOffset: entry.progress.lastOffset
                    });

                    if (verification.success) {
                        entry.progress.lastOffset = verification.verifiedOffset;
                        dlog(`[SYNC] Disk verified for ${entry.telegram.fileId} at ${entry.progress.lastOffset}`);
                    } else if (verification.error === 'MISSING') {
                        entry.progress.state = 'error';
                        entry.progress.error = 'File missing on disk';
                        continue;
                    }
                } catch (e) { console.error("[SYNC] Disk verification failed", e); }
            }

            if (!window.tdClient) continue;
            try {
                let file = null;
                entry.progress.identityStatus = 'RESOLVING';

                try {
                    if (!isValidId) throw new Error("STALE_PLACEHOLDER_ID");
                    file = await window.tdClient.send({ '@type': 'getFile', 'file_id': numericId });
                } catch (e) {
                    dlog(`[SYNC] ID ${entry.telegram.fileId} stale in TDLib. Re-binding...`);
                    const freshId = await rebindFile(entry);
                    if (freshId && freshId !== "PENDING_REGEN") {
                        file = await window.tdClient.send({ '@type': 'getFile', 'file_id': Number(freshId) });
                    }
                }

                if (file && file.local) {
                    const isResolved = file.remote && (String(file.remote.unique_id) === String(entry.telegram.telegramUniqueId));

                    if (isResolved) {
                        entry.progress.identityStatus = 'BOUND';
                        entry.progress.lastVerified = Date.now();
                        entry.media.totalSize = file.size;
                        entry.progress.networkBytes = file.local.downloaded_size;
                        entry.progress.isNetworkDone = file.local.is_downloading_completed;
                    } else {
                        dlog(`[SYNC] Identity mismatch for ${entry.media.fileName}. Keeping DB snapshot.`);
                    }

                    if (entry.progress.state === 'downloading' && entry.progress.identityStatus === 'BOUND' && !entry.progress.isPaused) {
                        window.tdClient.send({
                            "@type": "downloadFile",
                            "file_id": Number(entry.telegram.fileId),
                            "priority": 32,
                            "offset": 0,
                            "limit": 0,
                            "synchronous": false
                        });
                    }

                    const el = document.getElementById('saved-item-' + entry.discovery.messageId);
                    if (el && typeof renderSavedItemOverlay === 'function') renderSavedItemOverlay(el, entry);
                }
            } catch (e) { console.error("[SYNC ERROR]", e); }
        }
        if (typeof updateMainDownloadButton === 'function') updateMainDownloadButton();
    };
    syncState();
  } catch (e) { console.error("[DOWNLOAD] Persistence error", e); }
}

// Register Service Worker for streaming downloads
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(registration => {
    dlog('[STREAM] Service Worker registered');
  }).catch(err => {
    console.error('[SW ERROR] Service Worker registration failed:', err);
  });

  // ── Graceful Shutdown Pipeline ─────────────────────────────────────
  if (window.electronAPI && window.electronAPI.onPrepareShutdown) {
    window.electronAPI.onPrepareShutdown(async () => {
      dlog('[SYSTEM] prepare-for-shutdown received. Orchestrating async flush...');

      try {
        // Step 1: Flush Service Worker with acknowledgment via MessageChannel
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          const channel = new MessageChannel();
          const swFlushPromise = new Promise(resolve => {
            const timeout = setTimeout(resolve, 3000); // 3-second defensive fallback
            channel.port1.onmessage = (e) => {
              if (e.data.type === 'FLUSH_COMPLETE') {
                clearTimeout(timeout);
                resolve();
              }
            };
            navigator.serviceWorker.controller.postMessage({ type: 'FLUSH_AND_CLOSE_ALL' }, [channel.port2]);
          });
          await swFlushPromise;
          dlog('[SYSTEM] Service Worker flush confirmed.');
        }

        // Step 2: Await Mid-Air IPC Writes (Block until pipeline is empty)
        const waitForPendingWrites = async () => {
          const check = () => {
            let total = 0;
            // Guard against duplicate references in map indexing
            const entries = new Set(window.downloadManager.values());
            for (const entry of entries) {
              total += (entry.pendingWrites || 0);
            }
            return total === 0;
          };

          if (check()) return;
          dlog('[SYSTEM] Waiting for mid-flight IPC disk writes to settle...');

          return new Promise(resolve => {
            const start = Date.now();
            const interval = setInterval(() => {
              // Enforce a 5-second maximum safety bound to prevent freezing the window
              if (check() || (Date.now() - start > 5000)) {
                clearInterval(interval);
                resolve();
              }
            }, 50); // High-frequency polling (50ms) for snappy shutdown
          });
        };
        await waitForPendingWrites();
        dlog('[SYSTEM] All in-flight disk writes finalized.');

        // Step 3: Snapshot State (Offsets are now guaranteed to be completely accurate)
        window.saveDownloadsToStorage();
        dlog('[SYSTEM] Final state snapshot committed to localStorage.');

        // Step 4: Signal Final Exit to the Main Process
        await window.electronAPI.signalShutdownReady();
      } catch (err) {
        console.error('[SYSTEM] Critical error during graceful shutdown orchestration:', err);
        // Fail-safe: Always invoke signalShutdownReady so the user window isn't left hanging
        window.electronAPI.signalShutdownReady().catch(() => {});
      }
    });
  }

  window.addEventListener('beforeunload', (event) => {
    // Only used for browser-only mode or fallback execution contexts
    if (!window.electronAPI) {
        window.saveDownloadsToStorage();
    }
  });

  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data.type === 'STREAM_PROGRESS') {
      const { fileId, size, speed } = event.data;
      const entry = window.downloadManager.get(String(fileId));
      if (entry) {
        entry.media.totalSize = size;
        entry.speed = speed;

        if (size > 0) {
          entry.progress.percent = Math.round(((entry.progress.networkBytes || 0) / size) * 100);
          entry.eta = speed > 0 ? (size - (entry.progress.networkBytes || 0)) / speed : 0;
        }

        if (size > 0 && (entry.progress.networkBytes || 0) >= size && entry.progress.isNetworkDone) {
          entry.progress.state = 'completed';
          if (entry.iframe) { entry.iframe.remove(); entry.iframe = null; }
          if (window.electronAPI && entry.progress.savePath) {
            window.electronAPI.closeFile(entry.progress.savePath).catch(() => {});
          }
          window.saveDownloadsToStorage();
        }

        throttleUIUpdate(entry);
      }
    }
  });
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') { if(typeof closeDetail === 'function') closeDetail(); if(typeof closeSaved === 'function') closeSaved(); } });

// Initial render
document.addEventListener('DOMContentLoaded', async () => {
  await loadDownloadsFromStorage();
  await restoreDownloadUI();
  if (typeof loadCatalog === 'function') loadCatalog();
  else if (typeof renderHome === 'function') renderHome();
});

/**
 * BULLETPROOF FILE RESOLUTION ENGINE
 * Inspired by Android Telegram's rehydration system.
 * Tries increasingly aggressive methods to find a valid session fileId.
 */
async function refreshEntryId(entry) {
  if (!window.tdClient) return null;

  console.log(`[RESOLVER] Pipeline started for: ${entry.media.fileName} (CurrentID: ${entry.telegram.fileId})`);

  const currentFileId = String(entry.telegram.fileId || "");
  const isNumericId = /^-?\d+$/.test(currentFileId);

  // --- STAGE 1: Remote Identity ---
  if (entry.telegram.remoteId) {
    try {
      const file = await window.tdClient.send({
        '@type': 'getRemoteFile',
        'remote_file_id': entry.telegram.remoteId
      });
      if (file && file.id) {
        const newId = String(file.id);
        console.log(`[RESOLVER] STAGE 1 SUCCESS: Found via RemoteID -> ${newId}`);
        updateEntryIdMapping(entry, newId);
        return newId;
      }
    } catch (e) {
      console.warn(`[RESOLVER] Stage 1 Failed: ${e.message}`);
    }
  }

  // --- STAGE 2: Contextual Rehydration ---
  const cidStr = String(entry.discovery.chatId || "");
  const midStr = String(entry.discovery.messageId || "");
  const cid = (cidStr && cidStr !== '0' && /^-?\d+$/.test(cidStr)) ? Number(cidStr) : null;
  const mid = (midStr && midStr !== '0' && /^-?\d+$/.test(midStr)) ? Number(midStr) : null;

  if (cid && mid) {
    try {
      await window.tdClient.send({ '@type': 'getChat', 'chat_id': cid }).catch(() => {});
      await window.tdClient.send({
          '@type': 'getChatHistory',
          'chat_id': cid,
          'from_message_id': mid,
          'offset': -5,
          'limit': 10,
          'only_local': false
      }).catch(() => {});

      let msg = null;
      let attempts = 0;
      while (attempts < 3 && !msg) {
          try {
              msg = await window.tdClient.send({ '@type': 'getMessage', 'chat_id': cid, 'message_id': mid });
          } catch (e) {
              if (e.message.includes("not found")) {
                  await new Promise(r => setTimeout(r, 500));
                  attempts++;
              } else throw e;
          }
      }

      if (msg && msg.content) {
          let newId = null;
          let remote = null;
          if (msg.content.video) {
              newId = String(msg.content.video.video.id);
              remote = msg.content.video.video.remote;
          } else if (msg.content.document) {
              newId = String(msg.content.document.document.id);
              remote = msg.content.document.document.remote;
          }

          if (newId) {
              console.log(`[RESOLVER] STAGE 2 SUCCESS: Found via Message -> ${newId}`);
              if (remote && remote.id) entry.telegram.remoteId = remote.id;
              updateEntryIdMapping(entry, newId);
              return newId;
          }
      }
    } catch (e) {
      console.warn(`[RESOLVER] Stage 2 Failed: ${e.message}`);
    }
  }

  // --- STAGE 3: Bot Regeneration ---
  if (entry.discovery.lookupToken && entry.discovery.botUsername) {
    console.log(`[RESOLVER] STAGE 3: Attempting Bot Re-request (@${entry.discovery.botUsername})`);
    try {
      if (typeof handleSourceClick === 'function') {
          const sourceStub = {
              uniqueId: entry.telegram.telegramUniqueId,
              fileName: entry.media.fileName,
              addonId: entry.discovery.chatId,
              startParameter: entry.discovery.lookupToken,
              botUsername: entry.discovery.botUsername,
              fromCache: true
          };
          handleSourceClick(sourceStub, false);
          return "PENDING_REGEN";
      }
    } catch (e) {
      console.error(`[RESOLVER] Stage 3 Failed: ${e.message}`);
    }
  }

  if (!isNumericId) {
      console.error(`[RESOLVER] FATAL: All resolution stages failed for ${entry.media.fileName}. ID is non-numeric: ${currentFileId}`);
      return null;
  }

  console.log(`[RESOLVER] Recovery stages exhausted. Falling back to numeric ID: ${currentFileId}`);
  return currentFileId;
}

/**
 * BULLETPROOF REBINDING ENGINE (Stage 4 + Stabilization Gate)
 * Ensures that before every download restart, we always obtain a
 * fresh, session-valid and STABILIZED TDLib file object.
 */
async function rebindFile(entry) {
    console.log(`[REBIND] Pipeline started for: ${entry.media.fileName}`);

    entry._lastFile = null;

    const sessionId = await refreshEntryId(entry);

    if (!sessionId) return null;
    if (sessionId === "PENDING_REGEN") return "PENDING_REGEN";

    try {
        const numericSessionId = Number(sessionId);
        if (isNaN(numericSessionId) || numericSessionId === 0) {
             throw new Error(`Invalid session ID resolved: ${sessionId}`);
        }

        let freshFile = await window.tdClient.send({
            '@type': 'getFile',
            'file_id': numericSessionId
        });

        if (freshFile && freshFile.id) {
            let attempts = 0;
            while (attempts < 5 && (!freshFile.local || !freshFile.local.can_be_downloaded)) {
                console.log(`[REBIND] Waiting for file stabilization...`);
                await new Promise(r => setTimeout(r, 250));
                freshFile = await window.tdClient.send({ '@type': 'getFile', 'file_id': freshFile.id });
                attempts++;
            }

            console.log(`[REBIND] SUCCESS: Bound session object ${freshFile.id}`);

            entry.telegram.fileId = String(freshFile.id);
            entry._lastFile = freshFile;
            entry.media.totalSize = freshFile.size;

            if (freshFile.remote && freshFile.remote.id) {
                entry.telegram.remoteId = freshFile.remote.id;
            }

            updateEntryIdMapping(entry, entry.telegram.fileId);

            return entry.telegram.fileId;
        }
    } catch (e) {
        console.error(`[REBIND] FAILED: TDLib rejected resolved ID ${sessionId}: ${e.message}`);
    }
    return null;
}

function updateEntryIdMapping(entry, newId) {
    const oldId = String(entry.telegram.fileId);
    entry.telegram.fileId = String(newId);

    window.downloadManager.set(entry.telegram.fileId, entry);

    const safeChatId = entry.discovery.chatId || '0';
    const safeItemId = entry.discovery.messageId || '0';
    const newStreamKey = `${safeChatId}_${safeItemId}_${newId}`;
    window.downloadManager.set(newStreamKey, entry);
}

function sendDownloadRequest(fileId, offset = 0) {
  // Legacy function removed in Phase 3
  return;
}

async function processDownloadChunks(fileId, fileObject = null) {
  // Legacy function removed in Phase 3
  return;
}

function throttleUIUpdate(entry) {
  const now = Date.now();

  // CENTRAL SPEED SAMPLING
  if (!entry._speedSamples) entry._speedSamples = [];
  const currentBytes = Math.max(entry.progress.diskBytes || 0, entry.progress.streamedBytes || 0, entry.progress.networkBytes || 0);

  if (entry._speedSamples.length === 0 || entry._speedSamples[entry._speedSamples.length-1].b !== currentBytes) {
      entry._speedSamples.push({ t: now, b: currentBytes });
  }
  while (entry._speedSamples.length > 2 && now - entry._speedSamples[0].t > 3000) {
      entry._speedSamples.shift();
  }

  if (entry._lastUIUpdate && (now - entry._lastUIUpdate < 100)) return;
  entry._lastUIUpdate = now;

  const el = document.getElementById('saved-item-' + entry.discovery.messageId);
  if (el && typeof renderSavedItemOverlay === 'function') {
    renderSavedItemOverlay(el, entry);
  }
  if (typeof updateMainDownloadButton === 'function') {
    updateMainDownloadButton();
  }
}

// --- ARCHITECTURAL FLAGS ---
window.PLAYBACK_MODE = "legacy-sw"; // "legacy-sw" | "tdlib-local"
window.USE_DIRECT_STREAM = true;   // If true, uses Electron native fs streaming via 127.0.0.1:3301
window.ENABLE_LEGACY_PLAYBACK = false; // Phase 2A: Disable manual chunk pumping and SW registration

function handleFileUpdate(update) {
  if (update['@type'] !== 'updateFile' || !update.file) return;
  const f = update.file;

  let entry = null;
  // Primary lookup: Current session fileId
  for (const e of window.downloadManager.values()) {
      if (e.telegram && String(e.telegram.fileId) === String(f.id)) {
          entry = e;
          break;
      }
  }

  // Fingerprint Fallback
  if (!entry && f.local && f.local.path) {
      const fileName = f.local.path.split(/[/\\]/).pop();
      const fingerprint = `${fileName}_${f.size}`;
      entry = window.downloadManager.get(fingerprint);
      if (entry) {
          console.log(`[SYNC] Fingerprint match for TDLib update: ${fileName}`);
          entry.telegram.fileId = f.id;
          window.downloadManager.set(String(f.id), entry);
      }
  }

  if (!entry) return;

  // GHOST RULE
  if (entry.progress.state === 'completed' || entry.progress.state === 'finalizing') return;

  // --- CONFIDENCE CLASSIFICATION ENGINE ---
  const isResolved = f.remote && f.remote.id && (String(f.remote.unique_id) === String(entry.telegram.telegramUniqueId) || String(f.remote.id) === String(entry.telegram.remoteId));
  const isCorrectSize = entry.media.totalSize > 1024 * 1024 ? (f.size > 1024 * 1024) : true;

  if (!isResolved && f.size < 1024 * 1024 && entry.media.totalSize > 1024 * 1024) {
      console.warn(`[SYNC] Low confidence update for ${entry.media.fileName}. Holding RESTORED state.`);
      return;
  }

  if (isResolved && isCorrectSize) {
      if (entry.progress.identityStatus !== 'BOUND') {
          console.log(`[SYNC] Identity BOUND for ${entry.media.fileName}`);
          entry.progress.identityStatus = 'BOUND';
          entry.progress.lastVerified = Date.now();
          if (f.remote && f.remote.id) entry.telegram.remoteId = f.remote.id;
      }
  }

  const canTrustTDLib = entry.progress.identityStatus === 'BOUND' || (isResolved && isCorrectSize);
  const isPaused = entry.progress.state === 'paused' || entry.progress.isPaused;

  if (canTrustTDLib && !isPaused) {
      entry.progress.networkBytes = f.local.downloaded_size;
      if (f.size > 0) entry.media.totalSize = f.size;
  } else if (!isPaused) {
      // While RESTORED/RESOLVING, only allow progress to move forward
      entry.progress.networkBytes = Math.max(entry.progress.networkBytes || 0, f.local.downloaded_size || 0);
  }

  entry._lastFile = f;
  entry.downloadedPrefix = f.local.can_be_read_prefix_size;
  entry.progress.isNetworkDone = f.local.is_downloading_completed;

  // UI Update logic (Progress calculation)
  const total = entry.media.totalSize || 0;
  const current = entry.progress.networkBytes || 0;

  if (total > 0) {
      const newPercent = Math.round((current / total) * 100);

      const now = Date.now();
      const lastSave = entry._lastSaveTime || 0;
      const lastPercent = entry._lastSavedPercent || 0;

      if (newPercent >= lastPercent + 1 || (now - lastSave > 10000)) {
          entry._lastSaveTime = now;
          entry._lastSavedPercent = newPercent;
          entry.progress.percent = newPercent;
          window.saveDownloadsToStorage();
      } else {
          entry.progress.percent = newPercent;
      }
  }

  if (entry.progress.state !== 'completed' && entry.progress.state !== 'error' && entry.progress.state !== 'finalizing') {
      // 1. BRIDGE THE GAP (Only if not paused)
      if (entry.progress.percent >= 99 && !f.local.is_downloading_completed && !entry._finalNudgeSent && !isPaused) {
          entry._finalNudgeSent = true;
          console.log("[DOWNLOAD] Sending final nudge for completion", entry.telegram.fileId);
          window.tdClient.send({
              "@type": "downloadFile",
              "file_id": Number(entry.telegram.fileId),
              "priority": 32,
              "offset": 0,
              "limit": 0,
              "synchronous": false
          }).catch(() => {});
      }

      if (f.local.is_downloading_completed) {
          console.log("[EXPECTED SIZE - TDLIB]", f.size);
          entry.progress.state = 'finalizing';

          (async () => {
              try {
                  // PHASE 5 - FINALIZE DOWNLOAD (Electron Copy)
                  if (window.electronAPI && entry.progress.savePath && f.local.path) {
                      console.log(`[FINALIZE OWNER] taskId=${entry.taskId} savePath=${entry.progress.savePath} trigger=download-complete`);
                      const res = await window.electronAPI.finalizeDownload(f.local.path, entry.progress.savePath);
                      if (res.success) {
                          console.log("[FINALIZE] Copy successful");
                      } else {
                          console.error("[FINALIZE] Copy failed:", res.error);
                          entry.progress.state = 'error';
                          entry.progress.error = 'COPY_FAILED';
                          return;
                      }
                  }

                  entry.progress.state = 'completed';
                  entry.progress.networkBytes = f.size;
                  entry.progress.diskBytes = f.size;

                  // Clean up TDLib cache
                  window.tdClient.send({ '@type': 'deleteFile', 'file_id': Number(f.id) })
                      .catch(e => console.warn("[DOWNLOAD] TDLib cache cleanup failed", e));

                  if (entry.writable) {
                      entry.writable.close().then(() => { entry.writable = null; });
                  }
                  if (window.electronAPI && entry.progress.savePath) {
                      await window.electronAPI.closeFile(entry.progress.savePath).catch(() => {});
                  }
                  window.saveDownloadsToStorage();
              } catch (e) {
                  console.error("[COMPLETION ERROR]", e);
                  entry.progress.state = 'error';
              } finally {
                  throttleUIUpdate(entry);
              }
          })();
      } else if (f.local.is_downloading_active && !entry.progress.isPaused && entry.progress.state !== 'paused' && entry.progress.state !== 'error') {
          entry.progress.state = 'downloading';
      }
  }

  throttleUIUpdate(entry);
}

window.handleFileUpdate = handleFileUpdate;

const inFlightDownloads = new Set();
async function startDownload(fileId, itemId, suggestedName, isPlayback = false, botChatId = null, existingHandle = null, uniqueId = null, offset = 0, limit = 0, lookupToken = null) {
  const downloadKey = String(fileId);
  if (inFlightDownloads.has(downloadKey)) return;
  inFlightDownloads.add(downloadKey);
  try {
    return await startDownloadInternal(fileId, itemId, suggestedName, isPlayback, botChatId, existingHandle, uniqueId, offset, limit, lookupToken);
  } finally {
    inFlightDownloads.delete(downloadKey);
  }
}

async function startDownloadInternal(fileId, itemId, suggestedName, isPlayback = false, botChatId = null, existingHandle = null, uniqueId = null, offset = 0, limit = 0, lookupToken = null) {
  const streamKey = String(fileId);
  let entry = window.downloadManager.get(streamKey);

  // CRITICAL: Ensure entry is normalized if found
  if (entry) entry = normalizeTask(entry);

  let fileHandle = existingHandle || (entry ? entry.progress.fileHandle : null);

  let isAliveInSW = false;
  let backgroundOffset = 0;

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      await navigator.serviceWorker.ready;

      const channel = new MessageChannel();
      const swCheckPromise = new Promise(resolve => {
          const timeout = setTimeout(() => resolve(null), 1000);
          channel.port1.onmessage = (e) => {
              clearTimeout(timeout);
              if (e.data.type === 'ALIVE_STREAMS_VERBOSE') resolve(e.data.streams || {});
          };
          navigator.serviceWorker.controller.postMessage({ type: 'CHECK_STREAMS_VERBOSE' }, [channel.port2]);
      });

      const streams = await swCheckPromise;
      if (streams && streams[streamKey]) {
          console.log("[DOWNLOAD] Stream detected as ALIVE in Service Worker background.");
          isAliveInSW = true;
          backgroundOffset = streams[streamKey].streamed;
      }
  }

  if (!isPlayback && !fileHandle && !isAliveInSW && window.showSaveFilePicker && !window.electronAPI) {
      try {
          fileHandle = await window.showSaveFilePicker({ suggestedName: suggestedName || "video.mp4" });
      } catch (e) { if (e.name === 'AbortError') return; }
  }
  if (!fileId || !window.tdClient) return;

  try {
    let freshFileId = fileId;

    const me = await window.tdClient.send({ '@type': 'getMe' });
    const targetChatId = botChatId || (await window.tdClient.send({ '@type': 'createPrivateChat', 'user_id': Number(me.id), 'force': false })).id;

    const tempEntry = {
        discovery: { chatId: String(targetChatId), messageId: String(itemId) },
        telegram: { fileId: String(fileId) },
        media: { fileName: suggestedName }
    };
    const resolvedId = await refreshEntryId(tempEntry);
    if (resolvedId) freshFileId = resolvedId;

    const file = await window.tdClient.send({ '@type': 'getFile', 'file_id': parseInt(freshFileId) });
    if (file && file['@type'] === 'error') {
        throw new Error(file.message);
    }

    const uniqueKey = uniqueId || (file.remote ? file.remote.unique_id : String(freshFileId));
    const remoteId = file.remote ? file.remote.id : null;
    const size = file.size || 0;
    const downloadedSize = file.local?.downloaded_size || 0;
    const fileName = suggestedName || "video.mp4";

    const safeChatId = botChatId || String(targetChatId);
    const lookup = window.selectedSource ? (window.selectedSource.lookup || {}) : {};
    const effectiveLookupToken = lookup.lookupToken || lookupToken || (window.selectedSource ? (window.selectedSource.startParameter || window.selectedSource.startParam || (window.selectedSource.telegramFileId ? `file_${window.selectedSource.telegramFileId}` : null)) : null);
    const taskIdentity = window.getTaskIdentity(safeChatId, effectiveLookupToken);

    const compositeUniqueKey = `${safeChatId}_${itemId}_${uniqueKey}`;

    // REUSE LOOKUP (Identity > Token > Composite > Stream > Original > UID > fileId)
    let entry = (taskIdentity ? downloadManager.get(taskIdentity) : null) ||
                (effectiveLookupToken ? downloadManager.get(String(effectiveLookupToken)) : null) ||
                downloadManager.get(compositeUniqueKey) ||
                downloadManager.get(String(fileId)) ||
                downloadManager.get(String(uniqueKey)) ||
                downloadManager.get(String(freshFileId));

    if (!entry) {
        entry = {
            taskId: `vault_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`,
            discovery: {
                providerId: window.selectedSource?.addonId || safeChatId,
                providerName: window.selectedSource?.addon || "Unknown",
                lookupToken: effectiveLookupToken,
                chatId: String(safeChatId),
                messageId: String(itemId),
                botUsername: window.selectedSource ? window.selectedSource.botUsername : null
            },
            telegram: {
                fileId: String(freshFileId),
                remoteId: remoteId,
                telegramUniqueId: uniqueKey,
                originalFileId: String(fileId)
            },
            media: {
                tmdbId: window.currentDetailItem?.id || window.currentDetailItem?.tmdbId || null,
                season: window.currentDetailItem?.season || null,
                episode: window.currentDetailItem?.episode || null,
                fileName: fileName,
                totalSize: size,
                type: window.currentDetailItem?.type || "movie",
                poster: window.currentDetailItem?.poster_path || null,
                backdrop: window.currentDetailItem?.backdrop_path || null
            },
            progress: {
                networkBytes: downloadedSize,
                diskBytes: isAliveInSW ? backgroundOffset : 0,
                lastOffset: isAliveInSW ? backgroundOffset : 0,
                state: 'downloading',
                identityStatus: 'BOUND',
                lastVerified: Date.now(),
                savePath: null,
                fileHandle: fileHandle
            },
            startTime: Date.now(),
            speed: 0,
            eta: 0,
            pendingWrites: 0
        };
        console.log(`[DOWNLOAD ENTRY CREATED] taskId=${entry.taskId} fileId=${entry.telegram.fileId} identity=${taskIdentity}`);
    } else {
        // ENFORCE NORMALIZATION ON REUSE
        entry = normalizeTask(entry);

        // PROTECTION: Don't downgrade 'completed' to 'downloading'
        if (entry.progress.state !== 'completed') {
            entry.progress.state = 'downloading';
            entry.progress.isPaused = false;
        }

        if (fileHandle) entry.progress.fileHandle = fileHandle;

        entry.telegram.fileId = String(freshFileId);
        if (uniqueKey) entry.telegram.telegramUniqueId = uniqueKey;
        if (remoteId) entry.telegram.remoteId = remoteId;

        if (effectiveLookupToken) entry.discovery.lookupToken = effectiveLookupToken;
        if (window.selectedSource && window.selectedSource.botUsername)
            entry.discovery.botUsername = window.selectedSource.botUsername;

        if (isAliveInSW) {
            entry.progress.lastOffset = backgroundOffset;
            entry.progress.diskBytes = backgroundOffset;
        }

        console.log(`[DOWNLOAD ENTRY UPDATED] taskId=${entry.taskId} fileId=${entry.telegram.fileId} identity=${taskIdentity}`);
    }

    // Indexing
    if (taskIdentity) downloadManager.set(taskIdentity, entry);
    if (effectiveLookupToken) downloadManager.set(String(effectiveLookupToken), entry);
    downloadManager.set(String(freshFileId), entry);
    if (uniqueKey) downloadManager.set(String(uniqueKey), entry);
    downloadManager.set(compositeUniqueKey, entry);
    downloadManager.set(entry.taskId, entry);

    if (!isPlayback) {
        console.log("[DOWNLOAD MODE] Native TDLib");
        if (window.electronAPI && !entry.progress.savePath) {
            entry.progress.savePath = await window.electronAPI.getAutoSavePath(fileName);
        }

        if (!file?.local?.is_downloading_active) {
            await window.tdClient.send({
                "@type": "downloadFile",
                "file_id": Number(freshFileId),
                "priority": 32,
                "offset": 0,
                "limit": 0,
                "synchronous": false
            });
        }

        saveDownloadsToStorage();
        return freshFileId;
    }

    console.log("[PLAYBACK MODE] Direct Stream (127.0.0.1:3301)");
    entry.isPlayback = true;

    if (!file?.local?.is_downloading_completed && !file?.local?.is_downloading_active) {
        await window.tdClient.send({
            "@type": "downloadFile",
            "file_id": Number(freshFileId),
            "priority": 32,
            "offset": offset,
            "limit": limit,
            "synchronous": false
        });
    }

    saveDownloadsToStorage();
    return freshFileId;
  } catch (e) {
    console.error("[DOWNLOAD ERROR]", e);
    return null;
  }
}

function updateMainDownloadButton() {
    const mainDlBtn = document.getElementById('main-download-btn');
    if (!mainDlBtn || !window.selectedSource) return;

    const fileId = window.selectedSource.fileId;
    const uniqueId = window.selectedSource.uniqueId;
    const lookup = window.selectedSource.lookup || {};
    const fingerprint = window.selectedSource.fileName && window.selectedSource.size ? `${window.selectedSource.fileName}_${window.selectedSource.size}` : null;

    let entry = (lookup.taskIdentity ? window.downloadManager.get(lookup.taskIdentity) : null) ||
                (lookup.lookupToken ? window.downloadManager.get(String(lookup.lookupToken)) : null) ||
                window.downloadManager.get(String(uniqueId)) ||
                (fileId && window.downloadManager.get(String(fileId))) ||
                (fingerprint && window.downloadManager.get(fingerprint));

    if (entry) entry = normalizeTask(entry);

    const btnText = mainDlBtn.querySelector('.btn-text');
    let progBar = mainDlBtn.querySelector('.btn-progress');

    if (entry) {
        const currentProgressBytes = Math.max(entry.progress.diskBytes || 0, entry.progress.streamedBytes || 0, entry.progress.networkBytes || 0);
        const totalSize = entry.media.totalSize || 0;

        let percent = totalSize > 0 ? Math.round((currentProgressBytes / totalSize) * 100) : 0;
        if (entry.progress.state === 'completed') percent = 100;

        const isWriting = (entry.progress.isNetworkDone && (entry.progress.diskBytes || 0) < totalSize) || entry.progress.state === 'finalizing';

        if (!progBar) {
            progBar = document.createElement('div');
            progBar.className = 'btn-progress';
            mainDlBtn.appendChild(progBar);
        }
        progBar.style.width = percent + '%';
        if (btnText) {
            if (entry.progress.state === 'completed') btnText.textContent = 'Play Local File';
            else if (entry.progress.state === 'error' && percent === 0) btnText.textContent = 'Retry Download';
            else if (entry.progress.state === 'paused' || entry.progress.isPaused) btnText.textContent = percent + '% Paused';
            else if (isWriting) btnText.textContent = 'Saving to disk...';
            else if (percent === 0 && !entry.progress.networkBytes) btnText.textContent = 'Resolving file...';
            else btnText.textContent = percent + '% Downloading...';
        }
    } else {
        if (progBar) progBar.remove();
        if (btnText) btnText.textContent = 'Download';
    }
}

window.updateMainDownloadButton = updateMainDownloadButton;

async function toggleDownload(fileId, itemId) {
  const key = String(fileId);
  let entry = downloadManager.get(key);
  if (!entry) return;

  entry = normalizeTask(entry);

  if (entry.progress.state === 'downloading') {
    entry.progress.state = 'paused';
    entry.progress.isPaused = true;
    const numericId = parseInt(entry.telegram.fileId);
    if (!isNaN(numericId)) {
        window.tdClient.send({ '@type': 'cancelDownloadFile', 'file_id': numericId, 'only_if_pending': false }).catch(e => {});
    }
  } else {
    console.log(`[RESUME] Rehydrating state for: ${entry.media.fileName}`);

    const freshId = await rebindFile(entry);

    if (freshId === "PENDING_REGEN") return;

    if (!freshId) {
        if (window.selectedSource) {
            handleSourceClick(window.selectedSource, false);
            return;
        }
        return;
    }

    entry = downloadManager.get(String(freshId)) || entry;

    entry.progress.state = 'downloading';
    entry.progress.isPaused = false;

    const numericId = parseInt(entry.telegram.fileId);
    window.tdClient.send({ '@type': 'addFileToDownloads', 'file_id': numericId, 'priority': 32 }).catch(e => {});

    window.tdClient.send({
        "@type": "downloadFile",
        "file_id": numericId,
        "priority": 32,
        "offset": 0,
        "limit": 0,
        "synchronous": false
    });
  }

  const el = document.getElementById('saved-item-' + entry.discovery.messageId);
  if (el && typeof renderSavedItemOverlay === 'function') renderSavedItemOverlay(el, entry);

  if (typeof updateMainDownloadButton === 'function') {
      updateMainDownloadButton();
  }
  window.saveDownloadsToStorage();
}

window.startDownload = startDownload;
window.toggleDownload = toggleDownload;

function saveDownloadsToStorage() {
  if (!window.DownloadPersistence) {
      console.warn("[SAVE] DownloadPersistence not ready.");
      return;
  }

  // The method name in persistence.js is saveDownloadsToStorage
  window.DownloadPersistence.saveDownloadsToStorage();
}

window.saveDownloadsToStorage = saveDownloadsToStorage;

// ── DIAGNOSTICS ───────────────────────────────────────────
setInterval(async () => {
  if(!window.tdClient) return;
  const uniqueEntries = new Set(window.downloadManager.values());
  for (let entry of uniqueEntries) {
    if (!entry.progress) {
        // Self-heal legacy entries in memory
        const normalized = normalizeTask(entry);
        // We can't easily replace all keys in the Map here, but we can fix this reference
        // for the rest of this loop iteration.
        entry = normalized;
    }
    const fileId = entry.telegram.fileId;
    if (entry.progress.state === 'downloading') {
       try {
         const file = await window.tdClient.send({ '@type': 'getFile', 'file_id': Number(fileId) });
         if (file && file.local) {
           if (!entry.isReading) processDownloadChunks(fileId, file);
         }
       } catch (e) {}
       const el = document.getElementById('saved-item-' + entry.discovery.messageId);
       if (el) renderSavedItemOverlay(el, entry);
    }
  }
}, 1000);

setInterval(() => {
    window.saveDownloadsToStorage();
}, 5000);

async function restoreDownloadUI() {
  const db = await initSourceDB();
  const tx = db.transaction("sv_tasks", "readonly");
  const request = tx.objectStore("sv_tasks").getAll();

  request.onsuccess = async () => {
    const tasks = request.result;
    for (const task of tasks) {
        const entry = normalizeTask(task);
        const isFinished = entry.progress.state === 'completed';
        const hasProgress = (entry.progress.networkBytes > 0 || entry.progress.diskBytes > 0 || entry.progress.lastOffset > 0);

        if (!hasProgress && !isFinished) continue;

        // DISK VERIFICATION
        if (isFinished && window.electronAPI && entry.progress.savePath) {
            const exists = await window.electronAPI.verifyAndResumeFile({
                fileId: entry.telegram.fileId,
                savePath: entry.progress.savePath,
                lastOffset: 0
            });
            if (!exists.success) {
                console.warn(`[RESTORE] Completed file ${entry.media.fileName} missing. Resetting.`);
                entry.progress.state = 'paused';
            }
        }

        const safeChatId = entry.discovery.chatId;
        const safeItemId = entry.discovery.messageId;
        const fileId = entry.telegram.fileId;
        const uniqueId = entry.telegram.telegramUniqueId;
        const lookupToken = entry.discovery.lookupToken;

        const taskIdentity = window.getTaskIdentity(safeChatId, lookupToken);

        if (taskIdentity) window.downloadManager.set(taskIdentity, entry);
        if (lookupToken) window.downloadManager.set(String(lookupToken), entry);
        if (fileId) window.downloadManager.set(String(fileId), entry);
        if (uniqueId) window.downloadManager.set(String(uniqueId), entry);
        if (entry.telegram.originalFileId) window.downloadManager.set(String(entry.telegram.originalFileId), entry);
        if (entry.taskId) window.downloadManager.set(String(entry.taskId), entry);

        if (entry.media.fileName && entry.media.totalSize) {
            const fingerprint = `${entry.media.fileName}_${entry.media.totalSize}`;
            window.downloadManager.set(fingerprint, entry);
        }

        const compositeKey = `${safeChatId}_${safeItemId}_${fileId}`;
        window.downloadManager.set(compositeKey, entry);
    }

    if (typeof window.updateMainDownloadButton === 'function') {
        window.updateMainDownloadButton();
    }
  };
}
