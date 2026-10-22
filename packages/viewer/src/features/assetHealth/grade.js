import { EXPORT_WEIGHT, RUNTIME_WEIGHT } from './types.js';

/** @typedef {import('./types.js').HealthFinding} HealthFinding */

export const PENALTY = { info: 0, pass: 0, warn: 5, fail: 15 };
export const CATEGORY_CAP = 30;

/**
 * @param {HealthFinding[]} findings
 * @param {string} prefix e.g. 'export' categories match finding.category
 */
export function scoreFromFindings(findings, prefix = '') {
  /** @type {Record<string, number>} */
  const breakdown = {};
  let total = 0;
  for (const f of findings) {
    if (prefix && !f.category.startsWith(prefix)) continue;
    const p = PENALTY[f.level] || 0;
    if (p <= 0) continue;
    breakdown[f.category] = (breakdown[f.category] || 0) + p;
    const cat = breakdown[f.category];
    if (cat > CATEGORY_CAP) breakdown[f.category] = CATEGORY_CAP;
  }
  for (const v of Object.values(breakdown)) total += v;
  return { score: Math.max(0, Math.min(100, 100 - total)), breakdown };
}

/**
 * @param {number} runtimeScore
 * @param {number} exportScore
 */
export function combineOverall(runtimeScore, exportScore) {
  const overall = Math.round(runtimeScore * RUNTIME_WEIGHT + exportScore * EXPORT_WEIGHT);
  return Math.max(0, Math.min(100, overall));
}

/** @param {number} score */
export function bandForScore(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 55) return 'Moderate';
  if (score >= 40) return 'Poor';
  return 'Critical';
}

/**
 * @param {HealthFinding[]} findings
 */
export function summarize(findings) {
  const summary = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const f of findings) {
    if (f.level === 'pass') summary.pass += 1;
    else if (f.level === 'warn') summary.warn += 1;
    else if (f.level === 'fail') summary.fail += 1;
    else summary.info += 1;
  }
  return summary;
}

/**
 * @param {import('./types.js').AnimationHealthRow[]} animRows
 * @param {number} setupRuntimeScore
 */
export function resolveAssetRuntimeScore(animRows, setupRuntimeScore) {
  const sampled = animRows.filter((r) => !r.runtimeSkipped);
  if (!sampled.length) return setupRuntimeScore;
  return Math.min(setupRuntimeScore, ...sampled.map((r) => r.runtimeScore));
}

/**
 * @param {import('./types.js').AnimationHealthRow[]} animRows
 */
export function pickBestWorstSampledAnimations(animRows) {
  const sampled = animRows.filter((r) => !r.runtimeSkipped);
  if (!sampled.length) return { bestAnimation: null, worstAnimation: null };
  const sorted = [...sampled].sort((a, b) => b.runtimeScore - a.runtimeScore);
  return {
    bestAnimation: sorted[0]?.name ?? null,
    worstAnimation: sorted[sorted.length - 1]?.name ?? null,
  };
}

/**
 * @param {number} runtimeScore
 * @param {number} exportScore
 */
export function buildOverallScoreTip(runtimeScore, exportScore) {
  const overall = combineOverall(runtimeScore, exportScore);
  const rPct = Math.round(RUNTIME_WEIGHT * 100);
  const ePct = Math.round(EXPORT_WEIGHT * 100);
  return `Overall ${overall}: ${rPct}% runtime (${runtimeScore}) + ${ePct}% export (${exportScore}). Bands: Excellent 85+, Good 70+, Moderate 55+.`;
}

/**
 * @param {import('./types.js').AnimationHealthRow[]} animRows
 * @param {number} setupRuntimeScore
 * @param {number} assetRuntimeScore
 * @param {string | null} worstAnimation
 */
export function buildRuntimeScoreTip(animRows, setupRuntimeScore, assetRuntimeScore, worstAnimation) {
  const skipped = animRows.filter((r) => r.runtimeSkipped);
  const sampled = animRows.filter((r) => !r.runtimeSkipped);
  const parts = [`Asset runtime score: ${assetRuntimeScore}.`];
  parts.push(`Setup pose: ${setupRuntimeScore}.`);
  if (sampled.length) {
    const worstScore = Math.min(...sampled.map((r) => r.runtimeScore));
    parts.push(`Worst sampled clip${worstAnimation ? ` (“${worstAnimation}”)` : ''}: ${worstScore} (20 Hz sampling).`);
  }
  if (skipped.length) {
    parts.push(
      `${skipped.length} zero-length clip(s) are not included in this score (table shows “50” as not evaluated).`,
    );
  } else if (!sampled.length && !animRows.length) {
    parts.push('No animations; based on setup pose only.');
  }
  return parts.join(' ');
}

/**
 * @param {HealthFinding[]} exportFindings
 * @param {number} exportScore
 */
export function buildExportScoreTip(exportFindings, exportScore) {
  const hits = exportFindings.filter((f) => f.level === 'warn' || f.level === 'fail');
  const parts = [`Export score: ${exportScore} (100 minus penalties for data issues).`];
  if (!hits.length) {
    parts.push('No export warnings or failures.');
  } else {
    parts.push('Main hits:');
    for (const f of hits.slice(0, 10)) {
      parts.push(`• ${f.title}`);
    }
    if (hits.length > 10) parts.push(`…and ${hits.length - 10} more (see Issues).`);
  }
  return parts.join('\n');
}
