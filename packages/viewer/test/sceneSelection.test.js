import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addInstance,
  resetScene,
  scene,
  selectInstance,
  selectedInstances,
} from '../src/app/sceneStore.js';

/** @param {string} id */
function stub(id) {
  return {
    id,
    name: id,
    assetKey: id,
    assetId: id,
    spine: { zIndex: 0 },
    atlas: null,
    zIndex: scene.instances.length,
    visible: true,
    locked: false,
    skins: new Set(),
    tracks: {},
    selectedSlot: null,
    selectedBone: null,
    selectedTrack: 0,
    pulse: false,
    maskColorIndex: 0,
    lastAnimationName: null,
    holdSetup: false,
    playing: false,
  };
}

test('selectInstance additive toggles membership and keeps a primary', () => {
  resetScene({ version: '4.2', locked: true });
  addInstance(stub('a'));
  scene.instances.push(stub('b'));
  selectInstance('b', { additive: true });
  assert.equal(selectedInstances().length, 2);
  assert.equal(scene.selectedId, 'b');
  selectInstance('a', { additive: true });
  assert.equal(selectedInstances().length, 1);
  assert.equal(scene.selectedId, 'b');
});
