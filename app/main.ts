/**
 * The Tabula app page: read a project folder, play its assets (source and
 * exported side by side, at any tier, with or without KTX2), and produce an
 * export. Talks to the server in src/cli/app/server.ts.
 */

import { Application, Rectangle, Sprite, UPDATE_PRIORITY } from 'pixi.js';
import { globToRegExp } from 'tabula-pixi/core/manifest.js';
import { TabulaAssetManager, createTabulaRuntime, registerTabulaRenderer, unloadTabulaAsset } from 'tabula-pixi';
import type { ClipView, TabulaAsset, TabulaRuntime } from 'tabula-pixi';
import { loadTabulaJson, spineJson } from 'tabula-pixi/json';
import type { AppBundle, AppProject, AppSkeleton } from '../src/cli/app/server.js';
import type { ExportEvent, ExportReport } from '../src/export/export-project.js';
import type { TabulaProjectConfig } from '../src/export/config.js';

type Report = Omit<ExportReport, 'manifest'> & { date?: string };

/** What the desktop app's preload adds (desktop/preload.cjs); absent in a browser. */
interface DesktopBridge {
  /** System folder picker; null when cancelled. */
  openFolder(): Promise<string | null>;
  /** Path of a dropped file or folder. */
  pathForFile(file: File): string;
  /** The app menu opened a project. */
  onProjectOpened(callback: (dir: string) => void): void;
  /** CPU throttling of the page (1 = off). */
  setCpuThrottle?(rate: number): Promise<void>;
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

// --- preview -------------------------------------------------------------------

registerTabulaRenderer();
const app = new Application({ resizeTo: $('stage'), backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: devicePixelRatio });
$('stage').prepend(app.view as HTMLCanvasElement);
const runtime: TabulaRuntime = createTabulaRuntime(app);
let views: ClipView[] = [];
let sourceAsset: { name: string; asset: TabulaAsset } | null = null;
let manager: { key: string; promise: Promise<TabulaAssetManager> } | null = null;
let previewToken = 0;

function exportedManager(): Promise<TabulaAssetManager> {
  const tier = Number(($('tier') as HTMLSelectElement).value || 1);
  const ktx2 = ($('ktx2') as HTMLInputElement).checked;
  const key = `${tier}|${ktx2}|${(project.report as Report | null)?.date ?? ''}`;
  if (manager?.key !== key) {
    const old = manager;
    manager = {
      key,
      promise: TabulaAssetManager.load('/files/out/assets.manifest.json', {
        renderer: app.renderer, transcoder: ktx2 ? '/basis/' : undefined, ktx2, tier, json: spineJson, cacheBust: true,
      }),
    };
    void old?.promise.then((m) => m.destroy(), () => undefined);
  }
  return manager.promise;
}

async function loadExported(name: string): Promise<{ asset: TabulaAsset; label: string } | null> {
  if (!project.exported) return null;
  const m = await exportedManager();
  const entry = m.manifest.skeletons[name];
  if (!entry) return null;
  const group = Object.keys(m.manifest.groups).find((g) => m.manifest.groups[g]!.skeletons.includes(name))!;
  await m.loadGroup(group);
  const pages = m.loadedPages().filter((p) => entry.pages.includes(p.name));
  const gpu = pages.reduce((n, p) => n + p.gpuBytes, 0);
  const label = `Exported · ${entry.format === 'json' ? 'raw JSON' : `compressed${entry.baked ? ', baked' : ''}`} · tier ${m.tier}x · ${pages.map((p) => p.format).join('/') || 'no pages'} · ${kib(gpu)} GPU`;
  return { asset: m.getAsset(name), label };
}

async function loadSource(s: AppSkeleton): Promise<TabulaAsset> {
  if (sourceAsset?.name === s.name) return sourceAsset.asset;
  if (sourceAsset) unloadTabulaAsset(sourceAsset.asset);
  const asset = await loadTabulaJson(`/files/src/${s.json}`);
  sourceAsset = { name: s.name, asset };
  return asset;
}

// --- scene and performance ------------------------------------------------------

/** Frame CPU time: from the first ticker listener to after Pixi's render. */
let frameStart = 0;
let frameMs = 0;
let frames = 0;
app.ticker.add(() => {
  frameStart = performance.now();
}, null, UPDATE_PRIORITY.INTERACTION);
app.ticker.add(() => {
  frameMs += performance.now() - frameStart;
  frames++;
}, null, UPDATE_PRIORITY.UTILITY);

let sceneInfo: { gpuBytes: () => number; pages: () => number } | null = null;
const sceneSources = new Map<string, TabulaAsset>();
let statsTimer: ReturnType<typeof setInterval> | null = null;

function idleAnimation(names: string[]): string | null {
  return names.find((a) => /idle/i.test(a)) ?? names[0] ?? null;
}

async function showScene(s: AppSkeleton, token: number): Promise<void> {
  const set = pageSetOf(s.name);
  const members = project.skeletons.filter((k) => pageSetOf(k.name) === set && k.animations.length && !k.errors.length);
  if (!members.some((m) => m.name === s.name)) members.unshift(s);
  const count = Number(($('scene-count') as HTMLSelectElement).value);
  const assets: { name: string; asset: TabulaAsset }[] = [];
  let label: string;
  const exported = project.exported ? await exportedManager() : null;
  if (exported && members.every((m) => exported.manifest.skeletons[m.name])) {
    const groups = [...new Set(members.flatMap((m) => Object.keys(exported.manifest.groups).filter((g) => exported.manifest.groups[g]!.skeletons.includes(m.name))))];
    await Promise.all(groups.map((g) => exported.loadGroup(g)));
    for (const m of members) assets.push({ name: m.name, asset: exported.getAsset(m.name) });
    sceneInfo = { gpuBytes: () => exported.gpuBytes, pages: () => exported.loadedPages().length };
    label = `Scene · exported · page set "${set}" · tier ${exported.tier}x · groups ${groups.join(', ')}`;
  } else {
    for (const m of members) {
      let asset = sceneSources.get(m.name);
      if (!asset) {
        asset = await loadTabulaJson(`/files/src/${m.json}`);
        sceneSources.set(m.name, asset);
      }
      assets.push({ name: m.name, asset });
    }
    const textures = (): Set<{ realWidth: number; realHeight: number }> => new Set(assets.flatMap((a) => [...a.asset.textures.values()]) as unknown as { realWidth: number; realHeight: number }[]);
    sceneInfo = { gpuBytes: () => [...textures()].reduce((n, t) => n + t.realWidth * t.realHeight * 4, 0), pages: () => textures().size };
    label = `Scene · source JSON${project.exported ? ' (export it to measure the exported build)' : ''} · page set "${set}"`;
  }
  if (token !== previewToken) return;
  const cols = Math.max(1, Math.round(Math.sqrt(count * (app.screen.width / app.screen.height))));
  const rows = Math.ceil(count / cols);
  const cw = app.screen.width / cols;
  const ch = (app.screen.height - 30) / rows;
  const bounds = new Map<string, Rectangle>();
  for (let i = 0; i < count; i++) {
    const { name, asset } = assets[i % assets.length]!;
    const view = runtime.createView(asset);
    const anim = idleAnimation(asset.data.animations.map((a) => a.name));
    if (!bounds.has(name)) bounds.set(name, poseBounds(view, anim));
    app.stage.addChild(view);
    fit(view, bounds.get(name)!, cw * (i % cols) + cw / 2, 30 + ch * Math.floor(i / cols) + ch / 2, cw * 0.9, ch * 0.9);
    if (anim) view.play(anim, { loop: true, speed: 0.8 + ((i * 37) % 40) / 100 });
    views.push(view);
  }
  $('label-left').textContent = label;
  $('label-right').textContent = `${count} views of ${assets.length} skeletons`;
  startStats();
}

function startStats(): void {
  stopStats();
  frameMs = 0;
  frames = 0;
  ($('stats') as HTMLElement).hidden = false;
  const tick = (): void => {
    const st = runtime.stats;
    const cpu = frames ? frameMs / frames : 0;
    frameMs = 0;
    frames = 0;
    const gpu = (sceneInfo?.gpuBytes() ?? 0) / 1048576;
    const row = (label: string, value: string): HTMLElement => h('div', { class: 'row' }, h('span', { textContent: label }), h('span', { textContent: value }));
    const breaks = Object.entries(st.batchBreaks).filter(([, n]) => n > 0).map(([why, n]) => `${n} × ${why}`).join('\n');
    $('stats').replaceChildren(
      row('Draw calls', String(st.drawCalls)),
      row('GPU memory', `${gpu.toFixed(1)} MB`),
      row('CPU / frame', `${cpu.toFixed(2)} ms`),
      row('Pages loaded', String(sceneInfo?.pages() ?? 0)),
      row('Triangles', String(st.triangles)),
      row('FPS', app.ticker.FPS.toFixed(0)),
      h('div', { class: 'breaks', textContent: breaks ? `Extra batches:\n${breaks}` : 'No batch breaks' }),
    );
  };
  statsTimer = setInterval(tick, 300);
}

function stopStats(): void {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  ($('stats') as HTMLElement).hidden = true;
}

/** Preview a `.tbla` from the project: its own manifest, its first skeleton (or image). */
async function showBundle(b: AppBundle, token: number): Promise<void> {
  if (b.error || !b.members) {
    $('stage-empty').textContent = b.error ?? 'This bundle has no manifest inside (a release bundle): open the export instead';
    return;
  }
  const m = await TabulaAssetManager.load(`/files/src/${b.path}`, { renderer: app.renderer, transcoder: '/basis/', json: spineJson });
  await m.loadGroup('base');
  if (token !== previewToken) return m.destroy();
  bundleManager?.destroy();
  bundleManager = m;
  const name = b.members.skeletons[0];
  if (name) {
    const view = runtime.createView(m.getAsset(name));
    const anim = ($('animation') as HTMLSelectElement).value || idleAnimation(m.getAsset(name).data.animations.map((a) => a.name));
    app.stage.addChild(view);
    fit(view, poseBounds(view, anim), app.screen.width / 2, app.screen.height / 2 + 10, app.screen.width * 0.86, app.screen.height * 0.8);
    if (anim) view.play(anim, { loop: true });
    views.push(view);
  } else if (b.members.images[0]) {
    const sprite = new Sprite(m.getTexture(b.members.images[0]));
    sprite.anchor.set(0.5);
    sprite.position.set(app.screen.width / 2, app.screen.height / 2);
    sprite.scale.set(Math.min(1, (app.screen.width * 0.8) / sprite.width, (app.screen.height * 0.8) / sprite.height));
    app.stage.addChild(sprite);
    extraDisplay.push(sprite);
  }
  $('label-left').textContent = `${b.path} · tier ${String(b.meta.tier ?? 1)}x · ${kib(b.bytes)} · ${m.loadedPages().map((p) => p.format).join('/')} · ${kib(m.gpuBytes)} GPU`;
}

let bundleManager: TabulaAssetManager | null = null;
const extraDisplay: Sprite[] = [];

async function showPreview(): Promise<void> {
  const token = ++previewToken;
  app.resize(); // the stage may have changed size with the panels around it
  for (const v of views) v.destroy();
  views = [];
  for (const d of extraDisplay.splice(0)) d.destroy();
  stopStats();
  $('label-left').textContent = '';
  $('label-right').textContent = '';
  const mode = ($('mode') as HTMLSelectElement).value;
  document.body.classList.toggle('scene', mode === 'scene');
  if (selected?.startsWith('bundle:')) {
    const b = project.bundles.find((x) => `bundle:${x.path}` === selected);
    $('stage-empty').textContent = '';
    if (b) await showBundle(b, token).catch((err: Error) => ($('stage-empty').textContent = `Could not load: ${err.message}`));
    return;
  }
  const s = project.skeletons.find((k) => k.name === selected);
  $('stage-empty').textContent = s ? (s.errors.length && !s.animations.length ? 'Cannot be shown: see the errors below' : '') : 'Select a skeleton';
  if (!s || (s.errors.length && !s.animations.length)) return;
  if (mode === 'scene') {
    await showScene(s, token).catch((err: Error) => ($('stage-empty').textContent = `Could not load: ${err.message}`));
    return;
  }
  const animation = ($('animation') as HTMLSelectElement).value || null;
  const slots: { asset: TabulaAsset; label: string }[] = [];
  try {
    if (mode !== 'exported') slots.push({ asset: await loadSource(s), label: `Source · Spine ${s.spineVersion} JSON · ${kib(s.bytes)}` });
    if (mode !== 'source') {
      const exported = await loadExported(s.name);
      if (exported) slots.push(exported);
      else if (mode === 'exported') $('stage-empty').textContent = project.exported ? 'Not in the export' : 'Not exported yet';
    }
  } catch (err) {
    $('stage-empty').textContent = `Could not load: ${(err as Error).message}`;
    return;
  }
  if (token !== previewToken) return;
  const width = app.screen.width / slots.length;
  slots.forEach((slot, i) => {
    const view = runtime.createView(slot.asset);
    app.stage.addChild(view);
    fit(view, poseBounds(view, animation), width * i + width / 2, app.screen.height / 2 + 10, width * 0.86, app.screen.height * 0.8);
    if (animation) view.play(animation, { loop: true });
    views.push(view);
    $(i === 0 ? 'label-left' : 'label-right').textContent = slot.label;
  });
}

/** Rendered bounds across the animation (header bounds are often wrong in exports); leaves the clip stopped. */
function poseBounds(view: ClipView, animation: string | null): Rectangle {
  const union = new Rectangle();
  const sample = new Rectangle();
  let empty = true;
  const add = (): void => {
    view.getPoseBounds(sample);
    if (sample.width <= 0 && sample.height <= 0) return;
    if (empty) union.copyFrom(sample);
    else union.enlarge(sample);
    empty = false;
  };
  const clip = view.clip;
  if (animation && clip.hasAnimation(animation)) {
    clip.play(animation);
    for (let i = 0; i < 9; i++) {
      clip.seek((clip.duration * i) / 8);
      add();
    }
  }
  clip.stop();
  if (empty) add();
  return empty ? new Rectangle(-100, -100, 200, 200) : union;
}

function fit(view: ClipView, b: Rectangle, x: number, y: number, w: number, hgt: number): void {
  const scale = Math.min(w / b.width, hgt / b.height, 4);
  view.scale.set(scale);
  view.position.set(x - (b.x + b.width / 2) * scale, y - (b.y + b.height / 2) * scale);
}

// --- read ----------------------------------------------------------------------

function exportState(name: string): { cls: string; text: string; title: string } {
  const r = (project.report as Report | null)?.skeletons?.[name];
  if (!r) return { cls: 'raw', text: 'not exported', title: 'Not in the last export' };
  if (r.format === 'tabula') return { cls: 'ok', text: 'compressed', title: `Compressed in group "${r.group}"` };
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
    : r.format === 'tabula' ? `Compressed: ${kib(r.bytes)} (.tabula and .baked) instead of ${kib(r.sourceBytes)} JSON + atlas; pages shared in group "${r.group}".`
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

/** Page set of a skeleton, as a release export assigns it (exact name, then patterns; else "misc", or "atlas" without sets). */
function pageSetOf(name: string): string {
  const groups = config().atlas?.groups ?? [];
  if (!groups.length) return 'atlas';
  return (groups.find((g) => g.skeletons.includes(name)) ?? groups.find((g) => g.skeletons.some((p) => globToRegExp(p).test(name))))?.name ?? 'misc';
}

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
  if (($('mode') as HTMLSelectElement).value === 'scene') void showPreview();
}

function select(name: string): void {
  selected = name;
  const s = project.skeletons.find((k) => k.name === name);
  const anim = $('animation') as HTMLSelectElement;
  const previous = anim.value;
  const names = s?.animations ?? [];
  anim.replaceChildren(...names.map((a) => h('option', { value: a, textContent: a })));
  if (names.includes(previous)) anim.value = previous;
  else anim.value = idleAnimation(names) ?? '';
  renderAssets();
  renderDetails();
  void showPreview();
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
    const compressed = list.filter((s) => s.format === 'tabula').length;
    const failed = Object.entries(r.skeletons).filter(([, s]) => s.format === 'json' && s.reason !== 'not selected for compression');
    const tier1 = r.tiers.find((t) => t.tier === 1);
    // One device downloads one tier and one copy of each page (KTX2 when it can use it, the image otherwise).
    const bundled = (tier: number): number | null => r.bundles?.length ? r.bundles.filter((b) => b.tier === tier).reduce((n, b) => n + b.bytes, 0) : null;
    const device = (t: Report['tiers'][number]): { ktx2: number; image: number } | null => {
      const total = bundled(t.tier);
      if (total === null) return null;
      const data = total - t.imageBytes - (t.ktx2FileBytes ?? 0);
      return { ktx2: data + t.ktx2Bytes, image: data + t.imageBytes };
    };
    const d1 = tier1 && device(tier1);
    const hasKtx2 = r.tiers.some((t) => (t.ktx2FileBytes ?? 0) > 0);
    body.append(
      h('div', {},
        h('div', { class: 'big', textContent: d1 ? `${kib(hasKtx2 ? d1.ktx2 : d1.image)} per device` : `${kib(r.sourceBytes)} → ${kib(r.outputBytes)}` }),
        h('div', { class: 'muted', textContent: `${d1 ? `download at 1x${hasKtx2 ? ` (KTX2; ${kib(d1.image)} without)` : ''} · ${kib(r.outputBytes)} on disk, all tiers and formats · source ${kib(r.sourceBytes)}` : 'source → export (all tiers and formats)'} · ${compressed}/${list.length} skeletons compressed · ${r.date ? new Date(r.date).toLocaleString() : ''}` })),
      h('table', {},
        h('tr', {}, h('th', { textContent: 'Tier' }), h('th', { textContent: 'Download' }), h('th', { textContent: 'with KTX2' }), h('th', { textContent: 'GPU' }), h('th', { textContent: 'GPU KTX2' })),
        ...r.tiers.map((t) => {
          const d = device(t);
          return h('tr', {}, h('td', { textContent: `${t.tier}x` }), h('td', { textContent: kib(d ? d.image : t.imageBytes) }), h('td', { textContent: kib(d ? d.ktx2 : t.ktx2Bytes) }),
            h('td', { textContent: `${kib(t.vramBytes)}${tier1 && t.tier !== 1 ? ` (${Math.round((t.vramBytes / tier1.vramBytes) * 100)}%)` : ''}` }),
            h('td', { textContent: kib(t.ktx2VramBytes ?? t.vramBytes) }));
        })),
      h('span', { class: 'hint muted', textContent: `${d1 ? 'What one device downloads at each tier (bundle files minus the page copy it skips)' : 'Atlas pages per tier'}. The bundle holds both an image and a KTX2 copy of each page; a device reads one. GPU: as RGBA without KTX2; GPU KTX2: block-compressed where pages have KTX2. Raw JSON skeletons keep their own pages at 1x.` }),
    );
    if (r.bundles?.length) {
      body.append(h('div', {}, h('strong', { textContent: `${r.mode === 'development' ? 'Development' : 'Release'} bundles` }),
        h('div', { class: 'files', textContent: r.bundles.map((b) => `${kib(b.bytes).padStart(9)}  ${b.path}  (${b.files} files${b.language ? `, ${b.language}` : ''})`).join('\n') })));
    }
    if (r.conflicts?.length) body.append(h('div', {}, h('strong', { textContent: 'Pages shared by load groups' }), h('ul', {}, ...r.conflicts.map((c) => h('li', { class: 'warn-line', textContent: c })))));
    if (failed.length) body.append(h('div', {}, h('strong', { textContent: 'Exported as JSON instead' }), h('ul', {}, ...failed.map(([n, s]) => h('li', { textContent: `${n}: ${s.reason}` })))));
    if (r.warnings.length) body.append(h('div', {}, h('strong', { textContent: 'Warnings' }), h('ul', {}, ...r.warnings.map((w) => h('li', { textContent: w })))));
  }
  $('report').replaceChildren(h('h2', {}, 'Last export'), body);
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

function renderTierSelect(): void {
  const tiers = (project.report as Report | null)?.tiers.map((t) => t.tier) ?? [1];
  const select = $('tier') as HTMLSelectElement;
  const previous = select.value;
  select.replaceChildren(...tiers.map((t) => h('option', { value: String(t), textContent: `${t}x` })));
  select.value = tiers.map(String).includes(previous) ? previous : '1';
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

/** Forget everything of the previous project (views, loaded assets, selection). */
function resetProject(): void {
  previewToken++;
  for (const v of views) v.destroy();
  views = [];
  if (sourceAsset) unloadTabulaAsset(sourceAsset.asset);
  sourceAsset = null;
  for (const a of sceneSources.values()) unloadTabulaAsset(a);
  sceneSources.clear();
  bundleManager?.destroy();
  bundleManager = null;
  void manager?.promise.then((m) => m.destroy(), () => undefined);
  manager = null;
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
  app.resize();
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
  renderTierSelect();
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
for (const id of ['animation', 'mode', 'tier', 'ktx2', 'scene-count']) $(id).onchange = () => void showPreview();
$('throttle-label').hidden = !desktop?.setCpuThrottle;
$('throttle').onchange = () => void desktop?.setCpuThrottle?.(Number(($('throttle') as HTMLSelectElement).value));
$('mode').addEventListener('change', () => {
  // Leaving the scene ends the weak-device emulation.
  if (($('mode') as HTMLSelectElement).value !== 'scene' && ($('throttle') as HTMLSelectElement).value !== '1') {
    ($('throttle') as HTMLSelectElement).value = '1';
    void desktop?.setCpuThrottle?.(1);
  }
});
// Re-layout when the preview area changes size (window, details panel, start screen).
let lastStage = '';
let relayout: ReturnType<typeof setTimeout> | null = null;
new ResizeObserver(([entry]) => {
  const size = `${Math.round(entry!.contentRect.width)}x${Math.round(entry!.contentRect.height)}`;
  if (size === lastStage || !entry!.contentRect.height) return;
  lastStage = size;
  if (relayout) clearTimeout(relayout);
  relayout = setTimeout(() => {
    if (project && selected) void showPreview();
    else app.resize();
  }, 120);
}).observe($('stage'));
void boot().catch(showError);
