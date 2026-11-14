// Download page: show the newest app version (green chip) and its size.
fetch('/api/v1/app/latest').then((r) => r.json()).then(({ android: a }) => {
  if (!a) return;
  const v = document.getElementById('apk-ver'); const b = document.getElementById('apk-btn');
  const when = a.publishedAt ? new Date(a.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  v.innerHTML = '';
  const chip = document.createElement('span'); chip.className = 'ver-chip ver-new'; chip.textContent = 'Latest version ' + a.version;
  v.append(chip, when ? ' updated ' + when : ''); v.hidden = false;
  if (a.sizeMb && b) b.textContent = 'Download the app (' + Math.round(a.sizeMb) + ' MB)';
}).catch(() => {});
