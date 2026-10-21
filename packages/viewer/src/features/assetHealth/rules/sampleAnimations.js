import { measureInstance } from '../../perf.js';
import { currentTrackEntry } from '../../../tabula/skeletonAccess.js';
import { scoreFromFindings } from '../grade.js';
import { applyAnimationPose, applySetupPose } from '../spinePose.js';
import { runtimeFindingsFromPerf } from './runtimePillars.js';

/** @typedef {import('../types.js').AnimationHealthRow} AnimationHealthRow */

export const SAMPLE_HZ = 20;
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
        runtimeSkipped: true,
        runtimeScoreTip:
          'Duration 0s — runtime was not sampled (nothing to play). Score 50 is a neutral placeholder, not a pass or fail. Export checks for this clip are shown in the Export column.',
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
    let maxDraw = 0;
    let maxVerts = 0;
    /** @type {import('../types.js').HealthFinding[]} */
    let worstFindings = [];

    for (let i = 0; i <= sampleCount; i++) {
      const t = Math.min(duration, i * (duration / sampleCount));
      if (entry) entry.trackTime = t;
      applyAnimationPose(inst);
      const perf = measureInstance(inst);
      maxDraw = Math.max(maxDraw, perf.drawCalls);
      maxVerts = Math.max(maxVerts, perf.vertexCount);
      const findings = runtimeFindingsFromPerf(perf, `t=${t.toFixed(2)}s`);
      const { score } = scoreFromFindings(findings.filter((f) => f.category.startsWith('runtime.')));
      if (!worstFindings.length || score < scoreFromFindings(worstFindings).score) {
        worstFindings = findings;
      }
    }

    const runtimeOnly = worstFindings.filter((f) => f.category.startsWith('runtime.'));
    const { score: runtimeScore } = scoreFromFindings(runtimeOnly);
    const hotIssues = runtimeOnly.filter((f) => f.level === 'warn' || f.level === 'fail');
    /** @type {string} */
    let runtimeScoreTip;
    if (!hotIssues.length) {
      runtimeScoreTip =
        `Sampled at ${SAMPLE_HZ} Hz (${sampleCount + 1} poses). Worst frame: ${maxDraw} draw calls, ${maxVerts} vertices. No runtime warnings at the hottest sample.`;
    } else {
      runtimeScoreTip = `Worst sampled frame (${maxDraw} DC, ${maxVerts} verts):\n${hotIssues.map((f) => `${f.title} — ${f.detail}`).join('\n')}`;
    }

    rows.push({
      name: anim.name,
      duration,
      runtimeScore,
      runtimeSkipped: false,
      runtimeScoreTip,
      exportWarns: 0,
      exportFails: 0,
      hotDrawCalls: maxDraw,
      hotVertices: maxVerts,
      exportFindingTips: [],
    });
  }
  } finally {
    restorePlaybackState(inst, saved);
  }
  return rows;
}
