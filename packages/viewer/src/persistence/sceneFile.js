const SCHEMA = 1;

/**
 * @param {import('../app/sceneStore.js').SceneState} scene
 */
export function serializeScene(scene) {
  return {
    schemaVersion: SCHEMA,
    camera: { ...scene.camera },
    snapEnabled: scene.snapEnabled,
    gridEnabled: scene.gridEnabled === true,
    gridSize: scene.gridSize || 16,
    playing: scene.playing,
    instances: scene.instances.map((inst) => serializeInstance(inst)),
  };
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
export function serializeInstance(inst) {
  return {
    id: inst.id,
    name: inst.name,
    assetKey: inst.assetKey,
    assetId: inst.assetId,
    transform: {
      x: inst.spine.x,
      y: inst.spine.y,
      rotation: inst.spine.rotation,
      scaleX: inst.spine.scale.x,
      scaleY: inst.spine.scale.y,
    },
    zIndex: inst.zIndex,
    visible: inst.visible,
    locked: inst.locked,
    stageAnimations: inst.stageAnimations !== false,
    skins: [...inst.skins],
    tracks: { ...inst.tracks },
    hiddenSlots: [...(inst.hiddenSlots || [])],
    playbackSpeed: inst.playbackSpeed || 1,
    trackLoop: { ...(inst.trackLoop || {}) },
    trackMode: { ...(inst.trackMode || {}) },
  };
}

/**
 * @param {unknown} value
 */
export function parseSceneFile(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Scene file is not an object.');
  }
  const data = /** @type {Record<string, unknown>} */ (value);
  if (data.schemaVersion !== SCHEMA) {
    throw new Error('Unsupported scene schema.');
  }
  if (!Array.isArray(data.instances)) {
    throw new Error('Scene is missing instances.');
  }
  const camera = data.camera && typeof data.camera === 'object' ? /** @type {Record<string, unknown>} */ (data.camera) : {};
  return {
    schemaVersion: SCHEMA,
    camera: {
      x: numberOr(camera.x, 0),
      y: numberOr(camera.y, 0),
      zoom: numberOr(camera.zoom, 1),
    },
    snapEnabled: data.snapEnabled !== false,
    gridEnabled: data.gridEnabled === true,
    gridSize: numberOr(data.gridSize, 16),
    playing: data.playing !== false,
    instances: data.instances.map((raw) => parseInstance(raw)),
  };
}

/** @param {unknown} raw */
export function parseInstance(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid instance.');
  const inst = /** @type {Record<string, unknown>} */ (raw);
  const transform = inst.transform && typeof inst.transform === 'object'
    ? /** @type {Record<string, unknown>} */ (inst.transform)
    : {};
  const tracks = inst.tracks && typeof inst.tracks === 'object'
    ? /** @type {Record<string, string>} */ (inst.tracks)
    : {};
  const trackLoop = inst.trackLoop && typeof inst.trackLoop === 'object'
    ? /** @type {Record<string, boolean>} */ (inst.trackLoop)
    : {};
  const trackMode = inst.trackMode && typeof inst.trackMode === 'object'
    ? /** @type {Record<string, string>} */ (inst.trackMode)
    : {};
  return {
    id: String(inst.id || ''),
    name: String(inst.name || inst.assetKey || 'spine'),
    assetKey: String(inst.assetKey || ''),
    assetId: String(inst.assetId || ''),
    transform: {
      x: numberOr(transform.x, 0),
      y: numberOr(transform.y, 0),
      rotation: numberOr(transform.rotation, 0),
      scaleX: numberOr(transform.scaleX, 1),
      scaleY: numberOr(transform.scaleY, 1),
    },
    zIndex: numberOr(inst.zIndex, 0),
    visible: inst.visible !== false,
    locked: inst.locked === true,
    stageAnimations: inst.stageAnimations !== false,
    skins: Array.isArray(inst.skins) ? inst.skins.map(String) : [],
    tracks,
    hiddenSlots: Array.isArray(inst.hiddenSlots) ? inst.hiddenSlots.map(String) : [],
    playbackSpeed: numberOr(inst.playbackSpeed, 1),
    trackLoop,
    trackMode,
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function numberOr(value, fallback) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}
