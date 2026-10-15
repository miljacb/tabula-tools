import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** The runtime from source (../tabula-pixi/src), so tests need no tabula-pixi build. */
const pixi = (path: string): string => fileURLToPath(new URL(`../tabula-pixi/src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^tabula-pixi\/core\//, replacement: pixi('core/') },
      { find: /^tabula-pixi\/json$/, replacement: pixi('pixi-v7/json.ts') },
      { find: /^tabula-pixi$/, replacement: pixi('pixi-v7/index.ts') },
    ],
    dedupe: ['pixi.js'],
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
