let currentDetailItem = null;

async function openDetail(item) {
  // Reset series selector visibility
  document.getElementById('series-selector').style.display = 'none';
  document.getElementById('d-seasons').innerHTML = '';
  document.getElementById('d-episodes').innerHTML = '';

  // Show basic info first
  renderDetailUI(item);
  document.getElementById('detail-page').classList.add('open');
  document.body.style.overflow = 'hidden';

  // Fetch full details from TMDB
  const fullItem = await getFullDetails(item);
  currentDetailItem = fullItem;
  renderDetailUI(fullItem);

  // If Series, show selector. If Movie, load sources immediately.
  if (fullItem.type === 'tv' || fullItem.sub === "TV SERIES") {
      renderSeasons(fullItem.seasons);
  } else if (typeof loadSources === 'function') {
      loadSources(fullItem);
  }
}

function renderSeasons(seasons) {
    const container = document.getElementById('d-seasons');
    if (!container || !seasons) return;
    container.innerHTML = '';
    document.getElementById('series-selector').style.display = 'block';

    seasons.forEach(season => {
        if (season.season_number === 0) return; // Skip specials usually

        const chip = document.createElement('div');
        chip.className = 'season-chip';
        chip.textContent = `Season ${season.season_number}`;
        chip.onclick = () => {
            document.querySelectorAll('.season-chip').forEach(el => el.classList.remove('active'));
            chip.classList.add('active');
            renderEpisodes(season.season_number);
        };
        container.appendChild(chip);
    });

    // Auto-select first season
    const first = container.querySelector('.season-chip');
    if (first) first.click();
}

async function renderEpisodes(seasonNumber) {
    const container = document.getElementById('d-episodes');
    if (!container || !currentDetailItem) return;

    container.innerHTML = '<div class="loading" style="grid-column:1/-1">Loading episodes...</div>';

    const episodes = await window.getSeasonEpisodes(currentDetailItem.tmdbId, seasonNumber);
    container.innerHTML = '';

    episodes.forEach(ep => {
        const card = document.createElement('div');
        card.className = 'episode-card';

        const thumb = ep.still_path
            ? `<img src="${ep.still_path}" class="episode-thumb" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : "";

        card.innerHTML = `
            <div class="episode-thumb-wrap">
                ${thumb}
                <div class="episode-thumb" style="display:${ep.still_path ? 'none' : 'flex'};align-items:center;justify-content:center;background:var(--card-bg);font-size:24px;font-weight:800;color:var(--text-muted);">${ep.episode_number}</div>
                <div class="episode-number-badge">EP ${ep.episode_number}</div>
            </div>
            <div class="episode-info">
                <div class="episode-name">${ep.name}</div>
                <div class="episode-date">${ep.air_date || ''}</div>
            </div>
        `;

        card.onclick = () => {
            document.querySelectorAll('.episode-card').forEach(el => el.classList.remove('active'));
            card.classList.add('active');

            // Inject episode context into the item
            const episodeItem = {
                ...currentDetailItem,
                season: seasonNumber,
                episode: ep.episode_number,
                episodeTitle: ep.name
            };

            if (typeof loadSources === 'function') {
                loadSources(episodeItem);
            }
        };
        container.appendChild(card);
    });
}

function renderDetailUI(item) {
  // Reset Main Download Button
  const mainDlBtn = document.getElementById('main-download-btn');
  if (mainDlBtn) {
      const btnText = mainDlBtn.querySelector('.btn-text');
      if (btnText) btnText.textContent = 'Download';
      const progBar = mainDlBtn.querySelector('.btn-progress');
      if (progBar) progBar.remove();
  }

  const fill = document.getElementById('detail-bg-fill');
  const detailBg = fill.parentElement;

  // Backdrop image
  if (item.backdrop) {
    detailBg.style.backgroundImage = `url(${item.backdrop})`;
    detailBg.style.backgroundSize = 'cover';
    detailBg.style.backgroundPosition = 'center';
    fill.style.display = 'none';
  } else {
    detailBg.style.backgroundImage = 'none';
    fill.style.display = 'flex';
    fill.textContent = item.label || item.title || '';
    fill.className = 'detail-bg-fill ' + (item.g || 'g1');
  }

  document.getElementById('d-sub').textContent     = item.sub || '';
  document.getElementById('d-title').textContent   = item.label || item.title || 'Unknown';
  document.getElementById('d-duration').textContent= item.duration || '';
  document.getElementById('d-year').textContent    = item.year || '';
  document.getElementById('d-rating').textContent  = item.rating || '';
  document.getElementById('d-summary').textContent = item.summary || '';

  ['d-genres','d-cast','d-directors'].forEach(id => {
    const el = document.getElementById(id);
    const key = id.split('-')[1]; // genres, cast, directors
    const arr = item[key];
    el.innerHTML = Array.isArray(arr) ? arr.map(t => `<span class="tag">${t}</span>`).join('') : '';

    // Update label for TV Series
    if (id === 'd-directors') {
      const label = el.previousElementSibling;
      if (label && label.classList.contains('detail-label')) {
        label.textContent = item.sub === "TV SERIES" ? "CREATORS" : "DIRECTORS";
      }
    }
  });
}

function closeDetail() {
  document.getElementById('detail-page').classList.remove('open');
  document.body.style.overflow = '';
  currentDetailItem = null;
  if (typeof currentSeriesSeasons !== 'undefined') currentSeriesSeasons = null;
}
