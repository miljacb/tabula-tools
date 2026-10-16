/**
 * Spine 4.1 / 4.2 JSON adapter: parses a Spine JSON export into the runtime IR.
 *
 * Part of the version-adapter layer (design §7.3): this is the only place that
 * knows the JSON format. It normalizes semantics, not just syntax — per-version
 * defaults are filled in explicitly, linked meshes are resolved, weighted vertex
 * data is split into bones/vertices, and every timeline uses the single
 * {@link CurveTimeline} representation.
 *
 * The test assets declare `"spine": "4.1-from-4.2.43"`: authored in Spine 4.2.43,
 * exported in 4.1 format. A few 4.2 keys appear in them (bone `inherit`, the
 * `inherit` timeline) and are accepted as well.
 */

import {
  IK_FLAG_BEND_POSITIVE,
  IK_FLAG_COMPRESS,
  IK_FLAG_STRETCH,
  BlendMode,
  Inherit,
  PositionMode,
  RotateMode,
  SequenceMode,
  SpacingMode,
  type Attachment,
  type AnimationData,
  type BoneData,
  type Color,
  type CurveData,
  type CurveTimeline,
  type CurveTimelineKind,
  type DarkColor,
  type DrawOrderTimeline,
  type EventData,
  type EventKey,
  type IkConstraintData,
  type MeshAttachment,
  type PhysicsConstraintData,
  type TransformConstraintData,
  type PathConstraintData,
  type SequenceData,
  type SkeletonData,
  type SkinData,
  type SlotData,
  type Timeline,
  type VertexAttachment,
  type VertexData,
} from '../types.js';

// ============================================================================
// JSON shapes (only the parts we read)
// ============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

const DEFAULT_SEQUENCE_START = 1;

const INHERIT_MODES: Record<string, Inherit> = {
  normal: Inherit.Normal,
  onlyTranslation: Inherit.OnlyTranslation,
  noRotationOrReflection: Inherit.NoRotationOrReflection,
  noScale: Inherit.NoScale,
  noScaleOrReflection: Inherit.NoScaleOrReflection,
};

const BLEND_MODES: Record<string, BlendMode> = {
  normal: BlendMode.Normal,
  additive: BlendMode.Additive,
  multiply: BlendMode.Multiply,
  screen: BlendMode.Screen,
};

const SEQUENCE_MODES: Record<string, SequenceMode> = {
  hold: SequenceMode.Hold,
  once: SequenceMode.Once,
  loop: SequenceMode.Loop,
  pingpong: SequenceMode.Pingpong,
  onceReverse: SequenceMode.OnceReverse,
  loopReverse: SequenceMode.LoopReverse,
  pingpongReverse: SequenceMode.PingpongReverse,
};

/** Bone timeline key -> (kind, channel names, default value). */
const BONE_TIMELINES: Record<string, { kind: CurveTimelineKind; keys: string[]; defaultValue: number }> = {
  rotate: { kind: 'rotate', keys: ['value'], defaultValue: 0 },
  translate: { kind: 'translate', keys: ['x', 'y'], defaultValue: 0 },
  translatex: { kind: 'translatex', keys: ['value'], defaultValue: 0 },
  translatey: { kind: 'translatey', keys: ['value'], defaultValue: 0 },
  scale: { kind: 'scale', keys: ['x', 'y'], defaultValue: 1 },
  scalex: { kind: 'scalex', keys: ['value'], defaultValue: 1 },
  scaley: { kind: 'scaley', keys: ['value'], defaultValue: 1 },
  shear: { kind: 'shear', keys: ['x', 'y'], defaultValue: 0 },
  shearx: { kind: 'shearx', keys: ['value'], defaultValue: 0 },
  sheary: { kind: 'sheary', keys: ['value'], defaultValue: 0 },
};

interface PendingLinkedMesh {
  mesh: MeshAttachment;
  skinName: string | null;
  slotIndex: number;
  parentName: string;
  inheritTimelines: boolean;
}

// ============================================================================
// Parser
// ============================================================================

/**
 * JSON format versions this adapter reads: Spine 4.1 data (including exports
 * written by a newer editor in 4.1 format, "4.1-from-4.2.43") and Spine 4.2
 * data (adds physics constraints, `referenceScale` and the bone `inherit` key).
 * Newer 4.x exports are read best-effort (with notes for the validator);
 * Spine 5 and anything before 4.1 are rejected.
 */
const SUPPORTED_VERSION = /^4\.[12](\.|-|$)/;

/** Top-level sections of a 4.1 / 4.2 export (others are reported for newer versions). */
const KNOWN_SECTIONS = new Set(['skeleton', 'bones', 'slots', 'ik', 'transform', 'path', 'physics', 'skins', 'events', 'animations']);

/** Check the export's Spine version; returns notes for a newer 4.x, throws for unsupported versions. */
export function checkSpineVersion(version: string, name: string, root: Record<string, unknown>): string[] {
  if (SUPPORTED_VERSION.test(version)) return [];
  const m = /^(\d+)\.(\d+)/.exec(version);
  const major = m ? Number(m[1]) : NaN;
  const minor = m ? Number(m[2]) : NaN;
  if (major === 4 && minor > 2) {
    const unknown = Object.keys(root).filter((k) => !KNOWN_SECTIONS.has(k));
    return [
      `Spine ${version} export read best-effort (tested: 4.1, 4.2); check that it plays as in the editor`,
      ...unknown.map((k) => `section "${k}" (new in Spine ${major}.${minor}?) is ignored`),
    ];
  }
  if (major >= 5) throw new Error(`"${name}": Spine ${version} JSON is not supported yet (reads 4.1 and 4.2, newer 4.x best-effort)`);
  throw new Error(`"${name}": unsupported Spine JSON version "${version || 'missing'}"; re-export it as Spine 4.1 or 4.2 JSON`);
}

/** Physics timeline JSON key -> curve timeline kind. */
const PHYSICS_TIMELINES: Record<string, CurveTimelineKind> = {
  inertia: 'physicsInertia',
  strength: 'physicsStrength',
  damping: 'physicsDamping',
  mass: 'physicsMass',
  wind: 'physicsWind',
  gravity: 'physicsGravity',
  mix: 'physicsMix',
};

/** Parses Spine 4.1 and 4.2 JSON exports into {@link SkeletonData}. */
export class SpineJsonParser {
  private data!: SkeletonData;
  private linkedMeshes: PendingLinkedMesh[] = [];

  /**
   * Parse a Spine JSON export.
   * @param json Parsed JSON object.
   * @param name Asset name to store in the IR.
   * @throws if the export is not Spine 4.x JSON from 4.1 on (newer 4.x: best-effort, see `notes`).
   */
  parse(json: unknown, name: string): SkeletonData {
    const root = json as Json;
    const skel = (root.skeleton ?? {}) as Json;
    const version = String(skel.spine ?? '');
    const notes = checkSpineVersion(version, name, root);
    this.linkedMeshes = [];
    this.data = {
      name,
      hash: skel.hash ?? '',
      spineVersion: version,
      ...(notes.length ? { notes } : {}),
      x: skel.x ?? 0,
      y: skel.y ?? 0,
      width: skel.width ?? 0,
      height: skel.height ?? 0,
      bones: [],
      slots: [],
      skins: [],
      defaultSkin: null,
      animations: [],
      events: [],
      pathConstraints: [],
      ikConstraints: [],
      transformConstraints: [],
      physicsConstraints: [],
      referenceScale: skel.referenceScale ?? 100,
      unsupported: [],
      boneIndex: new Map(),
      slotIndex: new Map(),
    };
    const data = this.data;

    for (const boneJson of (root.bones ?? []) as Json[]) {
      const bone = this.parseBone(boneJson, data.bones.length);
      data.boneIndex.set(bone.name, bone.index);
      data.bones.push(bone);
    }
    for (const slotJson of (root.slots ?? []) as Json[]) {
      const slot = this.parseSlot(slotJson, data.slots.length);
      data.slotIndex.set(slot.name, slot.index);
      data.slots.push(slot);
    }
    for (const c of (root.path ?? []) as Json[]) data.pathConstraints.push(this.parsePathConstraint(c));
    for (const c of (root.ik ?? []) as Json[]) data.ikConstraints.push(this.parseIkConstraint(c));
    for (const c of (root.transform ?? []) as Json[]) data.transformConstraints.push(this.parseTransformConstraint(c));
    for (const c of (root.physics ?? []) as Json[]) data.physicsConstraints.push(this.parsePhysicsConstraint(c));

    for (const skinJson of this.skinList(root.skins)) data.skins.push(this.parseSkin(skinJson));
    data.defaultSkin = data.skins.find((s) => s.name === 'default') ?? null;
    this.resolveLinkedMeshes();

    for (const [eventName, e] of Object.entries((root.events ?? {}) as Record<string, Json>)) {
      data.events.push({
        name: eventName,
        intValue: e.int ?? 0,
        floatValue: e.float ?? 0,
        stringValue: e.string ?? '',
        audioPath: e.audio ?? null,
        volume: e.volume ?? 1,
        balance: e.balance ?? 0,
      });
    }

    for (const [animName, animJson] of Object.entries((root.animations ?? {}) as Record<string, Json>)) {
      data.animations.push(this.parseAnimation(animName, animJson));
    }
    return data;
  }

  // ---- constraints ---------------------------------------------------------

  private parseIkConstraint(json: Json): IkConstraintData {
    const bones = ((json.bones ?? []) as string[]).map((b) => this.boneIndexOf(b));
    if (bones.length < 1 || bones.length > 2) throw new Error(`IK constraint "${json.name}" must have 1 or 2 bones`);
    return {
      name: json.name,
      order: json.order ?? 0,
      skinRequired: json.skin ?? false,
      bones,
      target: this.boneIndexOf(json.target),
      mix: json.mix ?? 1,
      softness: json.softness ?? 0,
      bendDirection: (json.bendPositive ?? true) ? 1 : -1,
      compress: json.compress ?? false,
      stretch: json.stretch ?? false,
      uniform: json.uniform ?? false,
    };
  }

  private parseTransformConstraint(json: Json): TransformConstraintData {
    const mixX = json.mixX ?? 1;
    const mixScaleX = json.mixScaleX ?? 1;
    return {
      name: json.name,
      order: json.order ?? 0,
      skinRequired: json.skin ?? false,
      bones: ((json.bones ?? []) as string[]).map((b) => this.boneIndexOf(b)),
      target: this.boneIndexOf(json.target),
      local: json.local ?? false,
      relative: json.relative ?? false,
      offsetRotation: json.rotation ?? 0,
      offsetX: json.x ?? 0,
      offsetY: json.y ?? 0,
      offsetScaleX: json.scaleX ?? 0,
      offsetScaleY: json.scaleY ?? 0,
      offsetShearY: json.shearY ?? 0,
      mixRotate: json.mixRotate ?? 1,
      mixX,
      mixY: json.mixY ?? mixX,
      mixScaleX,
      mixScaleY: json.mixScaleY ?? mixScaleX,
      mixShearY: json.mixShearY ?? 1,
    };
  }

  private parsePhysicsConstraint(json: Json): PhysicsConstraintData {
    return {
      name: json.name,
      order: json.order ?? 0,
      skinRequired: json.skin ?? false,
      bone: this.boneIndexOf(json.bone),
      x: json.x ?? 0,
      y: json.y ?? 0,
      rotate: json.rotate ?? 0,
      scaleX: json.scaleX ?? 0,
      shearX: json.shearX ?? 0,
      limit: json.limit ?? 5000,
      step: 1 / (json.fps ?? 60),
      inertia: json.inertia ?? 1,
      strength: json.strength ?? 100,
      damping: json.damping ?? 1,
      massInverse: 1 / (json.mass ?? 1),
      wind: json.wind ?? 0,
      gravity: json.gravity ?? 0,
      mix: json.mix ?? 1,
      inertiaGlobal: json.inertiaGlobal ?? false,
      strengthGlobal: json.strengthGlobal ?? false,
      dampingGlobal: json.dampingGlobal ?? false,
      massGlobal: json.massGlobal ?? false,
      windGlobal: json.windGlobal ?? false,
      gravityGlobal: json.gravityGlobal ?? false,
      mixGlobal: json.mixGlobal ?? false,
    };
  }

  // ---- setup pose ---------------------------------------------------------

  private parseBone(json: Json, index: number): BoneData {
    const parentIndex = json.parent !== undefined ? this.boneIndexOf(json.parent) : -1;
    const inheritName: string = json.inherit ?? json.transform ?? 'normal';
    return {
      index,
      name: json.name,
      parentIndex,
      length: json.length ?? 0,
      x: json.x ?? 0,
      y: json.y ?? 0,
      rotation: json.rotation ?? 0,
      scaleX: json.scaleX ?? 1,
      scaleY: json.scaleY ?? 1,
      shearX: json.shearX ?? 0,
      shearY: json.shearY ?? 0,
      inherit: INHERIT_MODES[inheritName] ?? Inherit.Normal,
      skinRequired: json.skin ?? false,
    };
  }

  private parseSlot(json: Json, index: number): SlotData {
    return {
      index,
      name: json.name,
      boneIndex: this.boneIndexOf(json.bone),
      color: parseColor(json.color ?? 'ffffffff'),
      darkColor: json.dark ? parseDarkColor(json.dark) : null,
      attachmentName: json.attachment ?? null,
      blendMode: BLEND_MODES[json.blend ?? 'normal'] ?? BlendMode.Normal,
    };
  }

  private parsePathConstraint(json: Json): PathConstraintData {
    const positionMode = json.positionMode === 'fixed' ? PositionMode.Fixed : PositionMode.Percent;
    const spacingMode =
      ({ length: SpacingMode.Length, fixed: SpacingMode.Fixed, percent: SpacingMode.Percent, proportional: SpacingMode.Proportional } as Record<string, SpacingMode>)[
        json.spacingMode ?? 'length'
      ] ?? SpacingMode.Length;
    const rotateMode =
      ({ tangent: RotateMode.Tangent, chain: RotateMode.Chain, chainScale: RotateMode.ChainScale } as Record<string, RotateMode>)[
        json.rotateMode ?? 'tangent'
      ] ?? RotateMode.Tangent;
    const mixX = json.mixX ?? 1;
    return {
      name: json.name,
      order: json.order ?? 0,
      skinRequired: json.skin ?? false,
      bones: ((json.bones ?? []) as string[]).map((b) => this.boneIndexOf(b)),
      targetSlotIndex: this.slotIndexOf(json.target),
      positionMode,
      spacingMode,
      rotateMode,
      offsetRotation: json.rotation ?? 0,
      position: json.position ?? 0,
      spacing: json.spacing ?? 0,
      mixRotate: json.mixRotate ?? 1,
      mixX,
      mixY: json.mixY ?? mixX,
    };
  }

  /** 4.x exports skins as an array; 3.x as an object. Accept both. */
  private skinList(skins: unknown): Json[] {
    if (!skins) return [];
    if (Array.isArray(skins)) return skins as Json[];
    return Object.entries(skins as Record<string, Json>).map(([name, attachments]) => ({ name, attachments }));
  }

  private parseSkin(json: Json): SkinData {
    const skin: SkinData = { name: json.name, attachments: new Map() };
    const bones = ((json.bones ?? []) as string[]).map((b) => this.boneIndexOf(b));
    const constraints = (['ik', 'transform', 'path', 'physics'] as const).flatMap((k) => (json[k] ?? []) as string[]);
    if (bones.length) skin.bones = bones;
    if (constraints.length) skin.constraints = constraints;
    for (const [slotName, entries] of Object.entries((json.attachments ?? {}) as Record<string, Record<string, Json>>)) {
      const slotIndex = this.slotIndexOf(slotName);
      const map = new Map<string, Attachment>();
      for (const [key, attJson] of Object.entries(entries)) {
        const attachment = this.parseAttachment(attJson, key, slotIndex);
        if (attachment) map.set(key, attachment);
      }
      skin.attachments.set(slotIndex, map);
    }
    return skin;
  }

  private parseAttachment(json: Json, key: string, slotIndex: number): Attachment | null {
    const name: string = json.name ?? key;
    const type: string = json.type ?? 'region';
    switch (type) {
      case 'region':
        return {
          type: 'region',
          name,
          path: json.path ?? name,
          x: json.x ?? 0,
          y: json.y ?? 0,
          scaleX: json.scaleX ?? 1,
          scaleY: json.scaleY ?? 1,
          rotation: json.rotation ?? 0,
          width: json.width ?? 32,
          height: json.height ?? 32,
          color: parseColor(json.color ?? 'ffffffff'),
          sequence: parseSequence(json.sequence),
        };
      case 'mesh':
      case 'linkedmesh': {
        const mesh: MeshAttachment = {
          type: 'mesh',
          name,
          path: json.path ?? name,
          regionUVs: new Float32Array(0),
          triangles: new Uint16Array(0),
          hullLength: 0,
          bones: null,
          vertices: new Float32Array(0),
          worldVerticesLength: 0,
          color: parseColor(json.color ?? 'ffffffff'),
          width: json.width ?? 0,
          height: json.height ?? 0,
          sequence: parseSequence(json.sequence),
          timelineAttachment: null as unknown as Attachment,
        };
        mesh.timelineAttachment = mesh;
        if (type === 'linkedmesh') {
          this.linkedMeshes.push({
            mesh,
            skinName: json.skin ?? null,
            slotIndex,
            parentName: json.parent,
            inheritTimelines: (json.timelines ?? json.deform ?? true) !== false,
          });
          return mesh;
        }
        const uvs = (json.uvs ?? []) as number[];
        Object.assign(mesh, readVertices(json.vertices ?? [], uvs.length));
        mesh.regionUVs = new Float32Array(uvs);
        mesh.triangles = new Uint16Array(json.triangles ?? []);
        mesh.hullLength = (json.hull ?? 0) * 2;
        return mesh;
      }
      case 'clipping':
        return {
          type: 'clipping',
          name,
          endSlotIndex: json.end !== undefined ? this.data.slotIndex.get(json.end) ?? -1 : -1,
          ...readVertices(json.vertices ?? [], (json.vertexCount ?? 0) * 2),
        };
      case 'path':
        return {
          type: 'path',
          name,
          closed: json.closed ?? false,
          constantSpeed: json.constantSpeed ?? true,
          lengths: new Float32Array(json.lengths ?? []),
          ...readVertices(json.vertices ?? [], (json.vertexCount ?? 0) * 2),
        };
      case 'point':
        return { type: 'point', name, x: json.x ?? 0, y: json.y ?? 0, rotation: json.rotation ?? 0 };
      case 'boundingbox':
        return { type: 'boundingbox', name, ...readVertices(json.vertices ?? [], (json.vertexCount ?? 0) * 2) };
      default:
        this.data.unsupported.push({ feature: `attachment type "${type}"`, detail: `"${name}"` });
        return null;
    }
  }

  private resolveLinkedMeshes(): void {
    for (const linked of this.linkedMeshes) {
      const skin = linked.skinName ? this.data.skins.find((s) => s.name === linked.skinName) : this.data.defaultSkin;
      const parent = skin?.attachments.get(linked.slotIndex)?.get(linked.parentName);
      if (!parent || parent.type !== 'mesh') {
        throw new Error(`Linked mesh "${linked.mesh.name}": parent mesh "${linked.parentName}" not found`);
      }
      const mesh = linked.mesh;
      mesh.bones = parent.bones;
      mesh.vertices = parent.vertices;
      mesh.worldVerticesLength = parent.worldVerticesLength;
      mesh.regionUVs = parent.regionUVs;
      mesh.triangles = parent.triangles;
      mesh.hullLength = parent.hullLength;
      mesh.timelineAttachment = linked.inheritTimelines ? parent.timelineAttachment : mesh;
    }
  }

  // ---- animations ----------------------------------------------------------

  private parseAnimation(name: string, json: Json): AnimationData {
    const timelines: Timeline[] = [];

    for (const [slotName, slotMap] of Object.entries((json.slots ?? {}) as Record<string, Json>)) {
      const slot = this.slotIndexOf(slotName);
      for (const [key, frames] of Object.entries(slotMap) as [string, Json[]][]) {
        if (!frames.length) continue;
        switch (key) {
          case 'attachment':
            timelines.push({
              kind: 'attachment',
              target: slot,
              times: Float32Array.from(frames, (f) => f.time ?? 0),
              names: frames.map((f) => f.name ?? null),
            });
            break;
          case 'rgba':
            timelines.push(readCurveTimeline('rgba', slot, frames, (f) => colorChannels(f.color, 4)));
            break;
          case 'rgb':
            timelines.push(readCurveTimeline('rgb', slot, frames, (f) => colorChannels(f.color, 3)));
            break;
          case 'alpha':
            timelines.push(readCurveTimeline('alpha', slot, frames, (f) => [f.value ?? 1]));
            break;
          case 'rgba2':
            timelines.push(readCurveTimeline('rgba2', slot, frames, (f) => [...colorChannels(f.light, 4), ...colorChannels(f.dark, 3)]));
            break;
          case 'rgb2':
            timelines.push(readCurveTimeline('rgb2', slot, frames, (f) => [...colorChannels(f.light, 3), ...colorChannels(f.dark, 3)]));
            break;
          default:
            this.data.unsupported.push({ feature: `slot timeline "${key}"`, detail: `animation "${name}", slot "${slotName}"` });
        }
      }
    }

    for (const [boneName, boneMap] of Object.entries((json.bones ?? {}) as Record<string, Json>)) {
      const bone = this.boneIndexOf(boneName);
      for (const [key, frames] of Object.entries(boneMap) as [string, Json[]][]) {
        if (!frames.length) continue;
        if (key === 'inherit') {
          timelines.push({
            kind: 'inherit',
            target: bone,
            times: Float32Array.from(frames, (f) => f.time ?? 0),
            inherits: frames.map((f) => INHERIT_MODES[f.inherit ?? 'normal'] ?? Inherit.Normal),
          });
          continue;
        }
        const spec = BONE_TIMELINES[key];
        if (!spec) {
          this.data.unsupported.push({ feature: `bone timeline "${key}"`, detail: `animation "${name}", bone "${boneName}"` });
          continue;
        }
        timelines.push(readCurveTimeline(spec.kind, bone, frames, (f) => spec.keys.map((k) => f[k] ?? spec.defaultValue)));
      }
    }

    for (const [constraintName, frames] of Object.entries((json.ik ?? {}) as Record<string, Json[]>)) {
      if (!frames.length) continue;
      const index = this.data.ikConstraints.findIndex((c) => c.name === constraintName);
      if (index < 0) throw new Error(`IK constraint timeline for unknown constraint "${constraintName}"`);
      const timeline = readCurveTimeline('ik', index, frames, (f) => [f.mix ?? 1, f.softness ?? 0]);
      timeline.flags = Uint8Array.from(frames, (f) =>
        ((f.bendPositive ?? true) ? IK_FLAG_BEND_POSITIVE : 0) | (f.compress ? IK_FLAG_COMPRESS : 0) | (f.stretch ? IK_FLAG_STRETCH : 0)
      );
      timelines.push(timeline);
    }

    for (const [constraintName, frames] of Object.entries((json.transform ?? {}) as Record<string, Json[]>)) {
      if (!frames.length) continue;
      const index = this.data.transformConstraints.findIndex((c) => c.name === constraintName);
      if (index < 0) throw new Error(`Transform constraint timeline for unknown constraint "${constraintName}"`);
      timelines.push(
        readCurveTimeline('transformMix', index, frames, (f) => {
          const x = f.mixX ?? 1;
          const sx = f.mixScaleX ?? 1;
          return [f.mixRotate ?? 1, x, f.mixY ?? x, sx, f.mixScaleY ?? sx, f.mixShearY ?? 1];
        })
      );
    }

    // Constraint name "" = all physics constraints (value timelines: those with the matching *Global flag).
    for (const [constraintName, map] of Object.entries((json.physics ?? {}) as Record<string, Record<string, Json[]>>)) {
      let index = -1;
      if (constraintName.length) {
        index = this.data.physicsConstraints.findIndex((c) => c.name === constraintName);
        if (index < 0) throw new Error(`Physics constraint timeline for unknown constraint "${constraintName}"`);
      }
      for (const [key, frames] of Object.entries(map)) {
        if (!frames.length) continue;
        if (key === 'reset') {
          timelines.push({ kind: 'physicsReset', target: index, times: Float32Array.from(frames, (f) => f.time ?? 0) });
          continue;
        }
        const kind = PHYSICS_TIMELINES[key];
        if (!kind) {
          this.data.unsupported.push({ feature: `physics timeline "${key}"`, detail: `animation "${name}", constraint "${constraintName}"` });
          continue;
        }
        timelines.push(readCurveTimeline(kind, index, frames, (f) => [f.value ?? 0]));
      }
    }

    for (const [constraintName, map] of Object.entries((json.path ?? {}) as Record<string, Json>)) {
      const index = this.data.pathConstraints.findIndex((c) => c.name === constraintName);
      if (index < 0) throw new Error(`Path constraint timeline for unknown constraint "${constraintName}"`);
      for (const [key, frames] of Object.entries(map) as [string, Json[]][]) {
        if (!frames.length) continue;
        if (key === 'position') timelines.push(readCurveTimeline('pathPosition', index, frames, (f) => [f.value ?? 0]));
        else if (key === 'spacing') timelines.push(readCurveTimeline('pathSpacing', index, frames, (f) => [f.value ?? 0]));
        else if (key === 'mix') {
          timelines.push(
            readCurveTimeline('pathMix', index, frames, (f) => {
              const x = f.mixX ?? 1;
              return [f.mixRotate ?? 1, x, f.mixY ?? x];
            })
          );
        }
      }
    }

    // 4.1: "attachments" -> skin -> slot -> attachment -> { deform, sequence }. 4.0: "deform" -> ... -> frames.
    const attachmentTimelines = (json.attachments ?? {}) as Record<string, Record<string, Record<string, Json>>>;
    const legacyDeform = (json.deform ?? {}) as Record<string, Record<string, Record<string, Json[]>>>;
    for (const [skinName, slots] of Object.entries(legacyDeform)) {
      for (const [slotName, atts] of Object.entries(slots)) {
        for (const [attName, frames] of Object.entries(atts)) {
          ((attachmentTimelines[skinName] ??= {})[slotName] ??= {})[attName] = { deform: frames };
        }
      }
    }
    for (const [skinName, slots] of Object.entries(attachmentTimelines)) {
      const skin = this.data.skins.find((s) => s.name === skinName);
      if (!skin) throw new Error(`Animation "${name}": unknown skin "${skinName}"`);
      for (const [slotName, atts] of Object.entries(slots)) {
        const slot = this.slotIndexOf(slotName);
        for (const [attName, map] of Object.entries(atts)) {
          const attachment = skin.attachments.get(slot)?.get(attName);
          if (!attachment) throw new Error(`Animation "${name}": attachment "${attName}" not found in skin "${skinName}"`);
          if (map.deform?.length) timelines.push(this.readDeformTimeline(slot, attachment, map.deform));
          if (map.sequence?.length) {
            if (attachment.type !== 'region' && attachment.type !== 'mesh') throw new Error(`Sequence timeline on "${attName}" requires region/mesh`);
            const frames = map.sequence as Json[];
            timelines.push({
              kind: 'sequence',
              target: slot,
              attachment,
              times: Float32Array.from(frames, (f) => f.time ?? 0),
              modes: frames.map((f) => SEQUENCE_MODES[f.mode ?? 'hold'] ?? SequenceMode.Hold),
              indices: frames.map((f) => f.index ?? 0),
              delays: frames.map((f) => f.delay ?? 0),
            });
          }
        }
      }
    }

    if (json.drawOrder?.length) timelines.push(this.readDrawOrderTimeline(json.drawOrder as Json[]));

    if (json.events?.length) {
      const frames = json.events as Json[];
      const events: EventKey[] = frames.map((f) => {
        const def = this.data.events.find((e) => e.name === f.name) as EventData | undefined;
        if (!def) throw new Error(`Animation "${name}": unknown event "${f.name}"`);
        return {
          time: f.time ?? 0,
          name: def.name,
          intValue: f.int ?? def.intValue,
          floatValue: f.float ?? def.floatValue,
          stringValue: f.string ?? def.stringValue,
          volume: f.volume ?? def.volume,
          balance: f.balance ?? def.balance,
        };
      });
      timelines.push({ kind: 'event', times: Float32Array.from(events, (e) => e.time), events });
    }

    let duration = 0;
    for (const t of timelines) {
      if (t.times.length) duration = Math.max(duration, t.times[t.times.length - 1]!);
    }
    return { name, duration, timelines };
  }

  private readDeformTimeline(slot: number, attachment: Attachment, frames: Json[]): Timeline {
    if (attachment.type === 'region' || attachment.type === 'point') {
      throw new Error(`Deform timeline on non-vertex attachment "${attachment.name}"`);
    }
    const vertexAttachment: VertexAttachment = attachment;
    const weighted = vertexAttachment.bones !== null;
    const setup = vertexAttachment.vertices;
    const deformLength = weighted ? (setup.length / 3) * 2 : setup.length;
    const out: Float32Array[] = frames.map((f) => {
      const values = f.vertices as number[] | undefined;
      if (!values) return weighted ? new Float32Array(deformLength) : Float32Array.from(setup);
      const deform = new Float32Array(deformLength);
      deform.set(values, f.offset ?? 0);
      if (!weighted) for (let i = 0; i < deformLength; i++) deform[i]! += setup[i]!;
      return deform;
    });
    return {
      kind: 'deform',
      target: slot,
      attachment: vertexAttachment,
      times: Float32Array.from(frames, (f) => f.time ?? 0),
      frames: out,
      curves: frames.map((f) => readCurve(f.curve)),
    };
  }

  private readDrawOrderTimeline(frames: Json[]): DrawOrderTimeline {
    const slotCount = this.data.slots.length;
    const orders = frames.map((f) => {
      const offsets = f.offsets as { slot: string; offset: number }[] | undefined;
      if (!offsets) return null;
      // Spine's algorithm: place offset slots, then fill the gaps with the unchanged ones in order.
      const drawOrder = new Int32Array(slotCount).fill(-1);
      const unchanged = new Int32Array(slotCount - offsets.length);
      let originalIndex = 0;
      let unchangedIndex = 0;
      for (const { slot, offset } of offsets) {
        const slotIndex = this.slotIndexOf(slot);
        while (originalIndex !== slotIndex) unchanged[unchangedIndex++] = originalIndex++;
        drawOrder[originalIndex + offset] = originalIndex++;
      }
      while (originalIndex < slotCount) unchanged[unchangedIndex++] = originalIndex++;
      for (let i = slotCount - 1; i >= 0; i--) if (drawOrder[i] === -1) drawOrder[i] = unchanged[--unchangedIndex]!;
      return drawOrder;
    });
    return { kind: 'drawOrder', times: Float32Array.from(frames, (f) => f.time ?? 0), orders };
  }

  // ---- lookups -------------------------------------------------------------

  private boneIndexOf(name: string): number {
    const index = this.data.boneIndex.get(name);
    if (index === undefined) throw new Error(`Unknown bone "${name}"`);
    return index;
  }

  private slotIndexOf(name: string): number {
    const index = this.data.slotIndex.get(name);
    if (index === undefined) throw new Error(`Unknown slot "${name}"`);
    return index;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function readCurveTimeline(kind: CurveTimelineKind, target: number, frames: Json[], read: (frame: Json) => number[]): CurveTimeline {
  const channels = read(frames[0]!).length;
  const values = new Float32Array(frames.length * channels);
  frames.forEach((f, i) => values.set(read(f), i * channels));
  return {
    kind,
    target,
    channels,
    times: Float32Array.from(frames, (f) => f.time ?? 0),
    values,
    curves: frames.map((f) => readCurve(f.curve)),
  };
}

function readCurve(curve: unknown): CurveData {
  if (curve === 'stepped') return 'stepped';
  if (Array.isArray(curve)) return curve as number[];
  return null;
}

/** Split weighted/unweighted vertex data. `unweightedLength` = expected float count when unweighted. */
function readVertices(vertices: number[], unweightedLength: number): VertexData {
  if (vertices.length === unweightedLength) {
    return { bones: null, vertices: new Float32Array(vertices), worldVerticesLength: unweightedLength };
  }
  const bones: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < vertices.length; ) {
    const boneCount = vertices[i++]!;
    bones.push(boneCount);
    for (let n = i + boneCount * 4; i < n; i += 4) {
      bones.push(vertices[i]!);
      weights.push(vertices[i + 1]!, vertices[i + 2]!, vertices[i + 3]!);
    }
  }
  return { bones: new Int32Array(bones), vertices: new Float32Array(weights), worldVerticesLength: unweightedLength };
}

function parseSequence(json: Json | undefined): SequenceData | null {
  if (!json) return null;
  return {
    count: json.count,
    start: json.start ?? DEFAULT_SEQUENCE_START,
    digits: json.digits ?? 0,
    setupIndex: json.setup ?? 0,
  };
}

function colorChannels(hex: string | undefined, count: 3 | 4): number[] {
  const c = parseColor(hex ?? 'ffffffff');
  return count === 4 ? [c.r, c.g, c.b, c.a] : [c.r, c.g, c.b];
}

/** Parse "RRGGBBAA" or "RRGGBB". */
export function parseColor(hex: string): Color {
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
    a: hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

function parseDarkColor(hex: string): DarkColor {
  const { r, g, b } = parseColor(hex);
  return { r, g, b };
}
