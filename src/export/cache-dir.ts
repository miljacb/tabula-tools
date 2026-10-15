/** Where the tools cache downloads (the `ktx` encoder, Google Fonts). */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * `$TABULA_CACHE_DIR`, else `.cache/tabula` in the nearest `node_modules`
 * above `from` (default: the working directory), else in `<from>/node_modules`.
 */
export function toolsCacheDir(from = process.cwd()): string {
  if (process.env.TABULA_CACHE_DIR) return process.env.TABULA_CACHE_DIR;
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules'))) return join(dir, 'node_modules', '.cache', 'tabula');
    if (dirname(dir) === dir) return join(resolve(from), 'node_modules', '.cache', 'tabula');
  }
}
