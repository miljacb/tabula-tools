/**
 * The preview in the middle pane: the selected skeleton from its Spine JSON and, once the project is
 * exported, from the export as a game loads it, side by side. A `.tbla` from the project plays its first
 * skeleton. Files come through the app's API (/api/file), so it works the same with the server and on the
 * website; loading is the Tabula Viewer's (packages/viewer/src/tabula).
 */

import { Application, Rectangle } from 'pixi.js';
import { createTabulaRuntime, registerTabulaRenderer } from 'tabula-pixi';
import { AtlasParser } from 'tabula-pixi/json';
import type { ClipView, TabulaAsset, TabulaRuntime } from 'tabula-pixi';
import type { BaseTexture } from 'pixi.js';
import { buildTabulaAsset } from 'tabula-viewer/tabula/loader.js';
import { loadSkeletons, openExport, type OpenedExport } from 'tabula-viewer/tabula/exportManager.js';

/** How the preview reads project (`src`) and export (`out`) files. */
export interface PreviewFiles {
  read(root: 'src' | 'out', path: string): Promise<Uint8Array>;
  /** The export folder's files. */
  list(): Promise<string[]>;
}

export interface PreviewSkeleton {
  name: string;
  /** Paths relative to the project. */
  json: string;
  atlas: string;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const kib = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

let app: Application | null = null;
let runtime: TabulaRuntime;
let views: ClipView[] = [];
/** Each view's rendered bounds, to re-fit when the stage resizes. */
let bounds: Rectangle[] = [];
let token = 0;
let source: { key: string; asset: TabulaAsset; textures: BaseTexture[] } | null = null;
let exported: { key: string; promise: Promise<OpenedExport> } | null = null;

/** Pixi starts on the first preview: the stage must be in the page and have a size. */
function stage(): Application {
  if (app) return app;
  registerTabulaRenderer();
  const host = $('stage');
  try {
    app = new Application({ resizeTo: host, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: devicePixelRatio });
  } catch {
    throw new Error('WebGL is not available in this browser, so there is no preview');
  }
  host.prepend(app.view as HTMLCanvasElement);
  runtime = createTabulaRuntime(app);
  new ResizeObserver(() => {
    app?.resize();
    layout();
  }).observe(host);
  return app;
}

function clearViews(): void {
  for (const v of views) v.destroy();
  views = [];
  bounds = [];
  $('label-left').textContent = '';
  $('label-right').textContent = '';
}

/** Show a message instead of skeletons ('' hides it). */
export function clearPreview(message: string): void {
  token++;
  clearViews();
  $('stage-empty').textContent = message;
}

async function loadSource(files: PreviewFiles, s: PreviewSkeleton): Promise<TabulaAsset> {
  if (source?.key === s.json) return source.asset;
  const [json, atlasText] = await Promise.all([files.read('src', s.json), files.read('src', s.atlas).then(decode)]);
  const dir = s.atlas.includes('/') ? s.atlas.slice(0, s.atlas.lastIndexOf('/') + 1) : '';
  const pages = new AtlasParser().parse(atlasText).pages.map((p) => p.name);
  const urls: Record<string, string> = {};
  try {
    for (const page of pages) urls[page] = URL.createObjectURL(new Blob([(await files.read('src', dir + page)).slice()]));
    const built = await buildTabulaAsset({ atlasText, skeletonJson: JSON.parse(decode(json)), pageUrls: urls, name: s.name });
    for (const t of source?.textures ?? []) t.destroy();
    source = { key: s.json, asset: built.asset, textures: built.textures };
    return built.asset;
  } finally {
    for (const url of Object.values(urls)) URL.revokeObjectURL(url);
  }
}

/** The export, opened once per export (`key`) and tier. */
function loadExport(files: PreviewFiles, key: string, tier: number): Promise<OpenedExport> {
  const full = `${key}|${tier}`;
  if (exported?.key !== full) {
    void exported?.promise.then((e) => e.manager.destroy(), () => undefined);
    exported = {
      key: full,
      promise: (async () => {
        const paths = (await files.list()).filter((p) => p !== 'export-report.json');
        const opened = await Promise.all(paths.map(async (name) => ({ name, bytes: await files.read('out', name) })));
        return openExport(opened, stage().renderer, tier);
      })(),
    };
    exported.promise.catch(() => (exported = null));
  }
  return exported.promise;
}

/** Forget loaded assets (another project was opened). */
export function resetPreview(): void {
  clearPreview('');
  for (const t of source?.textures ?? []) t.destroy();
  source = null;
  void exported?.promise.then((e) => e.manager.destroy(), () => undefined);
  exported = null;
}

/**
 * The skeleton from source and, when `exportKey` is set (the project has an export), from the export.
 * `exportKey` changes with every export so a new one is reopened.
 */
export async function showSkeleton(files: PreviewFiles, s: PreviewSkeleton, animation: string | null, exportKey: string | null, tier: number, bytes: number): Promise<void> {
  const mine = ++token;
  $('stage-empty').textContent = 'Loading…';
  const slots: { asset: TabulaAsset; label: string }[] = [];
  try {
    stage();
    slots.push({ asset: await loadSource(files, s), label: `Source · Spine JSON · ${kib(bytes)}` });
    if (exportKey) {
      const exp = await loadExport(files, exportKey, tier);
      const entry = exp.pkg.manifest.skeletons[s.name];
      if (entry) {
        const [loaded] = await loadSkeletons(exp, [s.name]);
        const pages = exp.manager.loadedPages().filter((p) => entry.pages.includes(p.name));
        const format = entry.format === 'json' ? 'raw JSON' : `compressed${entry.baked ? ', baked' : ''}`;
        slots.push({ asset: loaded!.asset, label: `Exported · ${format} · tier ${exp.manager.tier}x · ${[...new Set(pages.map((p) => p.format))].join('/') || 'no pages'} · ${kib(pages.reduce((n, p) => n + p.gpuBytes, 0))} GPU` });
      }
    }
  } catch (err) {
    if (mine === token) clearPreview(`Could not load: ${(err as Error).message}`);
    return;
  }
  if (mine !== token) return;
  place(slots, animation);
  if (exportKey && slots.length === 1) $('label-right').textContent = 'Not in the export';
}

/** A `.tbla` from the project (one with its manifest inside): its first skeleton. */
export async function showBundle(files: PreviewFiles, path: string, animation: string | null): Promise<string[]> {
  const mine = ++token;
  $('stage-empty').textContent = 'Loading…';
  try {
    const exp = await openExport([{ name: baseName(path), bytes: await files.read('src', path) }], stage().renderer);
    const name = Object.keys(exp.pkg.manifest.skeletons)[0];
    if (!name) throw new Error('no skeleton in this bundle');
    const [loaded] = await loadSkeletons(exp, [name]);
    if (mine !== token) return [];
    const names = loaded!.asset.data.animations.map((a) => a.name);
    place([{ asset: loaded!.asset, label: `${baseName(path)} · ${name} · ${kib(exp.manager.gpuBytes)} GPU` }], animation && names.includes(animation) ? animation : null);
    return names;
  } catch (err) {
    if (mine === token) clearPreview(`Could not load: ${(err as Error).message}`);
    return [];
  }
}

function place(slots: { asset: TabulaAsset; label: string }[], animation: string | null): void {
  const a = stage();
  a.resize();
  clearViews();
  $('stage-empty').textContent = '';
  slots.forEach((slot, i) => {
    const anim = animation ?? idleAnimation(slot.asset.data.animations.map((x) => x.name));
    const view = runtime.createView(slot.asset);
    a.stage.addChild(view);
    bounds.push(poseBounds(view, anim));
    if (anim && view.clip.hasAnimation(anim)) view.play(anim, { loop: true });
    views.push(view);
    $(i === 0 ? 'label-left' : 'label-right').textContent = slot.label;
  });
  layout();
}

/** Side by side, each fitted to its share of the stage. */
function layout(): void {
  if (!app) return;
  const { width: w, height: h } = app.screen;
  const width = w / views.length;
  views.forEach((view, i) => fit(view, bounds[i]!, width * i + width / 2, h / 2 + 10, width * 0.86, h * 0.8));
}

export function idleAnimation(names: string[]): string | null {
  return names.find((a) => /idle/i.test(a)) ?? names[0] ?? null;
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

function fit(view: ClipView, b: Rectangle, x: number, y: number, w: number, h: number): void {
  const scale = Math.min(w / b.width, h / b.height, 4);
  view.scale.set(scale);
  view.position.set(x - (b.x + b.width / 2) * scale, y - (b.y + b.height / 2) * scale);
}
