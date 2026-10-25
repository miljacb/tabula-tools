// Copies the tabula-pixi runtime docs (docs/api + the images they use) into docs/runtime/,
// so the tools site can render them without the sibling repo. Run after the runtime docs change:
//   pnpm docs:runtime [path/to/tabula-pixi]   (default ../tabula-pixi)
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pixi = resolve(root, process.argv[2] ?? '../tabula-pixi');
const out = join(root, 'docs/runtime');
if (!existsSync(join(pixi, 'docs/api'))) throw new Error(`no docs/api in ${pixi}`);

rmSync(out, { recursive: true, force: true });
cpSync(join(pixi, 'docs/api'), join(out, 'api'), { recursive: true, filter: (src) => !src.includes('.') || src.endsWith('.md') });

// Only the images the copied pages reference.
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
let images = 0;
for (const file of walk(join(out, 'api'))) {
  for (const [, src] of readFileSync(file, 'utf8').matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
    if (/^[a-z]+:/i.test(src)) continue;
    const rel = posix.join(posix.dirname(relative(out, file)), src); // relative to docs/runtime = tabula-pixi/docs
    if (!existsSync(join(pixi, 'docs', rel))) continue;
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    cpSync(join(pixi, 'docs', rel), join(out, rel));
    images++;
  }
}

let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { cwd: pixi }).toString().trim(); } catch {}
writeFileSync(join(out, 'SOURCE'), `Copied from tabula-pixi/docs at ${commit} by scripts/sync-runtime-docs.mjs. Edit them there, then re-run pnpm docs:runtime.\n`);
console.log(`runtime docs: ${walk(join(out, 'api')).length} pages, ${images} images from tabula-pixi@${commit}`);
