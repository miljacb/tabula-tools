import { SCREEN_STORAGE_KEY } from '../constants.js';

/**
 * @typedef {Object} ScreenSize
 * @property {string} id
 * @property {number} width
 * @property {number} height
 * @property {boolean} builtin
 */

/** @type {ScreenSize[]} */
export const BUILTIN_SCREENS = [
  { id: '1080x1920', width: 1080, height: 1920, builtin: true },
  { id: '1920x1080', width: 1920, height: 1080, builtin: true },
];

/**
 * @param {unknown} value
 * @returns {value is { id: string, width: number, height: number }}
 */
function isCustom(value) {
  if (!value || typeof value !== 'object') return false;
  const item = /** @type {{ id?: unknown, width?: unknown, height?: unknown }} */ (value);
  return typeof item.id === 'string'
    && Number.isFinite(item.width)
    && Number.isFinite(item.height)
    && item.width > 0
    && item.height > 0;
}

export function loadScreenState() {
  /** @type {ScreenSize[]} */
  let custom = [];
  let selectedId = BUILTIN_SCREENS[0].id;
  try {
    const raw = JSON.parse(localStorage.getItem(SCREEN_STORAGE_KEY) || '{}');
    if (Array.isArray(raw.custom)) {
      custom = raw.custom.filter(isCustom).map((item) => ({
        id: item.id,
        width: Math.round(item.width),
        height: Math.round(item.height),
        builtin: false,
      }));
    }
    if (typeof raw.selectedId === 'string') selectedId = raw.selectedId;
  } catch {
    custom = [];
  }
  const all = [...BUILTIN_SCREENS, ...custom];
  if (!all.some((item) => item.id === selectedId)) selectedId = BUILTIN_SCREENS[0].id;
  return { custom, selectedId, all };
}

/**
 * @param {ScreenSize[]} custom
 * @param {string} selectedId
 */
export function saveScreenState(custom, selectedId) {
  localStorage.setItem(SCREEN_STORAGE_KEY, JSON.stringify({
    selectedId,
    custom: custom.map((item) => ({ id: item.id, width: item.width, height: item.height })),
  }));
}

/** @param {number} width @param {number} height */
export function formatScreenSize(width, height) {
  return `${width} × ${height}`;
}
