import { MANUAL_TAB_STORAGE_KEY } from '../constants.js';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * @param {string} key
 * @param {{ shift?: boolean, alt?: boolean }} [mods]
 */
function chord(key, mods = {}) {
  const parts = [];
  if (isMac) {
    if (mods.alt) parts.push('⌥');
    if (mods.shift) parts.push('⇧');
    parts.push('⌘');
    parts.push(key);
    return parts.join('');
  }
  if (mods.alt) parts.push('Alt');
  if (mods.shift) parts.push('Shift');
  parts.push('Ctrl');
  parts.push(key);
  return parts.join('+');
}

/** @param {string} label @param {string} detail */
function row(label, detail) {
  return `<tr><th scope="row"><kbd class="manual-kbd">${label}</kbd></th><td>${detail}</td></tr>`;
}

const MANUAL_TAB_KEY = MANUAL_TAB_STORAGE_KEY;

/** @param {string} title @param {string} html */
function section(title, html) {
  return `<section class="manual-section manual-block"><h3 class="manual-section-title">${title}</h3>${html}</section>`;
}

/** @param {string[]} rows */
function table(rows) {
  return `<table class="manual-table">${rows.join('')}</table>`;
}

/** @param {string[]} items */
function list(items) {
  return `<ul class="manual-list">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

/** @returns {{ id: string, label: string, html: string }[]} */
function manualTabs() {
  const modClick = isMac ? '⌘-click' : 'Ctrl+click';
  const modShift = (k) => chord(k, { shift: true });
  return [
    {
      id: 'start',
      label: 'Start',
      html: section('Open skeletons', list([
        '<strong>Open</strong> (header) or drop files on the stage: a Spine skeleton (<code>.json</code>, <code>.atlas</code> and its page images), or a Tabula export: a <code>.tbla</code> file, or <code>assets.manifest.json</code> with its <code>.tbla</code> bundles or loose files. An export with several skeletons asks which ones to add.',
        '<strong>New</strong> clears the stage. <strong>Undo / Redo</strong> sit left of it.',
        'The <strong>⋯</strong> menu holds Load samples, this manual, <strong>Open scene</strong> / <strong>Save scene</strong> and Clear browser data.',
        '<strong>Save scene</strong> downloads the layout as <code>.json</code>: positions, skins, tracks, speed and camera, not the skeleton files. <strong>Open scene</strong> reads it, asks for the skeleton files, and places them as saved.',
        'Dropped files are not kept after a reload or closing the tab; drop them again to continue. <strong>Clear browser data</strong> also wipes UI prefs and reloads as a first visit.',
      ]))
        + section('Layout', list([
          '<strong>Tool rail</strong> (left): Outliner and Performance open in the side drawer; Animations opens the bottom drawer once a skeleton is selected.',
          '<strong>Stage toolbar</strong>: background, screen frame and zoom · Snap and Grid · Debug and Health.',
          'Drag a drawer edge to resize it; double-click the edge to reset.',
        ])),
    },
    {
      id: 'stage',
      label: 'Stage',
      html: section('Mouse', table([
        row('Scroll wheel', 'Zoom toward the cursor'),
        row('Space + drag / middle drag', 'Pan'),
        row('Click skeleton', 'Select it'),
        row(modClick, 'Add or remove a skeleton from the selection'),
        row('Drag empty stage', 'Box-select skeletons fully inside; Shift / ⌘ / Ctrl adds'),
        row('Click empty stage', 'Clear the selection and every slot, bone and attachment highlight'),
        row('Drag skeleton', 'Move the selection together'),
        row('Shift while dragging', 'Flip Snap and Grid for this drag'),
        row('Click mesh / region', 'Highlight that slot'),
        row('Double-click skeleton', 'Select it and show it in the Outliner'),
      ]))
        + section('Toolbar', list([
          '<strong>Background</strong>: dark, checker, light or a custom colour.',
          '<strong>Screen size</strong>: the frame drawn on the stage; Center places skeletons in it. Add your own sizes in its menu.',
          '<strong>Zoom</strong>: − and +; click the percentage to reset the view.',
          '<strong>Snap</strong> snaps edges and centres to other skeletons; <strong>Grid</strong> snaps origins to a world grid of 8–64 units. Snap runs first, then Grid.',
          '<strong>Debug</strong>: overlays for bones, IK, physics, regions, mesh hulls and triangles, clipping, paths, bounding boxes and events. “Selected assets only” limits them to the selection.',
        ])),
    },
    {
      id: 'outliner',
      label: 'Outliner',
      html: section('Tree', table([
        row('Asset ▸ Bones & slots ▸ bone ▸ slot ▸ attachment', 'One tree per skeleton, with Skins, Constraints, Events and Draw order beside it'),
        row('Click asset name', 'Select and open it, shutting the others; click again to drop its slot / bone'),
        row('Click bone', 'Mark it on the stage; live world values under the tree (read-only)'),
        row('Click slot', 'Highlight it on the stage until clicked again; Pulse and outline colour appear under the tree'),
        row('Click attachment', 'Highlight its slot; type, size, region and vertices under the tree. ● marks the one showing now'),
        row('◆ badge', 'Keyed in the playing animation'),
        row('Alt-click arrow', 'Open or shut a whole branch'),
        row('Alt-click eye', 'Show only this slot or bone branch; again shows everything'),
        row('Hover bone / slot', 'Faint mark on the stage'),
        row('Right-click row', 'Copy name, hide, show only, go to slot / bone / draw order'),
        row('Drag asset row', 'Change draw order (z-index)'),
        row('Double-click asset name', 'Rename'),
      ]))
        + section('Filters', list([
          'Type buttons show only bones, slots, attachments, constraints, events, draw order or hidden slots; Shift adds a type.',
          'The filter field keeps matching rows with their parents opened. Arrow keys walk the filtered rows.',
          '<strong>Hide all</strong> hides or shows every skeleton.',
        ])),
    },
    {
      id: 'animations',
      label: 'Animations',
      html: section('Drawer', list([
        'Pick an animation in the list to play it on the selected track. <strong>Play / Pause</strong> and frame stepping are in the timeline toolbar.',
        '<strong>Speed</strong> with <strong>Selected / All</strong>: Selected changes speed and mode on the selected skeleton; All changes every skeleton and copies the selected one’s speed and mode to the others.',
        '<strong>Mode</strong>: loop, once (holds the last frame), ping-pong or reverse. <strong>Mix</strong>: crossfade time between animations.',
        '<strong>Seconds / Frames</strong> and fps set the ruler and frame stepping. <strong>Keys</strong> shows every keyframe of the track (read-only); drag a row to scrub.',
        'With several skeletons selected the list and tracks are off; speed, mode and Selected / All still apply.',
      ])),
    },
    {
      id: 'panels',
      label: 'Panels',
      html: section('Transform', list([
        'Acts on the selection, or every skeleton when nothing is selected.',
        '<strong>Fit view</strong> moves the camera only · <strong>Center</strong> puts skeletons in the screen frame · <strong>Setup pose</strong> stops and shows the setup pose · <strong>Revert</strong> returns position, scale, skins, tracks and visibility to how they were when opened.',
        'X / Y / Rot / SX / SY edit the same scope. <strong>Bounds</strong> is the live size.',
      ]))
        + section('Performance', list([
          '<strong>Selected / All</strong>: measure the selection or the whole stage.',
          'FPS, estimated atlas VRAM, vertices, draw calls, bones, constraints, clipping and blend modes for the current pose.',
        ]))
        + section('Health', list([
          '<strong>Health</strong> (stage toolbar) opens the selected skeleton’s report, or every skeleton’s scores when none or several are selected. <strong>← All assets</strong> goes from a report to the list.',
          'The score chip by each asset name opens its report. Hover an issue for fix hints, and column headers for their meaning.',
        ])),
    },
    {
      id: 'keys',
      label: 'Shortcuts',
      html: section('Keyboard', table([
        row('?', 'This manual'),
        row(chord('Z'), 'Undo'),
        row(modShift('Z') + ' / ' + chord('Y'), 'Redo'),
        row(chord('C'), 'Duplicate selected skeletons'),
        row(chord('H'), 'Hide or show selected skeletons'),
        row(modShift('L'), 'Lock or unlock selected skeletons'),
        row(modShift('A'), 'Include or skip selected skeletons in global Play'),
        row('Delete / Backspace', 'Delete selected skeletons'),
        row('[ ]', 'Send selection backward / forward'),
        row('S', 'Flip the selected skeleton between its current and previous skin'),
        row('O', 'Show or hide the selection outline on the stage'),
        row('H (Outliner focused)', 'Hide or show the selected slot'),
        row('↑ ↓', 'Walk Outliner rows, or the animation list when focused'),
        row('← →', 'Previous / next frame; open or shut a branch when the Outliner has focus'),
        row('Home / End', 'Go to the start / end of the animation'),
        row('Esc', 'Close a dialog'),
      ])),
    },
  ];
}

export function bindManual() {
  const modal = document.getElementById('manual-modal');
  const body = document.getElementById('manual-body');
  const openBtn = document.getElementById('btn-manual');
  const closeBtn = document.getElementById('manual-close');
  if (!modal || !body) {
    return { open: () => {}, close: () => {} };
  }

  const tabs = manualTabs();
  const tabBar = document.getElementById('manual-tabs');
  /** @param {string} id */
  const show = (id) => {
    const tab = tabs.find((item) => item.id === id) || tabs[0];
    body.innerHTML = tab.html;
    body.scrollTop = 0;
    tabBar?.querySelectorAll('[role="tab"]').forEach((button) => {
      const on = /** @type {HTMLElement} */ (button).dataset.tab === tab.id;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
    });
    try { localStorage.setItem(MANUAL_TAB_KEY, tab.id); } catch { /* ignore */ }
  };
  if (tabBar) {
    tabBar.innerHTML = tabs.map((tab) => `<button type="button" role="tab" class="manual-tab" data-tab="${tab.id}">${tab.label}</button>`).join('');
    tabBar.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-tab]') : null;
      if (button) show(/** @type {HTMLElement} */ (button).dataset.tab || '');
    });
    // Left / right walk the tabs, as in any tab list.
    tabBar.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      const buttons = [...tabBar.querySelectorAll('[role="tab"]')];
      const at = buttons.findIndex((button) => button.getAttribute('aria-selected') === 'true');
      const next = /** @type {HTMLElement} */ (buttons[(at + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]);
      show(next.dataset.tab || '');
      next.focus();
    });
  }
  let saved = '';
  try { saved = localStorage.getItem(MANUAL_TAB_KEY) || ''; } catch { /* ignore */ }
  show(saved);

  const open = () => {
    modal.hidden = false;
    closeBtn?.focus();
  };
  const close = () => {
    modal.hidden = true;
  };

  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  window.addEventListener('keydown', (event) => {
    if (!modal.hidden && event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  return { open, close };
}
