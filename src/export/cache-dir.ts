/** Where the tools cache what they download or compute (the `ktx` encoder, Google Fonts, KTX2 encodings). */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `$TABULA_CACHE_DIR`, else `.cache/tabula` in the nearest `node_modules`
 * above `from` (default: this package, so a project folder the tools work
 * on never gets a cache), else in `<from>/node_modules`. The desktop app
 * sets `$TABULA_CACHE_DIR` to its user data folder.
 */
export function toolsCacheDir(from = dirname(fileURLToPath(import.meta.url))): string {
  if (process.env.TABULA_CACHE_DIR) return process.env.TABULA_CACHE_DIR;
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules'))) return join(dir, 'node_modules', '.cache', 'tabula');
    if (dirname(dir) === dir) return join(resolve(from), 'node_modules', '.cache', 'tabula');
  }
}
