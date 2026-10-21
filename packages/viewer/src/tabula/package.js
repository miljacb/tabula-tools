// An export opened from files (drop, picker), served to tabula-pixi's TabulaAssetManager from memory the way a
// web server serves it to a game: the manager gets a manifest URL and a `fetch` that answers from the opened
// files. Nothing touches the network.
//
// What can be opened:
// - a self-contained bundle (one `.tbla` of a development export, `assets.manifest.json` inside);
// - `assets.manifest.json` with the `.tbla` bundles it lists (release export: `game.tbla`, load groups, tiers, KTX2);
// - `assets.manifest.json` with loose files (a `files` export): they are served as one in-memory bundle,
//   because the manager loads loose page images through Pixi's loader, which does not use `fetch`.
import { BUNDLE_MANIFEST, readBundle, readBundleToc, writeBundle } from 'tabula-pixi/core/tbla.js';
import { validateAssetManifest } from 'tabula-pixi/core/manifest.js';

/** @typedef {{ name: string, bytes: Uint8Array }} PackageFile */
/**
 * @typedef {Object} TabulaPackage
 * @property {string} manifestUrl Pass to TabulaAssetManager.load.
 * @property {typeof fetch} fetch Pass as the manager's `fetch` option.
 * @property {import('tabula-pixi/core/manifest.js').AssetManifest} manifest
 * @property {string} label What was opened, for messages ("game.tbla", "assets.manifest.json + 3 bundles").
 */

/** Never resolves, so a stray request fails at once instead of reaching the network. */
const ORIGIN = 'https://tbla-viewer.invalid/';
const LOOSE_BUNDLE = '(opened files).tbla';
let sessions = 0;

/** @param {string} path */
export const baseName = (path) => path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1);
/** @param {string} name */
export const isManifestFile = (name) => baseName(name).toLowerCase() === BUNDLE_MANIFEST;
/** @param {string} name */
export const isBundleFile = (name) => /\.tbla$/i.test(name);
/** True when a drop holds an export (a manifest or a `.tbla`) rather than raw Spine files. @param {{ name: string }[]} files */
export const hasPackageFiles = (files) => files.some((f) => isManifestFile(f.name) || isBundleFile(f.name));

const decode = (/** @type {Uint8Array} */ bytes) => new TextDecoder().decode(bytes);

/**
 * Work out what `files` are and serve them. Throws a message for the user when they are no complete export
 * (a bundle of a split export without its manifest, missing bundles, not a .tbla).
 * @param {readonly PackageFile[]} files
 * @returns {Promise<TabulaPackage>}
 */
export async function openTabulaPackage(files) {
  // Keyed by path relative to the manifest: a folder drop gives "export/game.tbla", a picker "game.tbla".
  /** @type {Map<string, Uint8Array>} */
  const byName = new Map();
  const manifestFile = files.find((f) => isManifestFile(f.name));
  const root = manifestFile ? manifestFile.name.replace(/\\/g, '/').slice(0, -BUNDLE_MANIFEST.length) : '';
  for (const f of files) {
    const path = f.name.replace(/\\/g, '/');
    byName.set(path.startsWith(root) ? path.slice(root.length) : baseName(path), f.bytes);
  }
  const bundles = files.filter((f) => isBundleFile(f.name));
  let manifest;
  let entry;
  let label;
  if (manifestFile) {
    manifest = validateAssetManifest(JSON.parse(decode(manifestFile.bytes)));
    entry = BUNDLE_MANIFEST;
    const listed = manifest.bundles ?? [];
    if (listed.length) {
      const missing = listed.map((b) => b.file.path).filter((p) => !byName.has(p) && !byName.has(baseName(p)));
      if (missing.length) {
        throw new Error(`Open these bundles together with ${BUNDLE_MANIFEST}: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` and ${missing.length - 4} more` : ''}.`);
      }
      label = `${BUNDLE_MANIFEST} + ${listed.length} bundle${listed.length === 1 ? '' : 's'}`;
    } else {
      // Loose files: one in-memory bundle with every file that was opened.
      const paths = [...byName.keys()].filter((p) => p !== BUNDLE_MANIFEST && !isBundleFile(p));
      const bytes = await writeBundle(paths.map((path, order) => ({ path, bytes: /** @type {Uint8Array} */ (byName.get(path)), order })), { tier: 1, group: '*' });
      byName.set(LOOSE_BUNDLE, bytes);
      manifest = { ...manifest, bundles: [{ file: { path: LOOSE_BUNDLE, bytes: bytes.length, hash: '' }, tier: 1, group: '*', paths }] };
      label = `${BUNDLE_MANIFEST} + ${paths.length} files`;
    }
  } else {
    if (!bundles.length) throw new Error('Choose a .tbla file (or assets.manifest.json with its .tbla bundles).');
    const tocOf = (/** @type {PackageFile} */ b) => {
      try { return readBundleToc(b.bytes); } catch { return null; }
    };
    const own = bundles.filter((b) => tocOf(b)?.files.some((f) => f.path === BUNDLE_MANIFEST));
    if (!own.length) {
      const first = tocOf(bundles[0]);
      if (!first) throw new Error(`${baseName(bundles[0].name)} is not a .tbla bundle.`);
      throw new Error(`${baseName(bundles[0].name)} is one bundle of a split export (group "${String(first.meta.group ?? '?')}", tier ${String(first.meta.tier ?? 1)}). Open ${BUNDLE_MANIFEST} together with its .tbla files.`);
    }
    if (own.length > 1) {
      throw new Error(`${own.map((b) => baseName(b.name)).slice(0, 3).join(', ')}${own.length > 3 ? ' …' : ''} each open on their own. To see them together, open ${BUNDLE_MANIFEST} with them.`);
    }
    entry = baseName(own[0].name);
    byName.set(entry, own[0].bytes);
    const embedded = (await readBundle(own[0].bytes)).files.get(BUNDLE_MANIFEST);
    manifest = validateAssetManifest(JSON.parse(decode(/** @type {Uint8Array} */ (embedded))));
    label = entry;
  }
  const base = `${ORIGIN}${++sessions}/`;
  const served = manifest;
  /** @type {typeof fetch} */
  const serve = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith(base) ? decodeURIComponent(url.slice(base.length).split('?')[0]) : null;
    const bytes = path === null
      ? undefined
      : path === BUNDLE_MANIFEST && manifestFile
        ? new TextEncoder().encode(JSON.stringify(served))
        : byName.get(path) ?? byName.get(baseName(path));
    if (!bytes) return Promise.resolve(new Response(`Not in the opened files: ${path ?? url}`, { status: 404 }));
    return Promise.resolve(new Response(bytes.slice(), { headers: { 'content-length': String(bytes.length) } }));
  };
  return { manifestUrl: base + entry, fetch: serve, manifest, label };
}
