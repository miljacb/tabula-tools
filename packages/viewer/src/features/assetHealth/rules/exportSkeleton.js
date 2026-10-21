/** @typedef {import('../types.js').HealthFinding} HealthFinding */

/**
 * @param {object | null} skeletonJson
 */
export function lintSkeletonExport(skeletonJson) {
  /** @type {HealthFinding[]} */
  const findings = [];
  if (!skeletonJson) return findings;

  const bones = skeletonJson.bones;
  const slots = skeletonJson.slots;
  const boneCount = Array.isArray(bones) ? bones.length : 0;
  const slotCount = Array.isArray(slots) ? slots.length : 0;

  if (boneCount > 80) {
    findings.push({
      id: 'export-bones-high',
      level: 'warn',
      category: 'export.skeleton',
      title: 'Large bone count',
      detail: `${boneCount} bones (ideal under ~80 for simple characters).`,
    });
  } else if (boneCount > 0) {
    findings.push({
      id: 'export-bones-ok',
      level: 'pass',
      category: 'export.skeleton',
      title: 'Bone count',
      detail: `${boneCount} bones.`,
    });
  }

  if (slotCount > 60) {
    findings.push({
      id: 'export-slots-high',
      level: 'warn',
      category: 'export.skeleton',
      title: 'Many slots',
      detail: `${slotCount} slots.`,
    });
  } else if (slotCount > 0) {
    findings.push({
      id: 'export-slots-ok',
      level: 'pass',
      category: 'export.skeleton',
      title: 'Slot count',
      detail: `${slotCount} slots.`,
    });
  }

  return findings;
}
