/**
 * The tool rail and its docks, as in the Tabula Viewer (packages/viewer/src/ui/drawers.js):
 * a rail button shows its page in a dock; pressing the active one closes the dock.
 * Remembered in this browser.
 */

type Drawer = 'left' | 'right';

const STORAGE_KEY = 'tabula-exporter.drawers';
/** Active tool per dock; null means closed. */
const DEFAULTS: Record<Drawer, string | null> = { left: 'assets', right: 'settings' };
const HOSTS: Record<Drawer, string> = { left: 'left-dock', right: 'right-stack' };

const active = { ...DEFAULTS };

function load(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    for (const drawer of Object.keys(DEFAULTS) as Drawer[]) {
      const v = raw[drawer];
      if (v === null || typeof v === 'string') active[drawer] = v;
    }
  } catch {
    /* ignore */
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(active));
  } catch {
    /* ignore */
  }
}

function render(): void {
  for (const drawer of Object.keys(DEFAULTS) as Drawer[]) {
    const host = document.getElementById(HOSTS[drawer]);
    if (!host) continue;
    const tool = active[drawer];
    const pages = host.querySelectorAll<HTMLElement>('.drawer-page');
    // A dock without pages (Assets) is one tool: open or closed.
    if (pages.length && tool && ![...pages].some((p) => p.dataset.tool === tool)) active[drawer] = DEFAULTS[drawer];
    let title = '';
    for (const page of pages) {
      page.hidden = page.dataset.tool !== active[drawer];
      if (!page.hidden) title = page.dataset.title ?? '';
    }
    host.classList.toggle('is-closed', !active[drawer]);
    const heading = document.getElementById(`${drawer}-drawer-title`);
    if (heading && title) heading.textContent = title;
  }
  for (const button of document.querySelectorAll<HTMLElement>('.rail-tool')) {
    button.setAttribute('aria-pressed', String(active[button.dataset.drawer as Drawer] === button.dataset.tool));
  }
}

/** Open a dock on a tool (the export opens its report). */
export function showTool(drawer: Drawer, tool: string): void {
  active[drawer] = tool;
  save();
  render();
}

export function initDrawers(): void {
  load();
  for (const button of document.querySelectorAll<HTMLElement>('.rail-tool')) {
    button.onclick = () => {
      const drawer = button.dataset.drawer as Drawer;
      const tool = button.dataset.tool!;
      active[drawer] = active[drawer] === tool ? null : tool;
      save();
      render();
    };
  }
  render();
}
