/**
 * Build-time validator: checks a parsed skeleton (and optionally its atlas)
 * against what the Tabula runtime renders. Errors fail the build; warnings and
 * notes are reported.
 */

import { BlendMode, Inherit } from './types.js';
import type { AtlasData, MeshAttachment, RegionAttachment, SkeletonData } from './types.js';
import { attachmentRegionPaths } from './regions.js';

/** Validator findings. Errors block baking; warnings and notes are informational. */
export interface ValidationResult {
  /** Unsupported features or missing data: the asset would not render correctly. */
  errors: string[];
  /** Supported but costly or ignored content. */
  warnings: string[];
  /** Informational findings (e.g. how clipping is configured). */
  notes: string[];
}

/** Validate `data`; pass `atlas` to also check that every referenced region exists. */
export function validateSkeleton(data: SkeletonData, atlas?: AtlasData): ValidationResult {
  const result: ValidationResult = { errors: [], warnings: [], notes: [] };

  for (const u of data.unsupported) result.errors.push(`Unsupported ${u.feature}: ${u.detail}`);
  for (const note of data.notes ?? []) result.warnings.push(note);

  const pathTargets = new Set(data.pathConstraints.map((c) => c.targetSlotIndex));
  for (const c of data.pathConstraints) {
    result.notes.push(`Path constraint "${c.name}" drives ${c.bones.length} bone(s) along slot "${data.slots[c.targetSlotIndex]!.name}"`);
  }

  const boneName = (i: number): string => data.bones[i]!.name;
  for (const c of data.ikConstraints ?? []) {
    const [first, second] = c.bones;
    if (data.bones[first!]!.parentIndex < 0) result.errors.push(`IK constraint "${c.name}": bone "${boneName(first!)}" has no parent (spine-core throws)`);
    if (second !== undefined) {
      if (data.bones[second]!.parentIndex !== first) result.errors.push(`IK constraint "${c.name}": "${boneName(second)}" is not a direct child of "${boneName(first!)}"`);
      if (data.bones[second]!.inherit !== Inherit.Normal || data.bones[first!]!.inherit !== Inherit.Normal) {
        result.warnings.push(`IK constraint "${c.name}": two-bone IK only affects bones with normal inheritance (as in spine-core); it is a no-op here`);
      }
    }
    result.notes.push(`IK constraint "${c.name}": ${c.bones.length} bone(s) -> "${boneName(c.target)}"`);
  }
  for (const c of data.transformConstraints ?? []) {
    result.notes.push(`Transform constraint "${c.name}" (${c.local ? 'local' : 'world'}, ${c.relative ? 'relative' : 'absolute'}): ${c.bones.length} bone(s) -> "${boneName(c.target)}"`);
  }
  for (const c of data.physicsConstraints ?? []) {
    result.notes.push(`Physics constraint "${c.name}" on bone "${boneName(c.bone)}": simulated live at ${Math.round(1 / c.step)} Hz; animations of this skeleton are not baked`);
  }

  for (const slot of data.slots) {
    if (slot.blendMode === BlendMode.Multiply || slot.blendMode === BlendMode.Screen) {
      result.warnings.push(`Slot "${slot.name}" uses ${BlendMode[slot.blendMode]} blending: costs a batch break when drawn`);
    }
  }

  const missing = new Set<string>();
  const checkRegion = (attachment: RegionAttachment | MeshAttachment): void => {
    if (!atlas) return;
    for (const p of attachmentRegionPaths(attachment)) if (!atlas.regions.has(p)) missing.add(p);
  };

  for (const skin of data.skins) {
    for (const [slotIndex, attachments] of skin.attachments) {
      const slotName = data.slots[slotIndex]!.name;
      for (const attachment of attachments.values()) {
        switch (attachment.type) {
          case 'region':
          case 'mesh':
            checkRegion(attachment);
            break;
          case 'path':
            if (!pathTargets.has(slotIndex)) {
              result.warnings.push(`Path attachment "${attachment.name}" (slot "${slotName}") is not used by any path constraint: inert, ignored`);
            }
            break;
          case 'clipping': {
            const end = attachment.endSlotIndex;
            const range =
              end < 0 || end === slotIndex
                ? 'until the end of the draw order (no end slot / self-ended, same as the official runtimes)'
                : `through slot "${data.slots[end]!.name}"`;
            result.notes.push(`Clipping "${attachment.name}" (slot "${slotName}", ${attachment.worldVerticesLength / 2} vertices) clips ${range}`);
            break;
          }
          default:
            break;
        }
      }
    }
  }
  for (const p of missing) result.errors.push(`Atlas region "${p}" not found`);

  const inheritAnimations = data.animations.filter((a) => a.timelines.some((t) => t.kind === 'inherit')).map((a) => a.name);
  if (inheritAnimations.length > 0) {
    result.notes.push(`Inherit timelines (Spine 4.2) in: ${inheritAnimations.join(', ')}. Honored here; the official 4.1 runtime ignores them.`);
  }
  return result;
}
