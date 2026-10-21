import assert from 'node:assert/strict';
import test from 'node:test';
import { findingHelpText, healthScoreHue } from '../src/features/assetHealth/findingHelp.js';

test('healthScoreHue maps 0 to red and 100 to green', () => {
  assert.equal(healthScoreHue(0), 0);
  assert.equal(healthScoreHue(100), 120);
  assert.ok(healthScoreHue(50) > 50 && healthScoreHue(50) < 70);
});

test('findingHelpText includes fix guidance for known ids', () => {
  const text = findingHelpText({
    id: 'export-atlas-vram-fail',
    level: 'fail',
    category: 'export.atlas',
    title: 'x',
    detail: 'y',
  });
  assert.match(text, /Usually fixed:/);
  assert.match(text, /atlas/i);
});
