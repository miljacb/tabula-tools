/**
 * `src/core/` is a copy of the tabula-pixi modules the engine uses (see
 * README). This test fails when a copy and its tabula-pixi source differ, so
 * a change made in one place is carried to the other. Skipped when the
 * tabula-pixi checkout is not next to this folder.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../tabula-pixi/src/core/', import.meta.url));
const COPY = fileURLToPath(new URL('../src/core/', import.meta.url));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const files = walk(COPY).map((path) => relative(COPY, path)).filter((f) => f.endsWith('.ts'));

describe.skipIf(!existsSync(SRC))('vendored core matches tabula-pixi', () => {
  it('has the same files', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  it.each(files)('%s', (file) => {
    expect(readFileSync(COPY + file, 'utf8')).toBe(readFileSync(SRC + file, 'utf8'));
  });
});
