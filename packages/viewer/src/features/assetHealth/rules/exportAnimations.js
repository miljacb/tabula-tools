/** @typedef {import('../types.js').HealthFinding} HealthFinding */

/**
 * Spine 3.x exports may use an animations array; 4.x uses a name → data map.
 * @param {object | null | undefined} skeletonJson
 * @returns {Record<string, Record<string, unknown>>}
 */
export function normalizeAnimationsJson(skeletonJson) {
  const raw = skeletonJson?.animations;
  if (!raw) return {};
  if (Array.isArray(raw)) {
    /** @type {Record<string, Record<string, unknown>>} */
    const out = {};
    for (const anim of raw) {
      if (anim && typeof anim === 'object' && typeof anim.name === 'string') {
        out[anim.name] = anim;
      }
    }
    return out;
  }
  if (typeof raw === 'object') return /** @type {Record<string, Record<string, unknown>>} */ (raw);
  return {};
}

/** Below this duration, keys/s is meaningless (instant / single-frame clips). */
const MIN_DURATION_FOR_KPS = 1 / 60;

const THRESHOLDS = {
  keysPerSecondWarn: 40,
  keysPerSecondFail: 80,
  deformKeysWarn: 200,
  deformKeysFail: 600,
  attachmentSwitchesWarn: 30,
  drawOrderKeysWarn: 20,
};

/**
 * @param {unknown} arr
 */
function keyframeCount(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  const first = arr[0];
  if (first && typeof first === 'object' && 'time' in first) return arr.length;
  return Math.ceil(arr.length / 2);
}

/**
 * @param {Record<string, unknown>} animBlock
 */
export function countAnimationJsonStats(animBlock) {
  let keys = 0;
  let deformKeys = 0;
  let attachmentSwitches = 0;
  let drawOrderKeys = 0;
  let events = 0;

  const bones = animBlock.bones;
  if (bones && typeof bones === 'object') {
    for (const bone of Object.values(bones)) {
      if (!bone || typeof bone !== 'object') continue;
      for (const prop of ['rotate', 'translate', 'scale', 'shear']) {
        keys += keyframeCount(/** @type {unknown[]} */ (bone[prop]));
      }
    }
  }

  const slots = animBlock.slots;
  if (slots && typeof slots === 'object') {
    for (const slot of Object.values(slots)) {
      if (!slot || typeof slot !== 'object') continue;
      attachmentSwitches += keyframeCount(/** @type {unknown[]} */ (slot.attachment));
      keys += keyframeCount(/** @type {unknown[]} */ (slot.color));
      keys += keyframeCount(/** @type {unknown[]} */ (slot.twoColor));
    }
  }

  const deform = animBlock.deform;
  if (deform && typeof deform === 'object') {
    for (const slotDef of Object.values(deform)) {
      if (!slotDef || typeof slotDef !== 'object') continue;
      for (const mesh of Object.values(slotDef)) {
        deformKeys += keyframeCount(/** @type {unknown[]} */ (mesh));
      }
    }
  }

  if (Array.isArray(animBlock.drawOrder)) drawOrderKeys = animBlock.drawOrder.length;
  if (Array.isArray(animBlock.events)) events = animBlock.events.length;

  return { keys, deformKeys, attachmentSwitches, drawOrderKeys, events };
}

/**
 * @param {Record<string, Record<string, unknown>> | undefined} animationsJson
 * @param {string} animName
 * @param {number} duration
 */
export function lintAnimationExport(animationsJson, animName, duration) {
  /** @type {HealthFinding[]} */
  const findings = [];
  const block = animationsJson?.[animName];
  if (!block) {
    findings.push({
      id: `export-anim-missing-${animName}`,
      level: 'warn',
      category: 'export.animations',
      title: `Animation "${animName}" missing in JSON`,
      detail: 'Could not read animation block from skeleton JSON.',
    });
    return { findings, warn: 1, fail: 0 };
  }

  const stats = countAnimationJsonStats(block);

  if (duration > MIN_DURATION_FOR_KPS) {
    const kps = stats.keys / duration;
    if (kps >= THRESHOLDS.keysPerSecondFail) {
      findings.push({
        id: `export-kps-${animName}`,
        level: 'fail',
        category: 'export.animations',
        title: `High key rate in "${animName}"`,
        detail: `${Math.round(kps)} keys/s (${stats.keys} keys, ${duration.toFixed(2)}s).`,
      });
    } else if (kps >= THRESHOLDS.keysPerSecondWarn) {
      findings.push({
        id: `export-kps-${animName}`,
        level: 'warn',
        category: 'export.animations',
        title: `Elevated key rate in "${animName}"`,
        detail: `${Math.round(kps)} keys/s (${stats.keys} keys, ${duration.toFixed(2)}s).`,
      });
    }
  }

  if (stats.deformKeys >= THRESHOLDS.deformKeysFail) {
    findings.push({
      id: `export-deform-${animName}`,
      level: 'fail',
      category: 'export.animations',
      title: `Heavy mesh deform keys in "${animName}"`,
      detail: `${stats.deformKeys} deform keyframes.`,
    });
  } else if (stats.deformKeys >= THRESHOLDS.deformKeysWarn) {
    findings.push({
      id: `export-deform-${animName}`,
      level: 'warn',
      category: 'export.animations',
      title: `Many deform keys in "${animName}"`,
      detail: `${stats.deformKeys} deform keyframes.`,
    });
  }

  if (stats.attachmentSwitches >= THRESHOLDS.attachmentSwitchesWarn) {
    findings.push({
      id: `export-attach-${animName}`,
      level: 'warn',
      category: 'export.animations',
      title: `Frequent attachment changes in "${animName}"`,
      detail: `${stats.attachmentSwitches} attachment keys.`,
    });
  }

  if (stats.drawOrderKeys >= THRESHOLDS.drawOrderKeysWarn) {
    findings.push({
      id: `export-draworder-${animName}`,
      level: 'warn',
      category: 'export.animations',
      title: `Many draw order keys in "${animName}"`,
      detail: `${stats.drawOrderKeys} draw order entries.`,
    });
  }

  let warn = 0;
  let fail = 0;
  for (const f of findings) {
    if (f.level === 'warn') warn += 1;
    if (f.level === 'fail') fail += 1;
  }
  return { findings, warn, fail, stats };
}

/**
 * @param {Record<string, Record<string, unknown>> | undefined} animationsJson
 */
export function lintAllAnimationsExport(animationsJson) {
  /** @type {HealthFinding[]} */
  const findings = [];
  if (!animationsJson || typeof animationsJson !== 'object') {
    findings.push({
      id: 'export-no-anims',
      level: 'info',
      category: 'export.animations',
      title: 'No animation data in JSON',
      detail: 'Skeleton JSON has no animations section.',
    });
    return findings;
  }
  const names = Object.keys(animationsJson);
  if (!names.length) {
    findings.push({
      id: 'export-empty-anims',
      level: 'warn',
      category: 'export.animations',
      title: 'No animations exported',
      detail: 'Empty animations object.',
    });
  }
  return findings;
}
