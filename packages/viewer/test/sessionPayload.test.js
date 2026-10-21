import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeScene } from '../src/persistence/sceneFile.js';
import { blobToFile, buildSessionPayload, parseSessionPayload } from '../src/persistence/sessionPayload.js';

test('serializeScene includes assetId', () => {
  const json = serializeScene({
    camera: { x: 0, y: 0, zoom: 1 },
    snapEnabled: true,
    playing: false,
    instances: [{
      id: 'i1',
      name: 'hero',
      assetKey: 'hero.json',
      assetId: 'a1',
      spine: { x: 1, y: 2, rotation: 0, scale: { x: 1, y: 1 } },
      zIndex: 0,
      visible: true,
      locked: false,
      stageAnimations: true,
      skins: new Set(['default']),
      tracks: { 0: 'idle' },
    }],
  });
  assert.equal(json.instances[0].assetId, 'a1');
});

test('buildSessionPayload keeps only used assets with source files', () => {
  const skeleton = new File(['{}'], 'hero.json', { type: 'application/json' });
  const atlas = new File(['x'], 'hero.atlas', { type: 'text/plain' });
  const image = new File([new Uint8Array([1, 2])], 'hero.png', { type: 'image/png' });
  const assets = new Map([
    ['a1', {
      id: 'a1',
      assetKey: 'hero.json',
      sourceFiles: { skeleton, atlas, images: [image] },
    }],
    ['a2', {
      id: 'a2',
      assetKey: 'unused.json',
      sourceFiles: { skeleton, atlas, images: [image] },
    }],
  ]);
  const payload = buildSessionPayload({
    camera: { x: 0, y: 0, zoom: 1 },
    snapEnabled: true,
    playing: false,
    instances: [{
      id: 'i1',
      name: 'hero',
      assetKey: 'hero.json',
      assetId: 'a1',
      spine: { x: 0, y: 0, rotation: 0, scale: { x: 1, y: 1 } },
      zIndex: 0,
      visible: true,
      locked: false,
      skins: new Set(),
      tracks: {},
    }],
  }, assets);
  assert.equal(payload.assets.length, 1);
  assert.equal(payload.assets[0].id, 'a1');
  assert.deepEqual(payload.assets[0].images, []);
  const parsed = parseSessionPayload(payload);
  assert.equal(parsed.scene.instances[0].assetId, 'a1');
  assert.equal(blobToFile(parsed.assets[0].skeleton).name, 'hero.json');
  assert.equal(parsed.assets[0].images.length, 0);
});

test('parseSessionPayload rejects unknown schema', () => {
  assert.throws(() => parseSessionPayload({
    schemaVersion: 99,
    scene: { schemaVersion: 1, instances: [] },
    assets: [],
  }));
});
