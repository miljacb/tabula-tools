import { BatchCounter } from 'tabula-pixi/core/batching.js';
import { SkeletonRenderer } from 'tabula-pixi/core/renderer.js';
import { DEFAULT_MAX_TEXTURES } from 'tabula-pixi/core/shaders.js';
import { attachmentKind, drawOrderSlots, regionOf } from '../tabula/geometry.js';

const BLEND_NAMES = ['Normal', 'Additive', 'Multiply', 'Screen'];

/** Shared like tabula-pixi's own; drawing allocates nothing after warm-up. */
const skeletonRenderer = new SkeletonRenderer();

/** Texture units per batch the counts assume: the renderer uses min(GPU units, 8). */
let textureUnits = DEFAULT_MAX_TEXTURES;
/** Units the GPU allows the renderer (set from the WebGL context once the stage exists). */
let gpuTextureUnits = DEFAULT_MAX_TEXTURES;

export function getTextureUnits() {
  return textureUnits;
}

export function getGpuTextureUnits() {
  return gpuTextureUnits;
}

/** @param {number} units GPU limit reported by the context; the renderer never uses more than 8. */
export function setGpuTextureUnits(units) {
  const next = Math.max(1, Math.min(DEFAULT_MAX_TEXTURES, Math.floor(units) || DEFAULT_MAX_TEXTURES));
  if (textureUnits === gpuTextureUnits) textureUnits = next;
  gpuTextureUnits = next;
}

/** @param {number} units simulate a device with fewer units (1 – GPU limit) */
export function setTextureUnits(units) {
  textureUnits = Math.max(1, Math.min(gpuTextureUnits, Math.floor(units) || gpuTextureUnits));
}

/**
 * A DrawSink that counts like the renderer (BatchCounter) and also tallies what was drawn per blend mode.
 * With `matrix`, positions go to world space first, so overlap between skeletons is judged like on screen.
 */
class CountingSink {
  /** @param {number} units */
  constructor(units) {
    this.counter = new BatchCounter(units);
    /** @type {Record<number, number>} */
    this.blends = {};
    /** @type {{ a: number, b: number, c: number, d: number, tx: number, ty: number } | null} */
    this.matrix = null;
    this.scratch = new Float64Array(512);
  }

  drawTriangles(texture, blendMode, positions, uvs, vertexCount, indices, indexCount, colors) {
    this.blends[blendMode] = (this.blends[blendMode] || 0) + 1;
    let pos = positions;
    const m = this.matrix;
    if (m) {
      const n = vertexCount * 2;
      if (this.scratch.length < n) this.scratch = new Float64Array(Math.max(n, this.scratch.length * 2));
      pos = this.scratch;
      for (let i = 0; i < n; i += 2) {
        const x = positions[i];
        const y = positions[i + 1];
        pos[i] = m.a * x + m.c * y + m.tx;
        pos[i + 1] = m.b * x + m.d * y + m.ty;
      }
    }
    this.counter.drawTriangles(texture, blendMode, pos, uvs, vertexCount, indices, indexCount, colors);
  }
}

/**
 * Draw one view into `sink` the way ClipView does (clip tint × alpha).
 * @param {any} view TabulaView
 * @param {CountingSink} sink
 * @param {number} alpha
 */
function drawView(view, sink, alpha) {
  const tint = view.clip.tint;
  skeletonRenderer.draw(view.clip.skeleton, view.asset.resolve, sink, { r: tint.r, g: tint.g, b: tint.b, a: tint.a * alpha }, view.clip.darkTint);
}

/** @param {CountingSink} sink */
function finish(sink) {
  sink.counter.flush();
  const s = sink.counter.stats;
  const blends = Object.entries(sink.blends)
    .map(([mode, count]) => `${BLEND_NAMES[Number(mode)] || `Mode ${mode}`}: ${count}`)
    .join(', ') || 'None';
  return {
    drawCalls: s.drawCalls,
    vertices: s.vertices,
    triangles: s.triangles,
    textures: s.textures,
    batchBreaks: { ...s.batchBreaks },
    blends,
  };
}

/**
 * Exact draw statistics of one skeleton drawn alone, by the renderer's own batching rules.
 * Null when the instance is not a tabula view (plain data in tests).
 * @param {any} inst
 * @param {number} [units]
 */
export function countInstanceDraws(inst, units = textureUnits) {
  const view = inst?.spine;
  if (!view?.clip?.skeleton || !view.asset?.resolve) return null;
  const sink = new CountingSink(units);
  sink.counter.breakSegment();
  drawView(view, sink, 1);
  return finish(sink);
}

/**
 * Exact draw statistics of several skeletons drawn together in z-order, in world space,
 * so skeletons batch with each other like they do on screen. Hidden instances are skipped.
 * @param {any[]} instances
 * @param {number} [units]
 */
export function countSceneDraws(instances, units = textureUnits) {
  const sink = new CountingSink(units);
  const ordered = [...instances].filter((i) => i.visible !== false).sort((a, b) => a.zIndex - b.zIndex);
  for (const inst of ordered) {
    const view = inst.spine;
    if (!view?.clip?.skeleton || !view.asset?.resolve) continue;
    const alpha = view.worldAlpha ?? 1;
    if (!(alpha > 0) || view.worldVisible === false) continue;
    sink.matrix = view.worldTransform ?? null;
    sink.counter.breakSegment();
    drawView(view, sink, alpha);
  }
  return finish(sink);
}

/**
 * @param {object | null | undefined} page
 */
function baseOf(page) {
  const texture = page?.texture?.texture || page?.texture;
  return texture?.baseTexture || null;
}

/**
 * @param {object | null | undefined} page
 */
function pageKey(page) {
  if (!page) return '';
  const base = baseOf(page);
  if (base?.uid != null) return `uid:${base.uid}`;
  return contentPageKey(page, base);
}

/**
 * Logical atlas page identity (file name + decoded size). Same WebP dropped with multiple skeletons shares this key even when GPU uids differ.
 * @param {object | null | undefined} page
 * @param {object | null | undefined} [base]
 */
export function contentPageKey(page, base = baseOf(page)) {
  if (!page) return '';
  const w = firstSize(base?.realWidth, base?.width, base?.resource?.width, page.width, page.texture?.width);
  const h = firstSize(base?.realHeight, base?.height, base?.resource?.height, page.height, page.texture?.height);
  const name = (page.name || '').toLowerCase();
  return `file:${name}:${w}x${h}`;
}

/**
 * Pixi uploads WebP/PNG as uncompressed pixels. With mipmaps on, every level down to 1×1 is stored too;
 * levels are summed exactly (each halves, rounding down, never below 1).
 * Pixi 7 MIPMAP_MODES: 0 off, 1 power-of-two only, 2 on, 3 manual.
 * @param {object | null} base
 * @param {number} width
 * @param {number} height
 */
export function textureBytes(base, width, height) {
  // KTX2 / Basis pages: Pixi's CompressedTextureResource holds every uploaded level; its bytes are the GPU size.
  const levels = base?.resource?._levelBuffers;
  if (Array.isArray(levels) && levels.length) {
    const bytes = levels.reduce((sum, level) => sum + (level.levelBuffer?.byteLength || 0), 0);
    return { bytes, mips: levels.length > 1, compressed: true };
  }
  const format = base?.format;
  const bpp = format === 6407 ? 3 : format === 6406 || format === 6409 || format === 6403 ? 1 : format === 6410 || format === 33319 ? 2 : 4;
  const mode = base?.mipmap;
  const pot = width > 0 && height > 0 && (width & (width - 1)) === 0 && (height & (height - 1)) === 0;
  const mips = mode >= 2 || (mode === 1 && pot);
  let pixels = width * height;
  if (mips) {
    let w = width;
    let h = height;
    while (w > 1 || h > 1) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      pixels += w * h;
    }
  }
  return { bytes: pixels * bpp, mips, compressed: false };
}

/** @param {...unknown} values */
function firstSize(...values) {
  for (const value of values) {
    const number = Number(value);
    if (number > 0) return number;
  }
  return 0;
}

/**
 * Atlas pages of one instance with their GPU size. Cheap: no skeleton walk, so memory-only callers
 * (stage dedupe, marginal VRAM) do not pay for the exact draw count.
 * @param {{ atlas?: any }} inst
 */
export function measureAtlasPages(inst) {
  const atlas = inst.atlas;
  /** @type {{ key: string, contentKey: string, label: string, bytes: number, uploaded: boolean | null }[]} */
  const pages = [];
  if (atlas?.pages?.length) {
    for (let i = 0; i < atlas.pages.length; i++) {
      const page = atlas.pages[i];
      const base = baseOf(page);
      const w = firstSize(base?.realWidth, base?.width, base?.resource?.width, page.width, page.texture?.width);
      const h = firstSize(base?.realHeight, base?.height, base?.resource?.height, page.height, page.texture?.height);
      const { bytes, mips, compressed } = textureBytes(base, w, h);
      const pageMb = (bytes / (1024 * 1024)).toFixed(2);
      const contentKey = contentPageKey(page, base) || `atlas:${i}:${w}x${h}`;
      // Pixi 7 fills _glTextures on first draw; a page nothing has drawn yet holds no VRAM.
      const gl = base?._glTextures;
      const uploaded = gl ? Object.keys(gl).length > 0 : null;
      pages.push({
        key: pageKey(page) || contentKey,
        contentKey,
        label: `${i + 1}: ${page.name || 'Page'} (${w}×${h}) ${pageMb} MB${compressed ? ' compressed' : ''}${mips ? ' incl. mips' : ''}${uploaded === false ? ' · not uploaded yet' : ''}`,
        bytes,
        uploaded,
      });
    }
  }
  return { pages, memoryBytes: pages.reduce((sum, page) => sum + page.bytes, 0) };
}

/**
 * @param {{ spine: { skeleton: any, atlas?: any }, atlas?: any }} inst
 */
export function measureInstance(inst) {
  const skeleton = inst.spine.skeleton;
  const atlas = inst.atlas;
  const { pages, memoryBytes } = measureAtlasPages(inst);

  let vertexCount = 0;
  let clippingCount = 0;
  let clippingVertexCount = 0;
  let drawCalls = 0;
  /** @type {string} */
  let lastBatch = '';
  /** @type {Record<string, number>} */
  const blendModes = {};
  const drawOrder = drawOrderSlots(skeleton);
  const atlasData = atlas?.data;
  const textures = atlas?.textures;

  for (let i = 0; i < drawOrder.length; i++) {
    const slot = drawOrder[i];
    const attachment = slot.attachment;
    if (!attachment) continue;
    if (slot.bone && slot.bone.active === false) continue;
    if (slot.color && slot.color.a === 0) continue;
    const kind = attachmentKind(attachment);
    if (kind === 'clip') {
      clippingCount += 1;
      if (attachment.worldVerticesLength) clippingVertexCount += attachment.worldVerticesLength / 2;
      continue;
    }
    if (kind !== 'region' && kind !== 'mesh') continue;

    const bm = slot.blendMode ?? 0;
    const bmName = BLEND_NAMES[bm] || `Mode ${bm}`;
    blendModes[bmName] = (blendModes[bmName] || 0) + 1;
    if (kind === 'region') vertexCount += 4;
    else vertexCount += (attachment.worldVerticesLength || 0) / 2;

    const region = regionOf(atlasData, slot, attachment);
    const base = region ? textures?.get(region.page.name) : null;
    const batch = `${base?.uid ?? region?.page.name ?? ''}|${bm}`;
    if (batch !== lastBatch) {
      drawCalls += 1;
      lastBatch = batch;
    }
  }

  // Exact numbers from the renderer's own walk and batching (skips inactive bones, transparent slots,
  // counts clipped vertices); the walk above stays as the fallback for plain data.
  const exact = countInstanceDraws(inst);
  let triangles = null;
  let textureCount = null;
  let batchBreaks = null;
  let blendSummary = Object.entries(blendModes).filter(([, count]) => count > 0).map(([name, count]) => `${name}: ${count}`).join(', ') || 'None';
  if (exact) {
    vertexCount = exact.vertices;
    drawCalls = exact.drawCalls;
    triangles = exact.triangles;
    textureCount = exact.textures;
    batchBreaks = exact.batchBreaks;
    blendSummary = exact.blends;
  }

  const data = skeleton.data || {};
  const ikCount = (data.ikConstraints || skeleton.ikConstraints || []).length;
  const pathCount = (data.pathConstraints || skeleton.pathConstraints || []).length;
  const transCount = (data.transformConstraints || skeleton.transformConstraints || []).length;
  const physCount = (data.physicsConstraints || skeleton.physicsConstraints || []).length;

  return {
    pages,
    memoryBytes,
    pageInfo: pages.map((page) => page.label),
    vertexCount,
    drawCalls,
    bones: (skeleton.bones || []).length,
    constraints: ikCount + pathCount + transCount + physCount,
    constraintDetail: [
      ikCount ? `IK: ${ikCount}` : '',
      pathCount ? `Path: ${pathCount}` : '',
      transCount ? `Trans: ${transCount}` : '',
      physCount ? `Phys: ${physCount}` : '',
    ].filter(Boolean).join(', '),
    clippingCount,
    clippingVertexCount,
    blends: blendSummary,
    /** Null when counted by the fallback walk. */
    triangles,
    textures: textureCount,
    batchBreaks,
    exact: !!exact,
  };
}

/**
 * @param {ReturnType<typeof measureInstance>[]} rows
 */
export function sumPerf(rows) {
  const total = {
    memoryBytes: 0,
    pageInfo: /** @type {string[]} */ ([]),
    vertexCount: 0,
    drawCalls: 0,
    bones: 0,
    constraints: 0,
    constraintDetail: '',
    clippingCount: 0,
    clippingVertexCount: 0,
    blends: '',
  };
  /** @type {Record<string, number>} */
  const blends = {};
  const seenPages = new Set();
  for (const row of rows) {
    for (const page of row.pages || []) {
      if (seenPages.has(page.key)) continue;
      seenPages.add(page.key);
      total.memoryBytes += page.bytes;
      total.pageInfo.push(page.label.replace(/^\d+:/, `${total.pageInfo.length + 1}:`));
    }
    total.vertexCount += row.vertexCount;
    total.drawCalls += row.drawCalls;
    total.bones += row.bones;
    total.constraints += row.constraints;
    total.clippingCount += row.clippingCount;
    total.clippingVertexCount += row.clippingVertexCount;
    for (const part of row.blends.split(', ')) {
      const splitAt = part.lastIndexOf(': ');
      if (splitAt < 0) continue;
      const name = part.slice(0, splitAt);
      const count = part.slice(splitAt + 2);
      if (!name || name === 'None') continue;
      blends[name] = (blends[name] || 0) + Number(count || 0);
    }
  }
  total.blends = Object.entries(blends).map(([name, count]) => `${name}: ${count}`).join(', ') || 'None';
  total.constraintDetail = rows.map((row) => row.constraintDetail).filter(Boolean).join(' | ');
  return total;
}

/**
 * @param {{ pages: { key: string, contentKey: string, label: string, bytes: number }[] }[]} rows
 */
export function sumAtlasByContentKey(rows) {
  const seen = new Set();
  let memoryBytes = 0;
  /** @type {string[]} */
  const pageInfo = [];
  for (const row of rows) {
    for (const page of row.pages || []) {
      const ck = page.contentKey || page.key;
      if (seen.has(ck)) continue;
      seen.add(ck);
      memoryBytes += page.bytes;
      pageInfo.push(page.label.replace(/^\d+:/, `${pageInfo.length + 1}:`));
    }
  }
  return { memoryBytes, pageCount: seen.size, pageInfo };
}

/**
 * What one skeleton's atlas costs on top of the skeletons below it in z-order.
 * Pages are compared by GPU texture: the same texture object costs nothing again (`shared`),
 * while the same image file uploaded a second time (separate import) costs its full size again (`duplicate`).
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {import('../app/sceneStore.js').SpineInstance[]} instances
 */
export function marginalAtlasBytesForInstance(inst, instances) {
  const ordered = [...instances].sort((a, b) => a.zIndex - b.zIndex);
  const priorGpu = new Set();
  const priorContent = new Set();
  const perf = measureAtlasPages(inst);
  const localBytes = perf.memoryBytes;
  let marginalBytes = 0;
  let sharedPageCount = 0;
  let duplicatePageCount = 0;
  let duplicateBytes = 0;

  let found = false;
  for (const item of ordered) {
    const row = item.id === inst.id ? perf : measureAtlasPages(item);
    if (item.id === inst.id) {
      found = true;
      for (const page of row.pages) {
        if (priorGpu.has(page.key)) {
          sharedPageCount += 1;
          continue;
        }
        marginalBytes += page.bytes;
        if (priorContent.has(page.contentKey || page.key)) {
          duplicatePageCount += 1;
          duplicateBytes += page.bytes;
        }
      }
      break;
    }
    for (const page of row.pages) {
      priorGpu.add(page.key);
      priorContent.add(page.contentKey || page.key);
    }
  }
  if (!found) {
    marginalBytes = localBytes;
  }

  return {
    localBytes,
    /** Bytes this skeleton adds to GPU memory (new textures, including duplicate uploads). */
    marginalBytes,
    pageCount: perf.pages.length,
    /** Pages that are the same GPU texture as a lower skeleton's: free. */
    sharedPageCount,
    /** Pages whose image file is already on the GPU from another import: uploaded again, wasted. */
    duplicatePageCount,
    duplicateBytes,
  };
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance[]} instances
 */
export function sceneAtlasMemorySummary(instances) {
  const rows = instances.map((item) => measureAtlasPages(item));
  /** @type {Map<string, number>} */
  const gpu = new Map();
  for (const row of rows) for (const page of row.pages) if (!gpu.has(page.key)) gpu.set(page.key, page.bytes);
  const byContent = sumAtlasByContentKey(rows);
  return {
    instanceCount: instances.length,
    /** Unique GPU textures (same upload / shared atlas object). */
    gpuUniqueBytes: [...gpu.values()].reduce((sum, bytes) => sum + bytes, 0),
    gpuUniquePageCount: gpu.size,
    /** Unique atlas image files on stage (name + size), even if uploaded multiple times. */
    contentUniqueBytes: byContent.memoryBytes,
    contentUniquePageCount: byContent.pageCount,
    /** Sum per skeleton without deduplication — upper bound if every import uploads separately. */
    stackedBytes: rows.reduce((sum, row) => sum + row.memoryBytes, 0),
    /** Unique textures nothing has drawn yet (Pixi uploads on first draw). */
    notUploadedPageCount: new Set(rows.flatMap((row) => row.pages.filter((p) => p.uploaded === false).map((p) => p.key))).size,
  };
}
