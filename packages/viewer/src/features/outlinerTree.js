import { matchesFilter } from './slotPick.js';

/**
 * Outliner tree of one asset, in Studio's layout: Bones (slots under their bone, attachments under their slot),
 * Skins, Constraints, Events and Draw order. Pure data, so the view can rebuild it on every render.
 *
 * @typedef {'asset' | 'group' | 'bone' | 'slot' | 'attachment' | 'skin' | 'constraint' | 'event' | 'order'} OutlinerKind
 * @typedef {{
 *   key: string,
 *   kind: OutlinerKind,
 *   name: string,
 *   meta?: string,
 *   slot?: string,
 *   bone?: string,
 *   skin?: string,
 *   type?: string,
 *   hidden?: boolean,
 *   keyed?: boolean,
 *   children: OutlinerNode[],
 * }} OutlinerNode
 * @typedef {{ node: OutlinerNode, depth: number, path: string[], index: number }} OutlinerRow
 */

const CONSTRAINT_TYPES = [
  ['ikConstraints', 'IK', 'ik'],
  ['transformConstraints', 'Transform', 'transform'],
  ['pathConstraints', 'Path', 'path'],
  ['physicsConstraints', 'Physics', 'physics'],
];

/**
 * @param {string} instId
 * @param {string} name
 * @param {any} data skeleton data
 * @param {{
 *   skins?: Iterable<string>,
 *   drawOrder?: { data: { name: string } }[],
 *   hiddenSlots?: ReadonlySet<string>,
 *   keyed?: { bones: ReadonlySet<string>, slots: ReadonlySet<string> },
 * }} [live]
 * @returns {OutlinerNode}
 */
export function buildAssetTree(instId, name, data, live = {}) {
  const k = (/** @type {string} */ suffix) => `${instId}|${suffix}`;
  const bones = data?.bones || [];
  const slots = data?.slots || [];
  const skins = data?.skins || [];

  /** @type {Map<number, OutlinerNode>} */
  const boneNodes = new Map();
  for (const bone of bones) {
    boneNodes.set(bone.index, {
      key: k(`b:${bone.name}`), kind: 'bone', name: bone.name, bone: bone.name, meta: bone.parentIndex < 0 ? 'root' : '',
      keyed: !!live.keyed?.bones.has(bone.name), children: [],
    });
  }
  // Studio order: child bones first, then the bone's slots.
  /** @type {OutlinerNode[]} */
  const roots = [];
  for (const bone of bones) {
    const node = /** @type {OutlinerNode} */ (boneNodes.get(bone.index));
    const parent = bone.parentIndex >= 0 ? boneNodes.get(bone.parentIndex) : null;
    (parent ? parent.children : roots).push(node);
  }
  const attachmentSkins = activeAttachmentSkins(data, live.skins);
  for (const slot of slots) {
    const owner = boneNodes.get(slot.boneIndex);
    if (!owner) continue;
    owner.children.push({
      key: k(`s:${slot.name}`),
      kind: 'slot',
      name: slot.name,
      slot: slot.name,
      hidden: !!live.hiddenSlots?.has(slot.name),
      keyed: !!live.keyed?.slots.has(slot.name),
      children: slotAttachments(slot, attachmentSkins).map((item) => ({
        key: k(`a:${slot.name}/${item.skin}/${item.name}`),
        kind: /** @type {const} */ ('attachment'),
        name: item.name,
        slot: slot.name,
        skin: item.skin,
        type: item.type,
        meta: item.skin === 'default' ? '' : item.skin,
        children: [],
      })),
    });
  }

  /** @type {OutlinerNode[]} */
  const groups = [group(k('g:bones'), 'Bones & slots', roots, '', 'bones')];
  groups.push(group(k('g:skins'), 'Skins', skins.map((skin) => ({ key: k(`k:${skin.name}`), kind: /** @type {const} */ ('skin'), name: skin.name, skin: skin.name, children: [] })), undefined, 'skins'));
  const constraints = [];
  for (const [field, label, type] of CONSTRAINT_TYPES) {
    for (const item of data?.[field] || []) constraints.push({ key: k(`c:${field}/${item.name}`), kind: /** @type {const} */ ('constraint'), name: item.name, type, meta: label, children: [] });
  }
  if (constraints.length) groups.push(group(k('g:constraints'), 'Constraints', constraints, undefined, 'constraints'));
  const events = data?.events || [];
  if (events.length) groups.push(group(k('g:events'), 'Events', events.map((event) => ({ key: k(`e:${event.name}`), kind: /** @type {const} */ ('event'), name: event.name, children: [] })), undefined, 'events'));
  const order = live.drawOrder?.length ? live.drawOrder.map((slot) => slot.data.name) : slots.map((slot) => slot.name);
  if (order.length) {
    groups.push(group(k('g:order'), 'Draw order', order.map((slotName, index) => ({
      key: k(`o:${slotName}`), kind: /** @type {const} */ ('order'), name: slotName, slot: slotName, meta: String(index + 1),
      hidden: !!live.hiddenSlots?.has(slotName), children: [],
    })), undefined, 'order'));
  }
  return { key: k('asset'), kind: 'asset', name, children: groups };
}

/** @param {string} key @param {string} name @param {OutlinerNode[]} children @param {string} [meta] @param {string} [type] */
function group(key, name, children, meta = children.length ? String(children.length) : '', type = '') {
  return { key, kind: /** @type {const} */ ('group'), name, meta, type, children };
}

/**
 * Skins whose attachments the slots can show, lowest priority first: the default skin, then the chosen ones
 * (later ones win, as in `applySkins`).
 * @param {any} data
 * @param {Iterable<string> | undefined} chosen
 */
function activeAttachmentSkins(data, chosen) {
  const byName = new Map((data?.skins || []).map((skin) => [skin.name, skin]));
  const list = [];
  if (data?.defaultSkin) list.push(data.defaultSkin);
  for (const name of chosen || []) {
    const skin = byName.get(name);
    if (skin && skin !== data?.defaultSkin) list.push(skin);
  }
  return list;
}

/**
 * Attachments a slot can show with the active skins; a later skin replaces an attachment of the same key.
 * @param {{ index: number }} slot
 * @param {any[]} skins
 * @returns {{ name: string, skin: string, type: string }[]}
 */
function slotAttachments(slot, skins) {
  /** @type {Map<string, { name: string, skin: string, type: string }>} */
  const byKey = new Map();
  for (const skin of skins) {
    const entries = skin.attachments?.get?.(slot.index);
    if (!entries) continue;
    for (const [key, attachment] of entries) byKey.set(key, { name: key, skin: skin.name, type: attachment?.type || '' });
  }
  return [...byKey.values()];
}

/**
 * Flatten the trees into the rows to draw. With a text filter or type filter, a row shows when it or a descendant
 * matches, and every branch on the way is open; without one, `isOpen` decides.
 * @param {OutlinerNode[]} trees
 * @param {(node: OutlinerNode) => boolean} isOpen
 * @param {string} [filter]
 * @param {ReadonlySet<string>} [kinds] row kinds to keep (bone, slot, attachment, constraint, event, order;
 *   `hidden` keeps slots switched off on the stage)
 * @returns {OutlinerRow[]}
 */
export function visibleRows(trees, isOpen, filter = '', kinds = new Set()) {
  const text = String(filter).trim();
  const filtering = !!text || kinds.size > 0;
  /** @type {OutlinerRow[]} */
  const rows = [];
  /** @param {OutlinerNode} node */
  const self = (node) => (!text || matchesFilter(node.name, text))
    && (!kinds.size || kinds.has(node.kind) || (kinds.has('hidden') && node.kind === 'slot' && !!node.hidden));
  /** @type {Map<OutlinerNode, boolean>} */
  const memo = new Map();
  /** @param {OutlinerNode} node @returns {boolean} */
  const matches = (node) => {
    let hit = memo.get(node);
    if (hit === undefined) {
      hit = (node.kind !== 'asset' && self(node)) || node.children.some(matches);
      memo.set(node, hit);
    }
    return hit;
  };
  /** @param {OutlinerNode} node @param {number} depth @param {string[]} path */
  const walk = (node, depth, path) => {
    // Asset rows always show while filtering, so the scene list keeps its shape; they open only when something matches.
    if (filtering && node.kind !== 'asset' && !matches(node)) return;
    rows.push({ node, depth, path, index: rows.length });
    const open = filtering ? node.children.some(matches) : isOpen(node);
    if (!open) return;
    for (const child of node.children) walk(child, depth + 1, [...path, node.key]);
  };
  for (const tree of trees) walk(tree, 0, []);
  return rows;
}

/**
 * Keys of the branches above the first node `match` accepts, so it can be revealed.
 * @param {OutlinerNode} tree
 * @param {(node: OutlinerNode) => boolean} match
 * @returns {string[] | null}
 */
export function pathTo(tree, match) {
  /** @param {OutlinerNode} node @param {string[]} path @returns {string[] | null} */
  const walk = (node, path) => {
    if (match(node)) return path;
    for (const child of node.children) {
      const found = walk(child, [...path, node.key]);
      if (found) return found;
    }
    return null;
  };
  return walk(tree, []);
}

/** Everything starts shut; branches open when clicked. @param {OutlinerNode} _node */
export function openByDefault(_node) {
  return false;
}

const BONE_KINDS = new Set(['rotate', 'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'shear', 'shearx', 'sheary', 'inherit']);
const SLOT_KINDS = new Set(['rgba', 'rgb', 'alpha', 'rgba2', 'rgb2', 'attachment', 'deform', 'sequence']);

/**
 * Bones and slots the given animations key, by name, for the outliner's keyed badges.
 * @param {any} data skeleton data
 * @param {Iterable<{ timelines?: { kind: string, target?: number }[] } | null | undefined>} animations
 */
export function keyedTargets(data, animations) {
  /** @type {Set<string>} */
  const bones = new Set();
  /** @type {Set<string>} */
  const slots = new Set();
  for (const animation of animations) {
    for (const timeline of animation?.timelines || []) {
      const target = timeline.target ?? -1;
      if (BONE_KINDS.has(timeline.kind)) {
        const name = data?.bones?.[target]?.name;
        if (name) bones.add(name);
      } else if (SLOT_KINDS.has(timeline.kind)) {
        const name = data?.slots?.[target]?.name;
        if (name) slots.add(name);
      }
    }
  }
  return { bones, slots };
}
