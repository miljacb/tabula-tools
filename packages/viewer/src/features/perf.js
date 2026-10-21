import { attachmentKind, drawOrderSlots, regionOf } from '../tabula/geometry.js';

const BLEND_NAMES = ['Normal', 'Additive', 'Multiply', 'Screen'];

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
 * Pixi uploads WebP as uncompressed pixels. Power-of-two images also get a mip chain (~4/3).
 * @param {object | null} base
 * @param {number} width
 * @param {number} height
 */
function textureBytes(base, width, height) {
  const format = base?.format;
  const bpp = format === 6407 ? 3 : format === 6406 || format === 6409 || format === 6403 ? 1 : format === 6410 || format === 33319 ? 2 : 4;
  let bytes = width * height * bpp;
  const mode = base?.mipmap;
  const pot = width > 0 && height > 0 && (width & (width - 1)) === 0 && (height & (height - 1)) === 0;
  const mips = mode >= 2 || (mode === 1 && pot);
  if (mips) bytes = Math.round(bytes * 4 / 3);
  return { bytes, mips };
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
 * @param {{ spine: { skeleton: any, atlas?: any }, atlas?: any }} inst
 */
export function measureInstance(inst) {
  const skeleton = inst.spine.skeleton;
  const atlas = inst.atlas;
  /** @type {{ key: string, contentKey: string, label: string, bytes: number }[]} */
  const pages = [];
  if (atlas?.pages?.length) {
    for (let i = 0; i < atlas.pages.length; i++) {
      const page = atlas.pages[i];
      const base = baseOf(page);
      const w = firstSize(base?.realWidth, base?.width, base?.resource?.width, page.width, page.texture?.width);
      const h = firstSize(base?.realHeight, base?.height, base?.resource?.height, page.height, page.texture?.height);
      const { bytes, mips } = textureBytes(base, w, h);
      const pageMb = (bytes / (1024 * 1024)).toFixed(2);
      const contentKey = contentPageKey(page, base) || `atlas:${i}:${w}x${h}`;
      pages.push({
        key: pageKey(page) || contentKey,
        contentKey,
        label: `${i + 1}: ${page.name || 'Page'} (${w}×${h}) ${pageMb} MB${mips ? ' +mips' : ''}`,
        bytes,
      });
    }
  }

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

  const data = skeleton.data || {};
  const ikCount = (data.ikConstraints || skeleton.ikConstraints || []).length;
  const pathCount = (data.pathConstraints || skeleton.pathConstraints || []).length;
  const transCount = (data.transformConstraints || skeleton.transformConstraints || []).length;
  const physCount = (data.physicsConstraints || skeleton.physicsConstraints || []).length;

  return {
    pages,
    memoryBytes: pages.reduce((sum, page) => sum + page.bytes, 0),
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
    blends: Object.entries(blendModes).filter(([, count]) => count > 0).map(([name, count]) => `${name}: ${count}`).join(', ') || 'None',
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
 * @param {ReturnType<typeof measureInstance>[]} rows
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
 * Atlas bytes for one instance that are not already contributed by earlier instances on the stage (by content key).
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {import('../app/sceneStore.js').SpineInstance[]} instances
 */
export function marginalAtlasBytesForInstance(inst, instances) {
  const ordered = [...instances].sort((a, b) => a.zIndex - b.zIndex);
  const priorContent = new Set();
  const perf = measureInstance(inst);
  const localBytes = perf.memoryBytes;
  let marginalBytes = 0;
  let sharedPageCount = 0;

  let found = false;
  for (const item of ordered) {
    const row = item.id === inst.id ? perf : measureInstance(item);
    if (item.id === inst.id) {
      found = true;
      for (const page of row.pages) {
        const ck = page.contentKey || page.key;
        if (priorContent.has(ck)) sharedPageCount += 1;
        else marginalBytes += page.bytes;
      }
      break;
    }
    for (const page of row.pages) {
      priorContent.add(page.contentKey || page.key);
    }
  }
  if (!found) {
    marginalBytes = localBytes;
  }

  return {
    localBytes,
    marginalBytes,
    pageCount: perf.pages.length,
    sharedPageCount,
  };
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance[]} instances
 */
export function sceneAtlasMemorySummary(instances) {
  const rows = instances.map((item) => measureInstance(item));
  const gpu = sumPerf(rows);
  const byContent = sumAtlasByContentKey(rows);
  return {
    instanceCount: instances.length,
    /** Unique GPU textures (same upload / shared atlas object). */
    gpuUniqueBytes: gpu.memoryBytes,
    gpuUniquePageCount: gpu.pageInfo.length,
    /** Unique atlas image files on stage (name + size), even if uploaded multiple times. */
    contentUniqueBytes: byContent.memoryBytes,
    contentUniquePageCount: byContent.pageCount,
    /** Sum per skeleton without deduplication — upper bound if every import uploads separately. */
    stackedBytes: rows.reduce((sum, row) => sum + row.memoryBytes, 0),
  };
}
