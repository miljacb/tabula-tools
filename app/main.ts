/**
 * The Tabula app page: read a project folder, check its assets, set the
 * export (load groups, atlas pages, tiers) and produce it. There is no
 * preview here: play skeletons and exports in the Tabula Viewer
 * (packages/viewer). Talks to the server in src/cli/app/server.ts.
 */

import { globToRegExp } from 'tabula-pixi/core/manifest.js';
import type { AppProject } from '../src/cli/app/server.js';
import type { ExportEvent, ExportReport } from '../src/export/export-project.js';
import type { TabulaProjectConfig } from '../src/export/config.js';

/** export-report.json (`downloads` is missing in reports of older exports). */
type Report = Omit<ExportReport, 'manifest' | 'downloads' | 'pages' | 'data'> & Partial<Pick<ExportReport, 'downloads' | 'pages' | 'data'>> & { date?: string };

/** What the desktop app's preload adds (desktop/preload.cjs); absent in a browser. */
interface DesktopBridge {
  /** System folder picker; null when cancelled. */
  openFolder(): Promise<string | null>;
  /** Path of a dropped file or folder. */
  pathForFile(file: File): string;
  /** The app menu opened a project. */
  onProjectOpened(callback: (dir: string) => void): void;
}
const desktop = (window as { tabula?: DesktopBridge }).tabula;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const c of children) if (c !== null) el.append(c);
  return el;
};
const kib = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const TIER_CHOICES = [2, 1, 0.75, 0.5];

let project: AppProject;
let selected: string | null = null;
const compress = new Set<string>();
let exporting = false;

// --- read ----------------------------------------------------------------------

function exportState(name: string): { cls: string; text: string; title: string } {
  const r = (project.report as Report | null)?.skeletons?.[name];
  if (!r) return { cls: 'raw', text: 'not exported', title: 'Not in the last export' };
  if (r.format === 'tbin') return { cls: 'ok', text: 'compressed', title: `Compressed in group "${r.group}"` };
  if (r.reason === 'not selected for compression') return { cls: 'raw', text: 'raw', title: 'Exported as JSON (not selected for compression)' };
  return { cls: 'bad', text: 'raw: failed', title: `Compression failed, exported as JSON: ${r.reason}` };
}

function renderAssets(): void {
  const list = $('assets');
  list.replaceChildren();
  const all = h('button', { textContent: compress.size === project.skeletons.length ? 'none' : 'all', title: 'Select all / none for compression' });
  all.onclick = () => {
    if (compress.size === project.skeletons.length) compress.clear();
    else for (const s of project.skeletons) compress.add(s.name);
    renderAssets();
  };
  list.append(h('h2', {}, `Skeletons (${project.skeletons.length})`, all));
  for (const s of project.skeletons) {
    const state = exportState(s.name);
    const check = h('input', { type: 'checkbox', checked: compress.has(s.name), title: 'Compress this skeleton on export (unchecked: exported as raw JSON)' });
    check.onclick = (e) => {
      e.stopPropagation();
      if (check.checked) compress.add(s.name);
      else compress.delete(s.name);
    };
    const issues = s.errors.length ? h('span', { class: 'badge bad', textContent: `${s.errors.length} error${s.errors.length > 1 ? 's' : ''}` })
      : s.warnings.length ? h('span', { class: 'badge warn', textContent: `${s.warnings.length} warning${s.warnings.length > 1 ? 's' : ''}` }) : null;
    const row = h('div', { class: `asset${s.name === selected ? ' selected' : ''}` },
      check, h('span', { class: 'name', textContent: s.name, title: s.json }), h('span', { class: `badge ${state.cls}`, textContent: state.text, title: state.title }),
      h('span', { class: 'meta' }, `${kib(s.bytes)} · ${s.animations.length} animations · Spine ${s.spineVersion || '?'} `, issues));
    row.onclick = () => select(s.name);
    list.append(row);
  }
  if (project.sprites.length) {
    list.append(h('h2', {}, `Sprite sheets (${project.sprites.length})`));
    const tiers = (project.report as Report | null)?.sprites ?? {};
    for (const path of project.sprites) {
      const name = path.slice(path.lastIndexOf('/') + 1, -'.json'.length);
      list.append(h('div', { class: 'asset' }, h('span', {}), h('span', { class: 'name', textContent: name, title: path }),
        h('span', { class: `badge ${tiers[name] ? 'ok' : 'raw'}`, textContent: tiers[name] ? tiers[name].map((t) => `${t}x`).join(' ') : 'not exported' })));
    }
  }
  if (project.fonts.length) {
    list.append(h('h2', {}, `Fonts (${project.fonts.length})`));
    for (const path of project.fonts) list.append(h('div', { class: 'asset' }, h('span', {}), h('span', { class: 'name', textContent: path })));
  }
  if (project.bundles.length) {
    list.append(h('h2', {}, `Bundles (${project.bundles.length})`));
    for (const b of project.bundles) {
      const row = h('div', { class: `asset${selected === `bundle:${b.path}` ? ' selected' : ''}`, title: b.path },
        h('span', {}), h('span', { class: 'name', textContent: b.path.slice(b.path.lastIndexOf('/') + 1) }),
        h('span', { class: `badge ${b.error ? 'bad' : 'ok'}`, textContent: b.error ? 'damaged' : '.tbla' }),
        h('span', { class: 'meta', textContent: b.error ?? `${kib(b.bytes)} · ${b.files.length} files · tier ${String(b.meta.tier ?? 1)}x` }));
      row.onclick = () => select(`bundle:${b.path}`);
      list.append(row);
    }
  }
  if (project.skel.length) {
    list.append(h('h2', {}, 'Not supported'));
    for (const path of project.skel) {
      list.append(h('div', { class: 'asset', title: 'Spine binary export: export the skeleton as JSON instead' }, h('span', {}), h('span', { class: 'name', textContent: path }), h('span', { class: 'badge bad', textContent: '.skel' })));
    }
  }
}

function renderDetails(): void {
  const d = $('details');
  const b = project.bundles.find((x) => `bundle:${x.path}` === selected);
  if (b) {
    const m = b.members;
    d.replaceChildren(
      h('div', {}, h('strong', { textContent: b.path }), ` · ${kib(b.bytes)} · ${Object.entries(b.meta).map(([k, v]) => `${k} ${String(v)}`).join(' · ')}`),
      m ? h('div', { textContent: Object.entries(m).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join(', ')}`).join(' · ') } as Partial<HTMLDivElement>) : h('div', { class: 'muted', textContent: b.error ?? 'No manifest inside: a release bundle, loaded through the export\'s assets.manifest.json.' }),
      h('div', { class: 'files', textContent: b.files.map((f) => `${kib(f.bytes).padStart(9)}  ${f.path}`).join('\n') }),
    );
    return;
  }
  const s = project.skeletons.find((k) => k.name === selected);
  if (!s) {
    d.replaceChildren(h('span', { class: 'muted', textContent: 'Select a skeleton to see its details.' }));
    return;
  }
  const r = (project.report as Report | null)?.skeletons?.[s.name];
  const exported = !r ? 'Not in the last export.'
    : r.format === 'tbin' ? `Compressed: ${kib(r.bytes)} (.tbin and .baked) instead of ${kib(r.sourceBytes)} JSON + atlas; pages shared in group "${r.group}".`
    : `Exported as raw JSON${r.reason ? `: ${r.reason}` : ''}.`;
  const groupSel = assignSelect(loadGroupNames(), loadGroupsOf(s.name)[0]!, 'group', (v) => assignGroup(s.name, v));
  d.replaceChildren(
    h('div', {}, h('strong', { textContent: s.name }), ` · ${s.json} · pages ${s.pages.join(', ') || 'none'} · skins ${s.skins.join(', ') || 'default'}`),
    h('div', { class: 'assign' },
      h('label', { title: 'A group loads together and shares atlas pages, so its skeletons draw in few draw calls' }, 'Group', groupSel)),
    h('div', { class: 'muted', textContent: exported }),
    h('ul', {}, ...s.errors.map((e) => h('li', { class: 'bad', textContent: e })), ...s.warnings.map((w) => h('li', { class: 'warn', textContent: w }))),
  );
}

// --- groups ---------------------------------------------------

/** Load groups of a member, as the manifest assigns them. */
function loadGroupsOf(name: string): string[] {
  const spec = config().loadGroups ?? {};
  const groups = spec.groups ?? {};
  const exact = Object.keys(groups).filter((g) => groups[g]!.includes(name));
  const matched = exact.length ? exact : Object.keys(groups).filter((g) => groups[g]!.some((p) => globToRegExp(p).test(name)));
  return matched.length ? matched : [spec.defaultGroup ?? 'base'];
}

function loadGroupNames(): string[] {
  const spec = config().loadGroups ?? {};
  return [...new Set([spec.defaultGroup ?? 'base', ...Object.keys(spec.groups ?? {})])];
}

function assignSelect(options: string[], value: string, what: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = h('select', {}, ...options.map((o) => h('option', { value: o, textContent: o })), h('option', { value: '+new', textContent: `New ${what}…` }));
  sel.value = value;
  sel.onchange = () => {
    if (sel.value !== '+new') return onChange(sel.value);
    // An inline name field (Electron has no window.prompt).
    const input = h('input', { type: 'text', placeholder: `new ${what}`, className: 'new-name', spellcheck: false });
    let finished = false;
    const done = (apply: boolean): void => {
      if (finished) return; // Enter, then the blur of the removed field
      finished = true;
      const v = input.value.trim();
      input.replaceWith(sel);
      if (!apply || !v) {
        sel.value = value;
        return;
      }
      if (!/^[\w-]+$/.test(v)) {
        sel.value = value;
        showError(new Error(`Use letters, digits, - and _ in a ${what} name`));
        return;
      }
      onChange(v);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
    };
    input.onblur = () => done(true);
    sel.replaceWith(input);
    input.focus();
  };
  return sel;
}

/**
 * Move a skeleton to a group: what the game loads together and what shares
 * atlas pages (batches). The atlas page sets mirror the load groups.
 */
function assignGroup(name: string, group: string): void {
  const c = config();
  const spec = c.loadGroups ?? {};
  const groups = Object.fromEntries(Object.entries(spec.groups ?? {}).map(([g, list]) => [g, list.filter((n) => n !== name)]));
  if (group !== (spec.defaultGroup ?? 'base') || Object.values(groups).some((l) => l.some((p) => globToRegExp(p).test(name)))) (groups[group] ??= []).push(name);
  const loadGroups = { ...spec, groups: Object.fromEntries(Object.entries(groups).filter(([, l]) => l.length)) };
  void saveConfig({ ...c, loadGroups, atlas: { ...c.atlas, groups: pageSetsFor(loadGroups, c.atlas?.groups ?? []) } }).then(afterAssign, showError);
}

/** One page set per named load group (keeping each set's other settings); the default group's skeletons share the rest ("misc"). */
function pageSetsFor(spec: NonNullable<TabulaProjectConfig['loadGroups']>, previous: NonNullable<NonNullable<TabulaProjectConfig['atlas']>['groups']>): NonNullable<NonNullable<TabulaProjectConfig['atlas']>['groups']> {
  return Object.entries(spec.groups ?? {})
    .filter(([g]) => g !== (spec.defaultGroup ?? 'base'))
    .map(([g, list]) => ({ ...previous.find((p) => p.name === g), name: g, skeletons: [...list] }));
}

function afterAssign(): void {
  renderDetails();
  renderSettings();
}

function select(name: string): void {
  selected = name;
  renderAssets();
  renderDetails();
}

// --- produce -------------------------------------------------------------------

function config(): TabulaProjectConfig {
  return (project.config && !(project.config as { error?: string }).error ? project.config : {}) as TabulaProjectConfig;
}

async function saveConfig(next: TabulaProjectConfig): Promise<void> {
  const res = await fetch('/api/config', { method: 'PUT', body: JSON.stringify(next) });
  const body = await res.json() as TabulaProjectConfig & { error?: string };
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  project.config = body;
  $('status').textContent = 'Settings saved. Export to apply them.';
}

/** Group colors (stable by position). */
const GROUP_COLORS = ['#2f8f83', '#c2683a', '#6a5acd', '#b8487a', '#4a7fc1', '#8a8a2e', '#9b5a2a', '#3d8b4a'];
let assignFilter: string | null = null;

/** Groups as one table: a row per skeleton with its group picker, chips above with counts (click one to show only its skeletons). */
function renderAssignments(): HTMLElement {
  const groups = loadGroupNames();
  const color = (name: string): string => GROUP_COLORS[Math.max(0, groups.indexOf(name)) % GROUP_COLORS.length]!;
  const groupOf = (name: string): string => loadGroupsOf(name)[0]!;
  const chips = h('div', { class: 'chips' }, ...groups.map((name) => {
    const count = project.skeletons.filter((k) => groupOf(k.name) === name).length;
    const active = assignFilter === name;
    const dot = h('span', { class: 'dot' });
    dot.style.background = color(name);
    const chip = h('button', { class: `chip${active ? ' active' : ''}`, title: active ? 'Show all' : `Show only ${name}` }, dot, `${name} `, h('span', { class: 'muted', textContent: String(count) }));
    chip.onclick = () => {
      assignFilter = active ? null : name;
      renderSettings();
    };
    return chip;
  }));
  const rows = project.skeletons
    .filter((k) => !assignFilter || groupOf(k.name) === assignFilter)
    .map((k) => {
      const group = groupOf(k.name);
      const sel = assignSelect(groups, group, 'group', (v) => assignGroup(k.name, v));
      sel.style.borderLeft = `4px solid ${color(group)}`;
      const name = h('td', { class: 'skel-name', textContent: k.name, title: k.name });
      name.onclick = () => select(k.name);
      return h('tr', { class: k.name === selected ? 'selected' : '' }, name, h('td', {}, sel));
    });
  return h('div', { class: 'field' },
    h('span', { textContent: 'Groups' }),
    h('span', { class: 'hint muted', textContent: 'A group loads together and shares atlas pages, so its skeletons batch into few draw calls.' }),
    chips,
    h('div', { class: 'assign-table' }, h('table', {},
      h('tr', {}, h('th', { textContent: 'Skeleton' }), h('th', { textContent: 'Group' })),
      ...rows)));
}

function renderSettings(): void {
  const c = config();
  const tiers = new Set(c.tiers ?? [1]);
  const tierBoxes = TIER_CHOICES.map((t) => {
    const box = h('input', { type: 'checkbox', checked: t === 1 || tiers.has(t), disabled: t === 1 });
    box.onchange = () => {
      const next = TIER_CHOICES.filter((x) => x === 1 || (x === t ? box.checked : tiers.has(x)));
      void saveConfig({ ...c, tiers: next }).then(renderSettings, showError);
    };
    return h('label', { title: t > 1 ? `Needs <name>@${t}x exports (never upscaled)` : t === 1 ? 'Always exported' : `Pages downscaled to ${t * 100}%` }, box, `${t}x`);
  });
  const codec = h('select', {}, ...['none', 'uastc', 'etc1s'].map((v) => h('option', { value: v, textContent: v === 'none' ? 'Off (PNG only)' : v === 'uastc' ? 'UASTC (quality)' : 'ETC1S (small)' })));
  codec.value = c.ktx2 ?? 'none';
  codec.onchange = () => void saveConfig({ ...c, ktx2: codec.value as TabulaProjectConfig['ktx2'] }).then(renderSettings, showError);
  const bake = h('input', { type: 'checkbox', checked: c.bake !== false });
  bake.onchange = () => void saveConfig({ ...c, bake: bake.checked ? {} : false }).then(renderSettings, showError);
  const configError = (project.config as { error?: string } | null)?.error;
  const choice = <K extends 'mode' | 'format'>(key: K, options: [NonNullable<TabulaProjectConfig[K]>, string][]): HTMLSelectElement => {
    const sel = h('select', {}, ...options.map(([v, label]) => h('option', { value: v, textContent: label })));
    sel.value = c[key] ?? options[0]![0];
    sel.onchange = () => void saveConfig({ ...c, [key]: sel.value }).then(renderSettings, showError);
    return sel;
  };
  const imagesBox = h('input', { type: 'checkbox', checked: c.images !== false });
  imagesBox.onchange = () => void saveConfig({ ...c, images: imagesBox.checked }).then(renderSettings, showError);
  const assignments = renderAssignments();
  $('settings').replaceChildren(
    h('h2', {}, 'Export settings'),
    h('div', { class: 'settings-body' },
      configError ? h('div', { class: 'badge bad', textContent: configError }) : null,
      h('div', { class: 'field' }, h('span', { textContent: 'Export' }),
        h('div', { class: 'inline-fields' },
          choice('mode', [['release', 'Release (bundled)'], ['development', 'Development (per asset)']]),
          choice('format', [['tbla', '.tbla bundles'], ['files', 'Loose files']])),
        h('span', { class: 'hint', textContent: (c.mode ?? 'release') === 'release'
          ? 'Release: one .tbla per load group and tier; skeletons of a page set share atlas pages (fewest draw calls).'
          : 'Development: one .tbla per asset and tier, each with its own pages: swap or send one asset at a time.' }),
        h('span', { class: 'hint muted', textContent: (c.format ?? 'tbla') === 'tbla'
          ? '.tbla bundles: everything packed into a few files that stream in. Few requests, one file per tier to upload. Use this to ship.'
          : 'Loose files: every skeleton, page and font as its own file, with assets.manifest.json. Easy to open and inspect; use this to debug.' })),
      h('div', { class: 'field' }, h('span', { textContent: 'Resolution tiers' }), h('div', { class: 'tiers' }, ...tierBoxes),
        h('span', { class: 'hint', textContent: 'Copies of the atlas pages at other resolutions. The game chooses one (default 1x): lower tiers save GPU memory on weak phones, 2x adds detail on desktop.' })),
      h('div', { class: 'field' }, h('span', { textContent: 'GPU texture compression (KTX2)' }), codec,
        h('span', { class: 'hint', textContent: 'Pages stay compressed in GPU memory: about 4x less than PNG. UASTC keeps quality; ETC1S makes small files but can band gradients. Devices without support load the PNG.' })),
      h('label', { title: 'Pre-sample animations into .baked files' }, bake, 'Bake animations'),
      h('span', { class: 'hint muted', textContent: 'Baked animations cost far less CPU per frame; tiny differences from the editor are measured and kept under 0.05 units.' }),
      h('label', { title: 'PNG / WebP / JPG files not used by an atlas, sprite sheet or font' }, imagesBox, 'Export standalone images'),
      assignments,
      h('span', { class: 'hint muted', textContent: `Saved in ${project.dir}/tabula.config.json.` }),
    ),
  );
}

function renderReport(log?: HTMLElement): void {
  const r = project.report as Report | null;
  const body = h('div', { class: 'report' });
  if (log) {
    body.append(log);
    $('report').replaceChildren(h('h2', {}, 'Exporting'), body);
    return;
  }
  if (!r) body.append(h('span', { class: 'muted', textContent: 'No export yet. Check the skeletons to compress and press Export.' }));
  else {
    const list = Object.values(r.skeletons);
    const compressed = list.filter((s) => s.format === 'tbin').length;
    const failed = Object.entries(r.skeletons).filter(([, s]) => s.format === 'json' && s.reason !== 'not selected for compression');
    body.append(h('div', { class: 'muted', textContent: `${r.date ? new Date(r.date).toLocaleString() : ''} · ${compressed}/${list.length} skeletons compressed · ${r.mode}, ${r.format === 'tbla' ? '.tbla bundles' : 'loose files'}` }));
    if (r.downloads) body.append(renderDownloads(r, r.downloads));
    else body.append(h('span', { class: 'muted', textContent: 'Export again to see what a device downloads (this report is from an older version).' }));
    body.append(h('div', { class: 'muted', textContent: `On disk: ${kib(r.outputBytes)} (every tier and page format) · source ${kib(r.sourceBytes)}` }));
    if (r.bundles?.length) {
      const kindLabel: Record<string, string> = { data: 'data', ktx2: 'KTX2 pages', images: 'image pages', asset: 'asset' };
      body.append(h('details', { class: 'bundles' },
        h('summary', { textContent: `${r.bundles.length} ${r.mode === 'development' ? 'development' : 'release'} bundles` }),
        h('div', { class: 'bundle-list' }, h('table', {}, ...r.bundles.map((b) => h('tr', {},
          h('td', { class: 'path', textContent: b.path, title: `${b.path}: ${b.files} files${b.language ? `, ${b.language}` : ''}` }),
          h('td', { class: 'muted', textContent: b.language ? `fonts ${b.language}` : kindLabel[b.kind] ?? '' }),
          h('td', { textContent: kib(b.bytes) })))))));
    }
    if (r.conflicts?.length) body.append(h('div', {}, h('strong', { textContent: 'Pages shared by load groups' }), h('ul', {}, ...r.conflicts.map((c) => h('li', { class: 'warn-line', textContent: c })))));
    if (failed.length) body.append(h('div', {}, h('strong', { textContent: 'Exported as JSON instead' }), h('ul', {}, ...failed.map(([n, s]) => h('li', { textContent: `${n}: ${s.reason}` })))));
    if (r.warnings.length) body.append(h('div', {}, h('strong', { textContent: 'Warnings' }), h('ul', {}, ...r.warnings.map((w) => h('li', { textContent: w })))));
  }
  $('report').replaceChildren(h('h2', {}, 'Last export'), body);
}

/**
 * What one device downloads per tier (every load group, measured on the export's files) and the GPU memory of
 * those pages, with and without KTX2 support.
 */
function renderDownloads(r: Report, d: NonNullable<Report['downloads']>): HTMLElement {
  const hasKtx2 = d.tiers.some((t) => t.ktx2 !== null);
  const gpu = new Map(r.tiers.map((t) => [t.tier, t]));
  const row = (label: string, ...values: string[]): HTMLElement => h('tr', {}, h('td', { textContent: label }), ...values.map((v) => h('td', { textContent: v })));
  const tiers = d.tiers.map((t) => {
    const g = gpu.get(t.tier);
    const vram = g?.vramBytes;
    const vramKtx2 = g?.ktx2VramBytes;
    const pct = (n: number | undefined, of: number | undefined): string => (n && of && n !== of ? ` (${Math.round((n / of) * 100)}%)` : '');
    return h('table', { class: 'tier' },
      h('tr', {}, h('th', { textContent: `Tier ${t.tier}x` }), ...(hasKtx2 ? [h('th', { textContent: 'KTX2 device' }), h('th', { textContent: 'Other device' })] : [h('th', { textContent: 'Device' })])),
      row('Download', ...(hasKtx2 ? [t.ktx2 === null ? '–' : kib(t.ktx2), kib(t.images)] : [kib(t.images)])),
      row('GPU memory', ...(hasKtx2 ? [vramKtx2 === undefined ? '–' : `${kib(vramKtx2)}${pct(vramKtx2, vram)}`, vram === undefined ? '–' : kib(vram)] : [vram === undefined ? '–' : kib(vram)])));
  });
  const languages = Object.entries(d.languages);
  const pages = r.pages ?? [];
  const sizes = new Map<string, number>();
  for (const p of pages) sizes.set(`${p.width}×${p.height}`, (sizes.get(`${p.width}×${p.height}`) ?? 0) + 1);
  const ktx2Pages = pages.filter((p) => p.ktx2).length;
  const skeletons = Object.values(r.skeletons);
  const compressed = skeletons.filter((s) => s.format === 'tbin').length;
  return h('div', { class: 'downloads' },
    h('strong', { textContent: 'One device, every load group' }),
    ...tiers,
    languages.length ? h('div', { class: 'muted small', textContent: `Download plus the fonts of its language: ${languages.map(([l, n]) => `${l} ${kib(n)}`).join(' · ')}` }) : null,
    hasKtx2 ? h('div', { class: 'note', textContent: 'Trade-off: a KTX2 device downloads more but its pages stay block-compressed on the GPU (about 4× less memory); other devices download less and decode pages to RGBA.' }) : null,
    h('table', { class: 'facts' },
      pages.length ? row('Pages', `${pages.length} at 1x: ${[...sizes].map(([s, n]) => `${n > 1 ? `${n} × ` : ''}${s}`).join(', ')}${hasKtx2 ? ` · ${ktx2Pages} with KTX2` : ''}`) : null,
      row('Skeletons', `${compressed}/${skeletons.length} compressed${r.data ? ` · ${r.data.baked} baked` : ''}`),
      r.data ? row('Skeleton data', `${kib(r.data.tabulaBytes + r.data.bakedBytes)} in memory while loaded (.tbin ${kib(r.data.tabulaBytes)}, .baked ${kib(r.data.bakedBytes)})`) : null,
      row('CPU', `${r.data?.baked ? 'Baked animations play without per-frame bone math. ' : ''}Live draw calls, CPU per frame and FPS: Show → Scene.`)),
    h('span', { class: 'hint muted', textContent: 'Download: measured on the files written (data plus one page format). GPU memory: every page of that tier loaded, transcoded KTX2 at 1 byte per pixel, images as RGBA (4 bytes per pixel), no mipmaps.' }));
}

async function runExport(): Promise<void> {
  if (exporting) return;
  exporting = true;
  ($('export') as HTMLButtonElement).disabled = true;
  const bar = h('progress', { max: 1, value: 0 });
  const percent = h('span', { class: 'big', textContent: '0%' });
  const elapsed = h('span', { class: 'muted' });
  const item = h('div', { class: 'progress-item', textContent: 'Starting…' });
  const lines = h('div', { class: 'log' });
  const panel = h('div', { class: 'progress-panel' }, h('div', { class: 'progress-head' }, percent, elapsed), bar, item, lines);
  const line = (text: string, cls = ''): void => {
    lines.append(h('div', { class: cls, textContent: text }));
    lines.scrollTop = lines.scrollHeight;
  };
  const t0 = performance.now();
  const clock = setInterval(() => {
    const s = Math.round((performance.now() - t0) / 1000);
    elapsed.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
  renderReport(panel);
  $('status').textContent = 'Exporting… 0%';
  try {
    const res = await fetch('/api/export', { method: 'POST', body: JSON.stringify({ compress: [...compress] }) });
    if (!res.ok || !res.body) throw new Error((await res.json() as { error?: string }).error ?? res.statusText);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, nl)) as ExportEvent | { type: 'done'; report: Report } | { type: 'failed'; error: string };
        buffer = buffer.slice(nl + 1);
        if (event.type === 'progress') {
          bar.value = event.fraction;
          percent.textContent = `${Math.floor(event.fraction * 100)}%`;
          item.textContent = event.total > 1 ? `${event.item} · ${Math.min(event.done + 1, event.total)} of ${event.total}` : event.item;
          $('status').textContent = `Exporting… ${Math.floor(event.fraction * 100)}%`;
        } else if (event.type === 'step') line(event.message);
        else if (event.type === 'warning') line(`${event.asset ? `${event.asset}: ` : ''}${event.message}`, 'warn');
        else if (event.type === 'fallback') line(`${event.asset}: exported as JSON (${event.reason})`, 'bad');
        else if (event.type === 'failed') throw new Error(event.error);
        else if (event.type === 'done') line(`Done in ${(event.report.ms / 1000).toFixed(1)} s`);
      }
    }
    $('status').textContent = 'Exported.';
  } catch (err) {
    line(`Export failed: ${(err as Error).message}`, 'bad');
    $('status').textContent = 'Export failed.';
  } finally {
    clearInterval(clock);
    exporting = false;
    ($('export') as HTMLButtonElement).disabled = false;
    await refresh();
  }
}

function showError(err: Error): void {
  $('status').textContent = err.message;
}

// --- open ----------------------------------------------------------------------

function showStart(recent: string[], error = ''): void {
  ($('start') as HTMLElement).hidden = false;
  (document.querySelector('main') as HTMLElement).hidden = true;
  $('export').hidden = true;
  $('pick').hidden = !desktop;
  $('drop-hint').textContent = desktop ? 'or drop a folder here (or onto the window, any time)' : 'In a browser, type the folder path below. The desktop app also opens a folder picker and takes dropped folders.';
  $('start-error').textContent = error;
  $('recent').replaceChildren(...(recent.length ? recent.map((dir) => {
    const b = h('button', { textContent: dir, title: dir });
    b.onclick = () => void openProject(dir);
    return h('li', {}, b);
  }) : [h('li', { class: 'muted', textContent: 'No recent projects' })]));
}

/** Forget everything of the previous project (selection, what is checked for compression). */
function resetProject(): void {
  selected = null;
  compress.clear();
}

async function openProject(dir: string): Promise<void> {
  const res = await fetch('/api/open', { method: 'POST', body: JSON.stringify({ dir }) });
  const body = await res.json() as { project?: string; error?: string; select?: string | null };
  if (!res.ok) {
    const state = await (await fetch('/api/state')).json() as { recent: string[] };
    showStart(state.recent, body.error ?? res.statusText);
    return;
  }
  await showProject(body.select ? `bundle:${body.select}` : null);
}

async function showProject(select: string | null = null): Promise<void> {
  resetProject();
  selected = select;
  ($('start') as HTMLElement).hidden = true;
  (document.querySelector('main') as HTMLElement).hidden = false;
  $('export').hidden = false;
  await refresh();
}

async function chooseFolder(): Promise<void> {
  if (!desktop) {
    const state = await (await fetch('/api/state')).json() as { recent: string[] };
    showStart(state.recent);
    return;
  }
  const dir = await desktop.openFolder();
  if (dir) await openProject(dir);
}

async function boot(): Promise<void> {
  const state = await (await fetch('/api/state')).json() as { project: string | null; recent: string[]; select: string | null };
  if (state.project) await showProject(state.select ? `bundle:${state.select}` : null);
  else showStart(state.recent);
}

async function refresh(): Promise<void> {
  const res = await fetch('/api/project');
  if (res.status === 409) return boot();
  project = await res.json() as AppProject;
  if (!compress.size) for (const s of project.skeletons) compress.add(s.name);
  $('project-path').textContent = project.dir;
  renderAssets();
  renderSettings();
  renderReport();
  if (selected && (project.skeletons.some((s) => s.name === selected) || project.bundles.some((b) => `bundle:${b.path}` === selected))) select(selected);
  else renderDetails();
}

$('export').onclick = () => void runExport();
$('open').onclick = () => void chooseFolder();
$('pick').onclick = () => void chooseFolder();
$('path-form').onsubmit = (e) => {
  e.preventDefault();
  const dir = ($('path-input') as HTMLInputElement).value.trim();
  if (dir) void openProject(dir);
};
// A folder dropped anywhere on the window opens it (desktop: real paths only exist there).
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  if (!desktop) {
    $('status').textContent = 'Dropping folders works in the desktop app; here, type the folder path.';
    void chooseFolder();
    return;
  }
  void openProject(desktop.pathForFile(file));
});
desktop?.onProjectOpened(() => void showProject());
void boot().catch(showError);
