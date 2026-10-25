/**
 * Tabula Tools desktop app (Electron). The main process runs the app server
 * (dist/cli/app, the same one as `tabula app`) on 127.0.0.1 with a free
 * port and shows the tools homepage in a window; the tools are its subpages. preload.cjs gives the page the folder
 * picker and the paths of dropped folders.
 *
 * Run: pnpm desktop. Package: pnpm desktop:dist.
 */

import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const icon = join(here, 'icons', 'icon.png');

// The KTX2 encoder and its cache live in the user's app data, not in the (read-only) app bundle.
process.env.TABULA_CACHE_DIR ??= join(app.getPath('userData'), 'cache');

let server = null;
let win = null;
/** Recent project folders, newest first (the server's recent.json), for File › Open Recent. */
let recent = [];
/** A folder or file the OS asked us to open before the server was up (macOS open-file). */
let pendingOpen = null;

async function chooseFolder() {
  const result = await dialog.showOpenDialog(win, { title: 'Open a project folder', properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
}

async function openFromMenu() {
  const dir = await chooseFolder();
  if (dir) await openPath(dir);
}

/** Open a project folder (or a file: its folder) and show it in the exporter. */
async function openPath(dir) {
  try {
    const folder = await server.handler.open(dir);
    app.addRecentDocument(folder);
    // The exporter picks the project up live; from the homepage or another tool, go to it.
    const exporter = `${server.url}exporter/`;
    if (win?.webContents.getURL().startsWith(exporter)) win.webContents.send('project-opened', folder);
    else await win?.loadURL(exporter);
    win?.show();
  } catch (err) {
    dialog.showErrorBox('Cannot open the folder', err.message);
  }
}

function setRecent(list) {
  recent = list;
  buildMenu();
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => void openFromMenu() },
        {
          label: 'Open Recent',
          enabled: recent.length > 0,
          submenu: recent.length ? [
            ...recent.map((dir) => ({ label: `${basename(dir)}  —  ${dir}`, click: () => void openPath(dir) })),
            { type: 'separator' },
            { label: 'Clear Recent', click: () => { app.clearRecentDocuments(); void server.handler.forget(); } },
          ] : [{ label: 'No recent projects', enabled: false }],
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600, title: 'Tabula Tools', show: false, icon,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Links to other sites open in the browser, never in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(server.url)) event.preventDefault();
  });
  win.once('ready-to-show', () => win.show());
  await win.loadURL(server.url);
}

app.whenReady().then(async () => {
  const { startAppServer } = await import(pathToFileURL(join(here, '..', 'dist', 'cli', 'app', 'command.js')).href);
  const folder = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  server = await startAppServer({ port: 0, projectDir: folder, recentFile: join(app.getPath('userData'), 'recent.json'), onRecent: setRecent });
  recent = await server.handler.recent();
  // The OS recent list (macOS Dock / File menu of Finder, Windows jump list) mirrors ours.
  app.clearRecentDocuments();
  for (const dir of [...recent].reverse()) app.addRecentDocument(dir);
  ipcMain.handle('tabula:open-folder', () => chooseFolder());
  // Packaged builds get the icon from electron-builder; this covers `pnpm desktop` (the dock shows Electron's otherwise).
  if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(icon);
  buildMenu();
  await createWindow();
  if (pendingOpen) void openPath(pendingOpen);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch((err) => {
  dialog.showErrorBox('Tabula could not start', String(err?.stack ?? err));
  app.quit();
});

// One window: a second launch (Windows jump list, a folder opened with the app) hands its folder to this one.
// exit, not quit: quit waits, and whenReady above would still start a second server and window.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', (_event, argv) => {
  const path = argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  if (path && server) void openPath(path);
  else win?.show();
});

// macOS: a folder dropped on the Dock icon, or picked from the Dock's recent list.
app.on('open-file', (event, path) => {
  event.preventDefault();
  if (server && win) void openPath(path);
  else pendingOpen = path;
});

app.on('window-all-closed', () => {
  server?.close();
  app.quit();
});
