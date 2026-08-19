const TMDB_API_KEY = "6c53e22511383ad8701b4c58b2e89617";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";
const TMDB_BACKDROP_BASE_URL = "https://image.tmdb.org/t/p/original";

// Global data state
window.realMovies = [];
window.realSeries = [];
window.realFeatured = [];

// Mock Data Definitions
(function() {
    const GENRES   = ["Action","Adventure","Comedy","Drama","Sci-Fi","Horror","Thriller","Fantasy","Mystery","Romance"];
    const CAST     = [["Ryan Gosling","Sandra Hüller","James Ortiz"],["Tom Holland","Zendaya","Mark Ruffalo"],["Margot Robbie","Pedro Pascal","Idris Elba"]];
    const DIRECTORS= [["Phil Lord","Christopher Miller"],["Denis Villeneuve"],["Greta Gerwig"]];
    const SUMMARIES= ["A science teacher wakes up alone on a spaceship...", "In a dystopian future...", "Two estranged siblings reunite..."];
    const YEARS  = [2026, 2025, 2024];
    const RATINGS= [8.3, 7.9, 8.1];
    const DURATIONS=["157 min", "124 min", "138 min"];
    const gradients = ["g1","g2","g3","g4","g5","g6","g7","g8","g9","g10","g11","g12","g13","g14","g15","g16"];

    function makeMovies(prefix, count, startG) {
      return Array.from({length: count}, (_, i) => ({
        id: prefix + (i+1),
        label: prefix + " " + (i+1),
        title: prefix + " " + (i+1),
        g: gradients[(startG + i) % gradients.length],
        genres: [GENRES[i % GENRES.length], GENRES[(i+2) % GENRES.length]].slice(0,2),
        cast: CAST[i % CAST.length],
        directors: DIRECTORS[i % DIRECTORS.length],
        summary: SUMMARIES[i % SUMMARIES.length],
        duration: DURATIONS[i % DURATIONS.length],
        year: YEARS[i % YEARS.length],
        rating: RATINGS[i % RATINGS.length],
        sub: prefix === "Movie" ? "FEATURE FILM" : prefix === "Series" ? "TV SERIES" : "FEATURED",
      }));
    }

    window.mockMovies = makeMovies("Movie", 9, 0);
    window.mockSeries = makeMovies("Series", 9, 5);
    window.mockFeatured = makeMovies("Feature", 8, 10);
    window.cwItems = [];
})();

// Automatic fallback accessors
Object.defineProperty(window, 'movies', { get: () => window.realMovies.length > 0 ? window.realMovies : window.mockMovies });
Object.defineProperty(window, 'series', { get: () => window.realSeries.length > 0 ? window.realSeries : window.mockSeries });
Object.defineProperty(window, 'featured', { get: () => window.realFeatured.length > 0 ? window.realFeatured : window.mockFeatured });

async function fetchTMDB(endpoint, params = {}, signal = null) {
  const url = new URL(`${TMDB_BASE_URL}${endpoint}`);
  url.searchParams.append("api_key", TMDB_API_KEY);
  for (const key in params) { url.searchParams.append(key, params[key]); }
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`TMDB API Error: ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return null;
  }
}

function mapTMDBItem(item, type) {
  const isMovie = type === 'movie' || item.media_type === 'movie';
  const gradients = ["g1","g2","g3","g4","g5","g6","g7","g8","g9","g10","g11","g12","g13","g14","g15","g16"];
  const randomG = gradients[item.id % gradients.length];
  return {
    tmdbId: item.id,
    id: `tmdb_${item.id}`,
    label: isMovie ? item.title : item.name,
    title: isMovie ? item.title : item.name,
    poster: item.poster_path ? `${TMDB_IMAGE_BASE_URL}${item.poster_path}` : null,
    backdrop: item.backdrop_path ? `${TMDB_BACKDROP_BASE_URL}${item.backdrop_path}` : null,
    rating: item.vote_average ? item.vote_average.toFixed(1) : "0.0",
    year: (isMovie ? item.release_date : item.first_air_date)?.split("-")[0] || "N/A",
    sub: isMovie ? "FEATURE FILM" : "TV SERIES",
    type: isMovie ? "movie" : "tv",
    g: randomG
  };
}

async function loadCatalog() {
  const cached = localStorage.getItem('tmdb_catalog_cache');
  if (cached) {
    try {
      const data = JSON.parse(cached);
      window.realMovies = data.movies || [];
      window.realSeries = data.series || [];
      window.realFeatured = data.featured || [];
      if (window.realMovies.length || window.realSeries.length) {
          if (typeof renderHome === "function") renderHome();
      }
    } catch (e) {}
  }

  try {
    const [popularMovies, popularTV, trending] = await Promise.all([
      fetchTMDB("/movie/popular"),
      fetchTMDB("/tv/popular"),
      fetchTMDB("/trending/all/day")
    ]);

    if (popularMovies?.results) window.realMovies = popularMovies.results.map(item => mapTMDBItem(item, 'movie'));
    if (popularTV?.results) window.realSeries = popularTV.results.map(item => mapTMDBItem(item, 'tv'));
    if (trending?.results) window.realFeatured = trending.results.map(item => mapTMDBItem(item));

    localStorage.setItem('tmdb_catalog_cache', JSON.stringify({
      movies: window.realMovies,
      series: window.realSeries,
      featured: window.realFeatured,
      timestamp: Date.now()
    }));
    if (typeof renderHome === "function") renderHome();
  } catch (err) { console.error("Catalog refresh failed", err); }
}

// ── EXPLORE SEARCH ───────────────────────────────────────
window.currentSearchAbort = null;
window.searchDebounceTimer = null;

function handleExploreSearch() {
  const query = document.getElementById('explore-search-input').value.trim();
  const grid = document.getElementById('explore-results-grid');

  if (!query) {
    grid.innerHTML = '<div style="grid-column:1/-1; padding:10px 0; font-size:13px; color:var(--text-muted);">Search movies or TV series</div>';
    return;
  }

  clearTimeout(window.searchDebounceTimer);
  window.searchDebounceTimer = setTimeout(() => performExploreSearch(query), 400);
}

async function performExploreSearch(query) {
  const grid = document.getElementById('explore-results-grid');

  // 1. Normalize Helpers
  const normalize = (s) => s ? s.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ') : "";
  const nQuery = normalize(query);
  const qWords = nQuery.split(' ').filter(w => w);

  // 2. Check Cache
  const cached = getExploreCache(query);
  if (cached) {
    if (typeof renderCards === 'function') renderCards(cached, 'explore-results-grid');
    return;
  }

  // 3. Abort previous request
  if (window.currentSearchAbort) window.currentSearchAbort.abort();
  window.currentSearchAbort = new AbortController();

  try {
    const data = await fetchTMDB("/search/multi", { query: query }, window.currentSearchAbort.signal);
    if (!data || !data.results) return;

    // 4. Rank, Deduplicate and Filter
    const seen = new Map();
    data.results.forEach(item => {
      // 4a. Basic Validation
      if (item.media_type !== 'movie' && item.media_type !== 'tv') return;
      if (!item.poster_path) return; // SKIP items without posters

      const titleText = item.title || item.name || "";
      const originalTitleText = item.original_title || item.original_name || "";
      const title = normalize(titleText);
      const original = normalize(originalTitleText);
      const year = parseInt((item.release_date || item.first_air_date || "0").split("-")[0]) || 0;

      // 4b. Local Scoring
      let score = 0;
      if (title === nQuery || original === nQuery) {
        score = 100000; // EXACT MATCH
      } else if (title.startsWith(nQuery) || original.startsWith(nQuery)) {
        score = 90000;  // STARTS WITH
      } else if (title.includes(nQuery) || original.includes(nQuery)) {
        score = 80000;  // PHRASE MATCH
      } else {
        const tWords = title.split(' ').concat(original.split(' '));
        const matches = qWords.filter(w => tWords.includes(w));

        if (matches.length === qWords.length && qWords.length > 0) {
          score = 70000; // ALL WORDS PRESENT
        } else {
          // FUZZY / TYPO CHECK
          const isFuzzy = qWords.some(qw => tWords.some(tw => {
              if (Math.abs(qw.length - tw.length) > 2) return false;
              let common = 0;
              const temp = tw.split('');
              for(const c of qw) { const i = temp.indexOf(c); if(i!==-1) { common++; temp.splice(i,1); } }
              return (common / Math.max(qw.length, tw.length)) > 0.75;
          }));
          if (isFuzzy) score = 50000;
          else if (matches.length > 0) score = 100; // PARTIAL
        }
      }

      // 4c. Lenient multi-word filter (don't over-filter, but remove trash)
      if (qWords.length >= 2 && score < 50000) {
        const tWords = title.split(' ').concat(original.split(' '));
        const matches = qWords.filter(w => tWords.includes(w));
        if (matches.length / qWords.length < 0.5) score = 0;
      }

      if (score === 0) return;

      const key = `${item.media_type}_${item.id}`;
      const existing = seen.get(key);
      // Keep only one card, prioritize highest score and newest year
      if (!existing || score > existing._score || (score === existing._score && year > existing._year)) {
        item._score = score;
        item._year = year;
        seen.set(key, item);
      }
    });

    const sorted = Array.from(seen.values()).sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      if (b._year !== a._year) return b._year - a._year;
      return (b.popularity || 0) - (a.popularity || 0);
    });

    const finalItems = sorted.map(item => mapTMDBItem(item));

    grid.innerHTML = ''; // CRITICAL: Reset grid to ensure zero duplicates

    if (finalItems.length === 0) {
      grid.innerHTML = '<div class="loading" style="grid-column:1/-1">No results found</div>';
    } else {
      if (typeof renderCards === 'function') {
          renderCards(finalItems, 'explore-results-grid');
          setExploreCache(query, finalItems);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error("Search failed", err);
    grid.innerHTML = '<div class="loading" style="grid-column:1/-1">Search failed. Please try again.</div>';
  }
}

function getExploreCache(query) {
  const key = `search_${query.toLowerCase()}`;
  const stored = localStorage.getItem('tmdb_search_cache');
  if (!stored) return null;
  try {
    const cache = JSON.parse(stored);
    const item = cache[key];
    if (item && Date.now() - item.time < 3600000) { // 1 hour expiry
      return item.data;
    }
  } catch(e) {}
  return null;
}

function setExploreCache(query, data) {
  const key = `search_${query.toLowerCase()}`;
  let cache = {};
  try {
    const stored = localStorage.getItem('tmdb_search_cache');
    if (stored) cache = JSON.parse(stored);
  } catch(e) {}

  cache[key] = { data, time: Date.now() };

  const keys = Object.keys(cache);
  if (keys.length > 50) delete cache[keys[0]]; // Limit cache size

  localStorage.setItem('tmdb_search_cache', JSON.stringify(cache));
}

window.loadCatalog = loadCatalog;
window.handleExploreSearch = handleExploreSearch;

window.getSeasonEpisodes = async function(tvId, seasonNumber) {
  try {
    const data = await fetchTMDB(`/tv/${tvId}/season/${seasonNumber}`);
    if (!data || !data.episodes) return [];
    return data.episodes.map(ep => ({
      episode_number: ep.episode_number,
      name: ep.name,
      overview: ep.overview,
      still_path: ep.still_path ? `${TMDB_IMAGE_BASE_URL}${ep.still_path}` : null,
      air_date: ep.air_date
    }));
  } catch (e) {
    console.error("Error fetching episodes", e);
    return [];
  }
};

window.getFullDetails = async function(item) {
  const type = item.type || (item.sub === "TV SERIES" ? "tv" : "movie");
  const data = await fetchTMDB(`/${type}/${item.tmdbId}`, { append_to_response: "credits" });
  if (!data) return item;
  const isMovie = type === 'movie';
  return {
    ...item,
    summary: data.overview,
    genres: data.genres?.map(g => g.name) || [],
    cast: data.credits?.cast?.slice(0, 10).map(c => c.name) || [],
    directors: isMovie ? data.credits?.crew?.filter(c => c.job === "Director").map(c => c.name) : data.created_by?.map(c => c.name),
    duration: isMovie ? (data.runtime ? `${data.runtime} min` : "") : (data.episode_run_time?.[0] ? `${data.episode_run_time[0]} min` : ""),
    rating: data.vote_average ? data.vote_average.toFixed(1) : item.rating,
    year: (isMovie ? data.release_date : data.first_air_date)?.split("-")[0] || item.year,
    backdrop: data.backdrop_path ? `${TMDB_BACKDROP_BASE_URL}${data.backdrop_path}` : item.backdrop,
    seasons: data.seasons
  };
};
