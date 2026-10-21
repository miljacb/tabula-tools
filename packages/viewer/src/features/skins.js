/**
 * Show the instance's selected skins together (later ones win), or the default skin when none is selected.
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 */
export function applySkins(inst) {
  const { clip, skeleton } = inst.spine;
  const known = new Set(skeleton.data.skins.map((skin) => skin.name));
  const names = [...inst.skins].filter((name) => known.has(name));
  if (names.length) clip.setSkin(names.length === 1 ? names[0] : names);
  else if (skeleton.data.defaultSkin) clip.setSkin(skeleton.data.defaultSkin.name);
  skeleton.setSlotsToSetupPose();
}
