export const ZOOM_STEP = 0.15;
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
export const SNAP_PX = 8;
export const GRID_SIZES = [8, 16, 32, 64];
export const DEFAULT_GRID_SIZE = 16;
export const HISTORY_LIMIT = 50;

export const TRACK_COLORS = ['#569cd6', '#ce9178', '#b5cea8', '#dcdcaa', '#c586c0'];
export const TRACK_COUNT = TRACK_COLORS.length;

export const MASK_COLORS = [
  { r: 0, g: 1, b: 0, attr: 'green' },
  { r: 0, g: 0, b: 1, attr: 'blue' },
  { r: 1, g: 0, b: 0, attr: 'red' },
];

export const UI_STORAGE_KEY = 'spine-viewer-web.ui';
export const SCREEN_STORAGE_KEY = 'spine-viewer-web.screens';
export const DRAWER_STORAGE_KEY = 'spine-viewer-web.drawers';
export const SESSION_DB_NAME = 'spine-viewer-web-session';
