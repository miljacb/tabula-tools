/**
 * A checklist dialog for the Tabula tools: pick which skeletons of a large drop or folder to open.
 * Filter box, All / None (on what the filter shows), a checkbox per item and a selected count.
 * Styles in chrome.css ("Chooser").
 */

export interface ChooserItem {
  /** Key returned when picked. */
  name: string;
  /** Shown instead of the name (e.g. without folder and extension). */
  label?: string;
  /** Small text on the right (folder, format, size). */
  meta?: string;
}

export interface ChooserOptions {
  title: string;
  /** Line under the title. */
  label?: string;
  items: ChooserItem[];
  /** Ticked at the start. Default: every item when there are at most 12, else none. */
  picked?: Iterable<string>;
  /** Text of the confirm button. */
  action?: string;
}

/** A size for the item's meta, the same in every tool ("12 KB", "4.4 MB"). */
export const sizeLabel = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Items ticked at the start when no `picked` is given: all of a small list, none of a large one. */
export const PICK_ALL_UP_TO = 12;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};

/** Every word of the filter appears in the name (case-insensitive). */
function matches(name: string, filter: string): boolean {
  const lower = name.toLowerCase();
  return filter.toLowerCase().split(/\s+/).filter(Boolean).every((word) => lower.includes(word));
}

/** Show the chooser; resolves with the picked names in list order, or null when cancelled. */
export function chooseItems(options: ChooserOptions): Promise<string[] | null> {
  // A to Z, numbers in order (symbol2 before symbol10), whatever order the drop or folder gave.
  const text = (i: ChooserItem): string => i.label ?? i.name;
  const items = [...options.items].sort((a, b) => text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' }));
  const picked = new Set(options.picked ?? (items.length <= PICK_ALL_UP_TO ? items.map((i) => i.name) : []));

  const backdrop = el('div', 'chooser-backdrop');
  const form = el('form', 'chooser');
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'true');
  form.setAttribute('aria-label', options.title);
  const title = el('h2', '', options.title);
  const label = options.label ? el('p', 'chooser-label', options.label) : null;
  const filter = el('input');
  Object.assign(filter, { type: 'search', placeholder: 'Filter', autocomplete: 'off', spellcheck: false });
  filter.setAttribute('aria-label', 'Filter');
  const all = el('button', '', 'All');
  const none = el('button', '', 'None');
  all.type = none.type = 'button';
  all.title = 'Tick everything the filter shows';
  none.title = 'Untick everything the filter shows';
  const list = el('div', 'chooser-list');
  const count = el('span', 'chooser-count');
  const cancel = el('button', '', 'Cancel');
  cancel.type = 'button';
  const ok = el('button', 'primary', options.action ?? 'Open');
  ok.type = 'submit';
  form.append(title, ...(label ? [label] : []), el('div', 'chooser-tools'), list, el('div', 'chooser-actions'));
  form.querySelector('.chooser-tools')!.append(filter, all, none);
  form.querySelector('.chooser-actions')!.append(count, cancel, ok);
  backdrop.append(form);

  const visible = (): ChooserItem[] => items.filter((i) => matches(`${text(i)} ${i.meta ?? ''}`, filter.value));
  const refresh = (): void => {
    count.textContent = `${picked.size} of ${items.length} selected`;
    ok.disabled = picked.size === 0;
  };
  const render = (): void => {
    const shown = visible();
    list.replaceChildren(...shown.map((item) => {
      const row = el('label', 'chooser-item');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = picked.has(item.name);
      box.onchange = () => {
        if (box.checked) picked.add(item.name);
        else picked.delete(item.name);
        refresh();
      };
      const name = el('span', 'chooser-name', text(item));
      name.title = item.name;
      row.append(box, name, ...(item.meta ? [el('small', '', item.meta)] : []));
      return row;
    }));
    if (!shown.length) list.append(el('p', 'chooser-empty', 'Nothing matches the filter.'));
    refresh();
  };
  filter.oninput = render;
  all.onclick = () => {
    for (const i of visible()) picked.add(i.name);
    render();
  };
  none.onclick = () => {
    for (const i of visible()) picked.delete(i.name);
    render();
  };

  return new Promise((resolve) => {
    const done = (value: string[] | null): void => {
      backdrop.remove();
      resolve(value);
    };
    cancel.onclick = () => done(null);
    backdrop.onmousedown = (e) => {
      if (e.target === backdrop) done(null);
    };
    form.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      }
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      if (picked.size) done(items.map((i) => i.name).filter((n) => picked.has(n)));
    };
    render();
    document.body.append(backdrop);
    filter.focus();
  });
}
