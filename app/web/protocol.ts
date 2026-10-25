// Messages between the web exporter page (api.ts) and its worker (worker.ts).
import type { ExportEvent } from '../../src/export/export-project.js';
import type { TabulaProjectConfig } from '../../src/export/config.js';

export type WebRequest = { id: number } & (
  | { op: 'load'; name: string; files: [string, Blob][] }
  | { op: 'project' }
  | { op: 'config'; config: TabulaProjectConfig }
  | { op: 'export'; compress?: string[] }
  | { op: 'download' }
);

/** A result (`value`), a failure (`error`), or an export event on the way (`event`). */
export type WebResponse = { id: number } & ({ value: unknown } | { error: string } | { event: ExportEvent });
