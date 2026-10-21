/**
 * @param {File[]} files
 * @returns {{ images: Map<string, File>, atlases: File[], skeletons: File[] }}
 */
export function classifyFiles(files) {
  /** @type {Map<string, File>} */
  const images = new Map();
  /** @type {File[]} */
  const atlases = [];
  /** @type {File[]} */
  const skeletons = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.png') || name.endsWith('.webp') || name.endsWith('.jpg') || name.endsWith('.jpeg')) {
      images.set(file.name, file);
    } else if (name.endsWith('.atlas')) {
      atlases.push(file);
    } else if (name.endsWith('.json') || name.endsWith('.skel')) {
      skeletons.push(file);
    }
  }
  return { images, atlases, skeletons };
}

/**
 * @param {string} filename
 */
export function stemOf(filename) {
  return filename.replace(/\.(json|skel|atlas)$/i, '');
}

/**
 * @param {File} skeleton
 * @param {File[]} atlases
 * @returns {File | null}
 */
export function findAtlas(skeleton, atlases) {
  const stem = stemOf(skeleton.name).toLowerCase();
  const exact = atlases.find((file) => stemOf(file.name).toLowerCase() === stem);
  if (exact) return exact;
  if (atlases.length === 1) return atlases[0];
  return null;
}
