/**
 * `tabula app [folder]`: open the Tabula app. Starts a local server
 * (127.0.0.1 only) with the built app page (dist-app/) and the project API
 * (see server.ts), then opens the browser. Without a folder the page shows
 * its start screen (recent projects, or a folder path). The desktop app
 * (desktop/main.mjs) starts the same server with {@link startAppServer}.
 */

import { createServer } from 'node:http';
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
  /** Recent projects file (default `~/.tbin/recent.json`). */
  recentFile?: string;
}

/** Options for {@link appCommand}. */
export interface AppCommandOptions extends Omit<AppServerStartOptions, 'projectDir'> {
  /** Do not open the browser. */
  noOpen?: boolean;
}

const STATIC_TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png' };

/** Start the app server on 127.0.0.1; resolves once listening. */
export async function startAppServer(options: AppServerStartOptions = {}): Promise<{ url: string; handler: AppHandler; close: () => void }> {
  if (options.projectDir && !existsSync(options.projectDir)) throw new Error(`Folder not found: ${resolve(options.projectDir)}`);
  const pageDir = findPageDir();
  if (!pageDir) throw new Error('The app page is not built: run "npm run app:build" in the tabula-tools package');
  const handler = createAppHandler({ projectDir: options.projectDir, outDir: options.outDir, recentFile: options.recentFile });
  const server = createServer((req, res) => {
    handler(req, res, () => {
      const path = new URL(req.url ?? '/', 'http://local').pathname;
      const file = resolve(pageDir, `.${path === '/' ? '/index.html' : decodeURIComponent(path)}`);
      if (!file.startsWith(pageDir + sep)) {
        res.writeHead(404).end();
        return;
      }
      readFile(file).then((bytes) => {
        res.writeHead(200, { 'Content-Type': STATIC_TYPES[file.slice(file.lastIndexOf('.') + 1)] ?? 'application/octet-stream' });
        res.end(bytes);
      }, () => res.writeHead(404).end('Not found'));
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
  console.log(`Tabula app: ${url}  (${folder ? `project ${resolve(folder)}` : 'open a project in the page'}; Ctrl+C to stop)`);
  if (!options.noOpen) openBrowser(url);
  return url;
}

function findPageDir(): string | null {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'dist-app');
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}
