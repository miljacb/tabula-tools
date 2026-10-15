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
 *   GET  /files/src/<path>     project files
 *   GET  /files/out/<path>     export files
 *   GET  /basis/<file>         Basis transcoder (KTX2 preview)
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpineJsonParser } from 'tabula-pixi/core/adapters/spine-json-parser.js';
import { AtlasParser } from 'tabula-pixi/core/adapters/atlas-parser.js';
import { validateSkeleton } from 'tabula-pixi/core/validate.js';
import { inspectBundle } from '../commands/inspect.js';
import { PROJECT_CONFIG_FILE, loadProjectConfig, validateProjectConfig } from '../../export/config.js';
import { MANIFEST_FILE, REPORT_FILE, discoverProject, exportProject } from '../../export/export-project.js';
import type { ExportEvent } from '../../export/export-project.js';

/** Options for {@link createAppHandler}. */
export interface AppServerOptions {
  /** Project folder to open at start (else the page shows its start screen). */
  projectDir?: string;
  /** Export folder of `projectDir` (default `<project>/tabula-export`; other projects always use that). */
  outDir?: string;
  /** Where the recent projects are kept (default `~/.tabula/recent.json`). */
  recentFile?: string;
  /** Folder with basis_transcoder.js / .wasm (default: tabula-pixi's vendor/basis). */
  basisDir?: string;
}

/** A skeleton as the app lists it. */
export interface AppSkeleton {
  name: string;
  /** Paths relative to the project. */
  json: string;
  atlas: string;
  spineVersion: string;
  animations: string[];
  skins: string[];
  errors: string[];
  warnings: string[];
  /** JSON + atlas + page bytes. */
  bytes: number;
  pages: string[];
}

/** GET /api/project. */
export interface AppProject {
  dir: string;
  outDir: string;
  config: unknown;
  skeletons: AppSkeleton[];
  sprites: string[];
  fonts: string[];
  /** Spine binary exports (not supported). */
  skel: string[];
  /** Last export (export-report.json), if any. */
  report: unknown;
  /** The export folder has a manifest (the preview can load exported assets). */
  exported: boolean;
  /** `.tbla` bundles in the project folder (outside the export), e.g. sent by a designer. */
  bundles: AppBundle[];
}

/** A `.tbla` in the project, as the app lists it. */
export interface AppBundle {
  /** Relative to the project. */
  path: string;
  bytes: number;
  meta: Record<string, unknown>;
  /** Assets of its manifest (a self-contained bundle), else null. */
  members: { skeletons: string[]; sprites: string[]; images: string[]; fonts: string[] } | null;
  files: { path: string; bytes: number }[];
  /** Why it could not be read (damaged, not a bundle). */
  error?: string;
}

const TYPES: Record<string, string> = {
  json: 'application/json', atlas: 'text/plain', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  ktx2: 'image/ktx2', tbla: 'application/octet-stream', tabula: 'application/octet-stream', baked: 'application/octet-stream', wasm: 'application/wasm', js: 'text/javascript',
};

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
  const basisDir = options.basisDir ?? findBasisDir();
  let projectDir: string | null = null;
  /** A `.tbla` opened directly: the page selects it. */
  let selectBundle: string | null = null;
  let outDir = '';
  let running = false;

  const readRecent = async (): Promise<string[]> => {
    const list = await readFile(recentFile, 'utf-8').then((t) => JSON.parse(t) as unknown, () => []);
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
      if (path.startsWith('/api/') || path.startsWith('/files/')) return sendJson(res, { error: 'No project is open' }, 409);
      if (path.startsWith('/basis/') && basisDir) return sendFile(res, basisDir, path.slice('/basis/'.length), next);
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
    if (path.startsWith('/files/src/')) return sendFile(res, projectDir, path.slice('/files/src/'.length), next);
    if (path.startsWith('/files/out/')) return sendFile(res, outDir, path.slice('/files/out/'.length), next);
    if (path.startsWith('/basis/') && basisDir) return sendFile(res, basisDir, path.slice('/basis/'.length), next);
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

/** Everything the app lists for the project folder. */
export async function readProject(projectDir: string, outDir: string): Promise<AppProject> {
  const files = await discoverProject(projectDir, outDir);
  const rel = (p: string): string => relative(projectDir, p).split(sep).join('/');
  const skeletons: AppSkeleton[] = [];
  for (const s of files.skeletons) {
    const entry: AppSkeleton = { name: s.name, json: rel(s.json), atlas: rel(s.atlas), spineVersion: '', animations: [], skins: [], errors: [], warnings: [], bytes: 0, pages: [] };
    skeletons.push(entry);
    try {
      const json = JSON.parse(await readFile(s.json, 'utf-8')) as { skeleton?: { spine?: string } };
      entry.spineVersion = String(json.skeleton?.spine ?? '');
      entry.bytes += (await stat(s.json)).size;
      const atlasText = await readFile(s.atlas, 'utf-8').catch(() => null);
      if (atlasText === null) throw new Error(`no ${rel(s.atlas)}`);
      entry.bytes += Buffer.byteLength(atlasText);
      const atlas = new AtlasParser().parse(atlasText);
      for (const page of atlas.pages) {
        entry.pages.push(page.name);
        const size = (await stat(join(dirname(s.atlas), page.name)).catch(() => null))?.size;
        if (size === undefined) entry.errors.push(`page ${page.name} is missing`);
        else entry.bytes += size;
      }
      const data = new SpineJsonParser().parse(json, s.name);
      entry.animations = data.animations.map((a) => a.name);
      entry.skins = data.skins.map((k) => k.name);
      const validation = validateSkeleton(data, atlas);
      entry.errors.push(...validation.errors);
      entry.warnings.push(...validation.warnings);
    } catch (err) {
      entry.errors.push((err as Error).message);
    }
  }
  const report = await readFile(join(outDir, REPORT_FILE), 'utf-8').then((t) => JSON.parse(t) as unknown, () => null);
  const bundles: AppBundle[] = [];
  for (const file of files.bundles) {
    try {
      const info = await inspectBundle(file);
      bundles.push({ path: rel(file), bytes: info.bytes, meta: info.meta, members: info.members, files: info.files });
    } catch (err) {
      bundles.push({ path: rel(file), bytes: 0, meta: {}, members: null, files: [], error: (err as Error).message });
    }
  }
  return {
    dir: projectDir, outDir, config: await loadProjectConfig(projectDir).catch((err: Error) => ({ error: err.message })),
    skeletons, sprites: files.sprites.map(rel), fonts: files.fonts.map(rel), skel: files.skel.map(rel),
    report, exported: existsSync(join(outDir, MANIFEST_FILE)), bundles,
  };
}

/** tabula-pixi's vendored Basis transcoder (the `tabula-pixi/basis/*` export). */
function findBasisDir(): string | undefined {
  try {
    const wasm = fileURLToPath(import.meta.resolve('tabula-pixi/basis/basis_transcoder.wasm'));
    return existsSync(wasm) ? dirname(wasm) : undefined;
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function sendFile(res: ServerResponse, root: string, path: string, next: () => void): Promise<void> {
  const file = resolve(root, path);
  if (file !== root && !file.startsWith(root + sep)) return next(); // no ../ out of the folder
  const bytes = await readFile(file).catch(() => null);
  if (!bytes) return next();
  res.writeHead(200, { 'Content-Type': TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(bytes);
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
