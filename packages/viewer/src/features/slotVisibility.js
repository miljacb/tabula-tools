/** Slots each skeleton had hidden on the last pass, so un-hiding can restore them once. @type {WeakMap<object, Set<string>>} */
const lastHidden = new WeakMap();

/**
 * Hide the slots the user switched off (alpha 0). Runs after every animation update, so it must not touch the
 * other slots: their colour, alpha fades included, belongs to the animation.
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 */
export function applySlotVisibility(inst) {
  const skeleton = inst?.spine?.skeleton;
  if (!skeleton?.slots) return;
  const hidden = inst.hiddenSlots;
  const before = lastHidden.get(skeleton) || new Set();
  for (let i = 0; i < skeleton.slots.length; i++) {
    const slot = skeleton.slots[i];
    if (!slot?.data) continue;
    const name = slot.data.name;
    const isHidden = hidden.has(name);
    if (typeof slot.visible === 'boolean') slot.visible = !isHidden;
    if (!slot.color) continue;
    if (isHidden) slot.color.a = 0;
    // Shown again: back to the setup alpha; the animation overrides it on its next apply if it keys this slot.
    else if (before.has(name)) slot.color.a = slot.data.color?.a ?? 1;
  }
  lastHidden.set(skeleton, new Set(hidden));
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {boolean} hidden
 */
export function setAllSlotsHidden(inst, hidden) {
  const names = inst.spine?.skeleton?.data?.slots?.map((slot) => slot.name) || [];
  inst.hiddenSlots = hidden ? new Set(names) : new Set();
  applySlotVisibility(inst);
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {string} name
 */
export function toggleSlotHidden(inst, name) {
  if (inst.hiddenSlots.has(name)) inst.hiddenSlots.delete(name);
  else inst.hiddenSlots.add(name);
  applySlotVisibility(inst);
}
