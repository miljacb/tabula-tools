import { importFiles } from './session.js';

/**
 * @param {DataTransfer | null} transfer
 */
function isFileDrag(transfer) {
  if (!transfer) return false;
  const types = [...transfer.types];
  return types.includes('Files') || transfer.files.length > 0;
}

/**
 * @param {DataTransfer | null} transfer
 * @returns {Promise<File[]>}
 */
export async function collectFilesFromDataTransfer(transfer) {
  if (!transfer) return [];
  /** @type {File[]} */
  const files = [];
  const entries = [...transfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    for (const entry of entries) await walkEntry(entry, files);
  }
  if (!files.length) files.push(...transfer.files);
  return files;
}

/** @param {FileSystemEntry} entry @param {File[]} out */
function walkEntry(entry, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        // Dropped folders: keep the path inside the folder, which an export's files are matched by.
        Object.defineProperty(file, 'viewerPath', { value: entry.fullPath.replace(/^\//, '') });
        out.push(file);
        resolve();
      });
      return;
    }
    if (!entry.isDirectory) {
      resolve();
      return;
    }
    const reader = entry.createReader();
    const batch = () => {
      reader.readEntries(async (entries) => {
        if (!entries.length) {
          resolve();
          return;
        }
        for (const child of entries) await walkEntry(child, out);
        batch();
      });
    };
    batch();
  });
}

/** Block Chrome from opening dropped files in new tabs. */
export function bindFileDrop() {
  const allowDrop = (event) => {
    const transfer = event.dataTransfer;
    if (!isFileDrag(transfer)) return;
    event.preventDefault();
    if (transfer) transfer.dropEffect = 'copy';
  };

  document.addEventListener('dragenter', allowDrop, true);
  document.addEventListener('dragover', allowDrop, true);

  document.addEventListener('drop', (event) => {
    const transfer = event.dataTransfer;
    if (!isFileDrag(transfer)) return;
    event.preventDefault();
    event.stopPropagation();
    void collectFilesFromDataTransfer(transfer).then((files) => {
      if (files.length) void importFiles(files);
    });
  }, true);
}
