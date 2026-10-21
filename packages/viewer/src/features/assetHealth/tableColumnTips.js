/** @typedef {{ label: string, tip: string }} HealthColumnTip */

/** @type {HealthColumnTip[]} */
export const HEALTH_LIST_COLUMNS = [
  {
    label: 'Score',
    tip: 'Overall health 0–100. Mix of runtime sampling (60%) and export lint (40%). Lower is worse.',
  },
  {
    label: 'Asset',
    tip: 'Skeleton instance on stage. Click a row to open the full report.',
  },
  {
    label: 'Runtime',
    tip: 'Worst animation sample: bones, vertices, draw calls, clipping, blends, constraints at playback poses.',
  },
  {
    label: 'Export',
    tip: 'JSON data quality: key rates, deform/attachment density, atlas VRAM estimate, skeleton size.',
  },
  {
    label: 'Atlas',
    tip: 'Live marginal atlas VRAM for this skeleton (unique pages on stage, by file name + size).',
  },
  {
    label: 'Issues',
    tip: 'Count of failed and warning findings from the last scan.',
  },
];

/** @type {HealthColumnTip[]} */
export const HEALTH_ANIM_COLUMNS = [
  {
    label: 'Name',
    tip: 'Animation name from the skeleton data.',
  },
  {
    label: 'Duration',
    tip: 'Runtime clip length in seconds. Zero-length clips skip runtime sampling.',
  },
  {
    label: 'Score',
    tip: 'Runtime score from sampled poses (20 Hz). Hover a score for details. 50 on 0s clips = neutral (not sampled).',
  },
  {
    label: 'Hot DC',
    tip: 'Peak draw calls seen while stepping through this animation.',
  },
  {
    label: 'Verts',
    tip: 'Peak deformed/drawn vertices while sampling this animation.',
  },
  {
    label: 'Export',
    tip: 'Export lint for this clip. Hover the cell to see which warnings or failures apply.',
  },
];

/**
 * @param {HealthColumnTip} col
 */
export function renderHealthTh(col) {
  const tip = col.tip
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
  return `<th class="health-th-tip" data-tip="${tip}">${col.label}</th>`;
}
