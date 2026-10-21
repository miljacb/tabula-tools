import assert from 'node:assert/strict';
import test from 'node:test';
import { atlasPageNames } from '../src/tabula/atlasPages.js';

test('reads page names and ignores region names', () => {
  const text = `hero.png
size: 64,64
format: RGBA8888
filter: Linear,Linear
repeat: none
box
  rotate: false
  xy: 0, 0
  size: 64, 64
  orig: 64, 64
  offset: 0, 0
  index: -1
extra.webp
size: 32,32
format: RGBA8888
filter: Linear,Linear
repeat: none
mark
  rotate: false
  xy: 0, 0
  size: 32, 32
  orig: 32, 32
  offset: 0, 0
  index: -1
`;
  assert.deepEqual(atlasPageNames(text), ['hero.png', 'extra.webp']);
});
