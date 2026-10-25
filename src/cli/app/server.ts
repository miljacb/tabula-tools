/**
 * The Tabula app's server side: a request handler over the open project
 * folder. The app page (app/) calls it to open a project, read it, save its
 * settings, run an export with live progress, and load the source and
 * exported files for the preview. Used by `tabula app` (plain Node http), the
 * desktop app (desktop/) and the app's Vite dev server (as middleware).
 *
 *   GET  /api/state            { project: folder or null, recent: folders }
 *   POST /api/open             { dir } → open a project folder (a file: its folder)
 *   GET  /api/project          assets, settings, last export report (409 without a project)
 *   PUT  /api/config           save tabula.config.json
 *   POST /api/export           { compress?: string[] } → NDJSON events, then { type: 'done', report } or { type: 'failed', error }
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { PROJECT_CONFIG_FILE, loadProjectConfig, validateProjectConfig } from '../../export/config.js';
import { exportProject } from '../../export/export-project.js';
import type { ExportEvent } from '../../export/export-project.js';
import { readProject } from './project.js';

export type { AppBundle, AppProject, AppSkeleton } from './project.js';

/** Options for {@link createAppHandler}. */
export interface AppServerOptions {
  /** Project folder to open at start (else the page shows its start screen). */
  projectDir?: string;
  /** Export folder of `projectDir` (default `<project>/tabula-export`; other projects always use that). */
  outDir?: string;
  /** Where the recent projects are kept (default `~/.tabula/recent.json`). */
  recentFile?: string;
}

/** Connect-style handler (`next` for requests it does not serve), with `open` to switch the project. */
export type AppHandler = ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) & {
  /** Open a project folder (a file: its folder); remembered in the recent projects. */
  open(dir: string): Promise<string>;
  /** The open project folder, or null. */
  readonly project: string | null;
};

const MAX_RECENT = 10;

/** The request handler of the app (see the module comment). */
export function createAppHandler(options: AppServerOptions = {}): AppHandler {
  const initial = options.projectDir ? resolve(options.projectDir) : null;
  const recentFile = options.recentFile ?? join(homedir(), '.tabula', 'recent.json');
  let projectDir: string | null = null;
  /** A `.tbla` opened directly: the page selects it. */
  let selectBundle: string | null = null;
  let outDir = '';
  let running = false;

  const readRecent = async (): Promise<string[]> => {
    // A missing or damaged file (empty after an interrupted write) is no recent projects, not a dead server.
    const list = await readFile(recentFile, 'utf-8').then((t) => JSON.parse(t) as unknown).catch(() => []);
    return Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string' && existsSync(d)) : [];
  };
  const open = async (dir: string): Promise<string> => {
    let folder = resolve(dir);
    const info = await stat(folder).catch(() => null);
    if (!info) throw new Error(`Not found: ${folder}`);
    selectBundle = null;
    if (!info.isDirectory()) {
      if (folder.toLowerCase().endsWith('.tbla')) selectBundle = folder;
      folder = dirname(folder);
    }
    if (running) throw new Error('An export is running; open the folder when it is done');
    projectDir = folder;
    outDir = resolve(folder === initial && options.outDir ? options.outDir : join(folder, 'tabula-export'));
    const recent = [folder, ...(await readRecent()).filter((d) => d !== folder)].slice(0, MAX_RECENT);
    await mkdir(dirname(recentFile), { recursive: true });
    await writeFile(recentFile, `${JSON.stringify(recent, null, 1)}\n`).catch(() => undefined);
    return folder;
  };
  const ready = initial ? open(initial) : Promise.resolve(null);

  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    await ready;
    const url = new URL(req.url ?? '/', 'http://local');
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/state' && req.method === 'GET') {
      return sendJson(res, { project: projectDir, recent: await readRecent(), select: projectDir && selectBundle ? relative(projectDir, selectBundle).split(sep).join('/') : null });
    }
    if (path === '/api/open' && req.method === 'POST') {
      const { dir } = JSON.parse(await readBody(req)) as { dir?: string };
      if (!dir) return sendJson(res, { error: 'No folder given' }, 400);
      try {
        const project = await open(dir);
        return sendJson(res, { project, select: selectBundle ? relative(project, selectBundle).split(sep).join('/') : null });
      } catch (err) {
        return sendJson(res, { error: (err as Error).message }, 400);
      }
    }
    if (!projectDir) {
      if (path.startsWith('/api/')) return sendJson(res, { error: 'No project is open' }, 409);
      return next();
    }
    if (path === '/api/project' && req.method === 'GET') return sendJson(res, await readProject(projectDir, outDir));
    if (path === '/api/config' && req.method === 'PUT') {
      const config = validateProjectConfig(JSON.parse(await readBody(req)));
      await writeFile(join(projectDir, PROJECT_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
      return sendJson(res, config);
    }
    if (path === '/api/export' && req.method === 'POST') {
      if (running) return sendJson(res, { error: 'An export is already running' }, 409);
      const body = JSON.parse((await readBody(req)) || '{}') as { compress?: string[] };
      running = true;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      const line = (value: unknown): void => void res.write(`${JSON.stringify(value)}\n`);
      const sourceDir = projectDir;
      try {
        const report = await exportProject({
          sourceDir, outDir, config: await loadProjectConfig(projectDir), compress: body.compress,
          onEvent: (event: ExportEvent) => line(event),
        });
        line({ type: 'done', report: { ...report, manifest: undefined } });
      } catch (err) {
        line({ type: 'failed', error: (err as Error).message });
      } finally {
        running = false;
        res.end();
      }
      return;
    }
    next();
  };

  const handler = ((req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    handle(req, res, next).catch((err: Error) => {
      if (!res.headersSent) sendJson(res, { error: err.message }, 500);
      else res.end();
    });
  }) as AppHandler;
  handler.open = open;
  Object.defineProperty(handler, 'project', { get: () => projectDir });
  return handler;
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 1e6) reject(new Error('Request too large'));
    });
    req.on('end', () => resolveBody(body));
    req.on('error', reject);
  });
}
