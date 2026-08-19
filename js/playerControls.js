/**
 * Pill Control Bar — connects the glassmorhism UI to the HTMLVideoElement.
 * Requires Font Awesome 6 to be loaded in index.html.
 */

(function() {
  let video = null;
  let progressInterval = null;
  let popoverOpen = false;

  function init() {
    video = document.getElementById('main-player');
    if (!video) return;

    video.removeAttribute('controls'); // Kill native UI
    bindPlay();
    bindVolume();
    bindProgress();
    bindTimeDisplay();
    bindPopover();
    bindFullscreen();
    bindBack();
    bindKeyboardShortcuts();
  }

  // ---- BACK / CLOSE --------------------------------------------------
  function bindBack() {
    const btn = document.getElementById('pillBack');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof closePlayer === 'function') closePlayer();
    });
  }

  // ---- FULLSCREEN ----------------------------------------------------
  function bindFullscreen() {
    const btn = document.getElementById('pillFullscreen');
    const wrapper = document.getElementById('videoWrapper');
    if (!btn || !wrapper) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!document.fullscreenElement) {
            wrapper.requestFullscreen().catch(err => console.warn(`Fullscreen error: ${err.message}`));
        } else {
            document.exitFullscreen();
        }
    });

    document.addEventListener('fullscreenchange', () => {
        const icon = btn.querySelector('i');
        if (document.fullscreenElement) {
            icon.classList.replace('fa-expand', 'fa-compress');
        } else {
            icon.classList.replace('fa-compress', 'fa-expand');
        }
    });
  }

  // ---- PLAY / PAUSE --------------------------------------------------
  function bindPlay() {
    const btn = document.getElementById('pillPlay');
    if (!btn) return;

    function updateIcon() {
      const icon = btn.querySelector('i');
      if (!icon) return;
      if (video.paused) {
        icon.classList.remove('fa-pause');
        icon.classList.add('fa-play');
      } else {
        icon.classList.remove('fa-play');
        icon.classList.add('fa-pause');
      }
    }

    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (video.paused) video.play();
      else video.pause();
    });

    video.addEventListener('play', updateIcon);
    video.addEventListener('pause', updateIcon);
    video.addEventListener('ended', updateIcon);
    updateIcon();
  }

  // ---- VOLUME ---------------------------------------------------------
  function bindVolume() {
    const btn = document.getElementById('pillVolume');
    if (!btn) return;

    function updateIcon() {
      const icon = btn.querySelector('i');
      if (!icon) return;
      icon.classList.remove('fa-volume-up', 'fa-volume-down', 'fa-volume-mute');
      if (video.muted || video.volume === 0) icon.classList.add('fa-volume-mute');
      else if (video.volume < 0.5) icon.classList.add('fa-volume-down');
      else icon.classList.add('fa-volume-up');
    }

    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (video.muted) {
        video.muted = false;
      } else if (video.volume === 0) {
        video.volume = 0.8;
        video.muted = false;
      } else if (video.volume < 0.25) {
        video.muted = true;
      } else if (video.volume < 0.75) {
        video.volume = 0;
      } else {
        video.volume = 0.25;
      }
      updateIcon();
    });

    video.addEventListener('volumechange', updateIcon);
    updateIcon();
  }

  // ---- PROGRESS BAR & SEEK -------------------------------------------
  function bindProgress() {
    const playedFill = document.getElementById('playedFill');
    const progressThumb = document.getElementById('progressThumb');
    const seekOverlay = document.getElementById('seekOverlay');
    const trackWrapper = document.getElementById('trackWrapper');

    function setProgress(percent) {
      const clamped = Math.round(Math.min(100, Math.max(0, percent)));
      if (playedFill) playedFill.style.width = clamped + '%';
      if (progressThumb) progressThumb.style.left = clamped + '%';
    }

    // Continuous UI update during playback
    progressInterval = setInterval(() => {
      if (video.duration && !video.seeking && !video.paused) {
        const pct = (video.currentTime / video.duration) * 100;
        setProgress(pct);
      }
    }, 200);

    function performSeek(pct) {
        const targetTime = (pct / 100) * video.duration;

        // ALWAYS update video.currentTime to move the playhead.
        // This triggers the 'seeking' event which our player.js handles.
        video.currentTime = targetTime;

        setProgress(pct);
    }

    if (seekOverlay) {
      seekOverlay.addEventListener('click', function(e) {
        e.stopPropagation();
        const rect = trackWrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pct = (x / rect.width) * 100;
        performSeek(pct);
      });
    }

    // Dragging the thumb
    if (progressThumb) {
      let dragging = false;
      progressThumb.addEventListener('mousedown', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        if (video.paused === false) video.dataset.wasPlaying = "true";
        video.pause();
      });

      document.addEventListener('mousemove', function(e) {
        if (!dragging) return;
        const rect = trackWrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pct = Math.min(100, Math.max(0, (x / rect.width) * 100));

        // Update UI only during drag for smoothness
        setProgress(pct);

        // Optional: Update time display while dragging
        const currentEl = document.getElementById('currentTimeDisplay');
        if (currentEl && video.duration) {
            currentEl.textContent = fmt((pct / 100) * video.duration);
        }
      });

      document.addEventListener('mouseup', function(e) {
        if (!dragging) return;
        dragging = false;

        const rect = trackWrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pct = Math.min(100, Math.max(0, (x / rect.width) * 100));

        performSeek(pct);

        if (video.dataset.wasPlaying === "true") {
            video.play();
            delete video.dataset.wasPlaying;
        }
      });
    }
  }

  // ---- TIME DISPLAY ---------------------------------------------------
  function bindTimeDisplay() {
    const currentEl = document.getElementById('currentTimeDisplay');
    const durationEl = document.getElementById('durationDisplay');

    function fmt(secs) {
      if (isNaN(secs) || secs < 0) return '0:00';
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60);
      return m + ':' + String(s).padStart(2, '0');
    }

    video.addEventListener('loadedmetadata', function() {
      if (durationEl) durationEl.textContent = fmt(video.duration);
    });

    video.addEventListener('timeupdate', function() {
      if (currentEl) currentEl.textContent = fmt(video.currentTime);
      if (durationEl && video.duration) durationEl.textContent = fmt(video.duration);
    });
  }

  // ---- GLASS POPOVER --------------------------------------------------
  function bindPopover() {
    const gearBtn = document.getElementById('gearBtn');
    const popover = document.getElementById('settingsPopover');
    if (!gearBtn || !popover) return;

    function togglePopover(e) {
      e.stopPropagation();
      popoverOpen = !popoverOpen;
      if (popoverOpen) {
        popover.classList.add('active');
        resetPanels();
      } else {
        popover.classList.remove('active');
      }
    }

    function resetPanels() {
      const panels = popover.querySelectorAll('.popover-panel');
      panels.forEach(p => p.classList.remove('active'));
      const mainPanel = document.getElementById('mainPanel');
      if (mainPanel) mainPanel.classList.add('active');
    }

    gearBtn.addEventListener('click', togglePopover);

    // Close on outside click
    document.addEventListener('click', function(e) {
      if (popoverOpen) {
        const isInside = popover.contains(e.target) || gearBtn.contains(e.target);
        if (!isInside) {
          popover.classList.remove('active');
          popoverOpen = false;
          resetPanels();
        }
      }
    });

    // Close on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && popoverOpen) {
        popover.classList.remove('active');
        popoverOpen = false;
        resetPanels();
      }
    });

    // Panel navigation (Audio / Subtitle)
    popover.querySelectorAll('.menu-item').forEach(item => {
      item.addEventListener('click', function(e) {
        e.stopPropagation();
        const panelId = this.getAttribute('data-panel');
        const targetPanel = document.getElementById(panelId);
        if (targetPanel) {
          popover.querySelectorAll('.popover-panel').forEach(p => p.classList.remove('active'));
          targetPanel.classList.add('active');
        }
      });
    });

    // Back button navigation
    popover.querySelectorAll('.back-btn').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const panelId = this.getAttribute('data-panel');
        const targetPanel = document.getElementById(panelId);
        if (targetPanel) {
          popover.querySelectorAll('.popover-panel').forEach(p => p.classList.remove('active'));
          targetPanel.classList.add('active');
        }
      });
    });

    // Prevent popover clicks from propagating
    popover.addEventListener('click', function(e) {
      e.stopPropagation();
    });
  }

  // ---- KEYBOARD SHORTCUTS --------------------------------------------
  function bindKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space' && video) {
        e.preventDefault();
        video.paused ? video.play() : video.pause();
      }
    });
  }

  // ---- EXPOSED FUNCTIONS (called by player.js after manifest loads) ---
  window.updateAudioPopoverItems = function(tracks) {
    const container = document.getElementById('popover-audio-list');
    if (!container) return;

    container.innerHTML = '';
    tracks.forEach(function(track) {
      const opt = document.createElement('div');
      opt.className = 'popover-option';
      opt.innerHTML = `<i class="fas fa-language"></i> <span>${track._label}</span>`;
      opt.addEventListener('click', function() {
        // Switch audio track via MP4MSEPlayer
        if (window.mp4Player && window.mp4Player.bufferController) {
            // TODO: Implement audio track switching for unified player
            console.log('[AUDIO SWITCH] Not yet implemented for unified player');
        } else if (typeof setAudioTrack === 'function') {
            setAudioTrack(track._index, track.trackNumber);
        }
      });
      container.appendChild(opt);
    });
  };

  window.apiUpdateSubtitlePopoverItems = function(tracks) {
    const container = document.getElementById('popover-subtitle-list');
    if (!container) return;

    container.innerHTML = '';

    // Add "Off" option
    const offOpt = document.createElement('div');
    offOpt.className = 'popover-option';
    offOpt.setAttribute('data-value', 'off');
    offOpt.innerHTML = `<i class="fas fa-closed-captioning"></i> <span>Off</span> <div class="check"></div>`;
    offOpt.addEventListener('click', () => {
        if (typeof setSubtitle === 'function') setSubtitle('off');
    });
    container.appendChild(offOpt);

    tracks.forEach(function(track) {
      const opt = document.createElement('div');
      opt.className = 'popover-option';
      opt.setAttribute('data-value', track.id);
      opt.innerHTML = `<i class="fas fa-closed-captioning"></i> <span>${track._label}</span> <div class="check"></div>`;
      opt.addEventListener('click', function() {
        if (typeof setSubtitle === 'function') setSubtitle(track.id);
      });
      container.appendChild(opt);
    });

    // Sync UI initial state
    if (typeof syncSubtitleUILocal === 'function') syncSubtitleUILocal();
  };

  window.updateSubtitleVisibility = function(visible) {
    const tracks = document.getElementById('main-player').querySelectorAll('track');
    tracks.forEach(t => t.mode = visible ? 'showing' : 'disabled');
  };

  // ---- INITIALIZE ----------------------------------------------------
  document.addEventListener('DOMContentLoaded', init);

})();
