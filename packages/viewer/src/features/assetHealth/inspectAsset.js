import {
  bandForScore,
  buildExportScoreTip,
  buildOverallScoreTip,
  buildRuntimeScoreTip,
  combineOverall,
  pickBestWorstSampledAnimations,
  resolveAssetRuntimeScore,
  scoreFromFindings,
  summarize,
} from './grade.js';
import { lintAllAnimationsExport, lintAnimationExport, normalizeAnimationsJson } from './rules/exportAnimations.js';
import { lintAtlasExport } from './rules/exportAtlas.js';
import { lintSkeletonExport } from './rules/exportSkeleton.js';
import { measureSetupPose, runtimeFindingsFromPerf } from './rules/runtimePillars.js';
import { sampleAllAnimations } from './rules/sampleAnimations.js';
import { scene } from '../../app/sceneStore.js';

/** @typedef {import('./types.js').HealthReport} HealthReport */

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {{ skeletonJson: object | null, atlasText?: string, assetKey: string, assetId: string }} asset
 * @param {import('../app/sceneStore.js').SpineInstance[]} [sceneInstances]
 */
export function inspectAsset(inst, asset, sceneInstances) {
  /** @type {import('./types.js').HealthFinding[]} */
  const findings = [];

  const onStage = sceneInstances ?? scene.instances;
  // Export checks read the Spine JSON; a compiled (.tbin) skeleton from an export has none.
  const json = asset.skeletonJson;
  if (json) findings.push(...lintSkeletonExport(json));
  else {
    findings.push({
      id: 'compiled-export',
      level: 'info',
      category: 'export.meta',
      title: 'Compiled export',
      detail: 'Export data checks read the skeleton JSON, so they are skipped for compiled skeletons. Runtime numbers come from the compiled data.',
    });
  }
  const atlasLint = lintAtlasExport(inst, onStage);
  findings.push(...atlasLint.findings);
  const animationsJson = json ? normalizeAnimationsJson(json) : null;
  if (animationsJson) findings.push(...lintAllAnimationsExport(animationsJson));

  const setupPerf = measureSetupPose(inst);
  findings.push(...runtimeFindingsFromPerf(setupPerf, 'setup pose'));

  const animRows = sampleAllAnimations(inst);

  for (const row of animRows) {
    if (!animationsJson) continue;
    const lint = lintAnimationExport(animationsJson, row.name, row.duration);
    findings.push(...lint.findings);
    row.exportFindings = lint.findings;
    row.stats = lint.stats ?? null;
    row.exportWarns = lint.warn;
    row.exportFails = lint.fail;
    row.exportFindingTips = lint.findings
      .filter((f) => f.level === 'warn' || f.level === 'fail')
      .map((f) => `${f.title}: ${f.detail}`);
  }

  const exportFindings = findings.filter((f) => f.category.startsWith('export.'));
  const runtimeFindings = findings.filter((f) => f.category.startsWith('runtime.'));

  const { score: exportScore, breakdown: breakdownExport } = scoreFromFindings(exportFindings);
  const setupRuntimeScore = scoreFromFindings(runtimeFindings).score;
  const runtimeScore = resolveAssetRuntimeScore(animRows, setupRuntimeScore);
  const { bestAnimation, worstAnimation } = pickBestWorstSampledAnimations(animRows);

  const breakdownRuntime = scoreFromFindings(runtimeFindings).breakdown;
  const data = inst.spine.skeleton?.data || {};
  const overallScore = combineOverall(runtimeScore, exportScore);
  const scoreTips = {
    overall: buildOverallScoreTip(runtimeScore, exportScore),
    runtime: buildRuntimeScoreTip(animRows, setupRuntimeScore, runtimeScore, worstAnimation),
    export: buildExportScoreTip(exportFindings, exportScore),
  };

  return {
    assetKey: asset.assetKey,
    assetId: asset.assetId,
    scannedAt: Date.now(),
    overallScore,
    runtimeScore,
    exportScore,
    band: bandForScore(overallScore),
    summary: summarize(findings),
    breakdownExport,
    breakdownRuntime,
    findings,
    animations: animRows,
    bestAnimation,
    worstAnimation,
    state: 'done',
    atlas: atlasLint.atlas,
    scoreTips,
    setupRuntimeScore,
    setup: {
      bones: setupPerf.bones,
      slots: (data.slots || inst.spine.skeleton?.slots || []).length,
      vertexCount: setupPerf.vertexCount,
      drawCalls: setupPerf.drawCalls,
      clippingCount: setupPerf.clippingCount,
      constraints: setupPerf.constraints,
      constraintDetail: setupPerf.constraintDetail || '',
      blends: setupPerf.blends || 'None',
      animationCount: animRows.length,
      skinCount: (data.skins || []).length,
    },
  };
}

/** @param {HealthReport} report */
export function exportHealthReportJson(report) {
  return JSON.stringify({
    schemaVersion: 1,
    assetKey: report.assetKey,
    assetId: report.assetId,
    scannedAt: report.scannedAt,
    overallScore: report.overallScore,
    runtimeScore: report.runtimeScore,
    exportScore: report.exportScore,
    band: report.band,
    summary: report.summary,
    animations: report.animations,
    bestAnimation: report.bestAnimation,
    worstAnimation: report.worstAnimation,
    findings: report.findings.map((f) => ({
      level: f.level,
      category: f.category,
      title: f.title,
      detail: f.detail,
    })),
    atlas: report.atlas ?? undefined,
  }, null, 2);
}
