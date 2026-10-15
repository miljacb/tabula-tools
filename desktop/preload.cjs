/**
 * The page's bridge to the desktop app (window.tabula): the folder picker,
 * the real path of a dropped folder, projects opened from the menu, and
 * CPU throttling for the weak-device preview.
 * Nothing else of Node or Electron reaches the page.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tabula', {
  openFolder: () => ipcRenderer.invoke('tabula:open-folder'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProjectOpened: (callback) => ipcRenderer.on('project-opened', (_event, dir) => callback(dir)),
  /** Slow the page's CPU down `rate` times (1 = off), like a weak phone (Chromium's CPU throttling). */
  setCpuThrottle: (rate) => ipcRenderer.invoke('tabula:cpu-throttle', rate),
});
