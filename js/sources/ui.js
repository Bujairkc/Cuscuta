async function selectSource(source, element) {
    console.log('[SELECT SOURCE]', `uniqueId=${source.uniqueId}`);

    document.querySelectorAll('.source-item.selected').forEach(el => el.classList.remove('selected'));
    window.selectedSource = source;
    element.classList.add('selected');

    const lookup = source.lookup || {};
    const fingerprint = source.fileName && source.size ? `${source.fileName}_${source.size}` : null;

    let existingTask = (lookup.taskIdentity ? window.downloadManager.get(lookup.taskIdentity) : null) ||
                       (lookup.lookupToken ? window.downloadManager.get(String(lookup.lookupToken)) : null) ||
                       window.downloadManager.get(String(source.uniqueId)) ||
                       window.downloadManager.get(String(source.fileId)) ||
                       (fingerprint ? window.downloadManager.get(fingerprint) : null);

    if (!existingTask) {
        existingTask = await window.getTask(lookup.taskIdentity || lookup.lookupToken || source.uniqueId || source.fileId);
    }

    if (existingTask) {
        // PROACTIVE SYNC
        if (window.tdClient && existingTask.telegram?.fileId && existingTask.progress.state !== 'completed') {
            window.tdClient.send({
                "@type": "getFile",
                "file_id": Number(existingTask.telegram.fileId)
            }).then(f => {
                if (f && f.local) {
                    const isResolved = f.remote && (String(f.remote.unique_id) === String(existingTask.telegram.telegramUniqueId));
                    if (isResolved) {
                        existingTask.progress.identityStatus = 'BOUND';
                        existingTask.progress.networkBytes = f.local.downloaded_size;
                        existingTask.media.totalSize = f.size;
                        window.updateMainDownloadButton();
                    }
                }
            }).catch(() => {});
        }
    }

    if (typeof window.updateMainDownloadButton === 'function') {
        window.updateMainDownloadButton();
    }
}

function renderMovieSources(list) {
  const container = document.getElementById("sourceResults");
  if (!container) return;
  container.innerHTML = "";

  if (!list || list.length === 0) {
      container.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-muted);font-size:14px;">No sources found.</div>';
      return;
  }

  // Filter logic: Strictly filter by Provider ID if not "all"
  let filtered = list;
  const activeFilter = String(window.selectedFilter || "all");

  if (activeFilter !== "all") {
      filtered = list.filter(s => String(s.addonId) === activeFilter);
      console.log(`[UI] Filtering for Provider: ${activeFilter}. Showing ${filtered.length}/${list.length} sources.`);
  }

  // Sort: Best quality first, then size
  filtered.sort((a, b) => {
    const qa = window.detectQuality(a.fileName);
    const qb = window.detectQuality(b.fileName);
    if (qb !== qa) return qb - qa;
    return (b.size || 0) - (a.size || 0);
  });

  filtered.forEach((source, idx) => {
    const div = document.createElement('div');
    div.className = 'source-item';

    // Maintain selection visual state
    if (window.selectedSource && (window.selectedSource.uniqueId === source.uniqueId || window.selectedSource.fileName === source.fileName)) {
        div.classList.add('selected');
    }

    const sizeStr = window.formatSize(source.size);
    const q = window.detectQuality(source.fileName);
    const qualityLabel = q > 0 ? `${q}p` : "Unknown";
    const metaIcon = source.isButton ? "🔗 Reveal" : "💾 File";

    const sourceName = source.fileName || source.title || "Unknown File";

    // Check for existing progress in the list
    const fingerprint = source.fileName && source.size ? `${source.fileName}_${source.size}` : null;
    const lookup = source.lookup || {};

    const task = (lookup.taskIdentity ? window.downloadManager.get(lookup.taskIdentity) : null) ||
                 (lookup.lookupToken ? window.downloadManager.get(String(lookup.lookupToken)) : null) ||
                 window.downloadManager.get(String(source.uniqueId)) ||
                 (fingerprint ? window.downloadManager.get(fingerprint) : null);

    let progressHtml = "";
    if (task && task.progress) {
        const bytes = Math.max(task.progress.diskBytes || 0, task.progress.networkBytes || 0);
        const total = task.media?.totalSize || 0;
        const percent = total > 0 ? Math.round((bytes / total) * 100) : 0;

        if (task.progress.state === 'completed') {
            progressHtml = `<span style="color:var(--accent2);font-weight:bold;margin-left:8px;">✓ Done</span>`;
        } else if (percent > 0) {
            const status = (task.progress.state === 'paused' || task.progress.isPaused) ? "Paused" : "Downloading";
            progressHtml = `<span style="color:var(--accent2);margin-left:8px;">${percent}% ${status}</span>`;
        }
    }

    div.innerHTML = `
      <div class="source-addon">${source.addon}</div>
      <div class="source-content">
        <div class="source-title"><span class="source-eye-icon" title="Quick Play">👁️</span> ${sourceName}${progressHtml}</div>
        <div class="source-meta">${metaIcon}  🏷️ ${qualityLabel}  📦 ${sizeStr}</div>
      </div>
    `;

    // CLICK BEHAVIOR: Select-Only
    div.onclick = (e) => {
      if (e.target.classList.contains('source-eye-icon')) {
        e.stopPropagation();
        handleSourceClick(source, true); // Direct Play
      } else {
        selectSource(source, div); // Just highlight
      }
    };

    container.appendChild(div);
  });
}

function renderSeriesView(seasons) {
  const container = document.getElementById("sourceResults");
  if (!container) return;
  container.innerHTML = "";
  seasons.forEach((season, sIdx) => {
    const header = document.createElement('div');
    header.className = 'source-season-header';
    header.innerHTML = `<span>📺 Season ${season.season} (${season.episodes.length} episodes)</span><span class="season-arrow">▶</span>`;
    header.onclick = function() {
      this.classList.toggle('open');
      const epDiv = this.nextElementSibling;
      const arrow = this.querySelector('.season-arrow');
      if (this.classList.contains('open')) { arrow.textContent = '▼'; epDiv.style.maxHeight = epDiv.scrollHeight + 'px'; }
      else { arrow.textContent = '▶'; epDiv.style.maxHeight = '0'; }
    };

    const epDiv = document.createElement('div');
    epDiv.className = 'source-episodes';
    epDiv.style.maxHeight = '0';
    season.episodes.forEach((ep, epIdx) => {
      const epHeader = document.createElement('div');
      epHeader.className = 'source-item episode-item';
      epHeader.style.cursor = 'pointer';
      epHeader.style.animation = `msgSlideIn 0.3s cubic-bezier(0.34,1.56,0.64,1) ${(epIdx * 0.02)}s both`;
      epHeader.innerHTML = `<div class="source-addon" style="font-size:13px;color:var(--accent2);">Episode ${ep.episode}</div><div class="source-content"><div class="source-title">${window.currentDetailItem.title} S${season.season.toString().padStart(2,'0')}E${ep.episode.toString().padStart(2,'0')}</div></div>`;
      epHeader.onclick = (e) => { e.stopPropagation(); showEpisodeSources(season.season, ep); };
      epDiv.appendChild(epHeader);
    });
    container.appendChild(header);
    container.appendChild(epDiv);
    if (sIdx === 0) setTimeout(() => header.click(), 100);
  });
}

function showEpisodeSources(seasonNum, episode) {
  const container = document.getElementById("sourceResults");
  if (!container) return;
  window.selectedFilter = "all";
  document.getElementById("sourceFilter").value = "all";
  container.innerHTML = '';
  const backBtn = document.createElement('div');
  backBtn.style.cssText = 'padding:8px 10px 12px;cursor:pointer;color:var(--accent2);font-size:13px;font-weight:600;display:flex;align-items:center;gap:4px;';
  backBtn.innerHTML = '← Back to seasons';
  backBtn.onclick = () => loadSources(window.currentDetailItem);
  container.appendChild(backBtn);

  const title = document.createElement('div');
  title.style.cssText = 'padding:0 10px 14px;color:#ddeedd;font-size:16px;font-weight:600;';
  title.textContent = `${window.currentDetailItem.title} S${seasonNum.toString().padStart(2,'0')}E${episode.episode.toString().padStart(2,'0')}`;
  container.appendChild(title);

  // Set global currentSources to episode sources and start search
  window.currentSources = episode.sources || [];
  renderMovieSources(window.currentSources);
}

window.renderMovieSources = renderMovieSources;
window.renderSeriesView = renderSeriesView;
window.showEpisodeSources = showEpisodeSources;
window.selectSource = selectSource;
