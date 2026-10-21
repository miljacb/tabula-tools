import assert from 'node:assert/strict';
import test from 'node:test';
import { canRedo, canUndo, clearHistory, configureHistory, redo, undo, withHistory } from '../src/app/history.js';

test('withHistory undoes and redoes a value', async () => {
  let value = 0;
  configureHistory({
    capture: () => ({ value }),
    apply: (snap) => { value = snap.value; },
  });
  clearHistory();
  withHistory(() => { value = 1; });
  assert.equal(value, 1);
  assert.equal(canUndo(), true);
  await undo();
  assert.equal(value, 0);
  assert.equal(canRedo(), true);
  await redo();
  assert.equal(value, 1);
});

test('clearHistory drops both stacks', async () => {
  let value = 0;
  configureHistory({
    capture: () => ({ value }),
    apply: (snap) => { value = snap.value; },
  });
  withHistory(() => { value = 2; });
  clearHistory();
  assert.equal(canUndo(), false);
  assert.equal(await undo(), false);
});
