import { GRID_SIZES, MASK_COLORS, OUTLINER_STORAGE_KEY, TRACK_COLORS, TRACK_COUNT, ZOOM_STEP } from '../constants.js';
import { setOnDoublePick, setOnEmptyClick } from '../composer/input.js';
import { liveSkeletonBounds, formatDimension } from '../features/bounds.js';
import { countSceneDraws, getGpuTextureUnits, getTextureUnits, marginalAtlasBytesForInstance, measureInstance, sceneAtlasMemorySummary, setTextureUnits, sumPerf } from '../features/perf.js';
import { formatAtlasPageLines, formatMb, formatPerfAtlasMemory } from '../features/perfDisplay.js';
import { canMeasurePageMemory, measurePageMemory, pageMemoryUnavailableReason, readJsHeap } from '../features/memory.js';
import { bindBudget, bindRecorder, loadStatsText, recentStutters, recordFrame as recordPerfFrame, renderBudget, trackStutter } from './perfExtras.js';
import { applySkins } from '../features/skins.js';
import { applySlotVisibility, setAllSlotsHidden, toggleSlotHidden } from '../features/slotVisibility.js';
import { matchesFilter } from '../features/slotPick.js';
import { buildAssetTree, keyedTargets, openByDefault, pathTo, visibleRows } from '../features/outlinerTree.js';
import { icon, nodeIcon } from './icons.js';
import { DEFAULT_DEBUG_FLAGS } from '../features/debugOverlay.js';
import { selectionMarksVisible, setSelectionMarksVisible } from '../features/highlight.js';

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
import { canRedo, canUndo, redo, undo, withHistory } from '../app/history.js';
import {
  centerInstances,
  centerAllInstances,
  deleteInstance,
  duplicateInstance,
  fitInstances,
  resetInstancesToBaseline,
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
  getLoadStatsForInstance,
  getUpdateMsForInstance,
  getHealthScanStateForInstance,
} from '../app/session.js';
import { camera, fitWorldRect, readFps, readFrameStats, resetCamera, screenFrameBounds, setScreenFrame, setStageBackground, zoomBy } from '../app/stage.js';
import { formatScreenSize, loadScreenState, saveScreenState } from '../persistence/screenSizes.js';
import {
  pickTransportInstance,
  resolveAnimTargets,
} from './transportLogic.js';
import { bindManual } from './manual.js';
import { bindHealthModals } from './healthModal.js';
import { applyHealthScoreChipStyle } from '../features/assetHealth/findingHelp.js';
import { bindDrawers, openTool } from './drawers.js';
import { bindSimpleMode } from './simpleMode.js';
import { flashTimelineEvent, refreshTimeline, renderTimeline } from './timeline.js';
import { applyTrackMode, poseTime, setPoseTime, trackModeOf } from '../app/playback.js';

/** @type {{ open: () => void, close: () => void } | null} */
let manual = null;

/** @type {{ refreshChrome: () => void } | null} */
let healthUi = null;

/** @type {ReturnType<typeof loadUiState>} */
let ui = loadUiState();
setSelectionMarksVisible(ui.selectionMarks !== false);
/** @type {string} */
/** Panel the arrow keys and H act on; none until one is clicked. */
let focusedPanel = '';
/** @type {ReturnType<typeof loadScreenState>} */
let screens = loadScreenState();
const panelFilters = {
  outliner: '',
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
  bindSimpleMode({ setTrack: (inst, track, name) => withHistory(() => setTrack(inst, track, name)), clearTrack: (inst, track) => withHistory(() => clearTrack(inst, track)) });
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
  // Rows are rebuilt on redraw and can vanish under the pointer without a leave event; the list's own leave clears hover.
  document.getElementById('scene-list')?.addEventListener('pointerleave', () => {
    for (const inst of scene.instances) inst.hoverBone = null;
  });
  void discardBrowserSession().then(() => {
    render();
  });
  window.addEventListener('pagehide', () => {
    void discardBrowserSession();
  });
  // Empty stage drops the slot, bone and attachment highlights too, not just the selection.
  setOnEmptyClick(() => {
    for (const inst of scene.instances) {
      if (inst.selectedSlot) setSelectedSlot(inst, null);
      inst.selectedBone = null;
    }
    outlinerAttachment = null;
  });
  setOnDoublePick((id) => {
    focusedPanel = 'scene-panel';
    openTool('outliner');
    document.getElementById('scene-panel')?.classList.remove('is-collapsed');
    document.getElementById('transform-all-panel')?.classList.remove('is-collapsed');
    outlinerScrollPending = true;
    outlinerCursor = `${id}|asset`;
    selectInstance(id);
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
  document.getElementById('btn-center-all')?.addEventListener('click', () => {
    if (!scene.instances.length) return;
    withHistory(() => centerAllInstances());
    showScreenFrame();
  });
  document.getElementById('zoom-label')?.addEventListener('click', () => { resetCamera(); refreshZoom(); });
  document.getElementById('btn-undo')?.addEventListener('click', () => { void undo(); });
  document.getElementById('btn-redo')?.addEventListener('click', () => { void redo(); });
  document.getElementById('btn-transform-fit-all')?.addEventListener('click', () => { fitTransformScope(); refreshZoom(); });
  document.getElementById('btn-transform-center-all')?.addEventListener('click', () => centerTransformScope());
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
  document.getElementById('btn-marks')?.addEventListener('click', toggleSelectionMarks);
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
    const targets = highlightTargets();
    if (!targets.length) return;
    const next = !targets[0].pulse;
    for (const inst of targets) inst.pulse = next;
    emit();
  });
  document.getElementById('btn-mask-color')?.addEventListener('click', () => {
    const targets = highlightTargets();
    if (!targets.length) return;
    const next = (targets[0].maskColorIndex + 1) % MASK_COLORS.length;
    for (const inst of targets) inst.maskColorIndex = next;
    emit();
  });
  document.querySelectorAll('[data-perf-scope]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = /** @type {HTMLElement} */ (button).dataset.perfScope === 'all' ? 'all' : 'selected';
      ui.perfScope = next;
      setPerfScope(next);
      persistUi();
    });
  });
  for (const id of ['animations-panel', 'performance-panel', 'scene-panel']) {
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
    ['outliner-filter', 'outliner', () => renderSceneList()],
    ['animations-filter', 'animations', renderAnimations],
  ];
  for (const [id, key, renderFn] of map) {
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
    if (!input) continue;
    input.value = panelFilters[/** @type {'outliner' | 'animations'} */ (key)];
    input.addEventListener('input', () => {
      panelFilters[/** @type {'outliner' | 'animations'} */ (key)] = input.value;
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
  /** @param {boolean} on */
  const setAll = (on) => {
    ui.debug = { ...DEFAULT_DEBUG_FLAGS, ...(ui.debug || {}) };
    document.querySelectorAll('#debug-modal input[data-debug]').forEach((node) => {
      const input = /** @type {HTMLInputElement} */ (node);
      input.checked = on;
      if (input.dataset.debug) ui.debug[input.dataset.debug] = on;
    });
    persistUi();
    setDebugFlags(ui.debug);
    syncDebugButton();
  };
  const scope = /** @type {HTMLInputElement | null} */ (document.getElementById('debug-selected-only'));
  if (scope) {
    scope.checked = !!ui.debug?.selectedOnly;
    scope.addEventListener('change', () => {
      ui.debug = { ...DEFAULT_DEBUG_FLAGS, ...(ui.debug || {}), selectedOnly: scope.checked };
      persistUi();
      setDebugFlags(ui.debug);
    });
  }
  document.getElementById('debug-all-on')?.addEventListener('click', () => setAll(true));
  document.getElementById('debug-all-off')?.addEventListener('click', () => setAll(false));
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
  // The scope switch is not an overlay, so it alone does not light the button.
  button.classList.toggle('is-active', Object.entries(flags).some(([key, on]) => key !== 'selectedOnly' && on));
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
    panel.style.left = `${Math.round(Math.max(8, rect.right - panel.offsetWidth))}px`;
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

let hadInstances = false;

/** Zoom the stage so the screen frame fills it, centered. */
function showScreenFrame() {
  const bounds = screenFrameBounds();
  if (!bounds) return;
  fitWorldRect(bounds);
  refreshZoom();
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
  snap?.setAttribute('aria-pressed', String(!!scene.snapEnabled));
  const marksBtn = document.getElementById('btn-marks');
  marksBtn?.classList.toggle('is-active', selectionMarksVisible());
  marksBtn?.setAttribute('aria-pressed', String(selectionMarksVisible()));
  const gridBtn = document.getElementById('btn-grid');
  gridBtn?.classList.toggle('is-active', scene.gridEnabled);
  gridBtn?.setAttribute('aria-pressed', String(!!scene.gridEnabled));
  const gridSize = /** @type {HTMLSelectElement | null} */ (document.getElementById('grid-size'));
  if (gridSize) {
    if (document.activeElement !== gridSize) gridSize.value = String(scene.gridSize || 16);
    gridSize.disabled = !scene.gridEnabled;
  }
  syncTimelineToolbar();
  // The animations drawer needs a skeleton to show; it waits until one is selected.
  const drawer = document.getElementById('bottom-drawer');
  const animationsTool = /** @type {HTMLButtonElement | null} */ (document.querySelector('.rail-tool[data-tool="animations"]'));
  if (drawer && drawer.classList.contains('is-unavailable') !== !inst) {
    drawer.classList.toggle('is-unavailable', !inst);
    window.dispatchEvent(new Event('resize'));
  }
  if (animationsTool) {
    // aria-disabled, not disabled: a disabled button gets no hover, so its tip could not say why.
    animationsTool.setAttribute('aria-disabled', String(!inst));
    animationsTool.dataset.tip = inst ? 'Animations' : 'Animations · select a skeleton first';
  }
  renderUndoButtons();
  renderTransformActionButtons();
  renderTransformFields();
  syncDebugButton();
  const setup = document.getElementById('btn-setup');
  if (setup) {
    const picks = selectedInstances().length ? selectedInstances() : scene.instances;
    setup.disabled = !picks.length || picks.every((item) => item.holdSetup && !item.playing);
  }
  document.getElementById('drop-hint')?.toggleAttribute('hidden', scene.instances.length > 0);
  // The drop screen just went away: start with the whole screen frame in view, not wherever assets landed.
  if (!hadInstances && scene.instances.length) showScreenFrame();
  hadInstances = scene.instances.length > 0;
  scheduleSceneList();
  renderAnimations(inst);
  refreshZoom();
  refreshLive();
  renderFocus();
  healthUi?.refreshChrome();
}

/** Branch open state the user set, by node key; untouched branches use `openByDefault`. @type {Map<string, boolean>} */
const outlinerOpen = new Map();
/** Instances whose open branches were already seeded from storage. @type {Set<string>} */
const outlinerSeeded = new Set();
let outlinerOpenDirty = false;

/** @param {string} key @param {boolean} open */
function setOutlinerOpen(key, open) {
  outlinerOpen.set(key, open);
  outlinerOpenDirty = true;
}

/** Open branches per asset file, so dropping the same asset again opens it the same way. @returns {Record<string, string[]>} */
function readOutlinerOpen() {
  try {
    const raw = JSON.parse(localStorage.getItem(OUTLINER_STORAGE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** Give instances seen for the first time the open branches saved for their asset. */
function seedOutlinerOpen() {
  /** @type {Record<string, string[]> | null} */
  let stored = null;
  for (const inst of scene.instances) {
    if (outlinerSeeded.has(inst.id)) continue;
    outlinerSeeded.add(inst.id);
    stored ??= readOutlinerOpen();
    for (const suffix of stored[inst.assetKey || inst.name] || []) {
      if (!outlinerOpen.has(`${inst.id}|${suffix}`)) outlinerOpen.set(`${inst.id}|${suffix}`, true);
    }
  }
}

function saveOutlinerOpen() {
  if (!outlinerOpenDirty) return;
  outlinerOpenDirty = false;
  const stored = readOutlinerOpen();
  /** @type {Record<string, string[]>} */
  const next = {};
  for (const inst of scene.instances) next[inst.assetKey || inst.name] ??= [];
  for (const [key, open] of outlinerOpen) {
    if (!open) continue;
    const cut = key.indexOf('|');
    const inst = scene.instances.find((item) => item.id === key.slice(0, cut));
    if (inst) next[inst.assetKey || inst.name].push(key.slice(cut + 1));
  }
  for (const [asset, branches] of Object.entries(next)) stored[asset] = [...new Set(branches)];
  try {
    localStorage.setItem(OUTLINER_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* ignore */
  }
}
/** Rows drawn last, in order, for arrow-key walking. @type {import('../features/outlinerTree.js').OutlinerRow[]} */
let outlinerRows = [];
/** Key of the row the arrow keys move from. @type {string | null} */
let outlinerCursor = null;
/** Attachment rows drawn last, so the live pass can mark the attachment each slot is showing. @type {{ el: HTMLElement, inst: import('../app/sceneStore.js').SpineInstance, slot: string, attachment: unknown }[]} */
let outlinerAttachmentRows = [];
/** Last selection revealed per instance, so canvas picks open their branch once. @type {Map<string, string>} */
const outlinerRevealed = new Map();
/** @type {string | null} */
let outlinerAutoOpened = null;
/** Row kinds the type buttons keep; empty shows every kind. @type {Set<string>} */
const outlinerKinds = new Set();
const OUTLINER_KIND_BUTTONS = [
  ['bone', 'bone', 'Bones'],
  ['slot', 'slot', 'Slots'],
  ['attachment', 'region', 'Attachments'],
  ['constraint', 'constraint', 'Constraints'],
  ['event', 'event', 'Events'],
  ['order', 'order', 'Draw order'],
  ['hidden', 'eyeOff', 'Hidden slots'],
];

/** @returns {boolean} */
function outlinerFiltering() {
  return !!panelFilters.outliner.trim() || outlinerKinds.size > 0;
}

function renderOutlinerTypes() {
  const bar = document.getElementById('outliner-types');
  if (!bar) return;
  if (!bar.childElementCount) {
    for (const [kind, glyph, label] of OUTLINER_KIND_BUTTONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.kind = kind;
      button.className = `outliner-type element-${glyph}`;
      button.innerHTML = icon(glyph);
      button.setAttribute('aria-label', `Show only ${label.toLowerCase()}`);
      button.dataset.tip = `Show only ${label.toLowerCase()}. Shift adds to the filter.`;
      button.addEventListener('click', (event) => {
        if (event.shiftKey) {
          if (outlinerKinds.has(kind)) outlinerKinds.delete(kind);
          else outlinerKinds.add(kind);
        } else if (outlinerKinds.size === 1 && outlinerKinds.has(kind)) outlinerKinds.clear();
        else {
          outlinerKinds.clear();
          outlinerKinds.add(kind);
        }
        renderSceneList();
      });
      bar.appendChild(button);
    }
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'outliner-type outliner-type-all';
    all.textContent = 'All';
    all.dataset.tip = 'Show every type.';
    all.addEventListener('click', () => {
      outlinerKinds.clear();
      renderSceneList();
    });
    bar.appendChild(all);
  }
  for (const button of bar.querySelectorAll('button[data-kind]')) {
    button.setAttribute('aria-pressed', String(outlinerKinds.has(/** @type {HTMLElement} */ (button).dataset.kind || '')));
  }
  const all = bar.querySelector('.outliner-type-all');
  if (all) /** @type {HTMLButtonElement} */ (all).disabled = !outlinerKinds.size;
}
let outlinerScrollPending = false;

/** @param {import('../features/outlinerTree.js').OutlinerNode} node */
function isOutlinerOpen(node) {
  const set = outlinerOpen.get(node.key);
  if (set !== undefined) return set;
  return node.kind !== 'asset' && openByDefault(node);
}

/** Last tree per instance and what it was built from; renders during a stage drag reuse it. @type {Map<string, { sig: string, tree: import('../features/outlinerTree.js').OutlinerNode }>} */
const outlinerTreeCache = new Map();

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
function assetTree(inst) {
  const skeleton = inst.spine?.skeleton;
  const animations = [];
  for (let track = 0; track < TRACK_COUNT; track++) animations.push(currentTrackEntry(inst.spine?.state, track)?.animation);
  // Draw order only matters while its branch is open (the live pass redraws it then).
  const order = outlinerOpen.get(`${inst.id}|g:order`) ? (skeleton?.drawOrder || []).map((slot) => slot.data.name).join(',') : '';
  const sig = JSON.stringify([inst.name, skeleton?.data?.name, [...inst.skins], [...inst.hiddenSlots], animations.map((item) => item?.name ?? ''), order]);
  const cached = outlinerTreeCache.get(inst.id);
  if (cached?.sig === sig) return cached.tree;
  const tree = buildAssetTree(inst.id, inst.name, skeleton?.data, {
    skins: inst.skins,
    drawOrder: skeleton?.drawOrder,
    hiddenSlots: inst.hiddenSlots,
    keyed: keyedTargets(skeleton?.data, animations),
  });
  outlinerTreeCache.set(inst.id, { sig, tree });
  return tree;
}

/**
 * Assets Pulse and the outline colour act on: the selected one first, then every asset still showing a clicked slot,
 * since a highlight stays on until its slot is clicked off.
 */
function highlightTargets() {
  const inst = selected();
  const rest = scene.instances.filter((item) => item.selectedSlot && item !== inst);
  return inst ? [inst, ...rest] : rest;
}

/** The row the selection points at: slot first (it is what the stage highlights), then bone, then the asset. */
function outlinerSelectionKey() {
  const inst = selected();
  if (!inst) return null;
  if (inst.selectedSlot) return `${inst.id}|s:${inst.selectedSlot}`;
  if (inst.selectedBone) return `${inst.id}|b:${inst.selectedBone}`;
  return `${inst.id}|asset`;
}

/**
 * Open the selected asset the first time it is selected, and the branches above a slot or bone picked elsewhere
 * (the stage, arrow keys), then scroll it into view.
 * @param {import('../features/outlinerTree.js').OutlinerNode[]} trees
 */
function revealOutlinerSelection(trees) {
  const inst = selected();
  if (!inst) {
    outlinerAutoOpened = null;
    return;
  }
  if (outlinerAutoOpened !== inst.id) {
    outlinerAutoOpened = inst.id;
    outlinerScrollPending = true;
  }
  const key = outlinerSelectionKey();
  if (!key || outlinerRevealed.get(inst.id) === key) return;
  outlinerRevealed.set(inst.id, key);
  // Only a slot or bone picked elsewhere (the stage, arrow keys) opens its branch; selecting the asset opens nothing.
  if (key === `${inst.id}|asset`) return;
  const tree = trees.find((item) => item.key === `${inst.id}|asset`);
  const path = tree ? pathTo(tree, (node) => node.key === key) : null;
  for (const branch of path || []) setOutlinerOpen(branch, true);
  outlinerCursor = key;
  outlinerScrollPending = true;
}

let sceneListQueued = false;

/** Stage drags emit on every pointer move; the tree only needs redrawing once per frame. */
function scheduleSceneList() {
  if (sceneListQueued) return;
  sceneListQueued = true;
  requestAnimationFrame(() => {
    sceneListQueued = false;
    renderSceneList();
  });
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
  const inst = selected();
  const lead = highlightTargets()[0] || null;
  const pulse = document.getElementById('btn-pulse-toggle');
  const mask = document.getElementById('btn-mask-color');
  pulse?.classList.toggle('is-active', !!lead?.pulse);
  if (pulse) /** @type {HTMLButtonElement} */ (pulse).disabled = !lead;
  if (mask) {
    /** @type {HTMLButtonElement} */ (mask).disabled = !lead;
    if (lead) mask.dataset.mask = MASK_COLORS[lead.maskColorIndex].attr;
  }
  const slotName = lead?.selectedSlot || '';
  document.getElementById('slot-inspector')?.classList.toggle('is-hidden', !slotName);
  setText('si-name', slotName);

  seedOutlinerOpen();
  const ordered = [...scene.instances].sort((a, b) => a.zIndex - b.zIndex);
  const byId = new Map(ordered.map((item) => [item.id, item]));
  for (const item of ordered) hookEventLog(item);
  const trees = ordered.map(assetTree);
  for (const id of outlinerTreeCache.keys()) if (!byId.has(id)) outlinerTreeCache.delete(id);
  revealOutlinerSelection(trees);
  renderOutlinerTypes();
  outlinerRows = visibleRows(trees, isOutlinerOpen, panelFilters.outliner, outlinerKinds);
  outlinerPathCache = { key: null, keys: new Set(), index: -1 };
  outlinerAttachmentRows = [];
  const selectionKey = outlinerSelectionKey();
  // Rebuilding drops the focused row; remember it so the tree keys (← →) keep working after a click or arrow step.
  const active = document.activeElement;
  const focusedKey = active instanceof HTMLElement && list.contains(active)
    ? active.closest('li[data-key]')?.getAttribute('data-key') ?? null
    : null;
  list.replaceChildren();
  for (const row of outlinerRows) {
    const owner = byId.get(row.node.key.slice(0, row.node.key.indexOf('|')));
    if (!owner) continue;
    if (row.node.kind !== 'asset') {
      list.appendChild(outlinerRow(owner, row, row.node.key === selectionKey));
      continue;
    }
    list.appendChild(assetRow(owner, row));
    if (isOutlinerOpen(row.node) && !outlinerFiltering()) list.appendChild(assetSummary(owner, row.node));
  }
  if (outlinerRows.length && outlinerFiltering() && outlinerRows.every((row) => row.node.kind === 'asset')) {
    const empty = document.createElement('li');
    empty.className = 'panel-empty';
    empty.textContent = 'No matches';
    list.appendChild(empty);
  }
  if (outlinerScrollPending) {
    outlinerScrollPending = false;
    const key = outlinerCursor || selectionKey;
    if (key) list.querySelector(`li[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  if (focusedKey) {
    const target = (outlinerCursor && list.querySelector(`li[data-key="${CSS.escape(outlinerCursor)}"]`))
      || list.querySelector(`li[data-key="${CSS.escape(focusedKey)}"]`);
    /** @type {HTMLElement | null | undefined} */ (target?.querySelector('button.outliner-name, button.scene-name, input'))?.focus({ preventScroll: true });
  }
  renderBoneInspector(inst);
  renderAttachmentInspector();
  saveOutlinerOpen();
  pruneOutlinerState(byId);
}

/**
 * Drop branch state of assets that left the scene (saved branches stay in storage for the next drop).
 * @param {Map<string, unknown>} live
 */
function pruneOutlinerState(live) {
  for (const key of outlinerOpen.keys()) if (!live.has(key.slice(0, key.indexOf('|')))) outlinerOpen.delete(key);
  for (const id of outlinerSeeded) if (!live.has(id)) outlinerSeeded.delete(id);
  for (const id of outlinerRevealed.keys()) if (!live.has(id)) outlinerRevealed.delete(id);
}

/**
 * @param {HTMLElement} el
 * @param {import('../features/outlinerTree.js').OutlinerRow} row
 */
function outlinerTwisty(el, row) {
  const twisty = document.createElement('button');
  twisty.type = 'button';
  twisty.className = 'outliner-twisty';
  const hasChildren = row.node.children.length > 0;
  twisty.disabled = !hasChildren;
  if (hasChildren) {
    const filtering = outlinerFiltering();
    // While filtering, a branch is open exactly when its next row is one of its children.
    const next = outlinerRows[row.index + 1];
    const open = filtering ? !!next && next.path.includes(row.node.key) : isOutlinerOpen(row.node);
    twisty.classList.toggle('is-open', open);
    twisty.innerHTML = icon(open ? 'chevronDown' : 'chevronRight');
    twisty.setAttribute('aria-label', open ? `Collapse ${row.node.name}` : `Expand ${row.node.name}`);
    twisty.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleOutlinerBranch(row.node, event.altKey);
    });
  }
  el.appendChild(twisty);
}

/**
 * Open or shut a branch; with Alt, its whole subtree follows.
 * @param {import('../features/outlinerTree.js').OutlinerNode} node
 * @param {boolean} [deep]
 */
function toggleOutlinerBranch(node, deep = false) {
  const next = !isOutlinerOpen(node);
  /** @param {import('../features/outlinerTree.js').OutlinerNode} item */
  const set = (item) => {
    if (!item.children.length) return;
    setOutlinerOpen(item.key, next);
    if (deep) for (const child of item.children) set(child);
  };
  set(node);
  renderSceneList();
}

/**
 * Studio's line under an open skeleton: counts, plus open-all and close-all for the asset's branches.
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {import('../features/outlinerTree.js').OutlinerNode} tree
 */
function assetSummary(inst, tree) {
  const item = document.createElement('li');
  item.className = 'outliner-summary';
  const data = inst.spine?.skeleton?.data;
  const text = document.createElement('span');
  const bones = data?.bones?.length || 0;
  const slots = data?.slots?.length || 0;
  const hidden = inst.hiddenSlots.size;
  text.textContent = `${bones} ${bones === 1 ? 'bone' : 'bones'} · ${slots} ${slots === 1 ? 'slot' : 'slots'}${hidden ? ` · ${hidden} hidden` : ''}`;
  item.appendChild(text);
  if (hidden) {
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'outliner-cell is-on';
    show.innerHTML = icon('eyeOff');
    show.setAttribute('aria-label', `Show the ${hidden} hidden slots of ${inst.name}`);
    show.dataset.tip = `Show all ${hidden} hidden slots.`;
    show.addEventListener('click', () => withHistory(() => {
      setAllSlotsHidden(inst, false);
      emit();
    }));
    item.appendChild(show);
  }
  /** @param {boolean} open */
  const setAll = (open) => {
    /** @param {import('../features/outlinerTree.js').OutlinerNode} node */
    const walk = (node) => {
      if (!node.children.length) return;
      if (node !== tree) setOutlinerOpen(node.key, open);
      for (const child of node.children) walk(child);
    };
    walk(tree);
    renderSceneList();
  };
  for (const [glyph, label, open] of /** @type {const} */ ([['expandAll', 'Expand all', true], ['collapseAll', 'Collapse all', false]])) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outliner-cell';
    button.innerHTML = icon(glyph);
    button.setAttribute('aria-label', `${label} in ${inst.name}`);
    button.dataset.tip = `${label} (Alt-click an arrow does one branch).`;
    button.addEventListener('click', () => setAll(open));
    item.appendChild(button);
  }
  return item;
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {import('../features/outlinerTree.js').OutlinerRow} row
 */
function assetRow(inst, row) {
  const inSelection = isInstanceSelected(inst.id);
  const isPrimary = inst.id === scene.selectedId;
  const item = document.createElement('li');
  item.className = `outliner-asset${inSelection ? ' is-selected' : ''}${inst.visible ? '' : ' is-object-hidden'}`;
  item.draggable = true;
  item.dataset.id = inst.id;
  item.dataset.key = row.node.key;
  item.setAttribute('role', 'treeitem');
  item.setAttribute('aria-level', '1');
  item.setAttribute('aria-selected', String(inSelection));
  item.setAttribute('aria-expanded', String(isOutlinerOpen(row.node) || outlinerFiltering()));
  const main = document.createElement('div');
  main.className = 'scene-row-main';
  outlinerTwisty(main, row);

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
    outlinerCursor = row.node.key;
    const additive = event.metaKey || event.ctrlKey;
    // Clicking an asset opens it and shuts the others; the arrows open several side by side.
    if (!additive) {
      for (const other of scene.instances) setOutlinerOpen(`${other.id}|asset`, other.id === inst.id);
    }
    // Back to the asset itself: a plain click drops the slot and bone picked inside it.
    if (!additive && inst.id === scene.selectedId && (inst.selectedSlot || inst.selectedBone)) {
      setSelectedSlot(inst, null);
      inst.selectedBone = null;
      emit();
      return;
    }
    selectInstance(inst.id, { additive });
  });
  name.addEventListener('dblclick', () => rename(inst));
  name.addEventListener('contextmenu', (event) => openOutlinerMenu(event, inst, row.node));
  item.addEventListener('dragstart', (event) => {
    if (event.target instanceof Element && event.target.closest('.scene-actions, .outliner-cell')) {
      event.preventDefault();
      return;
    }
    item.classList.add('is-dragging');
    event.dataTransfer?.setData('text/plain', inst.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  item.addEventListener('dragend', () => item.classList.remove('is-dragging'));
  // Only row drags reorder; dropped files fall through to the window's import.
  const isRowDrag = (/** @type {DragEvent} */ event) => !!event.dataTransfer?.types.includes('text/plain') && !event.dataTransfer.types.includes('Files');
  item.addEventListener('dragover', (event) => {
    if (!isRowDrag(event)) return;
    event.preventDefault();
    item.classList.add('is-drop-target');
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });
  item.addEventListener('dragleave', () => item.classList.remove('is-drop-target'));
  item.addEventListener('drop', (event) => {
    item.classList.remove('is-drop-target');
    if (!isRowDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const fromId = event.dataTransfer?.getData('text/plain');
    if (fromId) withHistory(() => reorderInstances(fromId, inst.id));
  });
  const glyph = document.createElement('span');
  glyph.className = 'outliner-glyph element-skeleton';
  glyph.innerHTML = icon('skeleton');
  main.append(
    glyph,
    name,
    healthChip,
    outlinerCell('eye', !inst.visible, inst.visible ? `Hide ${inst.name} on the stage. ${shortcutLabel('H')}` : `Show ${inst.name} on the stage. ${shortcutLabel('H')}`, () => withHistory(() => toggleVisible(inst))),
    outlinerCell('lock', inst.locked, inst.locked ? `Unlock ${inst.name}. ${shortcutLabel('L', true)}` : `Lock ${inst.name} so the stage cannot move it. ${shortcutLabel('L', true)}`, () => withHistory(() => toggleLocked(inst))),
    assetAction('copy', `Copy ${isPrimary && inSelection && selectionCount() > 1 ? 'the selected assets' : inst.name}. ${shortcutLabel('C')}`, () => {
      if (!isInstanceSelected(inst.id)) selectInstance(inst.id);
      duplicateSceneSelection();
    }),
    assetAction('trash', `Delete ${isPrimary && inSelection && selectionCount() > 1 ? 'the selected assets' : inst.name}. Delete`, () => {
      if (!isInstanceSelected(inst.id)) selectInstance(inst.id);
      deleteSceneSelection();
    }),
  );
  item.append(main);
  return item;
}

/**
 * A row under an asset: group, bone, slot, attachment, skin, constraint, event or draw-order slot.
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {import('../features/outlinerTree.js').OutlinerRow} row
 * @param {boolean} isSelected
 */
function outlinerRow(inst, row, isSelected) {
  const { node } = row;
  const item = document.createElement('li');
  const slotHidden = !!node.slot && (node.kind === 'slot' || node.kind === 'order') && inst.hiddenSlots.has(node.slot);
  const inSlot = node.kind === 'attachment' && node.slot === inst.selectedSlot && inst.id === scene.selectedId;
  item.className = [
    'outliner-row',
    `is-${node.kind}`,
    isSelected || (node.kind === 'order' && inst.id === scene.selectedId && node.slot === inst.selectedSlot) ? 'is-selected' : '',
    inSlot ? 'is-in-selection' : '',
    slotHidden ? 'is-object-hidden' : '',
    node.key === outlinerCursor ? 'is-cursor' : '',
  ].filter(Boolean).join(' ');
  item.dataset.key = node.key;
  item.setAttribute('role', 'treeitem');
  item.setAttribute('aria-level', String(row.depth + 1));
  item.setAttribute('aria-selected', String(item.classList.contains('is-selected')));
  if (node.children.length) item.setAttribute('aria-expanded', String(outlinerRows[row.index + 1]?.path.includes(node.key) ?? false));
  item.dataset.depth = String(Math.min(row.depth, 4));
  const rowIndex = row.index;
  item.dataset.stripe = String(rowIndex % 2);
  item.style.setProperty('--depth', String(row.depth));
  // Parent guides: a stem per ancestor below the asset, blue along the selection's path.
  const selectedPath = outlinerSelectedPath(inst);
  for (let level = 1; level < row.depth; level++) {
    const guide = document.createElement('span');
    // Blue from the ancestor down to the selected row, not past it.
    const active = selectedPath.has(row.path[level]) && rowIndex <= outlinerPathCache.index;
    guide.className = `outliner-guide${active ? ' is-active' : ''}`;
    guide.style.left = `${level * 12 - 1}px`;
    guide.setAttribute('aria-hidden', 'true');
    item.appendChild(guide);
  }
  outlinerTwisty(item, row);
  const glyphName = nodeIcon(node);
  const glyph = document.createElement('span');
  glyph.className = `outliner-glyph element-${glyphName}`;
  glyph.innerHTML = icon(glyphName);
  item.appendChild(glyph);

  if (node.kind === 'skin') {
    const label = document.createElement('label');
    label.className = 'skin-item outliner-name';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = node.name;
    box.checked = inst.skins.has(node.name);
    box.addEventListener('change', () => {
      withHistory(() => {
        inst.previousSkins = new Set(inst.skins);
        if (box.checked) inst.skins.add(node.name);
        else inst.skins.delete(node.name);
        applySkins(inst);
        inst.spine.update(0);
        emit();
      });
    });
    const span = document.createElement('span');
    span.textContent = node.name;
    label.append(box, span);
    label.addEventListener('contextmenu', (event) => openOutlinerMenu(event, inst, node));
    item.appendChild(label);
    return item;
  }

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'outliner-name';
  name.textContent = node.name;
  name.addEventListener('click', () => activateOutlinerRow(inst, node, { toggle: true }));
  name.addEventListener('contextmenu', (event) => openOutlinerMenu(event, inst, node));
  item.appendChild(name);
  if (node.kind === 'bone' || node.kind === 'slot') {
    const boneName = node.kind === 'bone' ? node.bone : slotBoneName(inst, /** @type {string} */ (node.slot));
    item.addEventListener('pointerenter', () => { inst.hoverBone = boneName || null; });
    item.addEventListener('pointerleave', () => { if (inst.hoverBone === boneName) inst.hoverBone = null; });
  }
  if (node.keyed) {
    const keyed = document.createElement('span');
    keyed.className = 'outliner-keyed';
    keyed.dataset.tip = 'Keyed in the playing animation.';
    keyed.setAttribute('aria-label', 'keyed');
    item.appendChild(keyed);
  }
  if (node.kind === 'attachment' && outlinerAttachment?.key === node.key) item.classList.add('is-selected');
  if (node.meta) {
    const meta = document.createElement('span');
    meta.className = 'outliner-meta';
    meta.textContent = node.meta;
    item.appendChild(meta);
  }
  if (node.kind === 'slot' || node.kind === 'order') {
    const slotName = /** @type {string} */ (node.slot);
    item.appendChild(outlinerCell('eye', slotHidden, slotHidden
      ? 'Show this slot on the stage (H). Alt-click shows only this slot.'
      : 'Hide this slot on the stage (H). Alt-click shows only this slot.', (event) => {
      if (event.altKey) soloSlots(inst, [slotName]);
      else withHistory(() => {
        toggleSlotHidden(inst, slotName);
        emit();
      });
    }));
  }
  if (node.kind === 'bone') {
    const branch = slotsUnder(node);
    if (branch.length) {
      const allHidden = branch.every((name) => inst.hiddenSlots.has(name));
      item.appendChild(outlinerCell('eye', allHidden, allHidden
        ? `Show the ${branch.length} slots of this branch. Alt-click shows only this branch.`
        : `Hide the ${branch.length} slots of this branch. Alt-click shows only this branch.`, (event) => {
        if (event.altKey) soloSlots(inst, branch);
        else setSlotsHidden(inst, branch, !allHidden);
      }));
    }
  }
  if (node.kind === 'event') {
    const log = inst.eventLog?.get(node.name);
    if (log) {
      const fired = document.createElement('span');
      fired.className = 'outliner-meta outliner-event-log';
      fired.textContent = `×${log.count} · ${log.time.toFixed(2)}s`;
      fired.dataset.tip = `Fired ${log.count} times since the last Setup pose; last at ${log.time.toFixed(2)}s into ${log.animation}.`;
      item.appendChild(fired);
    }
  }
  if (node.kind === 'attachment') {
    const slotIndex = inst.spine.skeleton.data.slotIndex?.get(node.slot);
    const skin = inst.spine.skeleton.data.skins.find((entry) => entry.name === node.skin);
    const attachment = slotIndex === undefined ? null : skin?.attachments.get(slotIndex)?.get(node.name);
    if (attachment) outlinerAttachmentRows.push({ el: item, inst, slot: /** @type {string} */ (node.slot), attachment });
  }
  return item;
}

/**
 * Select what a row stands for: a bone opens the inspector, a slot (or its attachment, or its draw-order row)
 * highlights on the stage, a group opens or shuts.
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {import('../features/outlinerTree.js').OutlinerNode} node
 * @param {{ toggle?: boolean }} [options]
 */
function activateOutlinerRow(inst, node, { toggle = false } = {}) {
  focusedPanel = 'scene-panel';
  outlinerCursor = node.key;
  outlinerAttachment = node.kind === 'attachment'
    ? { key: node.key, instId: inst.id, slot: /** @type {string} */ (node.slot), skin: /** @type {string} */ (node.skin), name: node.name }
    : null;
  if (node.kind === 'group') {
    if (toggle) toggleOutlinerBranch(node);
    else renderSceneList();
    return;
  }
  // A clicked bone or slot opens to show what is inside; its arrow shuts it again.
  if (toggle && node.children.length) setOutlinerOpen(node.key, true);
  if (node.kind !== 'bone' && !node.slot) {
    renderSceneList();
    return;
  }
  if (scene.selectedId !== inst.id || scene.selectedIds.size !== 1) {
    scene.selectedId = inst.id;
    scene.selectedIds = new Set([inst.id]);
  }
  if (node.kind === 'bone') {
    const next = toggle && inst.selectedBone === node.bone && !inst.selectedSlot ? null : /** @type {string} */ (node.bone);
    inst.selectedBone = next;
    if (inst.selectedSlot) setSelectedSlot(inst, null);
  } else {
    const slotName = /** @type {string} */ (node.slot);
    const next = toggle && node.kind === 'slot' && inst.selectedSlot === slotName ? null : slotName;
    setSelectedSlot(inst, next);
    // The slot's bone feeds the inspector, so its world transform shows next to the highlight.
    inst.selectedBone = next ? slotBoneName(inst, next) : null;
  }
  // Clicked rows are already in view; only stage picks and arrow keys need revealing.
  outlinerRevealed.set(inst.id, outlinerSelectionKey() || '');
  emit();
}

/** Keys from the asset down to the selected row, and that row's index, for the blue guides. @type {{ key: string | null, keys: Set<string>, index: number }} */
let outlinerPathCache = { key: null, keys: new Set(), index: -1 };

/** @param {import('../app/sceneStore.js').SpineInstance} inst */
function outlinerSelectedPath(inst) {
  const key = inst.id === scene.selectedId ? outlinerSelectionKey() : null;
  if (!key) return new Set();
  if (outlinerPathCache.key !== key) {
    const index = outlinerRows.findIndex((item) => item.node.key === key);
    const row = outlinerRows[index];
    outlinerPathCache = { key, keys: new Set(row ? [...row.path, key] : []), index };
  }
  return outlinerPathCache.keys;
}

/** Slot names in a branch of the tree. @param {import('../features/outlinerTree.js').OutlinerNode} node @returns {string[]} */
function slotsUnder(node) {
  /** @type {string[]} */
  const names = [];
  /** @param {import('../features/outlinerTree.js').OutlinerNode} item */
  const walk = (item) => {
    if (item.kind === 'slot' && item.slot) names.push(item.slot);
    for (const child of item.children) walk(child);
  };
  walk(node);
  return names;
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {string[]} names
 * @param {boolean} hidden
 */
function setSlotsHidden(inst, names, hidden) {
  withHistory(() => {
    for (const name of names) {
      if (hidden) inst.hiddenSlots.add(name);
      else inst.hiddenSlots.delete(name);
    }
    applySlotVisibility(inst);
    emit();
  });
}

/**
 * Show only these slots; when they already are the only ones shown, show everything again.
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {string[]} names
 */
function soloSlots(inst, names) {
  const keep = new Set(names);
  const all = inst.spine?.skeleton?.data?.slots?.map((slot) => slot.name) || [];
  const soloed = all.every((name) => keep.has(name) ? !inst.hiddenSlots.has(name) : inst.hiddenSlots.has(name));
  withHistory(() => {
    inst.hiddenSlots = soloed ? new Set() : new Set(all.filter((name) => !keep.has(name)));
    applySlotVisibility(inst);
    emit();
  });
}

/** @param {import('../app/sceneStore.js').SpineInstance} inst @param {string} slotName */
function slotBoneName(inst, slotName) {
  return inst.spine.skeleton.findSlot(slotName)?.bone?.data?.name || null;
}

/**
 * A fixed cell at the row's right edge (eye or lock), like Studio's metadata columns.
 * @param {'eye' | 'lock'} kind
 * @param {boolean} on hidden / locked
 * @param {string} tip
 * @param {(event: MouseEvent) => void} run
 */
function outlinerCell(kind, on, tip, run) {
  // run receives the click, so Alt can solo.
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `outliner-cell outliner-${kind}${on ? ' is-on' : ''}`;
  button.innerHTML = kind === 'eye' ? icon(on ? 'eyeOff' : 'eye') : icon(on ? 'lock' : 'unlock');
  button.setAttribute('aria-label', tip);
  button.setAttribute('aria-pressed', String(on));
  button.dataset.tip = tip;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    run(event);
  });
  return button;
}

/** Attachment row clicked last, for its details panel. @type {{ key: string, instId: string, slot: string, skin: string, name: string } | null} */
let outlinerAttachment = null;

/** Type, size and source of the clicked attachment, under the tree. */
function renderAttachmentInspector() {
  const panel = document.getElementById('attachment-inspector');
  if (!panel) return;
  const pick = outlinerAttachment;
  const inst = pick ? scene.instances.find((item) => item.id === pick.instId) : null;
  const data = inst?.spine?.skeleton?.data;
  const slotIndex = pick ? data?.slotIndex?.get(pick.slot) : undefined;
  const attachment = pick && slotIndex !== undefined
    ? data.skins.find((skin) => skin.name === pick.skin)?.attachments.get(slotIndex)?.get(pick.name)
    : null;
  panel.classList.toggle('is-hidden', !attachment);
  if (!attachment || !pick) return;
  setText('ai-name', pick.name);
  /** @type {[string, string][]} */
  const rows = [['Type', attachment.type], ['Slot', pick.slot], ['Skin', pick.skin]];
  if (attachment.path && attachment.path !== pick.name) rows.push(['Region', attachment.path]);
  if (attachment.width) rows.push(['Size', `${Math.round(attachment.width)} × ${Math.round(attachment.height)}`]);
  if (attachment.type === 'region') {
    rows.push(['Offset', `${attachment.x.toFixed(1)}, ${attachment.y.toFixed(1)}`]);
    if (attachment.rotation) rows.push(['Rotation', `${attachment.rotation.toFixed(1)}°`]);
  }
  if (attachment.worldVerticesLength) rows.push(['Vertices', String(attachment.worldVerticesLength / 2)]);
  if (attachment.triangles) rows.push(['Triangles', String(attachment.triangles.length / 3)]);
  if (attachment.vertices && attachment.bones !== undefined) rows.push(['Weighted', attachment.bones ? 'yes' : 'no']);
  if (attachment.sequence) rows.push(['Sequence', `${attachment.sequence.count ?? '?'} frames`]);
  drawAttachmentThumb(inst, attachment);
  const grid = document.getElementById('ai-grid');
  if (!grid) return;
  grid.replaceChildren();
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const desc = document.createElement('dd');
    desc.textContent = value;
    desc.title = value;
    grid.append(term, desc);
  }
}

/** @param {import('../app/sceneStore.js').SpineInstance | null} inst */
function renderBoneInspector(inst) {
  const inspector = document.getElementById('bone-inspector');
  if (!inspector) return;
  const boneName = inst?.selectedBone || null;
  inspector.classList.toggle('is-hidden', !boneName);
  setText('bi-name', boneName || '');
}

/** Mark the attachment each listed slot is showing right now (animations swap them). */
function refreshOutlinerAttachments() {
  for (const row of outlinerAttachmentRows) {
    const slot = row.inst.spine?.skeleton?.findSlot(row.slot);
    row.el.classList.toggle('is-current', !!slot && slot.attachment === row.attachment);
  }
}

/** @type {WeakSet<object>} */
const eventLogHooked = new WeakSet();

/**
 * Count fired events per asset for the Events branch (×count · last time); Setup pose clears it.
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 */
function hookEventLog(inst) {
  const state = inst.spine?.state;
  if (!state || eventLogHooked.has(state)) return;
  eventLogHooked.add(state);
  state.addListener({
    event: (entry, event) => {
      if (scene.scrubbing) return;
      inst.eventLog ??= new Map();
      const name = event?.data?.name ?? event?.name;
      if (!name) return;
      const log = inst.eventLog.get(name) || { count: 0, time: 0, animation: '' };
      log.count += 1;
      log.time = Number(event.time ?? poseTime(entry)) || 0;
      log.animation = entry?.animation?.name || '';
      inst.eventLog.set(name, log);
      if (outlinerOpen.get(`${inst.id}|g:events`)) scheduleSceneList();
    },
  });
}

const THUMB_SIZE = 64;

/**
 * Draw the attachment's atlas region into the panel thumbnail; compressed pages (KTX2) cannot be read back.
 * @param {import('../app/sceneStore.js').SpineInstance | null | undefined} inst
 * @param {any} attachment
 */
function drawAttachmentThumb(inst, attachment) {
  const canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('ai-thumb'));
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = THUMB_SIZE * ratio;
  canvas.height = THUMB_SIZE * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
  const regions = inst?.atlas?.data?.regions;
  const path = attachment?.path || attachment?.name;
  const region = regions?.get?.(path) || regions?.get?.(`${path}${attachment?.sequence ? '_0' : ''}`);
  const source = region ? inst?.atlas?.textures?.get?.(region.page.name)?.resource?.source : null;
  const drawable = source && (source instanceof HTMLImageElement || source instanceof HTMLCanvasElement
    || (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap));
  canvas.classList.toggle('is-empty', !drawable);
  canvas.title = drawable ? `${region.name} (${region.width} × ${region.height})` : 'No preview (missing region or compressed page)';
  if (!drawable) return;
  // A region packed at 90° sits sideways in the page: its page footprint swaps width and height.
  const sideways = region.degrees === 90 || region.degrees === 270;
  const pageW = sideways ? region.height : region.width;
  const pageH = sideways ? region.width : region.height;
  const scale = Math.min((THUMB_SIZE - 4) / region.width, (THUMB_SIZE - 4) / region.height, 4);
  ctx.save();
  ctx.translate(THUMB_SIZE / 2, THUMB_SIZE / 2);
  if (sideways) ctx.rotate(region.degrees === 90 ? -Math.PI / 2 : Math.PI / 2);
  ctx.drawImage(source, region.x, region.y, pageW, pageH, (-pageW * scale) / 2, (-pageH * scale) / 2, pageW * scale, pageH * scale);
  ctx.restore();
}

/**
 * Flip the asset between its current skins and the ones before the last change (S), to spot what a skin adds.
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 */
function flipSkins(inst) {
  if (!inst.previousSkins) return false;
  const before = inst.previousSkins;
  inst.previousSkins = new Set(inst.skins);
  inst.skins = new Set(before);
  applySkins(inst);
  inst.spine.update(0);
  emit();
  return true;
}

/** @type {HTMLElement | null} */
let outlinerMenu = null;

function closeOutlinerMenu() {
  outlinerMenu?.remove();
  outlinerMenu = null;
}

/**
 * Right-click menu on outliner rows: copy, hide, solo, and jumps between a slot, its bone and its draw-order row.
 * @param {MouseEvent} event
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {import('../features/outlinerTree.js').OutlinerNode} node
 */
function openOutlinerMenu(event, inst, node) {
  event.preventDefault();
  closeOutlinerMenu();
  /** @type {([string, () => void] | null)[]} */
  const items = [[`Copy “${node.kind === 'asset' ? inst.name : node.name}”`, () => { void navigator.clipboard?.writeText(node.kind === 'asset' ? inst.name : node.name); }]];
  /** @param {string} key */
  const reveal = (key) => {
    const tree = outlinerTreeCache.get(inst.id)?.tree;
    const path = tree ? pathTo(tree, (item) => item.key === key) : null;
    for (const branch of path || []) setOutlinerOpen(branch, true);
    outlinerCursor = key;
    outlinerScrollPending = true;
    renderSceneList();
  };
  if (node.kind === 'asset') {
    items.push(
      ['Rename…', () => rename(inst)],
      null,
      [inst.visible ? 'Hide' : 'Show', () => withHistory(() => toggleVisible(inst))],
      [inst.locked ? 'Unlock' : 'Lock', () => withHistory(() => toggleLocked(inst))],
      ['Show all slots', () => setSlotsHidden(inst, [...inst.hiddenSlots], false)],
      null,
      ['Copy asset', () => { selectInstance(inst.id); duplicateSceneSelection(); }],
      ['Delete', () => { selectInstance(inst.id); deleteSceneSelection(); }],
    );
  }
  const slot = node.kind === 'slot' || node.kind === 'order' || node.kind === 'attachment' ? node.slot : null;
  if (slot) {
    const hidden = inst.hiddenSlots.has(slot);
    items.push(
      null,
      [hidden ? 'Show slot' : 'Hide slot', () => setSlotsHidden(inst, [slot], !hidden)],
      ['Show only this slot', () => soloSlots(inst, [slot])],
      null,
      ['Go to slot', () => { activateOutlinerRow(inst, { key: `${inst.id}|s:${slot}`, kind: 'slot', name: slot, slot, children: [] }); reveal(`${inst.id}|s:${slot}`); }],
      ['Go to its bone', () => {
        const bone = slotBoneName(inst, slot);
        if (bone) reveal(`${inst.id}|b:${bone}`);
      }],
      ['Show in draw order', () => reveal(`${inst.id}|o:${slot}`)],
    );
  }
  if (node.kind === 'bone') {
    const branch = slotsUnder(node);
    if (branch.length) {
      items.push(
        null,
        ['Hide branch', () => setSlotsHidden(inst, branch, true)],
        ['Show branch', () => setSlotsHidden(inst, branch, false)],
        ['Show only this branch', () => soloSlots(inst, branch)],
      );
    }
  }
  if (node.children.length) {
    items.push(null, ['Expand all below', () => {
      setOutlinerOpen(node.key, false);
      toggleOutlinerBranch(node, true);
    }]);
  }
  const menu = document.createElement('div');
  menu.className = 'outliner-menu';
  menu.setAttribute('role', 'menu');
  for (const entry of items) {
    if (!entry) {
      if (menu.lastElementChild && !menu.lastElementChild.classList.contains('outliner-menu-sep')) {
        const sep = document.createElement('div');
        sep.className = 'outliner-menu-sep';
        menu.appendChild(sep);
      }
      continue;
    }
    const [label, run] = entry;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.addEventListener('click', () => {
      closeOutlinerMenu();
      run();
    });
    menu.appendChild(button);
  }
  if (menu.lastElementChild?.classList.contains('outliner-menu-sep')) menu.lastElementChild.remove();
  document.body.appendChild(menu);
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 4)}px`;
  outlinerMenu = menu;
  /** @type {HTMLButtonElement | null} */ (menu.querySelector('button'))?.focus();
  menu.addEventListener('keydown', (key) => {
    if (key.key === 'Escape') {
      key.stopPropagation();
      closeOutlinerMenu();
    } else if (key.key === 'ArrowDown' || key.key === 'ArrowUp') {
      key.preventDefault();
      key.stopPropagation();
      const buttons = [...menu.querySelectorAll('button')];
      const at = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
      buttons[(at + (key.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  });
}

window.addEventListener('pointerdown', (event) => {
  if (outlinerMenu && !(event.target instanceof Node && outlinerMenu.contains(event.target))) closeOutlinerMenu();
}, true);
window.addEventListener('blur', closeOutlinerMenu);

const macShortcuts = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * @param {string} key
 * @param {boolean} [shift]
 */
function shortcutLabel(key, shift = false) {
  if (macShortcuts) return `⌘${shift ? '⇧' : ''}${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
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

/**
 * Copy / Delete on the asset row, in the same line as eye and lock; shown on hover and on the selected asset.
 * @param {'copy' | 'trash'} glyph
 * @param {string} tip
 * @param {() => void} run
 */
function assetAction(glyph, tip, run) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `outliner-cell outliner-action outliner-${glyph}`;
  button.innerHTML = icon(glyph);
  button.setAttribute('aria-label', tip);
  button.dataset.tip = tip;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    run();
  });
  return button;
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

/**
 * Animations Play starts on an asset, by track: the ones picked in the animations drawer, else the ones it had
 * before Setup pose, else its last animation, else its first.
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @returns {Record<number, string>}
 */
function transportPlan(inst) {
  if (Object.keys(inst.tracks).length) return { ...inst.tracks };
  if (inst.savedTracks && Object.keys(inst.savedTracks).length) return { ...inst.savedTracks };
  const first = inst.spine?.skeleton?.data?.animations?.[0]?.name;
  const name = inst.lastAnimationName || first;
  return name ? { 0: name } : {};
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
    'btn-setup',
    'Stop every skeleton and show its setup pose. Play in Animations starts it again.',
    'Stop the selected skeleton and show its setup pose.',
    'Stop {n} selected skeletons and show their setup pose.',
  );
  apply(
    'btn-transform-reset-all',
    'Revert every skeleton to how it was when opened: position, scale, skins, tracks.',
    'Revert the selected skeleton to how it was when opened: position, scale, skins, tracks.',
    'Revert {n} selected skeletons to how they were when opened.',
  );
  const empty = document.getElementById('transform-empty');
  if (empty) empty.hidden = !!scene.instances.length;
  document.getElementById('transform-all-panel')?.classList.toggle('is-empty', !scene.instances.length);
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

function resetAssetsToBaseline() {
  const targets = transformTargets();
  if (!targets.length) return;
  withHistory(() => resetInstancesToBaseline(targets));
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
    } else if (!Object.keys(inst.tracks).length) {
      // Setup pose cleared the tracks: start what Play would.
      for (const [track, name] of Object.entries(transportPlan(inst))) setTrack(inst, Number(track), name);
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
  // After Setup pose there is no animation on the track, but ▶ can still start what Play would.
  const playButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('tl-play'));
  if (playButton && !ready && inst && !Object.keys(inst.tracks).length) playButton.disabled = !Object.keys(transportPlan(inst)).length;
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
  document.querySelectorAll('[data-anim-scope]').forEach((button) => {
    button.addEventListener('click', () => {
      ui.animApplyGlobal = /** @type {HTMLElement} */ (button).dataset.animScope === 'all';
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
  });
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
  document.querySelectorAll('[data-anim-scope]').forEach((button) => {
    const on = (/** @type {HTMLElement} */ (button).dataset.animScope === 'all') === !!ui.animApplyGlobal;
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-pressed', String(on));
  });
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

/** Draw order last drawn per open Draw order branch. @type {Map<string, string>} */
const drawOrderSeen = new Map();

/** Redraw the tree when an open Draw order branch changed order (draw-order keys during playback). */
function refreshOutlinerDrawOrder() {
  let changed = false;
  for (const inst of scene.instances) {
    const key = `${inst.id}|g:order`;
    if (!outlinerOpen.get(key)) continue;
    const order = (inst.spine?.skeleton?.drawOrder || []).map((slot) => slot.data.name).join('\n');
    if (drawOrderSeen.get(key) !== order) {
      drawOrderSeen.set(key, order);
      changed = true;
    }
  }
  if (changed) renderSceneList();
}

function refreshLive() {
  const inst = selected();
  refreshTime();
  const timeline = document.getElementById('anim-timeline');
  if (timeline && selectionCount() <= 1) refreshTimeline(timeline, inst);
  syncAnimControls(inst);
  refreshBone(inst);
  refreshOutlinerAttachments();
  refreshOutlinerDrawOrder();
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
/** Heavier perf numbers (exact draw counts, atlas, per-skeleton list) refresh at this interval, not every frame. */
const PERF_DETAIL_MS = 250;
/** Per-frame samples over the last {@link FPS_WINDOW_MS}: frame interval and the renderer's counts. */
/** @type {{ t: number, fps: number, ms: number, dc: number, verts: number, tris: number, stutter?: boolean }[]} */
const fpsSamples = [];
/** @type {{ key: string, primary: string, secondary: string, pages: string } | null} */
let atlasHudCache = null;
let perfDetailAt = 0;
let perfUnitsBound = false;

/** Common display refresh rates; the measured one snaps to the nearest. */
const REFRESH_RATES = [30, 60, 75, 90, 100, 120, 144, 165, 240];

/**
 * Display refresh rate estimated from the fastest frames (browsers expose no API for it):
 * the 10th-percentile frame interval, snapped to a common rate.
 */
function displayRefreshHz() {
  if (fpsSamples.length < 30) return 60;
  // Sorting the whole window is too much for every frame; the rate barely moves, so re-estimate at most once a second.
  const now = performance.now();
  if (now - refreshHzAt < 1000) return refreshHz;
  refreshHzAt = now;
  const sorted = fpsSamples.map((s) => s.ms).filter((ms) => ms > 0).sort((a, b) => a - b);
  const fast = sorted[Math.floor(sorted.length * 0.1)] || 16.7;
  const hz = 1000 / fast;
  refreshHz = REFRESH_RATES.reduce((best, r) => (Math.abs(r - hz) < Math.abs(best - hz) ? r : best), 60);
  return refreshHz;
}
let refreshHz = 60;
let refreshHzAt = -Infinity;

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

/** @param {ReturnType<typeof readFrameStats>} frame */
function recordFrame(frame) {
  const now = performance.now();
  const ms = frame.deltaMs;
  const r = frame.renderer;
  const stutter = trackStutter(frame, displayRefreshHz(), playingContext());
  fpsSamples.push({ t: now, fps: ms > 0 ? 1000 / ms : 0, ms, dc: r?.drawCalls ?? 0, verts: r?.vertices ?? 0, tris: r?.triangles ?? 0, stutter: !!stutter });
  const heap = readJsHeap();
  recordPerfFrame({
    frameMs: ms,
    updateMs: frame.updateMs,
    renderMs: frame.renderMs,
    drawCalls: r?.drawCalls ?? 0,
    vertices: r?.vertices ?? 0,
    triangles: r?.triangles ?? 0,
    stutter: stutter ? stutter.cause : '',
    heapMb: heap ? heap.used / (1024 * 1024) : null,
    playing: playingContext(),
  }, describePerfScene);
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
  // Reference lines: 30 and 60 FPS, and the display's own rate when higher.
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  strokeHz(30);
  strokeHz(60);
  const hz = displayRefreshHz();
  if (hz > 60) {
    ctx.strokeStyle = '#3d4a1a';
    strokeHz(hz);
  }
  if (!fpsSamples.length) return;
  ctx.strokeStyle = '#d2ff00';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  fpsSamples.forEach((sample, index) => {
    const x = ((sample.t - (now - FPS_WINDOW_MS)) / FPS_WINDOW_MS) * (width - 1);
    const y = 1 + (height - 2) * (1 - Math.min(ceiling, Math.max(0, sample.fps)) / ceiling);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // Stutter markers: a red tick at the top for each frame over twice the display's frame time.
  ctx.fillStyle = '#d96c5f';
  for (const sample of fpsSamples) {
    if (!sample.stutter) continue;
    const x = ((sample.t - (now - FPS_WINDOW_MS)) / FPS_WINDOW_MS) * (width - 1);
    ctx.fillRect(Math.round(x) - 1, 0, 2, 6);
  }
}

/** What is playing, for stutter context and recordings: the selected skeleton's animation, else the first playing one. */
function playingContext() {
  const inst = selected() ?? scene.instances.find((item) => item.playing);
  if (!inst) return '';
  const entry = currentTrackEntry(inst.spine?.state, 0);
  const anim = entry?.animation?.name;
  return anim ? `${inst.name} · ${anim}` : inst.name;
}

/** Scene description stored with a recording. */
function describePerfScene() {
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    displayHz: displayRefreshHz(),
    textureUnits: { counted: getTextureUnits(), gpu: getGpuTextureUnits() },
    skeletons: scene.instances.map((inst) => {
      const m = measureInstance(inst);
      return {
        name: inst.name,
        visible: inst.visible !== false,
        drawCalls: m.drawCalls,
        vertices: m.vertexCount,
        triangles: m.triangles,
        atlasBytes: m.memoryBytes,
        updateMs: getUpdateMsForInstance(inst),
        load: getLoadStatsForInstance(inst),
      };
    }),
  };
}

/** @param {number} n */
function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US');
}

/** @param {number} ms */
function fmtMs(ms) {
  return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
}

/** @param {Record<string, number> | null | undefined} breaks */
function breaksText(breaks) {
  if (!breaks) return '';
  const parts = [];
  if (breaks.textures) parts.push(`${breaks.textures} for textures (more pages than units)`);
  if (breaks.blend) parts.push(`${breaks.blend} for blend mode (Multiply / Screen)`);
  if (breaks.vertices) parts.push(`${breaks.vertices} for the 65,535-vertex limit`);
  return parts.length ? `Extra draw calls: ${parts.join(', ')}.` : '';
}

/** @param {string} blends "Normal: 3, Multiply: 1" */
function blendsNote(blends) {
  const names = blends.split(', ').map((p) => p.split(':')[0]);
  const own = names.filter((n) => n === 'Multiply' || n === 'Screen');
  return own.length ? `${own.join(' and ')} need their own draw call state; Normal and Additive share one.` : '';
}

/** @param {string} text */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let pageMemoryBusy = false;

function refreshMemory() {
  const heap = readJsHeap();
  const heapRow = document.getElementById('perf-heap-row');
  if (heapRow) heapRow.hidden = !heap;
  if (heap) setText('perf-heap', `${formatMb(heap.used)} MB used · ${formatMb(heap.allocated)} MB allocated`);
  const button = document.getElementById('perf-measure-mem');
  const can = canMeasurePageMemory();
  if (button) button.hidden = !can;
  if (!pageMemoryBusy) {
    const reason = pageMemoryUnavailableReason();
    setText('perf-mem-note', [heap ? '' : 'JS heap needs Chrome or Edge.', reason, 'GPU memory is not visible to web pages; Chrome’s Task Manager (Shift+Esc) shows it.'].filter(Boolean).join(' '));
  }
}

async function onMeasurePageMemory() {
  if (pageMemoryBusy) return;
  pageMemoryBusy = true;
  const button = /** @type {HTMLButtonElement | null} */ (document.getElementById('perf-measure-mem'));
  if (button) button.disabled = true;
  setText('perf-mem-note', 'Measuring… Chrome waits for its next garbage collection, which can take several seconds.');
  try {
    const { total, byType } = await measurePageMemory();
    const row = document.getElementById('perf-page-mem-row');
    if (row) row.hidden = false;
    setText('perf-page-mem', `${formatMb(total)} MB`);
    const parts = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([type, bytes]) => `${type} ${formatMb(bytes)} MB`);
    setText('perf-page-mem-detail', `${parts.join(' · ')} · measured ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setText('perf-page-mem-detail', `Measurement failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pageMemoryBusy = false;
    if (button) button.disabled = false;
    refreshMemory();
  }
}

function bindPerfUnits() {
  if (perfUnitsBound) return;
  // Set first: everything below adds listeners, which must happen once even if the units select is missing.
  perfUnitsBound = true;
  document.getElementById('perf-measure-mem')?.addEventListener('click', () => { void onMeasurePageMemory(); });
  bindBudget(ui, () => saveUiState(ui), () => { perfDetailAt = 0; });
  bindRecorder(describePerfScene);
  document.getElementById('perf-breakdown')?.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest('.perf-bd-row[data-id]') : null;
    const id = row?.getAttribute('data-id');
    if (id) selectInstance(id);
  });
  const select = document.getElementById('perf-units');
  if (!(select instanceof HTMLSelectElement)) return;
  const gpu = getGpuTextureUnits();
  const options = [gpu, 4, 2, 1].filter((n, i, all) => n <= gpu && all.indexOf(n) === i);
  select.innerHTML = options.map((n) => `<option value="${n}">${n}${n === gpu ? ' (this GPU)' : ''}</option>`).join('');
  select.value = String(getTextureUnits());
  select.addEventListener('change', () => {
    setTextureUnits(Number(select.value));
    perfDetailAt = 0;
    atlasHudCache = null;
  });
}

function refreshPerf() {
  const frame = readFrameStats();
  recordFrame(frame);
  setText('perf-fps', String(Math.round(readFps())));
  syncPerfScope();
  bindPerfUnits();

  const now = performance.now();
  if (now - perfDetailAt < PERF_DETAIL_MS) return;
  perfDetailAt = now;

  // Frame: averages and worst over the window.
  if (fpsSamples.length) {
    const intervals = fpsSamples.map((s) => s.ms).filter((ms) => ms > 0);
    const avg = intervals.reduce((a, b) => a + b, 0) / (intervals.length || 1);
    const worst = Math.max(0, ...intervals);
    const slow = [...intervals].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(intervals.length / 100)));
    const lowFps = 1000 / (slow.reduce((a, b) => a + b, 0) / slow.length);
    const hz = displayRefreshHz();
    setText('perf-fps-target', fpsSamples.length >= 30 ? ` of ${hz} Hz display` : '');
    setText('perf-frame-time', `${fmtMs(avg)} avg · ${fmtMs(worst)} worst`);
    setText('perf-fps-low', `${Math.round(lowFps)} FPS`);
  }
  setText('perf-cpu', `${fmtMs(frame.updateMs)} update · ${fmtMs(frame.renderMs)} render`);
  refreshMemory();

  // Stage, live from the renderer.
  const live = frame.renderer;
  setText('perf-live-dc', live ? String(live.drawCalls) : '—');
  setText('perf-live-tris', live ? fmtInt(live.triangles) : '—');
  setText('perf-live-verts', live ? fmtInt(live.vertices) : '—');
  if (fpsSamples.length) {
    const peakDc = Math.max(...fpsSamples.map((s) => s.dc));
    const peakVerts = Math.max(...fpsSamples.map((s) => s.verts));
    setText('perf-live-peak', `${peakDc} draw calls · ${fmtInt(peakVerts)} vertices`);
  }
  setText('perf-live-breaks', live ? breaksText(live.batchBreaks) : '');

  const recent = recentStutters();
  setText('perf-stutters', String(recent.length));
  setText('perf-stutter-list', recent.slice(-3).reverse()
    .map((st) => `${Math.round(st.ms)} ms · ${st.cause}${st.context ? ` · ${st.context}` : ''}`)
    .join('\n'));

  const avgMs = fpsSamples.length ? fpsSamples.reduce((a, b) => a + b.ms, 0) / fpsSamples.length : null;
  renderBudget({
    frameMs: avgMs,
    drawCalls: live ? live.drawCalls : null,
    vertices: live ? live.vertices : null,
    vramBytes: scene.instances.length ? sceneAtlasMemorySummary(scene.instances).gpuUniqueBytes : null,
  });

  if (!scene.instances.length) {
    atlasHudCache = null;
    setPerfEmpty('Open a skeleton to measure it.');
    return;
  }

  const selectedInst = selected();
  const scopeAll = scene.perfScope === 'all';
  // All: visible skeletons only, matching countSceneDraws.
  const source = scopeAll
    ? scene.instances.filter((i) => i.visible !== false)
    : (selectedInst ? [selectedInst] : []);

  setText('perf-scope-title', scopeAll ? `All skeletons (${scene.instances.filter((i) => i.visible !== false).length} visible)` : 'Selected skeleton');

  const rows = source.map((inst) => measureInstance(inst));
  const total = sumPerf(rows);
  // All: draw the visible skeletons together so they batch with each other like on screen.
  const draws = scopeAll ? countSceneDraws(scene.instances) : (rows[0]?.exact ? rows[0] : null);

  const hudKey = `${atlasHudKey(scopeAll, selectedInst)}:${getTextureUnits()}`;
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
    const label = !scopeAll && selectedInst?.holdSetup ? 'setup pose' : 'current pose';
    poseNote.textContent = source.length
      ? `Counted at the ${label}${scopeAll ? ', visible skeletons drawn together' : ', drawn alone'}${getTextureUnits() !== getGpuTextureUnits() ? `, with ${getTextureUnits()} texture unit(s)` : ''}.`
      : '';
  }

  const peakEl = document.getElementById('perf-health-peak');
  if (peakEl) {
    let peakText = '';
    if (!scopeAll && selectedInst) {
      const report = getHealthReportForInstance(selectedInst);
      const sampled = report?.animations?.filter((a) => !a.runtimeSkipped) ?? [];
      if (sampled.length) {
        // Peaks per metric across every sampled animation, each with the animation it came from.
        const dc = sampled.reduce((a, b) => (b.hotDrawCalls > a.hotDrawCalls ? b : a));
        const verts = sampled.reduce((a, b) => (b.hotVertices > a.hotVertices ? b : a));
        peakText = `Animation peak (health scan): ${dc.hotDrawCalls} draw calls in “${dc.name}”, ${verts.hotVertices} vertices in “${verts.name}”.`;
      }
    }
    peakEl.textContent = peakText;
    peakEl.style.display = peakText ? 'block' : 'none';
  }

  const has = source.length > 0;
  const single = !scopeAll && selectedInst;
  const cpuRow = document.getElementById('perf-skel-cpu-row');
  const loadRow = document.getElementById('perf-load-row');
  if (cpuRow) cpuRow.hidden = !has;
  if (loadRow) loadRow.hidden = !single;
  if (has) {
    const cpu = source.reduce((sum, inst) => sum + (getUpdateMsForInstance(inst) ?? 0), 0);
    setText('perf-skel-cpu', fmtMs(cpu));
  }
  const load = single ? loadStatsText(getLoadStatsForInstance(selectedInst)) : { value: '', detail: '' };
  setText('perf-load', load.value);
  setText('perf-load-detail', load.detail);
  setText('perf-draw-calls', has ? String(draws ? draws.drawCalls : total.drawCalls) : '—');
  setText('perf-breaks', draws ? breaksText(draws.batchBreaks) : '');
  setText('perf-vertices', has ? fmtInt(draws ? (draws.vertices ?? draws.vertexCount) : total.vertexCount) : '—');
  setText('perf-triangles', has && draws?.triangles != null ? fmtInt(draws.triangles) : '—');
  setText('perf-textures', has && draws?.textures != null ? String(draws.textures) : '—');
  setText('perf-bones', has ? String(total.bones) : '—');
  setText('perf-constraints', has ? String(total.constraints) : '—');
  setText('perf-constraints-detailed', total.constraintDetail);
  const detail = document.getElementById('perf-constraints-detailed');
  if (detail) detail.style.display = total.constraintDetail ? 'block' : 'none';
  setText('perf-clippings', has ? String(total.clippingCount) : '—');
  setText('perf-mask-verts', has ? String(total.clippingVertexCount) : '—');
  const blends = draws?.blends ?? total.blends;
  setText('perf-blends', has ? blends : '—');
  setText('perf-blends-note', has ? blendsNote(blends) : '');

  renderPerfBreakdown(scopeAll ? scene.instances : []);
  setPerfEmpty(has ? '' : 'Select a skeleton, or switch to All.');
}

/**
 * All mode: one row per skeleton (each drawn alone), heaviest first, click selects.
 * @param {import('../app/sceneStore.js').SpineInstance[]} instances
 */
function renderPerfBreakdown(instances) {
  const group = document.getElementById('perf-breakdown-group');
  const host = document.getElementById('perf-breakdown');
  if (!group || !host) return;
  group.hidden = instances.length < 2;
  if (group.hidden) return;
  const rows = instances.map((inst) => {
    const m = measureInstance(inst);
    const atlas = marginalAtlasBytesForInstance(inst, instances);
    return { inst, m, atlas };
  }).sort((a, b) => b.m.drawCalls - a.m.drawCalls || b.m.vertexCount - a.m.vertexCount);
  const html = `
    <div class="perf-bd-head"><span>Skeleton</span><span>DC</span><span>Verts</span><span>CPU</span><span>Adds</span></div>
    ${rows.map(({ inst, m, atlas }) => `
      <button type="button" class="perf-bd-row${inst.id === scene.selectedId ? ' is-selected' : ''}${inst.visible === false ? ' is-hidden' : ''}" data-id="${escapeHtml(inst.id)}">
        <span class="perf-bd-name">${escapeHtml(inst.name)}</span>
        <span>${m.drawCalls}</span>
        <span>${fmtInt(m.vertexCount)}</span>
        <span>${(getUpdateMsForInstance(inst) ?? 0).toFixed(2)}</span>
        <span>${formatMb(atlas.marginalBytes)} MB</span>
      </button>`).join('')}
    <p class="perf-hint">Each skeleton drawn alone; together they can batch into fewer calls. CPU = ms per frame updating it. Adds = atlas VRAM not already on the GPU from a lower skeleton.</p>
  `;
  if (host.dataset.html !== html) {
    host.dataset.html = html;
    host.innerHTML = html;
  }
}

function syncPerfScope() {
  document.querySelectorAll('[data-perf-scope]').forEach((button) => {
    const on = /** @type {HTMLElement} */ (button).dataset.perfScope === scene.perfScope;
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-pressed', String(on));
  });
}

/** @param {string} message empty hides the note and shows the numbers */
function setPerfEmpty(message) {
  const note = document.getElementById('perf-empty');
  if (!note) return;
  if (note.textContent !== message) note.textContent = message;
  note.hidden = !message;
  document.getElementById('performance-panel')?.classList.toggle('is-empty', !!message);
}

function renderUndoButtons() {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  if (undoBtn) {
    undoBtn.dataset.tip = `Undo (${mod}Z)`;
    /** @type {HTMLButtonElement} */ (undoBtn).disabled = !canUndo();
  }
  if (redoBtn) {
    redoBtn.dataset.tip = `Redo (${mod}Shift+Z)`;
    /** @type {HTMLButtonElement} */ (redoBtn).disabled = !canRedo();
  }
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
  for (const id of ['scene-panel', 'animations-panel', 'performance-panel']) {
    document.getElementById(id)?.classList.toggle('is-focused', id === focusedPanel);
  }
}

function applyPanelVisibility() {
  document.getElementById('performance-panel')?.classList.add('is-visible');
  document.getElementById('animations-panel')?.classList.add('is-visible');
}

function toggleSelectionMarks() {
  ui.selectionMarks = !selectionMarksVisible();
  setSelectionMarksVisible(ui.selectionMarks);
  persistUi();
  emit();
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
  }
  if (event.code === 'KeyO' && !command && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    toggleSelectionMarks();
    return;
  }
  if (event.code === 'KeyS' && !command && !event.shiftKey && !event.altKey) {
    const inst = selected();
    if (inst?.previousSkins) {
      event.preventDefault();
      withHistory(() => flipSkins(inst));
      return;
    }
  }
  if (event.code === 'KeyH' && !command && !event.shiftKey && !event.altKey) {
    const inst = selected();
    if (inst && focusedPanel === 'scene-panel' && inst.selectedSlot) {
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
    if (document.activeElement?.closest('#scene-list') && openOrCloseOutlinerRow(event.key === 'ArrowRight')) {
      event.preventDefault();
      return;
    }
    seekByKeyboard(event);
  }
}

/**
 * Tree keys while the tree has focus: → opens the cursor row, then steps into it; ← shuts it, then steps to its parent.
 * @param {boolean} forward
 * @returns {boolean} whether the key was used
 */
function openOrCloseOutlinerRow(forward) {
  const row = outlinerRows.find((item) => item.node.key === (outlinerCursor || outlinerSelectionKey()));
  if (!row) return false;
  const open = outlinerRows[row.index + 1]?.path.includes(row.node.key) ?? false;
  if (forward) {
    if (!row.node.children.length) return true;
    if (!open) {
      setOutlinerOpen(row.node.key, true);
      renderSceneList();
    } else moveOutlinerCursor(1);
  } else if (open && row.node.children.length) {
    setOutlinerOpen(row.node.key, false);
    renderSceneList();
  } else {
    const parent = outlinerRows.find((item) => item.node.key === row.path[row.path.length - 1]);
    if (parent) moveOutlinerCursor(parent.index - row.index);
  }
  document.querySelector(`#scene-list li[data-key="${CSS.escape(outlinerCursor || '')}"] :is(.outliner-name, .scene-name)`)?.focus();
  return true;
}

/** @param {KeyboardEvent} event */
function onKeyUp(event) {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') scene.scrubbing = false;
}

/** @param {number} direction */
function movePanel(direction) {
  if (focusedPanel === 'scene-panel') {
    moveOutlinerCursor(direction);
    return;
  }
  const inst = selected();
  if (!inst) return;
  if (focusedPanel === 'animations-panel') {
    const anims = (inst.spine.skeleton.data.animations || [])
      .filter((anim) => matchesFilter(anim.name, panelFilters.animations));
    const index = anims.findIndex((anim) => anim.name === inst.tracks[inst.selectedTrack]);
    const next = clampIndex(index, anims.length, direction);
    if (anims[next]) setTrack(inst, inst.selectedTrack, anims[next].name);

  }
}

/**
 * Walk the drawn outliner rows; rows that stand for something (asset, bone, slot) select it as the cursor lands.
 * @param {number} direction
 */
function moveOutlinerCursor(direction) {
  if (!outlinerRows.length) return;
  const index = outlinerRows.findIndex((row) => row.node.key === (outlinerCursor || outlinerSelectionKey()));
  const row = outlinerRows[clampIndex(index, outlinerRows.length, direction)];
  if (!row) return;
  const key = row.node.key;
  const inst = scene.instances.find((item) => item.id === key.slice(0, key.indexOf('|')));
  if (!inst) return;
  outlinerCursor = key;
  outlinerScrollPending = true;
  if (row.node.kind === 'asset') {
    if (inst.selectedSlot) setSelectedSlot(inst, null);
    inst.selectedBone = null;
    selectInstance(inst.id);
  } else activateOutlinerRow(inst, row.node);
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
  // Play brings these back.
  if (Object.keys(item.tracks).length) item.savedTracks = { ...item.tracks };
  item.eventLog?.clear();
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
  const targets = selectedInstances().length ? selectedInstances() : scene.instances;
  if (!targets.length) return;
  for (const item of targets) resetInstanceToSetup(item);
  scene.playing = scene.instances.some((item) => item.playing);
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

/** Download the layout only; the skeleton files stay with the user and Open scene asks for them. */
function saveScene() {
  const blob = new Blob([JSON.stringify(serializeScene(scene), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'tabula-scene.json';
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
