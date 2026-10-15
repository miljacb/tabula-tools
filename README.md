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
the caller, so a host app (an editor) can embed it. It reaches the runtime
only through `tabula-pixi/core/*`.

## Development

Expects `tabula-pixi` checked out next to this folder (linked as
`file:../tabula-pixi`; build it first). The dependency goes one way only:
tabula-pixi never imports these tools.

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
