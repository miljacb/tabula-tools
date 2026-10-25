# tabula-tools

Build tools for tabula-pixi: the headless export engine
(compile, bake, repack, KTX2, fonts), the `tabula` CLI, the Tabula app (read and
export a project folder) and its desktop (Electron) shell, and the Tabula
Viewer (`packages/viewer`).

Studio exports for now: Tabula Studio is the source of truth for the export and
its package layout. The export here is kept but not developed further until the
two are reconciled.

```
src/export/   engine, the package's main entry (import from 'tabula-tools')
src/cli/      tabula CLI and the app server
app/          Tabula app page
desktop/      Electron shell
packages/viewer/  Tabula Viewer (browser composer on tabula-pixi); see its README
```

The engine never prints or exits: results, events and warnings go back to
the caller, so a host app (an editor) can embed it. The runtime modules it
uses (parsers, compile, bake, manifest, `.tbla`, texture formats) come from
the `tabula-pixi` package (`tabula-pixi/core/*`); there is no copy to keep in
sync.

How to recreate the export in another app (the logic, step by step):
[docs/embedding.md](docs/embedding.md).

## Development

The runtime comes from the published `tabula-pixi` package (pinned in
`package.json`, as in tabula-studio): `pnpm install` is all it takes.

```sh
pnpm install
pnpm build        # dist/
pnpm test             # vitest, against the installed tabula-pixi
pnpm typecheck
pnpm lint
pnpm run docs     # docs/reference/export.md from the TSDoc (`run`: pnpm has its own `docs`)
pnpm dev          # tools homepage + viewer dev servers (http://localhost:5173/)
pnpm app          # exporter dev server on tests/assets (/exporter/)
pnpm desktop      # Electron app, opens the tools homepage
pnpm report:ktx         # KTX2 encode quality (needs ktx)
```

Tests use their own fixtures in `tests/assets`. Docs: [docs/app.md](docs/app.md),
[docs/cli.md](docs/cli.md), [docs/reference/export.md](docs/reference/export.md);
runtime docs are in the tabula-pixi repository (`docs/api/`).
