/**
 * PlaybackSession - Encapsulates all state and cleanup for a single track load attempt.
 */
class PlaybackSession {
    constructor(id, trackNumber, requestedStartTimeMs) {
        this.id = id;
        this.trackNumber = trackNumber;
        this.requestedStartTime = requestedStartTimeMs / 1000;
        this.actualAudioStartTime = 0;
        this.state = 'INITIALIZING';
        this.isActive = true;

        this.metrics = {
            alignmentJumps: 0,
            recoveryJumps: 0,
            velocitySteering: 0,
            perfectResets: 0,
            postEndedViolations: 0
        };

        this.abortController = new AbortController();
        this.timeouts = [];
        this.listeners = [];
    }

    addTimeout(fn, ms) {
        const handle = setTimeout(() => {
            if (this.isActive) fn();
        }, ms);
        this.timeouts.push(handle);
        return handle;
    }

    addListener(target, event, fn) {
        const wrapped = (...args) => {
            if (this.isActive) fn(...args);
        };
        target.addEventListener(event, wrapped);
        this.listeners.push({ target, event, fn: wrapped });
    }

    cancel() {
        if (!this.isActive) return;
        this.logSummary("CANCELLED");
        this.isActive = false;
        this.abortController.abort();
        this.timeouts.forEach(clearTimeout);
        this.listeners.forEach(l => l.target.removeEventListener(l.event, l.fn));
        this.timeouts = [];
        this.listeners = [];
        console.log(`[SESSION] Session ${this.id} (Track ${this.trackNumber}) invalidated.`);
    }

    logSummary(reason) {
        console.log(`
==================================================
[SESSION-SUMMARY] S${this.id} | Reason: ${reason}
--------------------------------------------------
- Initial Alignment: ${this.metrics.alignmentJumps}
- Recovery Jumps:    ${this.metrics.recoveryJumps}
- Velocity Steering: ${this.metrics.velocitySteering} (Tier 2)
- Perfect Resets:    ${this.metrics.perfectResets} (Tier 1)
- Post-EOS Writes:   ${this.metrics.postEndedViolations}
==================================================
        `);
    }
}

/**
 * AudioSyncController
 * Synchronizes a slave HTMLAudioElement to a master HTMLVideoElement using a Timeline-Origin model.
 */
class AudioSyncController {
    constructor() {
        this.video = null;
        this.audio = null;
        this.fileId = null;
        this.isActive = false;

        this.driftTimer = null;
        this.mse = null;
        this.sessionCounter = 0;
        this.activeSession = null;
        this._lastSnapTime = 0; // Throttle for logs

        this._boundVideoEvent = this._onVideoEvent.bind(this);
    }

    attach(video, audio, fileId) {
        this.video = video;
        this.audio = audio;
        this.fileId = fileId;
        this.isActive = true;

        // PHASE 1: Mute Original Video Audio
        this.video.muted = true;
        console.log(`[MSE] Video audio muted. ActiveSession=${this.activeSession ? this.activeSession.id : 'NONE'}`);

        const events = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'play', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting', 'playing', 'ended', 'error', 'timeupdate'];
        events.forEach(ev => this.video.addEventListener(ev, (e) => {
            if (!this.isActive) return;
            const b = this.video.buffered;
            let ranges = "";
            for(let i=0; i<b.length; i++) ranges += `[${b.start(i).toFixed(3)}-${b.end(i).toFixed(3)}] `;
            console.log(`[MEDIA-EVENT] Element=VIDEO | Event=${ev} | V.pos=${this.video.currentTime.toFixed(3)} | A.pos=${this.audio.currentTime.toFixed(3)} | ready=${this.video.readyState} | network=${this.video.networkState} | buf=${ranges || 'empty'} | perf=${performance.now().toFixed(2)}`);
            this._boundVideoEvent(e);
        }));

        // --- LEVEL-8 MEDIA PRESENTATION AUDIT ---
        this._setupPresentationAudit();

        // --- 100ms HIGH-FREQUENCY FORENSIC LOGGER ---
        this._forensicInterval = setInterval(() => {
            if (!this.isActive || !this.video || !this.audio) return;
            const v = this.video;
            const a = this.audio;
            const b = a.buffered;
            const bStart = b.length > 0 ? b.start(0).toFixed(3) : "none";
            const bEnd = b.length > 0 ? b.end(0).toFixed(3) : "none";

            let videoFrameTime = "N/A";
            // Check for recent video frame callback data
            if (this._lastVideoFrameMetadata) {
                videoFrameTime = this._lastVideoFrameMetadata.mediaTime.toFixed(3);
            }

            console.log(`[FORENSIC-100MS] perf=${performance.now().toFixed(0)} | V.pos=${v.currentTime.toFixed(3)} | V.frame=${videoFrameTime} | A.pos=${a.currentTime.toFixed(3)} | A.buf=[${bStart}-${bEnd}]`);
        }, 100);

        this._startDriftMonitor();
        console.log(`[SYNC-AUDIT] Controller attached | VideoMuted=${this.video.muted} | VideoVolume=${this.video.volume.toFixed(2)}`);
    }

    _setupPresentationAudit() {
        if (!this.video || !this.audio) return;

        this._presentationData = {
            videoRequestedPlay: 0,
            videoPlayingEvent: 0,
            videoFirstFrameTime: 0,
            audioRequestedPlay: 0,
            audioPlayingEvent: 0,
            audioFirstAdvanceTime: 0,
            startTime: performance.now(),
            auditInterval: null
        };

        const v = this.video;
        const a = this.audio;

        // Video Instrument
        const vLog = (ev) => {
            const now = performance.now() - this._presentationData.startTime;
            console.log(`[VIDEO-AUDIT] ${ev} at ${now.toFixed(2)}ms`);
            if (ev === 'play()') this._presentationData.videoRequestedPlay = now;
            if (ev === 'playing') this._presentationData.videoPlayingEvent = now;
        };

        const originalVPlay = v.play.bind(v);
        v.play = (...args) => {
            vLog('play()');
            return originalVPlay(...args);
        };

        v.addEventListener('playing', () => vLog('playing'));

        if ('requestVideoFrameCallback' in v) {
            const onFrame = (now, metadata) => {
                this._lastVideoFrameMetadata = metadata;
                if (this._presentationData.videoFirstFrameTime === 0) {
                    const elapsed = performance.now() - this._presentationData.startTime;
                    this._presentationData.videoFirstFrameTime = elapsed;
                    console.log(`[VIDEO-FIRST-FRAME] Presented at ${elapsed.toFixed(2)}ms | MediaTime=${metadata.mediaTime.toFixed(3)} | ExpectedDisplayTime=${metadata.expectedDisplayTime.toFixed(3)} | PresentedFrames=${metadata.presentedFrames}`);
                    this._checkStartupDelta();
                }
                if (this.isActive) v.requestVideoFrameCallback(onFrame);
            };
            v.requestVideoFrameCallback(onFrame);
        }

        // Audio Instrument
        const aLog = (ev) => {
            const now = performance.now() - this._presentationData.startTime;
            console.log(`[AUDIO-AUDIT] ${ev} at ${now.toFixed(2)}ms`);
            if (ev === 'play()') this._presentationData.audioRequestedPlay = now;
            if (ev === 'playing') this._presentationData.audioPlayingEvent = now;
        };

        const originalAPlay = a.play.bind(a);
        a.play = (...args) => {
            aLog('play()');
            return originalAPlay(...args);
        };

        a.addEventListener('playing', () => aLog('playing'));

        // Snapshot Interval
        this._presentationData.auditInterval = setInterval(() => {
            if (!this.isActive) return;
            const elapsed = performance.now() - this._presentationData.startTime;
            if (elapsed > 3000) { // Limit to 3s per request
                return;
            }

            // Throttle snapshot to ~1Hz (every 1000ms)
            const snapSlot = Math.floor(elapsed / 1000);
            if (this._presentationData.lastSnapSlot !== snapSlot) {
                console.log(`[CLOCK-SNAP] ${elapsed.toFixed(0)}ms | V.pos=${v.currentTime.toFixed(3)} V.ready=${v.readyState} | A.pos=${a.currentTime.toFixed(3)} A.ready=${a.readyState} | Rate=${a.playbackRate.toFixed(3)} | State=${this.activeSession?.state}`);
                this._presentationData.lastSnapSlot = snapSlot;
            }

            if (this._presentationData.audioFirstAdvanceTime === 0 && a.currentTime > (this.activeSession?.actualAudioStartTime || 0)) {
                this._presentationData.audioFirstAdvanceTime = elapsed;
                console.log(`[AUDIO-FIRST-SAMPLE] Audible advancement at ${elapsed.toFixed(2)}ms | CurrentTime=${a.currentTime.toFixed(3)}`);
                this._checkStartupDelta();
            }
        }, 50);
    }

    _checkStartupDelta() {
        const d = this._presentationData;
        if (d.videoFirstFrameTime > 0 && d.audioFirstAdvanceTime > 0) {
            const lead = d.audioFirstAdvanceTime - d.videoFirstFrameTime;
            console.log(`\n==================================================`);
            console.log(`[STARTUP-DELTA] AudioLead = ${lead.toFixed(2)}ms`);
            console.log(`(Positive means Video started first, Negative means Audio started first)`);
            console.log(`==================================================\n`);
        }
    }


    detach() {
        if (!this.isActive) return;
        if (this._forensicInterval) clearInterval(this._forensicInterval);
        const events = ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting', 'playing', 'ended', 'error'];
        events.forEach(ev => this.video.removeEventListener(ev, this._boundVideoEvent));

        if (this._presentationData && this._presentationData.auditInterval) {
            clearInterval(this._presentationData.auditInterval);
        }

        this._stopDriftMonitor();
        if (this.activeSession) {
            this.activeSession.cancel();
            this.activeSession = null;
        }
        if (this.mse) {
            this.mse.stop();
            this.mse = null;
        }

        this.isActive = false;
        console.log("[SYNC] Controller detached");
    }

    _transition(session, newState, reason) {
        if (this.activeSession !== session) return;
        const oldState = session.state;
        if (oldState === newState) return;

        session.state = newState;
        console.log(`[SYNC-FSM] S${session.id} | ${oldState} -> ${newState} | Reason: ${reason}`);

        // Handle Stabilizing Grace Period
        if (newState === 'STABILIZING') {
            session.addTimeout(() => {
                if (this.activeSession === session && session.state === 'STABILIZING') {
                    console.log(`[SYNC-WAIT] S${session.id} | Resuming drift monitor | Rate=${this.audio.playbackRate.toFixed(3)}`);
                    this._transition(session, 'MONITORING', 'Stabilization period complete');
                }
            }, 1000);
        }
    }

    async loadTrack(trackNumber, startTimeMs = 0) {
        console.log(`[LOADTRACK ENTER] track=${trackNumber} time=${startTimeMs}ms`);
        if (!this.isActive) {
            console.log(`[LOADTRACK EXIT] reason=not_active`);
            return;
        }

        // 1. Create and Activate New Session
        if (this.activeSession) {
            console.log(`[LOADTRACK SESSION] cancelling previous session=${this.activeSession.id}`);
            this.activeSession.cancel();
        }
        const session = new PlaybackSession(++this.sessionCounter, trackNumber, startTimeMs);
        this.activeSession = session;
        console.log(`[LOADTRACK SESSION] new session=${session.id} controller_aborted=${session.abortController.signal.aborted}`);

        // 2. Prepare Environment
        this.audio.pause();
        const mode = window.AUDIO_OUTPUT_MODE || 'adts';
        const url = `http://127.0.0.1:3301/stream/${this.fileId}/audio/${trackNumber}?start=${startTimeMs / 1000}&mode=${mode}`;
        console.log(`[LOADTRACK URL] url=${url}`);

        try {
            if (mode === 'fmp4' && window.MSEAudioController) {
                if (!this.mse) this.mse = new MSEAudioController(this.audio);

                console.log(`[FETCH ENTER] session=${session.id} mode=fmp4`);
                await this.mse.load(url, session, (meta) => {
                    if (this.activeSession !== session) return;
                    session.requestedStartTime = meta.requestedStartTime;
                    session.actualAudioStartTime = meta.actualAudioStartTime;
                    console.log(`[SYNC-METADATA] S${session.id} | Requested=${session.requestedStartTime}s, Actual=${session.actualAudioStartTime}s`);
                    this._transition(session, 'BUFFERING', 'Timeline origin received');
                });
            } else {
                if (this.activeSession !== session) return;
                session.actualAudioStartTime = startTimeMs / 1000;
                console.log(`[FETCH ENTER] session=${session.id} mode=legacy`);
                this.audio.src = url;
                this.audio.load();
                this._transition(session, 'BUFFERING', 'Legacy source assigned');
            }

            // 3. Wait for baseline (canplay or first data arrival)
            await new Promise((resolve, reject) => {
                const checkReady = () => {
                    if (this.audio.buffered.length > 0) {
                        console.log(`[SYNC-READY] S${session.id} | Data arrival detected. Resolving baseline.`);
                        cleanup();
                        resolve();
                    }
                };

                const cleanup = () => {
                    this.audio.removeEventListener('canplay', onCanPlay);
                    this.audio.removeEventListener('progress', checkReady);
                    this.audio.removeEventListener('timeupdate', checkReady);
                };

                const onCanPlay = () => {
                    cleanup();
                    resolve();
                };

                this.audio.addEventListener('canplay', onCanPlay);
                this.audio.addEventListener('progress', checkReady);
                this.audio.addEventListener('timeupdate', checkReady);

                session.addListener(this.audio, 'error', () => {
                    cleanup();
                    reject(new Error("Audio load failed"));
                });

                session.addTimeout(() => {
                    if (this.audio.buffered.length > 0) {
                        cleanup();
                        resolve();
                    } else {
                        cleanup();
                        reject(new Error("Audio load timeout"));
                    }
                }, 5000); // Reduced to 5s for faster error recovery

                if (!session.isActive) {
                    cleanup();
                    reject(new Error("Session invalidated"));
                }
            });

            // 4. Baseline Lock
            if (this.activeSession !== session) return;
            this._transition(session, 'BASELINE_LOCKED', 'Establishing baseline');

            // --- UNIFIED TIMELINE ALIGNMENT ---
            if (this.video.ended) return;

            const oldAudioTime = this.audio.currentTime;
            let targetTime = this.video.currentTime;

            console.log(`[CURRENTTIME WRITE] Element=AUDIO | old=${oldAudioTime.toFixed(3)} | new=${targetTime.toFixed(3)} | reason=Baseline Lock | perf=${performance.now().toFixed(2)} | stack=${new Error().stack.split('\n')[2]}`);

            this.audio.currentTime = targetTime;
            this.audio.playbackRate = this.video.playbackRate;
            session.metrics.alignmentJumps++;

            if (!this.video.paused) {
                // CRITICAL: Do NOT await play() here.
                // If audio is in a silent gap (unbuffered), play() will hang the state machine.
                this.audio.play().catch(() => {});
            }

            this._transition(session, 'STABILIZING', 'Waiting for hardware clocks to settle');

        } catch (err) {
            if (this.activeSession !== session) return;
            console.error(`[SYNC-ERROR] S${session.id} | Track load failed:`, err.message);
            this._transition(session, 'RECOVERY', 'Initialization failed');
            if (this.isActive) {
                this.loadTrack(trackNumber, this.video.currentTime * 1000);
            }
        }
    }

    _onVideoEvent(e) {
        if (!this.isActive || !this.activeSession) return;
        const session = this.activeSession;

        switch (e.type) {
            case 'play':
                if (['STABILIZING', 'MONITORING'].includes(session.state)) this.audio.play().catch(() => {});
                break;
            case 'pause':
            case 'waiting':
                this.audio.pause();
                if (e.type === 'waiting' && ['MONITORING', 'STABILIZING'].includes(session.state)) {
                    console.log(`[SYNC-WAIT] S${session.id} | Waiting event fired | State=${session.state} | Counter=${session.violationCounter} | Rate=${this.audio.playbackRate.toFixed(3)}`);
                    this._transition(session, 'STABILIZING', 'Waiting for buffer');
                }
                break;
            case 'ended':
                this.audio.pause();
                session.logSummary("VIDEO_ENDED");
                break;
            case 'seeking':
                this.audio.pause();
                break;
            case 'seeked':
                this.loadTrack(session.trackNumber, this.video.currentTime * 1000);
                break;
            case 'ratechange':
                if (!this.video.ended) this.audio.playbackRate = this.video.playbackRate;
                break;
            case 'playing':
                if (['STABILIZING', 'MONITORING'].includes(session.state)) this.audio.play().catch(() => {});
                break;
        }
    }

    _startDriftMonitor() {
        this.driftTimer = setInterval(() => {
            if (!this.isActive || !this.activeSession) return;
            const session = this.activeSession;

            if (session.state !== 'MONITORING') return;
            if (this.video.paused || this.video.seeking || this.video.ended) return;

            // --- UNIFIED TIMELINE DRIFT ---
            // Both elements are now in the 0-based relative timeline.
            const drift = Math.abs(this.video.currentTime - this.audio.currentTime);
            const direction = this.video.currentTime > this.audio.currentTime ? 1 : -1; // 1: audio slow, -1: audio fast

            // --- STALL RECOVERY (Gap Jump Replacement) ---
            // If audio is stalled and we are significantly behind the video,
            // we check if the video has reached a buffered region.
            if (this.audio.readyState < 3 && drift > 0.5) {
                const b = this.audio.buffered;
                if (b.length > 0) {
                    const firstStart = b.start(0);
                    // If video is approaching or past the first audio data,
                    // jump audio to the data start to kickstart the engine.
                    if (this.video.currentTime >= firstStart - 0.1) {
                        // Align with video if video is within or ahead of the first buffered range
                    const jumpTarget = Math.max(firstStart, Math.min(this.video.currentTime, b.end(0) - 0.1));
                    console.log(`[SYNC-RECOVERY] Gap jump via SyncController | A.pos=${this.audio.currentTime.toFixed(3)} -> ${jumpTarget.toFixed(3)} | V.pos=${this.video.currentTime.toFixed(3)}`);
                    this.audio.currentTime = jumpTarget;
                    return;
                    }
                }
            }

            // If audio is still stalled and not yet at data, just wait.
            if (this.audio.readyState < 3) return;

            // --- REFINED TREND LOGIC ---
            // We use a 10ms hysteresis to distinguish genuine divergence from measurement jitter.
            let trend = 'STABLE';
            if (drift > session.lastDrift + 0.010) trend = 'WORSENING';
            else if (drift < session.lastDrift - 0.010) trend = 'IMPROVING';

            // Diagnostic output (every interval)
            console.log(`[SYNC-AUDIT] S${session.id} | V.pos=${this.video.currentTime.toFixed(3)} | A.pos=${this.audio.currentTime.toFixed(3)} | Drift=${(drift*1000).toFixed(0)}ms | Rate=${this.audio.playbackRate.toFixed(3)} | Counter=${session.violationCounter}/3 | Trend=${trend}`);

            // --- THREE-TIER adaptive POLICY ---

            if (drift < 0.040) {
                // Tier 1: Perfect Zone
                session.violationCounter = 0;
                if (this.audio.playbackRate !== 1.0) {
                    if (this.video.ended) session.metrics.postEndedViolations++;
                    console.log(`[SYNC-RATE] S${session.id} | Drift=${(drift * 1000).toFixed(0)}ms | ${this.audio.playbackRate.toFixed(3)} -> 1.000 | Reason: Perfect Zone`);
                    this.audio.playbackRate = 1.0;
                    session.metrics.perfectResets++;
                }
            } else if (drift < 0.350) {
                // Tier 2: Micro-Correction (Velocity Steering)
                session.violationCounter = 0;
                const adjustment = Math.min(0.05, (drift / 5.0)); // Proportional but capped at 5%
                const targetRate = 1.0 + (adjustment * direction);

                if (Math.abs(this.audio.playbackRate - targetRate) > 0.001) {
                    if (this.video.ended) session.metrics.postEndedViolations++;
                    console.log(`[SYNC-RATE] S${session.id} | Drift=${(drift * 1000).toFixed(0)}ms | ${this.audio.playbackRate.toFixed(3)} -> ${targetRate.toFixed(3)} | Reason: Tier 2 Correction`);
                    this.audio.playbackRate = targetRate;
                    session.metrics.velocitySteering++;
                }
            } else {
                // Tier 3: Macro Violation (Potential recovery)
                // Only increment if not improving.
                if (trend !== 'IMPROVING' || drift > 0.800) {
                    session.violationCounter++;
                } else {
                    // If drift is improving, don't restart yet, even if over threshold.
                    // This allows Tier 2 (Rate correction) to do its job.
                    session.violationCounter = Math.max(0, session.violationCounter - 1);
                }

                if (session.violationCounter >= 3 && (trend === 'WORSENING' || drift > 0.650)) {
                    if (this.video.ended) session.metrics.postEndedViolations++;
                    console.log(`[CURRENTTIME WRITE] Element=AUDIO | old=${this.audio.currentTime.toFixed(3)} | new=${this.video.currentTime.toFixed(3)} | reason=Recovery (Macro Drift) | perf=${performance.now().toFixed(2)} | stack=${new Error().stack.split('\n')[2]}`);
                    console.error(`[SYNC-RECOVERY] S${session.id} | PERSISTENCE FAILURE! Drift=${(drift * 1000).toFixed(0)}ms | Trend=${trend}. Triggering Recovery.`);
                    session.metrics.recoveryJumps++;
                    this._transition(session, 'RECOVERY', 'Persistent worsening macro drift');
                    this.loadTrack(session.trackNumber, this.video.currentTime * 1000);
                }
            }

            session.lastDrift = drift;
        }, 1000);
    }

    _stopDriftMonitor() {
        if (this.driftTimer) clearInterval(this.driftTimer);
        this.driftTimer = null;
    }

    destroy() {
        this.detach();
        this.video = null;
        this.audio = null;
    }
}

window.AudioSyncController = AudioSyncController;
