import { activeBudgetLabel, activeLimits, budgetLevel, BUDGET_PRESETS, getBudget, setBudget } from '../features/budgets.js';
import { formatMb } from '../features/perfDisplay.js';

/**
 * Performance panel extras: budgets, stutter markers, recording.
 * The panel itself (bindUi.refreshPerf) feeds these each frame and reads them back.
 */

const WINDOW_MS = 10000;
const RECORD_MAX_MS = 60000;

// ── Stutters ─────────────────────────────────────────────

/** @typedef {{ t: number, ms: number, cause: string, context: string }} Stutter */

/** @type {Stutter[]} */
const stutters = [];
/** @type {number | null} */
let lastGpuTextures = null;

/**
 * Classify the frame that just ended. A stutter is a frame longer than twice the display's frame time.
 * @param {{ deltaMs: number, updateMs: number, renderMs: number, gpuTextures: number | null, longTasks: { t: number, ms: number }[] }} frame
 * @param {number} hz display refresh rate
 * @param {string} context what was playing, for the list
 * @returns {Stutter | null}
 */
export function trackStutter(frame, hz, context) {
  const now = performance.now();
  const uploaded = lastGpuTextures != null && frame.gpuTextures != null && frame.gpuTextures > lastGpuTextures;
  if (frame.gpuTextures != null) lastGpuTextures = frame.gpuTextures;
  while (stutters.length && stutters[0].t < now - WINDOW_MS) stutters.shift();

  const budget = 1000 / hz;
  if (!(frame.deltaMs > budget * 2)) return null;
  const longTask = frame.longTasks.reduce((max, task) => Math.max(max, task.ms), 0);
  let cause;
  if (uploaded) cause = 'texture upload';
  else if (longTask) cause = `long task ${Math.round(longTask)} ms`;
  else if (frame.updateMs > budget) cause = `update ${frame.updateMs.toFixed(1)} ms`;
  else if (frame.renderMs > budget) cause = `render ${frame.renderMs.toFixed(1)} ms`;
  else cause = 'browser / GPU (no CPU work in this page)';
  const entry = { t: now, ms: frame.deltaMs, cause, context };
  stutters.push(entry);
  return entry;
}

export function recentStutters() {
  return stutters;
}

// ── Budgets ──────────────────────────────────────────────

/**
 * @param {{ budget?: unknown }} ui persisted UI state
 * @param {() => void} save
 * @param {() => void} onChange
 */
export function bindBudget(ui, save, onChange) {
  setBudget(/** @type {any} */ (ui.budget));
  const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('perf-budget'));
  const custom = document.getElementById('perf-budget-custom');
  if (!select || !custom) return;
  select.innerHTML = [
    '<option value="off">Off</option>',
    ...Object.entries(BUDGET_PRESETS).map(([key, p]) => `<option value="${key}">${p.label}</option>`),
    '<option value="custom">Custom</option>',
  ].join('');

  const sync = () => {
    const state = getBudget();
    select.value = state.preset;
    custom.hidden = state.preset !== 'custom';
    custom.querySelectorAll('input[data-budget]').forEach((input) => {
      const key = /** @type {HTMLInputElement} */ (input).dataset.budget;
      /** @type {HTMLInputElement} */ (input).value = String(Math.round(state.custom[key] * 10) / 10);
    });
  };
  const commit = (/** @type {Partial<{ preset: string, custom: any }>} */ next) => {
    const state = setBudget({ ...getBudget(), ...next });
    ui.budget = state;
    save();
    sync();
    onChange();
  };
  select.addEventListener('change', () => commit({ preset: select.value }));
  custom.addEventListener('change', (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    const key = input.dataset.budget;
    if (!key) return;
    commit({ custom: { ...getBudget().custom, [key]: Number(input.value) } });
  });
  sync();
}

/**
 * Budget rows (value / limit with a bar) and a level class on the matching panel values.
 * @param {{ frameMs: number | null, drawCalls: number | null, vertices: number | null, vramBytes: number | null }} stage
 */
export function renderBudget(stage) {
  const host = document.getElementById('perf-budget-rows');
  const limits = activeLimits();
  /** @type {[string, string, number | null, number | undefined, (v: number) => string][]} */
  const rows = [
    ['Frame time', 'perf-frame-time', stage.frameMs, limits?.frameMs, (v) => `${v.toFixed(1)} ms`],
    ['Draw calls', 'perf-live-dc', stage.drawCalls, limits?.drawCalls, (v) => String(Math.round(v))],
    ['Vertices', 'perf-live-verts', stage.vertices, limits?.vertices, (v) => Math.round(v).toLocaleString('en-US')],
    ['Atlas VRAM', null, stage.vramBytes == null ? null : stage.vramBytes / (1024 * 1024), limits?.vramMb, (v) => `${v.toFixed(1)} MB`],
  ];
  for (const [, id, value, limit] of rows) {
    if (!id) continue;
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.remove('is-near', 'is-over');
    if (limits && value != null && limit) {
      const level = budgetLevel(value, limit);
      if (level !== 'ok') el.classList.add(`is-${level}`);
    }
  }
  if (!host) return;
  if (!limits) {
    host.innerHTML = '<p class="perf-hint">Off. Pick a target to compare the stage against limits.</p>';
    return;
  }
  host.innerHTML = rows.map(([label, , value, limit, fmt]) => {
    if (value == null || !limit) return '';
    const level = budgetLevel(value, limit);
    const pct = Math.min(100, (value / limit) * 100);
    return `<div class="perf-budget-row is-${level}">
      <span class="perf-label">${label}:</span>
      <span class="perf-budget-bar"><span style="width: ${pct}%"></span></span>
      <span class="perf-budget-value">${fmt(value)} / ${fmt(limit)}</span>
    </div>`;
  }).join('') + `<p class="perf-hint">${activeBudgetLabel()} · frame time is the 10 s average · whole stage.</p>`;
}

// ── Recording ────────────────────────────────────────────

/** @typedef {{ t: number, frameMs: number, updateMs: number, renderMs: number, drawCalls: number, vertices: number, triangles: number, stutter: string, heapMb: number | null, playing: string }} RecordedFrame */

const recording = {
  active: false,
  start: 0,
  /** @type {RecordedFrame[]} */
  frames: [],
  /** @type {Record<string, unknown> | null} */
  meta: null,
};

export function isRecording() {
  return recording.active;
}

/** @param {() => Record<string, unknown>} describeScene */
export function bindRecorder(describeScene) {
  const button = document.getElementById('perf-record');
  const json = /** @type {HTMLButtonElement | null} */ (document.getElementById('perf-export-json'));
  const csv = /** @type {HTMLButtonElement | null} */ (document.getElementById('perf-export-csv'));
  button?.addEventListener('click', () => {
    if (recording.active) stopRecording(describeScene);
    else {
      recording.active = true;
      recording.start = performance.now();
      recording.frames = [];
      recording.meta = null;
      button.textContent = 'Stop';
      button.classList.add('is-recording');
      if (json) json.disabled = true;
      if (csv) csv.disabled = true;
    }
  });
  json?.addEventListener('click', () => download('tabula-perf.json', 'application/json', JSON.stringify({ ...recording.meta, frames: recording.frames }, null, 2)));
  csv?.addEventListener('click', () => download('tabula-perf.csv', 'text/csv', toCsv(recording.frames)));
}

/** @param {() => Record<string, unknown>} describeScene */
function stopRecording(describeScene) {
  recording.active = false;
  const frames = recording.frames;
  const ms = frames.map((f) => f.frameMs);
  const sorted = [...ms].sort((a, b) => b - a);
  const slow = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 100)));
  recording.meta = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    durationMs: frames.length ? frames[frames.length - 1].t : 0,
    summary: frames.length ? {
      frames: frames.length,
      avgFrameMs: ms.reduce((a, b) => a + b, 0) / ms.length,
      worstFrameMs: sorted[0],
      onePercentLowFps: 1000 / (slow.reduce((a, b) => a + b, 0) / slow.length),
      stutters: frames.filter((f) => f.stutter).length,
      peakDrawCalls: Math.max(...frames.map((f) => f.drawCalls)),
      peakVertices: Math.max(...frames.map((f) => f.vertices)),
    } : null,
    budget: { target: activeBudgetLabel() || 'off', limits: activeLimits() },
    scene: describeScene(),
  };
  const button = document.getElementById('perf-record');
  if (button) {
    button.textContent = 'Record';
    button.classList.remove('is-recording');
  }
  const json = /** @type {HTMLButtonElement | null} */ (document.getElementById('perf-export-json'));
  const csv = /** @type {HTMLButtonElement | null} */ (document.getElementById('perf-export-csv'));
  if (json) json.disabled = !frames.length;
  if (csv) csv.disabled = !frames.length;
  setStatus(frames.length
    ? `Recorded ${frames.length} frames over ${(recording.meta.durationMs / 1000).toFixed(1)} s. Export to keep it.`
    : 'Nothing recorded.');
}

/**
 * @param {Omit<RecordedFrame, 't'>} frame
 * @param {() => Record<string, unknown>} describeScene
 */
export function recordFrame(frame, describeScene) {
  if (!recording.active) return;
  const t = performance.now() - recording.start;
  recording.frames.push({ t: Math.round(t * 10) / 10, ...frame });
  if (t >= RECORD_MAX_MS) stopRecording(describeScene);
  else if (recording.frames.length % 15 === 0) setStatus(`Recording… ${(t / 1000).toFixed(1)} s, ${recording.frames.length} frames (stops at 60 s).`);
}

/** @param {string} text */
function setStatus(text) {
  const el = document.getElementById('perf-record-status');
  if (el) el.textContent = text;
}

/** @param {RecordedFrame[]} frames */
export function toCsv(frames) {
  const cols = /** @type {(keyof RecordedFrame)[]} */ (['t', 'frameMs', 'updateMs', 'renderMs', 'drawCalls', 'vertices', 'triangles', 'heapMb', 'stutter', 'playing']);
  const cell = (v) => {
    if (v == null) return '';
    const text = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [cols.join(','), ...frames.map((f) => cols.map((c) => cell(f[c])).join(','))].join('\n');
}

/**
 * @param {string} name
 * @param {string} type
 * @param {string} text
 */
function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Load stats ───────────────────────────────────────────

/**
 * @param {{ parseMs: number | null, decodeMs: number, uploadMs: number | null, pages: { name: string, ms: number, format: string, gpuBytes?: number }[], groupMs?: number, groupShared?: number } | null} stats
 */
export function loadStatsText(stats) {
  if (!stats) return { value: '—', detail: '' };
  const fmt = (ms) => `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  const parts = [];
  if (stats.parseMs != null) parts.push(`parse ${fmt(stats.parseMs)}`);
  parts.push(`${stats.pages.some((p) => p.format !== 'image') ? 'fetch + transcode' : 'decode'} ${fmt(stats.decodeMs)}`);
  if (stats.uploadMs != null) parts.push(`upload ${fmt(stats.uploadMs)}`);
  const total = (stats.parseMs ?? 0) + stats.decodeMs + (stats.uploadMs ?? 0);
  const pages = stats.pages.map((p) => `${p.name} ${fmt(p.ms)}${p.format !== 'image' ? ` (${p.format}${p.gpuBytes ? `, ${formatMb(p.gpuBytes)} MB` : ''})` : ''}`);
  const group = stats.groupMs != null ? [`export group load ${fmt(stats.groupMs)}${stats.groupShared > 1 ? `, shared by ${stats.groupShared} skeletons` : ''}`] : [];
  return { value: `${fmt(total)} · ${parts.join(' · ')}`, detail: [...pages, ...group].join(' · ') };
}
