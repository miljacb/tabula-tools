/**
 * The exporter page's /api/ on the website, where there is no server: the same requests as
 * src/cli/app/server.ts, answered by a worker (worker.ts) over a folder the user picked or dropped.
 * The project stays in memory: settings last for the session and come with the download.
 */

import type { WebRequest, WebResponse } from './protocol';
import ExportWorker from './worker.ts?worker';

type Op = WebRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

let worker: Worker | null = null;
let nextId = 1;
let folder: string | null = null;

/** One request to the worker; `onEvent` gets the export's progress on the way. */
function call<T>(op: Op, onEvent?: (event: unknown) => void): Promise<T> {
  const w = (worker ??= new ExportWorker());
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const done = (): void => {
      w.removeEventListener('message', listen);
      w.removeEventListener('error', crash);
    };
    const listen = ({ data }: MessageEvent<WebResponse>): void => {
      if (data.id !== id) return;
      if ('event' in data) return void onEvent?.(data.event);
      done();
      if ('error' in data) reject(new Error(data.error));
      else resolve(data.value as T);
    };
    // The worker failed to load or threw outside a request: fail instead of waiting forever.
    const crash = (e: ErrorEvent): void => {
      done();
      reject(new Error(e.message || 'The export worker failed to start'));
    };
    w.addEventListener('message', listen);
    w.addEventListener('error', crash);
    w.postMessage({ ...op, id });
  });
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/** Load a folder's files (paths relative to the folder) as the project. */
export async function openWebFolder(name: string, files: [string, Blob][]): Promise<void> {
  await call({ op: 'load', name, files });
  folder = name;
}

/** The last export with the settings, as a zip to save. */
export async function downloadExport(): Promise<{ name: string; blob: Blob }> {
  return { name: `${folder ?? 'project'}-export.zip`, blob: await call<Blob>({ op: 'download' }) };
}

/** `fetch` for the page's /api/ requests (see server.ts for what each one returns). */
export async function webFetch(href: string, init: RequestInit = {}): Promise<Response> {
  const { pathname: url, searchParams } = new URL(href, 'http://local');
  const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
  try {
    if (url === '/api/state') return json({ project: folder, recent: [], select: null });
    if (!folder) return json({ error: 'No project is open' }, 409);
    if (url === '/api/project') return json(await call({ op: 'project' }));
    if (url === '/api/files') return json(await call({ op: 'files' }));
    if (url === '/api/file') {
      try {
        return new Response(await call<Blob>({ op: 'file', root: searchParams.get('root') === 'out' ? 'out' : 'src', path: searchParams.get('path') ?? '' }));
      } catch (err) {
        return json({ error: (err as Error).message }, 404);
      }
    }
    if (url === '/api/config') return json(await call({ op: 'config', config: body }));
    if (url === '/api/export') {
      // NDJSON as the server streams it: the events, then done or failed.
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const line = (value: unknown): void => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
          call({ op: 'export', compress: body.compress as string[] | undefined, skeletons: body.skeletons as string[] | undefined }, line).then(
            (report) => line({ type: 'done', report }),
            (err: Error) => line({ type: 'failed', error: err.message }),
          ).finally(() => controller.close());
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    return json({ error: `Unknown request ${url}` }, 404);
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }
}

/** Is there a server behind /api/ (desktop app, `tabula app`, the Vite dev server), or is this the website? */
export async function hasServer(): Promise<boolean> {
  try {
    const res = await fetch('/api/state');
    return res.ok && (res.headers.get('Content-Type') ?? '').includes('application/json');
  } catch {
    return false;
  }
}
