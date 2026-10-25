/**
 * The Tabula app page: read a project folder, check its assets, set the
 * export (load groups, atlas pages, tiers) and produce it. There is no
 * preview here: play skeletons and exports in the Tabula Viewer
 * (packages/viewer). Talks to the server in src/cli/app/server.ts; on the
 * website, where there is none, to the same code in a worker (app/web/api.ts).
 */

import { globToRegExp } from 'tabula-pixi/core/manifest.js';
import type { AppProject } from '../src/cli/app/project.js';
import type { ExportEvent, ExportReport } from '../src/export/export-project.js';
import type { TabulaProjectConfig } from '../src/export/config.js';
import { initDrawers, showTool } from './drawers.js';
import { clearPreview, idleAnimation, resetPreview, showBundle, showSkeleton, type PreviewFiles } from './preview.js';
import { bindHoverTips } from './tips.js';
import { chooseItems, sizeLabel } from '../packages/ui/chooser.js';
import { addRecent, clearRecent, droppedHandles, grantRead, listRecent, pickFolder, readFolder, recentItems, recentSupported, removeRecent, renderRecentList, renderRecentMenu, type RecentListItem } from '../packages/ui/recent.js';
import { downloadExport, hasServer, openWebFolder, webFetch } from './web/api.js';

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

/** The website: no server, the project is a folder loaded into the page (no paths, no KTX2). Set by boot(). */
let web = false;
/** fetch for /api/: the server's, or on the website the in-page one. */
let api: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);

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

/** Tiers: downscaled copies as in Studio (0.75, 0.5, 0.25). 2× needs `<name>@2x` exports of every skeleton (set it in tabula.config.json); the button only shows while it is on. */
const TIER_CHOICES = [2, 1, 0.75, 0.5, 0.25];

let project: AppProject;
let selected: string | null = null;
const compress = new Set<string>();
let exporting = false;

// --- preview -------------------------------------------------------------------

/** Project and export files for the preview, through the API (server or web worker). */
const files: PreviewFiles = {
  async read(root, path) {
    const res = await api(`/api/file?root=${root}&path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `${path}: ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async list() {
    return await (await api('/api/files?root=out')).json() as string[];
  },
};

/** Fill the animation picker, keeping the current one when the new list has it. */
function fillAnimations(names: string[]): void {
  const anim = $('animation') as HTMLSelectElement;
  const previous = anim.value;
  anim.replaceChildren(...names.map((a) => h('option', { value: a, textContent: a })));
  anim.value = names.includes(previous) ? previous : idleAnimation(names) ?? '';
  anim.disabled = !names.length;
}

/** Tiers of the last export (1x when there is none). */
function renderTierSelect(): void {
  const tiers = (project.report as Report | null)?.tiers?.map((t) => t.tier) ?? [1];
  const sel = $('tier') as HTMLSelectElement;
  const previous = sel.value;
  sel.replaceChildren(...tiers.map((t) => h('option', { value: String(t), textContent: `${t}x` })));
  sel.value = tiers.map(String).includes(previous) ? previous : '1';
  sel.disabled = !project.exported || tiers.length < 2;
}

function showPreview(): void {
  const animation = ($('animation') as HTMLSelectElement).value || null;
  if (selected?.startsWith('bundle:')) {
    void showBundle(files, selected.slice('bundle:'.length), animation).then((names) => {
      if (names.length && !names.includes(($('animation') as HTMLSelectElement).value)) fillAnimations(names);
    });
    return;
  }
  const s = project.skeletons.find((k) => k.name === selected);
  if (!s) return clearPreview(project.skeletons.length ? 'Select a skeleton' : 'No skeletons in this folder');
  if (s.errors.length && !s.animations.length) return clearPreview('Cannot be shown: see the errors below');
  // A new export (its report date) is opened again; source-only until there is one.
  const exportKey = project.exported ? (project.report as Report | null)?.date ?? 'export' : null;
  void showSkeleton(files, s, animation, exportKey, Number(($('tier') as HTMLSelectElement).value) || 1, s.bytes);
}

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
  const choose = h('button', { textContent: 'choose…', title: 'Pick which of the folder\'s skeletons to show and export' });
  choose.onclick = () => void pickSkeletons().then(async (ok) => {
    if (ok) await refresh();
  });
  list.append(h('h2', {}, included ? `Skeletons (${project.skeletons.length} of ${allSkeletons.length})` : `Skeletons (${project.skeletons.length})`, h('span', { class: 'h2-actions' }, choose, all)));
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
  $('stage-title').textContent = selected?.startsWith('bundle:') ? selected.slice('bundle:'.length) : selected ?? 'Details';
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
  if (!name.startsWith('bundle:')) fillAnimations(project.skeletons.find((k) => k.name === name)?.animations ?? []);
  renderAssets();
  renderDetails();
  showPreview();
}

// --- produce -------------------------------------------------------------------

function config(): TabulaProjectConfig {
  return (project.config && !(project.config as { error?: string }).error ? project.config : {}) as TabulaProjectConfig;
}

async function saveConfig(next: TabulaProjectConfig): Promise<void> {
  const res = await api('/api/config', { method: 'PUT', body: JSON.stringify(next) });
  const body = await res.json() as TabulaProjectConfig & { error?: string };
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  project.config = body;
  status('Settings saved. Export to apply them.');
}

/** Group colors (stable by position). */
const GROUP_COLORS = ['#2f8f83', '#c2683a', '#6a5acd', '#b8487a', '#4a7fc1', '#8a8a2e', '#9b5a2a', '#3d8b4a'];
let assignFilter: string | null = null;

function renderGroups(): void {
  $('groups').replaceChildren(h('div', { class: 'settings-body' }, renderAssignments()));
}

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
      renderGroups();
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

/** Studio's export defaults (tabula-studio lib/editor/tabla-settings.ts TABLA_DEFAULTS), as config fields. */
const DEFAULTS: TabulaProjectConfig = { mode: 'release', format: 'tbla', images: true, tiers: [1], imageFormat: 'webp', quality: 90, ktx2: 'none', bake: { maxError: 0.05 }, atlas: { maxSize: 2048, padding: 2, extrude: 0 } };
/** The settings a preset carries (not the project's groups). */
const PRESET_KEY = 'tabula-exporter.preset';
/** Bake max error presets, named by what they trade (smaller drift = larger data); as in Studio. */
const MAX_ERRORS: [number, string][] = [[0, 'Lossless'], [0.01, 'Very fine'], [0.02, 'Fine'], [0.05, 'Balanced'], [0.1, 'Coarse'], [0.25, 'Smallest']];

/** Studio's export settings minus the project's groups (loadGroups, atlas.groups): what a preset holds. */
function presetOf(c: TabulaProjectConfig): TabulaProjectConfig {
  const { loadGroups: _groups, atlas, ...rest } = c;
  void _groups;
  return { ...rest, atlas: atlas && { maxSize: atlas.maxSize, padding: atlas.padding, extrude: atlas.extrude } };
}

/** Apply settings on top of the project's groups. */
function withPreset(c: TabulaProjectConfig, preset: TabulaProjectConfig): TabulaProjectConfig {
  return { ...preset, loadGroups: c.loadGroups, atlas: { ...preset.atlas, groups: c.atlas?.groups } };
}

function readPreset(): TabulaProjectConfig | null {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    return raw ? JSON.parse(raw) as TabulaProjectConfig : null;
  } catch {
    return null;
  }
}

/** A themed range with its value beside the label (Studio's Slider); saves on release. */
function slider(label: string, title: string, min: number, max: number, value: number, show: (v: number) => string, disabled: boolean, save: (v: number) => void): HTMLElement {
  const out = h('output', { textContent: show(value) });
  const input = h('input', { type: 'range', min: String(min), max: String(max), value: String(value), disabled, ariaLabel: label });
  const fill = (): void => input.style.setProperty('--pct', `${max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0}%`);
  fill();
  input.oninput = () => {
    out.textContent = show(Number(input.value));
    fill();
  };
  input.onchange = () => save(Number(input.value));
  return h('label', { class: 'slider', title }, h('span', { class: 'slider-head' }, h('span', { textContent: label }), out), input);
}

function picker<T extends string | number>(label: string, title: string, options: [T, string][], value: T, disabled: boolean, save: (v: T) => void): HTMLElement {
  const sel = h('select', { disabled, ariaLabel: label }, ...options.map(([v, text]) => h('option', { value: String(v), textContent: text })));
  sel.value = String(value);
  sel.onchange = () => save((typeof value === 'number' ? Number(sel.value) : sel.value) as T);
  return h('label', { class: 'pick', title }, h('span', { textContent: label }), sel);
}

function toggle(label: string, title: string, checked: boolean, save: (on: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked, role: 'switch', ariaLabel: label });
  input.onchange = () => save(input.checked);
  return h('div', { class: 'switch-row', title }, h('span', { textContent: label }), h('label', { class: 'switch' }, input, h('i')));
}

/** The export settings, laid out as Studio's export dialog: common choices up front, the rest under Advanced. */
function renderSettings(): void {
  const c = config();
  const set = (patch: Partial<TabulaProjectConfig>): void => void saveConfig({ ...c, ...patch }).then(renderSettings, showError);
  const atlas = { maxSize: 2048, padding: 2, extrude: 0, ...c.atlas };
  const setAtlas = (patch: Partial<typeof atlas>): void => set({ atlas: { ...c.atlas, ...patch } });
  const bake = c.bake === false ? null : c.bake ?? {};
  const setBake = (patch: { fps?: number; maxError?: number }): void => set({ bake: { ...bake, ...patch } });
  const tiers = c.tiers ?? [1];
  const maxSize = atlas.maxSize ?? 2048;
  const lossy = (c.imageFormat ?? 'auto') !== 'png' && c.imageFormat !== 'webp-lossless';
  const ktx2 = web ? 'none' : c.ktx2 ?? 'none';
  const etc1s = ktx2 === 'etc1s';
  const configError = (project.config as { error?: string } | null)?.error;

  const preset = readPreset();
  const tool = (text: string, title: string, run: () => void): HTMLButtonElement => {
    const b = h('button', { class: 'mini', type: 'button', textContent: text, title });
    b.onclick = run;
    return b;
  };
  const tools = h('div', { class: 'export-tools' },
    h('span', { textContent: 'Tabula settings' }),
    tool('Reset to default', "Studio's defaults; the load groups stay", () => void saveConfig(withPreset(c, DEFAULTS)).then(renderSettings, showError)),
    preset ? tool('Apply preset', 'The settings saved with Save preset (this browser)', () => void saveConfig(withPreset(c, preset)).then(renderSettings, showError)) : null,
    tool('Save preset', 'Remember these settings in this browser, for other projects', () => {
      try {
        localStorage.setItem(PRESET_KEY, JSON.stringify(presetOf(c)));
        status('Preset saved.');
      } catch {
        /* storage blocked */
      }
      renderSettings();
    }));

  const tierButton = (t: number): HTMLButtonElement => {
    const on = t === 1 || tiers.includes(t);
    const b = h('button', { type: 'button', class: 'tier', disabled: t === 1, title: t === 1 ? 'Full resolution, always exported.' : t > 1 ? `${on ? 'Remove' : 'Add'} a ${t}× tier (needs <name>@${t}x exports; never upscaled).` : `${on ? 'Remove' : 'Add'} a ${t}× copy of every page (up to ${Math.round(maxSize * t)} px).` },
      h('b', { textContent: `${t}×` }), h('small', { textContent: `${Math.round(maxSize * t)}px` }));
    b.setAttribute('aria-pressed', String(on));
    b.onclick = () => set({ tiers: (on ? tiers.filter((x) => x !== t) : [...tiers, t]).concat(1).filter((x, i, a) => a.indexOf(x) === i).sort((a, b) => b - a) });
    return b;
  };

  const groups = loadGroupNames();
  const first = c.loadGroups?.defaultGroup ?? 'base';
  // Unset means none: the engine preloads only what is listed.
  const preload = c.loadGroups?.preload ?? [];
  const groupRows = groups.length > 1 ? [
    h('h4', { textContent: 'Load groups', title: 'The first group loads before anything is shown. Groups with Preload ticked are fetched in the background right after it; the rest only when the game asks for them.' }),
    h('div', { class: 'group-list' }, ...groups.map((g) => {
      const count = project.skeletons.filter((k) => loadGroupsOf(k.name)[0] === g).length;
      let cell: HTMLElement;
      if (g === first) cell = h('span', { class: 'muted', textContent: 'Loads first', title: 'The default group: loaded first, before the game shows anything.' });
      else {
        const box = h('input', { type: 'checkbox', checked: preload.includes(g) });
        box.onchange = () => set({ loadGroups: { ...c.loadGroups, preload: box.checked ? [...preload, g] : preload.filter((n) => n !== g) } });
        cell = h('label', { title: `Fetch ${g} in the background right after the first group.` }, box, 'Preload');
      }
      return h('div', { class: 'group-row' }, h('span', { textContent: g }), h('span', { class: 'muted', textContent: `${count} skeleton${count === 1 ? '' : 's'}` }), cell);
    })),
  ] : [];

  const advanced = h('details', { class: 'advanced' }, h('summary', { textContent: 'Advanced' }), h('div', { class: 'advanced-body' },
    h('h4', { textContent: 'Bundles' }),
    h('div', { class: 'settings-row' },
      picker('Bundles', 'Release: one bundle per load group, skeletons share repacked pages (what a game ships). Development: one bundle per asset, so you can swap one asset at a time.', [['release', 'Release · per load group'], ['development', 'Development · per asset']], c.mode ?? 'release', false, (v) => set({ mode: v })),
      picker('Max page size', 'Largest atlas page side. Larger pages mean fewer draw calls but more GPU memory per page.', [[1024, '1024 px'], [2048, '2048 px'], [4096, '4096 px']], maxSize, false, (v) => setAtlas({ maxSize: v }))),
    h('div', { class: 'settings-row' },
      picker('Output', '.tbla bundles: a few files that stream in (ship this). Loose files: every file on its own with assets.manifest.json (inspect, debug).', [['tbla', '.tbla bundles'], ['files', 'Loose files']], c.format ?? 'tbla', false, (v) => set({ format: v })),
      toggle('Standalone images', 'PNG / WebP / JPG files not used by an atlas, sprite sheet or font, exported as textures', c.images !== false, (on) => set({ images: on }))),
    h('h4', { textContent: 'GPU compression' }),
    h('div', { class: 'settings-row' },
      picker('KTX2', web ? 'KTX2 encoding needs the desktop app.' : 'GPU-compressed pages (Basis Universal) beside the images: less GPU memory and faster uploads. UASTC keeps quality, ETC1S is smallest.', [['none', web ? 'None (desktop app)' : 'None'], ['uastc', 'UASTC · quality'], ['etc1s', 'ETC1S · size']], ktx2, web, (v) => set({ ktx2: v as TabulaProjectConfig['ktx2'] })),
      slider(etc1s ? 'ETC1S quality' : 'UASTC level', ktx2 === 'none' ? 'Pick UASTC or ETC1S to set encoder quality.' : etc1s ? 'ETC1S quality 1-255: higher is larger and better.' : 'UASTC level 0-4: higher encodes slower and looks better.', etc1s ? 1 : 0, etc1s ? 255 : 4, c.ktx2Quality ?? (etc1s ? 128 : 2), String, ktx2 === 'none', (v) => set({ ktx2Quality: v }))),
    h('h4', { textContent: 'Baking' }),
    h('div', { class: 'settings-row' },
      slider('FPS', "Samples per second for baked animations. Fully left is Auto: a rate from each animation's keys.", 0, 240, bake?.fps ?? 0, (v) => (v ? `${v} fps` : 'Auto'), !bake, (v) => setBake({ fps: v || undefined })),
      picker('Precision', 'How far a baked value may drift from the live animation. Lossless is exact but largest; Balanced suits most games.', MAX_ERRORS.some(([v]) => v === (bake?.maxError ?? 0.05)) ? MAX_ERRORS : [...MAX_ERRORS, [bake!.maxError!, `Custom (${bake!.maxError})`]], bake?.maxError ?? 0.05, !bake, (v) => setBake({ maxError: v }))),
    h('h4', { textContent: 'Packing' }),
    h('div', { class: 'settings-row' },
      slider('Padding', 'Empty pixels between packed regions, so filtering never bleeds a neighbour into an image.', 0, 16, atlas.padding ?? 2, (v) => `${v} px`, false, (v) => setAtlas({ padding: v })),
      slider('Extrude', 'Edge pixels repeated around each region. Helps against seams when images are scaled or sit edge to edge.', 0, 8, atlas.extrude ?? 0, (v) => `${v} px`, false, (v) => setAtlas({ extrude: v }))),
    ...groupRows));

  $('settings').replaceChildren(h('div', { class: 'settings-body export-settings' },
    configError ? h('div', { class: 'badge bad', textContent: configError }) : null,
    tools,
    h('div', { class: 'settings-row' },
      picker('Format', 'Image format of the repacked atlas pages. Auto uses WebP when most source pages are WebP, PNG otherwise.', [['auto', 'Auto (as sources)'], ['png', 'PNG'], ['webp', 'WebP'], ['webp-lossless', 'WebP lossless']], c.imageFormat ?? 'auto', false, (v) => set({ imageFormat: v === 'auto' ? undefined : v })),
      slider('WebP quality', lossy ? 'Lossy WebP quality, 1-100: higher is larger and sharper.' : 'Only used by lossy WebP pages (WebP, or Auto when it picks WebP).', 1, 100, c.quality ?? 90, String, !lossy, (v) => set({ quality: v }))),
    h('div', { class: 'tiers', role: 'group', title: 'Extra copies of every page for other devices; the game picks one tier at load. 1× is always exported.' },
      // 2× only for projects with @2x exports: without them every skeleton ships as raw JSON. Shown while it is on, to turn it off.
      h('span', { textContent: 'Tiers' }), ...TIER_CHOICES.filter((t) => t <= 1 || tiers.includes(t)).map(tierButton)),
    toggle('Bake animations', 'Pre-sample animations into compact baked data so the game skips most skeleton math at runtime. A skeleton that cannot be baked plays live.', !!bake, (on) => set({ bake: on ? {} : false })),
    advanced,
    h('span', { class: 'hint muted', textContent: web ? 'Kept while this page is open; the download includes tabula.config.json for the project folder.' : `Saved in ${project.dir}/tabula.config.json.` })));
  renderGroups();
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
    if (web) {
      const save = h('button', { class: 'primary', textContent: 'Download export (.zip)', title: 'tabula-export/ and tabula.config.json, to unzip into the project folder' });
      save.onclick = () => void downloadExport().then(({ name, blob }) => {
        const link = h('a', { href: URL.createObjectURL(blob), download: name });
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      }, showError);
      body.append(save);
    }
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
  showTool('right', 'report');
  status('Exporting… 0%', 'busy');
  try {
    const res = await api('/api/export', { method: 'POST', body: JSON.stringify({ compress: [...compress], skeletons: included ? [...included] : undefined }) });
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
          status(`Exporting… ${Math.floor(event.fraction * 100)}%`, 'busy');
        } else if (event.type === 'step') line(event.message);
        else if (event.type === 'warning') line(`${event.asset ? `${event.asset}: ` : ''}${event.message}`, 'warn');
        else if (event.type === 'fallback') line(`${event.asset}: exported as JSON (${event.reason})`, 'bad');
        else if (event.type === 'failed') throw new Error(event.error);
        else if (event.type === 'done') line(`Done in ${(event.report.ms / 1000).toFixed(1)} s`);
      }
    }
    status('Exported.');
  } catch (err) {
    line(`Export failed: ${(err as Error).message}`, 'bad');
    status('Export failed. See the export report.', 'error');
  } finally {
    clearInterval(clock);
    exporting = false;
    ($('export') as HTMLButtonElement).disabled = false;
    await refresh();
  }
}

/** The header's "More" menu, as the viewer's (packages/viewer/src/ui/bindUi.js bindActionMenu). */
function bindActionMenu(): void {
  const trigger = $('action-menu-trigger');
  const panel = $('action-menu-panel');
  const host = $('action-menu');
  const close = (): void => {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', String(willOpen));
    if (!willOpen) return;
    const rect = trigger.getBoundingClientRect();
    panel.style.top = `${Math.round(rect.bottom + 6)}px`;
    panel.style.left = `${Math.round(Math.max(8, rect.right - panel.offsetWidth))}px`;
  });
  panel.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button, a')) close();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && !(event.target instanceof Node && host.contains(event.target))) close();
  });
  $('btn-clear-saved').addEventListener('click', () => {
    if (!window.confirm('Forget the saved export preset and panel layout in this browser?')) return;
    for (const key of Object.keys(localStorage)) if (key.startsWith('tabula-exporter.')) localStorage.removeItem(key);
    status('Saved settings cleared. They reset on the next load.');
  });
}

let bannerTimer = 0;

/**
 * Status messages in the viewer's banner (packages/viewer/src/ui/bindUi.js showBanner), under the header.
 * Plain notes close by themselves; errors and work in progress stay until replaced or closed.
 */
function status(message: string, kind: 'note' | 'busy' | 'error' = 'note'): void {
  clearTimeout(bannerTimer);
  const banner = $('banner');
  banner.hidden = !message;
  banner.classList.toggle('is-error', kind === 'error');
  $('banner-text').textContent = message;
  if (message && kind === 'note') bannerTimer = window.setTimeout(() => { banner.hidden = true; }, 4000);
}

function showError(err: Error): void {
  status(err.message, 'error');
}

// --- open ----------------------------------------------------------------------

function showStart(recent: string[], error = ''): void {
  ($('start') as HTMLElement).hidden = false;
  (document.querySelector('main') as HTMLElement).hidden = true;
  $('export').hidden = true;
  $('pick').hidden = !desktop && !web;
  $('path-form').hidden = web;
  // index.html ships the web wording so the hosted page shows it on first paint.
  if (!web) $('start-intro').innerHTML = 'A folder with Spine JSON exports (with their .atlas and page images), sprite sheets and fonts. The export goes to <code>tabula-export</code> inside it.';
  $('drop-hint').textContent = desktop || web ? 'or drop a folder here (or onto the window, any time)' : 'In a browser, type the folder path below. The desktop app also opens a folder picker and takes dropped folders.';
  $('start-error').textContent = error;
  if (!web) serverRecent = recent;
  void renderRecent();
}

/** Recent projects: folder paths from the server (desktop, `tabula app`), or folder handles on the website. */
let serverRecent: string[] = [];

async function recentList(): Promise<RecentListItem[]> {
  if (web) return recentSupported ? recentItems(await listRecent('exporter')) : [];
  return serverRecent.map((dir) => ({ key: dir, kind: 'folder' as const, name: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir, detail: dir }));
}

/** Reload the recent projects (the server adds one on every open) and redraw them. */
async function refreshRecent(): Promise<void> {
  if (!web) serverRecent = (await (await api('/api/state')).json() as { recent: string[] }).recent;
  await renderRecent();
}

async function renderRecent(): Promise<void> {
  const items = await recentList();
  $('recent-block').hidden = !items.length;
  renderRecentList($('recent'), items, (key) => void openRecent(key), (key) => void forgetRecent(key));
  renderRecentMenu($('menu-recent'), items, (key) => void openRecent(key), () => void forgetRecent());
}

async function openRecent(key: string): Promise<void> {
  if (!web) return openProject(key);
  const entry = (await listRecent('exporter')).find((e) => e.id === key);
  const dir = entry?.handles[0] as FileSystemDirectoryHandle | undefined;
  if (!entry || !dir) return;
  if (!(await grantRead([dir]))) {
    status(`No access to ${entry.name}. Allow it, or open the folder again.`, 'error');
    return;
  }
  try {
    const files = await readFolder(dir, SKIP);
    await addRecent('exporter', 'folder', dir.name, [dir]);
    await openWebProject(dir.name, files);
  } catch {
    status(`${entry.name} is gone or was moved. Removed from recent.`, 'error');
    await removeRecent(entry.id);
    void renderRecent();
  }
}

/** Forget one recent project, or all of them without a key. */
async function forgetRecent(key?: string): Promise<void> {
  if (web) await (key ? removeRecent(key) : clearRecent('exporter'));
  else serverRecent = (await (await api('/api/recent/forget', { method: 'POST', body: JSON.stringify({ dir: key }) })).json() as { recent: string[] }).recent;
  await renderRecent();
}

/** Forget everything of the previous project (selection, what is checked for compression). */
function resetProject(): void {
  selected = null;
  included = null;
  askChooser = true;
  resetPreview();
  fillAnimations([]);
  compress.clear();
}

async function openProject(dir: string): Promise<void> {
  const res = await api('/api/open', { method: 'POST', body: JSON.stringify({ dir }) });
  const body = await res.json() as { project?: string; error?: string; select?: string | null };
  if (!res.ok) {
    const state = await (await api('/api/state')).json() as { recent: string[] };
    showStart(state.recent, body.error ?? res.statusText);
    return;
  }
  await showProject(body.select ? `bundle:${body.select}` : null);
}

async function showProject(select: string | null = null): Promise<void> {
  void refreshRecent();
  resetProject();
  selected = select;
  ($('start') as HTMLElement).hidden = true;
  (document.querySelector('main') as HTMLElement).hidden = false;
  $('export').hidden = false;
  await refresh();
}

/** Folder contents to skip on the website: hidden files, installed packages, the previous export. */
const SKIP = /(^|\/)(\.[^/]*|node_modules|tabula-export)(\/|$)/;

/** Website: load a picked or dropped folder (paths relative to it) and show it. */
async function openWebProject(name: string, files: [string, File][]): Promise<void> {
  status(`Reading ${name}…`, 'busy');
  try {
    await openWebFolder(name, files.filter(([path]) => !SKIP.test(path)));
  } catch (err) {
    showStart([], (err as Error).message);
    return;
  }
  status('');
  await showProject();
}

/** Website: the folder picker; Chromium's remembers the folder for Recent, others use <input webkitdirectory>. */
async function pickWebFolder(): Promise<void> {
  if (recentSupported) {
    const dir = await pickFolder();
    if (!dir) return;
    status(`Reading ${dir.name}…`, 'busy');
    const files = await readFolder(dir, SKIP);
    await addRecent('exporter', 'folder', dir.name, [dir]);
    void renderRecent();
    return openWebProject(dir.name, files);
  }
  const input = h('input', { type: 'file', multiple: true });
  input.webkitdirectory = true;
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    if (!files.length) return;
    const name = files[0]!.webkitRelativePath.split('/')[0]!;
    void openWebProject(name, files.map((f) => [f.webkitRelativePath.slice(name.length + 1), f]));
  };
  input.click();
}

/** Website: every file under a dropped folder, relative to it. */
async function readDropped(entry: FileSystemDirectoryEntry): Promise<[string, File][]> {
  const out: [string, File][] = [];
  const walk = async (dir: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    const reader = dir.createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (!batch.length) break;
      for (const e of batch) {
        const path = `${prefix}${e.name}`;
        if (SKIP.test(path)) continue;
        if (e.isDirectory) await walk(e as FileSystemDirectoryEntry, `${path}/`);
        else out.push([path, await new Promise<File>((ok, fail) => (e as FileSystemFileEntry).file(ok, fail))]);
      }
    }
  };
  await walk(entry, '');
  return out;
}

async function chooseFolder(): Promise<void> {
  if (web) return pickWebFolder();
  if (!desktop) {
    const state = await (await api('/api/state')).json() as { recent: string[] };
    showStart(state.recent);
    return;
  }
  const dir = await desktop.openFolder();
  if (dir) await openProject(dir);
}

async function boot(): Promise<void> {
  if (!desktop && !(await hasServer())) {
    web = true;
    api = webFetch;
  }
  const state = await (await api('/api/state')).json() as { project: string | null; recent: string[]; select: string | null };
  if (state.project) await showProject(state.select ? `bundle:${state.select}` : null);
  else showStart(state.recent);
}

// --- choose skeletons (large folders) ---------------------------------------------

/** Every skeleton in the folder; `project.skeletons` holds only the chosen ones. */
let allSkeletons: AppProject['skeletons'] = [];
/** Skeletons to show and export; null: all of them. */
let included: Set<string> | null = null;
/** Ask once after a project opens (when it has several skeletons). */
let askChooser = false;

/** The checklist of the folder's skeletons; false when cancelled. */
async function pickSkeletons(): Promise<boolean> {
  const names = await chooseItems({
    title: 'Choose skeletons',
    label: `${project.dir}: ${allSkeletons.length} skeletons. Only the ticked ones are shown and exported.`,
    items: allSkeletons.map((k) => ({ name: k.name, meta: `${k.json.includes('/') ? `${k.json.slice(0, k.json.lastIndexOf('/'))} · ` : ''}${sizeLabel(k.jsonBytes)}` })),
    picked: included ?? (allSkeletons.length <= 12 ? allSkeletons.map((k) => k.name) : []),
    action: 'Use selected',
  });
  if (!names) return false;
  included = names.length === allSkeletons.length ? null : new Set(names);
  return true;
}

async function refresh(): Promise<void> {
  const res = await api('/api/project');
  if (res.status === 409) return boot();
  project = await res.json() as AppProject;
  allSkeletons = project.skeletons;
  if (askChooser) {
    askChooser = false;
    if (allSkeletons.length > 1) await pickSkeletons();
  }
  if (included) project.skeletons = allSkeletons.filter((k) => included!.has(k.name));
  if (!compress.size) for (const s of project.skeletons) compress.add(s.name);
  $('project-path').textContent = project.dir;
  renderAssets();
  renderSettings();
  renderReport();
  renderTierSelect();
  if (selected && (project.skeletons.some((s) => s.name === selected) || project.bundles.some((b) => `bundle:${b.path}` === selected))) select(selected);
  else {
    renderDetails();
    showPreview();
  }
}

$('animation').onchange = () => showPreview();
$('tier').onchange = () => showPreview();
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
  if (web) {
    const handles = droppedHandles(e.dataTransfer);
    const entry = e.dataTransfer?.items[0]?.webkitGetAsEntry();
    if (!entry?.isDirectory) {
      status('Drop the project folder, not single files.', 'error');
      return;
    }
    void handles.then((list) => {
      const dir = list.find((h) => h.kind === 'directory');
      if (dir) void addRecent('exporter', 'folder', dir.name, [dir]).then(renderRecent);
    });
    void readDropped(entry as FileSystemDirectoryEntry).then((files) => openWebProject(entry.name, files), showError);
    return;
  }
  if (!desktop) {
    status('Dropping folders works in the desktop app; here, type the folder path.', 'error');
    void chooseFolder();
    return;
  }
  void openProject(desktop.pathForFile(file));
});
initDrawers();
$('banner-close').onclick = () => status('');
bindActionMenu();
// The start card is in the page from first paint; the desktop app may reopen a project instead.
if (desktop) ($('start') as HTMLElement).hidden = true;
bindHoverTips();
desktop?.onProjectOpened(() => void showProject());
void boot().catch(showError);
