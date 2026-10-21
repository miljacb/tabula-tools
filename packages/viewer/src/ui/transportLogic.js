/**
 * Pure helpers for stage transport / animation targeting (unit-tested).
 * @typedef {{ id: string, playing?: boolean, stageAnimations?: boolean, selectedTrack?: number, spine?: { state?: { getCurrent?: (track: number) => { animation?: unknown } | null, getTrack?: (track: number) => { animation?: unknown } | null } } }} TransportInst
 */

/** @param {TransportInst['spine']} spine @param {number} track */
function trackEntry(spine, track) {
  const state = spine?.state;
  return state?.getCurrent?.(track) ?? state?.getTrack?.(track) ?? null;
}

/** @param {TransportInst[]} instances @param {TransportInst | null} selectedInstance @param {boolean} applyGlobal */
export function resolveAnimTargets(instances, selectedInstance, applyGlobal) {
  if (!selectedInstance) return instances;
  if (applyGlobal) return instances;
  return [selectedInstance];
}

/**
 * @param {{ scenePlaying: boolean, selectedInstance: TransportInst | null, instances: TransportInst[] }} ctx
 */
export function resolveTransportIsPlaying(ctx) {
  const { scenePlaying, selectedInstance, instances } = ctx;
  if (selectedInstance) {
    if (!selectedInstance.playing) return false;
    const track = selectedInstance.selectedTrack || 0;
    return !!trackEntry(selectedInstance.spine, track)?.animation;
  }
  if (!scenePlaying) return false;
  return instances.some((item) => {
    if (!item.playing) return false;
    const track = item.selectedTrack || 0;
    return !!trackEntry(item.spine, track)?.animation;
  });
}

/**
 * @param {TransportInst[]} instances
 * @param {TransportInst | null} selectedInstance
 * @param {boolean} scenePlaying
 */
export function pickTransportInstance(instances, selectedInstance, scenePlaying) {
  if (selectedInstance) return selectedInstance;
  if (!instances.length) return null;
  const withAnim = instances.filter((item) => {
    const track = item.selectedTrack || 0;
    return !!trackEntry(item.spine, track)?.animation;
  });
  const playing = withAnim.find((item) => item.playing)
    || (scenePlaying ? withAnim.find((item) => item.stageAnimations !== false) : undefined);
  return playing || withAnim[0] || instances[0];
}
