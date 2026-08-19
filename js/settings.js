function openSettings() {
  const homeView = document.getElementById('home-view');
  const settingsView = document.getElementById('settings-view');
  if (!homeView || !settingsView) return;

  homeView.style.display = 'none';
  settingsView.style.display = 'block';

  // Update sidebar active state
  document.querySelectorAll('.sidebar-icon').forEach(icon => icon.classList.remove('active'));
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.classList.add('active');

  // Close any floating panels
  if (typeof closeDownloads === 'function') closeDownloads();
  if (typeof closeExtensions === 'function') closeExtensions();
  if (typeof closeSaved === 'function') closeSaved();
  if (typeof closeDetail === 'function') closeDetail();

  dlog("[UI] Settings opened");
}

function showHome() {
  const homeView = document.getElementById('home-view');
  const settingsView = document.getElementById('settings-view');
  if (!homeView || !settingsView) return;

  homeView.style.display = 'block';
  settingsView.style.display = 'none';

  // Update sidebar active state
  document.querySelectorAll('.sidebar-icon').forEach(icon => icon.classList.remove('active'));
  const homeBtn = document.getElementById('home-btn');
  if (homeBtn) homeBtn.classList.add('active');

  dlog("[UI] Home view restored");
}

async function clearDownloadData() {
  if (!confirm("Are you sure you want to clear your download history and internal file cache? This will reset your active downloads. (Search results and login will remain).")) {
    return;
  }

  try {
    dlog("[SYSTEM] Starting download data purge...");

    // 1. Clear Download History (IndexedDB)
    const db = await initSourceDB();
    const tx = db.transaction(["sv_tasks"], "readwrite");
    tx.objectStore("sv_tasks").clear();
    dlog("[SYSTEM] Download history (sv_tasks) cleared.");

    // 2. Clear Active Progress (LocalStorage)
    localStorage.removeItem('sv_active_downloads');
    dlog("[SYSTEM] Active download progress cleared.");

    // 3. Reset In-memory state
    if (window.downloadManager) {
        window.downloadManager.clear();
    }

    // 4. Purge TDLib's internal file cache (Actual byte data)
    if (window.tdClient) {
        dlog("[SYSTEM] Purging TDLib file cache...");
        await window.tdClient.send({
            '@type': 'optimizeStorage',
            'size': 0, 'ttl': 0, 'count': 0, 'immunity_delay': -1,
            'file_types': [
                { '@type': 'fileTypeVideo' },
                { '@type': 'fileTypeDocument' }
            ],
            'chat_ids': [], 'exclude_chat_ids': [], 'return_stats': false, 'chat_limit': 0
        });
        dlog("[SYSTEM] TDLib cache purged.");
    }

    // 5. Update UI
    if (typeof restoreDownloadUI === 'function') await restoreDownloadUI();
    const dlBadge = document.getElementById('dl-badge');
    if (dlBadge) {
        dlBadge.textContent = '0';
        dlBadge.style.display = 'none';
    }

    alert("Download data and cache cleared!");
    location.reload();

  } catch (err) {
    console.error("[SYSTEM] Error during data purge:", err);
    alert("An error occurred while clearing download data.");
  }
}

// Map the generic "Back" behavior to return to Home if Settings is open
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const settingsView = document.getElementById('settings-view');
    if (settingsView && settingsView.style.display === 'block') {
      showHome();
    }
  }
});
