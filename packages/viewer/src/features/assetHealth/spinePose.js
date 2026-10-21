/**
 * Pose the instance at its setup pose (tracks are left as they are).
 * @param {import('../../app/sceneStore.js').SpineInstance} inst
 */
export function applySetupPose(inst) {
  inst.spine.skeleton.setToSetupPose();
  inst.spine.state.apply(inst.spine.skeleton);
  inst.spine.update(0);
}

/**
 * Apply current animation state to the skeleton (after setting trackTime).
 * @param {import('../../app/sceneStore.js').SpineInstance} inst
 */
export function applyAnimationPose(inst) {
  inst.spine.state.apply(inst.spine.skeleton);
  inst.spine.update(0);
}
