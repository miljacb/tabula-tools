import { measureInstance } from '../../perf.js';
import { applySetupPose } from '../spinePose.js';

/** @typedef {import('../types.js').HealthFinding} HealthFinding */

const IDEAL_BONES = 30;
const IDEAL_VERTS = 300;
const IDEAL_DRAW_CALLS = 8;
const IDEAL_CLIPS = 2;

/**
 * @param {number} value
 * @param {number} ideal
 * @param {number} scale
 */
function logPenalty(value, ideal, scale) {
  if (value <= ideal) return 0;
  return Math.log2(value / ideal + 1) * scale;
}

/**
 * @param {ReturnType<typeof measureInstance>} perf
 */
export function runtimeFindingsFromPerf(perf, label = 'setup pose') {
  /** @type {HealthFinding[]} */
  const findings = [];

  const bonePenalty = logPenalty(perf.bones, IDEAL_BONES, 12);
  if (bonePenalty > 8) {
    findings.push({
      id: 'runtime-bones',
      level: 'warn',
      category: 'runtime.bones',
      title: 'Skeleton complexity',
      detail: `${perf.bones} bones at ${label}.`,
    });
  } else {
    findings.push({
      id: 'runtime-bones-ok',
      level: 'pass',
      category: 'runtime.bones',
      title: 'Bone structure',
      detail: `${perf.bones} bones.`,
    });
  }

  if (perf.vertexCount > IDEAL_VERTS * 2) {
    findings.push({
      id: 'runtime-verts',
      level: 'fail',
      category: 'runtime.mesh',
      title: 'High vertex count',
      detail: `${perf.vertexCount} vertices at ${label}.`,
    });
  } else if (perf.vertexCount > IDEAL_VERTS) {
    findings.push({
      id: 'runtime-verts-warn',
      level: 'warn',
      category: 'runtime.mesh',
      title: 'Elevated vertices',
      detail: `${perf.vertexCount} vertices.`,
    });
  } else {
    findings.push({
      id: 'runtime-verts-ok',
      level: 'pass',
      category: 'runtime.mesh',
      title: 'Mesh complexity',
      detail: `${perf.vertexCount} vertices.`,
    });
  }

  if (perf.drawCalls > IDEAL_DRAW_CALLS * 2) {
    findings.push({
      id: 'runtime-drawcalls',
      level: 'fail',
      category: 'runtime.mesh',
      title: 'Many draw calls',
      detail: `${perf.drawCalls} batches at ${label}.`,
    });
  } else if (perf.drawCalls > IDEAL_DRAW_CALLS) {
    findings.push({
      id: 'runtime-drawcalls-warn',
      level: 'warn',
      category: 'runtime.mesh',
      title: 'Elevated draw calls',
      detail: `${perf.drawCalls} batches.`,
    });
  }

  if (perf.clippingCount > IDEAL_CLIPS) {
    findings.push({
      id: 'runtime-clip',
      level: 'warn',
      category: 'runtime.clipping',
      title: 'Clipping masks',
      detail: `${perf.clippingCount} active clip(s).`,
    });
  } else if (perf.clippingCount > 0) {
    findings.push({
      id: 'runtime-clip-ok',
      level: 'pass',
      category: 'runtime.clipping',
      title: 'Clipping',
      detail: `${perf.clippingCount} clip mask(s).`,
    });
  }

  const blends = perf.blends || 'None';
  if (blends !== 'None' && !/^Normal:/.test(blends) && blends.includes(':')) {
    const nonNormal = blends.split(', ').filter((p) => !p.startsWith('Normal:')).length;
    if (nonNormal > 2) {
      findings.push({
        id: 'runtime-blend',
        level: 'warn',
        category: 'runtime.blend',
        title: 'Blend modes',
        detail: blends,
      });
    }
  }

  if (perf.constraints > 0) {
    const level = perf.constraints > 6 ? 'warn' : 'pass';
    findings.push({
      id: 'runtime-constraints',
      level,
      category: 'runtime.constraints',
      title: 'Constraints',
      detail: perf.constraintDetail || `${perf.constraints} constraint(s).`,
    });
  }

  return findings;
}

/**
 * @param {{ spine: any, atlas: any }} inst
 */
export function measureSetupPose(inst) {
  applySetupPose(inst);
  return measureInstance(inst);
}
