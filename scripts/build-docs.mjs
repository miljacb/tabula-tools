// Renders the user-facing Markdown docs into packages/site/docs/ as static pages in the site's look,
// with a search index (docs/search.json), and refreshes the docs links on the homepage.
// Run by the site's dev script and by build-web; packages/site/docs/ is generated, not committed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'packages/site');
const out = join(site, 'docs');
// Netlify sets URL at build time; og:image needs an absolute address.
const siteUrl = (process.env.URL ?? '').replace(/\/$/, '');
// docs/runtime/ is a copy of tabula-pixi/docs/ (scripts/sync-runtime-docs.mjs).
const runtimeDir = 'docs/runtime/';

const runtime = (slug, path, group, extra) => ({ slug, file: `${runtimeDir}api/${path}`, group, ...extra });

// Order is the sidebar order; `group` heads each block. `home` puts a doc on the homepage, with `home` as its label.
export const docs = [
  runtime('runtime', 'index.md', 'Runtime', { title: 'Runtime overview', home: 'Guides and modules' }),
  runtime('runtime-getting-started', 'getting-started.md', 'Runtime', { home: 'Getting started' }),
  runtime('runtime-migration', 'migration-pixi-spine.md', 'Runtime', { home: 'Migrating from pixi-spine' }),
  runtime('runtime-troubleshooting', 'troubleshooting.md', 'Runtime'),
  runtime('runtime-core', 'core.md', 'Runtime guides'),
  runtime('runtime-pixi-v7', 'pixi-v7.md', 'Runtime guides'),
  runtime('runtime-pixi-v8', 'pixi-v8.md', 'Runtime guides'),
  runtime('runtime-textures', 'textures-ktx2.md', 'Runtime guides'),
  runtime('runtime-manifest', 'manifest.md', 'Runtime guides'),
  runtime('runtime-text', 'text.md', 'Runtime guides'),
  runtime('runtime-animation-state', 'animation-state.md', 'Runtime guides'),
  runtime('runtime-constraints', 'constraints.md', 'Runtime guides'),
  runtime('runtime-baking', 'baking.md', 'Runtime guides'),
  runtime('runtime-tbin', 'slb-format.md', 'Runtime guides'),
  runtime('runtime-hit-testing', 'hit-testing.md', 'Runtime guides'),
  runtime('runtime-cascade', 'recipes/cascade.md', 'Runtime guides', { title: 'Recipe: cascade symbols' }),
  runtime('runtime-api-v7', 'reference/pixi-v7.md', 'Runtime API reference', { title: 'Pixi v7 bridge', home: 'API reference' }),
  runtime('runtime-api-v8', 'reference/pixi-v8.md', 'Runtime API reference', { title: 'Pixi v8 bridge' }),
  runtime('runtime-api-core', 'reference/core.md', 'Runtime API reference', { title: 'Core' }),
  runtime('runtime-api-adapters', 'reference/adapters.md', 'Runtime API reference', { title: 'Adapters (JSON)' }),
  { slug: 'viewer', file: 'packages/viewer/README.md', group: 'Viewer', title: 'Viewer guide', home: 'Viewer guide' },
  { slug: 'performance', file: 'packages/viewer/docs/PERFORMANCE.md', group: 'Viewer', home: 'Performance panel' },
  { slug: 'asset-health', file: 'packages/viewer/docs/ASSET_HEALTH.md', group: 'Viewer', home: 'Asset health inspector' },
  { slug: 'app', file: 'docs/app.md', group: 'Exporter', home: 'Tabula app and export' },
  { slug: 'cli', file: 'docs/cli.md', group: 'Exporter', home: 'CLI reference' },
  { slug: 'export-format', file: 'docs/reference/export.md', group: 'Exporter', home: 'Export format' },
  { slug: 'embedding', file: 'docs/embedding.md', group: 'Exporter', home: 'Recreating the export in another app' },
];

// Homepage columns: the groups whose docs carry `home`, under these labels.
const homeColumns = { Runtime: 'Runtime / tabula-pixi', 'Runtime API reference': 'Runtime / tabula-pixi', Viewer: 'Viewer', Exporter: 'Exporter' };

const bySource = new Map(docs.map((d) => [d.file, d]));
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
const plain = (md) => md.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

for (const d of docs) {
  d.md = readFileSync(join(root, d.file), 'utf8');
  d.title ??= plain(d.md.match(/^#\s+(.+)$/m)?.[1] ?? d.slug);
  // First real paragraph: card text and meta description.
  const intro = d.md.replace(/^#.*$/m, '').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|```|\||[-*>] |Written for)/.test(p)) ?? '';
  d.intro = plain(intro);
}

// A relative link in `doc` → its rendered page, or null when the target is not on the site
// (source files, internal docs: both repos are private, so those links are dropped).
function resolveLink(doc, href) {
  const [path, hash] = href.split('#');
  const tail = hash ? `#${hash}` : '';
  const page = (file) => (bySource.has(file) ? `/docs/${bySource.get(file).slug}.html${tail}` : null);
  if (doc.file.startsWith(runtimeDir)) {
    // Resolve inside tabula-pixi, where these files were written.
    const target = posix.normalize(posix.join('docs', posix.dirname(doc.file.slice(runtimeDir.length)), path));
    if (target.startsWith('../tabula-tools/')) return page(target.slice('../tabula-tools/'.length));
    return target.startsWith('docs/') ? page(runtimeDir + target.slice(5)) : null;
  }
  return page(posix.normalize(posix.join(posix.dirname(doc.file), path)));
}

function render(doc) {
  const renderer = new marked.Renderer();
  const ids = new Map();
  const sections = [];
  renderer.heading = (text, level, raw) => {
    const base = slugify(raw) || 'section';
    const n = ids.get(base) ?? 0;
    ids.set(base, n + 1);
    const id = n ? `${base}-${n}` : base;
    sections.push({ id, heading: plain(raw), level });
    return `<h${level} id="${id}">${text}</h${level}>\n`;
  };
  renderer.image = (href, title, text) => {
    let src = href ?? '';
    if (!/^[a-z]+:/i.test(src)) {
      const file = join(root, posix.dirname(doc.file), src);
      if (existsSync(file)) {
        const name = posix.basename(src);
        copyFileSync(file, join(out, 'img', name));
        src = `/docs/img/${name}`;
      }
    }
    return `<img src="${esc(src)}" alt="${esc(text ?? '')}" loading="lazy"${title ? ` title="${esc(title)}"` : ''} />`;
  };
  renderer.link = (href, title, text) => {
    let url = href ?? '';
    if (!/^([a-z]+:|#)/i.test(url)) url = resolveLink(doc, url);
    if (!url) return text;
    const external = /^https?:/.test(url) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ''}${external}>${text}</a>`;
  };
  return { html: marked.parse(doc.md, { renderer, gfm: true }), sections };
}

// Search entries: one per heading, with the text under it until the next heading.
function searchEntries(doc, sections) {
  const entries = [];
  let i = -1;
  let text = [];
  const flush = () => {
    const s = sections[i];
    entries.push({ t: doc.title, h: s && s.level > 1 ? s.heading : '', u: `/docs/${doc.slug}.html${s && s.level > 1 ? `#${s.id}` : ''}`, x: clip(plain(text.join(' ')), 180) });
  };
  for (const token of marked.lexer(doc.md)) {
    if (token.type === 'heading') {
      if (i >= 0 || text.length) flush();
      i++;
      text = [];
    } else if (token.type === 'paragraph' || token.type === 'list' || token.type === 'blockquote') {
      text.push(token.raw);
    }
  }
  flush();
  return entries;
}

const arrowSe = '<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 5.5V12H5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/></svg>';
const arrowNe = '<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 12 12 4M5.5 4H12v6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/></svg>';

function sidebar(current) {
  let html = `<div class="doc-search" role="search">
      <input id="doc-search" type="search" placeholder="Search docs" aria-label="Search docs" autocomplete="off" spellcheck="false" />
      <kbd>/</kbd>
      <ol id="doc-search-results" hidden></ol>
    </div>
    <a class="doc-home" href="/docs/">All docs</a>`;
  let group = '';
  for (const d of docs) {
    if (d.group !== group) html += `${group ? '</ul>' : ''}<p class="eyebrow">${(group = d.group)}</p><ul>`;
    html += `<li><a href="/docs/${d.slug}.html"${d === current ? ' aria-current="page"' : ''}>${esc(d.title)}</a></li>`;
  }
  return html + '</ul>';
}

function page({ title, description, path, body, current }) {
  const fullTitle = `${title} · Tabula Tools`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(fullTitle)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="theme-color" content="#111112" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Tabula Tools" />
  <meta property="og:title" content="${esc(fullTitle)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${siteUrl}/og.png" />
  ${siteUrl ? `<meta property="og:url" content="${siteUrl}${path}" />\n  ` : ''}<meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600&family=Space+Grotesk:wght@400;500;600&display=swap" />
  <link rel="stylesheet" href="/docs.css" />
  <script type="module" src="/docs-search.js"></script>
</head>
<body>
  <header class="site-header">
    <a class="brand" href="/" aria-label="Tabula Tools home"><img src="/tools-logo.svg" alt="Tabula Tools" width="28" height="26" /></a>
    <nav aria-label="Main navigation">
      <a href="/#tools">Tools ${arrowSe}</a>
      <a href="/viewer/">Viewer ${arrowSe}</a>
      <a href="/exporter/">Exporter ${arrowSe}</a>
      <a href="/docs/"${current ? '' : ' aria-current="page"'}>Docs ${arrowSe}</a>
    </nav>
    <a class="button header-cta" href="https://tabula-studio.nsftx-0693.chatgpt.site/">Open Studio ${arrowNe}</a>
  </header>
  <div class="docs-layout">
    <aside class="docs-nav" aria-label="Docs">${sidebar(current)}</aside>
    <main class="doc" id="main">${body}</main>
  </div>
</body>
</html>
`;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'img'), { recursive: true });

const search = [];
for (const d of docs) {
  const { html, sections } = render(d);
  search.push(...searchEntries(d, sections));
  const body = `<p class="doc-source eyebrow">Docs / ${esc(d.group)}</p>${html}`;
  const description = clip(d.intro || `${d.title}: Tabula ${d.group.toLowerCase()} docs.`, 160);
  writeFileSync(join(out, `${d.slug}.html`), page({ title: d.title, description, path: `/docs/${d.slug}.html`, current: d, body }));
}
writeFileSync(join(out, 'search.json'), JSON.stringify(search));

const groups = [...new Set(docs.map((d) => d.group))];
const lede = 'Guides and references for the Tabula runtime (tabula-pixi) and the tools: the in-browser viewer, and the exporter app and CLI.';
const index = `<p class="doc-source eyebrow">Tabula / Docs</p><h1>Docs</h1>
<p class="lede">${lede}</p>
${groups.map((g) => `<h2>${g}</h2><div class="doc-cards">${docs.filter((d) => d.group === g).map((d) =>
  `<a class="doc-card" href="/docs/${d.slug}.html"><b>${esc(d.title)}</b><span>${esc(clip(d.intro, 150))}</span></a>`).join('')}</div>`).join('\n')}`;
writeFileSync(join(out, 'index.html'), page({ title: 'Docs', description: lede, path: '/docs/', body: index }));

// Homepage: rewrite the block between the docs-links markers from the `home` entries.
const homeFile = join(site, 'index.html');
const home = readFileSync(homeFile, 'utf8');
const columns = new Map();
for (const d of docs.filter((d) => d.home)) {
  const label = homeColumns[d.group] ?? d.group;
  if (!columns.has(label)) columns.set(label, []);
  columns.get(label).push(`          <a href="/docs/${d.slug}.html">${esc(d.home)} <svg class="arrow"><use href="#arrow-ne"/></svg></a>`);
}
const block = [...columns].map(([label, links]) => `        <div>\n          <p class="eyebrow">${esc(label)}</p>\n${links.join('\n')}\n        </div>`).join('\n');
const marked_ = /(<!-- docs-links:start[^>]*-->\n)[\s\S]*?(\n\s*<!-- docs-links:end -->)/;
if (!marked_.test(home)) throw new Error('packages/site/index.html: docs-links markers not found');
const nextHome = home.replace(marked_, `$1${block}$2`);
if (nextHome !== home) writeFileSync(homeFile, nextHome);

console.log(`docs: ${docs.length} pages, ${search.length} search entries -> ${relative(root, out)}`);
