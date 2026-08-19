if (typeof DEBUG_DOWNLOADS === 'undefined') {
  self.DEBUG_DOWNLOADS = false;
}

if (typeof dlog !== 'function') {
  self.dlog = (...args) => {
    if (self.DEBUG_DOWNLOADS) console.log(...args);
  };
}

const activeStreams = new Map();

self.addEventListener('install', (event) => {
  dlog('[SW] install event');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  dlog('[SW] activate event');
  event.waitUntil(self.clients.claim());
});

function broadcastProgress(fileId, streamInfo, force = false) {
  const now = Date.now();
  // Throttle updates to ~400ms unless forced (e.g. completion or start)
  if (!force && streamInfo.lastBroadcast && (now - streamInfo.lastBroadcast < 400)) {
    return;
  }
  streamInfo.lastBroadcast = now;

  const bufferSize = (streamInfo.chunkBuffer && typeof streamInfo.chunkBuffer.size === 'number') ? streamInfo.chunkBuffer.size : 0;
  dlog(`[SW DIAG] Progress: received:${streamInfo.received}, streamed:${streamInfo.streamed}, diff:${streamInfo.received - streamInfo.streamed}, buffer:${bufferSize}`);

  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'STREAM_PROGRESS',
        fileId: fileId,
        streamed: streamInfo.streamed,
        received: streamInfo.received,
        size: streamInfo.size,
        speed: streamInfo.lastMeasuredSpeed || 0
      });
    });
  });
}

function broadcastOffset(fileId, offset, isPlayback = false) {
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'BROWSER_OFFSET',
        fileId: fileId,
        offset: offset,
        isPlayback: isPlayback
      });
    });
  });
}

self.addEventListener('message', (event) => {
  const { type, fileId, chunk, size, fileName } = event.data;
  const streamKey = String(fileId);

  if (type === 'START_STREAM') {
    console.log("[SW START_STREAM RECEIVED]", fileId);
    if (activeStreams.has(streamKey)) {
        dlog("[SW] START_STREAM ignored, already exists", streamKey);
    } else {
        dlog("[SW] stream created", streamKey);
        activeStreams.set(streamKey, {
          size: Number(size) || 0,
          fileName,
          received: 0,
          streamed: 0,
          chunkBuffer: new Map(),
          controller: null,
          lastActivity: Date.now(),
          bytesInLastSecond: 0,
          lastMeasuredSpeed: 0
        });
        console.log("[SW STREAM REGISTERED]", streamKey);
    }
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ type: 'REGISTERED', fileId: streamKey });
    }
  } else if (type === 'FORCE_CLAIM_CLIENTS') {
    self.clients.claim().then(() => {
        dlog('[SW] clients.claim() executed via FORCE_CLAIM_CLIENTS');
    });
  } else if (type === 'PUSH_CHUNK') {
    const { offset, chunk } = event.data;
    const streamInfo = activeStreams.get(streamKey);
    if (streamInfo && !streamInfo.isPaused) {
      const numericOffset = Number(offset);
      if (isNaN(numericOffset)) {
        console.error(`[SW ERROR] PUSH_CHUNK received NaN offset for ${streamKey}`);
        return;
      }

      streamInfo.lastActivity = Date.now();
      const uint8Chunk = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);

      // SLICING FIX: Prevent overlapping chunk inflation during stream drops
      if (numericOffset < streamInfo.streamed) {
        const overlap = streamInfo.streamed - numericOffset;
        if (overlap >= uint8Chunk.byteLength) return; // Ignore entirely obsolete chunks
        const slicedChunk = uint8Chunk.slice(overlap);
        streamInfo.chunkBuffer.set(streamInfo.streamed, slicedChunk);
      } else {
        streamInfo.chunkBuffer.set(numericOffset, uint8Chunk);
      }

      // Update received bytes (total unique bytes buffered/streamed)
      const chunkEnd = numericOffset + uint8Chunk.byteLength;
      if (chunkEnd > streamInfo.received) streamInfo.received = chunkEnd;

      // BACKPRESSURE FLUSH: Only push data if the browser can handle it
      const flushBuffer = () => {
        while (
          streamInfo.controller &&
          streamInfo.controller.desiredSize > 0 && // OOM PREVENTION
          streamInfo.chunkBuffer.has(streamInfo.streamed)
        ) {
          const nextChunk = streamInfo.chunkBuffer.get(streamInfo.streamed);
          streamInfo.chunkBuffer.delete(streamInfo.streamed);

          try {
            streamInfo.controller.enqueue(nextChunk);
            streamInfo.streamed += nextChunk.byteLength;
            streamInfo.bytesInLastSecond += nextChunk.byteLength;
          } catch (e) {
            console.error('[SW ERROR] Enqueue failed:', e);
            streamInfo.controller = null;
            streamInfo.chunkBuffer.set(streamInfo.streamed, nextChunk); // Put back
            break;
          }
        }
      };

      flushBuffer();
      broadcastProgress(streamKey, streamInfo);

      if (streamInfo.received >= streamInfo.size && streamInfo.chunkBuffer.size === 0) {
        console.log("[DOWNLOAD COMPLETE]", streamKey);
        if (streamInfo.controller) {
          try { streamInfo.controller.close(); } catch(e) {}
          streamInfo.controller = null;
        }
        broadcastProgress(streamKey, streamInfo, true);
        setTimeout(() => {
          console.log("[SW STREAM REMOVED]", streamKey, "reason: completion timeout");
          activeStreams.delete(streamKey);
        }, 60000);
      }
    }
  } else if (type === 'CLOSE_STREAM') {
    const streamInfo = activeStreams.get(streamKey);
    if (streamInfo) {
      if (streamInfo.controller) {
        try { streamInfo.controller.close(); } catch(e) {}
      }
      console.log("[SW STREAM REMOVED]", streamKey, "reason: CLOSE_STREAM message");
      activeStreams.delete(streamKey);
    }
  } else if (type === 'PAUSE_STREAM') {
    const streamInfo = activeStreams.get(streamKey);
    if (streamInfo) {
      streamInfo.isPaused = true;
      console.log("[PAUSE]", streamKey);
    }
  } else if (type === 'RESUME_STREAM') {
    const streamInfo = activeStreams.get(streamKey);
    if (streamInfo) {
      streamInfo.isPaused = false;
      console.log("[RESUME]", streamKey);
    }
  } else if (type === 'FLUSH_AND_CLOSE_ALL') {
    console.log("[SW] FLUSH_AND_CLOSE_ALL received. Shutting down all streams.");
    activeStreams.forEach((info, id) => {
      if (info.controller) {
        try {
          // Flush any remaining buffered chunks
          if (info.chunkBuffer) {
            while (info.chunkBuffer.has(info.streamed)) {
              const chunk = info.chunkBuffer.get(info.streamed);
              info.chunkBuffer.delete(info.streamed);
              info.streamed += chunk.byteLength;
              info.controller.enqueue(chunk);
            }
          }
          info.controller.close();
        } catch (e) { console.error(`[SW] Error closing stream ${id}:`, e); }
        info.controller = null;
      }
    });
    activeStreams.clear();

    // Acknowledge if a port was provided
    if (event.ports && event.ports[0]) {
        event.ports[0].postMessage({ type: 'FLUSH_COMPLETE' });
    }
  } else if (type === 'CHECK_STREAMS') {
    const alive = [];
    activeStreams.forEach((info, id) => {
        if (info.controller) alive.push(id);
    });
    if (event.ports && event.ports[0]) {
        event.ports[0].postMessage({ type: 'ALIVE_STREAMS', ids: alive });
    }
  } else if (type === 'CHECK_STREAMS_VERBOSE') {
    const data = {};
    activeStreams.forEach((info, id) => {
        if (info.controller) {
            data[id] = { streamed: info.streamed, size: info.size };
        }
    });
    if (event.ports && event.ports[0]) {
        event.ports[0].postMessage({ type: 'ALIVE_STREAMS_VERBOSE', streams: data });
    }
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith('/stream-download/')) {
    const fileId = String(url.pathname.split('/').pop());

    const rangeHeader = event.request.headers.get('Range');
    const streamInfo = activeStreams.get(fileId);

    if (!streamInfo) {
        event.respondWith(new Response("Stream not found", { status: 404 }));
        return;
    }

    let startByte = 0;
    let endByte = streamInfo.size ? streamInfo.size - 1 : undefined;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
      if (match) {
        startByte = parseInt(match[1]);
        if (match[2]) endByte = parseInt(match[2]);
      }
    }

    // Broadcast WAKE_UP for demand-driven architecture
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage({
          type: 'WAKE_UP',
          fileId: fileId,
          offset: startByte
        });
      });
    });

    console.log("[SW FETCH]", {
        fileId,
        rangeHeader,
        streamSize: streamInfo ? streamInfo.size : 'unknown',
        activeController: streamInfo && !!streamInfo.controller
    });

    streamInfo.lastActivity = Date.now();

    const isPlayback = url.searchParams.get('playback') === '1';
    const fileName = (streamInfo.fileName || "").toLowerCase();

    // AGGRESSIVE DETECTION: Catch 'mkv' etc.
    const isUnsupportedContainer = fileName.includes('mkv') || fileName.includes('avi') || fileName.includes('flv') || fileName.includes('wmv');
    const forceSequential = isPlayback && isUnsupportedContainer;
    const isTailProbe = isPlayback && !isUnsupportedContainer && streamInfo.size && (startByte > streamInfo.size - 2 * 1024 * 1024);

    if (forceSequential || isTailProbe) {
        startByte = 0;
    }

    const safeStartByte = Number(startByte) || 0;

    // Always clear stale memory on a fresh thread request
    streamInfo.chunkBuffer.clear();
    streamInfo.streamed = safeStartByte;

    // Demand the exact offset from the main thread
    broadcastOffset(fileId, safeStartByte, isPlayback);

    const safeFileName = encodeURIComponent(streamInfo.fileName || 'video.mp4').replace(/['()]/g, escape).replace(/\*/g, '%2A');
    const contentType = isPlayback ? 'video/mp4' : 'application/octet-stream';
    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Disposition': isPlayback ? 'inline' : `attachment; filename="${streamInfo.fileName || 'video.mp4'}"`,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': forceSequential ? 'none' : 'bytes',
        'Access-Control-Allow-Origin': '*'
    });

    let status = 200;
    if (rangeHeader && streamInfo.size && !forceSequential && !isTailProbe) {
        status = 206;
        const actualEnd = (endByte !== undefined && !isNaN(Number(endByte))) ? Number(endByte) : streamInfo.size - 1;
        headers.set('Content-Range', `bytes ${safeStartByte}-${actualEnd}/${streamInfo.size}`);
        headers.set('Content-Length', String(actualEnd - safeStartByte + 1));
    } else if (streamInfo.size) {
        headers.set('Content-Length', String(streamInfo.size));
    }

    const stream = new ReadableStream({
      start(controller) {
        streamInfo.controller = controller;
      },
      pull(controller) {
        // Demand-driven architecture: Request chunks ONLY when needed
        if (!streamInfo.chunkBuffer.has(streamInfo.streamed)) {
           broadcastOffset(fileId, streamInfo.streamed, isPlayback);
        }
      },
      cancel(reason) {
        streamInfo.controller = null;
        // Prevent memory leak if the user aborts manually
        // Note: activeStreams.delete(fileId) might be too aggressive if we want to support resuming later,
        // but it satisfies the requirement to "Prevent memory leak if the user aborts manually"
        // Actually, let's keep it for now as per instructions.
        activeStreams.delete(fileId);
      }
    });

    event.respondWith(new Response(stream, { status, headers }));
  }
});

// Real speed measurement interval
setInterval(() => {
  for (const [fileId, info] of activeStreams.entries()) {
    if (info.bytesInLastSecond > 0 || info.lastMeasuredSpeed > 0) {
      const mbps = (info.bytesInLastSecond / (1024 * 1024)).toFixed(2);
      const bufferSize = (info.chunkBuffer && typeof info.chunkBuffer.size === 'number') ? info.chunkBuffer.size : 0;

      if (info.bytesInLastSecond > 0) {
        dlog(`[REAL SPEED] ${mbps} MB/s, BufferSize: ${bufferSize}`);
      }

      if (info.controller && bufferSize === 0 && info.bytesInLastSecond === 0) {
          dlog(`[SW STARVATION ALERT] Controller active but no data flowing for ${fileId}`);
          self.clients.matchAll().then(clients => {
              clients.forEach(client => client.postMessage({ type: 'STALL', fileId }));
          });
      }

      info.lastMeasuredSpeed = info.bytesInLastSecond;
      info.bytesInLastSecond = 0;
    }
  }
}, 1000);

// Cleanup of stale streams
setInterval(() => {
  const now = Date.now();
  for (const [fileId, info] of activeStreams.entries()) {
    if (now - info.lastActivity > 60000) {
      console.log("[SW STREAM REMOVED]", fileId, "reason: inactivity timeout");
      activeStreams.delete(fileId);
    }
  }
}, 30000);
