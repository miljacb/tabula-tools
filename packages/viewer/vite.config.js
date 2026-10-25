import { defineConfig } from 'vite';

/** Cross-origin isolation: lets the Performance panel call performance.measureUserAgentSpecificMemory(). */
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Served under /viewer/ on the tools site (see the root netlify.toml).
  base: '/viewer/',
  resolve: { dedupe: ['pixi.js'] },
  // Fixed port: the homepage dev server (packages/site) proxies /viewer/ here.
  server: { port: 5181, strictPort: true, headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('pixi.js') || id.includes('/@pixi/')) return 'pixi';
          if (id.includes('tabula-pixi')) return 'tabula';
          return undefined;
        },
      },
    },
  },
});
