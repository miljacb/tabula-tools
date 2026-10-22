import { SIMPLE_MODE_STORAGE_KEY, ZOOM_STEP } from '../constants.js';
import { emit, scene, selectInstance, selected, subscribe } from '../app/sceneStore.js';
import { zoomBy } from '../app/stage.js';
import { fitSelection } from '../app/session.js';
import { withHistory } from '../app/history.js';
import { applyTrackMode, poseTime, setPoseTime, trackModeOf } from '../app/playback.js';
import { applySkins } from '../features/skins.js';
import { matchesFilter } from '../features/slotPick.js';
import { currentTrackEntry } from '../tabula/skeletonAccess.js';

/**
 * Simple mode: the reduced layout of Studio's .tbla preview (tabla-viewer.tsx). The stage with zoom buttons on it,
 * an animation list beside it, transport and options below. The full viewer UI is hidden by CSS (html[data-simple]).
 */

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8Z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16M17 4v16"/></svg>';

/** @typedef {import('../app/sceneStore.js').SpineInstance} SpineInstance */
/**
 * @typedef {object} TrackApi
 * @property {(inst: SpineInstance, track: number, name: string) => void} setTrack
 * @property {(inst: SpineInstance, track: number) => void} clearTrack
 */

let on = false;
let query = '';
let frame = 0;
/** @type {TrackApi} */
let api;

const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

function load() {
  try {
    return localStorage.getItem(SIMPLE_MODE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function save() {
  try {
    localStorage.setItem(SIMPLE_MODE_STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** The skeleton the preview drives: the selected one, else the first on the stage. */
function current() {
  return selected() || scene.instances[0] || null;
}

/** @param {SpineInstance} inst */
function entryOf(inst) {
  return currentTrackEntry(inst.spine?.state, 0);
}

const formatTime = (/** @type {number} */ t) => t.toFixed(2);

/** @param {HTMLSelectElement} select @param {string[]} values @param {string} value @param {string[]} [labels] */
function fillSelect(select, values, value, labels = values) {
  select.replaceChildren(...values.map((v, i) => new Option(labels[i], v, false, v === value)));
}

function render() {
  if (!on) return;
  const inst = current();
  const instances = scene.instances;

  $('simple-skeleton-field').hidden = instances.length < 2;
  fillSelect($('simple-skeleton'), instances.map((i) => i.id), inst?.id ?? '', instances.map((i) => i.name));

  const skins = (inst?.spine?.skeleton?.data?.skins || []).map((/** @type {any} */ s) => s.name);
  // Always shown, like the Skeleton picker's place in Studio's preview; disabled when there is nothing to switch to.
  const activeSkin = inst ? [...inst.skins].find((name) => name !== 'default') || [...inst.skins][0] || '' : '';
  const skinSelect = $('simple-skin');
  if (skins.length) fillSelect(skinSelect, skins, activeSkin);
  else skinSelect.replaceChildren(new Option(inst ? 'No skins' : '—', ''));
  skinSelect.disabled = skins.length < 2;

  /** @type {{ name: string, duration: number }[]} */
  const anims = inst?.spine?.skeleton?.data?.animations || [];
  const filterHidden = anims.length <= 8;
  $('simple-filter').hidden = filterHidden;
  // A hidden filter must not keep filtering.
  const activeQuery = filterHidden ? '' : query;
  const list = $('simple-list');
  const playingName = inst?.tracks[0] ?? null;
  const row = (/** @type {string | null} */ name, /** @type {string} */ label, /** @type {string} */ time) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = !inst;
    button.setAttribute('aria-pressed', String(playingName === name));
    const text = document.createElement('span');
    text.textContent = label;
    button.append(text);
    if (time) {
      const small = document.createElement('small');
      small.textContent = time;
      button.append(small);
      button.title = `${label} · ${time}`;
    }
    button.addEventListener('click', () => {
      if (!inst) return;
      if (name === null) api.clearTrack(inst, 0);
      else api.setTrack(inst, 0, name);
    });
    return button;
  };
  const rows = [row(null, 'Setup pose', '')];
  for (const anim of anims) {
    if (matchesFilter(anim.name, activeQuery)) rows.push(row(anim.name, anim.name, `${formatTime(anim.duration)}s`));
  }
  if (inst && !anims.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No animations.';
    rows.push(/** @type {any} */ (empty));
  }
  list.replaceChildren(...rows);

  const hasAnim = !!inst && !!playingName;
  const play = $('simple-play');
  play.disabled = !hasAnim;
  play.innerHTML = inst?.playing ? PAUSE_ICON : PLAY_ICON;
  play.setAttribute('aria-label', inst?.playing ? 'Pause' : 'Play');
  $('simple-restart').disabled = !hasAnim;
  $('simple-scrub').disabled = !hasAnim;

  const speed = $('simple-speed');
  const value = String(inst?.playbackSpeed ?? 1);
  if (![...speed.options].some((o) => o.value === value)) speed.add(new Option(`${value}×`, value));
  speed.value = value;
  $('simple-loop').checked = !inst || trackModeOf(inst, 0) !== 'once';
  $('simple-bg').value = $('stage-bg').value;
  $('simple-bg-color').hidden = $('stage-bg').value !== 'custom';
  $('simple-bg-color').value = $('stage-bg-color').value;
  refreshTime();
}

function refreshTime() {
  const inst = current();
  const entry = inst && inst.tracks[0] ? entryOf(inst) : null;
  const duration = entry?.animation?.duration ?? 0;
  const time = entry ? Math.min(poseTime(entry), duration) : 0;
  const scrub = $('simple-scrub');
  scrub.max = String(duration || 1);
  if (document.activeElement !== scrub || !scene.scrubbing) scrub.value = String(time);
  $('simple-time').textContent = `${formatTime(time)} / ${formatTime(duration)} s`;
}

function loopTime() {
  if (!on) return;
  refreshTime();
  frame = requestAnimationFrame(loopTime);
}

/** @param {boolean} next */
function setOn(next) {
  on = next;
  const root = document.documentElement;
  if (on) root.dataset.simple = '';
  else delete root.dataset.simple;
  const button = $('btn-simple');
  button?.setAttribute('aria-pressed', String(on));
  button?.classList.toggle('is-active', on);
  cancelAnimationFrame(frame);
  if (on) {
    render();
    frame = requestAnimationFrame(loopTime);
  }
  // Pixi's resizeTo only listens to window resize.
  window.dispatchEvent(new Event('resize'));
}

function toggle() {
  setOn(!on);
  save();
}

/** @param {TrackApi} trackApi */
export function bindSimpleMode(trackApi) {
  api = trackApi;
  $('btn-simple')?.addEventListener('click', toggle);
  $('simple-exit').addEventListener('click', toggle);
  $('simple-open').addEventListener('click', () => $('btn-import')?.click());
  $('simple-zoom-in').addEventListener('click', () => zoomBy(ZOOM_STEP));
  $('simple-zoom-out').addEventListener('click', () => zoomBy(-ZOOM_STEP));
  $('simple-fit').addEventListener('click', () => fitSelection());

  $('simple-skeleton').addEventListener('change', (/** @type {Event} */ e) => selectInstance(/** @type {HTMLSelectElement} */ (e.target).value));
  $('simple-skin').addEventListener('change', (/** @type {Event} */ e) => {
    const inst = current();
    if (!inst) return;
    // Undoable like the outliner's skin checkboxes.
    withHistory(() => {
      inst.previousSkins = new Set(inst.skins);
      inst.skins = new Set([/** @type {HTMLSelectElement} */ (e.target).value]);
      applySkins(inst);
      inst.spine.update(0);
      emit();
    });
  });
  $('simple-filter').addEventListener('input', (/** @type {Event} */ e) => {
    query = /** @type {HTMLInputElement} */ (e.target).value;
    render();
  });

  $('simple-play').addEventListener('click', () => {
    const inst = current();
    if (!inst) return;
    inst.playing = !inst.playing;
    scene.playing = scene.instances.some((item) => item.playing);
    emit();
  });
  $('simple-restart').addEventListener('click', () => {
    const inst = current();
    const entry = inst && entryOf(inst);
    if (!inst || !entry) return;
    setPoseTime(entry, 0);
    inst.playing = true;
    scene.playing = true;
    emit();
  });
  const scrub = $('simple-scrub');
  scrub.addEventListener('input', () => {
    const inst = current();
    const entry = inst && entryOf(inst);
    if (!inst || !entry) return;
    inst.playing = false;
    scene.scrubbing = true;
    setPoseTime(entry, scrub.valueAsNumber);
    inst.spine.state.apply(inst.spine.skeleton);
    inst.spine.update(0);
    refreshTime();
  });
  scrub.addEventListener('change', () => {
    scene.scrubbing = false;
    emit();
  });

  $('simple-speed').addEventListener('change', (/** @type {Event} */ e) => {
    const inst = current();
    if (!inst) return;
    inst.playbackSpeed = Number(/** @type {HTMLSelectElement} */ (e.target).value);
    if (inst.spine?.state) inst.spine.state.timeScale = inst.playbackSpeed;
    emit();
  });
  $('simple-loop').addEventListener('change', (/** @type {Event} */ e) => {
    const inst = current();
    if (!inst) return;
    const mode = /** @type {HTMLInputElement} */ (e.target).checked ? 'loop' : 'once';
    inst.trackMode = { ...(inst.trackMode || {}), 0: mode };
    inst.trackLoop[0] = mode !== 'once';
    const entry = entryOf(inst);
    if (entry) {
      const time = poseTime(entry);
      applyTrackMode(entry, mode);
      setPoseTime(entry, time);
    }
    emit();
  });
  // Background drives the full viewer's controls, so both stay in step and the choice is saved the same way.
  const forward = (/** @type {string} */ id, /** @type {string} */ value, /** @type {string} */ type) => {
    const el = $(id);
    el.value = value;
    el.dispatchEvent(new Event(type));
    render();
  };
  $('simple-bg').addEventListener('change', (/** @type {Event} */ e) => forward('stage-bg', /** @type {HTMLSelectElement} */ (e.target).value, 'change'));
  $('simple-bg-color').addEventListener('input', (/** @type {Event} */ e) => forward('stage-bg-color', /** @type {HTMLInputElement} */ (e.target).value, 'input'));

  subscribe(render);
  setOn(load());
}
