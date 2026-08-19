/**
 * CacheManager Foundation - Phase B
 * Responsible for tracking TDLib cache usage, access times, and pinning status.
 */

const CacheManager = {
    entries: new Map(), // fileId -> CacheEntry
    storageKey: 'sv_cache_index',
    limitKey: 'sv_cache_limit_gb',

    init() {
        this.load();
        console.log('[CACHE MANAGER] Initialized with', this.entries.size, 'tracked files.');

        // Initial audit
        this.getCurrentCacheSize();
        this.getEvictionCandidates();
    },

    getCacheLimitGB() {
        return Number(localStorage.getItem(this.limitKey)) || 5;
    },

    setCacheLimitGB(gb) {
        localStorage.setItem(this.limitKey, gb);
        console.log('[CACHE MANAGER] Limit updated to:', gb, 'GB');
        this.checkAndEvict(); // Trigger check on limit change
    },

    /**
     * checkAndEvict
     * Enforces the cache limit with hysteresis.
     */
    async checkAndEvict() {
        const limitGB = this.getCacheLimitGB();
        if (limitGB === Infinity) return;

        const limitBytes = limitGB * (1024 ** 3);
        const stopBytes = limitBytes * 0.90; // Stop when we've cleared enough to be at 90% of limit

        let currentSize = this.getCurrentCacheSize();

        if (currentSize <= limitBytes) return;

        console.log('[LRU EVICTION START]', {
            cacheSize: (currentSize / (1024 ** 3)).toFixed(2) + ' GB',
            limit: limitGB + ' GB'
        });

        const candidates = this.getEvictionCandidates();
        if (candidates.length === 0) {
            console.log('[LRU NO CANDIDATES]');
            return;
        }

        const beforeSize = currentSize;
        let freedBytes = 0;

        for (const entry of candidates) {
            if (currentSize <= stopBytes) break;

            // Safety double check (should be filtered by getEvictionCandidates already)
            if (entry.isPinned || entry.isWatching || entry.isDownloading) {
                console.log('[LRU SKIPPED]', { reason: 'PROTECTED_RACE', fileName: entry.fileName });
                continue;
            }

            if (!entry.cachePath) {
                console.log('[LRU SKIPPED]', { reason: 'MISSING_PATH', fileName: entry.fileName });
                this.entries.delete(entry.fileId); // Cleanup index if no path
                continue;
            }

            try {
                // Real deletion via Electron
                const res = await window.electronAPI.deleteFile(entry.cachePath);

                if (res.success) {
                    console.log('[LRU DELETE]', {
                        fileId: entry.fileId,
                        fileName: entry.fileName,
                        size: entry.size,
                        lastAccessTime: new Date(entry.lastAccessTime).toISOString()
                    });

                    freedBytes += entry.size;
                    currentSize -= entry.size;
                    this.entries.delete(entry.fileId);
                } else {
                    console.log('[LRU SKIPPED]', {
                        reason: res.error === 'FILE_OPEN' ? 'FILE_OPEN' : 'DELETE_FAILED',
                        error: res.error,
                        fileName: entry.fileName
                    });
                }
            } catch (e) {
                console.error('[LRU ERROR] Failed to delete', entry.fileName, e);
            }
        }

        this.save();

        console.log('[LRU COMPLETE]', {
            cacheSizeBefore: (beforeSize / (1024 ** 3)).toFixed(2) + ' GB',
            cacheSizeAfter: (currentSize / (1024 ** 3)).toFixed(2) + ' GB',
            freedBytes: (freedBytes / (1024 ** 2)).toFixed(2) + ' MB'
        });
    },

    /**
     * updateEntry
     * Updates or creates a tracking record for a cached file.
     */
    updateEntry(fileId, data) {
        const id = String(fileId);
        let entry = this.entries.get(id);

        if (!entry) {
            entry = {
                fileId: id,
                uniqueId: data.uniqueId || null,
                fileName: data.fileName || "unknown",
                size: data.size || 0,
                lastAccessTime: Date.now(),
                isWatching: false,
                isDownloading: false,
                isPinned: false,
                cachePath: data.cachePath || null
            };
            console.log('[CACHE ENTRY CREATED]', entry);
        }

        // Merge updates
        Object.assign(entry, data);

        this.entries.set(id, entry);
        this.save();

        // Trigger eviction check on new entries or significant updates
        if (data.size || data.cachePath) {
            this.checkAndEvict();
        }

        return entry;
    },

    getEntry(fileId) {
        return this.entries.get(String(fileId));
    },

    /**
     * onAccess
     * Refreshes the lastAccessTime for LRU logic.
     */
    onAccess(fileId) {
        const entry = this.getEntry(fileId);
        if (entry) {
            entry.lastAccessTime = Date.now();
            console.log('[CACHE ENTRY UPDATED] Access refreshed for:', entry.fileName);
            this.save();
        } else {
            console.warn('[CACHE MANAGER] Access ignored: File ID', fileId, 'not tracked yet.');
        }
    },

    /**
     * getCurrentCacheSize
     * Returns total bytes of all tracked entries.
     */
    getCurrentCacheSize() {
        let total = 0;
        this.entries.forEach(e => {
            total += (e.size || 0);
        });
        const gb = (total / (1024 ** 3)).toFixed(2);
        console.log(`[CACHE SIZE] Total Tracked: ${gb} GB`);
        return total;
    },

    /**
     * getEvictionCandidates
     * Audit-only: Identifies files that could be removed based on LRU rules.
     */
    getEvictionCandidates() {
        const candidates = Array.from(this.entries.values())
            .filter(e => !e.isPinned && !e.isWatching && !e.isDownloading)
            .sort((a, b) => a.lastAccessTime - b.lastAccessTime);

        if (candidates.length > 0) {
            console.log('[LRU CANDIDATE] Oldest identified:', candidates[0].fileName);
        }

        return candidates;
    },

    /**
     * Favorites / Pinning
     */
    pinFile(fileId) {
        const entry = this.getEntry(fileId);
        if (entry) {
            entry.isPinned = true;
            this.save();
            console.log('[FAVORITE PINNED]', entry.fileName);
        }
    },

    unpinFile(fileId) {
        const entry = this.getEntry(fileId);
        if (entry) {
            entry.isPinned = false;
            this.save();
            console.log('[FAVORITE UNPINNED]', entry.fileName);
        }
    },

    /**
     * Persistence
     */
    save() {
        const data = Array.from(this.entries.values());
        localStorage.setItem(this.storageKey, JSON.stringify(data));
    },

    load() {
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (raw) {
                const list = JSON.parse(raw);
                list.forEach(item => this.entries.set(String(item.fileId), item));
            }
        } catch (e) {
            console.error('[CACHE MANAGER] Load failed', e);
        }
    }
};

window.CacheManager = CacheManager;
CacheManager.init();
