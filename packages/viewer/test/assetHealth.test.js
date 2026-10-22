import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bandForScore,
  combineOverall,
  resolveAssetRuntimeScore,
  pickBestWorstSampledAnimations,
  scoreFromFindings,
  summarize,
} from '../src/features/assetHealth/grade.js';
import { countAnimationJsonStats, lintAnimationExport, normalizeAnimationsJson } from '../src/features/assetHealth/rules/exportAnimations.js';
import { exportHealthReportJson } from '../src/features/assetHealth/inspectAsset.js';

test('combineOverall mixes runtime and export', () => {
  const overall = combineOverall(80, 60);
  assert.equal(overall, Math.round(80 * 0.6 + 60 * 0.4));
});

test('scoreFromFindings subtracts penalties', () => {
  const { score } = scoreFromFindings([
    { id: '1', level: 'warn', category: 'export.animations', title: 'a', detail: 'b' },
    { id: '2', level: 'fail', category: 'export.animations', title: 'c', detail: 'd' },
  ]);
  assert.ok(score < 100);
  assert.ok(score >= 0);
});

test('bandForScore maps ranges', () => {
  assert.equal(bandForScore(90), 'Excellent');
  assert.equal(bandForScore(75), 'Good');
  assert.equal(bandForScore(30), 'Critical');
});

test('normalizeAnimationsJson accepts array exports', () => {
  const map = normalizeAnimationsJson({ animations: [{ name: 'idle', bones: {} }] });
  assert.equal(map.idle?.name, 'idle');
});

test('countAnimationJsonStats counts bone rotate keys', () => {
  const stats = countAnimationJsonStats({
    bones: {
      hip: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 90 }] },
    },
  });
  assert.equal(stats.keys, 2);
});

test('lintAnimationExport flags high key rate', () => {
  const keys = [];
  for (let i = 0; i < 100; i++) keys.push({ time: i * 0.01, value: i });
  const animations = { walk: { bones: { hip: { rotate: keys } } } };
  const { fail } = lintAnimationExport(animations, 'walk', 1);
  assert.ok(fail >= 1);
});

test('resolveAssetRuntimeScore ignores skipped zero-length clips', () => {
  const score = resolveAssetRuntimeScore([
    { name: 'idle', duration: 0, runtimeScore: 50, runtimeSkipped: true },
    { name: 'walk', duration: 1, runtimeScore: 90, runtimeSkipped: false },
  ], 85);
  assert.equal(score, 85);
});

test('pickBestWorstSampledAnimations ignores skipped clips', () => {
  const { bestAnimation, worstAnimation } = pickBestWorstSampledAnimations([
    { name: 'idle', duration: 0, runtimeScore: 50, runtimeSkipped: true },
    { name: 'walk', duration: 1, runtimeScore: 90, runtimeSkipped: false },
    { name: 'run', duration: 1, runtimeScore: 70, runtimeSkipped: false },
  ]);
  assert.equal(bestAnimation, 'walk');
  assert.equal(worstAnimation, 'run');
});

test('lintAnimationExport skips key rate when duration is zero', () => {
  const animations = {
    idle: { bones: { hip: { rotate: [{ time: 0, value: 0 }, { time: 0, value: 1 }] } } },
  };
  const { fail, findings } = lintAnimationExport(animations, 'idle', 0);
  assert.equal(fail, 0);
  assert.ok(!findings.some((f) => f.id.startsWith('export-kps-')));
});

test('exportHealthReportJson is valid JSON', () => {
  const report = {
    assetKey: 'hero.json',
    assetId: 'id',
    scannedAt: 1,
    overallScore: 70,
    runtimeScore: 75,
    exportScore: 65,
    band: 'Good',
    summary: summarize([]),
    breakdownExport: {},
    breakdownRuntime: {},
    findings: [],
    animations: [],
    bestAnimation: null,
    worstAnimation: null,
    state: 'done',
  };
  const parsed = JSON.parse(exportHealthReportJson(report));
  assert.equal(parsed.overallScore, 70);
  assert.equal(parsed.schemaVersion, 1);
});

test('countAnimationJsonStats counts Spine 4 keys that omit time on the first key', () => {
  const stats = countAnimationJsonStats({
    bones: { hip: { rotate: [{ value: 0 }, { time: 1, value: 90 }], translatex: [{ value: 1 }] } },
    slots: { arm: { rgba: [{ color: 'ffffffff' }, { time: 0.5, color: 'ff0000ff' }] } },
  });
  assert.equal(stats.keys, 5);
  assert.equal(stats.timelines, 3);
});

test('countAnimationJsonStats counts deform keys in 4.0 and 4.1+ layouts', () => {
  const legacy = countAnimationJsonStats({ deform: { default: { body: { mesh: [{}, { time: 1 }] } } } });
  assert.equal(legacy.deformKeys, 2);
  const modern = countAnimationJsonStats({
    attachments: { default: { body: { mesh: { deform: [{}, { time: 1 }, { time: 2 }], sequence: [{}] } } } },
  });
  assert.equal(modern.deformKeys, 3);
  assert.equal(modern.sequenceKeys, 1);
});

test('countAnimationJsonStats counts constraint timelines', () => {
  const stats = countAnimationJsonStats({
    ik: { leg: [{}, { time: 1 }] },
    path: { spine: { position: [{}, { time: 1 }] } },
  });
  assert.equal(stats.constraintKeys, 4);
  assert.equal(stats.keys, 4);
});

test('runtimeFindingsFromPerf flags blend modes even when Normal is listed first', async () => {
  const { runtimeFindingsFromPerf } = await import('../src/features/assetHealth/rules/runtimePillars.js');
  const findings = runtimeFindingsFromPerf({
    bones: 10, vertexCount: 100, drawCalls: 2, clippingCount: 0, constraints: 0,
    blends: 'Normal: 10, Additive: 2, Screen: 1',
  });
  assert.ok(findings.some((f) => f.id === 'runtime-blend'));
});

test('runtimeFindingsFromPerf does not flag Additive, which batches with Normal', async () => {
  const { runtimeFindingsFromPerf } = await import('../src/features/assetHealth/rules/runtimePillars.js');
  const findings = runtimeFindingsFromPerf({
    bones: 10, vertexCount: 100, drawCalls: 2, clippingCount: 0, constraints: 0,
    blends: 'Normal: 10, Additive: 2',
  });
  assert.ok(!findings.some((f) => f.id === 'runtime-blend'));
});

test('runtimeFindingsFromPerf scores vertices and draw calls as separate categories', async () => {
  const { runtimeFindingsFromPerf } = await import('../src/features/assetHealth/rules/runtimePillars.js');
  const findings = runtimeFindingsFromPerf({
    bones: 10, vertexCount: 5000, drawCalls: 40, clippingCount: 0, constraints: 0, blends: 'None',
  });
  const { breakdown } = scoreFromFindings(findings);
  assert.equal(breakdown['runtime.vertices'], 15);
  assert.equal(breakdown['runtime.drawcalls'], 15);
});
