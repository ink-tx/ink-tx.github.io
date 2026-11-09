(() => {
  let theme = 'light';
  try { const saved = localStorage.getItem('ink-theme') || localStorage.getItem('theme'); if (saved === 'dark' || saved === 'light') theme = saved; } catch (_) {}
  document.documentElement.dataset.theme = theme;
})();
