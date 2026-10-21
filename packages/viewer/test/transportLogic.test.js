import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pickTransportInstance,
  resolveAnimTargets,
  resolveTransportIsPlaying,
} from '../src/ui/transportLogic.js';

/** @param {Partial<import('../src/ui/transportLogic.js').TransportInst>} spec */
function inst(spec) {
  return {
    id: spec.id || 'a',
    playing: spec.playing,
    stageAnimations: spec.stageAnimations,
    selectedTrack: spec.selectedTrack,
    spine: spec.spine,
  };
}

function animEntry() {
  return { animation: { duration: 1 } };
}

test('resolveAnimTargets uses all instances when nothing is selected', () => {
  const instances = [inst({ id: '1' }), inst({ id: '2' })];
  assert.deepEqual(resolveAnimTargets(instances, null, false), instances);
});

test('resolveAnimTargets uses selection only unless apply global', () => {
  const a = inst({ id: 'a' });
  const b = inst({ id: 'b' });
  const instances = [a, b];
  assert.deepEqual(resolveAnimTargets(instances, a, false), [a]);
  assert.deepEqual(resolveAnimTargets(instances, a, true), instances);
});

test('resolveTransportIsPlaying ignores scene.playing when no instance can advance', () => {
  const instances = [
    inst({
      id: '1',
      playing: false,
      stageAnimations: false,
      spine: { state: { getCurrent: () => animEntry() } },
    }),
  ];
  assert.equal(resolveTransportIsPlaying({
    scenePlaying: true,
    selectedInstance: null,
    instances,
  }), false);
});

test('resolveTransportIsPlaying is true for global play with a playing animation', () => {
  const instances = [
    inst({
      id: '1',
      playing: true,
      spine: { state: { getCurrent: () => animEntry() } },
    }),
  ];
  assert.equal(resolveTransportIsPlaying({
    scenePlaying: true,
    selectedInstance: null,
    instances,
  }), true);
});

test('resolveTransportIsPlaying reads Spine 4.3 getTrack when getCurrent is missing', () => {
  const instances = [
    inst({
      id: '1',
      playing: true,
      spine: { state: { getTrack: () => animEntry() } },
    }),
  ];
  assert.equal(resolveTransportIsPlaying({
    scenePlaying: true,
    selectedInstance: null,
    instances,
  }), true);
});

test('pickTransportInstance prefers selection then playing instance', () => {
  const selected = inst({
    id: 'sel',
    spine: { state: { getCurrent: () => null } },
  });
  const playing = inst({
    id: 'play',
    playing: true,
    spine: { state: { getCurrent: () => animEntry() } },
  });
  assert.equal(pickTransportInstance([playing], selected, false), selected);
  assert.equal(pickTransportInstance([playing], null, true), playing);
});
