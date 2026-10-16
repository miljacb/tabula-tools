/**
 * Locating and installing the `ktx` encoder of KTX-Software without a system
 * install.
 *
 * Resolution order ({@link resolveKtxTool}):
 * 1. `$TABULA_KTX` (any native `ktx`, e.g. a Homebrew or self-built one);
 * 2. the project-local copy installed by {@link installKtxTool} under
 *    `node_modules/.cache/tabula/ktx-software/<version>/<platform>`;
 * 3. `ktx` on PATH.
 *
 * {@link installKtxTool} downloads a pinned KTX-Software release from GitHub,
 * verifies its SHA-256 and unpacks only the `ktx` tool and `libktx` into the
 * project cache: macOS `.pkg` files are unpacked with `pkgutil --expand-full`
 * (nothing is installed, no admin rights), Linux tarballs with `tar`. The
 * binaries find `libktx` through their `@executable_path/../lib` /
 * `$ORIGIN/../lib` rpath, so no environment variables are needed.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { toolsCacheDir } from '../cache-dir.js';

const run = promisify(execFile);

/** KTX-Software release that {@link installKtxTool} installs. */
export const KTX_SOFTWARE_VERSION = '4.4.2';

/** Pinned release assets: file name and SHA-256 per `${process.platform}-${process.arch}`. */
export const KTX_SOFTWARE_ASSETS: Readonly<Record<string, { file: string; sha256: string }>> = {
  'darwin-arm64': { file: `KTX-Software-${KTX_SOFTWARE_VERSION}-Darwin-arm64.pkg`, sha256: '500bd8f9d63358c3f3a0d83b724c8574436a72c37dc0e4bad90ec1ca38032c3c' },
  'darwin-x64': { file: `KTX-Software-${KTX_SOFTWARE_VERSION}-Darwin-x86_64.pkg`, sha256: 'efecc685ab891a6e119a9fdc8cbe038e135f9a367eb2f5d8a059553f947f1fea' },
  'linux-x64': { file: `KTX-Software-${KTX_SOFTWARE_VERSION}-Linux-x86_64.tar.bz2`, sha256: 'a8781bad05f9624edbf910b7f258cd0a4ba7d3e63b49ecc0a0ab440bf6a0a245' },
  'linux-arm64': { file: `KTX-Software-${KTX_SOFTWARE_VERSION}-Linux-arm64.tar.bz2`, sha256: '60382e7b842177b8048bd58ccdc770383f8ef65b94452a25d3afdb55f2405c5a' },
};

const RELEASE_URL = `https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_SOFTWARE_VERSION}`;

/** Where the `ktx` executable comes from. */
export type KtxToolSource = 'env' | 'project' | 'path';

/** A resolved `ktx` tool. */
export interface KtxToolLocation {
  /** Executable path (or bare `ktx` for PATH lookup). */
  path: string;
  source: KtxToolSource;
}

/**
 * Cache directory for the installed tool:
 * `$TABULA_CACHE_DIR` or `<nearest node_modules>/.cache/tabula`, then
 * `ktx-software/<version>/<platform>-<arch>`.
 * @param from Directory to search upward from for `node_modules` (default: this package, see `toolsCacheDir`).
 */
export function ktxCacheDir(from?: string): string {
  return join(toolsCacheDir(from), 'ktx-software', KTX_SOFTWARE_VERSION, `${process.platform}-${process.arch}`);
}

/** Path of the project-local `ktx` (whether or not it is installed). */
export function projectKtxPath(from?: string): string {
  return join(ktxCacheDir(from), 'bin', process.platform === 'win32' ? 'ktx.exe' : 'ktx');
}

/** The `ktx` to run: `$TABULA_KTX`, else the project-local install, else `ktx` on PATH. */
export function resolveKtxTool(from?: string): KtxToolLocation {
  if (process.env.TABULA_KTX) return { path: process.env.TABULA_KTX, source: 'env' };
  const local = projectKtxPath(from);
  if (existsSync(local)) return { path: local, source: 'project' };
  return { path: 'ktx', source: 'path' };
}

/** `ktx --version` output of `tool`, or null if it does not run. Synchronous (for test guards). */
export function ktxVersionSync(tool: string): string | null {
  try {
    return execFileSync(tool, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Options of {@link installKtxTool}. */
export interface InstallKtxToolOptions {
  /** Reinstall even if the tool is already there. */
  force?: boolean;
  /** Progress messages (default: none). */
  log?: (message: string) => void;
  /** Download implementation (default: global fetch); tests pass a stub. */
  download?: (url: string) => Promise<Uint8Array>;
  /** Directory to search upward from for `node_modules`. */
  from?: string;
}

/**
 * Download the pinned KTX-Software release for this platform, verify its
 * SHA-256 and unpack `ktx` + `libktx` into {@link ktxCacheDir}. No admin
 * rights, nothing outside the project cache is touched.
 * @returns Path of the installed `ktx`.
 * @throws on unsupported platforms, download or checksum failures, or if the unpacked tool does not run.
 */
export async function installKtxTool(options: InstallKtxToolOptions = {}): Promise<string> {
  const key = `${process.platform}-${process.arch}`;
  const asset = KTX_SOFTWARE_ASSETS[key];
  if (!asset) {
    throw new Error(`No pinned KTX-Software build for ${key}; install KTX-Software ${KTX_SOFTWARE_VERSION}+ yourself and set TABULA_KTX`);
  }
  const dir = ktxCacheDir(options.from);
  const tool = projectKtxPath(options.from);
  if (!options.force && existsSync(tool) && ktxVersionSync(tool)) return tool;
  const log = options.log ?? ((): void => undefined);
  const download = options.download ?? fetchBytes;

  const url = `${RELEASE_URL}/${asset.file}`;
  log(`Downloading ${url}`);
  const bytes = await download(url);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== asset.sha256) throw new Error(`Checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${sha}`);

  await mkdir(dirname(dir), { recursive: true });
  const work = await mkdtemp(join(dirname(dir), '.install-'));
  try {
    const archive = join(work, asset.file);
    await writeFile(archive, bytes);
    const staged = join(work, 'staged');
    await mkdir(join(staged, 'bin'), { recursive: true });
    await mkdir(join(staged, 'lib'), { recursive: true });
    if (asset.file.endsWith('.pkg')) await unpackPkg(archive, join(work, 'expanded'), staged);
    else await unpackTarball(archive, join(work, 'expanded'), staged);
    const stagedTool = join(staged, 'bin', 'ktx');
    await chmod(stagedTool, 0o755);
    const version = ktxVersionSync(stagedTool);
    if (!version?.includes(KTX_SOFTWARE_VERSION)) throw new Error(`Unpacked ktx does not run (got: ${version ?? 'no output'})`);
    await rm(dir, { recursive: true, force: true });
    await rename(staged, dir);
    log(`Installed ${version} to ${dir}`);
    return tool;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** macOS: `pkgutil --expand-full` unpacks the component packages' payloads (no install). */
async function unpackPkg(pkg: string, expanded: string, staged: string): Promise<void> {
  await run('pkgutil', ['--expand-full', pkg, expanded]);
  const components = await readdir(expanded);
  const payload = (suffix: string): string => {
    const name = components.find((c) => c.endsWith(suffix));
    if (!name) throw new Error(`Unexpected package layout: no *${suffix}`);
    return join(expanded, name, 'Payload', 'usr', 'local');
  };
  await copyFile(join(payload('-tools.pkg'), 'bin', 'ktx'), join(staged, 'bin', 'ktx'));
  await copyLibs(join(payload('-library.pkg'), 'lib'), join(staged, 'lib'), /^libktx\.\d+\.\d+\.\d+\.dylib$/, (v) => [`libktx.${v.split('.')[0]}.dylib`, 'libktx.dylib'], '.dylib');
}

/** Linux: tarball with bin/ and lib/ (bzip2: `tar -xjf`, falling back to Python's tarfile). */
async function unpackTarball(archive: string, expanded: string, staged: string): Promise<void> {
  await mkdir(expanded, { recursive: true });
  try {
    await run('tar', ['-xjf', archive, '-C', expanded]);
  } catch {
    await run('python3', ['-c', 'import sys,tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2])', archive, expanded]);
  }
  const [root] = await readdir(expanded);
  const top = join(expanded, root!);
  await copyFile(join(top, 'bin', 'ktx'), join(staged, 'bin', 'ktx'));
  await copyLibs(join(top, 'lib'), join(staged, 'lib'), /^libktx\.so\.\d+\.\d+\.\d+$/, (v) => [`libktx.so.${v.split('.')[0]}`, 'libktx.so'], '');
}

/** Copy the versioned libktx and recreate its soname symlinks. */
async function copyLibs(from: string, to: string, real: RegExp, links: (version: string) => string[], ext: string): Promise<void> {
  const file = (await readdir(from)).find((f) => real.test(f));
  if (!file) throw new Error(`libktx not found in ${from}`);
  await copyFile(join(from, file), join(to, file));
  const version = file.replace(/^libktx\.(so\.)?/, '').replace(ext, '');
  for (const link of links(version)) await symlink(file, join(to, link));
}
