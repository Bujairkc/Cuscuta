const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // TDLib Commands
    init: (config) => ipcRenderer.invoke('tdlib-init', config),
    send: (request) => ipcRenderer.invoke('tdlib-send', request),
    onUpdate: (callback) => ipcRenderer.on('tdlib-update', (event, update) => callback(update)),

    // Streaming
    getStreamUrl: (fileId) => `http://127.0.0.1:3301/stream/${fileId}`,

    // File System (Electron replacements)
    getAutoSavePath: (suggestedName) => ipcRenderer.invoke('get-auto-save-path', suggestedName),
    verifyAndResumeFile: (data) => ipcRenderer.invoke('verify-and-resume-file', data),
    writeChunk: (path, offset, data) => ipcRenderer.invoke('write-chunk', { path, offset, data }),
    closeFile: (path) => ipcRenderer.invoke('close-file', path),
    finalizeDownload: (tdlibPath, destinationPath) => ipcRenderer.invoke('finalize-download', { tdlibPath, destinationPath }),

    // System
    openLocalPlayback: (path) => ipcRenderer.send('open-local-playback', { path }),
    openExternalPlayer: (url) => ipcRenderer.send('open-vlc', url),
    onPrepareShutdown: (callback) => ipcRenderer.on('prepare-for-shutdown', callback),
    signalShutdownReady: () => ipcRenderer.invoke('shutdown-ready'),
    saveForensicLogs: (logs) => ipcRenderer.invoke('save-forensic-logs', logs),

    // Diagnostics
    sendDiagnosticLog: (category, message) => ipcRenderer.send('DIAGNOSTIC_LOG', { category, message }),
    onLogBatch: (callback) => ipcRenderer.on('log-batch', (event, logs) => callback(logs)),

    // Subtitle Readiness
    onSubtitleResolution: (callback) => ipcRenderer.on('subtitle-resolution', (event, data) => callback(data))
});
