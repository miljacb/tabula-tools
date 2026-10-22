import {
  marginalAtlasBytesForInstance,
  measureAtlasPages,
  sceneAtlasMemorySummary,
} from './perf.js';

/** @param {number} bytes */
export function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

/** @param {number} n @param {string} word */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Atlas VRAM lines for the Performance panel. Sizes are decoded pixels (format bytes per pixel,
 * plus the exact mip chain when mipmaps are on), in MB of 1024 × 1024 bytes.
 * @param {'selected' | 'all'} scope
 * @param {import('../app/sceneStore.js').SpineInstance[]} instances
 * @param {import('../app/sceneStore.js').SpineInstance | null | undefined} selected
 */
export function formatPerfAtlasMemory(scope, instances, selected) {
  const onStage = instances;
  if (!onStage.length) {
    return { primary: '—', secondary: '' };
  }

  if (scope === 'all') {
    const sum = sceneAtlasMemorySummary(onStage);
    const primary = `${formatMb(sum.gpuUniqueBytes)} MB · ${plural(sum.gpuUniquePageCount, 'texture')}`;
    const parts = [];
    const wasted = sum.gpuUniqueBytes - sum.contentUniqueBytes;
    if (wasted > 0) {
      const extra = sum.gpuUniquePageCount - sum.contentUniquePageCount;
      parts.push(`${formatMb(wasted)} MB is ${plural(extra, 'duplicate upload')} of the same image file`);
    }
    if (sum.notUploadedPageCount) parts.push(`${plural(sum.notUploadedPageCount, 'texture')} not drawn yet`);
    return { primary, secondary: parts.join(' · ') };
  }

  const inst = selected;
  if (!inst) {
    return { primary: '—', secondary: 'Select a skeleton' };
  }

  const m = marginalAtlasBytesForInstance(inst, onStage);
  const primary = `${formatMb(m.localBytes)} MB · ${plural(m.pageCount, 'page')}`;
  const parts = [];
  if (onStage.length > 1) {
    parts.push(`adds ${formatMb(m.marginalBytes)} MB to the stage`);
    if (m.sharedPageCount) parts.push(`${m.sharedPageCount} shared with a lower skeleton`);
    if (m.duplicatePageCount) parts.push(`${m.duplicatePageCount} duplicate upload (${formatMb(m.duplicateBytes)} MB)`);
  }
  return { primary, secondary: parts.join(' · ') };
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance[]} instances
 */
export function formatAtlasPageLines(instances) {
  if (!instances.length) return [];

  /** @type {Map<string, { label: string, gpuKeys: Set<string>, instIds: Set<string> }>} */
  const byContent = new Map();
  /** @type {Map<string, { label: string, contentKey: string }>} */
  const byGpu = new Map();

  for (const inst of instances) {
    const perf = measureAtlasPages(inst);
    for (const page of perf.pages) {
      const ck = page.contentKey || page.key;
      let content = byContent.get(ck);
      if (!content) {
        content = {
          label: page.label.replace(/^\d+:\s*/, ''),
          gpuKeys: new Set(),
          instIds: new Set(),
        };
        byContent.set(ck, content);
      }
      content.gpuKeys.add(page.key);
      content.instIds.add(inst.id);
      if (!byGpu.has(page.key)) {
        byGpu.set(page.key, { label: page.label.replace(/^\d+:\s*/, ''), contentKey: ck });
      }
    }
  }

  const multi = instances.length > 1;
  /** @type {string[]} */
  const lines = [];
  let index = 0;
  for (const [, info] of byGpu) {
    index += 1;
    const content = byContent.get(info.contentKey);
    let note = '';
    if (multi && content) {
      const skel = content.instIds.size;
      const gpus = content.gpuKeys.size;
      if (gpus > 1) note = ` · ${gpus} uploads of the same file (${skel} skeletons)`;
      else if (skel > 1) note = ` · shared by ${skel} skeletons`;
    }
    lines.push(`${index}: ${info.label}${note}`);
  }
  return lines;
}

/**
 * @param {ReturnType<typeof sceneAtlasMemorySummary>} summary
 * @param {import('../app/sceneStore.js').SpineInstance} [inst]
 * @param {import('../app/sceneStore.js').SpineInstance[]} [allInstances]
 */
export function sceneVramDescription(summary, inst, allInstances = []) {
  const parts = [
    `${formatMb(summary.gpuUniqueBytes)} MB on the GPU in ${plural(summary.gpuUniquePageCount, 'texture')}.`,
  ];
  const wasted = summary.gpuUniqueBytes - summary.contentUniqueBytes;
  if (wasted > 0) {
    parts.push(`${formatMb(wasted)} MB of that is the same image file uploaded more than once (separate imports); duplicating a skeleton instead of re-importing shares the texture.`);
  }
  if (summary.notUploadedPageCount) {
    parts.push(`${plural(summary.notUploadedPageCount, 'texture')} not drawn yet, so not on the GPU until first shown.`);
  }
  if (inst && allInstances.length) {
    const m = marginalAtlasBytesForInstance(inst, allInstances);
    parts.push(`This skeleton: ${formatMb(m.localBytes)} MB, adds ${formatMb(m.marginalBytes)} MB to the stage.`);
  }
  parts.push('Sizes are decoded pixels (not file size), MB = 1024 × 1024 bytes.');
  return parts.join(' ');
}
