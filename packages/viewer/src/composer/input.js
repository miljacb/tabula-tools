import { SNAP_PX, ZOOM_STEP } from '../constants.js';
import {
  emit,
  isInstanceSelected,
  scene,
  selectInstance,
  selectInstances,
  selectedInstances,
} from '../app/sceneStore.js';
import { captureHistorySnapshot } from '../app/session.js';
import { pushUndo } from '../app/history.js';
import { pickSlotAtLocal } from '../features/slotPick.js';
import { applySlotVisibility } from '../features/slotVisibility.js';
import { clientDragRect, instanceIdsFullyInsideMarquee } from './marquee.js';
import {
  camera,
  clientToGlobal,
  drawGuides,
  drawMarquee,
  readCameraIntoScene,
  zoomAt,
} from '../app/stage.js';
import { snapBox, snapToGrid } from './snap.js';

/** @type {boolean} */
let spaceDown = false;

const MARQUEE_THRESHOLD_PX = 4;

/** @type {((id: string) => void)} */
let onDoublePick = () => {};

/** @param {(id: string) => void} fn */
export function setOnDoublePick(fn) {
  onDoublePick = fn;
}

/** @type {() => void} */
let onEmptyClick = () => {};

/** Runs on a plain click on empty stage, before the selection is cleared. @param {() => void} fn */
export function setOnEmptyClick(fn) {
  onEmptyClick = fn;
}

/** @param {HTMLCanvasElement} canvas */
export function bindPointer(canvas) {
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (!camera) return;
    const rect = canvas.getBoundingClientRect();
    const direction = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, camera.scale.x + direction);
    const label = document.getElementById('zoom-label');
    if (label) label.textContent = `${Math.round(camera.scale.x * 100)}%`;
  }, { passive: false });

  /** @type {null | {
   *   kind: 'pan' | 'move' | 'marquee',
   *   startClientX: number,
   *   startClientY: number,
   *   startCamX: number,
   *   startCamY: number,
   *   lastX: number,
   *   lastY: number,
   *   additive?: boolean,
   *   moveIds?: string[],
   *   starts?: { id: string, x: number, y: number }[],
   *   box?: { x: number, y: number, width: number, height: number },
   *   others?: { x: number, y: number, width: number, height: number }[],
   *   undoSnap?: object,
   * }} */
  let drag = null;

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    const global = clientToGlobal(event.clientX, event.clientY);
    const inst = event.button === 0 && !spaceDown ? pickInstance(global, false) : null;
    if (!inst || !camera) {
      if (event.button === 0 && !spaceDown && !inst && camera) {
        drag = {
          kind: 'marquee',
          startClientX: event.clientX,
          startClientY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          startCamX: 0,
          startCamY: 0,
          additive: event.metaKey || event.ctrlKey || event.shiftKey,
        };
        canvas.classList.add('is-dragging');
        return;
      }
      drag = {
        kind: 'pan',
        startClientX: event.clientX,
        startClientY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        startCamX: camera?.x ?? 0,
        startCamY: camera?.y ?? 0,
      };
      canvas.classList.add('is-dragging');
      return;
    }
    const additive = event.metaKey || event.ctrlKey;
    const wasSelected = isInstanceSelected(inst.id);
    if (additive) {
      selectInstance(inst.id, { additive: true });
    } else if (!wasSelected || scene.selectedIds.size <= 1) {
      selectInstance(inst.id);
    }
    pickSlotOnInstance(inst, global);
    const moveIds = scene.selectedIds.size > 1 && scene.selectedIds.has(inst.id)
      ? selectedInstances().map((item) => item.id)
      : [inst.id];
    const lead = scene.instances.find((item) => item.id === moveIds[0]) || inst;
    const bounds = lead.spine.getBounds();
    const moveSet = new Set(moveIds);
    drag = {
      kind: 'move',
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startCamX: 0,
      startCamY: 0,
      moveIds,
      starts: moveIds.map((id) => {
        const item = scene.instances.find((entry) => entry.id === id);
        return { id, x: item?.spine.x ?? 0, y: item?.spine.y ?? 0 };
      }),
      box: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      others: scene.instances
        .filter((other) => other.visible && !moveSet.has(other.id))
        .map((other) => {
          const b = other.spine.getBounds();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        }),
      undoSnap: captureHistorySnapshot(),
    };
    canvas.classList.add('is-dragging');
  });

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {boolean} shiftKey
   */
  function applyDrag(clientX, clientY, shiftKey) {
    if (!drag || !camera) return;
    drag.lastX = clientX;
    drag.lastY = clientY;
    const dx = clientX - drag.startClientX;
    const dy = clientY - drag.startClientY;
    if (drag.kind === 'marquee') {
      if (Math.hypot(dx, dy) >= MARQUEE_THRESHOLD_PX) {
        drawMarquee(clientDragRect(drag.startClientX, drag.startClientY, clientX, clientY));
      } else {
        drawMarquee(null);
      }
      return;
    }
    if (drag.kind === 'pan') {
      camera.x = drag.startCamX + dx;
      camera.y = drag.startCamY + dy;
      readCameraIntoScene();
      return;
    }
    if (!drag.box) return;
    let moveX = dx;
    let moveY = dy;
    const proposed = {
      x: drag.box.x + moveX,
      y: drag.box.y + moveY,
      width: drag.box.width,
      height: drag.box.height,
    };
    /** @type {{ vertical: number | null, horizontal: number | null }} */
    const guide = { vertical: null, horizontal: null };
    if (scene.snapEnabled !== shiftKey) {
      const snapped = snapBox(proposed, drag.others || [], SNAP_PX);
      moveX += snapped.box.x - proposed.x;
      moveY += snapped.box.y - proposed.y;
      proposed.x = snapped.box.x;
      proposed.y = snapped.box.y;
      for (const line of snapped.guides) {
        if (line.axis === 'x') guide.vertical = line.at;
        if (line.axis === 'y') guide.horizontal = line.at;
      }
    }
    drawGuides(guide);
    const scale = camera.scale.x || 1;
    let dxWorld = moveX / scale;
    let dyWorld = moveY / scale;
    if (scene.gridEnabled !== shiftKey && scene.gridSize > 0) {
      const lead = (drag.starts || [])[0];
      if (lead) {
        const worldBox = {
          x: lead.x + dxWorld,
          y: lead.y + dyWorld,
          width: (drag.box.width || 0) / scale,
          height: (drag.box.height || 0) / scale,
        };
        const grid = snapToGrid(worldBox, scene.gridSize, SNAP_PX / scale);
        dxWorld += grid.box.x - worldBox.x;
        dyWorld += grid.box.y - worldBox.y;
      }
    }
    for (const start of drag.starts || []) {
      const inst = scene.instances.find((item) => item.id === start.id);
      if (!inst) continue;
      inst.spine.position.set(start.x + dxWorld, start.y + dyWorld);
    }
  }

  window.addEventListener('pointermove', (event) => {
    if (!drag) return;
    applyDrag(event.clientX, event.clientY, event.shiftKey);
  });

  const endDrag = () => {
    if (!drag) return;
    if (drag.kind === 'marquee') {
      const dx = drag.lastX - drag.startClientX;
      const dy = drag.lastY - drag.startClientY;
      const dist = Math.hypot(dx, dy);
      if (dist < MARQUEE_THRESHOLD_PX) {
        if (!drag.additive) {
          onEmptyClick();
          selectInstance(null);
        }
      } else {
        const ids = instanceIdsFullyInsideMarquee(
          drag.startClientX,
          drag.startClientY,
          drag.lastX,
          drag.lastY,
        );
        selectInstances(ids, { additive: !!drag.additive });
      }
      drawMarquee(null);
    } else if (drag.kind === 'move') {
      const moved = (drag.starts || []).some((start) => {
        const inst = scene.instances.find((item) => item.id === start.id);
        return inst && (inst.spine.x !== start.x || inst.spine.y !== start.y);
      });
      if (moved && drag.undoSnap) pushUndo(drag.undoSnap);
      emit();
    }
    drag = null;
    canvas.classList.remove('is-dragging');
    drawGuides({ vertical: null, horizontal: null });
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !isTyping(event.target)) {
      spaceDown = true;
      canvas.classList.add('is-space');
    }
    if (event.key === 'Shift' && drag?.kind === 'move') applyDrag(drag.lastX, drag.lastY, true);
  });
  window.addEventListener('keyup', (event) => {
    if (event.code === 'Space') {
      spaceDown = false;
      canvas.classList.remove('is-space');
    }
    if (event.key === 'Shift' && drag?.kind === 'move') applyDrag(drag.lastX, drag.lastY, false);
  });

  canvas.addEventListener('dblclick', (event) => {
    const global = clientToGlobal(event.clientX, event.clientY);
    const inst = pickInstance(global, true);
    if (!inst) return;
    selectInstance(inst.id);
    onDoublePick(inst.id);
  });
}

/**
 * @param {import('pixi.js').Point} global
 * @param {boolean} includeLocked
 */
function pickInstance(global, includeLocked) {
  const ordered = [...scene.instances].sort((a, b) => b.zIndex - a.zIndex);
  for (const inst of ordered) {
    if (!inst.visible || (!includeLocked && inst.locked)) continue;
    const b = inst.spine.getBounds();
    if (global.x >= b.x && global.x <= b.x + b.width && global.y >= b.y && global.y <= b.y + b.height) {
      return inst;
    }
  }
  return null;
}

/**
 * @param {import('../app/sceneStore.js').SpineInstance} inst
 * @param {import('pixi.js').Point} global
 */
function pickSlotOnInstance(inst, global) {
  if (!inst?.spine?.toLocal) return;
  const local = inst.spine.toLocal(global);
  const name = pickSlotAtLocal(inst, local);
  if (!name) return;
  inst.selectedSlot = name;
  try {
    inst.spine.skeleton.setToSetupPose();
    inst.spine.state.apply(inst.spine.skeleton);
    applySlotVisibility(inst);
  } catch {
    /* pose helpers missing */
  }
  emit();
}

/** @param {EventTarget | null} target */
function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
