/**
 * Recent folders and files for the Tabula tools in the browser (and the desktop app's window), kept as
 * File System Access handles in IndexedDB. Reopening asks the browser for read access again; nothing is
 * copied. Chromium only (Chrome, Edge, Electron): elsewhere {@link recentSupported} is false and the
 * tools fall back to their plain pickers.
 */

export type RecentKind = 'folder' | 'files';

export interface RecentEntry {
  id: string;
  /** Which tool remembered it ('viewer', 'exporter'). */
  tool: string;
  kind: RecentKind;
  name: string;
  handles: FileSystemHandle[];
  opened: number;
}

const DB_NAME = 'tabula-tools-recent';
const STORE = 'entries';
const MAX = 8;

type Picker = Window & {
  showDirectoryPicker?: (options?: object) => Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?: (options?: object) => Promise<FileSystemFileHandle[]>;
};
type PermissionHandle = FileSystemHandle & {
  queryPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
};

export const recentSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window && 'indexedDB' in window;

function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const base = await db();
  return new Promise((ok, fail) => {
    const t = base.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => { base.close(); ok(req ? req.result : undefined); };
    t.onerror = () => { base.close(); fail(t.error); };
  });
}

/** This tool's recent entries, newest first. */
export async function listRecent(tool: string): Promise<RecentEntry[]> {
  if (!recentSupported) return [];
  try {
    const all = (await tx<RecentEntry[]>('readonly', (s) => s.getAll())) ?? [];
    return all.filter((e) => e.tool === tool).sort((a, b) => b.opened - a.opened);
  } catch {
    return [];
  }
}

async function sameEntry(a: RecentEntry, kind: RecentKind, handles: FileSystemHandle[]): Promise<boolean> {
  if (a.kind !== kind || a.handles.length !== handles.length) return false;
  for (let i = 0; i < handles.length; i++) if (!(await a.handles[i]!.isSameEntry(handles[i]!))) return false;
  return true;
}

/** Remember an opened folder or file set (moves it to the top when already listed). */
export async function addRecent(tool: string, kind: RecentKind, name: string, handles: FileSystemHandle[]): Promise<void> {
  if (!recentSupported || !handles.length) return;
  try {
    const list = await listRecent(tool);
    const same: RecentEntry[] = [];
    for (const e of list) if (await sameEntry(e, kind, handles)) same.push(e);
    const keep = list.filter((e) => !same.includes(e));
    const entry: RecentEntry = { id: same[0]?.id ?? crypto.randomUUID(), tool, kind, name, handles, opened: Date.now() };
    await tx('readwrite', (s) => {
      for (const e of same.slice(1)) s.delete(e.id);
      for (const e of keep.slice(MAX - 1)) s.delete(e.id);
      s.put(entry);
    });
  } catch {
    // Remembering is a convenience: a failure (private window, quota) must not break opening.
  }
}

export async function removeRecent(id: string): Promise<void> {
  await tx('readwrite', (s) => { s.delete(id); }).catch(() => undefined);
}

export async function clearRecent(tool: string): Promise<void> {
  const list = await listRecent(tool);
  await tx('readwrite', (s) => { for (const e of list) s.delete(e.id); }).catch(() => undefined);
}

/** Ask for read access again (the browser shows a prompt). False when refused. */
export async function grantRead(handles: FileSystemHandle[]): Promise<boolean> {
  for (const h of handles as PermissionHandle[]) {
    if ((await h.queryPermission?.({ mode: 'read' })) === 'granted') continue;
    if ((await h.requestPermission?.({ mode: 'read' })) !== 'granted') return false;
  }
  return true;
}

/** Every file under a folder handle, with its path inside the folder. `skip` tests that path. */
export async function readFolder(dir: FileSystemDirectoryHandle, skip?: RegExp): Promise<[string, File][]> {
  const out: [string, File][] = [];
  const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const child of (handle as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      const path = `${prefix}${child.name}`;
      if (skip?.test(path)) continue;
      if (child.kind === 'directory') await walk(child as FileSystemDirectoryHandle, `${path}/`);
      else out.push([path, await (child as FileSystemFileHandle).getFile()]);
    }
  };
  await walk(dir, '');
  return out;
}

/** Folder picker; null when cancelled. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (window as Picker).showDirectoryPicker!({ mode: 'read' });
  } catch {
    return null;
  }
}

/** Multi-file picker; empty when cancelled. */
export async function pickFiles(): Promise<FileSystemFileHandle[]> {
  try {
    return await (window as Picker).showOpenFilePicker!({ multiple: true });
  } catch {
    return [];
  }
}

/**
 * Handles of dropped items. Call it synchronously inside the drop handler (the items go away after it);
 * the promise resolves later.
 */
export function droppedHandles(transfer: DataTransfer | null): Promise<FileSystemHandle[]> {
  if (!recentSupported || !transfer) return Promise.resolve([]);
  const pending = [...transfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.());
  return Promise.all(pending).then((list) => list.filter((h): h is FileSystemHandle => !!h)).catch(() => []);
}

/** A display name for a file set: the skeleton's name when there is a .json, else the first file. */
export function filesName(names: string[]): string {
  const main = names.find((n) => /\.(json|tbla)$/i.test(n)) ?? names[0] ?? 'Files';
  return names.length > 1 ? `${main} +${names.length - 1}` : main;
}

function ago(time: number): string {
  const min = Math.round((Date.now() - time) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(time).toLocaleDateString();
}

const ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  files: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
};

export interface RecentListItem {
  key: string;
  kind: RecentKind;
  name: string;
  /** Second line: a path, or when it was opened. */
  detail: string;
}

/** Rows for a recent list (start card), each with an open button and a remove (×) button. */
export function renderRecentList(list: HTMLElement, items: RecentListItem[], open: (key: string) => void, remove: (key: string) => void): void {
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-open';
    button.title = item.detail;
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[item.kind]}</svg><span class="recent-name"></span><span class="recent-detail"></span>`;
    button.querySelector('.recent-name')!.textContent = item.name;
    button.querySelector('.recent-detail')!.textContent = item.detail;
    button.onclick = () => open(item.key);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'recent-remove';
    x.title = 'Remove from recent';
    x.setAttribute('aria-label', `Remove ${item.name} from recent`);
    x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    x.onclick = () => remove(item.key);
    li.append(button, x);
    return li;
  }));
}

/** List items for handle entries. */
export function recentItems(entries: RecentEntry[]): RecentListItem[] {
  return entries.map((e) => ({ key: e.id, kind: e.kind, name: e.name, detail: ago(e.opened) }));
}

/** "More" menu rows: one button per entry, under a small heading; empty when there are none. */
export function renderRecentMenu(host: HTMLElement, items: RecentListItem[], open: (key: string) => void, clear: () => void): void {
  host.replaceChildren();
  host.hidden = !items.length;
  if (!items.length) return;
  const heading = document.createElement('div');
  heading.className = 'menu-heading';
  heading.textContent = 'Open recent';
  host.append(heading);
  for (const item of items.slice(0, 5)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.title = item.detail;
    b.innerHTML = `<span class="menu-recent"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[item.kind]}</svg><span></span></span>`;
    b.querySelector('.menu-recent > span')!.textContent = item.name;
    b.onclick = () => open(item.key);
    host.append(b);
  }
  const c = document.createElement('button');
  c.type = 'button';
  c.setAttribute('role', 'menuitem');
  c.className = 'menu-muted';
  c.textContent = 'Clear recent';
  c.onclick = clear;
  host.append(c, document.createElement('hr'));
}
