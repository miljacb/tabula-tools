# tabula-tools

Build tools for [tabula-pixi](../tabula-pixi): the headless export engine
(compile, bake, repack, KTX2, fonts), the `tabula` CLI, the Tabula app and
its desktop (Electron) shell.

```
src/export/   engine, the package's main entry (import from 'tabula-tools')
src/cli/      tabula CLI and the app server
app/          Tabula app page
desktop/      Electron shell
```

The engine never prints or exits: results, events and warnings go back to
the caller, so a host app (an editor) can embed it. The engine does not need
tabula-pixi: the runtime modules it uses (parsers, compile, bake, manifest,
`.tbla`, texture formats) are vendored in `src/core/`, copied from
tabula-pixi's `src/core/`. Open issue: this copy must be kept in sync with tabula-pixi by hand until a
shared package replaces it (see [docs/embedding.md](docs/embedding.md#known-gaps)).
`tests/core-sync.test.ts` fails when a copy differs
from its source, so update both places together (or re-copy from tabula-pixi).

How to recreate the export in another app (the logic, step by step):
[docs/embedding.md](docs/embedding.md).

## Development

The engine builds without tabula-pixi. Tests, the app, the demo scripts and
the Basis transcoder used by `tabula app` still use a tabula-pixi checkout next
to this folder (linked as `file:../tabula-pixi`; build it first). tabula-pixi
never imports these tools.

```sh
npm install
npm run build        # dist/
npm test             # vitest, against ../tabula-pixi/src (no build needed)
npm run typecheck    # against ../tabula-pixi/src
npm run lint
npm run docs         # docs/reference/export.md from the TSDoc
npm run app          # app dev server on ../tabula-pixi/test-assets
npm run desktop      # Electron app
npm run report:ktx         # KTX2 encode quality (needs ktx)
npm run report:drawcalls   # tabula-pixi demo scenes: exported vs repacked atlas draw calls
```

Tests use `../tabula-pixi/test-assets`. Docs: [docs/app.md](docs/app.md),
[docs/cli.md](docs/cli.md), [docs/reference/export.md](docs/reference/export.md);
runtime docs are in `../tabula-pixi/docs/api/`.
