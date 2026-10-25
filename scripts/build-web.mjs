// Builds the tools site into dist-web/: the homepage at the root, each web tool under its own path.
// Netlify publishes it; the desktop app and `tabula app` serve it too, with the exporter's server API.
import { execSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const out = 'dist-web';
rmSync(out, { recursive: true, force: true });
execSync('node scripts/build-docs.mjs', { stdio: 'inherit' });
cpSync('packages/site', out, { recursive: true, filter: (src) => !/(package\.json|vite\.config\.js|node_modules)$/.test(src) });

// Link previews need an absolute og:image; Netlify sets URL to the site's address.
if (process.env.URL) {
  const site = process.env.URL.replace(/\/$/, '');
  const home = `${out}/index.html`;
  writeFileSync(home, readFileSync(home, 'utf8').replace('content="/og.png"', `content="${site}/og.png" />\n  <meta property="og:url" content="${site}/"`));
}

execSync('pnpm --filter tabula-viewer build', { stdio: 'inherit' });
cpSync('packages/viewer/dist', `${out}/viewer`, { recursive: true });

// The exporter: on the website it runs in the page (app/web/); locally the server serves dist-app at /exporter/ itself.
execSync('pnpm app:build', { stdio: 'inherit' });
cpSync('dist-app', `${out}/exporter`, { recursive: true });
