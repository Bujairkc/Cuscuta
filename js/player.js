/**
 * Player logic for StreamVault SPA.
 */

window.AUDIO_OUTPUT_MODE = "fmp4"; // "adts" | "fmp4"

let playerStartupState = 'IDLE'; // IDLE -> OPENING -> PREPARING_SUBTITLES -> READY_TO_PLAY -> PLAYING
let playerStartupPromise = null;

// --- FORENSIC LOG CAPTURE ---
window.SyncLogs = [];
const originalLog = console.log;
const originalError = console.error;
const capture = (args) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    if (/\[(FORENSIC|SYNC|AUDIO|MSE|STARTUP|CLOCK|WAITING|APPEND|EXP|CURRENTTIME|MEDIA-EVENT)/.test(msg)) {
        window.SyncLogs.push(`[${new Date().toISOString()}] ${msg}`);
        if (window.electronAPI) window.electronAPI.sendDiagnosticLog('sync', msg);
    } else if (msg.startsWith('[PLAYER STATE]')) {
        if (window.electronAPI) window.electronAPI.sendDiagnosticLog('player', msg);
    }
};
console.log = (...args) => { capture(args); originalLog(...args); };
console.error = (...args) => { capture(args); originalError(...args); };

// --- CURRENTTIME MONKEY-PATCH ---
try {
    const originalSetter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime').set;
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        set: function(val) {
            const id = this.id || this.tagName;
            console.log(`[CURRENTTIME SET] Element=${id} | old=${this.currentTime.toFixed(3)} | new=${val.toFixed(3)} | perf=${performance.now().toFixed(2)} | origin:`, new Error().stack.split('\n')[2]);
            originalSetter.call(this, val);
        },
        get: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime').get,
        configurable: true
    });
} catch(e) { console.error("Failed to patch currentTime", e); }

if (window.electronAPI && window.electronAPI.onPrepareShutdown) {
    window.electronAPI.onPrepareShutdown(async () => {
        if (window.SyncLogs.length > 0) {
            await window.electronAPI.saveForensicLogs(window.SyncLogs.join('\n'));
        }
        window.electronAPI.signalShutdownReady();
    });
}

function transitionTo(newState) {
    console.log(`[PLAYER STATE] ${playerStartupState} -> ${newState}`);
    playerStartupState = newState;
}

async function openPlayer(item) {
    if (playerStartupState !== 'IDLE') {
        if (window.activePlayerFileId === item.fileId) {
            console.log("[PLAYER] openPlayer called during startup for same file, reusing promise.");
            return playerStartupPromise;
        } else if (playerStartupState !== 'PLAYING') {
            console.warn("[PLAYER] openPlayer called for different file during startup. Aborting old startup.");
            // For now, we simple ignore or you could implement full cancellation.
            // But usually, one would close the old player first.
        }
    }

    if (window.activePlayerFileId === item.fileId && playerStartupState === 'PLAYING') {
        console.log("[PLAYER] File already playing.");
        return;
    }

    playerStartupPromise = (async () => {
        try {
            transitionTo('OPENING');
            window.activePlayerFileId = item.fileId;

            const _log = window.dlog || console.log;
            const playerView = document.getElementById('player-view');
            const video = document.getElementById('main-player');
            const overlay = document.getElementById('player-loading-overlay');
            const loadingSubtext = document.getElementById('player-loading-subtext');

            // 1. Reset UI & Loading State
            playerView.style.display = 'flex';
            overlay.classList.remove('hidden');
            loadingSubtext.textContent = "Initializing stream engine...";
            document.body.style.overflow = 'hidden';

            if (!video.dataset.seekBound) {
                const refreshSubtitleTracks = (reason) => {
                    const sessionId = window.currentSeekSessionId || 0;
                    if (!window.refreshCounts) window.refreshCounts = {};
                    window.refreshCounts[sessionId] = (window.refreshCounts[sessionId] || 0) + 1;

                    console.log(`[REFRESH AUDIT] Refresh #${window.refreshCounts[sessionId]} for SeekSession=${sessionId}`);
                    console.log(`[REFRESH AUDIT] Reason: ${reason} | currentTime: ${video.currentTime}`);
                    console.log(`[REFRESH AUDIT] Stack: ${new Error().stack.split('\n').slice(1, 7).join('\n')}`);

                    const tracks = video.querySelectorAll('track');
                    slog(`[SEEK] Refreshing ${tracks.length} subtitle tracks...`);

                    tracks.forEach((track, idx) => {
                        const textTrack = video.textTracks[idx];
                        const oldSrc = track.src;
                        const baseSrc = oldSrc.split('?')[0];

                        if (baseSrc && baseSrc.startsWith('http')) {
                            const newSrc = `${baseSrc}?t=${Date.now()}&refresh=${window.refreshCounts[sessionId]}&start=${video.currentTime}&sessionId=${sessionId}`;
                            console.log(`[REFRESH AUDIT] track.src assigned | Previous: ${oldSrc} | New: ${newSrc}`);

                            if (!window.httpRequestCounts) window.httpRequestCounts = {};
                            window.httpRequestCounts[sessionId] = (window.httpRequestCounts[sessionId] || 0) + 1;
                            console.log(`[REFRESH AUDIT] HTTP Request #${window.httpRequestCounts[sessionId]} (Triggered by Refresh #${window.refreshCounts[sessionId]})`);

                            track.src = newSrc;
                        }

                        if (textTrack && !textTrack.dataset_auditBound) {
                            let firstActiveCueLogged = false;
                            textTrack.addEventListener('cuechange', () => {
                                if (!firstActiveCueLogged && textTrack.activeCues && textTrack.activeCues.length > 0) {
                                    const cue = textTrack.activeCues[0];
                                    const browserTime = video.currentTime;
                                    console.log(`\nFIRST ACTIVE CUE\nPacketID: ${cue.id}\nCueStart: ${cue.startTime}\nCueEnd: ${cue.endTime}\nBrowserCurrentTime: ${browserTime}\nDelta = ${browserTime - cue.startTime}\n`);
                                    firstActiveCueLogged = true;
                                }
                            });
                            textTrack.dataset_auditBound = "true";
                        }
                    });

                    console.log(`[REFRESH AUDIT] SeekSession=${sessionId} Summary: Refresh count: ${window.refreshCounts[sessionId]}, HTTP request count: ${window.httpRequestCounts ? window.httpRequestCounts[sessionId] : 0}, Track recreation count: ${window.trackRecreationCounts ? window.trackRecreationCounts[sessionId] : 0}`);
                };

                video.addEventListener('seeking', () => {
                    if (window.mp4Player && window.mp4Player.isAttached) {
                        if (window.mp4Player.internalSeekGuard) return;
                        window.mp4Player.seek(video.currentTime);
                        return;
                    }

                    if (!window.currentSeekSessionId) window.currentSeekSessionId = 0;
                    window.currentSeekSessionId++;
                    const sessionId = window.currentSeekSessionId;
                    window.seekStartTime = Date.now();

                    const auditLog = (milestone) => {
                        const t = Date.now() - window.seekStartTime;
                        console.log(`[SeekSession=${sessionId}] [t=${t}ms] ${milestone}`);
                    };

                    console.log(`\n===============================\n[SEEK SESSION ${sessionId}]\nRequestedSeekTime: ${video.currentTime}\n===============================\n`);

                    auditLog("SEEK START");

                    // PART B: Seek Readiness Gate
                    safePause(video, "Seeking started");
                    const overlay = document.getElementById('player-loading-overlay');
                    const loadingSubtext = document.getElementById('player-loading-subtext');
                    overlay.classList.remove('hidden');
                    loadingSubtext.textContent = "Syncing subtitles...";

                    let subResolved = false;
                    let videoReady = false;

                    const checkReady = () => {
                        if (subResolved && videoReady) {
                            auditLog("SEEK GATE RELEASED");
                            overlay.classList.add('hidden');
                            safePlay(video, "Subtitles and video synced");
                        }
                    };

                    // Backend Resolution Handler
                    const onResolution = (data) => {
                        if (data.sessionId === sessionId) {
                            auditLog(`SUBTITLE RESOLUTION RECEIVED: ${data.state}`);

                            if (data.state === 'NO_CUE') {
                                subResolved = true;
                                checkReady();
                            } else if (data.state === 'CUE_FOUND') {
                                // Two-stage gate: wait for browser to ingest the cue
                                const checkBrowserIngestion = () => {
                                    if (window.currentSeekSessionId !== sessionId) return; // Stale session

                                    const showingTrackIdx = Array.from(video.textTracks).findIndex(t => t.mode === 'showing');
                                    const textTrack = video.textTracks[showingTrackIdx];

                                    if (textTrack && textTrack.cues && textTrack.cues.length > 0) {
                                        auditLog("SUBTITLE READY (Browser ingested cue)");
                                        subResolved = true;
                                        checkReady();
                                    } else {
                                        setTimeout(checkBrowserIngestion, 100);
                                    }
                                };
                                checkBrowserIngestion();
                            }
                        }
                    };

                    if (window.electronAPI && window.electronAPI.onSubtitleResolution) {
                        window.electronAPI.onSubtitleResolution(onResolution);
                    }

                    // 2. Wait for video canplay
                    video.addEventListener('canplay', () => {
                        videoReady = true;
                        auditLog("VIDEO READY");
                        checkReady();
                    }, { once: true });

                    // CRITICAL: Refresh tracks BEFORE starting checkSubs
                    auditLog("TRACK REFRESH");
                    refreshSubtitleTracks("video.seeking");

                    // Log state immediately after seek
                    setTimeout(() => {
                        slog(`[SEEK STATE] video.textTracks.length=${video.textTracks.length}`);
                        for (let i = 0; i < video.textTracks.length; i++) {
                            const t = video.textTracks[i];
                            slog(`[SEEK STATE] Track[${i}]: id=${t.id}, label=${t.label}, mode=${t.mode}, cues=${t.cues ? t.cues.length : 0}, active=${t.activeCues ? t.activeCues.length : 0}`);
                        }
                    }, 500);
                });
                video.dataset.seekBound = "true";

                // Observe DOM for track creation/removal
                const observer = new MutationObserver((mutations) => {
                    const sessionId = window.currentSeekSessionId || 0;
                    if (!window.trackRecreationCounts) window.trackRecreationCounts = {};

                    mutations.forEach((mutation) => {
                        mutation.addedNodes.forEach((node) => {
                            if (node.tagName === 'TRACK') {
                                window.trackRecreationCounts[sessionId] = (window.trackRecreationCounts[sessionId] || 0) + 1;
                                console.log(`[REFRESH AUDIT] New <track> element created | label: ${node.label}`);
                            }
                        });
                        mutation.removedNodes.forEach((node) => {
                            if (node.tagName === 'TRACK') {
                                console.log(`[REFRESH AUDIT] <track> element removed | label: ${node.label}`);
                            }
                        });
                    });
                });
                observer.observe(video, { childList: true });
            }

            safePause(video, "Initial reset");
            video.innerHTML = "";
            safeSetSrc(video, "");
            safeLoad(video, "Initial reset");

            // 2. Register Stream
            let activeFileId = item.fileId;
            if (typeof startDownload === 'function') {
                try {
                    // Pass addonId (chatId) to ensure rehydration finds the movie, not a random profile pic
                    const freshId = await startDownload(item.fileId, item.itemId, item.fileName, true, item.addonId);
                    if (freshId) {
                        console.log(`[PLAYER] Snap-to-ID: ${activeFileId} -> ${freshId}`);
                        activeFileId = freshId;
                    }
                } catch (e) { console.error("[PLAYER] startDownload failed:", e); }
            }

            // 3. Handle External Player Mode
            if (window.PLAYBACK_MODE === "tdlib-local" && window.electronAPI) {
                try {
                    const file = await window.tdClient.send({ '@type': 'getFile', 'file_id': Number(activeFileId) });
                    if (file && file.local && file.local.path) {
                        window.electronAPI.openLocalPlayback(file.local.path);
                        closePlayer();
                        return;
                    }
                } catch (e) { console.error("[PLAYER] Local playback failed", e); }
            }

            // 4. Build Stream URL
            let streamUrl = "";
            const entry = window.downloadManager.get(String(activeFileId));
            const savePathQuery = (entry && entry.progress?.state === 'completed' && entry.progress?.savePath) ? `&savePath=${encodeURIComponent(entry.progress.savePath)}` : "";

            if (window.USE_DIRECT_STREAM) {
                streamUrl = `http://127.0.0.1:3301/stream/${activeFileId}?name=${encodeURIComponent(item.fileName || "video.mp4")}${savePathQuery}`;

                // POLLING READINESS (From Finest): Wait for server to nudge TDLib and be ready
                _log("[PLAYER] Preparing stream buffer...");
                let ready = false;
                let retries = 0;
                while (!ready && retries < 40) {
                    try {
                        // Use HEAD to trigger the nudging logic without downloading full data yet
                        const check = await fetch(streamUrl, { method: 'HEAD' });
                        if (check.ok || check.status === 206) {
                            ready = true;
                            break;
                        }
                    } catch (e) {}
                    await new Promise(r => setTimeout(r, 1000));
                    retries++;
                }
            } else {
                streamUrl = window.location.origin + "/stream-download/" + activeFileId + "?playback=1";
            }

            // Verify Entry
            if (window.downloadManager && !window.downloadManager.has(String(activeFileId))) {
                _log("[PLAYER] Error: Stream entry not found.");
                closePlayer();
                return;
            }

            safeSetSrc(video, streamUrl);
            safeLoad(video, "Startup");

            // 5. FETCH MEDIA MANIFEST
            loadingSubtext.textContent = "Fetching media manifest...";

            // Initialize Subtitle Map
            window.subtitleTrackMap = new Map();

            let preferredSubIndex = -1;
            let preferredAudioTrack = null;

            try {
                const res = await fetch(`http://127.0.0.1:3301/stream/${activeFileId}/tracks`);
                const manifest = await res.json();

                if (manifest && String(manifest.container).toLowerCase() === 'mp4' && window.MP4MSEPlayer) {
                    console.log(`[MP4 MSE] ROUTING TO UNIFIED PLAYER`);
                    if (window.audioSync) window.audioSync.destroy();
                    if (window.mp4Player) window.mp4Player.detach();

                    window.mp4Player = new MP4MSEPlayer(video);
                    await window.mp4Player.attach(activeFileId, manifest);
                } else {
                    // LEGACY ROUTE (MKV / OTHER)
                    console.log(`[LEGACY ROUTE] container=${manifest ? manifest.container : 'unknown'}`);
                    if (window.mp4Player) window.mp4Player.detach();

                    if (window.audioSync) window.audioSync.destroy();
                    window.audioSync = new AudioSyncController();
                    window.audioSync.attach(video, document.getElementById('audio-companion'), activeFileId);
                }

                if (manifest) {
                    const audioForPopover = [];
                    const subsForPopover = [];

                    // Populate Subtitles
                    (manifest.subtitles || []).forEach((track, index) => {
                        const trackEl = document.createElement('track');
                        trackEl.kind = 'subtitles';
                        trackEl.label = track.title || track.language || `Track ${track.trackNumber || index + 1}`;
                        trackEl.srclang = (track.language || 'en').substring(0, 2).toLowerCase();
                        trackEl.src = `http://127.0.0.1:3301/stream/${activeFileId}/subtitles/${track.id}`;
                        trackEl.id = track.id;
                        trackEl.setAttribute('data-id', track.id);
                        video.appendChild(trackEl);

                        if (window.subtitleTrackMap) window.subtitleTrackMap.set(track.id, trackEl);

                        subsForPopover.push({
                            id: track.id,
                            _label: `${trackEl.label} (${track.type === 'embedded' ? 'MKV' : 'External'})`
                        });

                        if (preferredSubIndex === -1) {
                            const label = trackEl.label.toLowerCase();
                            if (label.includes('eng') || index === 0) preferredSubIndex = track.id;
                        }
                    });

                    // Populate Audio
                    (manifest.audio || []).forEach((track, index) => {
                        const lang = track.language || 'Unknown';
                        const codec = track.codec ? track.codec.replace('A_', '') : 'Unknown';
                        const channels = track.channels ? (track.channels === 2 ? 'Stereo' : track.channels + 'ch') : '';
                        const title = track.title ? ` — ${track.title}` : '';

                        audioForPopover.push({
                            trackNumber: track.trackNumber,
                            _index: index,
                            _label: `${lang}${title} (${codec} ${channels})`,
                            supported: track.supported
                        });

                        if (!preferredAudioTrack && track.supported) {
                            preferredAudioTrack = { index, number: track.trackNumber };
                        }
                    });

                    // Update New Glass UI
                    if (window.updateAudioPopoverItems) window.updateAudioPopoverItems(audioForPopover);
                    if (window.apiUpdateSubtitlePopoverItems) window.apiUpdateSubtitlePopoverItems(subsForPopover);
                }
            } catch (e) { console.warn('[PLAYER] Manifest fetch failed:', e); }

            // 6. PLAYBACK GATE (Fast Start)
            transitionTo('READY_TO_PLAY');
            overlay.classList.add('hidden');

            if (preferredSubIndex !== -1) setSubtitle(preferredSubIndex, true);
            if (preferredAudioTrack) {
                if (!(window.mp4Player && window.mp4Player.isAttached)) {
                    setAudioTrack(preferredAudioTrack.index, preferredAudioTrack.number, true);
                    video.muted = true;
                }
            } else {
                video.muted = false;
            }

            if (!(window.mp4Player && window.mp4Player.isAttached)) {
                await safePlay(video, "Startup finished");
            }
            transitionTo('PLAYING');

        } catch (err) {
            console.error("[PLAYER ERROR] Startup crashed:", err);
            transitionTo('IDLE');
        } finally {
            playerStartupPromise = null;
        }
    })();

    return playerStartupPromise;
}

// Media Lifecycle Wrappers
async function safePlay(video, reason) {
    console.log(`[PLAYER CALL] play() reason: ${reason}`);
    try {
        return await video.play();
    } catch (err) {
        if (err.name === 'AbortError') {
            console.warn(`[PLAYER ABORT] play() was interrupted by a pause() call. Reason: ${reason}`);
        } else {
            console.error(`[PLAYER ERROR] play() failed: ${err.message}`);
        }
    }
}

function safePause(video, reason) {
    if (playerStartupState !== 'IDLE' && playerStartupState !== 'PLAYING') {
        console.error(`[PLAYER ERROR] pause() interrupted startup. State: ${playerStartupState}. Reason: ${reason}`);
        console.trace();
    } else {
        console.log(`[PLAYER CALL] pause() reason: ${reason}`);
    }
    video.pause();
}

function safeLoad(video, reason) {
    console.log(`[PLAYER CALL] load() reason: ${reason}`);
    video.load();
}

function safeSetSrc(video, src) {
    console.log(`[PLAYER CALL] src assignment: ${src ? src.substring(0, 50) + '...' : 'empty'}`);
    video.src = src;
}

function setSubtitle(trackId, isAuto = false) {
    const video = document.getElementById('main-player');
    const textTracks = video.textTracks;

    console.log(`[SUBTITLE] setSubtitle(trackId=${trackId}) - Current textTracks.length=${textTracks.length}`);

    if (trackId === 'off') {
        for (let i = 0; i < textTracks.length; i++) textTracks[i].mode = 'disabled';
        syncSubtitleUILocal();
        return;
    }

    // Find track using the persistent Map
    const trackEl = window.subtitleTrackMap ? window.subtitleTrackMap.get(trackId) : null;
    if (!trackEl) {
        console.error(`[SUBTITLE] ERROR: TrackEl with ID ${trackId} not found in map!`);
        return;
    }

    const textTrack = trackEl.track;
    if (!textTrack) {
        console.error(`[SUBTITLE] ERROR: Browser has not associated TextTrack for ${trackId}`);
        return;
    }

    // Disable others
    for (let i = 0; i < textTracks.length; i++) {
        if (textTracks[i] !== textTrack) textTracks[i].mode = 'disabled';
    }

    // Reproduce Chromium's CC menu behavior exactly
    textTrack.mode = 'hidden';
    textTrack.mode = 'showing';

    // Sync UI now that the raw browser state has changed
    syncSubtitleUILocal();
}

function setAudioTrack(index, trackNumber, isAuto = false) {
    console.log(`[PLAYER] setAudioTrack(index=${index}, trackNumber=${trackNumber}, isAuto=${isAuto})`);

    // Update UI
    document.querySelectorAll('#audio-tracks-list .player-menu-item').forEach(item => item.classList.remove('active'));
    const menuItem = document.getElementById(`audio-track-${index}`);
    if (menuItem) menuItem.classList.add('active');

    if (window.audioSync) {
        const video = document.getElementById('main-player');
        console.log(`[PLAYER] Dispatching to AudioSyncController.loadTrack(${trackNumber})`);
        window.audioSync.loadTrack(trackNumber, video.currentTime * 1000);
    } else {
        console.error(`[PLAYER] ERROR: window.audioSync not initialized!`);
    }
}

/**
 * Syncs the custom subtitle menu to the current TextTrack state.
 * Treats video.textTracks as the single source of truth.
 */
function syncSubtitleUILocal() {
    const video = document.getElementById('main-player');
    if (!video) return;

    const textTracks = video.textTracks;

    // Find the active track
    let activeTrackId = null;
    for (let i = 0; i < textTracks.length; i++) {
        if (textTracks[i].mode === 'showing') {
            // Resolve its DOM id from our persistent map
            for (let [id, el] of window.subtitleTrackMap.entries()) {
                if (el.track === textTracks[i]) {
                    activeTrackId = id;
                    break;
                }
            }
            break;
        }
    }

    // Update the new popover UI
    const container = document.getElementById('popover-subtitle-list');
    if (container) {
        const options = container.querySelectorAll('.popover-option');
        options.forEach(opt => {
            const val = opt.getAttribute('data-value');
            const isActive = (activeTrackId && val === activeTrackId) || (!activeTrackId && val === 'off');

            opt.classList.toggle('active', isActive);
            const check = opt.querySelector('.check');
            if (check) check.innerHTML = isActive ? '<i class="fas fa-check"></i>' : '';

            if (isActive) {
                const label = opt.querySelector('span').textContent;
                const displayLabel = document.getElementById('subtitleSelectionLabel');
                if (displayLabel) displayLabel.textContent = label;
            }
        });
    }
}

function closePlayer() {
    slog(`[TRACK] closePlayer() - Cleaning up tracks`);
    console.log(`[PLAYER CALL] cleanup/closePlayer called. State: ${playerStartupState}`);
    window.activePlayerFileId = null;
    const video = document.getElementById('main-player');

    // Cleanup Sync Controller
    if (window.audioSync) {
        window.audioSync.destroy();
        window.audioSync = null;
    }
    if (window.mp4Player) {
        window.mp4Player.detach();
    }

    safePause(video, "closePlayer");
    safeSetSrc(video, "");
    video.innerHTML = "";
    slog(`[TRACK] video.innerHTML cleared.`);

    document.getElementById('player-view').style.display = 'none';
    document.getElementById('player-loading-overlay').classList.add('hidden');
    document.body.style.overflow = '';

    // Hide new popover
    const popover = document.getElementById('settingsPopover');
    if (popover) popover.classList.remove('active');

    transitionTo('IDLE');

    if (window.electronAPI && window.electronAPI.tdlibSend) {
        window.electronAPI.tdlibSend({ '@type': 'stopStreaming' });
    }
}

function updateSubStyle(prop, value) {
    let style = document.getElementById('vtt-styles');
    if (!style) {
        style = document.createElement('style');
        style.id = 'vtt-styles';
        document.head.appendChild(style);
    }
    if (prop === 'fontSize') style.innerHTML = `video::cue { font-size: ${value} !important; }`;
}
