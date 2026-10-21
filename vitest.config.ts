import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { dedupe: ['pixi.js'] },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
