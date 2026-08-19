function showHome() {
  document.getElementById('home-view').style.display = 'block';
  document.getElementById('explore-view').style.display = 'none';
  document.getElementById('settings-view').style.display = 'none';
  document.querySelectorAll('.sidebar-icon').forEach(el => el.classList.remove('active'));
  document.getElementById('home-btn').classList.add('active');
}

function openExplore() {
  document.getElementById('home-view').style.display = 'none';
  document.getElementById('explore-view').style.display = 'block';
  document.getElementById('settings-view').style.display = 'none';
  document.querySelectorAll('.sidebar-icon').forEach(el => el.classList.remove('active'));
  document.getElementById('explore-btn').classList.add('active');
  const input = document.getElementById('explore-search-input');
  if (input) {
    input.focus();
    if (!input.value.trim()) {
      const grid = document.getElementById('explore-results-grid');
      if (grid) grid.innerHTML = '<div style="grid-column:1/-1; padding:10px 0; font-size:13px; color:var(--text-muted);">Search movies or TV series</div>';
    }
  }
}

window.showHome = showHome;
window.openExplore = openExplore;
