import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSceneFile } from '../src/persistence/sceneFile.js';

test('round-trips a scene document', () => {
  const raw = {
    schemaVersion: 1,
    camera: { x: 3, y: 4, zoom: 1.5 },
    snapEnabled: false,
    playing: true,
    instances: [{
      id: 'a',
      name: 'hero',
      assetKey: 'hero.json',
      transform: { x: 10, y: 20, rotation: 0.2, scaleX: 1, scaleY: -1 },
      zIndex: 2,
      visible: true,
      locked: false,
      stageAnimations: false,
      skins: ['default'],
      tracks: { 0: 'idle' },
    }],
  };
  const parsed = parseSceneFile(JSON.parse(JSON.stringify(raw)));
  assert.equal(parsed.camera.zoom, 1.5);
  assert.equal(parsed.snapEnabled, false);
  assert.equal(parsed.instances[0].tracks[0], 'idle');
  assert.equal(parsed.instances[0].transform.scaleY, -1);
  assert.equal(parsed.instances[0].stageAnimations, false);
  assert.equal(parsed.instances[0].assetId, '');
  assert.equal(parsed.gridEnabled, false);
  assert.deepEqual(parsed.instances[0].hiddenSlots, []);
  const legacyInstance = { ...raw.instances[0] };
  delete legacyInstance.stageAnimations;
  const legacy = parseSceneFile({ ...raw, instances: [legacyInstance] });
  assert.equal(legacy.instances[0].stageAnimations, true);
});

test('rejects an unknown schema', () => {
  assert.throws(() => parseSceneFile({ schemaVersion: 99, instances: [] }));
});
