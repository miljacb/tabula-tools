/**
 * @module tabula-tools
 *
 * The headless export engine (Node) behind the Tabula app and the `tabula`
 * CLI, for build scripts and host apps: read a folder of Spine exports,
 * compress the chosen skeletons, write the export folder and its asset
 * manifest (see docs/app.md). The steps are exported too (compile,
 * bake, repack page output). The engine never prints or exits: results,
 * {@link ExportEvent}s and warnings go back to the caller.
 */

export {
  exportProject, discoverProject, cachedKtx2, type ExportPhase, scaleSpriteSheet, EXPORT_MARKER, MANIFEST_FILE, REPORT_FILE,
  type ExportEvent, type ExportOptions, type ExportReport, type SkeletonExport, type ProjectFiles, type SourceSkeleton,
  type BundleReport, type BundleKind, type DeviceDownloads,
} from './export-project.js';
export { loadProjectConfig, validateProjectConfig, PROJECT_CONFIG_FILE, type TabulaProjectConfig } from './config.js';
export { loadValidatedSkeleton } from './compile.js';
// Compile and bake are pure and live in the runtime's core; re-exported for the engine API.
export { compileSkeleton } from '../core/slb-writer.js';
export { bakeToBuffer, type BakeOptions, type BakeResult } from '../core/bake-report.js';
export { collectSkeletonFiles, loadAtlasNextTo, isTierExport } from './sources.js';
export {
  encodeGroupPages, ktx2Selector, manifestFileName, decodeImage, loadPageImage, encodePageImage, loadHiResAtlases,
  type PageImageFormat, type PageOutputOptions, type RepackGroupsFile,
} from './pages.js';
export {
  repackAtlases, renderTierPages, assignGroups, matchesPattern,
  type RepackSkeleton, type RepackGroupSpec, type RepackOptions, type RepackedGroup, type RegionPlacement, type PageLoader,
} from './pack/repack.js';
export { groupReport, type RepackGroupReport } from './repack-report.js';
export { setKtxInstallLog } from './pack/ktx2.js';
