import {
  marginalAtlasBytesForInstance,
  measureInstance,
  sceneAtlasMemorySummary,
} from '../../perf.js';

/** @typedef {import('../types.js').HealthFinding} HealthFinding */

const VRAM_WARN_MB = 16;
const VRAM_FAIL_MB = 32;

/**
 * @param {import('../../../app/sceneStore.js').SpineInstance} inst
 * @param {import('../../../app/sceneStore.js').SpineInstance[]} [sceneInstances]
 */
export function lintAtlasExport(inst, sceneInstances = []) {
  /** @type {HealthFinding[]} */
  const findings = [];
  const perf = measureInstance(inst);
  const localMb = perf.memoryBytes / (1024 * 1024);

  const onStage = sceneInstances.length > 0 ? sceneInstances : [inst];
  const marginal = marginalAtlasBytesForInstance(inst, onStage);
  const marginalMb = marginal.marginalBytes / (1024 * 1024);
  const scene = sceneAtlasMemorySummary(onStage);
  const sceneContentMb = scene.contentUniqueBytes / (1024 * 1024);
  const sceneGpuMb = scene.gpuUniqueBytes / (1024 * 1024);
  const stackedMb = scene.stackedBytes / (1024 * 1024);

  const gradeMb = onStage.length > 1 ? marginalMb : localMb;
  const sharedAll = marginal.sharedPageCount > 0 && marginal.marginalBytes === 0 && marginal.pageCount > 0;

  if (sharedAll) {
    findings.push({
      id: 'export-atlas-shared',
      level: 'info',
      category: 'export.atlas',
      title: 'Atlas textures shared on stage',
      detail: `This skeleton references ${marginal.pageCount} atlas page(s) (~${localMb.toFixed(1)} MB if loaded alone). All of those pages already appear on another skeleton here — count once for the scene (~${sceneContentMb.toFixed(1)} MB unique by file name, ${scene.contentUniquePageCount} page(s)).`,
    });
  } else if (gradeMb >= VRAM_FAIL_MB) {
    findings.push({
      id: 'export-atlas-vram-fail',
      level: 'fail',
      category: 'export.atlas',
      title: 'Very large atlas VRAM estimate',
      detail: formatAtlasDetail(localMb, marginalMb, marginal, scene, sceneContentMb, sceneGpuMb, stackedMb, onStage.length),
    });
  } else if (gradeMb >= VRAM_WARN_MB) {
    findings.push({
      id: 'export-atlas-vram-warn',
      level: 'warn',
      category: 'export.atlas',
      title: 'Large atlas VRAM estimate',
      detail: formatAtlasDetail(localMb, marginalMb, marginal, scene, sceneContentMb, sceneGpuMb, stackedMb, onStage.length),
    });
  } else if (perf.pages.length) {
    findings.push({
      id: 'export-atlas-ok',
      level: 'pass',
      category: 'export.atlas',
      title: 'Atlas size',
      detail: formatAtlasDetail(localMb, marginalMb, marginal, scene, sceneContentMb, sceneGpuMb, stackedMb, onStage.length),
    });
  }

  return {
    findings,
    atlas: {
      localBytes: perf.memoryBytes,
      marginalBytes: marginal.marginalBytes,
      pageCount: perf.pages.length,
      sharedPageCount: marginal.sharedPageCount,
      sceneContentUniqueBytes: scene.contentUniqueBytes,
      sceneGpuUniqueBytes: scene.gpuUniqueBytes,
      sceneStackedBytes: scene.stackedBytes,
    },
  };
}

/**
 * @param {number} localMb
 * @param {number} marginalMb
 * @param {ReturnType<typeof marginalAtlasBytesForInstance>} marginal
 * @param {ReturnType<typeof sceneAtlasMemorySummary>} scene
 * @param {number} sceneContentMb
 * @param {number} sceneGpuMb
 * @param {number} stackedMb
 * @param {number} instanceCount
 */
function formatAtlasDetail(localMb, marginalMb, marginal, scene, sceneContentMb, sceneGpuMb, stackedMb, instanceCount) {
  const parts = [
    `This asset: ~${localMb.toFixed(1)} MB (${marginal.pageCount} page(s))`,
  ];
  if (instanceCount > 1) {
    parts.push(`unique on stage for this skeleton: ~${marginalMb.toFixed(1)} MB`);
    if (marginal.sharedPageCount > 0) {
      parts.push(`${marginal.sharedPageCount} page(s) shared with other skeleton(s)`);
    }
    parts.push(`scene unique by atlas file: ~${sceneContentMb.toFixed(1)} MB (${scene.contentUniquePageCount} page(s))`);
    parts.push(`scene unique GPU upload: ~${sceneGpuMb.toFixed(1)} MB (${scene.gpuUniquePageCount} texture(s))`);
    if (stackedMb > sceneContentMb + 0.5) {
      parts.push(`stacked per-skeleton sum: ~${stackedMb.toFixed(1)} MB (same WebP loaded multiple times)`);
    }
  }
  return `${parts.join('. ')}.`;
}
