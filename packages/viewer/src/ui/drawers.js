import { DRAWER_STORAGE_KEY } from '../constants.js';

/** Default tool per drawer on a first visit; `null` means the drawer is closed. */
const DEFAULTS = { right: 'outliner', bottom: 'animations' };

/** Active tool per drawer, plus the bottom drawer's height and the side drawer's width. @type {Record<string, any>} */
let active = { ...DEFAULTS };

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAWER_STORAGE_KEY) || '{}');
    for (const drawer of Object.keys(DEFAULTS)) {
      if (raw[drawer] === null || typeof raw[drawer] === 'string') active[drawer] = raw[drawer];
    }
    if (typeof raw.bottomHeight === 'number') active.bottomHeight = raw.bottomHeight;
    if (typeof raw.rightWidth === 'number') active.rightWidth = raw.rightWidth;
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
  // The first-paint hint from index.html has done its job; the classes above rule from here.
  delete document.documentElement.dataset.right;
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
  if (!drawer || button?.getAttribute('aria-disabled') === 'true') return;
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

const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 240;

/** Keep the side drawer between its minimum and half the window. @param {number} width */
function clampWidth(width) {
  return Math.round(Math.max(MIN_WIDTH, Math.min(width, Math.max(MIN_WIDTH, window.innerWidth * 0.5))));
}

/** @param {number} width */
function setDrawerWidth(width) {
  const drawer = document.getElementById('right-stack');
  if (!drawer) return;
  drawer.style.setProperty('--drawer-width', `${clampWidth(width)}px`);
  window.dispatchEvent(new Event('resize'));
}

/** Drag the side drawer's left edge, like the animations drawer's top edge. */
function bindSideResize() {
  const drawer = document.getElementById('right-stack');
  const handle = drawer?.querySelector('.drawer-resize-x');
  if (!drawer || !(handle instanceof HTMLElement)) return;
  if (typeof active.rightWidth === 'number') setDrawerWidth(active.rightWidth);
  // A width saved on a wide screen must still fit a narrower window.
  window.addEventListener('resize', () => {
    if (typeof active.rightWidth !== 'number') return;
    const width = clampWidth(active.rightWidth);
    if (`${width}px` !== drawer.style.getPropertyValue('--drawer-width')) drawer.style.setProperty('--drawer-width', `${width}px`);
  });
  const commit = () => {
    active.rightWidth = drawer.getBoundingClientRect().width;
    save();
  };
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = drawer.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
    document.body.classList.add('is-resizing-drawer-x');
    const move = (/** @type {PointerEvent} */ next) => setDrawerWidth(startWidth + (startX - next.clientX));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing-drawer-x');
      commit();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  handle.addEventListener('dblclick', () => {
    setDrawerWidth(DEFAULT_WIDTH);
    commit();
  });
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 40 : 10;
    setDrawerWidth(drawer.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? step : -step));
    commit();
  });
}

export function bindDrawers() {
  load();
  // A tool saved by an older layout (the Slots, Bones and Skins pages now live in the Outliner) falls back to the default.
  for (const drawer of Object.keys(DEFAULTS)) {
    const tool = active[drawer];
    if (tool && !document.querySelector(`.rail-tool[data-drawer="${drawer}"][data-tool="${CSS.escape(tool)}"]`)) active[drawer] = DEFAULTS[drawer];
  }
  bindDrawerResize();
  bindSideResize();
  document.querySelectorAll('.rail-tool').forEach((button) => {
    button.addEventListener('click', () => openTool(/** @type {HTMLElement} */ (button).dataset.tool || '', { toggle: true }));
  });
  render();
}
