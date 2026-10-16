/**
 * Combined skins: several skins of one skeleton shown together (a symbol
 * value plus an effect, an outfit plus a weapon), with no `Skin` objects to
 * build by hand.
 *
 * A combined skin is an ordinary {@link SkinData} built once per skeleton
 * data and shared by every view of it. It holds the parts' attachment
 * objects themselves (no copies), so baked playback, deform, bounds and
 * packed sleeping frames treat it like any other skin. Showing one costs what
 * `setSkin` always costs; frames cost nothing extra.
 */

import type { Attachment, SkeletonData, SkinData } from './types.js';

/** A skin by name, or the names of skins to combine (later names win where two fill the same slot attachment). */
export type SkinSelector = string | readonly string[];

/** A combined skin and the names it was built from. */
interface CombinedSkin extends SkinData {
  readonly parts: readonly string[];
}

interface SkinRegistry {
  /** Names given with {@link defineSkin}. */
  readonly named: Map<string, { skin: CombinedSkin; key: string }>;
  /** Unnamed combinations by their parts (see {@link comboKey}). */
  readonly combined: Map<string, CombinedSkin>;
}

const registries = new WeakMap<SkeletonData, SkinRegistry>();

function registry(data: SkeletonData): SkinRegistry {
  let r = registries.get(data);
  if (!r) registries.set(data, (r = { named: new Map(), combined: new Map() }));
  return r;
}

function dataOf(target: SkeletonData | { readonly data: SkeletonData }): SkeletonData {
  // SkeletonData is the one with a skin list; assets, skeletons and clips hold theirs in `data`.
  return Array.isArray((target as SkeletonData).skins) ? (target as SkeletonData) : (target as { readonly data: SkeletonData }).data;
}

/** Cache key of a combination: parts joined by a character no skin name contains in practice. */
const comboKey = (parts: readonly string[]): string => parts.join('\u0000');

function exportedSkin(data: SkeletonData, name: string): SkinData | undefined {
  return data.skins.find((s) => s.name === name);
}

function combine(data: SkeletonData, name: string, parts: readonly string[]): CombinedSkin {
  if (parts.length === 0) throw new Error(`tabula: skin "${name}" of "${data.name}" combines no skins`);
  const attachments = new Map<number, Map<string, Attachment>>();
  const bones = new Set<number>();
  const constraints = new Set<string>();
  for (const part of parts) {
    const skin = resolveSkin(data, part);
    if (!skin) throw new Error(`tabula: skin "${part}" not found in skeleton "${data.name}"`);
    for (const [slot, map] of skin.attachments) {
      let into = attachments.get(slot);
      if (!into) attachments.set(slot, (into = new Map()));
      for (const [key, attachment] of map) into.set(key, attachment);
    }
    for (const b of skin.bones ?? []) bones.add(b);
    for (const c of skin.constraints ?? []) constraints.add(c);
  }
  return { name, attachments, bones: [...bones], constraints: [...constraints], parts: [...parts] };
}

/**
 * Give a combination of skins a name on a skeleton (or its loaded asset), so
 * views, pools and clip options can ask for it by that name. Defining the
 * same name again with the same parts is a no-op; with other parts, or with
 * the name of an exported skin, it throws. Returns the combined skin.
 *
 * @example
 * ```ts
 * defineSkin(asset, 'wild10', ['10', 'explode']);
 * view.clip.setSkin('wild10');
 * pool.acquire({ skin: 'wild10' });
 * ```
 */
export function defineSkin(target: SkeletonData | { readonly data: SkeletonData }, name: string, parts: readonly string[]): SkinData {
  const data = dataOf(target);
  if (exportedSkin(data, name)) throw new Error(`tabula: "${name}" is already a skin of "${data.name}"`);
  const r = registry(data);
  const key = comboKey(parts);
  const existing = r.named.get(name);
  if (existing) {
    if (existing.key === key) return existing.skin;
    throw new Error(`tabula: skin "${name}" of "${data.name}" is already defined as ${existing.skin.parts.join('+')}`);
  }
  const skin = combine(data, name, parts);
  r.named.set(name, { skin, key });
  return skin;
}

/**
 * The skin a selector names: an exported skin, a {@link defineSkin} name, or
 * (for an array) the parts combined, built once and cached. Null when a name
 * is unknown.
 */
export function resolveSkin(target: SkeletonData | { readonly data: SkeletonData }, selector: SkinSelector): SkinData | null {
  const data = dataOf(target);
  if (typeof selector === 'string') return exportedSkin(data, selector) ?? registries.get(data)?.named.get(selector)?.skin ?? null;
  if (selector.length === 1) return resolveSkin(data, selector[0]!);
  if (selector.length === 0) return null;
  const r = registry(data);
  const key = comboKey(selector);
  let skin = r.combined.get(key);
  if (!skin) {
    for (const part of selector) if (!resolveSkin(data, part)) return null;
    r.combined.set(key, (skin = combine(data, selector.join('+'), selector)));
  }
  return skin;
}

/** Names of the skins given with {@link defineSkin} on this skeleton. */
export function definedSkins(target: SkeletonData | { readonly data: SkeletonData }): string[] {
  return [...(registries.get(dataOf(target))?.named.keys() ?? [])];
}
