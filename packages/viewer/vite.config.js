import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { dedupe: ['pixi.js'] },
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
