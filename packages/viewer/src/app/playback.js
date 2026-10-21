import { TRACK_COUNT } from '../constants.js';
import { currentTrackEntry } from '../tabula/skeletonAccess.js';

/** Per-track playback modes. `reverse` loops backwards; `pingpong` alternates direction each cycle. */
export const TRACK_MODES = /** @type {const} */ (['loop', 'once', 'pingpong', 'reverse']);
export const TRACK_MODE_LABELS = { loop: 'Loop', once: 'Once', pingpong: 'Ping-pong', reverse: 'Reverse' };

/**
 * The track's mode; older scenes only stored `trackLoop`.
 * @param {import('./sceneStore.js').SpineInstance} inst
 * @param {number} track
 * @returns {'loop' | 'once' | 'pingpong' | 'reverse'}
 */
export function trackModeOf(inst, track) {
  const mode = inst.trackMode?.[track];
  if (mode && /** @type {readonly string[]} */ (TRACK_MODES).includes(mode)) return /** @type {any} */ (mode);
  return inst.trackLoop?.[track] === false ? 'once' : 'loop';
}

/**
 * Set loop and direction on a track entry for a mode.
 * @param {any} entry
 * @param {string} mode
 */
export function applyTrackMode(entry, mode) {
  if (!entry) return;
  entry.loop = mode !== 'once';
  entry.reverse = mode === 'reverse' || (mode === 'pingpong' && isBackwardCycle(entry));
}

/** @param {any} entry */
function isBackwardCycle(entry) {
  const duration = entry.animation?.duration || 0;
  return duration > 0 && Math.floor(entry.trackTime / duration) % 2 === 1;
}

/**
 * Ping-pong flips direction every cycle. Call before each update with the time it will advance: the direction must
 * match the cycle the update lands in, or the frame that crosses a turn is posed backwards for one frame.
 * @param {import('./sceneStore.js').SpineInstance} inst
 * @param {number} delta seconds the update advances (before time scales)
 */
export function updateTrackModes(inst, delta) {
  if (!inst.trackMode) return;
  const state = inst.spine?.state;
  for (let track = 0; track < TRACK_COUNT; track++) {
    if (inst.trackMode[track] !== 'pingpong') continue;
    const entry = currentTrackEntry(state, track);
    if (!entry) continue;
    const next = entry.trackTime + delta * (state.timeScale ?? 1) * (entry.timeScale ?? 1);
    entry.reverse = isBackwardCycle({ animation: entry.animation, trackTime: next });
  }
}

/**
 * Where the track's pose is in the animation (seconds), honouring loop, reverse and ping-pong.
 * @param {any} entry
 */
export function poseTime(entry) {
  const duration = entry?.animation?.duration || 0;
  if (duration <= 0) return 0;
  const time = entry.loop ? entry.trackTime % duration : Math.min(entry.trackTime, duration);
  return entry.reverse ? duration - time : time;
}

/**
 * Put a track's pose at `time` seconds into its animation (inverse of {@link poseTime}).
 * @param {any} entry
 * @param {number} time
 */
export function setPoseTime(entry, time) {
  const duration = entry?.animation?.duration || 0;
  if (duration <= 0) return;
  const clamped = Math.max(0, Math.min(time, duration - 0.0001));
  const local = entry.reverse ? duration - clamped : clamped;
  if (!entry.loop) {
    entry.trackTime = local;
    return;
  }
  // Keep the cycle (ping-pong direction) and only move within it.
  const cycle = Math.floor(entry.trackTime / duration);
  entry.trackTime = cycle * duration + local;
}
