import { TRACK_COLORS, TRACK_COUNT } from '../constants.js';
import { TRACK_MODE_LABELS, poseTime, trackModeOf } from '../app/playback.js';
import { currentTrackEntry } from '../tabula/skeletonAccess.js';

/**
 * Track timeline for one skeleton: a time ruler with event markers, one lane per
 * animation track, and (optionally) read-only key rows for the selected track's
 * animation. The ruler spans the selected track's animation; each lane shows its
 * animation as a bar and a playhead that follows that track's pose time.
 */

const SECOND_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
const FRAME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/**
 * @typedef {object} TimelineHandlers
 * @property {(track: number) => void} onSelectTrack
 * @property {(track: number) => void} onClearTrack
 * @property {(track: number, time: number) => void} onSeek
 * @property {(active: boolean) => void} onScrub
 */

/**
 * @typedef {object} TimelineOptions
 * @property {'seconds' | 'frames'} units
 * @property {number} fps
 * @property {boolean} showKeys
 */

/** @param {any} inst @param {number} track */
function trackAnimation(inst, track) {
  const entry = currentTrackEntry(inst?.spine?.state, track);
  return entry?.animation ? entry : null;
}

/**
 * The ruler spans the selected track's animation, so it always runs edge to edge.
 * Without one it falls back to the longest assigned animation, then to one second.
 */
function timelineSpan(inst) {
  const selected = trackAnimation(inst, inst.selectedTrack || 0);
  if (selected && selected.animation.duration > 0) return selected.animation.duration;
  let span = 0;
  for (let index = 0; index < TRACK_COUNT; index++) {
    const entry = trackAnimation(inst, index);
    if (entry) span = Math.max(span, entry.animation.duration);
  }
  return span > 0 ? span : 1;
}

/** @param {number} seconds @param {TimelineOptions} options @param {boolean} [short] */
function formatTime(seconds, options, short = false) {
  if (options.units === 'frames') return `${Math.round(seconds * options.fps)}${short ? '' : 'f'}`;
  const text = seconds >= 10 ? `${seconds.toFixed(1)}s` : `${seconds.toFixed(2)}s`;
  return short ? text.replace(/\.?0+s$/, 's') : text;
}

/** @param {HTMLElement} host @param {HTMLElement} ruler @param {number} span @param {TimelineOptions} options */
function renderRuler(host, ruler, span, options) {
  const frames = options.units === 'frames';
  const unit = frames ? 1 / options.fps : 1;
  const steps = frames ? FRAME_STEPS : SECOND_STEPS;
  const step = (steps.find((value) => span / (value * unit) <= 10) || steps[steps.length - 1]) * unit;
  host.style.setProperty('--tl-step', `${(step / span) * 100}%`);
  const count = Math.floor(span / step + 1e-6);
  for (let index = 0; index <= count; index++) {
    const time = index * step;
    // Leave room for the end label instead of crowding it.
    if (index > 0 && (span - time) / span < 0.06) break;
    ruler.appendChild(tickAt(time, span, '', options));
  }
  ruler.appendChild(tickAt(span, span, 'is-end', options));
}

/** @param {number} time @param {number} span @param {string} extra @param {TimelineOptions} options */
function tickAt(time, span, extra, options) {
  const tick = document.createElement('span');
  tick.className = `tl-tick ${extra}`.trim();
  tick.style.left = `${(time / span) * 100}%`;
  tick.textContent = formatTime(time, options, true);
  return tick;
}

/**
 * @param {HTMLElement} area element whose width maps to the span
 * @param {PointerEvent} event
 * @param {number} span
 */
function timeAt(area, event, span) {
  const rect = area.getBoundingClientRect();
  const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  return Math.max(0, Math.min(1, ratio)) * span;
}

/**
 * Drag on a lane (or the ruler) to scrub that track.
 * @param {HTMLElement} area @param {() => number} trackOf @param {number} span @param {TimelineHandlers} handlers
 */
function bindScrub(area, trackOf, span, handlers) {
  area.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const track = trackOf();
    handlers.onSelectTrack(track);
    area.setPointerCapture(event.pointerId);
    handlers.onScrub(true);
    handlers.onSeek(track, timeAt(area, event, span));
    const move = (/** @type {PointerEvent} */ next) => handlers.onSeek(track, timeAt(area, next, span));
    const end = () => {
      area.removeEventListener('pointermove', move);
      area.removeEventListener('pointerup', end);
      area.removeEventListener('pointercancel', end);
      handlers.onScrub(false);
    };
    area.addEventListener('pointermove', move);
    area.addEventListener('pointerup', end);
    area.addEventListener('pointercancel', end);
  });
}

const BONE_KINDS = new Set(['rotate', 'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'shear', 'shearx', 'sheary', 'inherit']);
const SLOT_KINDS = new Set(['rgba', 'rgb', 'alpha', 'rgba2', 'rgb2', 'attachment', 'deform', 'sequence']);
const PATH_KINDS = new Set(['pathPosition', 'pathSpacing', 'pathMix']);
const GROUP_ORDER = ['Events', 'Draw order', 'Bones', 'Slots', 'Constraints'];

/**
 * Key rows for an animation: one per bone, slot or constraint it keys (kinds merged), plus draw order and events.
 * @param {any} animation tabula-pixi AnimationData
 * @param {any} data SkeletonData
 * @returns {{ group: string, name: string, kinds: string[], times: number[], titles?: string[] }[]}
 */
export function keyRows(animation, data) {
  /** @type {Map<string, { group: string, name: string, kinds: Set<string>, times: Set<number>, titles?: string[] }>} */
  const rows = new Map();
  const row = (group, name, kind) => {
    const key = `${group}\u0000${name}`;
    let entry = rows.get(key);
    if (!entry) rows.set(key, (entry = { group, name, kinds: new Set(), times: new Set() }));
    if (kind) entry.kinds.add(kind);
    return entry;
  };
  for (const timeline of animation?.timelines || []) {
    const kind = timeline.kind;
    let entry;
    if (kind === 'event') {
      entry = row('Events', 'Events', '');
      entry.titles = timeline.events.map((event) => `${event.name} @ ${event.time.toFixed(3)}s`);
    } else if (kind === 'drawOrder') entry = row('Draw order', 'Draw order', '');
    else if (BONE_KINDS.has(kind)) entry = row('Bones', data.bones[timeline.target]?.name ?? `bone ${timeline.target}`, kind);
    else if (SLOT_KINDS.has(kind)) entry = row('Slots', data.slots[timeline.target]?.name ?? `slot ${timeline.target}`, kind);
    else if (kind === 'ik') entry = row('Constraints', data.ikConstraints[timeline.target]?.name ?? 'ik', 'ik');
    else if (kind === 'transformMix') entry = row('Constraints', data.transformConstraints[timeline.target]?.name ?? 'transform', 'transform');
    else if (PATH_KINDS.has(kind)) entry = row('Constraints', data.pathConstraints[timeline.target]?.name ?? 'path', 'path');
    else if (kind.startsWith('physics')) entry = row('Constraints', timeline.target < 0 ? 'All physics' : data.physicsConstraints?.[timeline.target]?.name ?? 'physics', 'physics');
    else continue;
    for (const time of timeline.times) entry.times.add(Math.round(time * 1e4) / 1e4);
  }
  return [...rows.values()]
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
    .map((entry) => ({ ...entry, kinds: [...entry.kinds], times: [...entry.times].sort((a, b) => a - b) }));
}

/** @param {any} animation @returns {{ name: string, time: number }[]} */
function animationEvents(animation) {
  return (animation?.timelines || []).filter((t) => t.kind === 'event').flatMap((t) => t.events.map((event) => ({ name: event.name, time: event.time })));
}

/**
 * Rebuild the timeline. `reason` disables it and explains why (no selection, several skeletons).
 * @param {HTMLElement} host
 * @param {any} inst
 * @param {string} reason
 * @param {TimelineHandlers} handlers
 * @param {TimelineOptions} options
 */
export function renderTimeline(host, inst, reason, handlers, options) {
  host.replaceChildren();
  host.classList.toggle('is-disabled', !!reason);
  host.timelineOptions = options;
  if (reason || !inst) {
    const empty = document.createElement('div');
    empty.className = 'tl-empty';
    empty.textContent = reason || 'Select one skeleton to see its tracks.';
    host.appendChild(empty);
    return;
  }
  const span = timelineSpan(inst);
  host.dataset.span = String(span);
  const selectedTrack = inst.selectedTrack || 0;
  const selectedEntry = trackAnimation(inst, selectedTrack);

  const head = document.createElement('div');
  head.className = 'tl-row tl-head';
  const corner = document.createElement('div');
  corner.className = 'tl-label tl-corner';
  const readout = document.createElement('span');
  readout.className = 'tl-readout';
  corner.appendChild(readout);
  const ruler = document.createElement('div');
  ruler.className = 'tl-lane tl-ruler';
  const rulerHead = document.createElement('i');
  rulerHead.className = 'tl-playhead';
  ruler.appendChild(rulerHead);
  bindScrub(ruler, () => inst.selectedTrack || 0, span, handlers);
  head.append(corner, ruler);
  host.appendChild(head);
  renderRuler(host, ruler, span, options);
  for (const event of animationEvents(selectedEntry?.animation)) {
    const marker = document.createElement('span');
    marker.className = 'tl-event';
    marker.dataset.event = event.name;
    marker.style.left = `${Math.min(event.time / span, 1) * 100}%`;
    marker.title = `Event "${event.name}" at ${formatTime(event.time, options)}`;
    ruler.appendChild(marker);
  }

  for (let index = 0; index < TRACK_COUNT; index++) {
    const name = inst.tracks[index] || '';
    const entry = trackAnimation(inst, index);
    const row = document.createElement('div');
    row.className = 'tl-row tl-track';
    row.dataset.track = String(index);
    row.classList.toggle('is-active', index === selectedTrack);
    row.style.setProperty('--track-color', TRACK_COLORS[index]);

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'tl-label';
    label.title = name ? `Track ${index}: ${name}` : `Track ${index} (empty). Pick an animation to play it here.`;
    const dot = document.createElement('span');
    dot.className = 'tl-dot';
    const number = document.createElement('span');
    number.className = 'tl-num';
    number.textContent = String(index);
    const text = document.createElement('span');
    text.className = 'tl-name';
    text.textContent = name || 'Empty';
    label.append(dot, number, text);
    label.addEventListener('click', () => handlers.onSelectTrack(index));
    if (name) {
      const clear = document.createElement('span');
      clear.className = 'tl-clear';
      clear.setAttribute('role', 'button');
      clear.setAttribute('aria-label', `Clear track ${index}`);
      clear.textContent = '×';
      clear.addEventListener('click', (event) => {
        event.stopPropagation();
        handlers.onClearTrack(index);
      });
      label.appendChild(clear);
    }

    const lane = document.createElement('div');
    lane.className = 'tl-lane';
    if (entry) {
      const bar = document.createElement('div');
      bar.className = 'tl-bar';
      const ratio = entry.animation.duration / span;
      bar.style.width = `${Math.min(1, ratio) * 100}%`;
      bar.classList.toggle('is-clipped', ratio > 1.001);
      if (ratio > 1.001) lane.title = `${name} is longer than the selected track; the rest is cut off.`;
      bar.textContent = `${name} · ${formatTime(entry.animation.duration, options)} · ${TRACK_MODE_LABELS[trackModeOf(inst, index)]}`;
      lane.appendChild(bar);
      const playhead = document.createElement('i');
      playhead.className = 'tl-playhead';
      lane.appendChild(playhead);
      bindScrub(lane, () => index, span, handlers);
    } else {
      lane.addEventListener('click', () => handlers.onSelectTrack(index));
    }
    row.append(label, lane);
    host.appendChild(row);
  }

  if (options.showKeys) renderKeyRows(host, inst, selectedEntry, span, handlers);
  refreshTimeline(host, inst);
}

/**
 * Read-only key rows for the selected track's animation; dragging on them scrubs that track.
 * @param {HTMLElement} host @param {any} inst @param {any} entry @param {number} span @param {TimelineHandlers} handlers
 */
function renderKeyRows(host, inst, entry, span, handlers) {
  const header = document.createElement('div');
  header.className = 'tl-row tl-keys-head';
  const title = document.createElement('div');
  title.className = 'tl-label';
  title.textContent = entry ? `Keys · ${entry.animation.name}` : 'Keys';
  const note = document.createElement('div');
  note.className = 'tl-lane tl-keys-note';
  note.textContent = entry ? '' : 'Pick an animation on the selected track to see its keys.';
  header.append(title, note);
  host.appendChild(header);
  if (!entry) return;
  const rows = keyRows(entry.animation, inst.spine.skeleton.data);
  if (!rows.length) {
    note.textContent = 'This animation has no keys.';
    return;
  }
  let group = '';
  for (const item of rows) {
    const row = document.createElement('div');
    row.className = `tl-row tl-key-row is-${item.group.toLowerCase().replace(/\s+/g, '-')}`;
    if (item.group !== group) {
      row.classList.add('is-group-start');
      group = item.group;
    }
    const label = document.createElement('div');
    label.className = 'tl-label';
    label.title = `${item.group}: ${item.name}${item.kinds.length ? ` (${item.kinds.join(', ')})` : ''}`;
    const name = document.createElement('span');
    name.className = 'tl-name';
    name.textContent = item.name;
    const kinds = document.createElement('span');
    kinds.className = 'tl-kinds';
    kinds.textContent = item.kinds.join(' ');
    label.append(name, kinds);
    const lane = document.createElement('div');
    lane.className = 'tl-lane';
    item.times.forEach((time, i) => {
      if (time > span + 1e-6) return;
      const key = document.createElement('i');
      key.className = 'tl-key';
      key.style.left = `${(time / span) * 100}%`;
      if (item.titles?.[i]) key.title = item.titles[i];
      lane.appendChild(key);
    });
    const playhead = document.createElement('i');
    playhead.className = 'tl-playhead tl-key-playhead';
    lane.appendChild(playhead);
    bindScrub(lane, () => inst.selectedTrack || 0, span, handlers);
    row.append(label, lane);
    host.appendChild(row);
  }
}

/**
 * Move playheads and the time readout without rebuilding (runs every tick).
 * @param {HTMLElement} host @param {any} inst
 */
export function refreshTimeline(host, inst) {
  if (!inst || host.classList.contains('is-disabled')) return;
  const options = /** @type {TimelineOptions} */ (host.timelineOptions || { units: 'seconds', fps: 30, showKeys: false });
  const span = Number(host.dataset.span) || 1;
  const selectedTrack = inst.selectedTrack || 0;
  let selectedTime = 0;
  let selectedDuration = 0;
  host.querySelectorAll('.tl-track').forEach((row) => {
    const index = Number(/** @type {HTMLElement} */ (row).dataset.track);
    const head = /** @type {HTMLElement | null} */ (row.querySelector('.tl-playhead'));
    const entry = trackAnimation(inst, index);
    if (!head || !entry) return;
    const time = poseTime(entry);
    head.hidden = time > span + 1e-6;
    head.style.left = `${Math.min(time / span, 1) * 100}%`;
    if (index === selectedTrack) {
      selectedTime = time;
      selectedDuration = entry.animation.duration;
    }
  });
  const left = `${(selectedTime / span) * 100}%`;
  host.querySelectorAll('.tl-ruler .tl-playhead, .tl-key-playhead').forEach((head) => {
    /** @type {HTMLElement} */ (head).hidden = selectedDuration <= 0;
    /** @type {HTMLElement} */ (head).style.left = left;
  });
  const readout = host.querySelector('.tl-readout');
  if (readout) readout.textContent = selectedDuration > 0 ? `${formatTime(selectedTime, options)} / ${formatTime(selectedDuration, options)}` : '—';
}

/**
 * Flash an event marker on the ruler when the event fires.
 * @param {HTMLElement} host @param {string} name
 */
export function flashTimelineEvent(host, name) {
  host.querySelectorAll(`.tl-event[data-event="${CSS.escape(name)}"]`).forEach((marker) => {
    marker.classList.remove('is-firing');
    void (/** @type {HTMLElement} */ (marker).offsetWidth);
    marker.classList.add('is-firing');
  });
}
