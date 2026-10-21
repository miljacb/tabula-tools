import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SpineJsonParser } from 'tabula-pixi/core/adapters/spine-json-parser.js';
import { AtlasParser } from 'tabula-pixi/core/adapters/atlas-parser.js';
import { writeAtlasText } from '../src/export/atlas-writer.js';
import { MaxRectsBin, packPages } from '../src/export/pack/maxrects.js';
import { blit, createImage, premultiply, readRegion, rotateForStorage } from '../src/export/pack/image.js';
import type { RgbaImage } from '../src/export/pack/image.js';
import { assignGroups, matchesPattern, renderTierPages, repackAtlases } from '../src/export/pack/repack.js';
import type { RepackOptions, RepackSkeleton } from '../src/export/pack/repack.js';
import { loadPageImage } from '../src/export/pages.js';
import { isTierExport } from '../src/export/sources.js';
import { tierSize } from 'tabula-pixi/core/texture-formats.js';
import { regionPathsOf } from 'tabula-pixi/core/regions.js';
import { BatchCounter } from 'tabula-pixi/core/batching.js';
import { BlendMode } from 'tabula-pixi/core/types.js';
import type { AtlasData, AtlasRegion } from 'tabula-pixi/core/types.js';
import { SkeletonRenderer } from 'tabula-pixi/core/renderer.js';
import type { DrawSink } from 'tabula-pixi/core/renderer.js';
import { Clip } from 'tabula-pixi/core/clip.js';
import { RecordingSink, resolverFor, skeletonFrom } from './helpers.js';

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url));
const OPTIONS: RepackOptions = { maxSize: 2048, padding: 2, extrude: 0, rotation: true, powerOfTwo: true, extension: 'png' };

/** Deterministic noise image. */
function noise(width: number, height: number, seed = 1): RgbaImage {
  const img = createImage(width, height);
  let s = seed;
  for (let i = 0; i < img.data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    img.data[i] = s >>> 24;
  }
  return img;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('MaxRects packing', () => {
  it('places rectangles inside the page without overlap, rotating when needed', () => {
    const sizes = Array.from({ length: 120 }, (_, i) => ({ width: 8 + ((i * 37) % 120), height: 8 + ((i * 53) % 90) }));
    sizes.push({ width: 500, height: 60 }); // only fits a 256-high page... rotated in a narrow one
    const { pages, placements } = packPages(sizes, { maxWidth: 512, maxHeight: 512, rotation: true, powerOfTwo: true });
    const rects = placements.map((p) => {
      const s = sizes[p.id]!;
      return { page: p.page, x: p.x, y: p.y, w: p.rotated ? s.height : s.width, h: p.rotated ? s.width : s.height };
    });
    expect(placements.map((p) => p.id)).toEqual(sizes.map((_, i) => i));
    for (const r of rects) {
      expect(r.x + r.w).toBeLessThanOrEqual(pages[r.page]!.width);
      expect(r.y + r.h).toBeLessThanOrEqual(pages[r.page]!.height);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) if (rects[i]!.page === rects[j]!.page) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
    }
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect([16, 32, 64, 128, 256, 512]).toContain(p.width);
  });

  it('shrinks a page to the smallest power of two that holds its rectangles', () => {
    const { pages } = packPages([{ width: 100, height: 50 }, { width: 20, height: 20 }], { maxWidth: 2048, maxHeight: 2048, rotation: false, powerOfTwo: true });
    expect(pages).toEqual([{ width: 128, height: 64, fill: (100 * 50 + 400) / (128 * 64) }]);
  });

  it('rotates only when allowed', () => {
    expect(new MaxRectsBin(100, 20, false).insert(20, 100)).toBeNull();
    expect(new MaxRectsBin(100, 20, true).insert(20, 100)).toEqual({ x: 0, y: 0, rotated: true });
    expect(() => packPages([{ width: 3000, height: 10 }], { maxWidth: 2048, maxHeight: 2048, rotation: false, powerOfTwo: true })).toThrow('does not fit');
  });
});

describe('region pixels', () => {
  it('rotateForStorage is the inverse of reading a 90° region', () => {
    const logical = noise(7, 3);
    const stored = rotateForStorage(logical);
    expect([stored.width, stored.height]).toEqual([3, 7]);
    const page = createImage(10, 10);
    blit(page, stored, 2, 1, 0);
    expect(readRegion(page, 2, 1, 7, 3, 90)).toEqual(logical);
    // Spine's convention: the logical top-right pixel is stored at the top-left.
    expect(Array.from(stored.data.subarray(0, 4))).toEqual(Array.from(logical.data.subarray(6 * 4, 7 * 4)));
  });

  it('extrudes edge pixels', () => {
    const src = noise(2, 2);
    const dst = createImage(6, 6);
    blit(dst, src, 2, 2, 2);
    const px = (img: RgbaImage, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
    expect(px(dst, 0, 0)).toEqual(px(src, 0, 0));
    expect(px(dst, 5, 5)).toEqual(px(src, 1, 1));
    expect(px(dst, 0, 3)).toEqual(px(src, 0, 1));
  });

  it('premultiplies', () => {
    const img = { width: 1, height: 1, data: new Uint8Array([200, 100, 50, 128]) };
    premultiply(img);
    expect(Array.from(img.data)).toEqual([100, 50, 25, 128]);
  });
});

/** A 256×256 page of noise with rotated and unrotated, trimmed regions, and skeletons using them. */
function syntheticSource(): { skeletons: RepackSkeleton[]; page: RgbaImage } {
  const atlasText = [
    'src.png', 'size:256,256', 'filter:Linear,Linear',
    'a', 'bounds:0,0,40,20',
    'b', 'bounds:50,0,30,60', 'rotate:90',
    'c', 'bounds:100,10,64,64', 'offsets:3,4,70,72',
    'd', 'bounds:0,100,100,8', 'rotate:90',
    'e', 'bounds:200,200,10,10',
  ].join('\n');
  const atlas = new AtlasParser().parse(atlasText);
  const skeleton = (name: string, paths: string[]) => skeletonFrom({
    bones: [{ name: 'root' }],
    slots: paths.map((p) => ({ name: p, bone: 'root', attachment: p })),
    skins: [{ name: 'default', attachments: Object.fromEntries(paths.map((p) => [p, { [p]: { width: 10, height: 10 } }])) }],
  }, name);
  return {
    page: noise(256, 256, 7),
    skeletons: [
      { data: skeleton('symbolA', ['a', 'b', 'c']), atlas, atlasDir: 'mem' },
      { data: skeleton('symbolB', ['c', 'd']), atlas, atlasDir: 'mem' },
      { data: skeleton('button', ['e', 'a']), atlas, atlasDir: 'mem' },
    ],
  };
}

function expectSamePixels(sourcePage: RgbaImage, source: AtlasRegion, outPages: Map<string, RgbaImage>, out: AtlasRegion): void {
  expect([out.width, out.height, out.offsetX, out.offsetY, out.originalWidth, out.originalHeight])
    .toEqual([source.width, source.height, source.offsetX, source.offsetY, source.originalWidth, source.originalHeight]);
  const a = readRegion(sourcePage, source.x, source.y, source.width, source.height, source.degrees);
  const b = readRegion(outPages.get(out.page.name)!, out.x, out.y, out.width, out.height, out.degrees);
  expect(Buffer.from(b.data).equals(Buffer.from(a.data)), source.name).toBe(true);
}

describe('repackAtlases', () => {
  it('assigns skeletons to groups by pattern, the rest to "misc"', () => {
    const { skeletons } = syntheticSource();
    expect(matchesPattern('symbol12', 'symbol*')).toBe(true);
    expect(matchesPattern('symbol12', 'symbol?')).toBe(false);
    const groups = assignGroups(skeletons, [{ name: 'reel', skeletons: ['symbol*'] }, { name: 'empty', skeletons: ['nothing'] }]);
    expect([...groups].map(([k, v]) => [k, v.map((s) => s.data.name)])).toEqual([['reel', ['symbolA', 'symbolB']], ['misc', ['button']]]);
    expect([...assignGroups(skeletons, []).keys()]).toEqual(['atlas']);
  });

  for (const rotation of [true, false]) {
    it(`copies every region pixel-exactly (rotation ${rotation ? 'on' : 'off'}), keeps trim data, writes parseable atlas text`, async () => {
      const { skeletons, page } = syntheticSource();
      const groups = await repackAtlases(skeletons, [{ name: 'reel', skeletons: ['symbol*'] }], { ...OPTIONS, rotation, extrude: 1 }, async () => page);
      expect(groups.map((g) => g.name)).toEqual(['reel', 'misc']);
      const [reel, misc] = groups;
      expect([...reel!.atlas.regions.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
      expect([...misc!.atlas.regions.keys()].sort()).toEqual(['a', 'e']);
      expect(reel!.sharedRegions).toEqual(['a']);
      for (const group of groups) {
        const pages = new Map(group.atlas.pages.map((p, i) => [p.name, group.images[i]!]));
        for (const [key, region] of group.atlas.regions) expectSamePixels(page, skeletons[0]!.atlas.regions.get(key)!, pages, region);
        // Text round trip.
        const parsed = new AtlasParser().parse(writeAtlasText(group.atlas));
        expect(parsed.pages.map((p) => [p.name, p.width, p.height])).toEqual(group.atlas.pages.map((p) => [p.name, p.width, p.height]));
        for (const [key, r] of group.atlas.regions) {
          const q = parsed.regions.get(key)!;
          expect([q.page.name, q.x, q.y, q.width, q.height, q.degrees, q.offsetX, q.offsetY, q.originalWidth, q.originalHeight])
            .toEqual([r.page.name, r.x, r.y, r.width, r.height, r.degrees, r.offsetX, r.offsetY, r.originalWidth, r.originalHeight]);
        }
      }
      if (!rotation) for (const g of groups) for (const r of g.atlas.regions.values()) expect(r.degrees).toBe(0);
    });
  }

  it('premultiplies when asked and marks the pages', async () => {
    const { skeletons, page } = syntheticSource();
    const [group] = await repackAtlases(skeletons, [], { ...OPTIONS, pma: true }, async () => page);
    expect(group!.atlas.pages.every((p) => p.pma)).toBe(true);
    const r = group!.atlas.regions.get('a')!;
    const src = readRegion(page, 0, 0, 40, 20, 0);
    premultiply(src);
    expect(readRegion(group!.images[0]!, r.x, r.y, 40, 20, r.degrees)).toEqual(src);
  });

  it('real assets: the reel symbols + buttons repack onto one page, pixel-exact, and render the same triangles', async () => {
    const atlasText = readFileSync(`${ASSETS}symbol1.atlas`, 'utf8');
    const atlas = new AtlasParser().parse(atlasText);
    const names = ['symbol1', 'symbol2', 'spinButton', 'storeButton'];
    const skeletons = names.map((n) => ({
      data: new SpineJsonParser().parse(JSON.parse(readFileSync(`${ASSETS}${n}.json`, 'utf8')), n), atlas, atlasDir: ASSETS,
    }));
    const [group] = await repackAtlases(skeletons, [], OPTIONS, loadPageImage);
    expect(group!.atlas.pages.length).toBe(1);
    expect(group!.sourcePages.length).toBe(5);
    const sourcePages = new Map<string, RgbaImage>();
    for (const p of atlas.pages) sourcePages.set(p.name, await loadPageImage(ASSETS, p));
    const outPages = new Map(group!.atlas.pages.map((p, i) => [p.name, group!.images[i]!]));
    for (const [key, region] of group!.atlas.regions) expectSamePixels(sourcePages.get(atlas.regions.get(key)!.page.name)!, atlas.regions.get(key)!, outPages, region);
    expect(new Set(group!.atlas.regions.keys())).toEqual(new Set(skeletons.flatMap((s) => [...regionPathsOf(s.data)])));

    // Same geometry and colors; UVs map to the same texels (checked above), positions identical.
    for (const s of skeletons) {
      const clip = new Clip(s.data).play(s.data.animations[0]!.name);
      clip.seek(0.3);
      const before = new RecordingSink();
      const after = new RecordingSink();
      new SkeletonRenderer<string>().draw(clip.skeleton, resolverFor(atlas), before);
      new SkeletonRenderer<string>().draw(clip.skeleton, resolverFor(group!.atlas), after);
      expect(after.draws.map((d) => [d.positions, d.indices, d.colors, d.blendMode])).toEqual(before.draws.map((d) => [d.positions, d.indices, d.colors, d.blendMode]));
    }
  });
});

describe('BatchCounter', () => {
  const draw = (sink: BatchCounter<string>, texture: string, blend = BlendMode.Normal, vertices = 4) =>
    (sink as DrawSink<string>).drawTriangles(texture, blend, [], [], vertices, [], 6, { lightR: 1, lightG: 1, lightB: 1, lightA: 1, darkR: 0, darkG: 0, darkB: 0 });

  it('breaks batches on texture-unit overflow, blend group changes and the vertex limit', () => {
    const sink = new BatchCounter<string>(2);
    for (const t of ['p1', 'p2', 'p1', 'p3', 'p3']) draw(sink, t);
    draw(sink, 'p3', BlendMode.Additive); // same PMA blend state
    draw(sink, 'p3', BlendMode.Screen);
    draw(sink, 'p3', BlendMode.Normal);
    draw(sink, 'p3', BlendMode.Normal, 65535);
    sink.flush();
    expect(sink.stats.batchBreaks).toEqual({ textures: 1, blend: 2, vertices: 1 });
    expect(sink.stats.drawCalls).toBe(5);
    expect(sink.stats.textures).toBe(3);
  });

  it('counts fewer draw calls for a repacked atlas when texture units are scarce', () => {
    const atlas = new AtlasParser().parse(readFileSync(`${ASSETS}symbol1.atlas`, 'utf8'));
    const data = new SpineJsonParser().parse(JSON.parse(readFileSync(`${ASSETS}symbol1.json`, 'utf8')), 'symbol1');
    const onePage: AtlasData = { pages: [atlas.pages[0]!], regions: new Map([...atlas.regions].map(([k, r]) => [k, { ...r, page: atlas.pages[0]! }])) };
    const count = (a: AtlasData, units: number) => {
      const clip = new Clip(data).play('symbolWin');
      clip.seek(0.5);
      const sink = new BatchCounter<string>(units);
      new SkeletonRenderer<string>().draw(clip.skeleton, resolverFor(a), sink);
      sink.flush();
      return sink.stats;
    };
    expect(count(atlas, 8).batchBreaks.textures).toBe(0);
    expect(count(atlas, 2).batchBreaks.textures).toBeGreaterThan(0);
    expect(count(onePage, 2).batchBreaks.textures).toBe(0);
    expect(count(onePage, 2).drawCalls).toBeLessThan(count(atlas, 2).drawCalls);
  });
});

describe('page groups', () => {
  it('a group naming a skeleton exactly wins over patterns', () => {
    const { skeletons } = syntheticSource();
    const groups = assignGroups(skeletons, [{ name: 'reel', skeletons: ['symbol*'] }, { name: 'bonus', skeletons: ['symbolB'] }]);
    expect(groups.get('reel')!.map((s) => s.data.name)).toEqual(['symbolA']);
    expect(groups.get('bonus')!.map((s) => s.data.name)).toEqual(['symbolB']);
  });
});

describe('tiers above 1', () => {
  /** A 2× export of the synthetic source: same region names, unrotated, a solid colour each, and another trim for "c". */
  function hiResExport(): { atlas: AtlasData; page: RgbaImage; colors: Record<string, number[]> } {
    const atlas = new AtlasParser().parse([
      'src@2x.png', 'size:512,512', 'filter:Linear,Linear',
      'a', 'bounds:0,0,80,40',
      'b', 'bounds:0,50,60,120',
      'c', 'bounds:100,0,130,132', 'offsets:5,6,140,144',
      'd', 'bounds:0,200,200,16',
      'e', 'bounds:250,0,20,20',
    ].join('\n'));
    const colors: Record<string, number[]> = { a: [255, 0, 0, 255], b: [0, 255, 0, 255], c: [0, 0, 255, 255], d: [255, 255, 0, 255], e: [0, 255, 255, 255] };
    const page = createImage(512, 512);
    for (const [name, r] of atlas.regions) {
      for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) page.data.set(colors[name]!, (y * 512 + x) * 4);
    }
    return { atlas, page, colors };
  }

  it('renders a 2x page from the 2x export in the 1x layout, never upscaled', async () => {
    const { skeletons, page } = syntheticSource();
    const hi = hiResExport();
    for (const s of skeletons) s.hiRes = new Map([[2, { atlas: hi.atlas, atlasDir: 'hi' }]]);
    const [group] = await repackAtlases(skeletons, [], OPTIONS, async () => page);
    const size = (p: { width: number; height: number }) => tierSize(p.width, p.height, 2);
    const [tier2] = await renderTierPages(group!, 2, size, async (dir) => (dir === 'hi' ? hi.page : page));
    const out = group!.atlas.pages[0]!;
    expect(tier2).toMatchObject(size(out));
    const sx = tier2!.width / out.width;
    const sy = tier2!.height / out.height;
    for (const [key, r] of group!.atlas.regions) {
      const w = r.degrees === 90 ? r.height : r.width;
      const h = r.degrees === 90 ? r.width : r.height;
      const px = Math.floor((r.x + w / 2) * sx);
      const py = Math.floor((r.y + h / 2) * sy);
      expect([...tier2!.data.subarray((py * tier2!.width + px) * 4, (py * tier2!.width + px) * 4 + 4)], key).toEqual(hi.colors[key]);
    }
  });

  it('fails without the 2x export of a region, and skips tier exports when collecting skeletons', async () => {
    const { skeletons, page } = syntheticSource();
    const [group] = await repackAtlases(skeletons, [], OPTIONS, async () => page);
    await expect(renderTierPages(group!, 2, (p) => p, async () => page)).rejects.toThrow(/no 2x export/);
    expect(isTierExport('a/symbol1@2x.json')).toBe(true);
    expect(isTierExport('a/symbol1@1.5x.atlas')).toBe(true);
    expect(isTierExport('a/symbol1.json')).toBe(false);
  });
});
