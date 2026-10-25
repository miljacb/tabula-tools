import * as PIXI from 'pixi.js';
import { ZOOM_MAX, ZOOM_MIN } from '../constants.js';
import { scene } from './sceneStore.js';
import { ensureTabulaRenderer } from '../tabula/runtime.js';
import { setGpuTextureUnits } from '../features/perf.js';

/** @type {PIXI.Application | null} */
export let app = null;
/** @type {PIXI.Container | null} */
export let camera = null;
/** @type {PIXI.Container | null} */
export let world = null;
/** @type {PIXI.Graphics | null} */
export let guides = null;
/** @type {PIXI.Graphics | null} */
let selection = null;
/** @type {PIXI.Graphics | null} */
let screenFrame = null;
/** @type {PIXI.Graphics | null} */
let gridGfx = null;
/** @type {PIXI.Graphics | null} */
let marquee = null;
/** @type {{ width: number, height: number } | null} */
let screenSize = null;

/** @type {(dt: number) => void} */
let onTick = () => {};

/** CPU milliseconds of the last frame: skeleton updates + UI (`update`) and Pixi's render call (`render`). */
const frameTiming = { update: 0, render: 0 };
let renderStart = 0;

/** Browser long tasks (> 50 ms of main-thread work) not yet handed to the panel. Chrome / Edge only. */
/** @type {{ t: number, ms: number }[]} */
const pendingLongTasks = [];
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) pendingLongTasks.push({ t: entry.startTime, ms: entry.duration });
    if (pendingLongTasks.length > 200) pendingLongTasks.splice(0, pendingLongTasks.length - 200);
  }).observe({ type: 'longtask', buffered: false });
} catch {
  // Not supported: stutter markers then come from frame times only.
}

const BACKGROUNDS = { dark: 0x111111, light: 0xe8e8e8 };

/**
 * Stage background: a solid colour, or transparent over the page's checkerboard.
 * @param {string} mode 'dark' | 'checker' | 'light' | 'custom'
 * @param {string} [color] '#rrggbb' for custom
 */
export function setStageBackground(mode, color = '#111111') {
  if (!app) return;
  const background = /** @type {any} */ (app.renderer).background;
  if (mode === 'checker') {
    background.alpha = 0;
    return;
  }
  background.alpha = 1;
  background.color = mode === 'custom' ? parseInt(color.slice(1), 16) : BACKGROUNDS[mode] ?? BACKGROUNDS.dark;
}

/** @param {HTMLElement} parent */
export function initStage(parent) {
  ensureTabulaRenderer();
  app = new PIXI.Application({
    resizeTo: parent,
    backgroundColor: 0x111111,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  parent.appendChild(app.view);
  camera = new PIXI.Container();
  world = new PIXI.Container();
  world.sortableChildren = true;
  guides = new PIXI.Graphics();
  selection = new PIXI.Graphics();
  selection.eventMode = 'none';
  screenFrame = new PIXI.Graphics();
  screenFrame.zIndex = -10000;
  screenFrame.eventMode = 'none';
  world.addChild(screenFrame);
  gridGfx = new PIXI.Graphics();
  gridGfx.zIndex = -9999;
  gridGfx.eventMode = 'none';
  world.addChild(gridGfx);
  camera.addChild(world);
  app.stage.addChild(camera);
  app.stage.addChild(guides);
  marquee = new PIXI.Graphics();
  marquee.eventMode = 'none';
  app.stage.addChild(marquee);
  app.stage.addChild(selection);
  app.ticker.add(() => {
    paintScreenFrame();
    paintGrid();
    paintSelection();
    const t0 = performance.now();
    onTick(app.ticker.deltaMS / 1000);
    frameTiming.update = performance.now() - t0;
  });
  const renderer = /** @type {any} */ (app.renderer);
  renderer.on?.('prerender', () => { renderStart = performance.now(); });
  renderer.on?.('postrender', () => { frameTiming.render = performance.now() - renderStart; });
  const gl = renderer.gl;
  if (gl) setGpuTextureUnits(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS));
}

/** @param {{ width: number, height: number } | null} size */
export function setScreenFrame(size) {
  screenSize = size;
  paintScreenFrame();
}

/** Camera-local rect for the current screen frame. */
export function screenFrameBounds() {
  if (!screenSize) return null;
  return {
    x: 0,
    y: 0,
    width: screenSize.width,
    height: screenSize.height,
  };
}

export function readFps() {
  return app?.ticker?.FPS || 0;
}

/**
 * Timing and renderer counters of the last frame.
 * `renderer` is the Tabula renderer's own count (skeleton draws only; Pixi graphics such as guides are not included).
 */
export function readFrameStats() {
  const tabula = /** @type {any} */ (app?.renderer)?.plugins?.tabula;
  const managed = /** @type {any} */ (app?.renderer)?.texture?.managedTextures;
  return {
    deltaMs: app?.ticker?.deltaMS || 0,
    updateMs: frameTiming.update,
    renderMs: frameTiming.render,
    renderer: tabula?.lastFrameStats ?? null,
    /** Textures currently uploaded to the GPU; a rise between frames means an upload happened. */
    gpuTextures: Array.isArray(managed) ? managed.length : null,
    /** Long tasks since the last call (drained). */
    longTasks: pendingLongTasks.splice(0),
  };
}

function paintSelection() {
  if (!selection) return;
  selection.clear();
  const ids = scene.selectedIds.size
    ? scene.instances.filter((item) => scene.selectedIds.has(item.id))
    : scene.selectedId
      ? scene.instances.filter((item) => item.id === scene.selectedId)
      : [];
  selection.lineStyle(1, 0xffffff, 0.95);
  for (const inst of ids) {
    if (!inst?.visible || !inst.spine) continue;
    const bounds = inst.spine.getBounds();
    if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) continue;
    selection.drawRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }
}

function paintScreenFrame() {
  if (!screenFrame || !camera) return;
  screenFrame.clear();
  // The frame only means something once there is an asset to place in it.
  if (!screenSize || !scene.instances.length) return;
  const zoom = camera.scale.x || 1;
  const { width, height } = screenSize;
  screenFrame.lineStyle(1 / zoom, 0xd2ff00, 0.9);
  screenFrame.drawRect(0, 0, width, height);
}

function paintGrid() {
  if (!gridGfx || !camera || !app) return;
  gridGfx.clear();
  if (!scene.gridEnabled || !(scene.gridSize > 0)) return;
  const zoom = camera.scale.x || 1;
  const size = scene.gridSize;
  const view = app.screen;
  const tl = camera.toLocal(new PIXI.Point(0, 0));
  const br = camera.toLocal(new PIXI.Point(view.width, view.height));
  const minX = Math.min(tl.x, br.x);
  const maxX = Math.max(tl.x, br.x);
  const minY = Math.min(tl.y, br.y);
  const maxY = Math.max(tl.y, br.y);
  const startX = Math.floor(minX / size) * size;
  const startY = Math.floor(minY / size) * size;
  gridGfx.lineStyle(1 / zoom, 0xffffff, 0.08);
  for (let x = startX; x <= maxX; x += size) {
    gridGfx.moveTo(x, minY);
    gridGfx.lineTo(x, maxY);
  }
  for (let y = startY; y <= maxY; y += size) {
    gridGfx.moveTo(minX, y);
    gridGfx.lineTo(maxX, y);
  }
}

/** @param {(dt: number) => void} fn */
export function setOnTick(fn) {
  onTick = fn;
}

export function syncCameraFromScene() {
  if (!camera) return;
  camera.position.set(scene.camera.x, scene.camera.y);
  camera.scale.set(scene.camera.zoom);
}

export function readCameraIntoScene() {
  if (!camera) return;
  scene.camera.x = camera.x;
  scene.camera.y = camera.y;
  scene.camera.zoom = camera.scale.x;
}

/**
 * @param {number} screenX
 * @param {number} screenY
 * @param {number} nextZoom
 */
export function zoomAt(screenX, screenY, nextZoom) {
  if (!camera) return;
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoom));
  const old = camera.scale.x || 1;
  const wx = (screenX - camera.x) / old;
  const wy = (screenY - camera.y) / old;
  camera.scale.set(zoom);
  camera.x = screenX - wx * zoom;
  camera.y = screenY - wy * zoom;
  readCameraIntoScene();
}

/** @param {number} delta */
export function zoomBy(delta) {
  if (!app || !camera) return;
  zoomAt(app.screen.width / 2, app.screen.height / 2, camera.scale.x + delta);
}

export function resetCamera() {
  if (!camera) return;
  camera.position.set(0, 0);
  camera.scale.set(1);
  readCameraIntoScene();
}

/** @param {number} clientX @param {number} clientY */
export function clientToGlobal(clientX, clientY) {
  const point = new PIXI.Point();
  app.renderer.events.mapPositionToPoint(point, clientX, clientY);
  return point;
}

/** @param {number} clientX @param {number} clientY */
export function clientToWorld(clientX, clientY) {
  return camera.toLocal(clientToGlobal(clientX, clientY));
}

/** Bounds in camera-local space, which matches spine x/y when the world container is untransformed. */
export function worldBoundsOf(inst) {
  const b = inst.spine.getBounds();
  const tl = camera.toLocal(new PIXI.Point(b.x, b.y));
  const br = camera.toLocal(new PIXI.Point(b.x + b.width, b.y + b.height));
  return {
    x: Math.min(tl.x, br.x),
    y: Math.min(tl.y, br.y),
    width: Math.max(1, Math.abs(br.x - tl.x)),
    height: Math.max(1, Math.abs(br.y - tl.y)),
  };
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} rect camera-local
 */
export function fitWorldRect(rect) {
  if (!app || !camera || rect.width <= 0 || rect.height <= 0) return;
  // Pixi's resizeTo only catches up on the next frame; fit against the stage's real size now.
  app.resize();
  const pad = 48;
  const viewW = app.screen.width;
  const viewH = app.screen.height;
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(
    (viewW - pad * 2) / rect.width,
    (viewH - pad * 2) / rect.height,
  )));
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  camera.scale.set(zoom);
  camera.x = viewW / 2 - cx * zoom;
  camera.y = viewH / 2 - cy * zoom;
  readCameraIntoScene();
}

/** @param {import('./sceneStore.js').SpineInstance[]} instances */
export function unionWorldBounds(instances) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const inst of instances) {
    if (!inst.visible) continue;
    const b = worldBoundsOf(inst);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/**
 * @param {{ vertical: number | null, horizontal: number | null }} guide
 */
export function drawGuides(guide) {
  if (!guides || !app) return;
  guides.clear();
  if (guide.vertical == null && guide.horizontal == null) return;
  guides.lineStyle(1, 0xff4fa3, 0.95);
  if (guide.vertical != null) {
    guides.moveTo(guide.vertical, 0);
    guides.lineTo(guide.vertical, app.screen.height);
  }
  if (guide.horizontal != null) {
    guides.moveTo(0, guide.horizontal);
    guides.lineTo(app.screen.width, guide.horizontal);
  }
}

/**
 * @param {{ x: number, y: number, width: number, height: number } | null} rect stage space
 */
export function drawMarquee(rect) {
  if (!marquee) return;
  marquee.clear();
  if (!rect || rect.width < 1 || rect.height < 1) return;
  marquee.lineStyle(1, 0xd2ff00, 0.95);
  marquee.beginFill(0xd2ff00, 0.12);
  marquee.drawRect(rect.x, rect.y, rect.width, rect.height);
  marquee.endFill();
}
