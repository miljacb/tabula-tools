import { UI_STORAGE_KEY } from '../constants.js';
import { DEFAULT_DEBUG_FLAGS } from '../features/debugOverlay.js';

const DEFAULTS = {
  perfScope: 'selected',
  animApplyGlobal: false,
  fps: 30,
  timeUnit: 'seconds',
  mix: 0,
  showKeys: false,
  selectionMarks: true,
  background: 'dark',
  backgroundColor: '#111111',
  debug: { ...DEFAULT_DEBUG_FLAGS },
};

export function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, debug: { ...DEFAULT_DEBUG_FLAGS } };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      debug: { ...DEFAULT_DEBUG_FLAGS, ...(parsed.debug || {}) },
    };
  } catch {
    return { ...DEFAULTS, debug: { ...DEFAULT_DEBUG_FLAGS } };
  }
}

/** @param {Record<string, unknown>} state */
export function saveUiState(state) {
  localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state));
}
