import { defineConfig } from 'vite';

// Dev only: the homepage at /, with /viewer/ and /exporter/ passed through to their dev servers,
// so the local site has the same layout as the deployed one. /api/ is not passed on: the exporter
// runs in web mode here, as on the website (the app's own server, :43301/exporter/, has the API).
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    open: '/',
    proxy: {
      '/viewer': { target: 'http://localhost:5181', ws: true },
      '/exporter': { target: 'http://localhost:43301', ws: true },
    },
  },
});
