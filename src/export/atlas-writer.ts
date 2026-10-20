/** Writes {@link AtlasData} as Spine 4.x `.atlas` text (the inverse of AtlasParser). */

import type { AtlasData, AtlasPage, AtlasRegion } from 'tabula-pixi/core/types.js';

/** Atlas text for `atlas`: pages in order, each followed by its regions in map order. */
export function writeAtlasText(atlas: AtlasData): string {
  const byPage = new Map<AtlasPage, AtlasRegion[]>(atlas.pages.map((p) => [p, []]));
  for (const region of atlas.regions.values()) {
    const list = byPage.get(region.page);
    if (!list) throw new Error(`Region "${region.name}" refers to a page that is not in the atlas`);
    list.push(region);
  }
  const blocks: string[] = [];
  for (const [page, regions] of byPage) {
    const lines = [page.name, `size:${page.width},${page.height}`, `filter:${page.minFilter},${page.magFilter}`];
    if (page.format !== 'RGBA8888') lines.push(`format:${page.format}`);
    if (page.uWrap === 'Repeat' || page.vWrap === 'Repeat') lines.push(`repeat:${page.uWrap === 'Repeat' ? 'x' : ''}${page.vWrap === 'Repeat' ? 'y' : ''}`);
    if (page.pma) lines.push('pma:true');
    for (const r of regions) {
      lines.push(r.name, `bounds:${r.x},${r.y},${r.width},${r.height}`);
      if (r.offsetX !== 0 || r.offsetY !== 0 || r.originalWidth !== r.width || r.originalHeight !== r.height) {
        lines.push(`offsets:${r.offsetX},${r.offsetY},${r.originalWidth},${r.originalHeight}`);
      }
      if (r.degrees !== 0) lines.push(`rotate:${r.degrees}`);
      if (r.index >= 0) lines.push(`index:${r.index}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n') + '\n';
}
