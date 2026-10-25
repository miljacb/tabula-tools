// Docs search: loads /docs/search.json (built by scripts/build-docs.mjs) on first use and
// matches every typed word against page title, heading and text. "/" focuses the box.
const input = document.getElementById('doc-search');
const list = document.getElementById('doc-search-results');
let entries = null;
let active = -1;

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function load() {
  if (entries) return entries;
  const res = await fetch('/docs/search.json');
  entries = (await res.json()).map((e) => ({ ...e, hay: `${e.t} ${e.h} ${e.x}`.toLowerCase(), head: `${e.t} ${e.h}`.toLowerCase() }));
  return entries;
}

function mark(text, words) {
  let html = esc(text);
  for (const w of words) html = html.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  return html;
}

async function update() {
  const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return close();
  const all = await load();
  const hits = all
    .filter((e) => words.every((w) => e.hay.includes(w)))
    .map((e) => ({ e, score: words.reduce((n, w) => n + (e.head.includes(w) ? 3 : 1), 0) + (e.h ? 0 : 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  active = -1;
  list.innerHTML = hits.length
    ? hits.map(({ e }) => `<li><a href="${e.u}"><b>${mark(e.h || e.t, words)}</b>${e.h ? `<small>${esc(e.t)}</small>` : ''}${e.x ? `<span>${mark(e.x, words)}</span>` : ''}</a></li>`).join('')
    : '<li class="empty">No matches</li>';
  list.hidden = false;
}

function close() {
  list.hidden = true;
  active = -1;
}

function move(step) {
  const links = [...list.querySelectorAll('a')];
  if (!links.length) return;
  active = (active + step + links.length) % links.length;
  links.forEach((a, i) => a.classList.toggle('active', i === active));
  links[active].scrollIntoView({ block: 'nearest' });
}

input.addEventListener('focus', load, { once: true });
input.addEventListener('input', update);
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') { const a = list.querySelectorAll('a')[Math.max(active, 0)]; if (a) location.href = a.href; }
  else if (e.key === 'Escape') { input.value = ''; close(); input.blur(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    input.focus();
  }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.doc-search')) close(); });
