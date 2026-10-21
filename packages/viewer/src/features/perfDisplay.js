import {
  marginalAtlasBytesForInstance,
  measureInstance,
  sceneAtlasMemorySummary,
} from './perf.js';

/** @param {number} bytes */
export function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

/**
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
    const primary = `~${formatMb(sum.gpuUniqueBytes)} MB GPU (${sum.gpuUniquePageCount} texture${sum.gpuUniquePageCount === 1 ? '' : 's'})`;
    const parts = [];
    if (onStage.length > 1) {
      parts.push(`~${formatMb(sum.contentUniqueBytes)} MB unique atlas file(s) (${sum.contentUniquePageCount})`);
      if (sum.stackedBytes > sum.contentUniqueBytes + 512 * 1024) {
        parts.push(`~${formatMb(sum.stackedBytes)} MB stacked`);
      }
    }
    return { primary, secondary: parts.join(' · ') };
  }

  const inst = selected;
  if (!inst) {
    return { primary: '—', secondary: 'Select a skeleton' };
  }

  const marginal = marginalAtlasBytesForInstance(inst, onStage);
  const primary = `~${formatMb(marginal.localBytes)} MB local (${marginal.pageCount} page${marginal.pageCount === 1 ? '' : 's'})`;
  const parts = [];
  if (onStage.length > 1) {
    parts.push(`~${formatMb(marginal.marginalBytes)} MB unique on stage`);
    if (marginal.sharedPageCount > 0) {
      parts.push(`${marginal.sharedPageCount} page(s) shared`);
    }
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
    const perf = measureInstance(inst);
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
      if (gpus > 1) note = ` · ${skel} skeleton(s), ${gpus} GPU uploads`;
      else if (skel > 1) note = ` · shared by ${skel} skeleton(s)`;
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
  const contentMb = formatMb(summary.contentUniqueBytes);
  const gpuMb = formatMb(summary.gpuUniqueBytes);
  const parts = [
    `~${contentMb} MB unique by file (${summary.contentUniquePageCount} page(s)), ~${gpuMb} MB unique GPU (${summary.gpuUniquePageCount} texture(s)).`,
  ];
  if (summary.stackedBytes > summary.contentUniqueBytes + 512 * 1024) {
    parts.push(`Stacked per-skeleton total ~${formatMb(summary.stackedBytes)} MB when imports re-upload textures.`);
  }
  if (inst && allInstances.length) {
    const m = marginalAtlasBytesForInstance(inst, allInstances);
    parts.push(`This asset: ~${formatMb(m.localBytes)} MB local, ~${formatMb(m.marginalBytes)} MB unique on stage (live).`);
    if (m.sharedPageCount > 0) {
      parts.push(`${m.sharedPageCount} atlas page(s) shared with an earlier skeleton (z-order).`);
    }
  }
  return parts.join(' ');
}
