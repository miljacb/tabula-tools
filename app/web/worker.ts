/**
 * The web exporter's worker: the project folder lives here in memory (shims/memfs.ts) and the same
 * code the local server runs (src/cli/app/project.ts, src/export/) reads and exports it, with node:*
 * and sharp redirected to shims/ by browser-shims.mjs. KTX2 needs the native `ktx` tool, so it is
 * off here (the desktop app has it).
 */

import './shims/globals';
import { zipSync, type Zippable } from 'fflate';
import { memfs, rm } from './shims/memfs';
import { readProject } from '../../src/cli/app/project.js';
import { exportProject, type ExportEvent } from '../../src/export/export-project.js';
import { PROJECT_CONFIG_FILE, loadProjectConfig, validateProjectConfig, type TabulaProjectConfig } from '../../src/export/config.js';
import type { WebRequest, WebResponse } from './protocol';

const ROOT = '/project';
const OUT = `${ROOT}/tabula-export`;
let folder = 'project';

const port = globalThis as unknown as { onmessage: (event: MessageEvent<WebRequest>) => void; postMessage: (message: WebResponse, transfer?: Transferable[]) => void };

/** The settings with KTX2 off everywhere; true when they asked for it. */
function withoutKtx2(config: TabulaProjectConfig): { config: TabulaProjectConfig; asked: boolean } {
  type Group = NonNullable<NonNullable<TabulaProjectConfig['atlas']>['groups']>[number] & { ktx2?: string; pages?: Record<string, string> };
  const groups = (config.atlas?.groups ?? []) as Group[];
  const asked = (!!config.ktx2 && config.ktx2 !== 'none') || groups.some((g) => (g.ktx2 && g.ktx2 !== 'none') || Object.values(g.pages ?? {}).some((c) => c !== 'none'));
  return {
    asked,
    config: { ...config, ktx2: 'none', atlas: config.atlas && { ...config.atlas, groups: groups.map((g) => ({ ...g, ktx2: 'none', pages: undefined })) } },
  };
}

async function handle(request: WebRequest, event: (e: ExportEvent) => void): Promise<unknown> {
  switch (request.op) {
    case 'load': {
      memfs.clear();
      folder = request.name;
      for (const [path, blob] of request.files) memfs.write(`${ROOT}/${path}`, new Uint8Array(await blob.arrayBuffer()));
      return null;
    }
    case 'project':
      return { ...(await readProject(ROOT, OUT)), dir: folder, outDir: `${folder}/tabula-export` };
    case 'config': {
      const config = validateProjectConfig(request.config);
      memfs.write(`${ROOT}/${PROJECT_CONFIG_FILE}`, `${JSON.stringify(config, null, 2)}\n`);
      return config;
    }
    case 'export': {
      const { config, asked } = withoutKtx2(await loadProjectConfig(ROOT));
      if (asked) event({ type: 'warning', message: 'KTX2 pages need the desktop app: exported as images only.' });
      await rm(OUT); // the download holds this export only
      const report = await exportProject({ sourceDir: ROOT, outDir: OUT, cacheDir: '/cache', config, compress: request.compress, skeletons: request.skeletons, onEvent: event, encodeKtx2: async () => null });
      return { ...report, manifest: undefined };
    }
    case 'files':
      return memfs.list(OUT);
    case 'file':
      return new Blob([memfs.read(`${request.root === 'out' ? OUT : ROOT}/${request.path}`).slice()]);
    case 'download': {
      // The export folder plus the settings, laid out as in the project folder.
      const entries: Zippable = {};
      for (const path of memfs.list(OUT)) entries[`${folder}/tabula-export/${path}`] = [memfs.read(`${OUT}/${path}`), { level: 0 }];
      try {
        entries[`${folder}/${PROJECT_CONFIG_FILE}`] = memfs.read(`${ROOT}/${PROJECT_CONFIG_FILE}`);
      } catch {
        /* no settings saved */
      }
      // zipSync allocates exactly the zip's size: its buffer is the zip, no copy needed.
      return new Blob([zipSync(entries).buffer as ArrayBuffer], { type: 'application/zip' });
    }
  }
}

port.onmessage = ({ data }) => {
  const event = (e: ExportEvent): void => port.postMessage({ id: data.id, event: e });
  handle(data, event).then(
    (value) => port.postMessage({ id: data.id, value }),
    (err: unknown) => port.postMessage({ id: data.id, error: err instanceof Error ? err.message : String(err) }),
  );
};
