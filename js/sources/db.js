// ── DATABASE LAYER ───────────────────────────────────────
async function initSourceDB() {
  if (sourceDB) return sourceDB;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("SourceCache", 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("sources")) {
        const store = db.createObjectStore("sources", { keyPath: "uniqueId" });
        store.createIndex("query", ["title", "year"], { unique: false });
      }
      if (!db.objectStoreNames.contains("sv_tasks")) {
        db.createObjectStore("sv_tasks", { keyPath: "uniqueId" });
      }
    };
    request.onsuccess = (e) => { sourceDB = e.target.result; resolve(sourceDB); };
    request.onerror = (e) => reject(e);
  });
}

async function getCachedSources(title, year) {
  try {
    const db = await initSourceDB();
    const sources = await new Promise((resolve) => {
      const tx = db.transaction("sources", "readonly");
      const index = tx.objectStore("sources").index("query");
      const request = index.getAll(IDBKeyRange.only([title.toLowerCase(), String(year)]));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve([]);
    });
    if (sources.length > 0) console.log(`[CACHE HIT] Found ${sources.length} sources for ${title} (${year})`);
    else console.log(`[CACHE MISS] No cached sources for ${title} (${year})`);
    return sources;
  } catch (e) {
    return [];
  }
}

async function cacheSource(source) {
  try {
    const db = await initSourceDB();
    const movieTitle = source.movieTitle.toLowerCase();
    const movieYear = String(source.movieYear);
    const normNew = normalizeFileName(source.fileName);

    const tx = db.transaction("sources", "readwrite");
    const store = tx.objectStore("sources");
    const index = store.index("query");

    const existing = await new Promise((resolve) => {
      const req = index.getAll(IDBKeyRange.only([movieTitle, movieYear]));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });

    const duplicate = existing.find(s => {
      if (s.uniqueId && source.uniqueId && s.uniqueId === source.uniqueId) return true;
      if (s.startParameter && source.startParameter && s.startParameter === source.startParameter) return true;
      if (s.telegramFileId && source.telegramFileId && s.telegramFileId === source.telegramFileId) return true;
      if (s.fileId && source.fileId && s.fileId === source.fileId) return true;
      if (normalizeFileName(s.fileName) === normNew) return true;
      return false;
    });

    if (duplicate) {
      console.log(`[CACHE DUPLICATE SKIPPED] ${source.fileName}`);
      if (source.startParameter) console.log(`[DUPLICATE START PARAMETER] ${source.startParameter}`);
      if (!duplicate.fileId && source.fileId) {
        store.put({
          ...duplicate,
          ...source,
          title: movieTitle,
          year: movieYear,
          timestamp: Date.now()
        });
      }
      return;
    }

    store.put({
      ...source,
      title: movieTitle,
      year: movieYear,
      timestamp: Date.now()
    });
  } catch (e) {
    console.error("[CACHE ERROR]", e);
  }
}

async function deleteCachedSource(uniqueId) {
  try {
    const db = await initSourceDB();
    const tx = db.transaction("sources", "readwrite");
    tx.objectStore("sources").delete(uniqueId);
    console.log(`[CACHE PURGED] ${uniqueId}`);
  } catch (e) {
    console.error("[CACHE DELETE ERROR]", e);
  }
}

window.initSourceDB = initSourceDB;
window.getCachedSources = getCachedSources;
window.cacheSource = cacheSource;
window.deleteCachedSource = deleteCachedSource;

async function getTask(uniqueId) {
  const db = await initSourceDB();
  return new Promise((resolve) => {
    const tx = db.transaction("sv_tasks", "readonly");
    const req = tx.objectStore("sv_tasks").get(uniqueId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function saveTask(task) {
  const db = await initSourceDB();
  const tx = db.transaction("sv_tasks", "readwrite");
  tx.objectStore("sv_tasks").put(task);
}

window.getTask = getTask;
window.saveTask = saveTask;
