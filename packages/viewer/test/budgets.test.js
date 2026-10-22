import assert from 'node:assert/strict';
import test from 'node:test';
import { activeLimits, budgetLevel, BUDGET_PRESETS, setBudget } from '../src/features/budgets.js';

test('budgetLevel: ok to 80%, near to 100%, over above', () => {
  assert.equal(budgetLevel(80, 100), 'ok');
  assert.equal(budgetLevel(81, 100), 'near');
  assert.equal(budgetLevel(100, 100), 'near');
  assert.equal(budgetLevel(101, 100), 'over');
});

test('setBudget picks presets, keeps valid custom values and rejects unknown presets', () => {
  setBudget({ preset: 'desktop' });
  assert.deepEqual(activeLimits(), BUDGET_PRESETS.desktop.limits);
  setBudget({ preset: 'custom', custom: { drawCalls: 12, vertices: -5 } });
  assert.equal(activeLimits()?.drawCalls, 12);
  assert.ok((activeLimits()?.vertices ?? 0) > 0);
  setBudget({ preset: 'nope' });
  assert.equal(activeLimits(), null);
});

test('recording CSV has a header and quotes cells with commas', async () => {
  const { toCsv } = await import('../src/ui/perfExtras.js');
  const csv = toCsv([{ t: 16.7, frameMs: 16.666, updateMs: 1.2, renderMs: 2.3, drawCalls: 3, vertices: 400, triangles: 200, heapMb: null, stutter: '', playing: 'hero, idle' }]);
  const [head, row] = csv.split('\n');
  assert.equal(head, 't,frameMs,updateMs,renderMs,drawCalls,vertices,triangles,heapMb,stutter,playing');
  assert.equal(row, '16.7,16.67,1.2,2.3,3,400,200,,,"hero, idle"');
});
