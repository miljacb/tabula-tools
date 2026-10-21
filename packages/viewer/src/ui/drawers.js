import { DRAWER_STORAGE_KEY } from '../constants.js';

/** Default tool per drawer on a first visit; `null` means the drawer is closed. */
const DEFAULTS = { right: 'outliner', bottom: 'animations' };

/** Active tool per drawer, plus the bottom drawer's height. @type {Record<string, any>} */
let active = { ...DEFAULTS };

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAWER_STORAGE_KEY) || '{}');
    for (const drawer of Object.keys(DEFAULTS)) {
      if (raw[drawer] === null || typeof raw[drawer] === 'string') active[drawer] = raw[drawer];
    }
    if (typeof raw.bottomHeight === 'number') active.bottomHeight = raw.bottomHeight;
  } catch {
    /* ignore */
  }
}

function save() {
  try {
    localStorage.setItem(DRAWER_STORAGE_KEY, JSON.stringify(active));
  } catch {
    /* ignore */
  }
}

/** @param {string} drawer */
function drawerElement(drawer) {
  return document.getElementById(drawer === 'right' ? 'right-stack' : 'bottom-drawer');
}

function render() {
  for (const drawer of Object.keys(DEFAULTS)) {
    const host = drawerElement(drawer);
    if (!host) continue;
    const tool = active[drawer];
    let title = '';
    host.querySelectorAll('.drawer-page').forEach((page) => {
      const el = /** @type {HTMLElement} */ (page);
      el.hidden = el.dataset.tool !== tool;
      if (!el.hidden) title = el.dataset.title || '';
    });
    host.classList.toggle('is-closed', !tool);
    const heading = document.getElementById(`${drawer}-drawer-title`);
    if (heading) heading.textContent = title;
  }
  document.querySelectorAll('.rail-tool').forEach((button) => {
    const el = /** @type {HTMLElement} */ (button);
    el.setAttribute('aria-pressed', String(active[el.dataset.drawer || ''] === el.dataset.tool));
  });
  // Pixi's resizeTo only listens to window resize.
  window.dispatchEvent(new Event('resize'));
}

/**
 * Show a tool in its drawer. `toggle` closes the drawer when the tool is already shown.
 * @param {string} tool
 * @param {{ toggle?: boolean }} [options]
 */
export function openTool(tool, { toggle = false } = {}) {
  const button = /** @type {HTMLElement | null} */ (document.querySelector(`.rail-tool[data-tool="${tool}"]`));
  const drawer = button?.dataset.drawer;
  if (!drawer) return;
  active[drawer] = toggle && active[drawer] === tool ? null : tool;
  save();
  render();
}

const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 120;

/** Keep the drawer between its minimum and most of the stage card. @param {number} height */
function clampHeight(height) {
  const card = document.querySelector('.stage-card');
  const max = Math.max(MIN_HEIGHT, (card?.clientHeight ?? window.innerHeight) - 140);
  return Math.round(Math.max(MIN_HEIGHT, Math.min(height, max)));
}

/** @param {number} height */
function setDrawerHeight(height) {
  const drawer = document.getElementById('bottom-drawer');
  if (!drawer) return;
  drawer.style.setProperty('--drawer-height', `${clampHeight(height)}px`);
  window.dispatchEvent(new Event('resize'));
}

function bindDrawerResize() {
  const drawer = document.getElementById('bottom-drawer');
  const handle = drawer?.querySelector('.drawer-resize');
  if (!drawer || !(handle instanceof HTMLElement)) return;
  if (typeof active.bottomHeight === 'number') setDrawerHeight(active.bottomHeight);
  const commit = () => {
    active.bottomHeight = drawer.getBoundingClientRect().height;
    save();
  };
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = drawer.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
    document.body.classList.add('is-resizing-drawer');
    const move = (/** @type {PointerEvent} */ next) => setDrawerHeight(startHeight + (startY - next.clientY));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing-drawer');
      commit();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  handle.addEventListener('dblclick', () => {
    setDrawerHeight(DEFAULT_HEIGHT);
    commit();
  });
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    setDrawerHeight(drawer.getBoundingClientRect().height + (event.key === 'ArrowUp' ? step : -step));
    commit();
  });
}

export function bindDrawers() {
  load();
  bindDrawerResize();
  document.querySelectorAll('.rail-tool').forEach((button) => {
    button.addEventListener('click', () => openTool(/** @type {HTMLElement} */ (button).dataset.tool || '', { toggle: true }));
  });
  render();
}
