/**
 * Manages the "Continue Watching" (Recently Opened) media history.
 */

const HistoryManager = {
  /**
   * addToContinueWatching
   * Adds the item to the "Recently Opened" list in localStorage and global state.
   */
  addToContinueWatching(item) {
    if (!window.cwItems) return;

    const id = item.id || item.itemId;

    // Check if already in list to avoid duplicates
    const index = window.cwItems.findIndex(i => i.id === id);
    if (index !== -1) {
      // Preserve the savedPath if the new item doesn't have it but the old one does
      if (!item.savedPath && window.cwItems[index].savedPath) {
          item.savedPath = window.cwItems[index].savedPath;
      }
      window.cwItems.splice(index, 1);
    }

    // Add to the top of the list
    window.cwItems.unshift({
      id: id,
      fileId: item.fileId,
      label: item.label || item.fileName,
      title: item.title || item.label || item.fileName,
      g: item.g || 'g8',
      sub: item.sub || 'FEATURE FILM',
      savedPath: item.savedPath || '', // PERSISTENT PATH
      progress: 0,
      timeLeft: ''
    });

    // Limit the history size to 20 items
    if (window.cwItems.length > 20) {
      window.cwItems.pop();
    }

    // Save to localStorage
    try {
      localStorage.setItem('streamvault_cw', JSON.stringify(window.cwItems));
    } catch (e) {
      console.error("[HISTORY] Failed to persist watch history:", e);
    }

    if (typeof dlog === 'function') dlog("[HISTORY] Item added to Continue Watching:", id);

    // Refresh the home UI if it's currently rendered
    if (typeof renderHome === 'function') {
      renderHome();
    }
  }
};

window.HistoryManager = HistoryManager;
