function renderCW(items, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const list = items || window.cwItems || [];

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted); font-size: 14px; background: rgba(255,255,255,0.02); border-radius: 12px; border: 1px dashed rgba(82,196,98,0.1);';
    empty.textContent = 'No continue watching items';
    container.appendChild(empty);
    return;
  }

  list.forEach(item => {
    const card = document.createElement('div');
    card.className = 'cw-card';

    const posterUrl = item.poster || (item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null);
    const posterHtml = posterUrl
      ? `<img src="${posterUrl}" class="card-img" alt="${item.label}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : "";

    card.innerHTML = `
      <div class="cw-poster">
        ${posterHtml}
        <div class="poster-placeholder ${item.g || 'g1'}" style="${posterUrl ? 'display:none' : 'display:flex'}">
          <div class="poster-shape ps1"></div>
          <div class="poster-shape ps3"></div>
          <span style="position:relative;z-index:1;text-shadow:0 2px 8px rgba(0,0,0,0.6)">${item.label}</span>
        </div>
        <div class="card-overlay">
        </div>
        <div class="cw-resume-badge">${item.timeLeft || ''}</div>
        <div class="cw-progress-wrap">
          <div class="cw-progress-bar" style="width:${item.progress || 0}%"></div>
        </div>
      </div>
      <div class="card-title">${item.label}</div>
      <div class="cw-meta">${item.progress || 0}% watched</div>
    `;
    card.addEventListener('click', () => openDetail(item));
    container.appendChild(card);
  });
}

function renderCards(items, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (!items || items.length === 0) return;

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'card';

    const posterUrl = item.poster || (item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null);
    const posterHtml = posterUrl
      ? `<img src="${posterUrl}" class="card-img" alt="${item.label}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : "";

    card.innerHTML = `
      <div class="card-poster">
        ${posterHtml}
        <div class="poster-placeholder ${item.g || 'g1'}" style="${posterUrl ? 'display:none' : 'display:flex'}">
          <div class="poster-shape ps1"></div>
          <div class="poster-shape ps3"></div>
          <span style="position:relative;z-index:1;text-shadow:0 2px 8px rgba(0,0,0,0.5);font-size:15px">${item.label}</span>
        </div>
        <div class="card-overlay">
        </div>
        ${item.rating ? `<div class="card-rating-badge">★ ${item.rating}</div>` : ''}
        ${item.year ? `<div class="card-year-badge">${item.year}</div>` : ''}
      </div>
      <div class="card-title">${item.label}</div>
    `;
    card.addEventListener('click', () => openDetail(item));
    container.appendChild(card);
  });
}

function renderHome() {
  console.log('[RENDER] renderHome triggered');
  if (typeof renderCW === 'function') renderCW(window.cwItems, 'cw-grid');

  // Real data arrays from movies.js (priority) or mock data
  const movieData = (window.realMovies && window.realMovies.length > 0) ? window.realMovies : (window.mockMovies || []);
  const seriesData = (window.realSeries && window.realSeries.length > 0) ? window.realSeries : (window.mockSeries || []);
  const featuredData = (window.realFeatured && window.realFeatured.length > 0) ? window.realFeatured : (window.mockFeatured || []);

  console.log('[RENDER] Data counts:', { movies: movieData.length, series: seriesData.length, featured: featuredData.length });

  renderCards(movieData, 'movies-grid');
  renderCards(seriesData, 'series-grid');

  const featuredGrid = document.getElementById('featured-grid');
  if (featuredGrid) {
    renderCards(featuredData, 'featured-grid');
    const titleEl = featuredGrid.previousElementSibling?.querySelector('.section-title');
    if (titleEl) titleEl.textContent = (window.realFeatured && window.realFeatured.length > 0) ? 'Trending Now' : 'Featured – Movie';
  }
}

function renderCatalog() { renderHome(); }
function renderMovies() { renderCards(window.movies, 'movies-grid'); }

window.renderCW = renderCW;
window.renderCards = renderCards;
window.renderHome = renderHome;
window.renderCatalog = renderCatalog;
window.renderMovies = renderMovies;
