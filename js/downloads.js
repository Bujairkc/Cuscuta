function openDownloads() {
  document.getElementById('dl-panel').classList.add('open');
  document.getElementById('dl-overlay').classList.add('open');
  document.getElementById('dl-btn').classList.add('active');

  // Close other panels
  if (typeof closeSaved === 'function') closeSaved();
  if (typeof closeExtensions === 'function') closeExtensions();

  renderDownloadsPanel();
  dlog("[UI] Downloads panel opened");
}

function closeDownloads() {
  document.getElementById('dl-panel').classList.remove('open');
  document.getElementById('dl-overlay').classList.remove('open');
  document.getElementById('dl-btn').classList.remove('active');
}

function renderDownloadsPanel() {
  const list = document.getElementById('dl-list');
  const empty = document.getElementById('dl-empty');
  if (!list || !empty) return;

  // Preserve the empty state element
  Array.from(list.querySelectorAll('.dl-item')).forEach(el => el.remove());

  const activeDownloads = Array.from(window.downloadManager.values());
  document.getElementById('dl-badge').textContent = activeDownloads.length;

  if (activeDownloads.length === 0) {
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';

  activeDownloads.forEach(entry => {
    const el = document.createElement('div');
    el.className = 'dl-item';
    el.id = 'dl-item-' + entry.telegram.fileId;

    // UNIFIED METRIC CALCULATION
    const currentBytes = Math.max(entry.progress.diskBytes || 0, entry.progress.streamedBytes || 0, entry.progress.networkBytes || 0);
    const totalBytes = entry.media.totalSize || 0;
    const percent = totalBytes > 0 ? Math.round((currentBytes / totalBytes) * 100) : 0;
    const isWriting = entry.progress.isNetworkDone && (entry.progress.diskBytes || 0) < totalBytes;

    // Smooth Rolling Speed Average
    let measuredSpeed = 0;
    if (entry._speedSamples && entry._speedSamples.length > 1) {
       const first = entry._speedSamples[0];
       const last = entry._speedSamples[entry._speedSamples.length - 1];
       const timeDiff = (last.t - first.t) / 1000;
       if (timeDiff > 0) measuredSpeed = (last.b - first.b) / timeDiff;
    }
    const displaySpeed = measuredSpeed > 0 ? (measuredSpeed / (1024 * 1024)).toFixed(2) + ' MB/s' : '';

    el.innerHTML = `
      <div class="dl-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </div>
      <div class="dl-info">
        <div class="dl-name" title="${entry.media.fileName}">${entry.media.fileName}</div>
        <div class="dl-bar-wrap">
          <div class="dl-bar ${entry.progress.state === 'paused' ? 'paused' : ''}" style="width:${percent}%"></div>
        </div>
        <div class="dl-status ${entry.progress.state === 'downloading' || entry.progress.state === 'finalizing' ? 'active' : ''}">
          ${formatSize(currentBytes)} / ${formatSize(totalBytes)} • ${displaySpeed ? displaySpeed + ' • ' : ''}${isWriting || entry.progress.state === 'finalizing' ? 'SAVING...' : entry.progress.state.toUpperCase()}
        </div>
      </div>
      <div class="dl-pct">${percent}%</div>
      <div style="display:flex; gap:6px; margin-left:8px;">
        <button class="saved-remove dl-pause-resume" title="${entry.progress.state === 'downloading' ? 'Pause' : 'Resume'}">
          ${entry.progress.state === 'downloading'
            ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'}
        </button>
        <button class="saved-remove dl-play" title="Play">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
    `;

    el.querySelector('.dl-pause-resume').onclick = (e) => {
      e.stopPropagation();
      if (typeof toggleDownload === 'function') {
        toggleDownload(entry.telegram.fileId, entry.discovery.messageId);
      }
    };

    el.querySelector('.dl-play').onclick = (e) => {
      e.stopPropagation();
      dlog("[UI] Play clicked for", entry.telegram.fileId);
    };

    list.appendChild(el);
  });
}

// Update the downloads panel periodically if visible
setInterval(() => {
  const dlPanel = document.getElementById('dl-panel');
  if (dlPanel && dlPanel.classList.contains('open')) {
    renderDownloadsPanel();
  }
}, 1000);

function renderSavedItemOverlay(container, entry) {
  const btn = container.querySelector('.dl-overlay-btn');
  const progText = container.querySelector('.dl-progress-text');
  if (!btn) return;

  const currentBytes = Math.max(entry.progress.diskBytes || 0, entry.progress.streamedBytes || 0, entry.progress.networkBytes || 0);
  const totalBytes = entry.media.totalSize || 0;
  const percent = totalBytes > 0 ? Math.round((currentBytes / totalBytes) * 100) : 0;
  const isWriting = entry.progress.isNetworkDone && (entry.progress.diskBytes || 0) < totalBytes;

  const mainDlBtn = document.getElementById('main-download-btn');
  if (mainDlBtn && window.selectedSource && (window.selectedSource.fileId == entry.telegram.fileId || window.selectedSource.uniqueId == entry.telegram.telegramUniqueId || window.selectedSource.taskId == entry.taskId)) {
      let progBar = mainDlBtn.querySelector('.btn-progress');
      if (!progBar) {
          progBar = document.createElement('div');
          progBar.className = 'btn-progress';
          mainDlBtn.appendChild(progBar);
      }
      progBar.style.width = percent + '%';
      const btnText = mainDlBtn.querySelector('.btn-text');
      if (btnText) {
          if (entry.progress.state === 'completed') btnText.textContent = 'Completed';
          else if (entry.progress.state === 'error') btnText.textContent = 'Retry Download';
          else if (entry.progress.state === 'paused' || entry.progress.isPaused) btnText.textContent = percent + '% Paused';
          else if (isWriting || entry.progress.state === 'finalizing') btnText.textContent = 'Saving to disk...';
          else btnText.textContent = percent + '% Downloading...';
      }
  }

  if (entry.progress.state === 'completed') {
    btn.innerHTML = `<div class="dl-circle-wrap" style="transform: scale(1.2);"><div class="dl-circle-bg"></div><div class="dl-icon-inner"><svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div></div>`;
    if (progText) progText.style.display = 'none';
    return;
  }

  const circumference = 107;
  const offset = circumference - (percent / 100) * circumference;

  if (entry.progress.state === 'downloading' || entry.progress.state === 'paused' || isWriting || entry.progress.state === 'finalizing') {
    const sizeText = totalBytes ? `${formatSize(currentBytes)} / ${formatSize(totalBytes)}` : `${percent}%`;

    let measuredSpeed = 0;
    if (entry._speedSamples && entry._speedSamples.length > 1) {
       const first = entry._speedSamples[0];
       const last = entry._speedSamples[entry._speedSamples.length - 1];
       const timeDiff = (last.t - first.t) / 1000;
       if (timeDiff > 0.1) measuredSpeed = (last.b - first.b) / timeDiff;
    }

    const displaySpeed = (measuredSpeed / (1024 * 1024)).toFixed(2);
    const speedText = measuredSpeed > 1024 ? `${displaySpeed} MB/s` : '';

    let etaText = '';
    if (measuredSpeed > 10240 && entry.media.totalSize) {
        const remaining = entry.media.totalSize - currentBytes;
        const seconds = Math.round(remaining / measuredSpeed);
        if (seconds > 0) {
            if (seconds < 60) etaText = ` - ${seconds}s`;
            else if (seconds < 3600) etaText = ` - ${Math.floor(seconds/60)}m ${seconds%60}s`;
            else etaText = ` - ${Math.floor(seconds/3600)}h`;
        }
    }

    if (progText) {
      progText.textContent = `${isWriting || entry.progress.state === 'finalizing' ? 'Saving... ' : ''}${percent}% • ${sizeText} ${speedText ? '• ' + speedText : ''}${etaText}`;
      progText.style.display = 'block';
    }

    if ((entry.progress.state === 'downloading' || entry.progress.state === 'finalizing') && !entry.progress.isPaused) {
      btn.innerHTML = `
        <div class="dl-circle-wrap" style="transform: scale(1.2);">
          <svg class="dl-svg" viewBox="0 0 38 38" style="transform:rotate(-90deg);width:100%;height:100%;">
            <circle cx="19" cy="19" r="17" style="stroke:rgba(255,255,255,0.2);stroke-width:2.5;fill:rgba(0,0,0,0.4)"/>
            <circle cx="19" cy="19" r="17" style="stroke:#fff;stroke-width:2.5;stroke-dasharray:${circumference};stroke-dashoffset:${offset};stroke-linecap:round;"/>
          </svg>
          <div class="dl-icon-inner">
            <svg viewBox="0 0 24 24" fill="#fff" style="width:14px;height:14px;"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
          </div>
        </div>`;
    } else {
      btn.innerHTML = `
        <div class="dl-circle-wrap" style="transform: scale(1.2);">
          <svg class="dl-svg" viewBox="0 0 38 38" style="transform:rotate(-90deg);width:100%;height:100%;">
            <circle cx="19" cy="19" r="17" style="stroke:rgba(255,255,255,0.2);stroke-width:2.5;fill:rgba(0,0,0,0.4)"/>
            <circle cx="19" cy="19" r="17" style="stroke:#fff;stroke-width:2.5;stroke-dasharray:${circumference};stroke-dashoffset:${offset};stroke-linecap:round;"/>
          </svg>
          <div class="dl-icon-inner">
            <svg viewBox="0 0 24 24" fill="#fff" style="width:14px;height:14px;"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>`;
    }
  } else {
    if (progText) progText.style.display = 'none';
    btn.innerHTML = `<div class="dl-circle-wrap"><div class="dl-circle-bg"></div><div class="dl-icon-inner"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div></div>`;
  }
}
