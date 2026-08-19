/**
 * PlaybackManager
 *
 * Responsible for launching external players and managing the
 * "Recently Opened" (Continue Watching) state.
 */
const PlaybackManager = {
  /**
   * play
   * Launches the external player and updates the watch history.
   * @param {Object} item - The media item (saved item or download entry).
   */
  play(item) {
    if (!item) return;

    dlog("[PLAYBACK] Play requested for:", item.label || item.fileName);

    // 1. Resolve local file path
    // Priority 1: Current download manager entry
    // Priority 2: Stored path in the item itself (for persisted CW items)
    let filePath = "";
    const fileId = item.fileId;
    const entry = window.downloadManager.get(String(fileId));

    if (entry && entry.progress?.savePath) {
      filePath = entry.progress.savePath;
    } else if (item.savedPath) {
      filePath = item.savedPath;
    }

    // 2. Launch VLC if path is available
    if (filePath) {
      this.launchVLC(filePath);
      // Update item with the resolved path for persistence
      item.savedPath = filePath;
    } else {
      dlog("[PLAYBACK] Cannot launch VLC: Local path not available for fileId", fileId);
    }

    // 3. Add to Continue Watching (Recently Opened)
    if (window.HistoryManager) {
      window.HistoryManager.addToContinueWatching(item);
    }
  },

  /**
   * launchVLC
   * Opens the VLC player using the vlc:// protocol.
   * @param {string} path - Local absolute path to the file.
   */
  launchVLC(path) {
    // Convert backslashes to forward slashes for URI compatibility
    const formattedPath = path.replace(/\\/g, '/');
    const vlcUrl = `vlc://file:///${formattedPath}`;

    dlog("[PLAYBACK] Launching VLC via protocol:", vlcUrl);

    // Launching via protocol
    window.location.href = vlcUrl;
  }
};

// Aliases for backward compatibility
PlaybackManager.addToContinueWatching = function(item) {
    if (window.HistoryManager) window.HistoryManager.addToContinueWatching(item);
};

window.PlaybackManager = PlaybackManager;
