import { TabulaAssetManager } from 'tabula-pixi';
import { spineJson } from 'tabula-pixi/json';
import basisScriptUrl from 'tabula-pixi/basis/basis_transcoder.js?url';
import basisWasmUrl from 'tabula-pixi/basis/basis_transcoder.wasm?url';
import { openTabulaPackage } from './package.js';

/** tabula-pixi's Basis transcoder, for KTX2 pages; on the main thread (a factory never uses workers). */
async function basisTranscoder() {
  const js = new URL(basisScriptUrl, location.href).href;
  const wasm = new URL(basisWasmUrl, location.href).href;
  const global = /** @type {{ BASIS?: (options: object) => Promise<any> }} */ (/** @type {unknown} */ (globalThis));
  if (!global.BASIS) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = js;
      script.async = true;
      script.onload = () => resolve(undefined);
      script.onerror = () => reject(new Error('Could not load the Basis transcoder'));
      document.head.appendChild(script);
    });
  }
  if (!global.BASIS) throw new Error('The Basis transcoder did not load');
  return global.BASIS({ locateFile: () => wasm });
}

/**
 * @typedef {Object} OpenedExport
 * @property {import('./package.js').TabulaPackage} pkg
 * @property {import('tabula-pixi').TabulaAssetManager} manager
 */

/**
 * Open an export (a `.tbla`, or `assets.manifest.json` with its bundles or loose files) the way a game loads it.
 * @param {import('./package.js').PackageFile[]} files
 * @param {import('pixi.js').IRenderer} renderer decides the KTX2 transcode format
 * @param {number} [tier] resolution tier to load (1 = the exported size)
 * @returns {Promise<OpenedExport>}
 */
export async function openExport(files, renderer, tier = 1) {
  const pkg = await openTabulaPackage(files);
  const hasKtx2 = Object.values(pkg.manifest.pages ?? {}).some((page) => Object.keys(page.files ?? {}).some((file) => /\.ktx2$/i.test(file)));
  const manager = await TabulaAssetManager.load(pkg.manifestUrl, {
    renderer,
    fetch: pkg.fetch,
    json: spineJson,
    tier,
    ktx2: hasKtx2,
    transcoder: hasKtx2 ? basisTranscoder : undefined,
    workers: false,
  });
  return { pkg, manager };
}

/**
 * Resolution tiers the export offers, largest first (always at least 1).
 * @param {OpenedExport} exp
 * @returns {number[]}
 */
export function listTiers(exp) {
  const tiers = exp.manager.availableTiers().map((entry) => entry.tier);
  return tiers.length ? tiers : [1];
}

/**
 * Skeletons an export lists, for the chooser.
 * @param {OpenedExport} exp
 * @returns {{ name: string, group: string, format: 'tbin' | 'json' }[]}
 */
export function listSkeletons(exp) {
  return Object.entries(exp.pkg.manifest.skeletons)
    .map(([name, skeleton]) => ({
      name,
      group: exp.manager.groupsOf(name, 'skeletons')[0] ?? '',
      format: skeleton.format ?? 'tbin',
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Load the groups the skeletons are in and hand over their assets.
 * @param {OpenedExport} exp
 * @param {string[]} names
 * @returns {Promise<{ name: string, asset: import('tabula-pixi').TabulaAsset }[]>}
 */
export async function loadSkeletons(exp, names) {
  const groups = new Set(names.flatMap((name) => exp.manager.groupsOf(name, 'skeletons')));
  for (const group of groups) await exp.manager.loadGroup(group);
  return names.map((name) => ({ name, asset: exp.manager.getAsset(name) }));
}
