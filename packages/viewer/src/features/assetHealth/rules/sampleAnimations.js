import { measureInstance } from '../../perf.js';
import { currentTrackEntry } from '../../../tabula/skeletonAccess.js';
import { scoreFromFindings } from '../grade.js';
import { applyAnimationPose, applySetupPose } from '../spinePose.js';
import { nonNormalBlendCount, runtimeFindingsFromPerf } from './runtimePillars.js';

/** @typedef {import('../types.js').AnimationHealthRow} AnimationHealthRow */

export const SAMPLE_HZ = 20;
/** Long clips are capped, so the effective rate drops below SAMPLE_HZ past 4s. */
export const MAX_SAMPLES_PER_ANIM = 80;

/**
 * @param {import('../../../app/sceneStore.js').SpineInstance} inst
 */
function capturePlaybackState(inst) {
  const state = inst.spine.state;
  /** @type {{ track: number, name: string, loop: boolean, time: number }[]} */
  const tracks = [];
  for (let i = 0; i < 5; i++) {
    const entry = currentTrackEntry(state, i);
    if (!entry?.animation) continue;
    tracks.push({
      track: i,
      name: entry.animation.name,
      loop: entry.loop,
      time: entry.trackTime,
    });
  }
  return { tracks, playing: inst.playing };
}

/**
 * @param {import('../../../app/sceneStore.js').SpineInstance} inst
 * @param {{ tracks: { track: number, name: string, loop: boolean, time: number }[], playing: boolean }} saved
 */
function restorePlaybackState(inst, saved) {
  const state = inst.spine.state;
  state.clearTracks();
  applySetupPose(inst);
  for (const t of saved.tracks) {
    const entry = state.setAnimation(t.track, t.name, t.loop);
    if (entry) entry.trackTime = t.time;
  }
  inst.playing = saved.playing;
  inst.spine.update(0);
}

/**
 * @param {import('../../../app/sceneStore.js').SpineInstance} inst
 * @returns {AnimationHealthRow[]}
 */
export function sampleAllAnimations(inst) {
  const skeleton = inst.spine.skeleton;
  const anims = skeleton.data?.animations || [];
  const saved = capturePlaybackState(inst);
  /** @type {AnimationHealthRow[]} */
  const rows = [];

  try {
  for (const anim of anims) {
    const duration = anim.duration || 0;
    if (duration <= 0) {
      rows.push({
        name: anim.name,
        duration: 0,
        runtimeScore: 50,
        samples: 0,
        runtimeFindings: [],
        runtimeSkipped: true,
        runtimeScoreTip:
          'Duration 0s — nothing to play, so runtime was not sampled and the clip does not affect the score.',
        exportWarns: 0,
        exportFails: 0,
        hotDrawCalls: 0,
        hotVertices: 0,
        exportFindingTips: [],
      });
      continue;
    }

    inst.spine.state.clearTracks();
    applySetupPose(inst);
    const entry = inst.spine.state.setAnimation(0, anim.name, false);
    const step = 1 / SAMPLE_HZ;
    const sampleCount = Math.min(MAX_SAMPLES_PER_ANIM, Math.max(1, Math.ceil(duration / step)));
    /** Per-metric peaks across all sampled poses; the clip is scored on this combined worst case. */
    let peak = null;
    let peakNonNormal = -1;

    for (let i = 0; i <= sampleCount; i++) {
      const t = Math.min(duration, i * (duration / sampleCount));
      if (entry) entry.trackTime = t;
      applyAnimationPose(inst);
      const perf = measureInstance(inst);
      const nonNormal = nonNormalBlendCount(perf.blends);
      if (!peak) {
        peak = { ...perf };
        peakNonNormal = nonNormal;
        continue;
      }
      peak.vertexCount = Math.max(peak.vertexCount, perf.vertexCount);
      peak.drawCalls = Math.max(peak.drawCalls, perf.drawCalls);
      peak.clippingCount = Math.max(peak.clippingCount, perf.clippingCount);
      if (nonNormal > peakNonNormal) {
        peak.blends = perf.blends;
        peakNonNormal = nonNormal;
      }
    }

    const runtimeFindings = runtimeFindingsFromPerf(peak, 'peak');
    const { score: runtimeScore } = scoreFromFindings(runtimeFindings);
    const hotIssues = runtimeFindings.filter((f) => f.level === 'warn' || f.level === 'fail');
    const rate = (sampleCount / duration).toFixed(sampleCount / duration < 10 ? 1 : 0);
    const head = `${sampleCount + 1} poses (~${rate} Hz). Peak: ${peak.drawCalls} draw calls, ${peak.vertexCount} vertices.`;
    const runtimeScoreTip = hotIssues.length
      ? `${head}\n${hotIssues.map((f) => `${f.title} — ${f.detail}`).join('\n')}`
      : `${head} No runtime warnings.`;

    rows.push({
      name: anim.name,
      duration,
      runtimeScore,
      runtimeSkipped: false,
      runtimeScoreTip,
      exportWarns: 0,
      exportFails: 0,
      hotDrawCalls: peak.drawCalls,
      hotVertices: peak.vertexCount,
      peakClipping: peak.clippingCount,
      samples: sampleCount + 1,
      runtimeFindings,
      exportFindingTips: [],
    });
  }
  } finally {
    restorePlaybackState(inst, saved);
  }
  return rows;
}
