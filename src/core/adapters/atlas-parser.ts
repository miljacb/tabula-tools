/**
 * Spine atlas (.atlas) parser, Spine 4.x text format (also reads the legacy
 * 3.x keys `xy`, `size`, `orig`, `offset`).
 *
 * Format: a page starts with its image file name followed by `key:value` page
 * properties; each following non-property line names a region, followed by its
 * properties. Pages are separated by blank lines.
 */

import type { AtlasData, AtlasPage, AtlasRegion } from '../types.js';

/** Parses Spine `.atlas` text into {@link AtlasData}. */
export class AtlasParser {
  /** Parse atlas text. Regions are keyed by name (sequence frames have distinct names in 4.x). */
  parse(content: string): AtlasData {
    const pages: AtlasPage[] = [];
    const regions = new Map<string, AtlasRegion>();
    const lines = content.split(/\r?\n/);

    let page: AtlasPage | null = null;
    let region: AtlasRegion | null = null;
    let expectPage = true;

    const finishRegion = (): void => {
      if (!region) return;
      if (region.originalWidth === 0) region.originalWidth = region.width;
      if (region.originalHeight === 0) region.originalHeight = region.height;
      const key = region.index >= 0 && regions.has(region.name) ? `${region.name}_${region.index}` : region.name;
      regions.set(key, region);
      region = null;
    };

    for (const raw of lines) {
      const line = raw.trim();
      if (line === '') {
        finishRegion();
        expectPage = true;
        continue;
      }
      const colon = line.indexOf(':');
      if (colon < 0) {
        finishRegion();
        if (expectPage) {
          page = createPage(line);
          pages.push(page);
          expectPage = false;
        } else {
          if (!page) throw new Error(`Atlas region "${line}" before any page`);
          region = createRegion(line, page);
        }
        continue;
      }
      const key = line.slice(0, colon).trim();
      const values = line.slice(colon + 1).split(',').map((v) => v.trim());
      if (region) parseRegionProperty(region, key, values);
      else if (page) parsePageProperty(page, key, values);
    }
    finishRegion();
    return { pages, regions };
  }
}

function createPage(name: string): AtlasPage {
  return {
    name,
    width: 0,
    height: 0,
    format: 'RGBA8888',
    minFilter: 'Linear',
    magFilter: 'Linear',
    uWrap: 'ClampToEdge',
    vWrap: 'ClampToEdge',
    pma: false,
  };
}

function createRegion(name: string, page: AtlasPage): AtlasRegion {
  return {
    name,
    page,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    degrees: 0,
    offsetX: 0,
    offsetY: 0,
    originalWidth: 0,
    originalHeight: 0,
    index: -1,
  };
}

function parsePageProperty(page: AtlasPage, key: string, v: string[]): void {
  switch (key) {
    case 'size':
      page.width = parseInt(v[0]!, 10);
      page.height = parseInt(v[1]!, 10);
      break;
    case 'format':
      page.format = v[0]!;
      break;
    case 'filter':
      page.minFilter = v[0]!;
      page.magFilter = v[1] ?? v[0]!;
      break;
    case 'repeat':
      page.uWrap = v[0]!.includes('x') ? 'Repeat' : 'ClampToEdge';
      page.vWrap = v[0]!.includes('y') ? 'Repeat' : 'ClampToEdge';
      break;
    case 'pma':
      page.pma = v[0] === 'true';
      break;
  }
}

function parseRegionProperty(region: AtlasRegion, key: string, v: string[]): void {
  const n = v.map((s) => parseInt(s, 10));
  switch (key) {
    case 'bounds':
      [region.x, region.y, region.width, region.height] = [n[0]!, n[1]!, n[2]!, n[3]!];
      break;
    case 'offsets':
      [region.offsetX, region.offsetY, region.originalWidth, region.originalHeight] = [n[0]!, n[1]!, n[2]!, n[3]!];
      break;
    case 'rotate':
      region.degrees = v[0] === 'true' ? 90 : v[0] === 'false' ? 0 : n[0]!;
      break;
    case 'index':
      region.index = n[0]!;
      break;
    // Legacy 3.x keys.
    case 'xy':
      [region.x, region.y] = [n[0]!, n[1]!];
      break;
    case 'size':
      [region.width, region.height] = [n[0]!, n[1]!];
      break;
    case 'orig':
      [region.originalWidth, region.originalHeight] = [n[0]!, n[1]!];
      break;
    case 'offset':
      [region.offsetX, region.offsetY] = [n[0]!, n[1]!];
      break;
  }
}
