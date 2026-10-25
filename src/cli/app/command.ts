/**
 * `tabula app [folder]`: open Tabula Tools. Starts a local server (127.0.0.1
 * only) with the tools site (dist-web/: the homepage at /, the viewer at
 * /viewer/), the exporter page (dist-app/) at /exporter/ and its project API
 * (see server.ts), then opens the homepage in the browser. A folder given is
 * opened as the exporter's project. The desktop app (desktop/main.mjs) starts
 * the same server with {@link startAppServer}.
 */

import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppHandler } from './server.js';
import type { AppHandler } from './server.js';

/** Options for {@link startAppServer}. */
export interface AppServerStartOptions {
  /** Project folder to open at start. */
  projectDir?: string;
  /** Export folder of `projectDir` (default `<folder>/tabula-export`). */
  outDir?: string;
  /** Port (default 43300; 0 = any free port). */
  port?: number;
  /** Recent projects file (default `~/.tabula/recent.json`). */
  recentFile?: string;
}

/** Options for {@link appCommand}. */
export interface AppCommandOptions extends Omit<AppServerStartOptions, 'projectDir'> {
  /** Do not open the browser. */
  noOpen?: boolean;
}

const STATIC_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png',
  json: 'application/json', wasm: 'application/wasm', webmanifest: 'application/manifest+json', atlas: 'text/plain',
};

/** Same as the root netlify.toml: cross-origin isolation for the viewer's memory measurement. */
const VIEWER_HEADERS = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

/** Start the app server on 127.0.0.1; resolves once listening. */
export async function startAppServer(options: AppServerStartOptions = {}): Promise<{ url: string; handler: AppHandler; close: () => void }> {
  if (options.projectDir && !existsSync(options.projectDir)) throw new Error(`Folder not found: ${resolve(options.projectDir)}`);
  const pageDir = findBuildDir('dist-app');
  if (!pageDir) throw new Error('The exporter page is not built: run "pnpm app:build" in the tabula-tools package');
  const siteDir = findBuildDir('dist-web');
  if (!siteDir) throw new Error('The tools site is not built: run "pnpm build:web" in the tabula-tools package');
  const handler = createAppHandler({ projectDir: options.projectDir, outDir: options.outDir, recentFile: options.recentFile });
  const server = createServer((req, res) => {
    handler(req, res, () => {
      let path: string;
      try {
        path = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
      } catch {
        return void res.writeHead(400).end('Bad request'); // malformed %-escape
      }
      if (path === '/exporter' || path === '/viewer') return void res.writeHead(301, { Location: `${path}/` }).end();
      if (path.startsWith('/exporter/')) return void sendStatic(res, pageDir, path.slice('/exporter'.length), '/index.html');
      // The viewer is a single-page app: unknown paths under it get its page.
      if (path.startsWith('/viewer/')) return void sendStatic(res, siteDir, path, '/viewer/index.html', VIEWER_HEADERS);
      sendStatic(res, siteDir, path);
    });
  });
  const port = options.port ?? 43300;
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}/`;
  return { url, handler, close: () => server.close() };
}

/** `tabula app [folder]`: start the server and open the browser. Resolves with the URL. */
export async function appCommand(folder: string | undefined, options: AppCommandOptions = {}): Promise<string> {
  const { url } = await startAppServer({ ...options, projectDir: folder });
  console.log(`Tabula Tools: ${url}  (${folder ? `exporter project ${resolve(folder)}` : 'exporter at /exporter/'}; Ctrl+C to stop)`);
  if (!options.noOpen) openBrowser(url);
  return url;
}

/**
 * Serve `path` from `root` (a folder path gets its index.html). A missing file gets `fallback`
 * when one is given (a single-page app's page), or a 404.
 */
async function sendStatic(res: ServerResponse, root: string, path: string, fallback?: string, headers: Record<string, string> = {}): Promise<void> {
  const fileFor = (p: string): string | null => {
    const file = resolve(root, `.${p.endsWith('/') ? `${p}index.html` : p}`);
    return file.startsWith(root + sep) ? file : null;
  };
  for (const file of [fileFor(path), fallback ? fileFor(fallback) : null]) {
    if (!file) continue;
    try {
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[file.slice(file.lastIndexOf('.') + 1)] ?? 'application/octet-stream', ...headers });
      res.end(bytes);
      return;
    } catch {
      /* try the fallback */
    }
  }
  // The site's own 404 page when the root has one (dist-web does), like Netlify.
  try {
    const page = await readFile(join(root, '404.html'));
    res.writeHead(404, { 'Content-Type': STATIC_TYPES.html }).end(page);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

/** The nearest `name` build folder (with an index.html) above this module: the package root when installed or packaged. */
function findBuildDir(name: string): string | null {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, name);
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}
