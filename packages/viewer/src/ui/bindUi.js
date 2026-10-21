import { GRID_SIZES, MASK_COLORS, TRACK_COLORS, TRACK_COUNT, ZOOM_STEP } from '../constants.js';
import { setOnDoublePick } from '../composer/input.js';
import { liveSkeletonBounds, formatDimension } from '../features/bounds.js';
import { measureInstance, sumPerf } from '../features/perf.js';
import { formatAtlasPageLines, formatPerfAtlasMemory } from '../features/perfDisplay.js';
import { applySkins } from '../features/skins.js';
import { applySlotVisibility, toggleSlotHidden } from '../features/slotVisibility.js';
import { matchesFilter } from '../features/slotPick.js';
import { DEFAULT_DEBUG_FLAGS } from '../features/debugOverlay.js';

const STAGE_GLOBAL_MARKUP = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.2"/><ellipse cx="8" cy="8" rx="2.6" ry="6.2" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M2.2 8h11.6" stroke="currentColor" stroke-width="1.1"/></svg>';

const SLOT_EYE_MARKUP = '<svg class="eye-icon eye-open" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 3.5C5 3.5 2.4 5.8 1.5 8c.9 2.2 3.5 4.5 6.5 4.5s5.6-2.3 6.5-4.5C13.6 5.8 11 3.5 8 3.5zm0 7.2a2.7 2.7 0 110-5.4 2.7 2.7 0 010 5.4z"/></svg><svg class="eye-icon eye-off" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 3.5C5 3.5 2.4 5.8 1.5 8c.7 1.7 2.2 3.4 4.1 4.2l1.2-1.2a2.7 2.7 0 013.8 3.8l1.1 1.1c-1.9-.8-3.4-2.5-4.1-4.2.9-2.2 3.5-4.5 6.5-4.5.8 0 1.5.1 2.2.3l-1.2 1.2a2.7 2.7 0 01-3.8-3.8L9.8 4.8C9.2 4.6 8.6 4.5 8 4.5c-3 0-5.6 2.3-6.5 4.5z"/><path stroke="currentColor" stroke-width="1.2" d="M2.5 2.5 13.5 13.5"/></svg>';
import { currentTrackEntry } from '../tabula/skeletonAccess.js';
import { loadUiState, saveUiState } from '../persistence/uiState.js';
import { serializeScene } from '../persistence/sceneFile.js';
import {
  emit,
  isInstanceSelected,
  reorderInstances,
  scene,
  selected,
  selectedInstances,
  selectionCount,
  selectInstance,
  setPerfScope,
  shiftZ,
  subscribe,
} from '../app/sceneStore.js';
import { redo, undo, withHistory } from '../app/history.js';
import {
  centerInstances,
  deleteInstance,
  duplicateInstance,
  fitInstances,
  resetInstancesToBaseline,
  stopInstances,
  importFiles,
  loadSamples,
  newScene,
  restoreScene,
  discardBrowserSession,
  clearAllBrowserData,
  setAfterTick,
  setBanner,
  setPackagePicker,
  setDebugFlags,
  setRestoreProgress,
  getHealthReportForInstance,
  getHealthScanStateForInstance,
} from '../app/session.js';
import { camera, fitWorldRect, readFps, resetCamera, screenFrameBounds, setScreenFrame, setStageBackground, zoomBy } from '../app/stage.js';
import { formatScreenSize, loadScreenState, saveScreenState } from '../persistence/screenSizes.js';
import {
  pickTransportInstance,
  resolveAnimTargets,
  resolveTransportIsPlaying,
} from './transportLogic.js';
import { bindManual } from './manual.js';
import { bindHealthModals } from './healthModal.js';
import { applyHealthScoreChipStyle } from '../features/assetHealth/findingHelp.js';
import { bindDrawers, openTool } from './drawers.js';
import { flashTimelineEvent, refreshTimeline, renderTimeline } from './timeline.js';
import { applyTrackMode, poseTime, setPoseTime, trackModeOf } from '../app/playback.js';

/** @type {{ open: () => void, close: () => void } | null} */
let manual = null;

/** @type {{ refreshChrome: () => void } | null} */
let healthUi = null;

/** @type {ReturnType<typeof loadUiState>} */
let ui = loadUiState();
/** @type {string} */
let focusedPanel = 'slots-panel';
/** @type {ReturnType<typeof loadScreenState>} */
let screens = loadScreenState();
const panelFilters = {
  slots: '',
  skins: '',
  bones: '',
  animations: '',
};

/** @param {string} message @param {{ label: string, run: () => void }[]=} actions */
function showBanner(message, actions = []) {
  const banner = document.getElementById('banner');
  const text = document.getElementById('banner-text');
  const actionRow = document.getElementById('banner-actions');
  if (!banner || !text || !actionRow) return;
  text.textContent = message;
  actionRow.replaceChildren();
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      hideBanner();
      action.run();
    });
    actionRow.appendChild(button);
  }
  banner.hidden = false;
}

function hideBanner() {
  const banner = document.getElementById('banner');
  if (banner) banner.hidden = true;
}

/** @param {{ visible: boolean, detail?: string }} state */
function setSessionRestoreOverlay(state) {
  const overlay = document.getElementById('session-restore-overlay');
  const detail = document.getElementById('session-restore-detail');
  if (!overlay) return;
  overlay.hidden = !state.visible;
  if (state.detail && detail) detail.textContent = state.detail;
  document.body.classList.toggle('is-restoring-session', state.visible);
}

export function bindUi() {
  setBanner(showBanner);
  setPackagePicker(pickPackageSkeletons);
  setRestoreProgress(setSessionRestoreOverlay);
  setAfterTick(refreshLive);
  ui.perfScope = ui.perfScope === 'all' ? 'all' : 'selected';
  scene.perfScope = ui.perfScope;
  setDebugFlags(ui.debug || DEFAULT_DEBUG_FLAGS);
  applyPanelVisibility();
  bindChrome();
  bindCollapsibles();
  bindDrawers();
  bindFilters();
  bindTransformFields();
  bindDebugFlags();
  bindScreenSizes();
  bindActionMenu();
  manual = bindManual();
  healthUi = bindHealthModals(
    () => scene.instances,
    (id) => scene.instances.find((item) => item.id === id),
  );
  bindHoverTips();
  subscribe(render);
  void discardBrowserSession().then(() => {
    render();
  });
  window.addEventListener('pagehide', () => {
    void discardBrowserSession();
  });
  setOnDoublePick((id) => {
    focusedPanel = 'scene-panel';
    openTool('outliner');
    document.getElementById('scene-panel')?.classList.remove('is-collapsed');
    document.getElementById('transform-all-panel')?.classList.remove('is-collapsed');
    selectInstance(id);
    document.querySelector(`#scene-list li[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const droppedFiles = [...transfer.items].some((item) => item.kind === 'file') || transfer.files.length > 0;
    if (!droppedFiles) return;
    void filesFromDataTransfer(transfer).then((files) => {
      if (files.length) importFiles(files);
    });
  });
}

function bindHoverTips() {
  const tip = document.getElementById('hover-tip');
  if (!tip) return;
  /** @type {Element | null} */
  let anchor = null;

  /** @param {Element} next */
  function show(next) {
    anchor = next;
    tip.textContent = next.getAttribute('data-tip') || '';
    tip.hidden = false;
    const margin = 8;
    const gap = 8;
    const rect = next.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    // Centred above the control; below it when there is no room above. Kept inside the window.
    let left = rect.left + (rect.width - width) / 2;
    let top = rect.top - height - gap;
    if (top < margin) top = rect.bottom + gap;
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - width));
    top = Math.max(margin, Math.min(top, window.innerHeight - margin - height));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function hide() {
    anchor = null;
    tip.hidden = true;
  }

  document.addEventListener('mouseover', (event) => {
    if (!(event.target instanceof Element)) return;
    const next = event.target.closest('[data-tip]');
    if (!next || next === anchor) return;
    show(next);
  });
  document.addEventListener('mouseout', (event) => {
    if (!anchor) return;
    const to = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (to && anchor.contains(to)) return;
    const next = to instanceof Element ? to.closest('[data-tip]') : null;
    if (next && next !== anchor) {
      show(next);
      return;
    }
    hide();
  });
  document.addEventListener('scroll', () => { if (anchor) show(anchor); }, true);
  window.addEventListener('resize', () => { if (anchor) show(anchor); });
}

function bindChrome() {
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => { zoomBy(ZOOM_STEP); refreshZoom(); });
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => { zoomBy(-ZOOM_STEP); refreshZoom(); });
  document.getElementById('btn-zoom-reset')?.addEventListener('click', () => { resetCamera(); refreshZoom(); });
  document.getElementById('btn-transform-fit-all')?.addEventListener('click', () => { fitTransformScope(); refreshZoom(); });
  document.getElementById('btn-transform-center-all')?.addEventListener('click', () => centerTransformScope());
  document.getElementById('btn-transform-stop-all')?.addEventListener('click', () => stopTransformScope());
  document.getElementById('btn-transform-reset-all')?.addEventListener('click', () => resetAssetsToBaseline());
  document.getElementById('btn-scene-visibility')?.addEventListener('click', () => {
    if (!scene.instances.length) return;
    const allHidden = scene.instances.every((item) => !item.visible);
    const nextVisible = allHidden;
    withHistory(() => {
      for (const item of scene.instances) {
        item.visible = nextVisible;
        item.spine.visible = nextVisible;
      }
      emit();
    });
  });
  bindAnimControls();
  bindTimelineToolbar();
  bindStageBackground();
  document.getElementById('btn-snap')?.addEventListener('click', () => {
    scene.snapEnabled = !scene.snapEnabled;
    emit();
  });
  document.getElementById('btn-grid')?.addEventListener('click', () => {
    scene.gridEnabled = !scene.gridEnabled;
    emit();
  });
  document.getElementById('grid-size')?.addEventListener('change', (event) => {
    const select = /** @type {HTMLSelectElement} */ (event.target);
    const size = Number(select.value);
    if (GRID_SIZES.includes(size)) scene.gridSize = size;
    emit();
  });
  document.getElementById('stage-animations')?.addEventListener('click', () => {
    if (selectionCount() > 1) runOnSceneSelection(toggleStageAnimations);
    else {
      const inst = selected();
      if (inst) toggleStageAnimations(inst);
    }
  });
  document.getElementById('btn-play')?.addEventListener('click', () => playTransport());
  document.getElementById('btn-pause')?.addEventListener('click', () => pauseTransport());
  document.getElementById('btn-setup')?.addEventListener('click', () => toggleSetup());
  document.getElementById('btn-samples')?.addEventListener('click', () => { void loadSamples().catch((error) => showBanner(String(error))); });
  document.getElementById('btn-save')?.addEventListener('click', saveScene);
  document.getElementById('btn-clear-all')?.addEventListener('click', () => {
    const ok = window.confirm('Clear all assets from this browser? The stage, saved files, and UI prefs will be removed. This cannot be undone.');
    if (!ok) return;
    void clearAllBrowserData();
  });
  document.getElementById('session-restore-clear')?.addEventListener('click', () => {
    const ok = window.confirm('Stop restoring and clear all saved assets from this browser?');
    if (!ok) return;
    void clearAllBrowserData();
  });
  document.getElementById('btn-open')?.addEventListener('click', () => document.getElementById('file-scene')?.click());
  document.getElementById('btn-import')?.addEventListener('click', () => document.getElementById('file-assets')?.click());
  document.getElementById('file-assets')?.addEventListener('change', (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    void importFiles([...(input.files || [])]);
    input.value = '';
  });
  document.getElementById('file-scene')?.addEventListener('change', async (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const text = await file.text();
    showBanner('Drop the skeleton files for this scene, then they will be placed from the saved layout.', [{
      label: 'Choose files',
      run: () => {
        const picker = document.getElementById('file-restore');
        picker.dataset.scene = text;
        picker.click();
      },
    }]);
  });
  document.getElementById('file-restore')?.addEventListener('change', async (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    const text = input.dataset.scene || '';
    const files = [...(input.files || [])];
    input.value = '';
    try {
      await restoreScene(text, files);
      hideBanner();
    } catch (error) {
      showBanner(error instanceof Error ? error.message : String(error));
    }
  });
  document.getElementById('btn-new-scene')?.addEventListener('click', () => {
    document.getElementById('modal').hidden = false;
  });
  document.getElementById('modal-cancel')?.addEventListener('click', () => {
    document.getElementById('modal').hidden = true;
  });
  document.getElementById('modal-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    document.getElementById('modal').hidden = true;
    void newScene();
  });
  document.getElementById('banner-close')?.addEventListener('click', hideBanner);
  const seekBar = document.getElementById('seek-bar');
  seekBar?.addEventListener('input', onSeek);
  seekBar?.addEventListener('pointerdown', () => { scene.scrubbing = true; });
  seekBar?.addEventListener('pointerup', () => { scene.scrubbing = false; });
  seekBar?.addEventListener('pointercancel', () => { scene.scrubbing = false; });
  document.getElementById('btn-pulse-toggle')?.addEventListener('click', () => {
    const inst = selected();
    if (!inst) return;
    inst.pulse = !inst.pulse;
    emit();
  });
  document.getElementById('btn-mask-color')?.addEventListener('click', () => {
    const inst = selected();
    if (!inst) return;
    inst.maskColorIndex = (inst.maskColorIndex + 1) % MASK_COLORS.length;
    emit();
  });
  document.getElementById('btn-perf-scope')?.addEventListener('click', () => {
    const next = scene.perfScope === 'selected' ? 'all' : 'selected';
    ui.perfScope = next;
    setPerfScope(next);
    persistUi();
  });
  for (const id of ['slots-panel', 'skins-panel', 'animations-panel', 'bones-panel', 'performance-panel', 'scene-panel']) {
    document.getElementById(id)?.addEventListener('pointerdown', () => {
      focusedPanel = id;
      renderFocus();
    });
  }
}

function bindCollapsibles() {
  document.querySelectorAll('.collapsible-panel').forEach((panel) => {
    if (panel.id === 'transform-all-panel') return;
      panel.querySelector('.panel-header')?.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      if (target.closest('input, select, textarea, .panel-filter')) return;
      if (target.closest('button') && !target.classList.contains('btn-collapse') && !target.closest('.btn-collapse')) return;
      panel.classList.toggle('is-collapsed');
    });
  });
}

function bindFilters() {
  const map = [
    ['slots-filter', 'slots', renderSlots],
    ['skins-filter', 'skins', renderSkins],
    ['bones-filter', 'bones', renderBones],
    ['animations-filter', 'animations', renderAnimations],
  ];
  for (const [id, key, renderFn] of map) {
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
    if (!input) continue;
    input.value = panelFilters[/** @type {'slots' | 'skins' | 'bones' | 'animations'} */ (key)];
    input.addEventListener('input', () => {
      panelFilters[/** @type {'slots' | 'skins' | 'bones' | 'animations'} */ (key)] = input.value;
      renderFn(selected());
    });
  }
}

function bindTransformFields() {
  for (const id of ['tf-x', 'tf-y', 'tf-rot', 'tf-sx', 'tf-sy']) {
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
    input?.addEventListener('change', () => commitTransformField(id, Number(input.value)));
  }
}

function bindDebugFlags() {
  const modal = document.getElementById('debug-modal');
  const openBtn = document.getElementById('btn-debug');
  const closeBtn = document.getElementById('debug-close');
  const open = () => {
    const tip = document.getElementById('hover-tip');
    if (tip) tip.hidden = true;
    if (modal) modal.hidden = false;
  };
  const close = () => {
    if (modal) modal.hidden = true;
  };
  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  window.addEventListener('keydown', (event) => {
    if (modal && !modal.hidden && event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  document.querySelectorAll('#debug-modal input[data-debug]').forEach((node) => {
    const input = /** @type {HTMLInputElement} */ (node);
    const key = input.dataset.debug;
    if (!key) return;
    input.checked = !!(ui.debug && ui.debug[key]);
    input.addEventListener('change', () => {
      ui.debug = { ...DEFAULT_DEBUG_FLAGS, ...(ui.debug || {}), [key]: input.checked };
      persistUi();
      setDebugFlags(ui.debug);
      syncDebugButton();
    });
  });
  syncDebugButton();
}

function syncDebugButton() {
  const button = document.getElementById('btn-debug');
  if (!button) return;
  const flags = ui.debug || DEFAULT_DEBUG_FLAGS;
  button.classList.toggle('is-active', Object.values(flags).some(Boolean));
}

function mixedOr(values) {
  if (!values.length) return '';
  const first = values[0];
  return values.every((item) => item === first) ? String(first) : '';
}

function renderTransformFields() {
  const targets = transformTargets().filter((item) => item.visible !== false);
  const ids = ['tf-x', 'tf-y', 'tf-rot', 'tf-sx', 'tf-sy'];
  const empty = !targets.length;
  const fields = empty ? null : {
    'tf-x': mixedOr(targets.map((item) => roundN(item.spine.x, 2))),
    'tf-y': mixedOr(targets.map((item) => roundN(item.spine.y, 2))),
    'tf-rot': mixedOr(targets.map((item) => roundN(item.spine.rotation, 3))),
    'tf-sx': mixedOr(targets.map((item) => roundN(item.spine.scale.x, 3))),
    'tf-sy': mixedOr(targets.map((item) => roundN(item.spine.scale.y, 3))),
  };
  for (const id of ids) {
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
    if (!input) continue;
    input.disabled = empty;
    if (document.activeElement === input) continue;
    input.value = fields ? fields[id] : '';
    input.placeholder = fields && fields[id] === '' ? 'Mixed' : '';
  }
}

/** @param {number} value @param {number} digits */
function roundN(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** @param {string} id @param {number} value */
function commitTransformField(id, value) {
  if (!Number.isFinite(value)) return;
  const targets = transformTargets();
  if (!targets.length) return;
  withHistory(() => {
    for (const inst of targets) {
      if (id === 'tf-x') inst.spine.x = value;
      else if (id === 'tf-y') inst.spine.y = value;
      else if (id === 'tf-rot') inst.spine.rotation = value;
      else if (id === 'tf-sx') inst.spine.scale.x = value;
      else if (id === 'tf-sy') inst.spine.scale.y = value;
    }
    emit();
  });
}

function bindActionMenu() {
  const trigger = document.getElementById('action-menu-trigger');
  const panel = document.getElementById('action-menu-panel');
  const host = document.getElementById('action-menu');
  if (!trigger || !panel || !host) return;
  const close = () => {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (!willOpen) return;
    const rect = trigger.getBoundingClientRect();
    panel.style.top = `${Math.round(rect.bottom + 6)}px`;
    panel.style.left = `${Math.round(rect.left)}px`;
  });
  panel.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button')) close();
  });
  document.addEventListener('pointerdown', (event) => {
    if (panel.hidden) return;
    if (event.target instanceof Node && host.contains(event.target)) return;
    close();
  });
}

function bindScreenSizes() {
  const trigger = document.getElementById('screen-size-trigger');
  const menu = document.getElementById('screen-size-menu');
  const form = /** @type {HTMLFormElement | null} */ (document.getElementById('screen-size-form'));
  trigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = menu?.hasAttribute('hidden');
    menu?.toggleAttribute('hidden', !willOpen);
    trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) renderScreenMenu();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!menu || menu.hidden) return;
    const host = document.getElementById('screen-size');
    if (event.target instanceof Node && host?.contains(event.target)) return;
    menu.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
  });
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const width = Math.round(Number(/** @type {HTMLInputElement} */ (document.getElementById('screen-width')).value));
    const height = Math.round(Number(/** @type {HTMLInputElement} */ (document.getElementById('screen-height')).value));
    if (!width || !height) return;
    const existing = screens.all.find((item) => item.width === width && item.height === height);
    if (existing) {
      chooseScreen(existing.id);
    } else {
      const item = {
        id: `custom-${width}x${height}-${Date.now()}`,
        width,
        height,
        builtin: false,
      };
      screens.custom.push(item);
      screens.all.push(item);
      chooseScreen(item.id);
    }
    form.reset();
  });
  chooseScreen(screens.selectedId, true);
}

function renderScreenMenu() {
  const list = document.getElementById('screen-size-list');
  if (!list) return;
  list.replaceChildren();
  for (const item of screens.all) {
    const row = document.createElement('div');
    row.className = `screen-size-option${item.id === screens.selectedId ? ' is-selected' : ''}`;
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'screen-size-pick';
    pick.textContent = formatScreenSize(item.width, item.height);
    pick.addEventListener('click', () => chooseScreen(item.id));
    row.appendChild(pick);
    if (!item.builtin) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'screen-size-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${formatScreenSize(item.width, item.height)}`);
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        screens.custom = screens.custom.filter((entry) => entry.id !== item.id);
        screens.all = screens.all.filter((entry) => entry.id !== item.id);
        if (screens.selectedId === item.id) chooseScreen(screens.all[0].id);
        else {
          saveScreenState(screens.custom, screens.selectedId);
          renderScreenMenu();
        }
      });
      row.appendChild(remove);
    }
    list.appendChild(row);
  }
}

/** @param {string} id @param {boolean} [fit] */
function chooseScreen(id, fit = true) {
  const item = screens.all.find((entry) => entry.id === id) || screens.all[0];
  if (!item) return;
  screens.selectedId = item.id;
  saveScreenState(screens.custom, screens.selectedId);
  const trigger = document.getElementById('screen-size-trigger');
  if (trigger) trigger.textContent = formatScreenSize(item.width, item.height);
  setScreenFrame({ width: item.width, height: item.height });
  const bounds = screenFrameBounds();
  if (fit && bounds) {
    fitWorldRect(bounds);
    refreshZoom();
  }
  const menu = document.getElementById('screen-size-menu');
  if (menu) menu.hidden = true;
  trigger?.setAttribute('aria-expanded', 'false');
}

function render() {
  const inst = selected();
  const snap = document.getElementById('btn-snap');
  snap?.classList.toggle('is-active', scene.snapEnabled);
  snap && (snap.textContent = scene.snapEnabled ? 'Snap on' : 'Snap off');
  const gridBtn = document.getElementById('btn-grid');
  gridBtn?.classList.toggle('is-active', scene.gridEnabled);
  if (gridBtn) gridBtn.textContent = scene.gridEnabled ? 'Grid on' : 'Grid off';
  const gridSize = /** @type {HTMLSelectElement | null} */ (document.getElementById('grid-size'));
  if (gridSize && document.activeElement !== gridSize) gridSize.value = String(scene.gridSize || 16);
  syncTimelineToolbar();
  const play = document.getElementById('btn-play');
  const pause = document.getElementById('btn-pause');
  if (play) play.hidden = transportIsPlaying();
  if (pause) pause.hidden = !transportIsPlaying();
  renderTransformActionButtons();
  renderTransformFields();
  syncDebugButton();
  const setup = document.getElementById('btn-setup');
  if (setup) {
    setup.textContent = 'Setup pose';
    const picks = selectedInstances();
    if (!scene.instances.length) setup.disabled = true;
    else if (picks.length) setup.disabled = picks.every((item) => item.holdSetup);
    else setup.disabled = scene.instances.every((item) => item.holdSetup);
  }
  document.getElementById('drop-hint')?.toggleAttribute('hidden', scene.instances.length > 0);
  renderSceneList();
  renderSlots(inst);
  renderSkins(inst);
  renderAnimations(inst);
  renderBones(inst);
  refreshZoom();
  refreshLive();
  renderFocus();
  healthUi?.refreshChrome();
}

function renderSceneList() {
  const list = document.getElementById('scene-list');
  const title = document.getElementById('scene-title');
  if (!list || !title) return;
  title.textContent = `Scene (${scene.instances.length})`;
  const sceneVisibility = document.getElementById('btn-scene-visibility');
  if (sceneVisibility) {
    const hasInstances = scene.instances.length > 0;
    sceneVisibility.disabled = !hasInstances;
    if (!hasInstances) {
      sceneVisibility.textContent = 'Hide all';
      sceneVisibility.classList.remove('is-active');
    }
    else {
      const allHidden = scene.instances.every((item) => !item.visible);
      sceneVisibility.textContent = allHidden ? 'Show all' : 'Hide all';
      sceneVisibility.classList.toggle('is-active', allHidden);
    }
  }
  list.replaceChildren();
  const ordered = [...scene.instances].sort((a, b) => a.zIndex - b.zIndex);
  for (const inst of ordered) {
    const inSelection = isInstanceSelected(inst.id);
    const isPrimary = inst.id === scene.selectedId;
    const row = document.createElement('li');
    row.className = inSelection ? 'is-selected' : '';
    row.draggable = true;
    row.dataset.id = inst.id;
    const main = document.createElement('div');
    main.className = 'scene-row-main';

    const healthChip = document.createElement('button');
    healthChip.type = 'button';
    healthChip.className = 'scene-health-chip';
    healthChip.setAttribute('aria-label', `Health score for ${inst.name}`);
    const hState = getHealthScanStateForInstance(inst);
    const hReport = getHealthReportForInstance(inst);
    let chipScore = null;
    if (hState === 'pending' || !hReport) {
      healthChip.classList.add('is-pending');
      healthChip.textContent = '…';
      healthChip.disabled = true;
    } else if (hReport) {
      chipScore = hReport.overallScore;
      healthChip.textContent = String(chipScore);
      healthChip.addEventListener('click', (event) => {
        event.stopPropagation();
        healthUi?.openDetailForInstanceId(inst.id);
      });
    } else {
      healthChip.classList.add('is-unknown');
      healthChip.textContent = '—';
      healthChip.disabled = true;
    }
    applyHealthScoreChipStyle(healthChip, chipScore);

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'scene-name';
    name.textContent = inst.name;
    name.addEventListener('click', (event) => {
      focusedPanel = 'scene-panel';
      selectInstance(inst.id, { additive: event.metaKey || event.ctrlKey });
    });
    name.addEventListener('dblclick', () => rename(inst));
    name.addEventListener('contextmenu', (event) => copyText(event, name, inst.name));
    row.addEventListener('dragstart', (event) => {
      if (event.target instanceof Element && event.target.closest('.scene-actions')) {
        event.preventDefault();
        return;
      }
      row.classList.add('is-dragging');
      event.dataTransfer?.setData('text/plain', inst.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.classList.add('is-drop-target');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove('is-drop-target');
      const fromId = event.dataTransfer?.getData('text/plain');
      if (fromId) withHistory(() => reorderInstances(fromId, inst.id));
    });
    main.append(healthChip, name);
    row.append(main);
    if (isPrimary && inSelection) {
      const actions = document.createElement('span');
      actions.className = 'scene-actions';
      actions.append(
        sceneAction(inst.visible ? 'Hide' : 'Show', () => runOnSceneSelection(toggleVisible), '', shortcutLabel('H')),
        sceneSep(),
        sceneAction(inst.locked ? 'Unlock' : 'Lock', () => runOnSceneSelection(toggleLocked), '', shortcutLabel('L', true)),
        sceneSep(),
        sceneAction('Copy', () => duplicateSceneSelection(), '', shortcutLabel('C')),
        sceneSep(),
        sceneAction('Delete', () => deleteSceneSelection(), '', 'Delete'),
      );
      row.appendChild(actions);
    }
    list.appendChild(row);
  }
}

const macShortcuts = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * @param {string} key
 * @param {boolean} [shift]
 */
function shortcutLabel(key, shift = false) {
  if (macShortcuts) return `⌘${shift ? '⇧' : ''}${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

/** @param {string} label @param {() => void} run @param {string} [className] @param {string} [tip] */
function sceneAction(label, run, className = '', tip = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  if (tip) button.dataset.tip = tip;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    run();
  });
  return button;
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
function toggleVisible(inst) {
  inst.visible = !inst.visible;
  inst.spine.visible = inst.visible;
  emit();
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
function toggleLocked(inst) {
  inst.locked = !inst.locked;
  emit();
}

function sceneSep() {
  const sep = document.createElement('span');
  sep.className = 'scene-sep';
  sep.textContent = '|';
  sep.setAttribute('aria-hidden', 'true');
  return sep;
}

/** @param {(inst: import('../app/sceneStore.js').SpineInstance) => void} fn */
function runOnSceneSelection(fn) {
  const picks = selectedInstances();
  if (!picks.length) return;
  withHistory(() => {
    for (const inst of picks) fn(inst);
  });
}

function duplicateSceneSelection() {
  const ids = selectedInstances().map((inst) => inst.id);
  withHistory(() => {
    for (const id of ids) duplicateInstance(id);
  });
}

function deleteSceneSelection() {
  withHistory(() => {
    for (const id of [...scene.selectedIds]) deleteInstance(id);
  });
}

function playTransport() {
  const picks = selectedInstances();
  const scoped = picks.length > 0;
  const targets = scoped ? picks : scene.instances;
  let anyPlaying = false;
  for (const inst of targets) {
    if (!scoped && inst.stageAnimations === false) {
      inst.playing = false;
      continue;
    }
    if (inst.holdSetup && inst.lastAnimationName) {
      setTrack(inst, 0, inst.lastAnimationName);
      anyPlaying = true;
      continue;
    }
    const track = inst.selectedTrack || 0;
    const name = inst.tracks[track];
    if (name) {
      setTrack(inst, track, name);
      anyPlaying = true;
    } else if (inst.stageAnimations !== false) {
      inst.playing = true;
      anyPlaying = true;
    }
  }
  scene.playing = anyPlaying;
  emit();
}

function pauseTransport() {
  const picks = selectedInstances();
  scene.playing = false;
  const targets = picks.length ? picks : scene.instances;
  for (const inst of targets) inst.playing = false;
  emit();
}

function transformTargets() {
  const picks = selectedInstances();
  return picks.length ? picks : [...scene.instances];
}

function renderTransformActionButtons() {
  const picks = selectedInstances();
  const n = picks.length;
  const disabled = !scene.instances.length;
  const scope = document.getElementById('transform-scope');
  if (scope) {
    scope.textContent = n > 1 ? `${n} selected` : n === 1 ? '1 selected' : 'all';
  }
  /**
   * @param {string} id
   * @param {string} allTip
   * @param {string} oneTip
   * @param {string} manyTip
   */
  const apply = (id, allTip, oneTip, manyTip) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = disabled;
    if (n > 1) el.dataset.tip = manyTip.replace('{n}', String(n));
    else if (n === 1) el.dataset.tip = oneTip;
    else el.dataset.tip = allTip;
  };
  apply(
    'btn-transform-fit-all',
    'Zoom the stage to fit every visible instance.',
    'Zoom the stage to fit the selected instance.',
    'Zoom the stage to fit {n} selected instances.',
  );
  apply(
    'btn-transform-center-all',
    'Move every visible instance so its bounds are centered in the screen frame.',
    'Center the selected instance in the screen frame.',
    'Center {n} selected instances in the screen frame.',
  );
  apply(
    'btn-transform-stop-all',
    'Clear animations on every instance and return to setup pose.',
    'Clear animations on the selected instance and return to setup pose.',
    'Clear animations on {n} selected instances and return to setup pose.',
  );
  apply(
    'btn-transform-reset-all',
    'Return every instance to how it was when added or loaded.',
    'Return this asset to how it was when added or loaded.',
    'Return {n} selected assets to how they were when added or loaded.',
  );
}

function fitTransformScope() {
  const targets = transformTargets();
  if (!targets.length) return;
  fitInstances(targets);
}

function centerTransformScope() {
  const targets = transformTargets();
  if (!targets.length) return;
  withHistory(() => centerInstances(targets));
}

function stopTransformScope() {
  const targets = transformTargets();
  if (!targets.length) return;
  withHistory(() => stopInstances(targets));
}

function resetAssetsToBaseline() {
  const targets = transformTargets();
  if (!targets.length) return;
  withHistory(() => resetInstancesToBaseline(targets));
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
function toggleStageAnimations(inst) {
  inst.stageAnimations = inst.stageAnimations === false;
  if (!inst.stageAnimations) inst.playing = false;
  else if (scene.playing) inst.playing = true;
  emit();
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
function rename(inst) {
  const next = window.prompt('Instance name', inst.name);
  if (next && next.trim()) {
    withHistory(() => {
      inst.name = next.trim();
      emit();
    });
  }
}

/** @param {import('../app/sceneStore.js').SpineInstance | null} inst */
function renderSlots(inst) {
  const title = document.getElementById('slots-title');
  const list = document.getElementById('slots-list');
  const pulse = document.getElementById('btn-pulse-toggle');
  const mask = document.getElementById('btn-mask-color');
  if (!title || !list) return;
  const names = inst?.spine?.skeleton?.data?.slots?.map((slot) => slot.name) || [];
  const visibleNames = names.filter((name) => matchesFilter(name, panelFilters.slots));
  title.textContent = `Slots (${names.length})`;
  pulse?.classList.toggle('is-active', !!inst?.pulse);
  if (mask && inst) {
    mask.dataset.mask = MASK_COLORS[inst.maskColorIndex].attr;
  }
  list.replaceChildren();
  if (names.length && !visibleNames.length) {
    const empty = document.createElement('li');
    empty.className = 'panel-empty';
    empty.textContent = 'No matches';
    list.appendChild(empty);
  }
  for (const name of visibleNames) {
    const item = document.createElement('li');
    const slotHidden = !!inst?.hiddenSlots.has(name);
    item.className = `slot-row${slotHidden ? ' is-slot-hidden' : ''}`;
    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'slot-name';
    nameBtn.textContent = name;
    nameBtn.dataset.slotName = name;
    nameBtn.classList.toggle('is-selected', name === inst?.selectedSlot);
    nameBtn.addEventListener('click', () => {
      if (!inst) return;
      const next = inst.selectedSlot === name ? null : name;
      setSelectedSlot(inst, next);
      emit();
    });
    nameBtn.addEventListener('contextmenu', (event) => copyText(event, nameBtn, name));
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'slot-eye';
    eye.innerHTML = SLOT_EYE_MARKUP;
    eye.setAttribute('aria-label', slotHidden ? `Show slot ${name}` : `Hide slot ${name}`);
    eye.dataset.tip = slotHidden
      ? `Show this slot on the stage. Press H while Slots is focused.`
      : `Hide this slot on the stage. Press H while Slots is focused.`;
    eye.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!inst) return;
      withHistory(() => {
        toggleSlotHidden(inst, name);
        emit();
      });
    });
    item.append(nameBtn, eye);
    list.appendChild(item);
  }
}

function transportIsPlaying() {
  const picks = selectedInstances();
  if (picks.length) {
    return picks.some((item) => {
      if (!item.playing) return false;
      const track = item.selectedTrack || 0;
      return !!currentTrackEntry(item.spine?.state, track)?.animation;
    });
  }
  return resolveTransportIsPlaying({
    scenePlaying: scene.playing,
    selectedInstance: null,
    instances: scene.instances,
  });
}

/** @returns {import('../app/sceneStore.js').SpineInstance | null} */
function transportInstance() {
  const picks = selectedInstances();
  if (picks.length) {
    return pickTransportInstance(picks, picks[picks.length - 1], scene.playing);
  }
  return pickTransportInstance(scene.instances, null, scene.playing);
}

/** @returns {import('../app/sceneStore.js').SpineInstance | null} */
function animControlInstance() {
  return selected() || transportInstance() || scene.instances[0] || null;
}

/** @param {import('../app/sceneStore.js').SpineInstance | null} inst */
function renderSkins(inst) {
  const title = document.getElementById('skins-title');
  const list = document.getElementById('skins-list');
  if (!title || !list) return;
  const skins = inst?.spine?.skeleton?.data?.skins || [];
  title.textContent = `Skins (${skins.length})`;
  list.replaceChildren();
  const visible = skins.filter((skin) => matchesFilter(skin.name, panelFilters.skins));
  if (skins.length && !visible.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'No matches';
    list.appendChild(empty);
  }
  for (const skin of visible) {
    const label = document.createElement('label');
    label.className = 'skin-item';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = skin.name;
    box.checked = !!inst?.skins.has(skin.name);
    box.addEventListener('change', () => {
      if (!inst) return;
      withHistory(() => {
        if (box.checked) inst.skins.add(skin.name);
        else inst.skins.delete(skin.name);
        applySkins(inst);
        inst.spine.update(0);
        emit();
      });
    });
    const span = document.createElement('span');
    span.textContent = skin.name;
    label.append(box, span);
    label.addEventListener('contextmenu', (event) => copyText(event, span, skin.name));
    list.appendChild(label);
  }
}

/** @param {import('../app/sceneStore.js').SpineInstance | null} inst */
function renderAnimations(inst) {
  const title = document.getElementById('animations-title-text');
  const tracks = document.getElementById('anim-timeline');
  const list = document.getElementById('animations-list');
  if (!title || !tracks || !list) return;
  applyMix();
  for (const item of scene.instances) hookEvents(item);
  const multiAnimPick = selectionCount() > 1;
  const anims = inst?.spine?.skeleton?.data?.animations || [];
  title.textContent = multiAnimPick
    ? `Animations (${anims.length}) · last selected`
    : `Animations (${anims.length})`;
  const selectedTrack = inst?.selectedTrack || 0;
  const count = selectionCount();
  const reason = count > 1
    ? `${count} skeletons selected. The timeline works on one skeleton; speed and loop still apply to all of them.`
    : !inst ? 'Select a skeleton to see its animation tracks.' : '';
  renderTimeline(tracks, inst, reason, timelineHandlers(inst), {
    units: ui.timeUnit === 'frames' ? 'frames' : 'seconds',
    fps: timelineFps(),
    showKeys: !!ui.showKeys,
  });
  list.replaceChildren();
  list.style.setProperty('--active-track-color', TRACK_COLORS[selectedTrack]);
  const visibleAnims = anims.filter((anim) => matchesFilter(anim.name, panelFilters.animations));
  if (anims.length && !visibleAnims.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'No matches';
    list.appendChild(empty);
  }
  for (const anim of visibleAnims) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'anim-item';
    if (inst?.tracks[selectedTrack] === anim.name) button.classList.add('is-playing-on-selected');
    const dots = document.createElement('span');
    dots.className = 'anim-track-dots';
    for (let index = 0; index < TRACK_COUNT; index++) {
      if (inst?.tracks[index] === anim.name) {
        const dot = document.createElement('span');
        dot.className = 'anim-track-dot';
        dot.style.background = TRACK_COLORS[index];
        dots.appendChild(dot);
      }
    }
    const mark = document.createElement('span');
    mark.className = 'anim-play';
    const playingThis = !!inst?.playing && inst?.tracks[selectedTrack] === anim.name;
    if (playingThis) {
      mark.append(document.createElement('i'), document.createElement('i'));
    } else {
      mark.classList.add('is-play');
    }
    const name = document.createElement('span');
    name.className = 'anim-item-name';
    name.textContent = anim.name;
    button.disabled = multiAnimPick;
    button.append(mark, dots, name);
    button.addEventListener('click', () => {
      if (!inst || multiAnimPick) return;
      if (inst.tracks[inst.selectedTrack] === anim.name && inst.playing) {
        inst.playing = false;
        emit();
        return;
      }
      withHistory(() => setTrack(inst, inst.selectedTrack, anim.name));
    });
    button.addEventListener('contextmenu', (event) => copyText(event, name, anim.name));
    list.appendChild(button);
  }
  renderStageAnimations(inst);
  syncAnimControls(inst);
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance | null} inst
 * @returns {import('./timeline.js').TimelineHandlers}
 */
function timelineHandlers(inst) {
  return {
    onSelectTrack(track) {
      if (!inst || inst.selectedTrack === track) return;
      inst.selectedTrack = track;
      emit();
    },
    onClearTrack(track) {
      if (inst) withHistory(() => clearTrack(inst, track));
    },
    onSeek(track, time) {
      if (!inst) return;
      const entry = currentTrackEntry(inst.spine?.state, track);
      if (!entry?.animation) return;
      setPoseTime(entry, time);
      applyPose(inst);
    },
    onScrub(active) {
      scene.scrubbing = active;
      if (!active) emit();
    },
  };
}

/** Re-pose a skeleton after its track times were moved by hand. */
function applyPose(inst) {
  inst.spine.state.apply(inst.spine.skeleton);
  inst.spine.update(0);
  refreshLive();
}

/** Frames per second for stepping and the frame ruler. */
function timelineFps() {
  return [24, 30, 60].includes(ui.fps) ? ui.fps : 30;
}

/** The skeleton the timeline drives: the one selected, else the transport's. */
function timelineInstance() {
  return selectionCount() > 1 ? null : selected() || transportInstance();
}

/** @param {number} dir 1 forward, -1 back; wraps around the selected track's animation. */
function stepFrame(dir) {
  const inst = timelineInstance();
  const entry = currentTrackEntry(inst?.spine?.state, inst?.selectedTrack || 0);
  if (!inst || !entry?.animation) return;
  const duration = entry.animation.duration;
  const frame = 1 / timelineFps();
  const now = poseTime(entry);
  let next;
  if (dir > 0) next = now >= duration - frame / 2 ? 0 : Math.min(now + frame, duration);
  else next = now <= frame / 2 ? duration : Math.max(now - frame, 0);
  inst.playing = false;
  setPoseTime(entry, next);
  applyPose(inst);
  emit();
}

/** @param {boolean} end */
function goToEdge(end) {
  const inst = timelineInstance();
  const entry = currentTrackEntry(inst?.spine?.state, inst?.selectedTrack || 0);
  if (!inst || !entry?.animation) return;
  inst.playing = false;
  setPoseTime(entry, end ? entry.animation.duration : 0);
  applyPose(inst);
  emit();
}

function bindTimelineToolbar() {
  document.getElementById('tl-start')?.addEventListener('click', () => goToEdge(false));
  document.getElementById('tl-end')?.addEventListener('click', () => goToEdge(true));
  document.getElementById('tl-prev')?.addEventListener('click', () => stepFrame(-1));
  document.getElementById('tl-next')?.addEventListener('click', () => stepFrame(1));
  document.getElementById('tl-play')?.addEventListener('click', () => {
    const inst = timelineInstance();
    if (!inst) return;
    if (inst.playing) {
      inst.playing = false;
    } else {
      inst.holdSetup = false;
      // Once that already reached its end plays again from the start.
      const entry = currentTrackEntry(inst.spine?.state, inst.selectedTrack || 0);
      if (entry?.animation && !entry.loop && entry.trackTime >= entry.animation.duration) setPoseTime(entry, 0);
      inst.playing = true;
    }
    emit();
  });
  const mix = /** @type {HTMLInputElement | null} */ (document.getElementById('anim-mix'));
  if (mix) {
    mix.value = String(ui.mix || 0);
    mix.addEventListener('change', () => {
      ui.mix = Math.max(0, Math.min(2, Number(mix.value) || 0));
      mix.value = String(ui.mix);
      persistUi();
      applyMix();
    });
  }
  const units = /** @type {HTMLSelectElement | null} */ (document.getElementById('tl-units'));
  const fps = /** @type {HTMLSelectElement | null} */ (document.getElementById('tl-fps'));
  if (units) {
    units.value = ui.timeUnit === 'frames' ? 'frames' : 'seconds';
    units.addEventListener('change', () => { ui.timeUnit = units.value; persistUi(); emit(); });
  }
  if (fps) {
    fps.value = String(timelineFps());
    fps.addEventListener('change', () => { ui.fps = Number(fps.value); persistUi(); emit(); });
  }
  for (const [id, key] of /** @type {const} */ ([['tl-keys', 'showKeys']])) {
    const button = document.getElementById(id);
    button?.setAttribute('aria-pressed', String(!!ui[key]));
    button?.addEventListener('click', () => {
      ui[key] = !ui[key];
      button.setAttribute('aria-pressed', String(!!ui[key]));
      persistUi();
      emit();
    });
  }
}

/** Enable the timeline toolbar for one skeleton with an animation on its selected track. */
function syncTimelineToolbar() {
  const inst = timelineInstance();
  const entry = currentTrackEntry(inst?.spine?.state, inst?.selectedTrack || 0);
  const ready = !!inst && !!entry?.animation;
  for (const id of ['tl-start', 'tl-prev', 'tl-play', 'tl-next', 'tl-end']) {
    const button = /** @type {HTMLButtonElement | null} */ (document.getElementById(id));
    if (button) button.disabled = !ready;
  }
  const play = document.getElementById('tl-play');
  if (play) {
    const playing = ready && !!inst?.playing;
    play.classList.toggle('is-playing', playing);
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
}

/** @type {WeakSet<object>} */
const eventHooked = new WeakSet();

/**
 * Show animation events of the timeline's skeleton as they fire: ruler marker flash and a stage toast.
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 */
function hookEvents(inst) {
  const state = inst.spine?.state;
  if (!state || eventHooked.has(state)) return;
  eventHooked.add(state);
  state.addListener({
    event: (_entry, event) => {
      if (timelineInstance() !== inst || scene.scrubbing) return;
      const timeline = document.getElementById('anim-timeline');
      if (timeline) flashTimelineEvent(timeline, event.name);
      showEventToast(event.name);
    },
  });
}

/** @param {string} name */
function showEventToast(name) {
  const host = document.querySelector('.stage-body');
  if (!host) return;
  let list = document.getElementById('event-toasts');
  if (!list) {
    list = document.createElement('div');
    list.id = 'event-toasts';
    list.setAttribute('aria-live', 'polite');
    host.appendChild(list);
  }
  const toast = document.createElement('div');
  toast.className = 'event-toast';
  toast.textContent = `⚑ ${name}`;
  list.appendChild(toast);
  while (list.children.length > 4) list.firstElementChild?.remove();
  setTimeout(() => toast.remove(), 1200);
}

/** Preview crossfade between animations on every skeleton. */
function applyMix() {
  for (const inst of scene.instances) {
    const data = inst.spine?.state?.data;
    if (data) data.defaultMix = ui.mix || 0;
  }
}

function bindStageBackground() {
  const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('stage-bg'));
  const color = /** @type {HTMLInputElement | null} */ (document.getElementById('stage-bg-color'));
  if (!select || !color) return;
  select.value = ['dark', 'checker', 'light', 'custom'].includes(ui.background) ? ui.background : 'dark';
  color.value = /^#[0-9a-f]{6}$/i.test(ui.backgroundColor || '') ? ui.backgroundColor : '#111111';
  const apply = () => {
    color.hidden = select.value !== 'custom';
    setStageBackground(select.value, color.value);
  };
  select.addEventListener('change', () => { ui.background = select.value; persistUi(); apply(); });
  color.addEventListener('input', () => { ui.backgroundColor = color.value; persistUi(); apply(); });
  apply();
}

function bindAnimControls() {
  const speed = /** @type {HTMLInputElement | null} */ (document.getElementById('anim-speed'));
  const mode = /** @type {HTMLSelectElement | null} */ (document.getElementById('anim-mode'));
  const applyGlobal = /** @type {HTMLInputElement | null} */ (document.getElementById('anim-apply-global'));
  if (applyGlobal) {
    applyGlobal.checked = !!ui.animApplyGlobal;
    applyGlobal.addEventListener('change', () => {
      ui.animApplyGlobal = applyGlobal.checked;
      persistUi();
      const source = selected() || scene.instances[0];
      if (ui.animApplyGlobal && source) {
        for (const other of scene.instances) {
          if (other.id === source.id) continue;
          other.playbackSpeed = source.playbackSpeed;
          other.trackLoop = { ...source.trackLoop };
          other.trackMode = { ...(source.trackMode || {}) };
          if (other.spine?.state) other.spine.state.timeScale = source.playbackSpeed;
        }
      }
      syncAnimControls(selected());
    });
  }
  speed?.addEventListener('input', () => {
    const value = Number(speed.value) / 100;
    setPlaybackSpeed(value);
  });
  mode?.addEventListener('change', () => setTrackMode(mode.value));
}

/** @returns {import('../app/sceneStore.js').SpineInstance[]} */
function animTargets() {
  const picks = selectedInstances();
  if (picks.length > 1) return picks;
  return resolveAnimTargets(scene.instances, selected(), ui.animApplyGlobal);
}

/** @param {number} speed */
function setPlaybackSpeed(speed) {
  const next = Math.max(0.1, Math.min(2, speed));
  for (const inst of animTargets()) {
    inst.playbackSpeed = next;
    if (inst.spine?.state) inst.spine.state.timeScale = next;
  }
  emit();
  syncAnimControls(selected());
}

/** @param {string} mode */
function setTrackMode(mode) {
  for (const inst of animTargets()) {
    const track = inst.selectedTrack || 0;
    inst.trackMode = { ...(inst.trackMode || {}), [track]: mode };
    inst.trackLoop[track] = mode !== 'once';
    const entry = currentTrackEntry(inst.spine?.state, track);
    if (entry) {
      const time = poseTime(entry);
      applyTrackMode(entry, mode);
      setPoseTime(entry, time);
    }
  }
  emit();
  syncAnimControls(selected());
}

/** @param {import('../app/sceneStore.js').SpineInstance | null} inst */
function syncAnimControls(inst) {
  const speed = /** @type {HTMLInputElement | null} */ (document.getElementById('anim-speed'));
  const loop = /** @type {HTMLSelectElement | null} */ (document.getElementById('anim-mode'));
  const display = animControlInstance();
  const disabled = !display;
  if (speed) speed.disabled = disabled;
  if (loop) loop.disabled = disabled;
  if (!display) {
    setText('anim-speed-value', '1.0×');
    if (loop && document.activeElement !== loop) loop.value = 'loop';
    return;
  }
  const track = display.selectedTrack || 0;
  const speedValue = display.playbackSpeed || 1;
  if (speed && document.activeElement !== speed) speed.value = String(Math.round(speedValue * 100));
  setText('anim-speed-value', `${speedValue.toFixed(1)}×`);
  if (loop && document.activeElement !== loop) loop.value = trackModeOf(display, track);
  syncTimelineToolbar();
  const play = document.getElementById('btn-play');
  const pause = document.getElementById('btn-pause');
  const playing = transportIsPlaying();
  if (play) play.hidden = playing;
  if (pause) pause.hidden = !playing;
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {number} ratio 0–1
 */
function seekSelectedTrack(inst, ratio) {
  const track = inst.selectedTrack || 0;
  const entry = currentTrackEntry(inst.spine?.state, track);
  if (!entry?.animation) return;
  setPoseTime(entry, ratio * entry.animation.duration);
  inst.spine.state.apply(inst.spine.skeleton);
  inst.spine.update(0);
  refreshTime();
}

function renderStageAnimations(inst) {
  const stage = document.getElementById('stage-animations');
  if (!stage) return;
  const off = !!inst && inst.stageAnimations === false;
  stage.dataset.tip = `Global stage Play skips this skeleton while this is off. Choosing an animation above still plays it. ${shortcutLabel('A', true)}`;
  stage.disabled = !inst;
  stage.classList.toggle('is-off', off);
  const name = stage.querySelector('.anim-item-name');
  if (name) name.textContent = off ? 'Global animations off' : 'Global animations on';
  const mark = stage.querySelector('.stage-global-mark');
  if (mark) {
    mark.innerHTML = STAGE_GLOBAL_MARKUP;
    mark.classList.toggle('is-off', off);
  }
}

/** @param {import('../app/sceneStore.js').SpineInstance | null} inst */
function renderBones(inst) {
  const title = document.getElementById('bones-title-text');
  const list = document.getElementById('bones-list');
  const inspector = document.getElementById('bone-inspector');
  if (!title || !list || !inspector) return;
  const bones = inst?.spine?.skeleton?.data?.bones || [];
  title.textContent = `Bones (${bones.length})`;
  list.replaceChildren();
  const visibleBones = bones.filter((bone) => matchesFilter(bone.name, panelFilters.bones));
  if (bones.length && !visibleBones.length) {
    const empty = document.createElement('li');
    empty.className = 'panel-empty';
    empty.textContent = 'No matches';
    list.appendChild(empty);
  }
  for (const bone of visibleBones) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.boneName = bone.name;
    const depth = boneDepth(bone);
    const indent = '\u00a0\u00a0'.repeat(depth);
    const prefix = depth > 0 ? '\u2514\u00a0' : '';
    button.textContent = indent + prefix + bone.name;
    button.classList.toggle('is-selected', bone.name === inst?.selectedBone);
    button.addEventListener('click', () => {
      if (!inst) return;
      inst.selectedBone = inst.selectedBone === bone.name ? null : bone.name;
      emit();
    });
    button.addEventListener('contextmenu', (event) => copyText(event, button, bone.name));
    item.appendChild(button);
    list.appendChild(item);
  }
  inspector.classList.toggle('is-hidden', !inst?.selectedBone);
}

/** @param {{ parent?: { name?: string } | null, name: string }} bone */
function boneDepth(bone) {
  let depth = 0;
  let parent = bone.parent;
  while (parent) {
    depth += 1;
    parent = parent.parent;
  }
  return depth;
}

function refreshLive() {
  const inst = selected();
  refreshTime();
  const timeline = document.getElementById('anim-timeline');
  if (timeline && selectionCount() <= 1) refreshTimeline(timeline, inst);
  syncAnimControls(inst);
  refreshBone(inst);
  refreshPerf();
  refreshDimensions(inst);
}

function refreshTime() {
  const label = document.getElementById('time-display');
  const seek = /** @type {HTMLInputElement | null} */ (document.getElementById('seek-bar'));
  if (!label) return;
  const inst = transportInstance();
  const hasSelection = !!selected();
  const track = inst?.selectedTrack || 0;
  const entry = currentTrackEntry(inst?.spine?.state, track);
  const prefix = hasSelection ? 'Selected' : inst ? 'Global' : 'No selection';
  if (!entry?.animation) {
    label.textContent = inst ? `${prefix} · setup` : 'No selection';
    if (seek) {
      seek.value = '0';
      seek.disabled = true;
    }
    return;
  }
  const duration = entry.animation.duration;
  const loop = duration > 0 ? entry.trackTime % duration : entry.trackTime;
  const currentMs = Math.max(0, Math.min(Math.round(loop * 1000), Math.round(duration * 1000) - 1));
  label.textContent = `${prefix} · ${currentMs} ms / ${Math.round(duration * 1000)} ms`;
  if (seek) {
    seek.disabled = false;
    if (document.activeElement !== seek && duration > 0) {
      seek.value = String(Math.round((loop / duration) * 10000));
    }
  }
}

/** @param {import('../app/sceneStore.js').SpineInstance | null} inst */
function refreshBone(inst) {
  if (!inst?.selectedBone) return;
  const bone = inst.spine.skeleton.findBone(inst.selectedBone);
  if (!bone) return;
  const fmt = (value) => Number(value).toFixed(2);
  setText('bi-x', fmt(bone.worldX));
  setText('bi-y', fmt(bone.worldY));
  setText('bi-rot', `${fmt(Math.atan2(bone.c, bone.a) * (180 / Math.PI))}°`);
  setText('bi-sx', fmt(Math.sqrt(bone.a * bone.a + bone.c * bone.c)));
  setText('bi-sy', fmt(Math.sqrt(bone.b * bone.b + bone.d * bone.d)));
  setText('bi-lsx', fmt(bone.scaleX));
  setText('bi-lsy', fmt(bone.scaleY));
}

const FPS_WINDOW_MS = 10000;
/** @type {{ t: number, fps: number }[]} */
const fpsSamples = [];
/** @type {{ key: string, primary: string, secondary: string, pages: string } | null} */
let atlasHudCache = null;

function displayRefreshHz() {
  const hz = Number(typeof window !== 'undefined' && window.screen && 'refreshRate' in window.screen
    ? window.screen.refreshRate
    : 0);
  return hz >= 30 && hz <= 360 ? hz : 120;
}

function fpsGraphCeiling() {
  let peak = displayRefreshHz();
  for (const sample of fpsSamples) {
    if (sample.fps > peak) peak = sample.fps;
  }
  return Math.max(peak, 60);
}

/** @param {boolean} scopeAll @param {import('../app/sceneStore.js').SpineInstance | null} selectedInst */
function atlasHudKey(scopeAll, selectedInst) {
  const ids = scene.instances.map((item) => `${item.id}:${item.zIndex}`).join(',');
  return `${scopeAll ? 'all' : 'sel'}:${selectedInst?.id || ''}:${ids}`;
}

/** @param {number} fps */
function recordFps(fps) {
  const now = performance.now();
  fpsSamples.push({ t: now, fps });
  const cutoff = now - FPS_WINDOW_MS;
  while (fpsSamples.length && fpsSamples[0].t < cutoff) fpsSamples.shift();
  drawFpsGraph(now);
}

/** @param {number} now */
function drawFpsGraph(now) {
  const canvas = document.getElementById('perf-fps-graph');
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, canvas.clientWidth || 240);
  const height = 36;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const ceiling = fpsGraphCeiling();
  const strokeHz = (hz) => {
    if (!(hz > 0) || hz > ceiling) return;
    const y = 1 + (height - 2) * (1 - hz / ceiling);
    if (y < 2) return;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  };
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  strokeHz(60);
  const hz = displayRefreshHz();
  if (hz > 60) strokeHz(hz);
  if (!fpsSamples.length) return;
  ctx.strokeStyle = '#d2ff00';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  fpsSamples.forEach((sample, index) => {
    const x = ((sample.t - (now - FPS_WINDOW_MS)) / FPS_WINDOW_MS) * (width - 1);
    const y = 1 + (height - 2) * (1 - Math.max(0, sample.fps) / ceiling);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function refreshPerf() {
  recordFps(readFps());
  setText('perf-fps', String(Math.round(readFps())));
  if (!scene.instances.length) {
    atlasHudCache = null;
    return;
  }

  const selectedInst = selected();
  const scopeAll = scene.perfScope === 'all';
  const source = scopeAll
    ? scene.instances
    : (selectedInst ? [selectedInst] : []);

  const rows = source.map((inst) => measureInstance(inst));
  const total = sumPerf(rows);
  const hudKey = atlasHudKey(scopeAll, selectedInst);
  if (!atlasHudCache || atlasHudCache.key !== hudKey) {
    const memory = formatPerfAtlasMemory(scene.perfScope, scene.instances, selectedInst);
    const pageInstances = scopeAll ? scene.instances : (selectedInst ? [selectedInst] : []);
    atlasHudCache = {
      key: hudKey,
      primary: memory.primary,
      secondary: memory.secondary,
      pages: formatAtlasPageLines(pageInstances).join('\n'),
    };
  }
  setText('perf-memory', atlasHudCache.primary);
  setText('perf-memory-sub', atlasHudCache.secondary);

  const pages = document.getElementById('perf-atlas-pages');
  if (pages) {
    const next = atlasHudCache.pages;
    if (pages.textContent !== next) pages.textContent = next;
    pages.classList.toggle('is-scroll', scopeAll && source.length > 1);
    pages.style.display = next ? 'block' : 'none';
  }

  const poseNote = document.getElementById('perf-pose-note');
  if (poseNote) {
    const label = selectedInst?.holdSetup ? 'setup pose' : 'current pose';
    poseNote.textContent = source.length
      ? `Vertices and draw calls: ${label}${scopeAll && scene.instances.length > 1 ? ' (summed)' : ''}.`
      : '';
  }

  const peakEl = document.getElementById('perf-health-peak');
  if (peakEl) {
    let peakText = '';
    if (!scopeAll && selectedInst) {
      const report = getHealthReportForInstance(selectedInst);
      if (report?.animations?.length && report.worstAnimation) {
        const row = report.animations.find((a) => a.name === report.worstAnimation)
          || report.animations.reduce((a, b) => (a.runtimeScore <= b.runtimeScore ? a : b));
        peakText = `Health scan peak (${row.name}): ${row.hotDrawCalls} DC, ${row.hotVertices} verts`;
      }
    }
    peakEl.textContent = peakText;
    peakEl.style.display = peakText ? 'block' : 'none';
  }

  setText('perf-vertices', source.length ? String(total.vertexCount) : '—');
  setText('perf-draw-calls', source.length ? String(total.drawCalls) : '—');
  setText('perf-bones', source.length ? String(total.bones) : '—');
  setText('perf-constraints', source.length ? String(total.constraints) : '—');
  setText('perf-constraints-detailed', total.constraintDetail);
  const detail = document.getElementById('perf-constraints-detailed');
  if (detail) detail.style.display = total.constraintDetail ? 'block' : 'none';
  setText('perf-clippings', source.length ? String(total.clippingCount) : '—');
  setText('perf-mask-verts', source.length ? String(total.clippingVertexCount) : '—');
  setText('perf-blends', source.length ? total.blends : '—');
  const scope = document.getElementById('btn-perf-scope');
  if (scope) scope.textContent = scopeAll ? 'All' : 'Selected';
}

/** @param {import('../app/sceneStore.js').SpineInstance | null} inst */
function refreshDimensions(inst) {
  const el = document.getElementById('dimensions-value');
  if (!el) return;
  if (!inst) {
    el.textContent = '—';
    return;
  }
  const bounds = liveSkeletonBounds(inst);
  if (!bounds) {
    el.textContent = '—';
    return;
  }
  el.textContent = `${formatDimension(bounds.width)} × ${formatDimension(bounds.height)}`;
}

function refreshZoom() {
  const label = document.getElementById('zoom-label');
  if (label && camera) label.textContent = `${Math.round(camera.scale.x * 100)}%`;
}

function renderFocus() {
  for (const id of ['scene-panel', 'slots-panel', 'skins-panel', 'animations-panel', 'bones-panel', 'performance-panel']) {
    document.getElementById(id)?.classList.toggle('is-focused', id === focusedPanel);
  }
}

function applyPanelVisibility() {
  document.getElementById('slots-panel')?.classList.remove('is-hidden');
  document.getElementById('performance-panel')?.classList.add('is-visible');
  document.getElementById('skins-panel')?.classList.add('is-visible');
  document.getElementById('animations-panel')?.classList.add('is-visible');
  document.getElementById('bones-panel')?.classList.add('is-visible');
}

function persistUi() {
  saveUiState(ui);
}

/** @param {KeyboardEvent} event */
function onKeyDown(event) {
  if (isTyping(event.target)) return;
  if ((event.key === '?' || (event.key === '/' && event.shiftKey)) && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    manual?.open();
    return;
  }
  const command = event.metaKey || event.ctrlKey;
  if (command && !event.altKey) {
    if (event.code === 'KeyZ' && event.shiftKey) {
      event.preventDefault();
      void redo();
      return;
    }
    if (event.code === 'KeyZ') {
      event.preventDefault();
      void undo();
      return;
    }
    if (event.code === 'KeyY') {
      event.preventDefault();
      void redo();
      return;
    }
    const inst = selected();
    if (event.code === 'KeyC' && !event.shiftKey) {
      if (!selectedInstances().length) return;
      event.preventDefault();
      duplicateSceneSelection();
      return;
    }
    if (event.code === 'KeyH' && !event.shiftKey) {
      if (!selectedInstances().length) return;
      event.preventDefault();
      runOnSceneSelection(toggleVisible);
      return;
    }
    if (event.code === 'KeyL' && event.shiftKey) {
      if (!selectedInstances().length) return;
      event.preventDefault();
      runOnSceneSelection(toggleLocked);
      return;
    }
    if (event.code === 'KeyA' && event.shiftKey) {
      if (!selectedInstances().length) return;
      event.preventDefault();
      runOnSceneSelection(toggleStageAnimations);
      return;
    }
  }
  if (event.code === 'KeyH' && !command && !event.shiftKey && !event.altKey) {
    const inst = selected();
    if (inst && focusedPanel === 'slots-panel' && inst.selectedSlot) {
      event.preventDefault();
      withHistory(() => {
        toggleSlotHidden(inst, inst.selectedSlot);
        emit();
      });
      return;
    }
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (scene.selectedIds.size) {
      event.preventDefault();
      deleteSceneSelection();
    }
    return;
  }
  if (event.key === '[') {
    withHistory(() => {
      for (const item of selectedInstances()) shiftZ(item.id, -1);
    });
    return;
  }
  if (event.key === ']') {
    withHistory(() => {
      for (const item of selectedInstances()) shiftZ(item.id, 1);
    });
    return;
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    movePanel(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if ((event.key === 'Home' || event.key === 'End') && !command) {
    event.preventDefault();
    goToEdge(event.key === 'End');
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    seekByKeyboard(event);
  }
}

/** @param {KeyboardEvent} event */
function onKeyUp(event) {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') scene.scrubbing = false;
}

/** @param {number} direction */
function movePanel(direction) {
  const inst = selected();
  if (!inst) return;
  if (focusedPanel === 'scene-panel') {
    const ordered = [...scene.instances].sort((a, b) => a.zIndex - b.zIndex);
    const index = ordered.findIndex((item) => item.id === scene.selectedId);
    const next = clampIndex(index, ordered.length, direction);
    if (ordered[next]) selectInstance(ordered[next].id);
    if (scene.selectedId) {
      document.querySelector(`#scene-list li[data-id="${CSS.escape(scene.selectedId)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  } else if (focusedPanel === 'slots-panel') {
    const names = inst.spine.skeleton.data.slots.map((slot) => slot.name)
      .filter((name) => matchesFilter(name, panelFilters.slots));
    const index = names.indexOf(inst.selectedSlot || '');
    const next = clampIndex(index, names.length, direction);
    setSelectedSlot(inst, names[next]);
    emit();
    document.querySelector('#slots-list .slot-name.is-selected')?.scrollIntoView({ block: 'nearest' });
  } else if (focusedPanel === 'animations-panel') {
    const anims = (inst.spine.skeleton.data.animations || [])
      .filter((anim) => matchesFilter(anim.name, panelFilters.animations));
    const index = anims.findIndex((anim) => anim.name === inst.tracks[inst.selectedTrack]);
    const next = clampIndex(index, anims.length, direction);
    if (anims[next]) setTrack(inst, inst.selectedTrack, anims[next].name);
  } else if (focusedPanel === 'bones-panel') {
    const bones = (inst.spine.skeleton.data.bones || [])
      .filter((bone) => matchesFilter(bone.name, panelFilters.bones));
    const index = bones.findIndex((bone) => bone.name === inst.selectedBone);
    const next = clampIndex(index, bones.length, direction);
    inst.selectedBone = bones[next]?.name || null;
    emit();
    document.querySelector('#bones-list button.is-selected')?.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {string | null} name
 */
function setSelectedSlot(inst, name) {
  inst.selectedSlot = name;
  inst.spine.skeleton.setToSetupPose();
  inst.spine.state.apply(inst.spine.skeleton);
  applySlotVisibility(inst);
}

/** @param {number} index @param {number} length @param {number} direction */
function clampIndex(index, length, direction) {
  if (!length) return 0;
  if (index < 0) return direction > 0 ? 0 : length - 1;
  return Math.max(0, Math.min(length - 1, index + direction));
}

/** @param {KeyboardEvent} event */
function seekByKeyboard(event) {
  const transport = transportInstance();
  const track = transport?.selectedTrack || 0;
  const entry = currentTrackEntry(transport?.spine?.state, track);
  if (!transport || !entry?.animation) return;
  event.preventDefault();
  stepFrame(event.key === 'ArrowRight' ? 1 : -1);
}

function onSeek() {
  const seek = /** @type {HTMLInputElement} */ (document.getElementById('seek-bar'));
  if (!seek) return;
  applySeekRatio(Number(seek.value) / 10000);
}

/** @param {number} ratio 0–1 */
function applySeekRatio(ratio) {
  const picked = selected();
  if (picked) {
    seekSelectedTrack(picked, ratio);
    return;
  }
  for (const item of scene.instances) {
    const track = item.selectedTrack || 0;
    if (currentTrackEntry(item.spine?.state, track)?.animation) seekSelectedTrack(item, ratio);
  }
  refreshTime();
}

/** @param {import('../app/sceneStore.js').SpineInstance} item */
function resetInstanceToSetup(item) {
  item.playing = false;
  item.holdSetup = true;
  item.spine.state.clearTracks();
  item.tracks = {};
  item.spine.skeleton.setToSetupPose();
  item.spine.state.apply(item.spine.skeleton);
  applySlotVisibility(item);
  item.spine.update(0);
}

function toggleSetup() {
  const picks = selectedInstances();
  if (picks.length) {
    if (picks.every((item) => item.holdSetup)) return;
    scene.playing = false;
    for (const item of picks) resetInstanceToSetup(item);
    emit();
    return;
  }
  if (!scene.instances.length) return;
  scene.playing = false;
  for (const item of scene.instances) resetInstanceToSetup(item);
  emit();
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst @param {number} track @param {string} name */
function setTrack(inst, track, name) {
  inst.holdSetup = false;
  const mode = trackModeOf(inst, track);
  const entry = inst.spine.state.setAnimation(track, name, mode !== 'once');
  applyTrackMode(entry, mode);
  inst.tracks[track] = name;
  if (track === 0) inst.lastAnimationName = name;
  inst.playing = true;
  inst.spine.update(0);
  emit();
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst @param {number} track */
function clearTrack(inst, track) {
  inst.spine.state.clearTrack(track);
  delete inst.tracks[track];
  if (track === 0) {
    inst.holdSetup = true;
    inst.playing = false;
    inst.spine.skeleton.setToSetupPose();
  }
  inst.spine.update(0);
  emit();
}

function saveScene() {
  const blob = new Blob([JSON.stringify(serializeScene(scene), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'spine-scene.json';
  link.click();
  URL.revokeObjectURL(url);
}

/** @param {DragEvent} event @param {HTMLElement} el @param {string} text */
function copyText(event, el, text) {
  event.preventDefault();
  const original = el.textContent;
  void navigator.clipboard?.writeText(text).then(() => {
    el.textContent = 'Copied!';
    setTimeout(() => { el.textContent = original; }, 1000);
  });
}

/** @param {string} id @param {string} text */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/** @param {EventTarget | null} target */
function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** @param {DataTransfer | null} transfer */
async function filesFromDataTransfer(transfer) {
  if (!transfer) return [];
  /** @type {File[]} */
  const files = [];
  const entries = [...transfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    for (const entry of entries) await walkEntry(entry, files);
  }
  if (!files.length) files.push(...transfer.files);
  return files;
}

/** @param {FileSystemEntry} entry @param {File[]} out */
function walkEntry(entry, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        out.push(file);
        resolve();
      });
      return;
    }
    if (!entry.isDirectory) {
      resolve();
      return;
    }
    const reader = entry.createReader();
    const batch = () => {
      reader.readEntries(async (entries) => {
        if (!entries.length) {
          resolve();
          return;
        }
        for (const child of entries) await walkEntry(child, out);
        batch();
      });
    };
    batch();
  });
}

/** Skeletons chosen at once when an export lists few; a bigger export starts with none picked. */
const PICK_ALL_UP_TO = 12;

/**
 * Let the user pick which skeletons of an opened export go on the stage.
 * @param {{ label: string, skeletons: { name: string, group: string, format: 'tbin' | 'json' }[], tiers: number[] }} info
 * @returns {Promise<{ names: string[], tier: number } | null>} the picked skeletons and the resolution tier, or null when cancelled
 */
function pickPackageSkeletons(info) {
  const modal = document.getElementById('package-modal');
  const form = /** @type {HTMLFormElement} */ (document.getElementById('package-form'));
  const list = document.getElementById('package-list');
  const filter = /** @type {HTMLInputElement} */ (document.getElementById('package-filter'));
  const count = document.getElementById('package-count');
  const addButton = /** @type {HTMLButtonElement} */ (document.getElementById('package-add'));
  document.getElementById('package-label').textContent = `${info.label}: ${info.skeletons.length} skeletons`;
  const picked = new Set(info.skeletons.length <= PICK_ALL_UP_TO ? info.skeletons.map((item) => item.name) : []);
  filter.value = '';
  const tierSelect = /** @type {HTMLSelectElement} */ (document.getElementById('package-tier'));
  tierSelect.replaceChildren(...info.tiers.map((tier) => {
    const option = document.createElement('option');
    option.value = String(tier);
    option.textContent = `${tier}x`;
    return option;
  }));
  tierSelect.value = info.tiers.includes(1) ? '1' : String(info.tiers[0]);
  document.getElementById('package-tier-label').hidden = info.tiers.length < 2;

  const render = () => {
    list.replaceChildren();
    for (const item of info.skeletons) {
      if (!matchesFilter(item.name, filter.value)) continue;
      const label = document.createElement('label');
      label.className = 'package-item';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = picked.has(item.name);
      box.addEventListener('change', () => {
        if (box.checked) picked.add(item.name);
        else picked.delete(item.name);
        refresh();
      });
      const name = document.createElement('span');
      name.textContent = item.name;
      const meta = document.createElement('small');
      meta.textContent = `${item.format === 'json' ? 'raw' : 'compiled'}${item.group ? ` · ${item.group}` : ''}`;
      label.append(box, name, meta);
      list.appendChild(label);
    }
    refresh();
  };
  const refresh = () => {
    count.textContent = `${picked.size} selected`;
    addButton.disabled = picked.size === 0;
  };

  return new Promise((resolve) => {
    const visible = () => info.skeletons.filter((item) => matchesFilter(item.name, filter.value)).map((item) => item.name);
    const done = (/** @type {{ names: string[], tier: number } | null} */ value) => {
      modal.hidden = true;
      controller.abort();
      resolve(value);
    };
    const controller = new AbortController();
    const { signal } = controller;
    filter.addEventListener('input', render, { signal });
    document.getElementById('package-all').addEventListener('click', () => { for (const name of visible()) picked.add(name); render(); }, { signal });
    document.getElementById('package-none').addEventListener('click', () => { for (const name of visible()) picked.delete(name); render(); }, { signal });
    document.getElementById('package-cancel').addEventListener('click', () => done(null), { signal });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      done({ names: info.skeletons.map((item) => item.name).filter((name) => picked.has(name)), tier: Number(tierSelect.value) });
    }, { signal });
    render();
    modal.hidden = false;
    filter.focus();
  });
}
