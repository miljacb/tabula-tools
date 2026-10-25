import { importFiles } from '../app/session.js';
import {
  addRecent,
  clearRecent,
  filesName,
  grantRead,
  listRecent,
  pickFiles,
  pickFolder,
  readFolder,
  recentItems,
  recentSupported,
  removeRecent,
  renderRecentList,
  renderRecentMenu,
} from '../../../ui/recent.ts';

/**
 * Recent folders and file sets (packages/ui/recent.ts): the start card's list, the "More" menu's
 * Open recent, and the pickers that remember what they open. Chromium only; elsewhere the plain
 * file input stays and no list shows.
 */

const TOOL = 'viewer';

/** @type {(message: string) => void} */
let report = () => {};

/** Files of a folder handle, each with its path inside the folder (as dropped folders carry it). */
async function folderFiles(dir) {
  return (await readFolder(dir, /(^|\/)\./)).map(([path, file]) => {
    Object.defineProperty(file, 'viewerPath', { value: path });
    return file;
  });
}

export async function renderRecent() {
  const items = recentItems(await listRecent(TOOL));
  const block = document.getElementById('recent-block');
  const list = document.getElementById('recent');
  if (block) block.hidden = !items.length;
  if (list) renderRecentList(list, items, (id) => void openRecent(id), (id) => void removeRecent(id).then(renderRecent));
  const menu = document.getElementById('menu-recent');
  if (menu) renderRecentMenu(menu, items, (id) => void openRecent(id), () => void clearRecent(TOOL).then(renderRecent));
}

async function openRecent(id) {
  const entry = (await listRecent(TOOL)).find((item) => item.id === id);
  if (!entry) return;
  if (!(await grantRead(entry.handles))) {
    report(`No access to ${entry.name}. Allow it, or open it again.`);
    return;
  }
  try {
    const files = entry.kind === 'folder'
      ? await folderFiles(/** @type {FileSystemDirectoryHandle} */ (entry.handles[0]))
      : await Promise.all(entry.handles.map((handle) => /** @type {FileSystemFileHandle} */ (handle).getFile()));
    await addRecent(TOOL, entry.kind, entry.name, entry.handles);
    void renderRecent();
    await importFiles(files);
  } catch {
    report(`${entry.name} is gone or was moved. Removed from recent.`);
    await removeRecent(entry.id);
    void renderRecent();
  }
}

/** Remember dropped items: one folder as a folder, anything else as a file set. */
export async function rememberDropped(handles) {
  if (!handles.length) return;
  const folders = handles.filter((handle) => handle.kind === 'directory');
  if (folders.length === 1 && handles.length === 1) await addRecent(TOOL, 'folder', folders[0].name, folders);
  else if (!folders.length) await addRecent(TOOL, 'files', filesName(handles.map((handle) => handle.name)), handles);
  void renderRecent();
}

/**
 * @param {{ fallbackInput: () => void, report: (message: string) => void }} options
 */
export function bindRecent(options) {
  report = options.report;
  const openFiles = async () => {
    if (!recentSupported) return options.fallbackInput();
    const handles = await pickFiles();
    if (!handles.length) return;
    const files = await Promise.all(handles.map((handle) => handle.getFile()));
    await addRecent(TOOL, 'files', filesName(handles.map((handle) => handle.name)), handles);
    void renderRecent();
    await importFiles(files);
  };
  const openFolder = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    const files = await folderFiles(dir);
    await addRecent(TOOL, 'folder', dir.name, [dir]);
    void renderRecent();
    await importFiles(files);
  };
  document.getElementById('btn-import')?.addEventListener('click', () => void openFiles());
  document.getElementById('start-open')?.addEventListener('click', () => void openFiles());
  const folderButton = document.getElementById('start-open-folder');
  if (folderButton) {
    folderButton.hidden = !recentSupported;
    folderButton.addEventListener('click', () => void openFolder());
  }
  void renderRecent();
}
