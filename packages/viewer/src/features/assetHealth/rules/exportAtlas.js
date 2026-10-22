import {
  marginalAtlasBytesForInstance,
  measureAtlasPages,
  sceneAtlasMemorySummary,
} from '../../perf.js';
import { formatMb } from '../../perfDisplay.js';

/** @typedef {import('../types.js').HealthFinding} HealthFinding */

const MB = 1024 * 1024;
const VRAM_WARN_MB = 16;
const VRAM_FAIL_MB = 32;

/**
 * Atlas VRAM is graded on what this skeleton adds to the GPU: its own size when alone,
 * otherwise only the textures not already uploaded by a lower skeleton in z-order.
 * @param {import('../../../app/sceneStore.js').SpineInstance} inst
 * @param {import('../../../app/sceneStore.js').SpineInstance[]} [sceneInstances]
 */
export function lintAtlasExport(inst, sceneInstances = []) {
  /** @type {HealthFinding[]} */
  const findings = [];
  const perf = measureAtlasPages(inst);
  const onStage = sceneInstances.length > 0 ? sceneInstances : [inst];
  const m = marginalAtlasBytesForInstance(inst, onStage);
  const scene = sceneAtlasMemorySummary(onStage);
  const multi = onStage.length > 1;
  const gradeBytes = multi ? m.marginalBytes : m.localBytes;
  const detail = atlasDetail(m, multi);

  if (m.pageCount && multi && m.sharedPageCount === m.pageCount) {
    findings.push({
      id: 'export-atlas-shared',
      level: 'info',
      category: 'export.atlas',
      title: 'Atlas textures shared on stage',
      detail: `All ${m.pageCount} page(s) (${formatMb(m.localBytes)} MB) are the same GPU textures a lower skeleton already uploaded, so this skeleton adds 0 MB.`,
    });
  } else if (gradeBytes >= VRAM_FAIL_MB * MB) {
    findings.push({ id: 'export-atlas-vram-fail', level: 'fail', category: 'export.atlas', title: 'Very large atlas VRAM', detail });
  } else if (gradeBytes >= VRAM_WARN_MB * MB) {
    findings.push({ id: 'export-atlas-vram-warn', level: 'warn', category: 'export.atlas', title: 'Large atlas VRAM', detail });
  } else if (perf.pages.length) {
    findings.push({ id: 'export-atlas-ok', level: 'pass', category: 'export.atlas', title: 'Atlas size', detail });
  }

  if (m.duplicatePageCount) {
    findings.push({
      id: 'export-atlas-duplicate',
      level: 'warn',
      category: 'export.atlas',
      title: 'Same atlas uploaded twice',
      detail: `${m.duplicatePageCount} page(s) (${formatMb(m.duplicateBytes)} MB) use the same image file as a lower skeleton but are a separate GPU upload.`,
    });
  }

  return {
    findings,
    atlas: {
      localBytes: m.localBytes,
      marginalBytes: m.marginalBytes,
      pageCount: m.pageCount,
      sharedPageCount: m.sharedPageCount,
      duplicatePageCount: m.duplicatePageCount,
      sceneContentUniqueBytes: scene.contentUniqueBytes,
      sceneGpuUniqueBytes: scene.gpuUniqueBytes,
      sceneStackedBytes: scene.stackedBytes,
    },
  };
}

/**
 * @param {ReturnType<typeof marginalAtlasBytesForInstance>} m
 * @param {boolean} multi
 */
function atlasDetail(m, multi) {
  const parts = [`${formatMb(m.localBytes)} MB in ${m.pageCount} page(s)`];
  if (multi) {
    parts.push(`adds ${formatMb(m.marginalBytes)} MB to the stage`);
    if (m.sharedPageCount) parts.push(`${m.sharedPageCount} page(s) shared with a lower skeleton`);
  }
  return `${parts.join(', ')}. Thresholds: warn ${VRAM_WARN_MB} MB, fail ${VRAM_FAIL_MB} MB.`;
}
