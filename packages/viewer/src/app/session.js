import { DEFAULT_GRID_SIZE, DRAWER_STORAGE_KEY, SCREEN_STORAGE_KEY, UI_STORAGE_KEY } from '../constants.js';
import { applySlotHighlight, clearSlotHighlight, disposeSlotHighlight } from '../features/highlight.js';
import { applySlotVisibility } from '../features/slotVisibility.js';
import { applySkins } from '../features/skins.js';
import {
  DEFAULT_DEBUG_FLAGS,
  disposeConstraintGizmos,
  paintConstraintGizmos,
} from '../features/debugOverlay.js';
import { atlasPageNames } from '../tabula/atlasPages.js';
import { classifyFiles, findAtlas } from '../tabula/groupFiles.js';
import { atlasInfo, buildTabulaAsset } from '../tabula/loader.js';
import { openExport, listSkeletons, listTiers, loadSkeletons } from '../tabula/exportManager.js';
import { Rectangle } from 'pixi.js';
import { hasPackageFiles } from '../tabula/package.js';
import { TabulaView } from '../tabula/view.js';
import { applyTrackMode, trackModeOf, updateTrackModes } from './playback.js';
import { parseSceneFile, serializeInstance } from '../persistence/sceneFile.js';
import { blobToFile, buildSessionPayload } from '../persistence/sessionPayload.js';
import { clearSession, loadSession, saveSession } from '../persistence/sessionStore.js';
import { enqueueInspect, inspectNow } from '../features/assetHealth/scanQueue.js';
import {
  addInstance,
  emit,
  removeInstance,
  resetScene,
  scene,
  selected,
} from './sceneStore.js';
import { configureHistory, clearHistory, isHistoryApplying, recordHistory } from './history.js';
import {
  app,
  fitWorldRect,
  screenFrameBounds,
  setOnTick,
  syncCameraFromScene,
  unionWorldBounds,
  world,
  worldBoundsOf,
} from './stage.js';

/** @type {Map<string, {
 *   id: string,
 *   assetKey: string,
 *   packageId?: string,
 *   tabulaAsset: import('tabula-pixi').TabulaAsset,
 *   skeletonData: object,
 *   skeletonJson: object | null,
 *   atlasText: string,
 *   atlas: object,
 *   textures: object[],
 *   urls: string[],
 *   sourceFiles?: { skeleton: File, atlas: File, images: File[] },
 *   refCount: number,
 *   healthReport: import('../features/assetHealth/types.js').HealthReport | null,
 *   healthScanState: 'idle' | 'pending' | 'done',
 * }>} */
const assets = new Map();

/**
 * Exports opened from `.tbla` / manifest files, with the manager that loads their groups.
 * @type {Map<string, { id: string, files: import('../tabula/package.js').PackageFile[], exp: import('../tabula/exportManager.js').OpenedExport, assetCount: number }>}
 */
const packages = new Map();

/** @type {(info: { label: string, skeletons: { name: string, group: string, format: 'tbin' | 'json' }[], tiers: number[] }) => Promise<{ names: string[], tier: number } | null>} */
let choosePackageSkeletons = async (info) => ({ names: info.skeletons.map((item) => item.name), tier: 1 });

/** @param {typeof choosePackageSkeletons} fn */
export function setPackagePicker(fn) {
  choosePackageSkeletons = fn;
}

let persistSuspended = false;
let persistTimer = 0;
let persistQuotaWarned = false;
let skipAutoFit = false;

/** @type {Record<string, boolean>} */
let debugFlags = { ...DEFAULT_DEBUG_FLAGS };

/** @type {(message: string, actions?: { label: string, run: () => void }[]) => void} */
let showBanner = () => {};
/** @type {(state: { visible: boolean, detail?: string }) => void} */
let reportRestoreProgress = () => {};
/** @type {() => void} */
let afterTick = () => {};

/** @param {() => void} fn */
export function setAfterTick(fn) {
  afterTick = fn;
}

/** @param {(message: string, actions?: { label: string, run: () => void }[]) => void} fn */
export function setBanner(fn) {
  showBanner = fn;
}

/** @param {(state: { visible: boolean, detail?: string }) => void} fn */
export function setRestoreProgress(fn) {
  reportRestoreProgress = fn;
}

export function schedulePersistSession() {
  if (persistSuspended) return;
  if (typeof window === 'undefined') return;
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    void persistSessionNow();
  }, 250);
}

export async function persistSessionNow() {
  if (persistSuspended) return;
  try {
    await saveSession(buildSessionPayload(scene, assets));
  } catch (error) {
    if (persistQuotaWarned) return;
    persistQuotaWarned = true;
    const quota = error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError';
    showBanner(quota
      ? 'This browser could not store the stage (storage full). Reload may lose dropped files.'
      : 'This browser could not store the stage. Reload may lose dropped files.');
  }
}

export async function flushPersistSession() {
  if (typeof window !== 'undefined') window.clearTimeout(persistTimer);
  await persistSessionNow();
}

export async function discardBrowserSession() {
  persistSuspended = true;
  if (typeof window !== 'undefined') window.clearTimeout(persistTimer);
  try {
    await clearSession();
  } catch (error) {
    console.warn('Could not clear session storage', error);
  } finally {
    persistSuspended = false;
  }
}

export function startTicker() {
  setOnTick(tick);
}

/** @param {number} dt */
function tick(dt) {
  for (const inst of scene.instances) {
    const scrubThis = scene.scrubbing && inst.id === scene.selectedId;
    const advance = inst.playing ? dt : 0;
    if (inst.holdSetup) {
      inst.spine.skeleton.setToSetupPose();
    }
    if (inst.spine.state) inst.spine.state.timeScale = inst.playbackSpeed;
    const delta = inst.holdSetup || scrubThis ? 0 : advance;
    if (inst.spine.state) updateTrackModes(inst, delta);
    if (typeof inst.spine.update === 'function') {
      inst.spine.update(delta);
    }
    applySlotVisibility(inst);
    paintConstraintGizmos(inst, debugFlags);
    if (inst.id === scene.selectedId) applySlotHighlight(inst);
    else clearSlotHighlight(inst);
  }
  afterTick();
}

/**
 * @param {File[]} files
 */
export async function importFiles(files) {
  if (hasPackageFiles(files)) {
    await importPackage(files);
    return;
  }
  const { images, atlases, skeletons } = classifyFiles(files);
  if (!skeletons.length) {
    showBanner('Drop a Spine .json skeleton with its .atlas and images, or a .tbla export (or assets.manifest.json with its files).');
    return;
  }
  if (!isHistoryApplying()) recordHistory();
  scene.playing = false;
  for (const inst of scene.instances) inst.playing = false;
  for (const file of skeletons) {
    try {
      await addSkeletonFile(file, atlases, images);
    } catch (error) {
      showBanner(error instanceof Error ? error.message : String(error));
    }
  }
  emit();
}

/**
 * @param {File} file
 * @returns {string} path inside a dropped folder, else the file name
 */
function packagePath(file) {
  return /** @type {{ viewerPath?: string }} */ (file).viewerPath || file.webkitRelativePath || file.name;
}

/** @param {File[]} files */
async function openPackageFiles(files) {
  const named = files.map((file) => (packagePath(file) === file.name ? file : new File([file], packagePath(file), { type: file.type })));
  const bytes = await Promise.all(named.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
  const exp = await openExport(bytes, app.renderer);
  const id = crypto.randomUUID();
  const rec = { id, files: bytes, exp, assetCount: 0 };
  packages.set(id, rec);
  return rec;
}

/**
 * Rendered bounds across the idle (else the longest) animation: a skeleton's own size changes while it plays, and the
 * header bounds of an export are often wrong. Uses a view of its own so the instance's playback is left alone.
 * @param {import('tabula-pixi').TabulaAsset} asset
 */
function animationBounds(asset) {
  const probe = new TabulaView(asset);
  const union = new Rectangle();
  const sample = new Rectangle();
  let empty = true;
  const add = () => {
    probe.getPoseBounds(sample);
    if (sample.width <= 0 && sample.height <= 0) return;
    if (empty) union.copyFrom(sample);
    else union.enlarge(sample);
    empty = false;
  };
  const animations = asset.data.animations.filter((animation) => animation.duration > 0);
  const chosen = animations.find((animation) => /idle/i.test(animation.name))
    ?? animations.reduce((best, animation) => (!best || animation.duration > best.duration ? animation : best), /** @type {typeof animations[number] | null} */ (null));
  if (chosen) {
    probe.clip.play(chosen.name);
    for (let i = 0; i < 9; i++) {
      probe.clip.seek((chosen.duration * i) / 8);
      add();
    }
  }
  probe.clip.stop();
  if (empty) add();
  probe.destroy({ children: true });
  return empty ? new Rectangle(-100, -100, 200, 200) : union;
}

/** @param {{ id: string, exp: import('../tabula/exportManager.js').OpenedExport }} rec */
function closePackage(rec) {
  rec.exp.manager.destroy();
  packages.delete(rec.id);
}

/**
 * Load the skeletons of an opened export and register them as assets.
 * @param {{ id: string, assetCount: number, exp: import('../tabula/exportManager.js').OpenedExport }} rec
 * @param {string[]} names
 * @param {Record<string, string>} [ids] asset ids to use, by skeleton name (session restore)
 */
async function addPackageAssets(rec, names, ids = {}) {
  const loaded = await loadSkeletons(rec.exp, names);
  return loaded.map(({ name, asset }) => {
    const assetId = ids[name] || crypto.randomUUID();
    assets.set(assetId, {
      id: assetId,
      assetKey: name,
      packageId: rec.id,
      tabulaAsset: asset,
      skeletonData: asset.data,
      skeletonJson: null,
      atlasText: '',
      atlas: atlasInfo(asset.atlas, asset.textures),
      textures: [],
      urls: [],
      refCount: 0,
      healthReport: null,
      healthScanState: 'idle',
    });
    rec.assetCount += 1;
    return { assetId, name };
  });
}

/**
 * Open a `.tbla` / `assets.manifest.json` export, let the user pick skeletons when it holds several, and put them on the stage.
 * @param {File[]} files
 */
async function importPackage(files) {
  let rec;
  try {
    rec = await openPackageFiles(files);
  } catch (error) {
    showBanner(error instanceof Error ? error.message : String(error));
    return;
  }
  const listed = listSkeletons(rec.exp);
  if (!listed.length) {
    closePackage(rec);
    showBanner(`${rec.exp.pkg.label} lists no skeletons.`);
    return;
  }
  const tiers = listTiers(rec.exp);
  const choice = listed.length === 1 && tiers.length === 1
    ? { names: [listed[0].name], tier: 1 }
    : await choosePackageSkeletons({ label: rec.exp.pkg.label, skeletons: listed, tiers });
  if (!choice?.names.length) {
    closePackage(rec);
    return;
  }
  const chosen = choice.names;
  if (choice.tier !== rec.exp.manager.tier) {
    // The tier is fixed when the manager is created: open the export again at the chosen one.
    try {
      rec.exp.manager.destroy();
      rec.exp = await openExport(rec.files, app.renderer, choice.tier);
    } catch (error) {
      packages.delete(rec.id);
      showBanner(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  if (!isHistoryApplying()) recordHistory();
  scene.playing = false;
  for (const inst of scene.instances) inst.playing = false;
  try {
    const added = await addPackageAssets(rec, chosen);
    let cursor = 0;
    for (const { assetId, name } of added) {
      const asset = assets.get(assetId);
      if (!asset) continue;
      const inst = mountInstance({
        assetId,
        name,
        assetKey: name,
        spine: new TabulaView(asset.tabulaAsset),
        atlas: asset.atlas,
      });
      if (added.length > 1) {
        // A row, left to right, so several skeletons do not sit on each other.
        const rect = animationBounds(asset.tabulaAsset);
        inst.spine.x = cursor - rect.x;
        inst.spine.y = -(rect.y + rect.height / 2);
        cursor += rect.width + 40;
      }
    }
    if (added.length > 1) fitAll();
  } catch (error) {
    showBanner(error instanceof Error ? error.message : String(error));
  }
  if (!rec.assetCount) closePackage(rec);
  emit();
}

/**
 * @param {File} file
 * @param {File[]} atlases
 * @param {Map<string, File>} images
 * @param {{ assetId?: string, skipMount?: boolean }} [options]
 */
async function addSkeletonFile(file, atlases, images, options = {}) {
  if (file.name.toLowerCase().endsWith('.skel')) {
    throw new Error(`"${file.name}" is a binary Spine skeleton. Export it as JSON (Spine 4.1 or 4.2).`);
  }
  const atlasFile = findAtlas(file, atlases);
  if (!atlasFile) {
    throw new Error(`No .atlas next to "${file.name}". Drop the atlas and page images with the skeleton.`);
  }
  const atlasText = await atlasFile.text();
  const pages = atlasPageNames(atlasText);
  /** @type {Record<string, string>} */
  const pageUrls = {};
  /** @type {string[]} */
  const urls = [];
  /** @type {File[]} */
  const imageFiles = [];
  for (const page of pages) {
    const image = images.get(page) || [...images.values()].find((img) => img.name === page);
    if (!image) throw new Error(`Missing atlas image "${page}" for ${file.name}.`);
    imageFiles.push(image);
    const url = URL.createObjectURL(image);
    urls.push(url);
    pageUrls[page] = url;
  }
  const skeletonJson = JSON.parse(await file.text());
  const name = file.name.replace(/\.json$/i, '');
  const built = await buildTabulaAsset({ atlasText, skeletonJson, pageUrls, name }).catch((error) => {
    for (const url of urls) URL.revokeObjectURL(url);
    throw error;
  });
  const spine = new TabulaView(built.asset);
  const assetId = options.assetId || crypto.randomUUID();
  assets.set(assetId, {
    id: assetId,
    assetKey: file.name,
    tabulaAsset: built.asset,
    skeletonData: built.data,
    skeletonJson,
    atlasText,
    atlas: built.atlas,
    textures: built.textures,
    urls,
    sourceFiles: {
      skeleton: file,
      atlas: atlasFile,
      images: imageFiles,
    },
    refCount: 0,
    healthReport: null,
    healthScanState: 'idle',
  });
  if (options.skipMount) return assets.get(assetId);
  mountInstance({
    assetId,
    name,
    assetKey: file.name,
    spine,
    atlas: built.atlas,
  });
  return assets.get(assetId);
}

/**
 * @param {{ assetId: string, name: string, assetKey: string, spine: any, atlas: any, transform?: { x: number, y: number, rotation: number, scaleX: number, scaleY: number }, zIndex?: number, visible?: boolean, locked?: boolean, skins?: string[], tracks?: Record<string, string>, id?: string, playing?: boolean, stageAnimations?: boolean }} spec
 */
function mountInstance(spec) {
  const asset = assets.get(spec.assetId);
  if (!asset) throw new Error('Missing asset.');
  asset.refCount += 1;
  const index = scene.instances.length;
  const inst = {
    id: spec.id || crypto.randomUUID(),
    name: spec.name,
    assetKey: spec.assetKey,
    assetId: spec.assetId,
    spine: spec.spine,
    atlas: spec.atlas,
    zIndex: spec.zIndex ?? index,
    visible: spec.visible !== false,
    locked: spec.locked === true,
    skins: new Set(spec.skins || defaultSkinNames(spec.spine)),
    tracks: {},
    selectedSlot: null,
    selectedBone: null,
    selectedTrack: 0,
    pulse: false,
    maskColorIndex: 0,
    lastAnimationName: null,
    holdSetup: false,
    stageAnimations: spec.stageAnimations !== false,
    playing: spec.stageAnimations === false ? false : (spec.playing ?? scene.playing),
    playbackSpeed: spec.playbackSpeed || 1,
    trackLoop: { ...(spec.trackLoop || {}) },
    trackMode: { ...(spec.trackMode || {}) },
    hiddenSlots: new Set(spec.hiddenSlots || []),
  };
  spec.spine.zIndex = inst.zIndex;
  spec.spine.visible = inst.visible;
  if (spec.transform) {
    spec.spine.position.set(spec.transform.x, spec.transform.y);
    spec.spine.rotation = spec.transform.rotation;
    spec.spine.scale.set(spec.transform.scaleX, spec.transform.scaleY);
  } else {
    spec.spine.position.set(0, 0);
  }
  world.addChild(spec.spine);
  applySkins(inst);
  const anims = spec.spine.skeleton.data.animations || [];
  const tracks = spec.tracks || {};
  const names = Object.keys(tracks);
  if (names.length) {
    for (const key of names) {
      const track = Number(key);
      const anim = tracks[key];
      if (anims.some((item) => item.name === anim)) {
        const mode = trackModeOf(inst, track);
        applyTrackMode(spec.spine.state.setAnimation(track, anim, mode !== 'once'), mode);
        inst.tracks[track] = anim;
        if (track === 0) inst.lastAnimationName = anim;
      }
    }
  } else if (anims[0]) {
    spec.spine.state.setAnimation(0, anims[0].name, true);
    inst.tracks[0] = anims[0].name;
    inst.lastAnimationName = anims[0].name;
  }
  spec.spine.update(0);
  applySlotVisibility(inst);
  inst.baseline = captureInstanceBaseline(inst);
  addInstance(inst, { skipSelect: !!spec.skipSelect });
  queueHealthScan(inst);
  if (!skipAutoFit && scene.instances.length === 1) fitSelection();
  return inst;
}

/** @param {import('./sceneStore.js').SpineInstance} inst */
function queueHealthScan(inst) {
  const asset = assets.get(inst.assetId);
  if (!asset) return;
  if (asset.healthScanState === 'done' && asset.healthReport) return;
  if (asset.healthScanState === 'pending') return;
  enqueueInspect(inst, asset);
}

/** @param {import('./sceneStore.js').SpineInstance | null | undefined} inst */
export function getHealthReportForInstance(inst) {
  if (!inst) return null;
  return assets.get(inst.assetId)?.healthReport ?? null;
}

/** @param {import('./sceneStore.js').SpineInstance | null | undefined} inst */
export function getHealthScanStateForInstance(inst) {
  if (!inst) return 'idle';
  return assets.get(inst.assetId)?.healthScanState ?? 'idle';
}

/** @param {import('./sceneStore.js').SpineInstance} inst */
export function rescanHealthForInstance(inst) {
  const asset = assets.get(inst.assetId);
  if (!asset) return;
  inspectNow(inst.assetId, inst, asset);
}

/** @param {import('./sceneStore.js').SpineInstance} inst */
function captureInstanceBaseline(inst) {
  return {
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
  };
}

/**
 * @param {import('./sceneStore.js').SpineInstance} inst
 * @param {import('./sceneStore.js').InstanceBaseline} baseline
 */
function applyInstanceBaseline(inst, baseline) {
  const asset = assets.get(inst.assetId);
  if (!asset) return;

  disposeSlotHighlight(inst);
  disposeConstraintGizmos(inst);
  world.removeChild(inst.spine);
  inst.spine.destroy({ children: true });
  inst.spine = new TabulaView(asset.tabulaAsset);
  world.addChild(inst.spine);

  inst.zIndex = baseline.zIndex;
  inst.spine.zIndex = baseline.zIndex;
  inst.visible = baseline.visible;
  inst.locked = baseline.locked;
  inst.stageAnimations = baseline.stageAnimations;
  inst.spine.visible = baseline.visible;
  inst.spine.position.set(baseline.transform.x, baseline.transform.y);
  inst.spine.rotation = baseline.transform.rotation;
  inst.spine.scale.set(baseline.transform.scaleX, baseline.transform.scaleY);

  inst.skins = new Set(baseline.skins);
  inst.hiddenSlots = new Set();
  inst.playbackSpeed = 1;
  inst.trackLoop = {};
  inst.trackMode = {};
  inst.pulse = false;
  inst.maskColorIndex = 0;
  inst.selectedSlot = null;
  inst.selectedBone = null;
  inst.holdSetup = false;
  inst.playing = false;
  inst.tracks = {};

  applySkins(inst);
  applySlotVisibility(inst);

  const anims = inst.spine.skeleton.data.animations || [];
  const trackKeys = Object.keys(baseline.tracks);
  if (trackKeys.length) {
    for (const key of trackKeys) {
      const track = Number(key);
      const anim = baseline.tracks[track];
      if (!anims.some((item) => item.name === anim)) continue;
      inst.spine.state.setAnimation(track, anim, true);
      inst.tracks[track] = anim;
      if (track === 0) inst.lastAnimationName = anim;
    }
  } else if (anims[0]) {
    inst.spine.state.setAnimation(0, anims[0].name, true);
    inst.tracks[0] = anims[0].name;
    inst.lastAnimationName = anims[0].name;
  }

  if (inst.spine.state) inst.spine.state.timeScale = 1;
  inst.spine.update(0);
}

/** @param {import('./sceneStore.js').SpineInstance[]} targets */
export function resetInstancesToBaseline(targets) {
  if (!targets.length) return;
  scene.playing = false;
  for (const inst of targets) {
    if (!inst.baseline) inst.baseline = captureInstanceBaseline(inst);
    applyInstanceBaseline(inst, inst.baseline);
  }
  for (const inst of scene.instances) {
    inst.spine.zIndex = inst.zIndex;
  }
  emit();
}

/** @param {{ skeleton: { data: { skins: { name: string }[] } } }} spine */
function defaultSkinNames(spine) {
  const skins = spine.skeleton?.data?.skins || [];
  const names = skins.map((skin) => skin.name);
  if (names.includes('default')) return ['default'];
  return names.length ? [names[0]] : [];
}

/** @param {string} id */
export function deleteInstance(id) {
  const inst = removeInstance(id);
  if (!inst) return;
  disposeSlotHighlight(inst);
  disposeConstraintGizmos(inst);
  world.removeChild(inst.spine);
  inst.spine.destroy({ children: true });
  const asset = assets.get(inst.assetId);
  if (!asset) return;
  asset.refCount -= 1;
  if (asset.refCount <= 0) {
    for (const url of asset.urls) URL.revokeObjectURL(url);
    for (const texture of asset.textures) texture.destroy(true);
    asset.atlas?.dispose?.();
    assets.delete(inst.assetId);
    const rec = asset.packageId ? packages.get(asset.packageId) : null;
    if (rec) {
      rec.assetCount -= 1;
      if (rec.assetCount <= 0) closePackage(rec);
    }
  }
}

/** @param {string} id */
export function duplicateInstance(id) {
  const inst = scene.instances.find((item) => item.id === id);
  if (!inst) return;
  const spine = new TabulaView(assets.get(inst.assetId).tabulaAsset);
  const copy = mountInstance({
    assetId: inst.assetId,
    name: `${inst.name} copy`,
    assetKey: inst.assetKey,
    spine,
    atlas: inst.atlas,
    transform: {
      x: inst.spine.x + 30,
      y: inst.spine.y + 30,
      rotation: inst.spine.rotation,
      scaleX: inst.spine.scale.x,
      scaleY: inst.spine.scale.y,
    },
    skins: [...inst.skins],
    stageAnimations: inst.stageAnimations !== false,
  });
  return copy;
}

export function disposeScene() {
  for (const inst of [...scene.instances]) deleteInstance(inst.id);
  for (const asset of assets.values()) {
    for (const url of asset.urls) URL.revokeObjectURL(url);
    for (const texture of asset.textures) texture.destroy(true);
  }
  assets.clear();
  for (const rec of [...packages.values()]) closePackage(rec);
}

export async function newScene() {
  disposeScene();
  resetScene();
  clearHistory();
  await persistSessionNow();
}

export async function loadSamples() {
  const names = ['box', 'badge'];
  /** @type {File[]} */
  const files = [];
  for (const name of names) {
    for (const ext of ['json', 'atlas', 'png']) {
      const response = await fetch(`/samples/${name}.${ext}`);
      if (!response.ok) throw new Error(`Missing sample ${name}.${ext}`);
      const blob = await response.blob();
      files.push(new File([blob], `${name}.${ext}`, { type: blob.type }));
    }
  }
  await importFiles(files);
}

export function fitSelection() {
  const inst = selected();
  const rect = inst ? worldBoundsOf(inst) : unionWorldBounds(scene.instances);
  if (rect) fitWorldRect(rect);
}

export function fitAll() {
  fitInstances(scene.instances);
}

/** @param {import('./sceneStore.js').SpineInstance[]} instances */
export function fitInstances(instances) {
  const rect = unionWorldBounds(instances);
  if (rect) fitWorldRect(rect);
}

export function centerAllInstances() {
  centerInstances(scene.instances);
}

/** @param {import('./sceneStore.js').SpineInstance[]} instances */
export function centerInstances(instances) {
  const frame = screenFrameBounds();
  if (!frame) return;
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  for (const inst of instances) {
    if (!inst.visible) continue;
    const bounds = worldBoundsOf(inst);
    const bx = bounds.x + bounds.width / 2;
    const by = bounds.y + bounds.height / 2;
    inst.spine.x += cx - bx;
    inst.spine.y += cy - by;
  }
  emit();
}

export function stopAllInstances() {
  scene.playing = false;
  stopInstances(scene.instances);
}

/** @param {import('./sceneStore.js').SpineInstance[]} instances */
export function stopInstances(instances) {
  for (const inst of instances) {
    inst.playing = false;
    inst.holdSetup = true;
    inst.spine.state.clearTracks();
    inst.tracks = {};
    inst.spine.skeleton.setToSetupPose();
    inst.spine.update(0);
  }
  scene.playing = scene.instances.some((item) => item.playing);
  emit();
}

/**
 * @param {string} jsonText
 * @param {File[]} files
 */
export async function restoreScene(jsonText, files) {
  const data = parseSceneFile(JSON.parse(jsonText));
  await newScene();
  scene.snapEnabled = data.snapEnabled;
  scene.gridEnabled = data.gridEnabled === true;
  scene.gridSize = data.gridSize || DEFAULT_GRID_SIZE;
  scene.playing = data.playing;
  scene.camera = data.camera;
  const { images, atlases, skeletons } = classifyFiles(files);
  // An export dropped with the scene (.tbla, or assets.manifest.json with its files) supplies skeletons by name.
  /** @type {Map<string, string>} */
  const packageAssets = new Map();
  if (hasPackageFiles(files)) {
    const rec = await openPackageFiles(files);
    const listed = new Set(listSkeletons(rec.exp).map((item) => item.name));
    const wanted = [...new Set(data.instances.map((spec) => spec.assetKey))].filter((key) => listed.has(key));
    for (const { assetId, name } of await addPackageAssets(rec, wanted)) packageAssets.set(name, assetId);
    if (!rec.assetCount) closePackage(rec);
  }
  for (const spec of data.instances) {
    const before = scene.instances.length;
    const packageAssetId = packageAssets.get(spec.assetKey);
    if (packageAssetId) {
      const asset = assets.get(packageAssetId);
      if (!asset) continue;
      mountInstance({
        assetId: packageAssetId,
        name: spec.name,
        assetKey: spec.assetKey,
        spine: new TabulaView(asset.tabulaAsset),
        atlas: asset.atlas,
      });
    } else {
      const file = skeletons.find((item) => item.name === spec.assetKey);
      if (!file) {
        showBanner(`Scene needs "${spec.assetKey}". Drop that file (or the .tbla export that has it) and try Open again.`);
        continue;
      }
      await addSkeletonFile(file, atlases, images);
    }
    const inst = scene.instances[scene.instances.length - 1];
    if (!inst || scene.instances.length === before) continue;
    inst.id = spec.id || inst.id;
    inst.name = spec.name;
    inst.zIndex = spec.zIndex;
    inst.spine.zIndex = spec.zIndex;
    inst.visible = spec.visible;
    inst.spine.visible = spec.visible;
    inst.locked = spec.locked;
    inst.stageAnimations = spec.stageAnimations !== false;
    if (!inst.stageAnimations) inst.playing = false;
    inst.spine.position.set(spec.transform.x, spec.transform.y);
    inst.spine.rotation = spec.transform.rotation;
    inst.spine.scale.set(spec.transform.scaleX, spec.transform.scaleY);
    inst.skins = new Set(spec.skins);
    inst.hiddenSlots = new Set(spec.hiddenSlots || []);
    inst.playbackSpeed = spec.playbackSpeed || 1;
    inst.trackLoop = { ...(spec.trackLoop || {}) };
    inst.trackMode = { ...(spec.trackMode || {}) };
    applySkins(inst);
    applySlotVisibility(inst);
    inst.tracks = {};
    for (const [track, anim] of Object.entries(spec.tracks)) {
      try {
        const mode = trackModeOf(inst, Number(track));
        applyTrackMode(inst.spine.state.setAnimation(Number(track), anim, mode !== 'once'), mode);
        inst.tracks[Number(track)] = anim;
        if (Number(track) === 0) inst.lastAnimationName = anim;
      } catch {
        /* animation missing from this export */
      }
    }
    inst.spine.update(0);
    inst.baseline = captureInstanceBaseline(inst);
  }
}

export async function restoreBrowserSession() {
  persistSuspended = true;
  skipAutoFit = true;
  reportRestoreProgress({ visible: true, detail: 'Checking saved assets…' });
  try {
    const payload = await loadSession();
    if (!payload) return false;
    const assetCount = payload.assets.length;
    const instanceCount = payload.scene.instances.length;
    if (!assetCount && !instanceCount) return false;
    reportRestoreProgress({
      visible: true,
      detail: assetCount
        ? `Loading ${assetCount} saved asset${assetCount === 1 ? '' : 's'}…`
        : 'Restoring stage layout…',
    });
    await newScene();
    scene.snapEnabled = payload.scene.snapEnabled;
    scene.gridEnabled = payload.scene.gridEnabled === true;
    scene.gridSize = payload.scene.gridSize || DEFAULT_GRID_SIZE;
    scene.playing = payload.scene.playing;
    scene.camera = payload.scene.camera;
    syncCameraFromScene();

    let loaded = 0;
    for (const rec of payload.assets) {
      if (!rec.id || !rec.skeleton?.blob || !rec.atlas?.blob) continue;
      loaded += 1;
      reportRestoreProgress({
        visible: true,
        detail: `Loading ${loaded} of ${assetCount}: ${rec.assetKey}`,
      });
      const skeleton = blobToFile(rec.skeleton);
      const atlas = blobToFile(rec.atlas);
      /** @type {Map<string, File>} */
      const images = new Map();
      for (const img of rec.images) {
        if (!img.name || !img.blob) continue;
        const file = blobToFile(img);
        images.set(file.name, file);
      }
      try {
        await addSkeletonFile(skeleton, [atlas], images, {
          assetId: rec.id,
          skipMount: true,
        });
      } catch (error) {
        console.warn('Could not restore asset', rec.assetKey, error);
      }
    }

    for (const spec of payload.scene.instances) {
      const asset = (spec.assetId && assets.get(spec.assetId))
        || [...assets.values()].find((item) => item.assetKey === spec.assetKey);
      if (!asset) {
        showBanner(`Saved session is missing files for "${spec.assetKey || spec.name}".`);
        continue;
      }
      const spine = new TabulaView(asset.tabulaAsset);
      mountInstance({
        id: spec.id || undefined,
        assetId: asset.id,
        name: spec.name,
        assetKey: spec.assetKey || asset.assetKey,
        spine,
        atlas: asset.atlas,
        transform: spec.transform,
        zIndex: spec.zIndex,
        visible: spec.visible,
        locked: spec.locked,
        skins: spec.skins,
        tracks: spec.tracks,
        stageAnimations: spec.stageAnimations,
        playing: spec.stageAnimations === false ? false : payload.scene.playing,
        hiddenSlots: spec.hiddenSlots,
        playbackSpeed: spec.playbackSpeed,
        trackLoop: spec.trackLoop,
      trackMode: spec.trackMode,
        trackMode: spec.trackMode,
        skipSelect: true,
      });
    }
    scene.playing = payload.scene.playing && scene.instances.some((item) => item.playing);
    if (assetCount || instanceCount) {
      reportRestoreProgress({ visible: true, detail: 'Placing skeletons on the stage…' });
    }
    emit();
    return scene.instances.length > 0;
  } catch (error) {
    console.warn('Could not restore browser session', error);
    return false;
  } finally {
    skipAutoFit = false;
    persistSuspended = false;
    reportRestoreProgress({ visible: false });
  }
}

export async function clearAllBrowserData() {
  persistSuspended = true;
  if (typeof window !== 'undefined') window.clearTimeout(persistTimer);
  disposeScene();
  resetScene();
  try {
    await clearSession();
  } catch (error) {
    console.warn('Could not delete session database', error);
  }
  try {
    localStorage.removeItem(UI_STORAGE_KEY);
    localStorage.removeItem(SCREEN_STORAGE_KEY);
    localStorage.removeItem(DRAWER_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  location.reload();
}

export function captureHistorySnapshot() {
  return {
    snapEnabled: scene.snapEnabled,
    gridEnabled: scene.gridEnabled === true,
    gridSize: scene.gridSize || DEFAULT_GRID_SIZE,
    playing: scene.playing,
    selectedId: scene.selectedId,
    selectedIds: [...scene.selectedIds],
    instances: scene.instances.map((inst) => serializeInstance(inst)),
  };
}

/** @param {ReturnType<typeof captureHistorySnapshot>} snap */
export async function applyHistorySnapshot(snap) {
  unmountAllKeepAssets();
  scene.snapEnabled = snap.snapEnabled !== false;
  scene.gridEnabled = snap.gridEnabled === true;
  scene.gridSize = snap.gridSize || DEFAULT_GRID_SIZE;
  scene.playing = !!snap.playing;
  skipAutoFit = true;
  for (const spec of snap.instances || []) {
    const asset = assets.get(spec.assetId);
    if (!asset) continue;
    const spine = new TabulaView(asset.tabulaAsset);
    mountInstance({
      id: spec.id || undefined,
      assetId: spec.assetId,
      name: spec.name,
      assetKey: spec.assetKey,
      spine,
      atlas: asset.atlas,
      transform: spec.transform,
      zIndex: spec.zIndex,
      visible: spec.visible,
      locked: spec.locked,
      skins: spec.skins,
      tracks: spec.tracks,
      stageAnimations: spec.stageAnimations,
      playing: spec.stageAnimations === false ? false : snap.playing,
      hiddenSlots: spec.hiddenSlots,
      playbackSpeed: spec.playbackSpeed,
      trackLoop: spec.trackLoop,
      trackMode: spec.trackMode,
      skipSelect: true,
    });
  }
  skipAutoFit = false;
  const ids = Array.isArray(snap.selectedIds)
    ? snap.selectedIds.filter((id) => scene.instances.some((item) => item.id === id))
    : [];
  scene.selectedIds = new Set(ids);
  scene.selectedId = (snap.selectedId && ids.includes(snap.selectedId))
    ? snap.selectedId
    : (ids[ids.length - 1] || null);
  emit();
}

function unmountAllKeepAssets() {
  for (const inst of [...scene.instances]) {
    disposeSlotHighlight(inst);
    disposeConstraintGizmos(inst);
    if (inst.spine) {
      world.removeChild(inst.spine);
      inst.spine.destroy({ children: true });
    }
    const asset = assets.get(inst.assetId);
    if (asset) asset.refCount -= 1;
  }
  scene.instances = [];
  scene.selectedId = null;
  scene.selectedIds = new Set();
}

/** @param {Record<string, boolean>} flags */
export function setDebugFlags(flags) {
  debugFlags = { ...DEFAULT_DEBUG_FLAGS, ...flags };
}

export function getDebugFlags() {
  return { ...debugFlags };
}

configureHistory({
  capture: captureHistorySnapshot,
  apply: applyHistorySnapshot,
});
