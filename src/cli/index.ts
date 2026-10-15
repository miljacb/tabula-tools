#!/usr/bin/env node
/**
 * Tabula CLI: build tool for the lean Spine runtime.
 *
 *   audit <path...>   feature usage + validation report
 *   check <path...>   validation only; exit code 1 on errors (CI)
 *   compile <path...> compile exports to .tabula (binary skeleton + atlas)
 *   bake <file.json>  bake animations to a binary .baked file
 *   repack <path...>  rebuild atlas pages per co-draw group
 *   manifest <dir...> asset manifest with load groups
 *   ktx-tool          show / install the project-local KTX2 encoder
 *   font <font...>    MSDF font atlas + metrics for SDF text
 *   app [folder]      the Tabula app: read, preview and export a project folder
 *   inspect <f.tbla>  what a .tbla bundle holds (--unpack <dir> writes its files)
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { auditCommand } from './commands/audit.js';
import { collectSkeletonFiles, loadAtlasNextTo } from '../export/sources.js';
import { bakeCommand } from './commands/bake.js';
import { repackCommand } from './commands/repack.js';
import type { PageImageFormat } from '../export/pages.js';
import type { BasisCodec } from 'tabula-pixi/core/texture-formats.js';
import { compileCommand } from './commands/compile.js';
import { manifestCommand } from './commands/manifest.js';
import { FONT_USAGE, fontCommand } from './commands/font.js';
import { installKtxTool, ktxCacheDir, ktxVersionSync, resolveKtxTool, KTX_SOFTWARE_VERSION } from '../export/pack/ktx-tool.js';
import { SpineJsonParser } from 'tabula-pixi/core/adapters/spine-json-parser.js';
import { appCommand } from './app/command.js';
import { inspectCommand } from './commands/inspect.js';
import { validateSkeleton } from 'tabula-pixi/core/validate.js';
import { setKtxInstallLog } from '../export/pack/ktx2.js';

const USAGE = `Tabula - lean Spine runtime build tool

Commands:
  audit <path...>    Feature usage + validation report (markdown or json)
  check <path...>    Validate exports; exit code 1 if any has errors
  compile <path...>  Compile exports to .tabula (binary skeleton, used atlas regions embedded)
  bake <file.json>   Bake animations to a compressed .baked file, with an error report
  repack <path...>   Rebuild atlas pages per co-draw group (-o <dir> required)
  manifest <dir...>  Write assets.manifest.json (skeletons, baked, pages, tiers, KTX2, sprite sheets, load groups)
  inspect <f.tbla>   Show a .tbla bundle's files, sizes and assets (checksums checked); --unpack <dir> writes them out
  app [folder]       Open the Tabula app (on a project folder, else its start screen): list the assets, preview them
                     (source and exported side by side, tiers, KTX2), set tiers / compression, export
  font <font...>     Compile TTF/OTF fonts (or --google families) to MSDF atlas pages + <name>.font.json for SDF text (-o <dir>)
  ktx-tool           Show which KTX2 encoder ("ktx") is used; --install puts the pinned KTX-Software
                     build into node_modules/.cache/tabula (checksum-verified, no admin rights)

Options:
  -o, --output <f>       Output file (compile: output directory)
  --atlas <file>         compile: atlas to embed (default: <name>.atlas next to each JSON)
  --no-atlas             compile: do not embed an atlas
  --bake                 compile, repack --compile: also write <name>.baked next to each .tabula
  -f, --format <fmt>     audit: markdown | json (default markdown)
  --fps <n>              bake: sample rate (default: smallest multiple of the
                         authoring key rate >= 30, e.g. 48 for 24 fps keys; else 30)
  --max-error <n>        bake, compile/repack --bake: vertex error budget in skeleton units (default 0.05; 0 = lossless)
  --tolerance <n>        bake, compile/repack --bake: largest deviation from live between samples, skeleton
                         units; samples are added where needed (default 0.25; 0 = fixed rate only)
  --no-report            bake: skip the per-animation error report
  -a, --animations <l>   bake: comma-separated animation names
  --groups <file>        repack: co-draw groups JSON
                         {"maxSize": 2048, "groups": [{"name": "reel", "skeletons": ["symbol*", "reel*"]}]}
                         (unmatched skeletons go to group "misc"; default: one group)
  --max-size <n>         repack: largest page side (default 2048; e.g. 4096)
  --padding <n>          repack: pixels between regions (default 2)
  --extrude <n>          repack: edge pixels repeated around regions (default 0)
  --pma                  repack: premultiply alpha in the pages (default: as the source)
  --no-rotate            repack: do not rotate regions
  --no-pot               repack: allow non-power-of-two page sizes
  --image-format <f>     repack: png | webp | webp-lossless (default png)
  --quality <n>          repack: lossy WebP quality (default 90)
  --compile              repack: also write <skeleton>.tabula embedding its group atlas
  --ktx2 <codec>         repack: also write KTX2 / Basis Universal pages: uastc (quality) | etc1s (size)
                         | none; per group / page in the groups file ("ktx2", "pages": {"game_1": "etc1s"}).
                         Uses $TABULA_KTX, else the project-local ktx (installed on first use; set
                         TABULA_KTX_DOWNLOAD=0 to forbid the download), else ktx on PATH
  --ktx2-quality <n>     repack: UASTC level 0-4 (default 2) / ETC1S quality 1-255 (default 128)
  --tiers <list>         repack: resolution tiers, e.g. 2,1,0.75,0.5 (default 1); writes <page>@0.5x.png ...
                         and <group>.textures.json (the game picks the tier). Tiers above 1 are never
                         upscaled: each needs the higher-resolution export next to the JSON
                         (<name>@2x.atlas + its pages)
  --skin <name>          bake: skin to bake with
  --load-groups <file>   manifest: load groups JSON {"groups": {"base": ["symbol*"], "bonus": ["bonus*"]},
                         "defaultGroup": "base", "preload": ["bonus"]} (default: everything in "base")
  --port <n>             app: port (default 43300)
  --no-open              app: do not open the browser
  -o <dir>               app: export folder (default <folder>/tabula-export)
  --install              ktx-tool: download and unpack KTX-Software into the project cache
  --force                ktx-tool --install: reinstall even if present
${FONT_USAGE}
  -h, --help             Show this help
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      output: { type: 'string', short: 'o' },
      format: { type: 'string', short: 'f', default: 'markdown' },
      fps: { type: 'string' },
      animations: { type: 'string', short: 'a' },
      skin: { type: 'string' },
      atlas: { type: 'string' },
      'no-atlas': { type: 'boolean' },
      bake: { type: 'boolean' },
      'max-error': { type: 'string' },
      tolerance: { type: 'string' },
      'no-report': { type: 'boolean' },
      groups: { type: 'string' },
      'max-size': { type: 'string' },
      padding: { type: 'string' },
      extrude: { type: 'string' },
      pma: { type: 'boolean' },
      'no-rotate': { type: 'boolean' },
      'no-pot': { type: 'boolean' },
      'image-format': { type: 'string' },
      quality: { type: 'string' },
      compile: { type: 'boolean' },
      ktx2: { type: 'string' },
      'ktx2-quality': { type: 'string' },
      tiers: { type: 'string' },
      'load-groups': { type: 'string' },
      install: { type: 'boolean' },
      force: { type: 'boolean' },
      size: { type: 'string' },
      range: { type: 'string' },
      charset: { type: 'string' },
      chars: { type: 'string' },
      name: { type: 'string' },
      lang: { type: 'string' },
      'charset-from': { type: 'string', multiple: true },
      google: { type: 'string', multiple: true },
      weights: { type: 'string' },
      chain: { type: 'boolean' },
      'per-lang': { type: 'boolean' },
      fallback: { type: 'string' },
      lock: { type: 'string' },
      'update-lock': { type: 'boolean' },
      port: { type: 'string' },
      unpack: { type: 'string' },
      'no-open': { type: 'boolean' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case 'audit':
      await auditCommand(args, { output: values.output, format: values.format === 'json' ? 'json' : 'markdown' });
      return;
    case 'inspect':
      await inspectCommand(args[0], { unpack: values.unpack, json: values.format === 'json' });
      return;
    case 'app':
      await appCommand(args[0], { outDir: values.output, port: values.port ? Number(values.port) : undefined, noOpen: values['no-open'] });
      return;
    case 'check': {
      let failed = 0;
      for (const file of await collectSkeletonFiles(args)) {
        const json = JSON.parse(await readFile(file, 'utf-8'));
        if (!json.skeleton || !json.bones) continue;
        const data = new SpineJsonParser().parse(json, basename(file, '.json'));
        const result = validateSkeleton(data, (await loadAtlasNextTo(file)) ?? undefined);
        if (result.errors.length) failed++;
        console.log(`${result.errors.length ? '✗' : '✓'} ${data.name}`);
        for (const e of result.errors) console.log(`    error: ${e}`);
        for (const w of result.warnings) console.log(`    warning: ${w}`);
      }
      if (failed) process.exitCode = 1;
      return;
    }
    case 'compile':
      if (!args.length) throw new Error('Usage: tabula compile <path...> [-o dir]');
      await compileCommand(args, {
        outDir: values.output,
        atlas: values.atlas,
        noAtlas: values['no-atlas'],
        bake: values.bake,
        maxError: values['max-error'] !== undefined ? Number(values['max-error']) : undefined,
        tolerance: values.tolerance !== undefined ? Number(values.tolerance) : undefined,
      });
      return;
    case 'bake': {
      const input = args[0];
      if (!input) throw new Error('Usage: tabula bake <file.json> [options]');
      await bakeCommand(input, {
        output: values.output,
        fps: values.fps ? Number(values.fps) : undefined,
        animations: values.animations,
        skin: values.skin,
        maxError: values['max-error'] !== undefined ? Number(values['max-error']) : undefined,
        tolerance: values.tolerance !== undefined ? Number(values.tolerance) : undefined,
        noReport: values['no-report'],
      });
      return;
    }
    case 'repack': {
      if (!values.output || args.length === 0) throw new Error('Usage: tabula repack <path...> -o <dir> [options]');
      const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
      await repackCommand(args, {
        outDir: values.output,
        groups: values.groups,
        maxSize: num(values['max-size']),
        padding: num(values.padding),
        extrude: num(values.extrude),
        pma: values.pma ? true : undefined,
        rotation: !values['no-rotate'],
        powerOfTwo: !values['no-pot'],
        imageFormat: values['image-format'] as PageImageFormat | undefined,
        quality: num(values.quality),
        compile: values.compile,
        bake: values.bake,
        maxError: num(values['max-error']),
        tolerance: num(values.tolerance),
        ktx2: parseCodec(values.ktx2),
        ktx2Quality: num(values['ktx2-quality']),
        tiers: values.tiers ? values.tiers.split(',').map(Number) : undefined,
      });
      return;
    }
    case 'manifest':
      await manifestCommand(args, { output: values.output, groups: values['load-groups'] });
      return;
    case 'font': {
      const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
      if (!values.output || (args.length === 0 && !values.google)) {
        throw new Error('Usage: tabula font <font.ttf...> | --google "<family>" -o <dir> [--weights 400,700] [--lang hr,el,ka] [--charset-from i18n/*.json] [--chain] [--per-lang]');
      }
      const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
      await fontCommand(args, {
        outDir: values.output,
        size: num(values.size),
        distanceRange: num(values.range),
        charset: values.charset,
        chars: values.chars,
        lang: values.lang,
        charsetFrom: list(values['charset-from']),
        google: list(values.google),
        weights: list(values.weights).map(Number),
        chain: values.chain,
        perLang: values['per-lang'],
        fallbacks: list(values.fallback),
        lockFile: values.lock,
        updateLock: values['update-lock'],
        name: values.name,
        maxSize: num(values['max-size']),
        padding: num(values.padding),
        ktx2: values.ktx2 !== undefined && values.ktx2 !== 'none',
      });
      return;
    }
    case 'ktx-tool': {
      if (values.install) await installKtxTool({ force: values.force, log: (m) => console.log(m) });
      const tool = resolveKtxTool();
      const version = ktxVersionSync(tool.path);
      console.log(`ktx: ${tool.path} (${tool.source === 'env' ? '$TABULA_KTX' : tool.source === 'project' ? 'project cache' : 'PATH'})`);
      console.log(version ? `version: ${version}` : `not found; run "tabula ktx-tool --install" (KTX-Software ${KTX_SOFTWARE_VERSION} into ${ktxCacheDir()})`);
      if (!version) process.exitCode = 1;
      return;
    }
    default:
      throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

function parseCodec(value: string | undefined): BasisCodec | 'none' | undefined {
  if (value === undefined) return undefined;
  if (value === 'uastc' || value === 'etc1s' || value === 'none') return value;
  throw new Error(`--ktx2 must be uastc, etc1s or none (got "${value}")`);
}

setKtxInstallLog((m) => console.log(`[tabula] ${m}`));
main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
