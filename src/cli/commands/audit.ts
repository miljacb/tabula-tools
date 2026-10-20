/**
 * `tabula audit`: scans Spine JSON exports and reports feature usage plus
 * validation findings.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { SpineJsonParser } from 'tabula-pixi/core/adapters/spine-json-parser.js';
import { validateSkeleton } from 'tabula-pixi/core/validate.js';
import { collectSkeletonFiles, loadAtlasNextTo } from '../../export/sources.js';
import { BlendMode } from 'tabula-pixi/core/types.js';
import type { SkeletonData } from 'tabula-pixi/core/types.js';

/** Feature counts for one skeleton (or totals across files). */
export interface FeatureUsage {
  bones: number;
  slots: number;
  skins: number;
  animations: number;
  events: number;
  attachmentTypes: {
    region: number;
    mesh: number;
    meshWeighted: number;
    linkedMesh: number;
    boundingBox: number;
    path: number;
    point: number;
    clipping: number;
  };
  blendModes: { normal: number; additive: number; multiply: number; screen: number };
  timelines: Record<string, number>;
  constraints: { ik: number; transform: number; path: number; physics: number };
  hasTintBlack: boolean;
  hasDeform: boolean;
  hasSequences: boolean;
  unsupportedFeatures: string[];
}

/** Audit result for one export. */
export interface FileAuditResult {
  file: string;
  spineVersion: string;
  features: FeatureUsage;
  errors: string[];
  warnings: string[];
}

/** Full audit report (JSON output of `tabula audit -f json`). */
export interface AuditReport {
  timestamp: string;
  totalFiles: number;
  parsedFiles: number;
  failedFiles: number;
  files: FileAuditResult[];
  totals: FeatureUsage;
  unsupportedFeatures: string[];
}

/** Options for {@link auditCommand}. */
export interface AuditOptions {
  output?: string;
  format?: 'markdown' | 'json';
}

/** Run the audit over files/directories. Throws when a path does not exist. */
export async function auditCommand(paths: string[], options: AuditOptions): Promise<AuditReport> {
  const files = await collectSkeletonFiles(paths);
  console.log(`Found ${files.length} JSON files`);
  const results: FileAuditResult[] = [];
  const totals = emptyUsage();

  for (const file of files) {
    const json = JSON.parse(await readFile(file, 'utf-8'));
    if (!json.skeleton || !json.bones) continue;
    try {
      const data = new SpineJsonParser().parse(json, basename(file, '.json'));
      const atlas = await loadAtlasNextTo(file);
      const features = analyzeFeatures(data);
      const validation = validateSkeleton(data, atlas ?? undefined);
      features.unsupportedFeatures = data.unsupported.map((u) => u.feature);
      results.push({ file, spineVersion: data.spineVersion, features, errors: validation.errors, warnings: [...validation.warnings, ...validation.notes] });
      accumulate(totals, features);
      console.log(`${validation.errors.length ? '✗' : '✓'} ${data.name} (${data.spineVersion})`);
    } catch (error) {
      results.push({ file, spineVersion: 'unknown', features: emptyUsage(), errors: [(error as Error).message], warnings: [] });
      console.error(`✗ ${basename(file)}: ${(error as Error).message}`);
    }
  }

  const report: AuditReport = {
    timestamp: new Date().toISOString(),
    totalFiles: results.length,
    parsedFiles: results.filter((r) => r.errors.length === 0).length,
    failedFiles: results.filter((r) => r.errors.length > 0).length,
    files: results,
    totals,
    unsupportedFeatures: totals.unsupportedFeatures,
  };

  const output = options.format === 'json' || options.output?.endsWith('.json') ? JSON.stringify(report, null, 2) : markdownReport(report);
  if (options.output) {
    await writeFile(options.output, output, 'utf-8');
    console.log(`Report written to ${options.output}`);
  } else console.log(output);
  return report;
}

function emptyUsage(): FeatureUsage {
  return {
    bones: 0,
    slots: 0,
    skins: 0,
    animations: 0,
    events: 0,
    attachmentTypes: { region: 0, mesh: 0, meshWeighted: 0, linkedMesh: 0, boundingBox: 0, path: 0, point: 0, clipping: 0 },
    blendModes: { normal: 0, additive: 0, multiply: 0, screen: 0 },
    timelines: {},
    constraints: { ik: 0, transform: 0, path: 0, physics: 0 },
    hasTintBlack: false,
    hasDeform: false,
    hasSequences: false,
    unsupportedFeatures: [],
  };
}

function analyzeFeatures(data: SkeletonData): FeatureUsage {
  const f = emptyUsage();
  f.bones = data.bones.length;
  f.slots = data.slots.length;
  f.skins = data.skins.length;
  f.animations = data.animations.length;
  f.events = data.events.length;
  f.constraints.path = data.pathConstraints.length;
  f.constraints.ik = data.ikConstraints?.length ?? 0;
  f.constraints.transform = data.transformConstraints?.length ?? 0;
  f.constraints.physics = data.physicsConstraints?.length ?? 0;
  for (const slot of data.slots) {
    const mode = BlendMode[slot.blendMode].toLowerCase() as keyof FeatureUsage['blendModes'];
    f.blendModes[mode]++;
    if (slot.darkColor) f.hasTintBlack = true;
  }
  for (const skin of data.skins) {
    for (const attachments of skin.attachments.values()) {
      for (const a of attachments.values()) {
        const types = f.attachmentTypes;
        switch (a.type) {
          case 'region':
            types.region++;
            if (a.sequence) f.hasSequences = true;
            break;
          case 'mesh':
            if (a.bones) types.meshWeighted++;
            else types.mesh++;
            if (a.timelineAttachment !== a) types.linkedMesh++;
            if (a.sequence) f.hasSequences = true;
            break;
          case 'boundingbox':
            types.boundingBox++;
            break;
          default:
            types[a.type]++;
        }
      }
    }
  }
  for (const anim of data.animations) {
    for (const t of anim.timelines) {
      f.timelines[t.kind] = (f.timelines[t.kind] ?? 0) + 1;
      if (t.kind === 'deform') f.hasDeform = true;
      if (t.kind === 'sequence') f.hasSequences = true;
      if (t.kind === 'rgba2' || t.kind === 'rgb2') f.hasTintBlack = true;
    }
  }
  return f;
}

function accumulate(totals: FeatureUsage, f: FeatureUsage): void {
  totals.bones += f.bones;
  totals.slots += f.slots;
  totals.skins += f.skins;
  totals.animations += f.animations;
  totals.events += f.events;
  for (const k of Object.keys(f.attachmentTypes) as (keyof FeatureUsage['attachmentTypes'])[]) totals.attachmentTypes[k] += f.attachmentTypes[k];
  for (const k of Object.keys(f.blendModes) as (keyof FeatureUsage['blendModes'])[]) totals.blendModes[k] += f.blendModes[k];
  for (const k of Object.keys(f.constraints) as (keyof FeatureUsage['constraints'])[]) totals.constraints[k] += f.constraints[k];
  for (const [k, v] of Object.entries(f.timelines)) totals.timelines[k] = (totals.timelines[k] ?? 0) + v;
  totals.hasTintBlack ||= f.hasTintBlack;
  totals.hasDeform ||= f.hasDeform;
  totals.hasSequences ||= f.hasSequences;
  for (const u of f.unsupportedFeatures) if (!totals.unsupportedFeatures.includes(u)) totals.unsupportedFeatures.push(u);
}

/** How Tabula handles each attachment type and constraint (static; the counts above say what the files use). */
const RUNTIME_SUPPORT = [
  '## Runtime support',
  '',
  '| Feature | Tabula |',
  '|---|---|',
  '| region, mesh, weighted mesh, linked mesh | drawn (linked meshes: unit-tested only, none in these files) |',
  '| clipping | CPU clipping, stays in the batch |',
  '| path + path constraints | supported (spine-core port) |',
  '| IK constraints (1/2 bones, softness, compress, stretch, uniform) | supported (spine-core 4.2 port, numerically checked) |',
  '| transform constraints (world/local, absolute/relative) | supported (spine-core 4.2 port, numerically checked) |',
  '| physics constraints (Spine 4.2) | supported live, fixed-step; skeletons with physics are not baked |',
  '| point | `Clip.getPointTransform` |',
  '| boundingBox | not drawn; world polygons and point-in-polygon hit tests: `Clip.hitTest` / `getBoundingBoxes`, `ClipView.hitTest` / `containsPoint` (Pixi events) |',
  '| multiply / screen blend | separate blend state: one batch break per switch |',
  '| two-color tint | vertex format + shader + rgba2/rgb2 timelines |',
  '| compiled format | `tabula compile` → `.tbin` (no JSON parsing at runtime) |',
];

function markdownReport(report: AuditReport): string {
  const t = report.totals;
  const lines: string[] = [
    '# Spine Feature Audit Report',
    '',
    `Generated: ${report.timestamp}`,
    '',
    `Files: ${report.totalFiles} · without errors: ${report.parsedFiles} · with errors: ${report.failedFiles}`,
    '',
    '## Totals',
    '',
    '| Feature | Count |',
    '|---|---|',
    `| Bones | ${t.bones} |`,
    `| Slots | ${t.slots} |`,
    `| Skins | ${t.skins} |`,
    `| Animations | ${t.animations} |`,
    `| Events | ${t.events} |`,
    ...Object.entries(t.attachmentTypes).map(([k, v]) => `| Attachments: ${k} | ${v} |`),
    ...Object.entries(t.blendModes).map(([k, v]) => `| Blend: ${k} slots | ${v} |`),
    ...Object.entries(t.constraints).map(([k, v]) => `| Constraints: ${k} | ${v} |`),
    ...Object.entries(t.timelines).sort().map(([k, v]) => `| Timelines: ${k} | ${v} |`),
    `| Two-color tint | ${t.hasTintBlack ? 'yes' : 'no'} |`,
    `| Deform | ${t.hasDeform ? 'yes' : 'no'} |`,
    `| Sequences | ${t.hasSequences ? 'yes' : 'no'} |`,
    '',
  ];
  if (t.unsupportedFeatures.length) lines.push('## Unsupported features found', '', ...t.unsupportedFeatures.map((u) => `- ${u}`), '');
  lines.push(...RUNTIME_SUPPORT, '', '## Per file', '');
  for (const r of report.files) {
    if (!r.errors.length && !r.warnings.length) continue;
    lines.push(`### ${basename(r.file)}`, '', ...r.errors.map((e) => `- ❌ ${e}`), ...r.warnings.map((w) => `- ${w}`), '');
  }
  return lines.join('\n');
}
