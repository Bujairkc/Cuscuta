function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function normalizeFileName(name) {
  if (!name) return "";
  return name.toLowerCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Generates the permanent StreamVault Task Identity.
 * identity = providerId + lookupToken
 */
function getTaskIdentity(providerId, lookupToken) {
    if (!providerId || !lookupToken) return null;
    return `${providerId}:${lookupToken}`;
}

// detectQuality moved to js/utils/mediaFormatters.js

window.formatSize = formatSize;
window.normalizeFileName = normalizeFileName;
window.getTaskIdentity = getTaskIdentity;
window.detectQuality = window.detectQuality;
