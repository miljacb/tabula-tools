import { DEFAULT_GRID_SIZE } from '../constants.js';

/**
 * @typedef {Object} SpineInstance
 * @property {string} id
 * @property {string} name
 * @property {string} assetKey
 * @property {string} assetId
 * @property {any} spine
 * @property {any} atlas
 * @property {number} zIndex
 * @property {boolean} visible
 * @property {boolean} locked
 * @property {Set<string>} skins
 * @property {Record<number, string>} tracks
 * @property {string | null} selectedSlot
 * @property {string | null} selectedBone
 * @property {number} selectedTrack
 * @property {boolean} pulse
 * @property {number} maskColorIndex
 * @property {string | null} lastAnimationName
 * @property {boolean} holdSetup
 * @property {boolean} playing
 * @property {boolean} stageAnimations
 * @property {number} playbackSpeed
 * @property {Record<number, boolean>} trackLoop
 * @property {Record<number, string>} [trackMode] 'loop' | 'once' | 'pingpong' | 'reverse'
 * @property {Set<string>} hiddenSlots
 * @property {InstanceBaseline | undefined} baseline
 */

/**
 * @typedef {Object} InstanceBaseline
 * @property {{ x: number, y: number, rotation: number, scaleX: number, scaleY: number }} transform
 * @property {number} zIndex
 * @property {boolean} visible
 * @property {boolean} locked
 * @property {boolean} stageAnimations
 * @property {string[]} skins
 * @property {Record<number, string>} tracks
 */

/**
 * @typedef {Object} SceneState
 * @property {SpineInstance[]} instances
 * @property {string | null} selectedId
 * @property {Set<string>} selectedIds
 * @property {{ x: number, y: number, zoom: number }} camera
 * @property {boolean} snapEnabled
 * @property {boolean} gridEnabled
 * @property {number} gridSize
 * @property {boolean} playing
 * @property {'selected' | 'all'} perfScope
 * @property {boolean} scrubbing
 */

/** @type {SceneState} */
export const scene = {
  instances: [],
  selectedId: null,
  selectedIds: new Set(),
  camera: { x: 0, y: 0, zoom: 1 },
  snapEnabled: true,
  gridEnabled: false,
  gridSize: DEFAULT_GRID_SIZE,
  playing: false,
  perfScope: 'selected',
  scrubbing: false,
};

/** @type {Set<() => void>} */
const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit() {
  for (const listener of listeners) listener();
}

/** Primary (last) selected instance — drives slots/skins/animations readout. */
export function selected() {
  if (!scene.selectedId) return null;
  return scene.instances.find((inst) => inst.id === scene.selectedId) || null;
}

/** Selected instances in z-order (back to front). */
export function selectedInstances() {
  if (!scene.selectedIds.size) return [];
  return scene.instances
    .filter((inst) => scene.selectedIds.has(inst.id))
    .sort((a, b) => a.zIndex - b.zIndex);
}

/** @param {string} id */
export function isInstanceSelected(id) {
  return scene.selectedIds.has(id);
}

export function selectionCount() {
  return scene.selectedIds.size;
}

export function resetScene() {
  scene.instances = [];
  scene.selectedId = null;
  scene.selectedIds = new Set();
  scene.playing = false;
  emit();
}

/** @param {SpineInstance} inst @param {{ skipSelect?: boolean }} [options] */
export function addInstance(inst, options = {}) {
  scene.instances.push(inst);
  if (!options.skipSelect) {
    scene.selectedId = inst.id;
    scene.selectedIds = new Set([inst.id]);
  }
  emit();
}

/** @param {string} id */
export function removeInstance(id) {
  const index = scene.instances.findIndex((inst) => inst.id === id);
  if (index < 0) return null;
  const [inst] = scene.instances.splice(index, 1);
  scene.selectedIds.delete(id);
  if (scene.selectedId === id) {
    const remaining = selectedInstances();
    scene.selectedId = remaining.length ? remaining[remaining.length - 1].id : null;
    if (!scene.selectedId) {
      scene.selectedId = scene.instances[index]?.id || scene.instances[index - 1]?.id || null;
      if (scene.selectedId) scene.selectedIds.add(scene.selectedId);
    }
  }
  if (!scene.selectedIds.size && scene.selectedId) {
    scene.selectedIds.add(scene.selectedId);
  }
  emit();
  return inst;
}

/**
 * @param {string | null} id
 * @param {{ additive?: boolean }} [options]
 */
export function selectInstance(id, options = {}) {
  const additive = !!options.additive;
  if (!id) {
    scene.selectedId = null;
    scene.selectedIds = new Set();
    emit();
    return;
  }
  if (additive) {
    const next = new Set(scene.selectedIds);
    if (next.has(id)) {
      next.delete(id);
      let primary = scene.selectedId;
      if (primary === id) {
        const ordered = scene.instances.filter((inst) => next.has(inst.id));
        primary = ordered.length ? ordered[ordered.length - 1].id : null;
      }
      scene.selectedIds = next;
      scene.selectedId = primary;
    } else {
      next.add(id);
      scene.selectedIds = next;
      scene.selectedId = id;
    }
  } else {
    scene.selectedId = id;
    scene.selectedIds = new Set([id]);
  }
  emit();
}

/**
 * @param {string[]} ids
 * @param {{ additive?: boolean }} [options]
 */
export function selectInstances(ids, options = {}) {
  const additive = !!options.additive;
  const unique = [...new Set(ids)];
  if (!additive) {
    if (!unique.length) {
      scene.selectedId = null;
      scene.selectedIds = new Set();
    } else {
      scene.selectedId = unique[unique.length - 1];
      scene.selectedIds = new Set(unique);
    }
    emit();
    return;
  }
  const next = new Set(scene.selectedIds);
  for (const id of unique) next.add(id);
  scene.selectedIds = next;
  if (unique.length) scene.selectedId = unique[unique.length - 1];
  emit();
}

/**
 * @param {string} id
 * @param {number} direction 1 forward, -1 backward
 */
export function shiftZ(id, direction) {
  const ordered = [...scene.instances].sort((a, b) => a.zIndex - b.zIndex);
  const index = ordered.findIndex((inst) => inst.id === id);
  const swap = ordered[index + direction];
  if (!swap) return;
  const z = ordered[index].zIndex;
  ordered[index].zIndex = swap.zIndex;
  swap.zIndex = z;
  if (ordered[index].zIndex === swap.zIndex) {
    ordered[index].zIndex += direction;
  }
  for (const inst of scene.instances) inst.spine.zIndex = inst.zIndex;
  emit();
}

/**
 * List order is back to front. `toId` is the row the dragged item is dropped on.
 * @param {string} fromId
 * @param {string} toId
 */
export function reorderInstances(fromId, toId) {
  const ordered = [...scene.instances].sort((a, b) => a.zIndex - b.zIndex);
  const from = ordered.findIndex((inst) => inst.id === fromId);
  const to = ordered.findIndex((inst) => inst.id === toId);
  if (from < 0 || to < 0 || from === to) return;
  const [item] = ordered.splice(from, 1);
  ordered.splice(to, 0, item);
  ordered.forEach((inst, index) => {
    inst.zIndex = index;
    inst.spine.zIndex = index;
  });
  emit();
}

/** @param {'selected' | 'all'} scope */
export function setPerfScope(scope) {
  scene.perfScope = scope;
  emit();
}
