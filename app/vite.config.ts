import { defineConfig } from 'vite';
import { resolve } from 'path';
import { createAppHandler } from '../src/cli/app/server.js';

/**
 * The Tabula app page. `pnpm app` serves it with the project API on
 * TABULA_PROJECT (default: tests/assets/); `pnpm app:build` writes
 * dist-app/, which `tabula app <folder>` serves.
 */
export default defineConfig({
  root: resolve(__dirname),
  plugins: [{
    name: 'tabula-app-api',
    configureServer(server) {
      const projectDir = process.env.TABULA_PROJECT ?? resolve(__dirname, '../tests/assets');
      // The repo's test assets export to the cache, not into the repo.
      const outDir = process.env.TABULA_PROJECT ? undefined : resolve(__dirname, '../node_modules/.cache/tabula-app-export');
      server.middlewares.use(createAppHandler({ projectDir, outDir }));
    },
  }],
  // One Pixi for the app and the tabula-pixi runtime.
  resolve: { dedupe: ['pixi.js'] },
  server: { port: 43301 },
  build: { outDir: resolve(__dirname, '../dist-app'), emptyOutDir: true },
});
