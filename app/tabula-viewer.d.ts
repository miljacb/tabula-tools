// Types for the Tabula Viewer's loaders (plain JS in packages/viewer/src), which the
// exporter's preview reuses through the `tabula-viewer/*` alias in vite.config.ts.

declare module 'tabula-viewer/tabula/loader.js' {
  import type { BaseTexture } from 'pixi.js';
  import type { TabulaAsset } from 'tabula-pixi';
  /** Parse a Spine 4.1 / 4.2 JSON export with its atlas and load the page textures. */
  export function buildTabulaAsset(source: { atlasText: string; skeletonJson: unknown; pageUrls: Record<string, string>; name: string }): Promise<{ asset: TabulaAsset; textures: BaseTexture[]; warnings: string[] }>;
}

declare module 'tabula-viewer/tabula/exportManager.js' {
  import type { IRenderer } from 'pixi.js';
  import type { AssetManifest } from 'tabula-pixi/core/manifest.js';
  import type { TabulaAsset, TabulaAssetManager } from 'tabula-pixi';
  export interface OpenedExport {
    pkg: { manifestUrl: string; manifest: AssetManifest; label: string };
    manager: TabulaAssetManager;
  }
  /** Open an export (a `.tbla`, or assets.manifest.json with its bundles or loose files) from memory, as a game loads it. */
  export function openExport(files: { name: string; bytes: Uint8Array }[], renderer: IRenderer, tier?: number): Promise<OpenedExport>;
  /** Load the groups of these skeletons and hand over their assets. */
  export function loadSkeletons(exp: OpenedExport, names: string[]): Promise<{ name: string; asset: TabulaAsset }[]>;
}
