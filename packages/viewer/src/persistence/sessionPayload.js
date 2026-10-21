import { serializeScene, parseSceneFile } from './sceneFile.js';

export const SESSION_SCHEMA = 1;

/**
 * @param {File | Blob} file
 * @param {string} [name]
 */
export function fileRecord(file, name = '') {
  const recName = name || (file instanceof File ? file.name : '');
  return {
    name: recName,
    type: file.type || '',
    blob: file,
  };
}

/**
 * @param {{ name?: string, type?: string, blob?: Blob | File }} rec
 */
export function blobToFile(rec) {
  if (!rec || !rec.blob) throw new Error('Session file is missing blob data.');
  const name = rec.name || 'file';
  const type = rec.type || rec.blob.type || '';
  if (rec.blob instanceof File && rec.blob.name === name) return rec.blob;
  return new File([rec.blob], name, { type });
}

/**
 * Only skeletons dropped as raw Spine files are stored; an opened export (`.tbla`, manifest) is dropped again after a reload.
 * @param {import('../app/sceneStore.js').SceneState} scene
 * @param {Map<string, { id: string, assetKey: string, sourceFiles?: { skeleton: File, atlas: File, images: File[] } }>} assets
 */
export function buildSessionPayload(scene, assets) {
  const used = new Set(scene.instances.map((inst) => inst.assetId));
  /** @type {object[]} */
  const records = [];
  for (const asset of assets.values()) {
    if (!used.has(asset.id) || !asset.sourceFiles) continue;
    records.push({
      id: asset.id,
      assetKey: asset.assetKey,
      skeleton: fileRecord(asset.sourceFiles.skeleton, asset.sourceFiles.skeleton.name),
      atlas: fileRecord(asset.sourceFiles.atlas, asset.sourceFiles.atlas.name),
      images: [],
    });
  }
  return {
    schemaVersion: SESSION_SCHEMA,
    scene: serializeScene(scene),
    assets: records,
  };
}

/**
 * @param {unknown} value
 */
export function parseSessionPayload(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Session is not an object.');
  }
  const data = /** @type {Record<string, unknown>} */ (value);
  if (data.schemaVersion !== SESSION_SCHEMA) {
    throw new Error('Unsupported session schema.');
  }
  const scene = parseSceneFile(data.scene);
  if (!Array.isArray(data.assets)) {
    throw new Error('Session is missing assets.');
  }
  const assets = data.assets.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid session asset.');
    const rec = /** @type {Record<string, unknown>} */ (raw);
    const skeleton = rec.skeleton && typeof rec.skeleton === 'object'
      ? /** @type {{ name?: string, type?: string, blob?: Blob }} */ (rec.skeleton)
      : null;
    const atlas = rec.atlas && typeof rec.atlas === 'object'
      ? /** @type {{ name?: string, type?: string, blob?: Blob }} */ (rec.atlas)
      : null;
    if (!skeleton?.name || !atlas?.name) throw new Error('Session asset is missing skeleton or atlas.');
    const images = Array.isArray(rec.images) ? rec.images : [];
    return {
      id: String(rec.id || ''),
      assetKey: String(rec.assetKey || skeleton.name),
      skeleton,
      atlas,
      images: images.map((img) => {
        if (!img || typeof img !== 'object') throw new Error('Invalid session image.');
        return /** @type {{ name?: string, type?: string, blob?: Blob }} */ (img);
      }),
    };
  });
  return {
    schemaVersion: SESSION_SCHEMA,
    scene,
    assets,
  };
}
