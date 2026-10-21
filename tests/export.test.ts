import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { TabulaAssetManager } from 'tabula-pixi';
import { spineJson } from 'tabula-pixi/json';
import { BUNDLE_MANIFEST, readBundle } from 'tabula-pixi/core/tbla.js';
import { exportProject, scaleSpriteSheet } from '../src/export/export-project.js';
import type { ExportEvent } from '../src/export/export-project.js';
import { validateProjectConfig } from '../src/export/config.js';
import { encodePageImage } from '../src/export/pages.js';
import { createImage } from '../src/export/pack/image.js';
import { validateAssetManifest } from 'tabula-pixi/core/manifest.js';

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));

/** A project folder with two Spine exports (and their pages) and a 16×8 sprite sheet. */
async function project(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'tabula-export-'));
  for (const name of ['symbol1', 'symbol2']) {
    for (const ext of ['json', 'atlas']) copyFileSync(join(ASSETS, `${name}.${ext}`), join(dir, `${name}.${ext}`));
    for (const line of readFileSync(join(ASSETS, `${name}.atlas`), 'utf8').split(/\r?\n/)) {
      if (/^\S+\.(png|webp)$/.test(line)) copyFileSync(join(ASSETS, line), join(dir, line));
    }
  }
  mkdirSync(join(dir, 'ui'));
  const sheet = createImage(16, 8);
  sheet.data.fill(255);
  writeFileSync(join(dir, 'ui', 'icons.png'), await encodePageImage(sheet, 'png'));
  writeFileSync(join(dir, 'ui', 'icons.json'), JSON.stringify({
    frames: { star: { frame: { x: 0, y: 0, w: 8, h: 8 }, sourceSize: { w: 8, h: 8 }, spriteSourceSize: { x: 0, y: 0, w: 8, h: 8 } } },
    meta: { image: 'icons.png', size: { w: 16, h: 8 }, scale: '1' },
  }));
  return dir;
}

describe('exportProject', () => {
  it('compresses the chosen skeletons, exports the rest raw, writes sprite tiers and the manifest', async () => {
    const src = await project();
    const out = join(src, 'export');
    const events: ExportEvent[] = [];
    const report = await exportProject({
      sourceDir: src, outDir: out, compress: ['symbol1'], onEvent: (e) => events.push(e),
      config: { format: 'files', imageFormat: 'png', tiers: [1, 0.5], loadGroups: { groups: { base: ['symbol*'], ui: ['icons'] } } },
    });
    expect(report.skeletons.symbol1).toMatchObject({ format: 'tbin', group: 'atlas' });
    expect(report.skeletons.symbol2).toMatchObject({ format: 'json', reason: 'not selected for compression' });
    expect(report.sprites).toEqual({ icons: [1, 0.5] });
    expect(report.tiers.map((t) => t.tier)).toEqual([1, 0.5]);
    expect(report.warnings).toEqual([]);

    const files = readdirSync(out, { recursive: true }).map(String).sort();
    expect(files).toEqual(expect.arrayContaining([
      '.tabula-export', 'assets.manifest.json', 'atlas.png', 'atlas@0.5x.png', 'atlas.textures.json', 'symbol1.tbin', 'symbol1.baked',
      join('raw', 'symbol2.json'), join('raw', 'symbol2.atlas'), join('sprites', 'ui', 'icons.json'), join('sprites', 'ui', 'icons@0.5x.json'), join('sprites', 'ui', 'icons@0.5x.png'),
    ]));
    const manifest = validateAssetManifest(JSON.parse(readFileSync(join(out, 'assets.manifest.json'), 'utf8')));
    expect(manifest.version).toBe(3);
    expect(manifest.sprites.icons!.page).toBe('icons.png'); // the sheet image is a page: tiers, KTX2
    expect(manifest.skeletons.symbol1).toMatchObject({ format: 'tbin', baked: { path: 'symbol1.baked' } });
    expect(manifest.skeletons.symbol2).toMatchObject({ format: 'json', file: { path: 'raw/symbol2.json' } });
    expect(manifest.sprites.icons!.tiers!['0.5']).toMatchObject({ json: { path: 'sprites/ui/icons@0.5x.json' } });
    expect(manifest.groups.ui!.sprites).toEqual(['icons']);
    const half = JSON.parse(readFileSync(join(out, 'sprites', 'ui', 'icons@0.5x.json'), 'utf8'));
    expect(half.meta).toMatchObject({ image: 'icons@0.5x.png', size: { w: 8, h: 4 }, scale: '0.5' });
    expect(half.frames.star.frame).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    expect(events.filter((e) => e.type === 'fallback')).toEqual([]);
  });

  it('exports a skeleton raw with the reason when it cannot be compressed; nothing is kept from earlier exports', async () => {
    const src = await project();
    const out = join(src, 'export');
    await exportProject({ sourceDir: src, outDir: out, config: { format: 'files', imageFormat: 'png' } });
    expect(existsSync(join(out, 'symbol2.tbin'))).toBe(true);
    const events: ExportEvent[] = [];
    // Tier 2 without symbol1@2x / symbol2@2x exports: both fall back to their JSON.
    const report = await exportProject({ sourceDir: src, outDir: out, config: { format: 'files', imageFormat: 'png', tiers: [2, 1] }, onEvent: (e) => events.push(e) });
    expect(report.skeletons.symbol1).toMatchObject({ format: 'json', reason: expect.stringMatching(/symbol1@2x\.atlas/) });
    expect(events.filter((e) => e.type === 'fallback').map((e) => (e as { asset: string }).asset).sort()).toEqual(['symbol1', 'symbol2']);
    expect(report.warnings.join()).toMatch(/icons: no @2x export/);
    expect(existsSync(join(out, 'symbol2.tbin'))).toBe(false); // the earlier export's file is gone
    expect(report.manifest.skeletons.symbol2!.format).toBe('json');
  });

  it('release: one .tbla per tier with everything, standalone images included; the manager loads from it', async () => {
    const src = await project();
    const logo = createImage(32, 16);
    logo.data.fill(200);
    writeFileSync(join(src, 'logo.png'), await encodePageImage(logo, 'png'));
    const out = join(src, 'export');
    const report = await exportProject({ sourceDir: src, outDir: out, config: { imageFormat: 'png', tiers: [1, 0.5] } });
    expect(report.format).toBe('tbla');
    expect(report.images).toEqual(['logo']);
    expect(readdirSync(out).sort()).toEqual(['.tabula-export', 'assets.manifest.json', 'export-report.json', 'game.tbla', 'game@0.5x.tbla']);
    expect(report.bundles.map((b) => [b.path, b.tier])).toEqual([['game.tbla', 1], ['game@0.5x.tbla', 0.5]]);
    const half = (await readBundle(new Uint8Array(readFileSync(join(out, 'game@0.5x.tbla'))))).toc.files.map((f) => f.path);
    expect(half).toEqual(expect.arrayContaining(['symbol1.tbin', 'symbol1.baked', 'atlas@0.5x.png', 'images/logo@0.5x.png', 'sprites/ui/icons@0.5x.json', 'sprites/ui/icons@0.5x.png']));
    expect(half.some((p) => p === 'atlas.png' || p === 'images/logo.png')).toBe(false); // only its tier's pages

    // Load it the way a game does: only the manifest and the bundles exist.
    class FakeBitmap { width = 4096; height = 4096; close(): void {} }
    vi.stubGlobal('ImageBitmap', FakeBitmap);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => new FakeBitmap()));
    const requested: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0]!;
      requested.push(url);
      const path = join(out, url.replace('/assets/', ''));
      return existsSync(path) ? new Response(readFileSync(path)) : new Response('missing', { status: 404 });
    }) as typeof fetch;
    const m = await TabulaAssetManager.load('/assets/assets.manifest.json', { tier: 0.5, fetch: fakeFetch, workers: false, json: spineJson });
    await m.loadGroup('base');
    expect(m.getAsset('symbol1').data.name).toBe('symbol1');
    expect(Object.keys(m.getSprites('icons').textures)).toEqual(['star']);
    expect(m.getTexture('logo').baseTexture).toBeTruthy();
    expect(requested).toEqual(['/assets/assets.manifest.json', '/assets/game@0.5x.tbla']);
    m.destroy();
    vi.unstubAllGlobals();
  });

  it('simple release (one load group, one tier, no KTX2): a single self-contained game.tbla, as Studio writes it', async () => {
    const src = await project();
    const out = join(src, 'export');
    const report = await exportProject({ sourceDir: src, outDir: out, config: { imageFormat: 'png' } });
    expect(report.entry).toBe('game.tbla');
    expect(readdirSync(out).sort()).toEqual(['.tabula-export', 'export-report.json', 'game.tbla']); // no manifest beside it
    expect(report.bundles.map((b) => [b.path, b.tier, b.group, b.kind])).toEqual([['game.tbla', 1, 'game', 'data']]);
    const bundle = await readBundle(new Uint8Array(readFileSync(join(out, 'game.tbla'))));
    expect(bundle.toc.meta).toMatchObject({ tier: 1, group: 'game', mode: 'release' });
    const paths = bundle.toc.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining([BUNDLE_MANIFEST, 'symbol1.tbin', 'symbol1.baked', 'atlas.png', 'sprites/ui/icons.png']));
    const embedded = validateAssetManifest(JSON.parse(new TextDecoder().decode(bundle.files.get(BUNDLE_MANIFEST)!)));
    expect(Object.keys(embedded.skeletons).sort()).toEqual(['symbol1', 'symbol2']);
    expect(report.downloads.tiers).toEqual([{ tier: 1, ktx2: null, images: report.bundles[0]!.bytes }]);
    // A game (or the viewer) opens the .tbla itself: its manifest is inside.
    class FakeBitmap { width = 4096; height = 4096; close(): void {} }
    vi.stubGlobal('ImageBitmap', FakeBitmap);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => new FakeBitmap()));
    const requested: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0]!;
      requested.push(url);
      return new Response(readFileSync(join(out, url.replace('/assets/', ''))));
    }) as typeof fetch;
    const m = await TabulaAssetManager.load('/assets/game.tbla', { fetch: fakeFetch, workers: false, json: spineJson });
    await m.loadGroup('base');
    expect(m.getAsset('symbol1').data.name).toBe('symbol1');
    expect([...new Set(requested)]).toEqual(['/assets/game.tbla']);
    m.destroy();
    vi.unstubAllGlobals();
  });

  it('release with KTX2: data, KTX2 and image bundles per tier; a device reads the data and one page format', async () => {
    const src = await project();
    const out = join(src, 'export');
    const ktx2 = new Uint8Array(readFileSync(new URL('./fixtures/gradient16x8-uastc.ktx2', import.meta.url)));
    const progress: Extract<ExportEvent, { type: 'progress' }>[] = [];
    const report = await exportProject({
      sourceDir: src, outDir: out, config: { imageFormat: 'png', tiers: [1, 0.5], ktx2: 'uastc' }, encodeKtx2: async () => ktx2,
      onEvent: (e) => { if (e.type === 'progress') progress.push(e); },
    });
    // Phases arrive in order (atlas pages, then sprite and image pages, then skeletons, ...), so the bar only moves forward.
    const order = ['read', 'pack', 'pages', 'skeletons', 'copy', 'manifest'];
    expect(progress.map((e) => order.indexOf(e.phase))).toEqual(progress.map((e) => order.indexOf(e.phase)).sort((a, b) => a - b));
    expect(progress.map((e) => e.fraction)).toEqual(progress.map((e) => e.fraction).sort((a, b) => a - b));
    expect(progress.at(-1)!.fraction).toBe(1);
    expect(report.bundles.map((b) => [b.path, b.kind])).toEqual([
      ['game.tbla', 'data'], ['game.ktx2.tbla', 'ktx2'], ['game.images.tbla', 'images'],
      ['game@0.5x.tbla', 'data'], ['game@0.5x.ktx2.tbla', 'ktx2'], ['game@0.5x.images.tbla', 'images'],
    ]);
    const paths = async (file: string): Promise<string[]> => (await readBundle(new Uint8Array(readFileSync(join(out, file))))).toc.files.map((f) => f.path);
    expect(await paths('game.ktx2.tbla')).toEqual(expect.arrayContaining(['atlas.ktx2', 'sprites/ui/icons.ktx2']));
    expect((await paths('game.images.tbla')).every((p) => p.endsWith('.png'))).toBe(true);
    expect((await paths('game.tbla')).some((p) => p.endsWith('.ktx2') || p === 'atlas.png')).toBe(false);
    // Per device: the data bundle plus one page bundle, exactly the files written.
    const size = (file: string): number => readFileSync(join(out, file)).length;
    expect(report.downloads.tiers.find((t) => t.tier === 1)).toEqual({ tier: 1, ktx2: size('game.tbla') + size('game.ktx2.tbla'), images: size('game.tbla') + size('game.images.tbla') });

    // Without KTX2 (no renderer and transcoder) the manager never opens the KTX2 bundle.
    class FakeBitmap { width = 4096; height = 4096; close(): void {} }
    vi.stubGlobal('ImageBitmap', FakeBitmap);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => new FakeBitmap()));
    const requested: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0]!;
      requested.push(url);
      return new Response(readFileSync(join(out, url.replace('/assets/', ''))));
    }) as typeof fetch;
    const m = await TabulaAssetManager.load('/assets/assets.manifest.json', { fetch: fakeFetch, workers: false, json: spineJson });
    await m.loadGroup('base');
    expect(requested.sort()).toEqual(['/assets/assets.manifest.json', '/assets/game.images.tbla', '/assets/game.tbla']);
    m.destroy();
    vi.unstubAllGlobals();
  });

  it('development: one self-contained .tbla per asset and tier', async () => {
    const src = await project();
    const out = join(src, 'export');
    const report = await exportProject({ sourceDir: src, outDir: out, config: { mode: 'development', imageFormat: 'png', tiers: [1, 0.5] } });
    expect(report.bundles.map((b) => b.path).sort()).toEqual(['icons.tbla', 'icons@0.5x.tbla', 'symbol1.tbla', 'symbol1@0.5x.tbla', 'symbol2.tbla', 'symbol2@0.5x.tbla']);
    expect(report.skeletons.symbol1!.group).toBe('symbol1'); // its own pages
    // A designer sends symbol1@0.5x.tbla alone: it opens by itself.
    const bytes = readFileSync(join(out, 'symbol1@0.5x.tbla'));
    class FakeBitmap { width = 4096; height = 4096; close(): void {} }
    vi.stubGlobal('ImageBitmap', FakeBitmap);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => new FakeBitmap()));
    const m = await TabulaAssetManager.load('/x/symbol1@0.5x.tbla', { fetch: (async () => new Response(bytes)) as typeof fetch, workers: false });
    expect(m.tier).toBe(0.5);
    await m.loadGroup('base');
    expect(m.getAsset('symbol1').data.name).toBe('symbol1');
    expect(m.loadedPages().map((p) => p.file)).toEqual(['symbol1@0.5x.png']);
    vi.unstubAllGlobals();
  });

  it('pages follow the source format by default; images not a multiple of 4 are padded with their size kept as the frame', async () => {
    const src = await project();
    const odd = createImage(30, 18);
    odd.data.fill(200);
    writeFileSync(join(src, 'odd.png'), await encodePageImage(odd, 'png'));
    const out = join(src, 'export');
    const report = await exportProject({ sourceDir: src, outDir: out, config: { format: 'files' } });
    expect(Object.keys(report.manifest.pages).some((p) => p.endsWith('.webp'))).toBe(true);
    const image = report.manifest.images!.odd!;
    expect(image.frame).toEqual({ width: 30, height: 18 });
    expect(report.manifest.pages[image.page]).toMatchObject({ width: 32, height: 20 });
  }, 60_000);

  it('refuses a non-empty folder it did not write, and checks the config', async () => {
    const src = await project();
    const out = join(src, 'mine');
    mkdirSync(out);
    writeFileSync(join(out, 'notes.txt'), 'keep');
    await expect(exportProject({ sourceDir: src, outDir: out })).rejects.toThrow(/not empty/);
    expect(readFileSync(join(out, 'notes.txt'), 'utf8')).toBe('keep');
    expect(() => validateProjectConfig({ tiers: [0] })).toThrow(/tiers/);
    expect(() => validateProjectConfig({ ktx2: 'astc' })).toThrow(/ktx2/);
  });

  it('scales sprite sheets so sprites keep their size', () => {
    const sheet = { frames: [{ filename: 'a', frame: { x: 3, y: 5, w: 7, h: 9 }, sourceSize: { w: 10, h: 10 } }], meta: { image: 'a.png', scale: '2' } };
    const half = scaleSpriteSheet(sheet as never, 0.5, 'a@0.5x.png', { w: 20, h: 20 });
    expect(half.meta).toMatchObject({ image: 'a@0.5x.png', size: { w: 10, h: 10 }, scale: '1' });
    expect((half.frames as { frame: object; sourceSize: object }[])[0]).toMatchObject({ filename: 'a', frame: { x: 2, y: 3, w: 3, h: 4 }, sourceSize: { w: 5, h: 5 } });
  });
});
