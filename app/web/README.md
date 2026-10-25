# app/web: the exporter on the website

Where there is no server (the Netlify site, `pnpm dev`), the exporter page answers its own `/api/`
requests (`api.ts`) with a worker (`worker.ts`) that runs the same code as the local server:
`src/cli/app/project.ts` and the export engine in `src/export/`. The project folder is picked or
dropped into the page and held in memory; nothing is uploaded. The export downloads as a zip
(`tabula-export/` plus `tabula.config.json`). KTX2 is off: it needs the native `ktx` tool (desktop app).

`shims/` and `browser-shims.mjs` are copied from Tabula Studio (`lib/tabula-export-web/`,
`build/tabla-browser-plugin.mjs`, at 608b687): browser stand-ins for `node:*` and `sharp`, applied only
to imports made from `src/`. A temporary copy, to be replaced by a shared package; copy Studio's
fixes across until then. `png.ts` and `sharp.ts` are checked with Studio's TypeScript settings
(`shims/tsconfig.json`).
