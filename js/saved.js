function updateSavedFromTelegram(items) {
  window.savedItems = items;
  renderSavedList();
}

function openSaved() {
  document.getElementById('saved-panel').classList.add('open');
  document.getElementById('saved-overlay').classList.add('open');
  document.getElementById('saved-btn').classList.add('active');

  if (window.tdClient && typeof window.refreshSavedMessages === 'function') {
    try {
      window.refreshSavedMessages();
    } catch (err) {
      console.warn("[TDLIB] database refresh deferred:", err);
    }
  } else {
    if (typeof renderSavedList === 'function') renderSavedList();
  }
}

function closeSaved() {
  document.getElementById('saved-panel').classList.remove('open');
  document.getElementById('saved-overlay').classList.remove('open');
  document.getElementById('saved-btn').classList.remove('active');
}

function removeSaved(id, e) {
  if(e) e.stopPropagation();
  window.savedItems = (window.savedItems || []).filter(s => s.id !== id);
  renderSavedList();
}

function renderSavedList() {
  const items = window.savedItems || [];
  const list = document.getElementById('saved-list');
  const empty = document.getElementById('saved-empty');
  if(!list) return;

  Array.from(list.querySelectorAll('.saved-item, .saved-date-sep')).forEach(el => el.remove());

  if (items.length === 0) {
    empty.style.display = 'flex';
    document.getElementById('saved-count').textContent = '0';
    return;
  }

  empty.style.display = 'none';
  document.getElementById('saved-count').textContent = items.length;

  const groups = {};
  items.forEach(item => {
    const d = new Date(item.date * 1000);
    const dateStr = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    if (!groups[dateStr]) groups[dateStr] = [];
    groups[dateStr].push(item);
  });

  Object.keys(groups).sort((a, b) => new Date(b) - new Date(a)).forEach(dateStr => {
    const sep = document.createElement('div');
    sep.className = 'saved-date-sep';
    sep.textContent = dateStr;
    list.appendChild(sep);

    groups[dateStr].forEach(item => {
      const el = document.createElement('div');
      el.className = 'saved-item';
      el.id = 'saved-item-' + item.id;
      const timeLabel = new Date(item.date * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      el.innerHTML = `
        <div class="saved-thumb">
          <div class="poster-placeholder g8"><div class="poster-shape ps1"></div></div>
          <div class="dl-overlay-btn" id="dl-btn-${item.id}">
            <div class="dl-circle-wrap">
              <div class="dl-circle-bg"></div>
              <div class="dl-icon-inner">
                <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </div>
            </div>
          </div>
        </div>
        <div class="saved-info">
          <div class="saved-title" title="${item.label}">${item.label}</div>
          <div class="dl-progress-text" style="font-size:11px;color:var(--text-muted);display:none;"></div>
        </div>
        <div class="saved-time">${timeLabel}</div>
        <button class="saved-remove" title="Play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>`;

      el.addEventListener('click', (e) => {
        if (e.target.closest('.dl-overlay-btn')) return;
        closeSaved();
        if (typeof openDetail === 'function') openDetail(item);
      });

      const dlBtn = el.querySelector(`.dl-overlay-btn`);
      if (dlBtn) {
        dlBtn.addEventListener("click", async (e) => {
          e.preventDefault(); e.stopPropagation();
          const key = String(item.fileId);
          const entry = window.downloadManager.get(key);
          if (entry) {
            if (entry.state !== 'completed') toggleDownload(item.fileId, item.id);
          } else {
            if (typeof startDownload === 'function') startDownload(item.fileId, item.id, (item.fileName || (item.label + ".mp4")));
          }
        });
      }
      list.appendChild(el);
    });
  });
}

window.openSaved = openSaved;
window.closeSaved = closeSaved;
window.removeSaved = removeSaved;
window.updateSavedFromTelegram = updateSavedFromTelegram;
window.renderSavedList = renderSavedList;
