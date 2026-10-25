// Vite worker plugin for the web exporter (after Tabula Studio's build/tabla-browser-plugin.mjs): imports of node:*
// and sharp made by the engine and the project reader (src/) resolve to the browser shims in app/web/shims, so the
// same code runs in Node (CLI, desktop app) and in the web worker. Other node:* imports fail the build.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const engine = path.join(root, 'src');
const shims = path.join(root, 'app/web/shims');
const targets = {
  'node:fs': 'memfs.ts', 'node:fs/promises': 'memfs.ts', 'node:path': 'path.ts', sharp: 'sharp.ts',
  'node:os': 'node-stubs.ts', 'node:url': 'node-stubs.ts', 'node:util': 'node-stubs.ts', 'node:crypto': 'node-stubs.ts',
  'node:child_process': 'node-stubs.ts', 'node:module': 'node-stubs.ts',
};

export function browserShims() {
  return {
    name: 'tabula-browser-shims',
    enforce: 'pre',
    resolveId(id, importer) {
      const from = importer?.split('?')[0];
      if (!from || !path.resolve(from).startsWith(engine + path.sep)) return null;
      const target = targets[id];
      if (target) return path.join(shims, target);
      if (id.startsWith('node:')) throw new Error(`${id} has no browser shim (imported by ${path.relative(root, from)})`);
      return null;
    },
  };
}
