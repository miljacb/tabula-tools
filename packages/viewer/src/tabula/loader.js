import * as PIXI from 'pixi.js';
import { createTabulaAsset } from 'tabula-pixi';
import { AtlasParser, SpineJsonParser } from 'tabula-pixi/json';
import { validateSkeleton } from 'tabula-pixi/core/validate.js';

/**
 * @param {string} url
 * @returns {Promise<PIXI.BaseTexture>}
 */
export function loadBaseTexture(url) {
  return new Promise((resolve, reject) => {
    const base = PIXI.BaseTexture.from(url);
    const ok = () => resolve(base);
    if (base.valid) ok();
    else {
      base.once('loaded', ok);
      base.once('error', () => reject(new Error(`Could not load image ${url}`)));
    }
  });
}

/**
 * Same page setup as tabula-pixi's own loaders.
 * @param {PIXI.BaseTexture} base
 * @param {import('tabula-pixi').AtlasPage} page
 */
function configurePage(base, page) {
  if (page.pma) base.alphaMode = PIXI.ALPHA_MODES.PMA;
  base.scaleMode = String(page.magFilter).toLowerCase().includes('linear') ? PIXI.SCALE_MODES.LINEAR : PIXI.SCALE_MODES.NEAREST;
  base.mipmap = String(page.minFilter).toLowerCase().includes('mipmap') ? PIXI.MIPMAP_MODES.ON : PIXI.MIPMAP_MODES.OFF;
}

/**
 * Pages as the perf and health code reads them: name, size and the GPU texture.
 * @param {import('tabula-pixi').AtlasData} atlas
 * @param {Map<string, PIXI.BaseTexture>} textures
 */
export function pageList(atlas, textures) {
  return atlas.pages.map((page) => ({
    name: page.name,
    width: page.width,
    height: page.height,
    texture: { baseTexture: textures.get(page.name) ?? null },
  }));
}

/**
 * The atlas as the perf and health code reads it: pages with their textures, the parsed atlas and the textures by page name.
 * @param {import('tabula-pixi').AtlasData} atlas
 * @param {Map<string, PIXI.BaseTexture>} textures
 */
export function atlasInfo(atlas, textures) {
  return { pages: pageList(atlas, textures), data: atlas, textures, dispose() {} };
}

/**
 * Parse a Spine 4.1 / 4.2 JSON export with its atlas and load the page textures.
 * @param {{ atlasText: string, skeletonJson: unknown, pageUrls: Record<string, string>, name: string }} source
 */
export async function buildTabulaAsset(source) {
  const atlas = new AtlasParser().parse(source.atlasText);
  const data = new SpineJsonParser().parse(source.skeletonJson, source.name);
  const validation = validateSkeleton(data, atlas);
  if (validation.errors.length) throw new Error(`${source.name}: ${validation.errors.join('; ')}`);
  /** @type {Map<string, PIXI.BaseTexture>} */
  const textures = new Map();
  try {
    for (const page of atlas.pages) {
      const url = source.pageUrls[page.name];
      if (!url) throw new Error(`Atlas page "${page.name}" was not in the drop.`);
      const base = await loadBaseTexture(url);
      configurePage(base, page);
      textures.set(page.name, base);
    }
  } catch (error) {
    for (const base of textures.values()) base.destroy();
    throw error;
  }
  const asset = createTabulaAsset(data, atlas, textures);
  return {
    asset,
    data,
    atlasData: atlas,
    atlas: atlasInfo(atlas, textures),
    textures: [...textures.values()],
    warnings: validation.warnings,
  };
}
