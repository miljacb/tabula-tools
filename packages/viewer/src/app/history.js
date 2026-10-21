import { HISTORY_LIMIT } from '../constants.js';

/** @type {object[]} */
let undoStack = [];
/** @type {object[]} */
let redoStack = [];
let applying = false;

/** @type {() => object} */
let captureFn = () => ({});
/** @type {(snapshot: object) => Promise<void> | void} */
let applyFn = () => {};

/**
 * @param {{ capture: () => object, apply: (snapshot: object) => Promise<void> | void }} api
 */
export function configureHistory(api) {
  captureFn = api.capture;
  applyFn = api.apply;
}

export function isHistoryApplying() {
  return applying;
}

export function clearHistory() {
  undoStack = [];
  redoStack = [];
}

export function canUndo() {
  return undoStack.length > 0;
}

export function canRedo() {
  return redoStack.length > 0;
}

/** @param {object} snapshot */
export function pushUndo(snapshot) {
  if (applying) return;
  undoStack.push(snapshot);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
}

export function recordHistory() {
  if (applying) return;
  pushUndo(captureFn());
}

/**
 * Snapshot current state, run `fn`, leave one undo step.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function withHistory(fn) {
  if (applying) return fn();
  recordHistory();
  return fn();
}

export async function undo() {
  if (!undoStack.length || applying) return false;
  const previous = undoStack.pop();
  const current = captureFn();
  redoStack.push(current);
  applying = true;
  try {
    await applyFn(previous);
  } finally {
    applying = false;
  }
  return true;
}

export async function redo() {
  if (!redoStack.length || applying) return false;
  const next = redoStack.pop();
  const current = captureFn();
  undoStack.push(current);
  applying = true;
  try {
    await applyFn(next);
  } finally {
    applying = false;
  }
  return true;
}
