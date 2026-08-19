async function loadPartial(id, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to load ' + url);
  const text = await res.text();

  const container = document.getElementById(id);
  if (!container) throw new Error('Missing container #' + id);

  container.innerHTML = text;

  // Execute any scripts included in the loaded HTML
  const scripts = Array.from(container.querySelectorAll('script'));
  for (const old of scripts) {
    const script = document.createElement('script');
    if (old.src) {
      script.src = old.src;
    } else {
      script.textContent = old.innerHTML;
    }
    document.head.appendChild(script);
    old.remove();
  }
}

async function loadAll() {
  try {
    await loadPartial('header', 'partials/header.html');
    await loadPartial('content', 'partials/content.html');
    await loadPartial('footer', 'partials/footer.html');
    document.dispatchEvent(new Event('partialsLoaded'));
  } catch (err) {
    console.error(err);
    document.getElementById('content').innerHTML = '<pre style="color:#f88;padding:20px">Error loading page parts. See console.</pre>';
  }
}

loadAll();
