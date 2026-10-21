import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAssetManifest } from 'tabula-pixi/core/manifest.js';
import { BUNDLE_MANIFEST, writeBundle } from 'tabula-pixi/core/tbla.js';
import { hasPackageFiles, isManifestFile, openTabulaPackage } from '../src/tabula/package.js';

const enc = (text) => new TextEncoder().encode(text);
const emptyManifest = () => buildAssetManifest([], {}).manifest;

/** A self-contained bundle: the manifest inside, as the app's release export writes it. */
async function bundleWithManifest(manifest = emptyManifest(), meta = { tier: 1, group: 'base' }) {
  return writeBundle([{ path: BUNDLE_MANIFEST, bytes: enc(JSON.stringify(manifest)) }], meta);
}

test('recognises export files by name, also inside a folder', () => {
  assert.equal(isManifestFile('export/assets.manifest.json'), true);
  assert.equal(isManifestFile('C:\\export\\ASSETS.MANIFEST.JSON'), true);
  assert.equal(isManifestFile('symbol1.json'), false);
  assert.equal(hasPackageFiles([{ name: 'game.tbla' }]), true);
  assert.equal(hasPackageFiles([{ name: 'a/assets.manifest.json' }]), true);
  assert.equal(hasPackageFiles([{ name: 'symbol1.json' }, { name: 'symbol1.atlas' }]), false);
});

test('opens a self-contained .tbla and serves it under the manifest URL', async () => {
  const bytes = await bundleWithManifest();
  const pkg = await openTabulaPackage([{ name: 'game.tbla', bytes }]);
  assert.equal(pkg.label, 'game.tbla');
  assert.equal(pkg.manifest.format, 'tabula-manifest');
  assert.match(pkg.manifestUrl, /^https:\/\/tbla-viewer\.invalid\/\d+\/game\.tbla$/);
  const response = await pkg.fetch(pkg.manifestUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test('a request outside the opened files is a 404, never the network', async () => {
  const pkg = await openTabulaPackage([{ name: 'game.tbla', bytes: await bundleWithManifest() }]);
  assert.equal((await pkg.fetch('https://example.com/game.tbla')).status, 404);
  assert.equal((await pkg.fetch(pkg.manifestUrl.replace('game.tbla', 'other.tbla'))).status, 404);
});

test('a manifest with loose files is served as one in-memory bundle', async () => {
  const manifest = emptyManifest();
  const pkg = await openTabulaPackage([
    { name: 'export/assets.manifest.json', bytes: enc(JSON.stringify(manifest)) },
    { name: 'export/symbol1.tbin', bytes: new Uint8Array([1, 2, 3]) },
    { name: 'export/pages/a.png', bytes: new Uint8Array([4, 5]) },
  ]);
  assert.equal(pkg.label, `${BUNDLE_MANIFEST} + 2 files`);
  const listed = pkg.manifest.bundles ?? [];
  assert.equal(listed.length, 1);
  assert.deepEqual([...listed[0].paths].sort(), ['pages/a.png', 'symbol1.tbin']);
  const bundle = await pkg.fetch(pkg.manifestUrl.replace(BUNDLE_MANIFEST, listed[0].file.path));
  assert.equal(bundle.status, 200);
  const served = await (await pkg.fetch(pkg.manifestUrl)).json();
  assert.equal(served.bundles.length, 1);
});

test('a manifest that lists bundles needs them', async () => {
  const manifest = { ...emptyManifest(), version: 3, bundles: [{ file: { path: 'game.tbla', bytes: 1, hash: '' }, tier: 1, group: 'base', paths: [] }] };
  await assert.rejects(
    openTabulaPackage([{ name: 'assets.manifest.json', bytes: enc(JSON.stringify(manifest)) }]),
    /Open these bundles together with assets\.manifest\.json: game\.tbla/,
  );
  const pkg = await openTabulaPackage([
    { name: 'assets.manifest.json', bytes: enc(JSON.stringify(manifest)) },
    { name: 'game.tbla', bytes: await bundleWithManifest() },
  ]);
  assert.equal(pkg.label, `${BUNDLE_MANIFEST} + 1 bundle`);
});

test('says what is wrong when the files are no complete export', async () => {
  await assert.rejects(openTabulaPackage([{ name: 'notes.txt', bytes: enc('x') }]), /Choose a \.tbla file/);
  await assert.rejects(openTabulaPackage([{ name: 'x.tbla', bytes: enc('not a bundle') }]), /not a \.tbla bundle/);
  const split = await writeBundle([{ path: 'symbol1.tbin', bytes: new Uint8Array([1]) }], { tier: 0.5, group: 'bigwin' });
  await assert.rejects(openTabulaPackage([{ name: 'game@0.5x.tbla', bytes: split }]), /one bundle of a split export \(group "bigwin", tier 0\.5\)/);
});

test('two self-contained bundles are not opened together without their manifest', async () => {
  const one = await bundleWithManifest();
  await assert.rejects(
    openTabulaPackage([{ name: 'a.tbla', bytes: one }, { name: 'b.tbla', bytes: one }]),
    /each open on their own/,
  );
});
