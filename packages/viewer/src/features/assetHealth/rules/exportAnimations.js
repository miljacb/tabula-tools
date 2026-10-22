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

/** Bone timelines across Spine 3.x (rotate/translate/scale/shear) and 4.x (split x/y variants). */
const BONE_TIMELINES = ['rotate', 'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'shear', 'shearx', 'sheary', 'inherit'];
/** Slot colour timelines: 3.x color/twoColor, 4.x rgba/rgb/alpha/rgba2/rgb2. */
const SLOT_COLOR_TIMELINES = ['color', 'twoColor', 'rgba', 'rgb', 'alpha', 'rgba2', 'rgb2'];
/** Constraint timeline sections; each is name → keys (path/physics nest one level deeper). */
const CONSTRAINT_SECTIONS = ['ik', 'transform', 'path', 'physics'];

/**
 * Spine JSON timelines are arrays of key objects (4.x omits `time` on the first key when it is 0).
 * @param {unknown} arr
 */
function keyframeCount(arr) {
  return Array.isArray(arr) ? arr.length : 0;
}

/**
 * Sums every key array found up to `depth` levels below `node`.
 * @param {unknown} node
 * @param {number} depth
 */
function nestedKeyCount(node, depth) {
  if (Array.isArray(node)) return node.length;
  if (!node || typeof node !== 'object' || depth <= 0) return 0;
  let total = 0;
  for (const child of Object.values(node)) total += nestedKeyCount(child, depth - 1);
  return total;
}

/**
 * @param {Record<string, unknown>} animBlock
 */
export function countAnimationJsonStats(animBlock) {
  let keys = 0;
  let deformKeys = 0;
  let sequenceKeys = 0;
  let attachmentSwitches = 0;
  let drawOrderKeys = 0;
  let events = 0;
  let constraintKeys = 0;
  let timelines = 0;

  const bones = animBlock.bones;
  if (bones && typeof bones === 'object') {
    for (const bone of Object.values(bones)) {
      if (!bone || typeof bone !== 'object') continue;
      for (const prop of BONE_TIMELINES) {
        const n = keyframeCount(bone[prop]);
        if (n) timelines += 1;
        keys += n;
      }
    }
  }

  const slots = animBlock.slots;
  if (slots && typeof slots === 'object') {
    for (const slot of Object.values(slots)) {
      if (!slot || typeof slot !== 'object') continue;
      attachmentSwitches += keyframeCount(slot.attachment);
      for (const prop of SLOT_COLOR_TIMELINES) {
        const n = keyframeCount(slot[prop]);
        if (n) timelines += 1;
        keys += n;
      }
    }
  }

  for (const section of CONSTRAINT_SECTIONS) {
    constraintKeys += nestedKeyCount(animBlock[section], 2);
  }
  keys += constraintKeys;

  // 3.x / 4.0: deform → skin → slot → attachment → keys.
  deformKeys += nestedKeyCount(animBlock.deform, 3);
  // 4.1+: attachments → skin → slot → attachment → { deform, sequence }.
  const attachments = animBlock.attachments;
  if (attachments && typeof attachments === 'object') {
    for (const skin of Object.values(attachments)) {
      if (!skin || typeof skin !== 'object') continue;
      for (const slot of Object.values(skin)) {
        if (!slot || typeof slot !== 'object') continue;
        for (const att of Object.values(slot)) {
          if (!att || typeof att !== 'object') continue;
          deformKeys += keyframeCount(att.deform);
          sequenceKeys += keyframeCount(att.sequence);
        }
      }
    }
  }

  const drawOrder = animBlock.drawOrder ?? animBlock.draworder;
  if (Array.isArray(drawOrder)) drawOrderKeys = drawOrder.length;
  if (Array.isArray(animBlock.events)) events = animBlock.events.length;

  return { keys, timelines, constraintKeys, deformKeys, sequenceKeys, attachmentSwitches, drawOrderKeys, events };
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
    return { findings, warn: 1, fail: 0, stats: null };
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
