// Draw calls of the tabula-pixi demo scenes (../tabula-pixi/demo/scenes.ts) with the exported atlas vs
// repacked atlases, at several texture-unit caps, counted in Node with the
// Tabula renderer's batching rules (core/batching.ts BatchCounter: the same
// BatchPlanner the Pixi TabulaRenderer uses). 120 frames at 60 fps per case.
//   source:        the exported atlas (5 pages, every skeleton draws from all 5)
//   repacked-2048: scripts/atlas-groups.json (game group, max 2048 pages)
//   repacked-4096: same groups, max 4096 pages
// Usage: npx tsx scripts/scene-drawcalls.ts [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { SpineJsonParser } from 'tabula-pixi/core/adapters/spine-json-parser.js';
import { AtlasParser } from 'tabula-pixi/core/adapters/atlas-parser.js';
import { repackAtlases } from '../src/export/pack/repack.js';
import type { RepackGroupSpec } from '../src/export/pack/repack.js';
import { createImage } from '../src/export/pack/image.js';
import { BatchCounter } from 'tabula-pixi/core/batching.js';
import type { BatchStats } from 'tabula-pixi/core/batching.js';
import { Clip } from 'tabula-pixi/core/clip.js';
import { SkeletonRenderer } from 'tabula-pixi/core/renderer.js';
import type { AtlasData, SkeletonData } from 'tabula-pixi/core/types.js';
import { sceneItems, sceneSkeletons } from '../../tabula-pixi/demo/scenes.js';
import type { ReelState, SceneName } from '../../tabula-pixi/demo/scenes.js';

const DIR = '../tabula-pixi/test-assets';
const FRAMES = 120;
const UNITS = [8, 4, 2];
const CASES: [SceneName, ReelState][] = [['reels', 'idle'], ['reels', 'win'], ['reels', 'winall'], ['game', 'idle'], ['game', 'win']];

const names = [...new Set(CASES.flatMap(([scene]) => sceneSkeletons(scene)))];
const source = new AtlasParser().parse(readFileSync(`${DIR}/symbol1.atlas`, 'utf8'));
const data = new Map<string, SkeletonData>(names.map((n) => [n, new SpineJsonParser().parse(JSON.parse(readFileSync(`${DIR}/${n}.json`, 'utf8')), n)]));
const groups = (JSON.parse(readFileSync('scripts/atlas-groups.json', 'utf8')) as { groups: RepackGroupSpec[] }).groups;

async function repacked(maxSize: number): Promise<Map<string, AtlasData>> {
  const skeletons = [...data.values()].map((d) => ({ data: d, atlas: source, atlasDir: DIR }));
  // Layout only: blank pages of the right size stand in for the images.
  const out = await repackAtlases(skeletons, groups, { maxSize, padding: 2, extrude: 0, rotation: true, powerOfTwo: true, extension: 'png' },
    async (_dir, page) => createImage(page.width, page.height));
  const bySkeleton = new Map<string, AtlasData>();
  for (const g of out) for (const s of g.skeletons) bySkeleton.set(s.name, g.atlas);
  return bySkeleton;
}

function measure(scene: SceneName, state: ReelState, atlasOf: (name: string) => AtlasData, units: number) {
  const items = sceneItems(scene, state).map((item) => {
    const clip = new Clip(data.get(item.skeleton)!).play(item.animation, { loop: true });
    clip.seek(item.phase * clip.duration);
    const atlas = atlasOf(item.skeleton);
    return { clip, resolve: (path: string) => {
      const region = atlas.regions.get(path);
      return region ? { region, texture: region.page.name } : null;
    } };
  });
  const renderer = new SkeletonRenderer<string>();
  const frames: BatchStats[] = [];
  for (let f = 0; f < FRAMES; f++) {
    const sink = new BatchCounter<string>(units);
    for (const { clip, resolve } of items) {
      clip.update(1 / 60);
      renderer.draw(clip.skeleton, resolve, sink);
    }
    sink.flush();
    frames.push(sink.stats);
  }
  const mean = (k: (s: BatchStats) => number): number => +(frames.reduce((a, s) => a + k(s), 0) / frames.length).toFixed(1);
  return {
    drawCalls: mean((s) => s.drawCalls),
    drawCallsMax: Math.max(...frames.map((s) => s.drawCalls)),
    textureBreaks: mean((s) => s.batchBreaks.textures),
    blendBreaks: mean((s) => s.batchBreaks.blend),
    textures: Math.max(...frames.map((s) => s.textures)),
    textureBinds: mean((s) => s.textureBinds),
  };
}

const variants: [string, (name: string) => AtlasData][] = [['source', () => source]];
for (const size of [2048, 4096]) {
  const map = await repacked(size);
  variants.push([`repacked-${size}`, (n) => map.get(n)!]);
}
const rows: ({ scene: SceneName; state: ReelState; atlas: string; maxTextures: number } & ReturnType<typeof measure>)[] = [];
for (const [scene, state] of CASES) {
  for (const [atlas, atlasOf] of variants) {
    for (const units of UNITS) rows.push({ scene, state, atlas, maxTextures: units, ...measure(scene, state, atlasOf, units) });
  }
}
console.log(`Mean (max) draw calls per frame over ${FRAMES} frames; pages = distinct textures drawn; binds = texture units bound per frame.`);
console.log('| scene | state | atlas | pages | 8 units | 4 units | 2 units | binds (8 units) | blend breaks |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const [scene, state] of CASES) {
  for (const [atlas] of variants) {
    const r = (u: number) => rows.find((x) => x.scene === scene && x.state === state && x.atlas === atlas && x.maxTextures === u)!;
    const cell = (u: number) => `${r(u).drawCalls} (${r(u).drawCallsMax})`;
    console.log(`| ${scene} | ${state} | ${atlas} | ${r(8).textures} | ${cell(8)} | ${cell(4)} | ${cell(2)} | ${r(8).textureBinds} | ${r(8).blendBreaks} |`);
  }
}
const out = process.argv.indexOf('--json');
if (out > 0) writeFileSync(process.argv[out + 1]!, JSON.stringify(rows, null, 2));
