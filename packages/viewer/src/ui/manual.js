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

function renderManualBody() {
  const modClick = isMac ? '⌘-click' : 'Ctrl+click';
  const modShift = (k) => chord(k, { shift: true });
  return `
    <section class="manual-section manual-block">
      <h3 class="manual-section-title">Stage &amp; selection</h3>
      <table class="manual-table">
        ${row('Scroll wheel', 'Zoom toward cursor')}
        ${row('Drag empty canvas', 'Marquee-select instances fully inside the box')}
        ${row('Click empty canvas', 'Clear selection (unless marquee)')}
        ${row(modClick, 'Add or remove instance from selection')}
        ${row('Shift / ⌘ / Ctrl + marquee', 'Add fully-inside instances to selection')}
        ${row('Drag instance', 'Move selection; other selected instances move together')}
        ${row('Space + drag', 'Pan stage')}
        ${row('Middle mouse + drag', 'Pan stage')}
        ${row('Double-click instance', 'Select and focus scene list')}
        ${row('Shift while dragging', 'Temporarily flip instance snap and grid snap')}
        ${row('[ ]', 'Send selection backward / forward in z-order')}
        ${row(chord('Z'), 'Undo')}
        ${row(modShift('Z') + ' / ' + chord('Y'), 'Redo')}
        ${row('Click mesh / region', 'Select that slot on the hit instance')}
      </table>
    </section>
    <section class="manual-section manual-block">
      <h3 class="manual-section-title">Scene list &amp; transport</h3>
      <table class="manual-table">
        ${row(chord('C'), 'Duplicate selected instance(s)')}
        ${row(chord('H'), 'Hide or show selected instance(s)')}
        ${row(modShift('L'), 'Lock or unlock selected instance(s)')}
        ${row(modShift('A'), 'Toggle “global animations on” for selection')}
        ${row('Delete / Backspace', 'Delete selected instance(s)')}
        ${row('↑ ↓', 'Move focus in the active panel (scene, slots, bones, animations)')}
        ${row('← →', 'Scrub transport when an animation is active')}
        ${row('Drag scene row', 'Reorder draw order (z-index)')}
        ${row('Right-click name', 'Copy instance or skin name')}
        ${row('Double-click scene name', 'Rename instance')}
      </table>
      <p class="manual-note">With nothing selected, Play / Pause / Setup pose and the seek bar apply to the whole stage (respecting per-instance “global animations on”). With a selection, transport targets only those instances.</p>
    </section>
    <section class="manual-section manual-block">
      <h3 class="manual-section-title">Slots &amp; bones</h3>
      <table class="manual-table">
        ${row('H (Slots panel focused)', 'Toggle hide on the highlighted slot')}
        ${row('Pulse / mask buttons', 'Slot tint plus filled outline on the selected slot')}
      </table>
    </section>
    <section class="manual-section manual-block">
      <h3 class="manual-section-title">Asset health</h3>
      <ul class="manual-list">
        <li><strong>Inspect</strong> — One selected skeleton: export + runtime report (JSON exports only for full scan).</li>
        <li><strong>♥ Asset health</strong> (stage toolbar, right) — Full list; hover column headers for meanings.</li>
        <li><strong>Score chip</strong> — Left of each scene name; opens that asset’s report. Hover issues in the modal for fix hints.</li>
        <li><strong>Hide all / Show all</strong> — Visibility for every skeleton on stage.</li>
      </ul>
    </section>
    <section class="manual-section manual-block">
      <h3 class="manual-section-title">Transform (inspector)</h3>
      <p class="manual-note">Fit, Center, Stop, and Reset use the current selection when any instance is selected; otherwise they apply to every instance on the stage. Reset restores the asset baseline (transform, skins, tracks, visibility) from when it was added or the scene was loaded. X / Y / Rot / SX / SY edit the same scope.</p>
    </section>
    <section class="manual-section manual-block">
      <h3 class="manual-section-title">Animations panel</h3>
      <ul class="manual-list">
        <li><strong>Speed</strong> — With no selection, adjusts speed for all instances; with selection, only those instances.</li>
        <li><strong>Loop</strong> — Per-instance loop for the active track (disabled when multiple skeletons are selected).</li>
        <li><strong>Apply globally</strong> — When checked, picking an animation applies it to every instance (still respects “global animations on”).</li>
        <li><strong>Global animations on</strong> — At the bottom of the panel (also ${modShift('A')} on selection). When off, stage Play skips that skeleton unless you pick an animation for it directly.</li>
        <li>Filter fields on Slots, Skins, Bones, and Animations live in the card header and hide non-matching rows. Arrow keys walk the filtered list.</li>
        <li>Multi-select disables track tabs and the animation list; speed, loop, apply-global, and stage toggle still work on the selection or whole stage.</li>
      </ul>
    </section>
    <section class="manual-section manual-block">
      <h3 class="manual-section-title">Menu &amp; other</h3>
      <ul class="manual-list">
        <li><strong>New scene</strong> — Clears the stage.</li>
        <li><strong>Snap on/off</strong> — Edge and center snapping while dragging instances (Shift inverts while dragging).</li>
        <li><strong>Grid</strong> — World-unit grid overlay; origin snaps to the grid. Size is 8 / 16 / 32 / 64. Shift also flips grid while dragging. Instance AABB snap runs first, then grid.</li>
        <li><strong>Debug</strong> — Scene card button. Bones, meshes, clipping, regions, paths, bounding boxes and events; IK lines and physics gizmos are extra.</li>
        <li><strong>Open / Save scene</strong> — JSON layout plus separate skeleton files on open.</li>
        <li><strong>Clear all assets</strong> — Wipes the saved stage, files, and UI prefs in this browser and reloads as a first visit.</li>
        <li><strong>Reload / reopen</strong> — Dropped images and skeletons are not kept after reload or closing the tab. Drop the files again to continue.</li>
        <li><strong>Screen size</strong> — Gold frame on stage; Center actions align to this frame’s center.</li>
        <li><strong>Performance → Selected</strong> — Toggle metrics for selection vs entire stage.</li>
        <li><strong>Scene Hide</strong> — Hide or show every skeleton at once.</li>
        <li>Drop files on the page to import skeletons, atlases, and images, or a Tabula export: a <code>.tbla</code> file, or <code>assets.manifest.json</code> together with its <code>.tbla</code> bundles (or loose files). An export with several skeletons asks which ones to add.</li>
      </ul>
    </section>
  `;
}

export function bindManual() {
  const modal = document.getElementById('manual-modal');
  const body = document.getElementById('manual-body');
  const openBtn = document.getElementById('btn-manual');
  const closeBtn = document.getElementById('manual-close');
  if (!modal || !body) {
    return { open: () => {}, close: () => {} };
  }

  body.innerHTML = renderManualBody();

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
