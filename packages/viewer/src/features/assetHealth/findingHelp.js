/** @typedef {import('./types.js').HealthFinding} HealthFinding */

/** @type {Record<string, { what: string, fix: string }>} */
const BY_ID = {
  'export-no-anims': {
    what: 'The skeleton JSON has no animations section.',
    fix: 'Export with animations from Spine, or confirm this is intentional for a static prop.',
  },
  'export-empty-anims': {
    what: 'Animations object exists but contains no clips.',
    fix: 'Add animations in Spine or remove unused animation tracks before export.',
  },
  'export-bones-high': {
    what: 'Bone count is high for real-time games.',
    fix: 'Merge cosmetic bones, use meshes instead of extra bones where possible, split into multiple skeletons.',
  },
  'export-slots-high': {
    what: 'Many draw slots increase batching and memory metadata.',
    fix: 'Combine attachments, remove unused slots, prefer mesh regions over many small regions.',
  },
  'export-atlas-shared': {
    what: 'This skeleton reuses atlas pages already on the stage.',
    fix: 'No action needed — marginal VRAM is low. Duplicate instances instead of re-importing the same files.',
  },
  'export-atlas-vram-fail': {
    what: 'Estimated decoded atlas VRAM is very large for this scope.',
    fix: 'Reduce texture size, use fewer atlas pages, enable texture packing, or split characters across atlases.',
  },
  'export-atlas-vram-warn': {
    what: 'Estimated atlas VRAM is elevated.',
    fix: 'Downscale pages, tighten packing, or move rarely used skins to a second atlas.',
  },
  'export-atlas-ok': {
    what: 'Atlas page sizes look reasonable for the estimate.',
    fix: 'Keep monitoring when adding more skeletons that share the same WebP files.',
  },
  'runtime-bones': {
    what: 'Many bones affect CPU pose solving each frame.',
    fix: 'Reduce bone count, disable unnecessary constraints, simplify skeleton hierarchy.',
  },
  'runtime-verts': {
    what: 'High mesh vertex count at the measured pose.',
    fix: 'Lower mesh resolution, reduce weighted meshes, avoid unnecessary mesh attachments.',
  },
  'runtime-verts-warn': {
    what: 'Vertex count is elevated at the measured pose.',
    fix: 'Simplify meshes on moving attachments; check deforms and mesh density.',
  },
  'runtime-drawcalls': {
    what: 'Many texture/blend batches at the measured pose.',
    fix: 'Atlas pack to keep attachments on fewer pages; reduce blend-mode changes; avoid excessive draw-order keys.',
  },
  'runtime-drawcalls-warn': {
    what: 'Draw call count is elevated.',
    fix: 'Reorder slots to batch by texture; combine small regions; limit additive/screen layers.',
  },
  'runtime-clip': {
    what: 'Clipping attachments are expensive on GPU.',
    fix: 'Use clipping sparingly; prefer masked art in the atlas; reduce clipping mesh complexity.',
  },
  'runtime-blend': {
    what: 'Multiple blend modes break batching.',
    fix: 'Standardize on Normal where possible; batch additive effects on dedicated atlases.',
  },
  'runtime-constraints': {
    what: 'IK, path, transform, or physics constraints add CPU cost.',
    fix: 'Remove unused constraints; bake motion to keys where acceptable; simplify IK chains.',
  },
  'scan-error': {
    what: 'The scanner threw an error while sampling this asset.',
    fix: 'Re-scan after reload; check browser console; verify the export is Spine 4.1 or 4.2 JSON.',
  },
};

/** @type {Record<string, { what: string, fix: string }>} */
const BY_PREFIX = [
  { prefix: 'export-kps-', what: 'Bone/slot key rate is high for animation length — more CPU to evaluate curves.', fix: 'Remove redundant keys in Spine, bake subtle motion, shorten animation, or reduce keyed properties.' },
  { prefix: 'export-deform-', what: 'Many mesh deform keys increase export size and runtime cost.', fix: 'Simplify meshes, reduce deform keys, or bake deform to fewer keys.' },
  { prefix: 'export-attach-', what: 'Frequent attachment swaps during the clip.', fix: 'Use fewer attachment keys; prefer mesh swaps only when needed; combine static pieces.' },
  { prefix: 'export-draworder-', what: 'Draw order keys force batch breaks every change.', fix: 'Minimize draw order animation; reorder slots in setup pose instead.' },
  { prefix: 'export-anim-missing-', what: 'Runtime animation not found in JSON data.', fix: 'Re-export skeleton; ensure animation names match between runtime and JSON.' },
];

/** @type {Record<string, { what: string, fix: string }>} */
const BY_CATEGORY = {
  'export.animations': {
    what: 'Animation data density or structure may hurt load time and runtime.',
    fix: 'Clean keys in Spine Timeline; avoid over-keying; use mesh deform only where visible.',
  },
  'export.skeleton': {
    what: 'Skeleton structure size (bones, slots) affects memory and pose cost.',
    fix: 'Prune unused bones/slots in Spine before export.',
  },
  'export.atlas': {
    what: 'Atlas images dominate GPU memory once decoded.',
    fix: 'Smaller textures, tighter packing, shared atlases across characters.',
  },
  'runtime.bones': {
    what: 'Bone count drives pose update cost.',
    fix: 'Simplify rig; merge static decoration into meshes.',
  },
  'runtime.vertices': {
    what: 'Visible mesh vertices at sampled poses.',
    fix: 'Reduce mesh detail; limit weighted vertices per mesh.',
  },
  'runtime.drawcalls': {
    what: 'Separate draw batches from textures or blend modes.',
    fix: 'Pack atlas; align slot order with texture pages.',
  },
  'runtime.clipping': {
    what: 'Stencil clipping adds GPU overhead.',
    fix: 'Pre-cut art in Photoshop/Spine instead of live clipping where possible.',
  },
  'runtime.blends': {
    what: 'Non-normal blend modes prevent batching.',
    fix: 'Isolate additive/screen slots and atlas pages.',
  },
  'runtime.constraints': {
    what: 'Constraints solve each frame after bones.',
    fix: 'Delete unused IK/path; reduce chain length.',
  },
  'export.meta': {
    what: 'Metadata about the scan itself.',
    fix: 'Follow the detail line; re-scan or change export format if needed.',
  },
};

/**
 * @param {HealthFinding} finding
 */
export function findingHelpText(finding) {
  const direct = BY_ID[finding.id];
  if (direct) {
    return `${direct.what}\n\nUsually fixed: ${direct.fix}`;
  }
  for (const row of BY_PREFIX) {
    if (finding.id.startsWith(row.prefix)) {
      return `${row.what}\n\nUsually fixed: ${row.fix}`;
    }
  }
  const cat = BY_CATEGORY[finding.category];
  if (cat) {
    return `${cat.what}\n\nUsually fixed: ${cat.fix}\n\n(${finding.detail})`;
  }
  return `${finding.detail}`;
}

/**
 * @param {number | null | undefined} score
 */
export function healthScoreHue(score) {
  if (score == null || Number.isNaN(score)) return 0;
  const s = Math.max(0, Math.min(100, score));
  return (s / 100) * 120;
}

/**
 * @param {number | null | undefined} score
 */
export function applyHealthScoreChipStyle(el, score) {
  if (!el) return;
  el.classList.remove('is-unknown');
  if (score == null || Number.isNaN(score)) {
    el.style.removeProperty('--health-hue');
    el.classList.add('is-unknown');
    return;
  }
  el.style.setProperty('--health-hue', String(healthScoreHue(score)));
}
