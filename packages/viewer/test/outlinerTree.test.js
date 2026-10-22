import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAssetTree, keyedTargets, openByDefault, pathTo, visibleRows } from '../src/features/outlinerTree.js';

const region = { type: 'region' };
const defaultSkin = { name: 'default', attachments: new Map([[0, new Map([['body', region]])], [1, new Map([['arm', region]])]]) };
const red = { name: 'red', attachments: new Map([[1, new Map([['arm', { type: 'mesh' }], ['arm-red', region]])]]) };
const data = {
  bones: [
    { index: 0, name: 'root', parentIndex: -1 },
    { index: 1, name: 'hip', parentIndex: 0 },
    { index: 2, name: 'arm', parentIndex: 1 },
  ],
  slots: [
    { index: 0, name: 'body', boneIndex: 1 },
    { index: 1, name: 'arm', boneIndex: 2 },
  ],
  skins: [defaultSkin, red],
  defaultSkin,
  events: [{ name: 'step' }],
  ikConstraints: [{ name: 'aim' }],
  transformConstraints: [],
  pathConstraints: [],
  physicsConstraints: [],
};

/** @param {any} node @param {string} name */
const child = (node, name) => node.children.find((item) => item.name === name);

test('child bones come first, then the bone\'s slots (Studio order)', () => {
  const tree = buildAssetTree('i1', 'hero', data);
  const bones = child(tree, 'Bones & slots');
  assert.equal(bones.name, 'Bones & slots');
  const hip = child(child(bones, 'root'), 'hip');
  assert.deepEqual(hip.children.map((node) => `${node.kind}:${node.name}`), ['bone:arm', 'slot:body']);
  assert.deepEqual(child(hip, 'body').children.map((node) => node.name), ['body']);
  assert.deepEqual(tree.children.map((node) => node.name), ['Bones & slots', 'Skins', 'Constraints', 'Events', 'Draw order']);
  assert.equal(child(child(tree, 'Constraints'), 'aim').meta, 'IK');
});

test('chosen skins replace and add attachments over the default skin', () => {
  const plain = buildAssetTree('i1', 'hero', data);
  const armSlot = (tree) => child(child(child(child(child(tree, 'Bones & slots'), 'root'), 'hip'), 'arm'), 'arm');
  assert.deepEqual(armSlot(plain).children.map((node) => [node.name, node.skin]), [['arm', 'default']]);
  const skinned = buildAssetTree('i1', 'hero', data, { skins: ['red'] });
  assert.deepEqual(armSlot(skinned).children.map((node) => [node.name, node.skin, node.meta]), [['arm', 'red', 'red'], ['arm-red', 'red', 'red']]);
});

test('draw order follows the live skeleton', () => {
  const tree = buildAssetTree('i1', 'hero', data, { drawOrder: [{ data: { name: 'arm' } }, { data: { name: 'body' } }] });
  assert.deepEqual(child(tree, 'Draw order').children.map((node) => node.name), ['arm', 'body']);
});

test('visibleRows respects open state, and a filter opens the way to matches', () => {
  const tree = buildAssetTree('i1', 'hero', data);
  const shut = visibleRows([tree], (node) => node.kind !== 'asset' && openByDefault(node));
  assert.deepEqual(shut.map((row) => row.node.name), ['hero']);
  assert.equal(openByDefault(tree.children[0]), false);
  const opened = new Set(['i1|asset', 'i1|g:bones', 'i1|b:root', 'i1|b:hip']);
  const open = visibleRows([tree], (node) => opened.has(node.key));
  assert.deepEqual(open.map((row) => row.node.name).slice(0, 7), ['hero', 'Bones & slots', 'root', 'hip', 'arm', 'body', 'Skins']);
  const filtered = visibleRows([tree], () => false, 'arm-red');
  assert.deepEqual(filtered.map((row) => row.node.name), ['hero']);
  const skinnedTree = buildAssetTree('i1', 'hero', data, { skins: ['red'] });
  assert.deepEqual(visibleRows([skinnedTree], () => false, 'arm-red').map((row) => row.node.name), ['hero', 'Bones & slots', 'root', 'hip', 'arm', 'arm', 'arm-red']);
  const filteredOpen = visibleRows([tree], (node) => node.kind === 'asset', 'step');
  assert.deepEqual(filteredOpen.map((row) => row.node.name), ['hero', 'Events', 'step']);
});

test('type filter keeps only rows of those kinds, with their parents', () => {
  const tree = buildAssetTree('i1', 'hero', data);
  const rows = visibleRows([tree], () => false, '', new Set(['constraint', 'event']));
  assert.deepEqual(rows.map((row) => row.node.name), ['hero', 'Constraints', 'aim', 'Events', 'step']);
  assert.deepEqual(visibleRows([tree], () => false, 'body', new Set(['slot'])).map((row) => row.node.name), ['hero', 'Bones & slots', 'root', 'hip', 'body']);
});

test('pathTo lists the branches above a node', () => {
  const tree = buildAssetTree('i1', 'hero', data);
  assert.deepEqual(pathTo(tree, (node) => node.key === 'i1|s:arm'), ['i1|asset', 'i1|g:bones', 'i1|b:root', 'i1|b:hip', 'i1|b:arm']);
});

test('hidden filter keeps slots switched off on the stage', () => {
  const tree = buildAssetTree('i1', 'hero', data, { hiddenSlots: new Set(['arm']) });
  assert.deepEqual(visibleRows([tree], () => false, '', new Set(['hidden'])).map((row) => row.node.name), ['hero', 'Bones & slots', 'root', 'hip', 'arm', 'arm']);
});

test('keyedTargets names the bones and slots an animation keys', () => {
  const keyed = keyedTargets(data, [{ timelines: [{ kind: 'rotate', target: 2 }, { kind: 'attachment', target: 0 }, { kind: 'drawOrder' }] }]);
  assert.deepEqual([...keyed.bones], ['arm']);
  assert.deepEqual([...keyed.slots], ['body']);
  const tree = buildAssetTree('i1', 'hero', data, { keyed });
  assert.equal(child(child(child(child(tree, 'Bones & slots'), 'root'), 'hip'), 'arm').keyed, true);
});
