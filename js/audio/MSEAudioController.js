/**
 * MSEAudioController - Standalone MediaSource layer for fragmented MP4.
 */
let msInstanceCounter = 0;
let sbInstanceCounter = 0;

class MSEAudioController {
    constructor(audioElement) {
        this.audio = audioElement;
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.queue = [];
        this.isAppending = false;
        this.isRemoving = false;
        this.eosPending = false;
        this.activeSession = null;
        this.mimeType = 'audio/mp4; codecs="mp4a.40.2"'; // Standard AAC-LC in MP4

        // Configurable Constants
        this.FORWARD_BUFFER_SECONDS = 60;
        this.BACKPRESSURE_LOW_WATERMARK = 50;
        this.BACK_BUFFER_SECONDS = 20;

        // Instrumentation State
        this._lastCaller = "none";
        this._lastDecision = "none";
        this._lastAppendTime = 0;
        this._lastUpdateEndTime = 0;
        this._stallSnapshotTaken = false;

        this.onUpdateEnd = this._onUpdateEnd.bind(this);

        // --- EXTENSIVE LIFECYCLE AUDIT ---
        const slaveEvents = [
            'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'stalled', 'error', 'timeupdate', 'waiting', 'seeking', 'seeked'
        ];
        slaveEvents.forEach(ev => {
            this.audio.addEventListener(ev, () => {
                const session = this.activeSession;
                if (!session) return;
                const b = this.audio.buffered;
                let ranges = "";
                for(let i=0; i<b.length; i++) ranges += `[${b.start(i).toFixed(3)}-${b.end(i).toFixed(3)}] `;
                console.log(`[MEDIA-EVENT] Element=AUDIO | Event=${ev} | A.pos=${this.audio.currentTime.toFixed(3)} | V.pos=${window.audioSync?.video?.currentTime.toFixed(3)} | ready=${this.audio.readyState} | network=${this.audio.networkState} | buf=${ranges || 'empty'} | perf=${performance.now().toFixed(2)}`);
            });
        });

        // Detailed WAITING forensic log as requested
        this.audio.addEventListener("waiting", () => {
            const session = this.activeSession;
            if (!session) return;

            const b = this.audio.buffered;
            const ranges = [];
            let gapToNext = "none";
            for (let i = 0; i < b.length; i++) {
                const start = b.start(i);
                const end = b.end(i);
                ranges.push({ start: start.toFixed(3), end: end.toFixed(3) });
                if (this.audio.currentTime < start && gapToNext === "none") {
                    gapToNext = (start - this.audio.currentTime).toFixed(3);
                }
            }

            const sb = this.sourceBuffer;
            const sbRanges = [];
            if (sb) {
                const sbb = sb.buffered;
                for (let i = 0; i < sbb.length; i++) {
                    sbRanges.push({ start: sbb.start(i).toFixed(3), end: sbb.end(i).toFixed(3) });
                }
            }

            console.error(`[WAITING-FORENSIC] Session=${session.id}`, {
                event: "WAITING",
                currentTime: this.audio.currentTime.toFixed(3),
                readyState: this.audio.readyState,
                networkState: this.audio.networkState,
                paused: this.audio.paused,
                ended: this.audio.ended,
                seeking: this.audio.seeking,
                duration: this.audio.duration,
                buffered: ranges,
                gapToNextRange: gapToNext,
                // Add Media Internal missing info
                mediaSource: {
                    readyState: this.mediaSource?.readyState,
                    duration: this.mediaSource?.duration,
                    nbSourceBuffers: this.mediaSource?.sourceBuffers.length,
                    nbActiveSourceBuffers: this.mediaSource?.activeSourceBuffers.length
                },
                sourceBuffer: {
                    updating: sb?.updating,
                    buffered: sbRanges,
                    timestampOffset: sb?.timestampOffset,
                    appendWindowStart: sb?.appendWindowStart,
                    appendWindowEnd: sb?.appendWindowEnd,
                    queueLength: this.queue.length,
                    isAppending: this.isAppending,
                    isRemoving: this.isRemoving,
                    lastDecision: this._lastDecision,
                    lastCaller: this._lastCaller,
                    timeSinceLastAppendMs: Date.now() - this._lastAppendTime,
                    timeSinceLastUpdateMs: Date.now() - this._lastUpdateEndTime
                }
            });
        });
    }

    async load(url, session, onMetadata) {
        const msId = ++msInstanceCounter;
        console.log(`[MSE-AUDIT] [SESSION START] Session=${session.id} | MS_ID=${msId}`);
        this.stop();
        this.activeSession = session;
        this.eosPending = false;
        this.sessionMsId = msId;
        this._stallSnapshotTaken = false;

        this.mediaSource = new MediaSource();
        this.audio.src = URL.createObjectURL(this.mediaSource);

        await new Promise((resolve, reject) => {
            const onOpen = () => {
                if (this.activeSession !== session) return;
                this.mediaSource.removeEventListener('sourceopen', onOpen);
                try {
                    this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeType);
                    this.sessionSbId = ++sbInstanceCounter;
                    this.sourceBuffer.addEventListener('updateend', this.onUpdateEnd);
                    resolve();
                } catch (err) { reject(err); }
            };
            this.mediaSource.addEventListener('sourceopen', onOpen);
            session.addTimeout(() => reject(new Error("MSE open timeout")), 15000);
        });

        if (this.activeSession === session) {
            this._fetchStream(url, session, onMetadata);
        }
    }

    stop() {
        if (this.activeSession) console.log(`[MSE-AUDIT] [STOP] Session=${this.activeSession.id}`);
        this.activeSession = null;
        if (this.sourceBuffer) {
            this.sourceBuffer.removeEventListener('updateend', this.onUpdateEnd);
            this.sourceBuffer = null;
        }
        if (this.mediaSource) {
            URL.revokeObjectURL(this.audio.src);
            this.audio.src = '';
            this.mediaSource = null;
        }
        this.queue = [];
        this.isAppending = false;
        this.isRemoving = false;
    }

    async _fetchStream(url, session, onMetadata) {
        console.log(`[FETCH DISPATCHED] session=${session.id} url=${url}`);
        try {
            const response = await fetch(url, { signal: session.abortController.signal });
            console.log(`[FETCH RESPONSE] session=${session.id} status=${response.status} ok=${response.ok}`);

            if (this.activeSession !== session) {
                console.log(`[FETCH ABORTED] session=${session.id} reason=session_mismatch`);
                return;
            }

            const requestedStart = (parseFloat(response.headers.get('X-Audio-Requested-Start-Ms')) || 0) / 1000;
            const actualStart = (parseFloat(response.headers.get('X-Audio-Actual-Start-Ms')) || 0) / 1000;

            if (this.sourceBuffer) {
                this.sourceBuffer.timestampOffset = 0;
                console.log(`[MSE-TIMELINE] Parity Mode | Requested=${requestedStart.toFixed(3)}s Actual=${actualStart.toFixed(3)}s`);
            }

            if (onMetadata) onMetadata({ requestedStartTime: requestedStart, actualAudioStartTime: actualStart });

            console.log(`[FETCH READER CREATED] session=${session.id}`);
            const reader = response.body.getReader();
            let chunkCount = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (this.activeSession !== session) {
                    console.log(`[FETCH CLOSED] session=${session.id} reason=session_mismatch`);
                    reader.releaseLock();
                    break;
                }
                if (done) {
                    console.log(`[FETCH CLOSED] session=${session.id} reason=eof`);
                    this._push(null, session);
                    break;
                }
                if (chunkCount === 0) {
                    console.log(`[FETCH FIRST CHUNK] session=${session.id} size=${value.byteLength}`);
                }
                chunkCount++;
                this._push(value, session);
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                console.log(`[FETCH ABORT] session=${session.id}`);
            } else {
                console.error(`[FETCH ERROR] session=${session.id}`, err);
            }
        }
    }

    _push(data, session) {
        if (this.activeSession !== session) {
            console.warn(`[MSE-AUDIT] [ZOMBIE PUSH] Session ${session.id} (Active is ${this.activeSession?.id}) | Size=${data ? data.byteLength : 'EOF'}`);
            return;
        }
        if (data) {
            this.queue.push(data);
        } else {
            this.eosPending = true;
        }
        this._processQueue("push", session);
    }

    _onUpdateEnd() {
        const session = this.activeSession;
        if (!session) return;
        this.isAppending = false;
        this.isRemoving = false;
        this._lastUpdateEndTime = Date.now();

        // Gap Jump Logic
        const b = this.audio.buffered;
        if (b.length > 0) {
            const firstStart = b.start(0);
            if (this.audio.currentTime < firstStart - 0.1) {
                console.warn(`[MSE-AUDIT] [GAP DETECTED] Session=${session.id} | Pos=${this.audio.currentTime.toFixed(3)} | BufferedStart=${firstStart.toFixed(3)} | Action=Waiting for SyncController`);
            }
            this._evict(session);
        }
        this._processQueue("updateend", session);
    }

    _processQueue(caller, session) {
        if (this.activeSession !== session) {
            console.warn(`[MSE-AUDIT] [ZOMBIE SCHEDULER] Session ${session.id} (Active is ${this.activeSession?.id}) called from ${caller}`);
            return;
        }

        const v = this.audio;
        const b = v.buffered;
        const ct = v.currentTime;

        // --- LEVEL-16 FORENSIC GAP AUDIT ---
        let currentRangeIndex = -1;
        for (let i = 0; i < b.length; i++) {
            if (ct >= b.start(i) - 0.1 && ct <= b.end(i) + 0.1) {
                currentRangeIndex = i;
                break;
            }
        }

        const methodA = b.length > 0 ? (b.end(b.length - 1) - ct) : 0;
        const methodB = currentRangeIndex !== -1 ? (b.end(currentRangeIndex) - ct) : 0;

        const decisionLog = (decision) => {
            this._lastDecision = decision;
            this._lastCaller = caller;

            // Log for Level-16 Audit
            let rangeString = "";
            for (let i = 0; i < b.length; i++) {
                rangeString += `R${i}:[${b.start(i).toFixed(3)}-${b.end(i).toFixed(3)}] `;
            }

            const stateInfo = currentRangeIndex === -1 ? "!!! CURRENT TIME IS IN A GAP !!!" : `In Range ${currentRangeIndex}`;

            console.log(`[SCHEDULER] Session=${session.id} | Caller=${caller} | Decision=${decision}`);
            console.log(`  - CT=${ct.toFixed(3)} | ${stateInfo}`);
            console.log(`  - Ranges(${b.length}): ${rangeString}`);
            console.log(`  - Method A (End-CT): ${methodA.toFixed(3)}s`);
            console.log(`  - Method B (Contig): ${methodB.toFixed(3)}s`);
            console.log(`  - Queue=${this.queue.length} | MS=${this.mediaSource?.readyState} | Ready=${v.readyState}`);
        };

        const forward = methodA; // Preserve current calculation for audit consistency

        // 1. Check Busy State
        if (this.isAppending || this.isRemoving || !this.sourceBuffer || this.sourceBuffer.updating) {
            return; // Silent busy
        }

        // 2. Back-Pressure Logic
        if (forward >= this.FORWARD_BUFFER_SECONDS) {
            decisionLog("PAUSE_HIGH_WATERMARK");
            return;
        }

        // 3. Check for Starvation
        if (this.queue.length === 0) {
            if (this.eosPending && this.mediaSource?.readyState === 'open') {
                decisionLog("EOS_CALL");
                this.mediaSource.endOfStream();
            }
            return;
        }

        // 4. Append Action
        const chunk = this.queue.shift();

        if (this.sourceBuffer) {
            const b = v.buffered;
            const bStart = b.length > 0 ? b.start(0).toFixed(3) : "none";
            const bEnd = b.length > 0 ? b.end(0).toFixed(3) : "none";

            console.log(`[APPEND AUDIO] PTS=UNKNOWN | tfdt=UNKNOWN | offset=${this.sourceBuffer.timestampOffset.toFixed(3)} | expected_playback=${(this.sourceBuffer.timestampOffset + 0).toFixed(3)} | A.pos=${v.currentTime.toFixed(3)} | perf=${performance.now().toFixed(2)}`);

            console.log(`\n--------------------------------------------------`);
            console.log(`Incoming Audio Fragment (Session=${session.id})`);
            console.log(`  - tfdt: UNKNOWN (Binary)`);
            console.log(`  - timestampOffset: ${this.sourceBuffer.timestampOffset.toFixed(3)}`);
            console.log(`  - audio.currentTime: ${v.currentTime.toFixed(3)}`);
            console.log(`  - video.currentTime: ${window.audioSync?.video?.currentTime.toFixed(3)}`);
            console.log(`  - buffered: [${bStart} - ${bEnd}]`);
            console.log(`  - perf: ${performance.now().toFixed(2)}`);
            console.log(`--------------------------------------------------\n`);
        }

        decisionLog("APPEND");
        this.isAppending = true;

        try {
            this._lastAppendTime = Date.now();
            console.log(`[MSE-APPEND] Element=AUDIO | Session=${session.id} | Size=${chunk.byteLength} | type=${this.queue.length === 0 && this.eosPending ? 'media' : 'media/init'}`);
            this.sourceBuffer.appendBuffer(chunk);
        } catch (err) {
            this.isAppending = false;
            if (err.name === 'QuotaExceededError') {
                this.queue.unshift(chunk);
                this._evict(session, true);
                console.warn(`[MSE-QUOTA] QuotaExceeded at CT=${v.currentTime.toFixed(3)}`);
            } else {
                console.error(`[MSE-APPEND-ERROR] Session=${session.id}:`, err);
                this.stop();
            }
        }
    }

    _evict(session, force = false) {
        if (!this.sourceBuffer || this.sourceBuffer.updating || this.isRemoving) return;
        const b = this.audio.buffered;
        if (b.length > 0) {
            const evictEnd = this.audio.currentTime - this.BACK_BUFFER_SECONDS;
            if (force || b.start(0) < evictEnd - 5) {
                this.isRemoving = true;
                try { this.sourceBuffer.remove(0, evictEnd); } catch (e) { this.isRemoving = false; }
            }
        }
    }

    _getForwardBuffer() {
        if (!this.sourceBuffer) return 0;
        const b = this.sourceBuffer.buffered;
        if (b.length === 0) return 0;
        return b.end(b.length - 1) - this.audio.currentTime;
    }

    _takeStallSnapshot(reason) {
        this._stallSnapshotTaken = true;
        const b = this.audio.buffered;
        const snapshot = {
            STALL_REASON: reason,
            Element: { time: this.audio.currentTime, ready: this.audio.readyState, paused: this.audio.paused },
            MSE: { msState: this.mediaSource.readyState, sbUpdating: this.sourceBuffer?.updating, isAppending: this.isAppending },
            Pipeline: {
                queue: this.queue.length,
                forward: this._getForwardBuffer().toFixed(3),
                lastCaller: this._lastCaller,
                lastDecision: this._lastDecision,
                timeSinceLastAppend: (Date.now() - this._lastAppendTime),
                timeSinceLastUpdate: (Date.now() - this._lastUpdateEndTime)
            }
        };
        console.error("!!! LEVEL-14 STALL SNAPSHOT !!!", snapshot);
    }

    _getBufferedString() {
        if (!this.sourceBuffer) return "none";
        const b = this.sourceBuffer.buffered;
        let s = "";
        for (let i = 0; i < b.length; i++) s += `[${b.start(i).toFixed(3)} - ${b.end(i).toFixed(3)}] `;
        return s || "empty";
    }
}

window.MSEAudioController = MSEAudioController;
