const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const express = require('express');
const fs = require('fs');
const { createClient, configure } = require('tdl');
const EventEmitter = require('events');
const subtitleManager = require('./subtitleManager');
const mkvMetaEngine = require('./mkvMetaEngine');
const clusterManager = require('./clusterManager');
const AudioStreamOrchestrator = require('./js/audio/AudioStreamOrchestrator');
const diagnosticManager = require('./DiagnosticManager');
const transportManager = require('./TransportManager');

const V2_TEST_MODE = true;
const ENABLE_TDLIB_SPAM = false;
const DEBUG_PROGRESS = false;
const DEBUG_METADATA = true;
const DEBUG_CLUSTER = false; // Set to true to see repetitive cluster logs
const fileEvents = new EventEmitter();

// --- DIAGNOSTIC HOOKS ---
ipcMain.on('DIAGNOSTIC_LOG', (event, { category, message }) => {
    diagnosticManager.log(category, message);
});

process.on('uncaughtException', (err) => {
    diagnosticManager.log('backend', `UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
    diagnosticManager.generateBundle();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    diagnosticManager.log('backend', `UNHANDLED REJECTION: ${reason}`);
});

app.on('before-quit', () => {
    diagnosticManager.generateBundle();
});

configure({ tdjson: path.join(__dirname, 'tdjson.dll') });

app.commandLine.appendSwitch('remote-debugging-port', '9222');
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoding,HardwareVideoDecoder');
app.commandLine.appendSwitch('enable-accelerated-video-decode');

function translateToModern(obj) {
    if (Array.isArray(obj)) return obj.map(translateToModern);
    if (obj !== null && typeof obj === 'object') {
        const newObj = {};
        for (let key in obj) {
            if (key === '@type') newObj._ = translateToModern(obj[key]);
            else newObj[key] = translateToModern(obj[key]);
        }
        return newObj;
    }
    return obj;
}

function translateToClassic(obj) {
    if (Array.isArray(obj)) return obj.map(translateToClassic);
    if (obj !== null && typeof obj === 'object') {
        const newObj = {};
        for (let key in obj) {
            if (key === '_') newObj['@type'] = translateToClassic(obj[key]);
            else newObj[key] = translateToClassic(obj[key]);
        }
        return newObj;
    }
    return obj;
}

let client = null;
let subtitleRequestCounter = 0;
const activeSubtitleStreams = new Map(); // trackKey -> AbortController
const activeAudioStreams = new Map(); // trackKey -> AbortController
let playbackOwnership = {
    fileId: null,
    isReady: false,
    lastOffset: 0,
    lastRequestTime: 0
};

async function tdSend(request) {
    if (!client) throw new Error('TDLib not initialized');
    try {
        const response = await client.invoke(translateToModern(request));
        return translateToClassic(response);
    } catch (err) {
        const isCommonError = err.message.includes("Not Found") || err.message.includes("message not found");
        if (!isCommonError) {
            dlog_main('[INVOKE ERROR]', err.message, request);
        }
        throw err;
    }
}

const webServer = express();
const PORT = 3301;
const HOST = '127.0.0.1';

webServer.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

webServer.use((req, res, next) => {
    if (DEBUG_PROGRESS) dlog_main(`[REQUEST] ${req.method} ${req.url}`);
    next();
});

webServer.get('/subtitle-test', (req, res) => {
    const vtt = `WEBVTT

00:00:02.000 --> 00:00:05.000
Hello World`;
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(vtt);
});

webServer.get('/debug', (req, res) => {
    let session = diagnosticManager.sections.session;

    // AUTO-DETECT BACKEND if it says "none" (Fixes the reporting bug)
    let effectiveBackend = session.backend;
    if (effectiveBackend === "none") {
        if (clusterManager.activeParses.size > 0 || mkvMetaEngine.cache.size > 0) {
            effectiveBackend = "MKV";
        }
    }

    // Define the logical "Teams" for each pipeline
    const pipelines = {
        "MKV": [
            "mkvMetaEngine.js", "clusterManager.js", "subtitleManager.js",
            "WebMAudioSerializer.js", "AACSerializer.js", "ISOBMFFSerializer.js",
            "MP4Generator.js", "TimestampConverter.js", "SampleBuilder.js"
        ],
        "MP4": [
            "MP4Backend.js", "mp4box.all.cjs", "styp-CouZUj9h.cjs", "MP4MSEPlayer.js", "MP4BufferController.js"
        ],
        "Universal": [
            "main.js", "TransportManager.js", "MediaDataSource.js",
            "DiagnosticManager.js", "AudioStreamOrchestrator.js", "preload.js"
        ]
    };

    // Get all project files currently in Node memory
    const loadedFiles = Object.keys(require.cache)
        .filter(p => (p.includes('project') || p.includes('StreamVault')) && !p.includes('node_modules'))
        .map(p => path.basename(p));

    // Determine Usage Status
    const participating = [];
    const idle = [];

    loadedFiles.forEach(file => {
        const isUniversal = pipelines.Universal.includes(file);
        const isTargetBackend = effectiveBackend !== "none" && pipelines[effectiveBackend] && pipelines[effectiveBackend].includes(file);

        if (isUniversal || isTargetBackend) {
            participating.push(file);
        } else {
            idle.push(file);
        }
    });

    const activity = [];
    if (transportManager.activeGapRepairs.size > 0) activity.push("Transport: Fetching bytes from TDLib");
    if (clusterManager.activeParses.size > 0) activity.push("MKV: Parsing cluster data");
    if (mkvMetaEngine.activeParses.size > 0) activity.push("MKV Meta: Processing EBML header");

    let html = `
    <html>
    <head>
        <title>StreamVault Live Logic Map</title>
        <style>
            body { font-family: 'Segoe UI', sans-serif; background: #0f0f0f; color: #eee; padding: 20px; }
            .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
            h2 { color: #00ffff; font-size: 1.1em; border-bottom: 1px solid #333; padding-bottom: 10px; text-transform: uppercase; }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
            .file { padding: 10px; border-radius: 4px; border: 1px solid #444; font-size: 0.9em; text-align: center; }
            .active { background: #1b3a1b; border-color: #00ff00; color: #00ff00; font-weight: bold; box-shadow: 0 0 10px rgba(0,255,0,0.1); }
            .unused { background: #2a2a2a; color: #666; border-style: dashed; }
            .hot-text { color: #ff4d4d; font-weight: bold; }
        </style>
        <meta http-equiv="refresh" content="2">
    </head>
    <body>
        <h1 style="text-align: center; color: #00ffff;">Live Logic Usage Analysis</h1>

        <div class="card">
            <h2>Current Session State</h2>
            <div style="font-size: 1.2em;">
                Detected Pipeline: <span class="hot-text">${effectiveBackend}</span><br>
                Target File: <span style="color: #00ff00;">${session.filename || "None"}</span><br>
                Functions Running: <span class="hot-text">${activity.length > 0 ? activity.join(" | ") : "Idle"}</span>
            </div>
        </div>

        <div class="card">
            <h2 style="color: #00ff00;">Participating Files (Driving your ${effectiveBackend} playback)</h2>
            <div class="grid">
                ${participating.map(f => `<div class="file active">${f}</div>`).join('')}
            </div>
        </div>

        <div class="card">
            <h2 style="color: #666;">Idle Modules (Loaded but NOT used for ${effectiveBackend})</h2>
            <div class="grid">
                ${idle.map(f => `<div class="file unused">${f}</div>`).join('')}
            </div>
        </div>

        <div class="card">
            <h2>Transport Layer Health</h2>
            Active Priority Windows: ${transportManager.activePlayerRanges.size}<br>
            Ongoing Byte Repairs: ${transportManager.activeGapRepairs.size}<br>
            Accumulated Requests: ${session.transportRequests}
        </div>

        <p style="text-align: center; color: #444; font-size: 0.8em;">Heartbeat: ${new Date().toLocaleTimeString()} (Refreshes every 2s)</p>
    </body>
    </html>`;

    res.send(html);
});

webServer.get('/stream/:fileId/subtitles', async (req, res) => {
    const fileId = parseInt(req.params.fileId);
    if (DEBUG_METADATA) dlog_main(`[SUBTITLE API] Request for fileId=${fileId}`);
    try {
        const file = await tdSend({ '@type': 'getFile', 'file_id': fileId });
        if (!file.local || !file.local.path) {
            return res.json([]);
        }

        const metadata = await mkvMetaEngine.parse(fileId, file.local.path, tdSend, fileEvents, (msg) => {
            if (DEBUG_METADATA) dlog_main(msg);
        });

        const allTracks = metadata.tracks || [];
        const subTracks = allTracks.filter(t => t.type === 'subtitle');

        const tracks = subTracks.map(t => ({
            id: `embedded_${t.number}`,
            type: 'embedded',
            label: t.title || `Track ${t.number}`,
            language: t.language || 'und',
            format: (t.codec && t.codec.includes('UTF8')) ? 'srt' : 'ass',
            codec: t.codec,
            trackNumber: t.number,
            fileId: fileId
        }));

        const external = await subtitleManager.discoverExternalSubtitles(fileId, file.local.path);
        const seenIds = new Set();
        const finalTracks = [];
        [...tracks, ...external].forEach(t => {
            if (!seenIds.has(t.id)) {
                seenIds.add(t.id);
                finalTracks.push(t);
            }
        });

        res.json(finalTracks);
    } catch (e) {
        dlog_main(`[SUBTITLE ERROR] API failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

webServer.get('/stream/:fileId/tracks', async (req, res) => {
    const fileId = parseInt(req.params.fileId);
    try {
        const file = await tdSend({ '@type': 'getFile', 'file_id': fileId });
        if (!file.local || !file.local.path) return res.status(404).json({ error: 'File not found' });

        const orchestrator = new AudioStreamOrchestrator(fileId, file.local.path, tdSend, fileEvents, dlog_main);
        const metadata = await orchestrator.getMetadata();
        const { containerType } = await orchestrator._resolveBackend();

        console.log(`[MP4 ROUTE] manifest request file=${fileId}`);
        console.log(`[MP4 ROUTE] resolved container=${containerType}`);

        const manifest = {
            fileId,
            container: containerType,
            duration: metadata.duration,
            timecodeScale: metadata.timecodeScale,
            video: [],
            audio: [],
            subtitles: []
        };

        (metadata.tracks || []).forEach(t => {
            const cleanCodec = (t.codec || "").trim();
            const trackBase = {
                trackNumber: t.number,
                codec: cleanCodec,
                language: t.language || 'und',
                title: t.title || '',
                default: !!t.flags?.default,
                supported: true
            };

            if (t.type === 'video') {
                manifest.video.push(trackBase);
            } else if (t.type === 'audio') {
                // Phase 1: Opus & Vorbis supported
                // Phase 2: AAC supported if no ContentEncodings
                let audioSupported = false;
                if (cleanCodec === 'A_OPUS' || cleanCodec === 'A_VORBIS') {
                    audioSupported = true;
                } else if (cleanCodec === 'A_AAC') {
                    // AAC supported if no ContentEncodings
                    audioSupported = !(t.contentEncodings && t.contentEncodings.length > 0);
                }
                trackBase.supported = audioSupported;
                trackBase.channels = t.channels;
                trackBase.samplingFrequency = t.samplingFrequency;
                manifest.audio.push(trackBase);
            } else if (t.type === 'subtitle') {
                trackBase.id = `embedded_${t.number}`;
                trackBase.type = 'embedded';
                trackBase.format = (t.codec && t.codec.includes('UTF8')) ? 'srt' : 'ass';
                manifest.subtitles.push(trackBase);
            }
        });

        // Add external subtitles
        const external = await subtitleManager.discoverExternalSubtitles(fileId, file.local.path);
        external.forEach(ext => {
            manifest.subtitles.push({
                id: ext.id,
                type: 'external',
                trackNumber: null,
                codec: ext.format,
                language: ext.language,
                title: ext.label,
                supported: true
            });
        });

        res.json(manifest);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

webServer.get('/stream/:fileId/subtitles/:trackId', async (req, res) => {
    const requestId = ++subtitleRequestCounter;
    const fileId = parseInt(req.params.fileId);
    const trackId = req.params.trackId;

    console.log(`\n[HTTP AUDIT] REQUEST CREATED | RequestID: ${requestId} | TrackID: ${trackId} | SeekSession: ${mkvMetaEngine.currentSeekSessionId} | VideoTime: UNKNOWN`);

    try {
        const file = await tdSend({ '@type': 'getFile', 'file_id': fileId });
        if (!file || !file.local || !file.local.path) throw new Error("File path missing");

        const subTracks = mkvMetaEngine.getSubtitleTracks(fileId);
        let track = subTracks.find(t => `embedded_${t.number}` === trackId);

        if (!track) {
            const external = await subtitleManager.discoverExternalSubtitles(fileId, file.local.path);
            track = external.find(t => t.id === trackId);
        }

        if (!track) return res.status(404).send('Track not found');

        if (track.number && !track.trackNumber) {
            track = {
                id: `embedded_${track.number}`,
                type: 'embedded',
                trackNumber: track.number,
                codec: track.codec,
                fileId: fileId,
                language: track.language
            };
        }

        const trackKey = `${fileId}:${trackId}`;
        if (activeSubtitleStreams.has(trackKey)) {
            dlog_main(`[SESSION] Aborting old stream for ${trackKey}`);
            activeSubtitleStreams.get(trackKey).abort("New request arrived");
        }

        const controller = new AbortController();
        activeSubtitleStreams.set(trackKey, controller);

        const originalAbort = controller.abort;
        controller.abort = (who) => {
            console.log(`\n[ABORT AUDIT] AbortController | RequestID: ${requestId} | Who: ${who || 'unknown'}`);
            console.log(`Stack trace:\n${new Error().stack.split('\n').slice(1, 6).join('\n')}`);
            originalAbort.call(controller);
        };

        req.on('close', () => {
            const isServerEnded = res.writableEnded || res.finished;
            const reason = isServerEnded ? "server ended" : "client aborted";
            console.log(`\n[HTTP AUDIT] REQUEST CLOSE | RequestID: ${requestId} | TrackID: ${trackId} | SeekSession: ${mkvMetaEngine.currentSeekSessionId} | Close initiated by: ${reason} | res.finished: ${res.finished} | res.destroyed: ${res.destroyed} | socket.destroyed: ${res.socket?.destroyed} | headersSent: ${res.headersSent} | bytesWritten: ${res.socket?.bytesWritten}`);
            controller.abort("req.on('close')");
        });

        res.on('finish', () => {
            console.log(`\n[HTTP AUDIT] REQUEST FINISH | RequestID: ${requestId} | TrackID: ${trackId} | res.finished: ${res.finished} | res.destroyed: ${res.destroyed} | socket.destroyed: ${res.socket?.destroyed}`);
        });

        res.on('error', (err) => {
            console.log(`\n[HTTP AUDIT] REQUEST ERROR | RequestID: ${requestId} | TrackID: ${trackId} | Error: ${err.message}`);
        });

        // Perform Progressive Streaming via new Cluster Architecture
        const startTimeMs = (parseFloat(req.query.start) || 0) * 1000;
        const sessionId = parseInt(req.query.sessionId) || 0;

        dlog_main(`[SESSION] Starting Progressive Stream for ${track.id} at ${req.query.start || 0}s (MKV Track: ${track.trackNumber}) | Session: ${sessionId}`);
        try {
            const onResolution = (state) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('subtitle-resolution', { sessionId, state });
                }
            };

            // Pass the correct internal track object containing trackNumber
            await subtitleManager.streamVTT(track, file.local.path, tdSend, fileEvents, dlog_main, res, controller.signal, startTimeMs, onResolution);
        } catch (vttErr) {
            dlog_main(`[SESSION] Stream Error: ${vttErr.message}`);
            if (!res.headersSent) res.status(500).send(vttErr.message);
            else res.end();
        } finally {
            if (activeSubtitleStreams.get(trackKey) === controller) {
                activeSubtitleStreams.delete(trackKey);
            }
        }

    } catch (err) {
        dlog_main(`[HTTP ERROR] ${err.name}: ${err.message}\n${err.stack}`);
        if (!res.headersSent) {
            res.status(500).send(err.stack);
        }
    }
});

webServer.get('/stream/:fileId/mp4/unified', async (req, res) => {
    console.log(`[HTTP] Unified Request: ${req.url}`);
    const fileId = parseInt(req.params.fileId);
    let startS = parseFloat(req.query.start) || 0;

    // Hard Validation
    if (!isFinite(startS) || startS < 0) {
        console.warn(`[MP4 UNIFIED] Invalid start time received: ${req.query.start}. Clamping to 0.`);
        startS = 0;
    }

    const generation = parseInt(req.query.gen) || 0;

    dlog_main(`[MP4 UNIFIED] START fileId=${fileId} start=${startS}s gen=${generation}`);

    try {
        const file = await tdSend({ '@type': 'getFile', 'file_id': fileId });
        if (!file?.local?.path) {
            dlog_main(`[MP4 UNIFIED ERROR] File path missing for fileId=${fileId}`);
            return res.status(404).send('File not found');
        }

        const orchestrator = new AudioStreamOrchestrator(fileId, file.local.path, tdSend, fileEvents, dlog_main);
        const { containerType, instance: backend } = await orchestrator._resolveBackend();
        dlog_main(`[MP4 UNIFIED] backend found: ${containerType}`);

        if (containerType !== 'mp4') {
            dlog_main(`[MP4 UNIFIED ERROR] Invalid container type: ${containerType}`);
            return res.status(400).send('Unified route is MP4 only');
        }

        // Phase 1 FIX: Wait for Discovery to FINISH before starting playback session
        dlog_main(`[MP4 UNIFIED] ensuring metadata ready...`);
        await backend.init();

        dlog_main(`[MP4 UNIFIED] transport ready, calling startSession`);
        // Phase 4 & 5 FIX: Pass generation and fileEvents to startSession to wake stale listeners
        const sessionId = await transportManager.startSession(fileId, tdSend, generation, fileEvents);
        dlog_main(`[MP4 UNIFIED] sessionId=${sessionId} created`);
        const controller = new AbortController();
        req.on('close', () => controller.abort());

        dlog_main(`[MP4 UNIFIED] metadata ready, calling streamUnified`);
        // streamUnified inter-leaves A/V segments from a single MP4Box session
        await backend.streamUnified(res, startS * 1000, controller.signal, sessionId);
    } catch (err) {
        console.error(`[MP4 UNIFIED FATAL] ${err.message}`, err.stack);
        dlog_main(`[MP4 UNIFIED ERROR] ${err.message}\n${err.stack}`);
        if (!res.headersSent) {
            res.status(500).send(err.message);
        }
    }
});

// --- Audio Track Streaming ---

let audioRequestCounter = 0;

webServer.get('/stream/:fileId/audio/:trackNumber', async (req, res) => {
    const requestId = ++audioRequestCounter;
    const fileId = parseInt(req.params.fileId);
    const trackNumber = parseInt(req.params.trackNumber);
    const startTimeMs = (parseFloat(req.query.start) || 0) * 1000;

    console.log(`[ROUTER ENTER] method=${req.method} url=${req.url} track=${trackNumber} start=${startTimeMs}ms requestId=${requestId}`);
    dlog_main(`[ROUTER] #${requestId} CALL webServer.get(/audio/:trackNumber) | url=${req.url} | fileId=${fileId} | track=${trackNumber} | start=${startTimeMs}ms`);

    try {
        const file = await tdSend({ '@type': 'getFile', 'file_id': fileId });
        if (!file || !file.local || !file.local.path) {
            return res.status(404).send('File not available');
        }

        const filePath = file.local.path;

        const trackKey = `${fileId}:audio:${trackNumber}`;
        if (activeAudioStreams.has(trackKey)) {
            dlog_main(`[AUDIO] Aborting old stream for ${trackKey}`);
            activeAudioStreams.get(trackKey).abort('New request arrived');
        }

        const controller = new AbortController();
        activeAudioStreams.set(trackKey, controller);

        req.on('close', () => {
            controller.abort('Client disconnected');
            if (activeAudioStreams.get(trackKey) === controller) {
                activeAudioStreams.delete(trackKey);
            }
        });

        const orchestrator = new AudioStreamOrchestrator(fileId, filePath, tdSend, fileEvents, dlog_main);
        const mode = req.query.mode || 'adts';
        dlog_main(`[ROUTER] #${requestId} CALL orchestrator.getBackend(track=${trackNumber}, mode=${mode})`);
        const backend = await orchestrator.getBackend(trackNumber, mode);

        if (!backend.supported) {
            dlog_main(`[ROUTER] #${requestId} RETURN backend not supported: constructor=${backend.constructor.name}`);
            res.status(415).json({ error: 'Unsupported codec', codec: backend.codec });
            return;
        }

        dlog_main(`[ROUTER] #${requestId} CALL ${backend.constructor.name}.streamToResponse()`);
        await backend.streamToResponse(res, startTimeMs, controller.signal, trackNumber);
    } catch (err) {
        dlog_main(`[AUDIO] #${requestId} Error: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).send(err.message);
        }
    }
});

let requestCounter = 0;
const activeReadStreams = new Map(); // fileId -> { stream, requestId }

webServer.all('/stream/:fileId', async (req, res) => {
    const requestId = ++requestCounter;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).send('Method Not Allowed');
    }

    const fileId = parseInt(req.params.fileId);
    const rangeHeader = req.headers.range;

    dlog_main(`[ROUTER] #${requestId} CALL webServer.all(/stream/:fileId) | url=${req.url} | range=${rangeHeader || 'FULL'}`);

    // Lifecycle: Ownership
    if (playbackOwnership.fileId !== fileId) {
        dlog_main(`[SYSTEM] Playback hijacked by fileId=${fileId}. Resetting old states.`);
        mkvMetaEngine.cancel(playbackOwnership.fileId, dlog_main);
        playbackOwnership.fileId = fileId;
        playbackOwnership.isReady = false;
        // Capture savePath if provided in query for local redirection
        if (req.query.savePath) {
            playbackOwnership.savePath = decodeURIComponent(req.query.savePath);
        } else {
            playbackOwnership.savePath = null;
        }
    }

    let isRequestActive = true;

    const cleanup = () => {
        if (!isRequestActive) return;
        isRequestActive = false;

        clusterManager.setActivePlayerRange(fileId, 0, 0);

        // Ensure playback block is released when request ends
        mkvMetaEngine.isPlaybackBlocked = false;

        if (activeReadStreams.get(fileId)?.requestId === requestId) {
            activeReadStreams.delete(fileId);
        }
        dlog_main(`[STREAM] #${requestId} CLOSED`);
    };

    req.on('close', cleanup);
    res.on('finish', cleanup);

    if (isNaN(fileId) || !client) return res.status(400).send('Invalid state');

    try {
        let file = await tdSend({ '@type': 'getFile', 'file_id': fileId });

        // Find if this task is marked as COMPLETED on disk
        // We'll pass the manager status via a global flag or check in a future IPC
        // For now, we check if the file is already 100% and exists at its savePath
        let originalPath = file.local?.path;
        let totalSize = parseInt(file.size, 10) || 0;

        // VERIFY: If TDLib cache is empty but we have a savePath, use savePath!
        // This is the core of the "Ghost TDLib" logic.
        if (playbackOwnership.fileId === fileId && playbackOwnership.savePath && fs.existsSync(playbackOwnership.savePath)) {
            originalPath = playbackOwnership.savePath;
            dlog_main(`[STREAM] Redirecting to Local SavePath: ${originalPath}`);
        } else if (!file.local || !file.local.path || !fs.existsSync(file.local.path)) {
            // Sequential Nudge for missing cache
            let attempts = 0;
            while ((!file.local || !file.local.path || !fs.existsSync(file.local.path)) && attempts < 30) {
                if (!isRequestActive) return;
                tdSend({ '@type': 'downloadFile', 'file_id': fileId, 'priority': 32, 'offset': 0, 'limit': 0, 'synchronous': false }).catch(() => {});
                await new Promise(r => setTimeout(r, 1000));
                file = await tdSend({ '@type': 'getFile', 'file_id': fileId });
                attempts++;
            }
            if (file.local?.path) originalPath = file.local.path;
        }

        if (!originalPath || !fs.existsSync(originalPath)) return res.status(504).send('Timeout');

        // 1. Determine Range
        let start = 0, end = totalSize - 1;
        if (rangeHeader) {
            const parts = rangeHeader.replace(/bytes=/, "").split("-");
            start = parseInt(parts[0], 10) || 0;
            if (parts[1]) end = parseInt(parts[1], 10);
        }
        if (end >= totalSize) end = totalSize - 1;

        const chunksize = (end - start) + 1;
        const isPartial = !!rangeHeader;

        // 2. Register Ownership & Setup Response
        clusterManager.setActivePlayerRange(fileId, start, end);
        playbackOwnership.lastOffset = start;

        let ext = path.extname(req.query.name || "").toLowerCase();
        const mimeMap = { '.mkv': 'video/webm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo' };
        const headers = {
            'Accept-Ranges': 'bytes',
            'Content-Type': mimeMap[ext] || 'video/mp4',
            'Content-Length': chunksize,
            'Connection': 'keep-alive'
        };
        if (isPartial) headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;

        if (DEBUG_PROGRESS) dlog_main(`[STREAM] #${requestId} READY range=${start}-${end}/${totalSize}`);
        res.writeHead(isPartial ? 206 : 200, headers);

        if (req.method === 'HEAD') return res.end();

        // 3. Reactive Pumping Loop
        let currentPos = start;
        let fd = fs.openSync(originalPath, 'r');

        const pump = async () => {
            if (!isRequestActive) return;

            try {
                const f = await tdSend({ '@type': 'getFile', 'file_id': fileId });
                if (!isRequestActive || fd === null) return;

                const dlOffset = f.local.download_offset || 0;
                const dlPrefix = f.local.downloaded_prefix_size || 0;
                const dlEnd = dlOffset + dlPrefix;

                // How much can we read right now?
                let availableToRead = 0;
                if (f.local.is_downloading_completed) {
                    availableToRead = (end - currentPos) + 1;
                } else if (currentPos >= dlOffset && currentPos < dlEnd) {
                    availableToRead = Math.min(dlEnd - currentPos, (end - currentPos) + 1);
                }

                if (availableToRead > 0) {
                    const buffer = Buffer.alloc(Math.min(availableToRead, 1024 * 1024)); // 1MB chunks
                    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, currentPos);

                    if (bytesRead > 0) {
                        res.write(buffer.slice(0, bytesRead));
                        currentPos += bytesRead;
                        if (currentPos > end) {
                            res.end();
                            return;
                        }
                        // Continue pumping immediately if more bytes available
                        setImmediate(pump);
                    } else {
                        // Wait for TDLib update
                        fileEvents.once(`update_${fileId}`, pump);
                    }
                } else {
                    // Bytes not available. Start/Update sequential download.
                    tdSend({
                        '@type': 'downloadFile', 'file_id': fileId, 'priority': 32,
                        'offset': currentPos, 'limit': 0, 'synchronous': false
                    }).catch(() => {});

                    // Wait for TDLib update
                    fileEvents.once(`update_${fileId}`, pump);
                }
            } catch (err) {
                dlog_main(`[STREAM] #${requestId} Pump Error: ${err.message}`);
                res.end();
            }
        };

        req.on('close', () => {
            isRequestActive = false;
            if (fd) { try { fs.closeSync(fd); } catch(e){} fd = null; }
        });

        pump();

    } catch (err) {
        if (isRequestActive && !res.headersSent) res.status(500).send('Internal Error');
    }
});

const server = webServer.listen(PORT, HOST, () => {
    console.log(`[SERVER] Listening on http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
    console.error('[SERVER] Failed to start:', err);
});

let mainWindow;
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280, height: 800, backgroundColor: '#0f0f0f',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    mainWindow.loadFile('index.html');
    mainWindow.on('close', async (event) => {
        if (app.isQuitting) return;
        event.preventDefault();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('prepare-for-shutdown');
        setTimeout(() => { if (!app.isQuitting) { app.isQuitting = true; app.quit(); } }, 10000);
    });
}
app.whenReady().then(createWindow);
app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function dlog_main(...args) {
    const str = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    if (ENABLE_TDLIB_SPAM || !str.includes('updateFile')) {
        console.log(...args);
        diagnosticManager.log('backend', str);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        logBatcher.add(str);
    }
}

const logBatcher = {
    queue: [],
    timer: null,
    add(msg) {
        this.queue.push(msg);
        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), 200);
        }
    },
    flush() {
        if (this.queue.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('log-batch', this.queue);
            this.queue = [];
        }
        this.timer = null;
    }
};

const openFiles = new Map();
ipcMain.handle('get-auto-save-path', async (event, suggestedName) => {
    const downloadsPath = app.getPath('downloads');
    const streamVaultPath = path.join(downloadsPath, 'StreamVault');
    if (!fs.existsSync(streamVaultPath)) fs.mkdirSync(streamVaultPath, { recursive: true });
    let finalPath = path.join(streamVaultPath, suggestedName);
    let counter = 1;
    const ext = path.extname(suggestedName);
    const base = path.basename(suggestedName, ext);
    while (fs.existsSync(finalPath)) { finalPath = path.join(streamVaultPath, `${base} (${counter})${ext}`); counter++; }
    if (!fs.existsSync(finalPath)) fs.writeFileSync(finalPath, Buffer.alloc(0));
    return finalPath;
});

ipcMain.handle('verify-and-resume-file', async (event, { fileId, savePath, lastOffset }) => {
    try {
        if (!fs.existsSync(savePath)) return { success: false, error: 'MISSING' };
        const stats = fs.statSync(savePath);
        let verifiedOffset = lastOffset;
        if (stats.size < lastOffset) verifiedOffset = stats.size;
        if (!openFiles.has(savePath)) openFiles.set(savePath, fs.openSync(savePath, 'r+'));
        return { success: true, verifiedOffset };
    } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('write-chunk', async (event, { path: filePath, offset, data }) => {
    try {
        const buffer = Buffer.from(data);
        let fd = openFiles.get(filePath);
        if (!fd) { fd = fs.openSync(filePath, 'r+'); openFiles.set(filePath, fd); }
        fs.writeSync(fd, buffer, 0, buffer.length, offset);
        fs.fsyncSync(fd);
        return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('finalize-download', async (event, { tdlibPath, destinationPath }) => {
    try {
        // CLOSE any active player streams for this file to prevent "File Busy" errors
        for (const [fileId, info] of activeReadStreams.entries()) {
            // We check if the stream belongs to the same file being finalized
            // Note: Since we don't store path in activeReadStreams, we check all for safety
            // or we can just destroy all streams for this specific fileId if provided
            if (info.stream.path === tdlibPath) {
                dlog_main(`[FINALIZE] Closing active read stream for ${fileId}`);
                info.stream.destroy();
                activeReadStreams.delete(fileId);
            }
        }

        return new Promise((resolve) => {
            fs.copyFile(tdlibPath, destinationPath, (err) => {
                if (err) resolve({ success: false, error: err.message });
                else resolve({ success: true });
            });
        });
    } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('close-file', async (event, filePath) => {
    const fd = openFiles.get(filePath);
    if (fd) { try { fs.closeSync(fd); } catch(e) {} openFiles.delete(filePath); }
    return { success: true };
});

ipcMain.handle('save-forensic-logs', async (event, logs) => {
    try {
        const downloadsPath = app.getPath('downloads');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `StreamVault_Sync_Log_${timestamp}.txt`;
        const filePath = path.join(downloadsPath, fileName);

        fs.writeFileSync(filePath, logs);
        return { success: true, path: filePath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('shutdown-ready', async () => {
    for (const [filePath, fd] of openFiles.entries()) { try { fs.fsyncSync(fd); fs.closeSync(fd); } catch (err) {} }
    openFiles.clear();
    app.isQuitting = true; app.quit();
    return true;
});

ipcMain.handle('tdlib-init', async (event, config) => {
    if (client) return { success: true };
    try {
        const dbPath = path.join(app.getPath('userData'), 'tdlib_data');
        client = createClient({
            apiId: config.apiId, apiHash: config.apiHash, databaseDirectory: dbPath,
            tdlibParameters: {
                use_message_database: true, use_file_database: true, use_chat_info_database: true, use_secret_chats: false,
                system_language_code: 'en', device_model: 'Desktop', application_version: '1.0',
                api_id: config.apiId, api_hash: config.apiHash, database_directory: dbPath,
                files_directory: path.join(dbPath, 'files')
            }
        });
        client.on('update', (update) => {
            const classic = translateToClassic(update);
            if (classic['@type'] === 'updateFile') {
                const f = classic.file;
                fileEvents.emit(`update_${f.id}`, f);
            }
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tdlib-update', classic);
        });
        return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('tdlib-send', async (event, request) => {
    try {
        if (request['@type'] === 'stopStreaming') {
            const fileId = parseInt(request.file_id);
            dlog_main(`[SYSTEM] Stop request for fileId=${fileId}. Cancelling parsers.`);
            mkvMetaEngine.cancel(fileId, dlog_main);
            if (playbackOwnership.fileId === fileId) {
                playbackOwnership.fileId = null;
                playbackOwnership.isReady = false;
            }
            return { success: true };
        }
        return await tdSend(request);
    } catch (err) { return { '@type': 'error', message: err.message }; }
});

ipcMain.on('open-local-playback', (event, { path: filePath }) => {
    const { exec } = require('child_process');
    exec(`vlc "${filePath}"`, (err) => {
        if (err) {
            const { shell } = require('electron');
            shell.openPath(filePath).catch(e => console.error('[SYSTEM] Failed to open local path:', e));
        }
    });
});
