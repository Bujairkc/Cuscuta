/**
 * Pure functions for media title cleaning, quality detection, and validation.
 */

function normalize(s) {
  return s ? s.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ') : "";
}

function cleanTelegramTitle(t) {
  if (!t) return "Video";
  let n = t.replace(/\.[^/.]+$/, "").replace(/[\._]/g, " ");
  const m = ["1080p","720p","2160p","4k","bluray","webrip","web dl","h264","x264","h265","x265"];
  const r = new RegExp("\\b(" + m.join("|") + ")\\b", "i");
  const idx = n.search(r);
  if (idx > 0) n = n.substring(0, idx);
  const yr = n.search(/\b(19|20)\d{2}\b/);
  if (yr > 0) n = n.substring(0, yr);
  return n.trim() || t;
}

function detectQuality(text) {
  const t = text.toLowerCase();
  if (t.includes("2160") || t.includes("4k") || t.includes("uhd")) return 2160;
  if (t.includes("1440") || t.includes("2k")) return 1440;
  if (t.includes("1080") || t.includes("fhd")) return 1080;
  if (t.includes("720") || t.includes("hd")) return 720;
  if (t.includes("480") || t.includes("sd")) return 480;
  if (t.includes("360")) return 360;
  return 0;
}

function isValidVideoFile(fileName, size) {
  if (!fileName) return false;
  const fn = fileName.toLowerCase().trim();
  const subExts = ['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx'];
  if (subExts.some(ext => fn.endsWith(ext))) {
    return false;
  }

  const MIN_SIZE = 5 * 1024 * 1024; // Lowered to 5MB to support small episodes
  if (size > 0 && size < MIN_SIZE) {
    return false;
  }

  const videoExts = ['mkv', 'mp4', 'avi', 'mov', 'webm', 'm4v', 'ts'];
  const qualities = ['2160p', '1440p', '1080p', '720p', '480p', '360p', '4k', 'uhd', 'fhd', 'hd', 'sd'];

  // Robust check: matches ".mkv" or " mkv" or "mkv" at the very end
  const hasVideoExt = videoExts.some(ext => {
      return fn.endsWith('.' + ext) ||
             fn.endsWith(' ' + ext) ||
             fn.includes('.' + ext + ' ') ||
             fn.includes(' ' + ext + ' ');
  });

  const hasQuality = qualities.some(q => fn.includes(q));
  return (hasVideoExt || hasQuality);
}

function shortenProviderName(name) {
    if (!name) return "Unknown";
    let n = name.replace(/^@/, '').toLowerCase();
    n = n.replace(/bot$/, '').replace(/_bot$/, '').replace(/official$/, '').replace(/provider$/, '');
    if (n.length > 12) n = n.substring(0, 11) + '...';
    return n.charAt(0).toUpperCase() + n.slice(1);
}

function parseEpisodeContext(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  // S01E02, S01 E02, S1E2
  const sxxexx = t.match(/s(\d+)\s*e(\d+)/i);
  if (sxxexx) return { season: parseInt(sxxexx[1]), episode: parseInt(sxxexx[2]) };

  // 1x02, 1X02
  const xFormat = t.match(/(\d+)x(\d+)/i);
  if (xFormat) return { season: parseInt(xFormat[1]), episode: parseInt(xFormat[2]) };

  // Season 1 Episode 2
  const longFormat = t.match(/season\s*(\d+).*episode\s*(\d+)/i);
  if (longFormat) return { season: parseInt(longFormat[1]), episode: parseInt(longFormat[2]) };

  return null;
}

// Export to global scope
window.normalize = normalize;
window.cleanTelegramTitle = cleanTelegramTitle;
window.detectQuality = detectQuality;
window.isValidVideoFile = isValidVideoFile;
window.shortenProviderName = shortenProviderName;
window.parseEpisodeContext = parseEpisodeContext;
