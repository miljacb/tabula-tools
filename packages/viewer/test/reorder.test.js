import assert from 'node:assert/strict';
import test from 'node:test';
import { addInstance, reorderInstances, resetScene, scene } from '../src/app/sceneStore.js';

test('reorderInstances moves a row and rewrites zIndex back to front', () => {
  resetScene({ version: '4.2', locked: true });
  for (const name of ['a', 'b', 'c']) {
    addInstance({
      id: name,
      name,
      assetKey: name,
      assetId: name,
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
    });
  }
  reorderInstances('a', 'c');
  const order = [...scene.instances].sort((x, y) => x.zIndex - y.zIndex).map((item) => item.id);
  assert.deepEqual(order, ['b', 'c', 'a']);
  for (const inst of scene.instances) assert.equal(inst.spine.zIndex, inst.zIndex);
});
