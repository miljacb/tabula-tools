/**
 * Compiled skeleton format (`.tabula`): the {@link SkeletonData} model in a
 * compact little-endian binary, written by the CLI (`tabula compile`), so
 * the browser never parses Spine JSON. Optionally embeds the atlas
 * (pages + the regions the skeleton uses).
 *
 * Layout:
 * - Header: magic `SLSK`, format version (u16), IR version (u16), flags (u32),
 *   then name, hash and source Spine version as strings. {@link readSlbHeader}
 *   reads only this part.
 * - String table: every other string once; the body refers to strings by index.
 * - Body (4-byte aligned): bones, slots, path constraints, (format 2+: IK,
 *   transform and physics constraints, reference scale), events, an
 *   attachment table (shared by skins and timelines), skins, animations,
 *   unsupported features, optional atlas.
 *
 * Typed arrays (vertices, UVs, triangles, key times and values, bezier
 * control points) are stored aligned and loaded as views into the file
 * buffer, so keep the buffer alive as long as the data is used. Setup-pose
 * scalars are stored as float32; animation data is float32 in the model
 * already.
 */

import { ByteReader } from './binary-io.js';
import { IR_VERSION } from './types.js';
import type {
  AnimationData, AtlasData, AtlasPage, AtlasRegion, Attachment, BoneData, Color, CurveData, CurveTimeline, DarkColor,
  EventData, EventKey, IkConstraintData, MeshAttachment, PathConstraintData, PhysicsConstraintData, TransformConstraintData, SequenceData, SkeletonData, SkinData, SlotData, Timeline, VertexData,
} from './types.js';

/** Magic number: 'SLSK' as little-endian bytes. */
export const SLB_MAGIC = 0x4b534c53;
/** Version of the byte layout written by the compiler (2 adds IK, transform and physics constraints; 3 adds skin-required bones/constraints and skin bone/constraint lists). */
export const SLB_FORMAT_VERSION = 3;
/** Oldest format version this runtime still reads. */
export const SLB_MIN_FORMAT_VERSION = 1;
/** Header flag: an atlas section follows the body. */
export const SLB_FLAG_ATLAS = 1;

/** Attachment type codes. */
export const SLB_ATTACHMENT_TYPES = ['region', 'mesh', 'clipping', 'path', 'point', 'boundingbox'] as const;

/** Timeline kind codes (index = code). */
export const SLB_TIMELINE_KINDS = [
  'rotate', 'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'shear', 'shearx', 'sheary',
  'rgba', 'rgb', 'alpha', 'rgba2', 'rgb2', 'pathPosition', 'pathSpacing', 'pathMix',
  'inherit', 'attachment', 'deform', 'sequence', 'drawOrder', 'event',
  // Format 2:
  'ik', 'transformMix', 'physicsInertia', 'physicsStrength', 'physicsDamping', 'physicsMass', 'physicsWind', 'physicsGravity', 'physicsMix',
  'physicsReset',
] as const satisfies readonly Timeline['kind'][];

/** Curve timeline kinds whose target may be -1 (all constraints); stored as a signed varint. */
export function slbSignedTarget(kind: string): boolean {
  return kind.startsWith('physics');
}

/** Curve type codes per key frame. */
export const SLB_CURVE_LINEAR = 0;
/** Curve type code: stepped. */
export const SLB_CURVE_STEPPED = 1;
/** Curve type code: bezier (control points follow). */
export const SLB_CURVE_BEZIER = 2;

/** Header of a compiled skeleton. */
export interface SlbHeader {
  formatVersion: number;
  irVersion: number;
  flags: number;
  name: string;
  hash: string;
  /** Spine version of the export the file was compiled from, e.g. "4.1-from-4.2.43". */
  sourceSpineVersion: string;
}

/** Result of {@link loadSkeletonBinary}. */
export interface SkeletonBinary {
  header: SlbHeader;
  data: SkeletonData;
  /** Embedded atlas, or null if the file was compiled without one. */
  atlas: AtlasData | null;
}

/** Read and check only the header. Throws on a bad magic number or an unsupported version. */
export function readSlbHeader(bytes: ArrayBuffer | Uint8Array): SlbHeader {
  return readHeader(new ByteReader(bytes));
}

function readHeader(r: ByteReader): SlbHeader {
  if (r.length < 12 || r.u32() !== SLB_MAGIC) throw new Error('Not a Tabula compiled skeleton (bad magic)');
  const formatVersion = r.u16();
  const irVersion = r.u16();
  if (formatVersion < SLB_MIN_FORMAT_VERSION || formatVersion > SLB_FORMAT_VERSION) {
    throw new Error(`Unsupported .tabula format version ${formatVersion} (this runtime reads ${SLB_MIN_FORMAT_VERSION}-${SLB_FORMAT_VERSION}); recompile the skeleton`);
  }
  if (irVersion !== IR_VERSION) {
    throw new Error(`.tabula compiled for IR version ${irVersion}, this runtime uses ${IR_VERSION}; recompile the skeleton`);
  }
  const flags = r.u32();
  return { formatVersion, irVersion, flags, name: r.str(), hash: r.str(), sourceSpineVersion: r.str() };
}

/**
 * Load a compiled skeleton. Allocates the model objects; typed arrays are
 * views into `bytes` (copied once only if `bytes` is not 4-byte aligned).
 *
 * @example
 * ```ts
 * const { data, atlas } = loadSkeletonBinary(await (await fetch('/assets/symbol1.tabula')).arrayBuffer());
 * ```
 */
export function loadSkeletonBinary(bytes: ArrayBuffer | Uint8Array): SkeletonBinary {
  const r = new ByteReader(bytes);
  const header = readHeader(r);
  return new SlbLoader(r).load(header);
}

class SlbLoader {
  private strings: string[] = [];
  private attachments: Attachment[] = [];

  constructor(private readonly r: ByteReader) {}

  load(header: SlbHeader): SkeletonBinary {
    const r = this.r;
    const stringCount = r.varuint();
    const strings = new Array<string>(stringCount);
    for (let i = 0; i < stringCount; i++) strings[i] = r.str();
    this.strings = strings;
    r.pos = Math.ceil(r.pos / 4) * 4;

    const data: SkeletonData = {
      name: header.name,
      hash: header.hash,
      spineVersion: header.sourceSpineVersion,
      x: r.f32(),
      y: r.f32(),
      width: r.f32(),
      height: r.f32(),
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
      referenceScale: 100,
      unsupported: [],
      boneIndex: new Map(),
      slotIndex: new Map(),
    };
    for (let i = 0, n = r.varuint(); i < n; i++) {
      const bone = this.bone(i);
      data.bones.push(bone);
      data.boneIndex.set(bone.name, i);
    }
    for (let i = 0, n = r.varuint(); i < n; i++) {
      const slot = this.slot(i);
      data.slots.push(slot);
      data.slotIndex.set(slot.name, i);
    }
    for (let n = r.varuint(); n > 0; n--) data.pathConstraints.push(this.pathConstraint());
    if (header.formatVersion >= 2) {
      for (let n = r.varuint(); n > 0; n--) data.ikConstraints.push(this.ikConstraint());
      for (let n = r.varuint(); n > 0; n--) data.transformConstraints.push(this.transformConstraint());
      for (let n = r.varuint(); n > 0; n--) data.physicsConstraints.push(this.physicsConstraint());
      data.referenceScale = r.f32();
    }
    for (let n = r.varuint(); n > 0; n--) data.events.push(this.event());
    this.attachmentTable();
    for (let n = r.varuint(); n > 0; n--) data.skins.push(this.skin());
    const defaultSkin = r.varuint();
    data.defaultSkin = defaultSkin > 0 ? data.skins[defaultSkin - 1]! : null;
    if (header.formatVersion >= 3) {
      const list = (): number[] => {
        const out: number[] = [];
        for (let n = r.varuint(); n > 0; n--) out.push(r.varuint());
        return out;
      };
      for (const i of list()) data.bones[i]!.skinRequired = true;
      for (const i of list()) data.pathConstraints[i]!.skinRequired = true;
      for (const skin of data.skins) {
        const bones = list();
        const constraints: string[] = [];
        for (let n = r.varuint(); n > 0; n--) constraints.push(this.string());
        if (bones.length) skin.bones = bones;
        if (constraints.length) skin.constraints = constraints;
      }
    }
    for (let n = r.varuint(); n > 0; n--) data.animations.push(this.animation());
    for (let n = r.varuint(); n > 0; n--) data.unsupported.push({ feature: this.string(), detail: this.string() });
    const atlas = header.flags & SLB_FLAG_ATLAS ? this.atlas() : null;
    return { header, data, atlas };
  }

  private string(): string {
    return this.strings[this.r.varuint()]!;
  }

  private nullableString(): string | null {
    const i = this.r.varuint();
    return i > 0 ? this.strings[i - 1]! : null;
  }

  private color(): Color {
    const r = this.r;
    return { r: r.u8() / 255, g: r.u8() / 255, b: r.u8() / 255, a: r.u8() / 255 };
  }

  private bone(index: number): BoneData {
    const r = this.r;
    return {
      index,
      name: this.string(),
      parentIndex: r.varuint() - 1,
      length: r.f32(),
      x: r.f32(),
      y: r.f32(),
      rotation: r.f32(),
      scaleX: r.f32(),
      scaleY: r.f32(),
      shearX: r.f32(),
      shearY: r.f32(),
      inherit: r.u8(),
      skinRequired: false,
    };
  }

  private slot(index: number): SlotData {
    const r = this.r;
    const name = this.string();
    const boneIndex = r.varuint();
    const color = this.color();
    let darkColor: DarkColor | null = null;
    if (r.u8()) darkColor = { r: r.u8() / 255, g: r.u8() / 255, b: r.u8() / 255 };
    return { index, name, boneIndex, color, darkColor, attachmentName: this.nullableString(), blendMode: r.u8() };
  }

  private pathConstraint(): PathConstraintData {
    const r = this.r;
    const name = this.string();
    const order = r.varuint();
    const bones: number[] = [];
    for (let n = r.varuint(); n > 0; n--) bones.push(r.varuint());
    return {
      name,
      order,
      skinRequired: false,
      bones,
      targetSlotIndex: r.varuint(),
      positionMode: r.u8(),
      spacingMode: r.u8(),
      rotateMode: r.u8(),
      offsetRotation: r.f32(),
      position: r.f32(),
      spacing: r.f32(),
      mixRotate: r.f32(),
      mixX: r.f32(),
      mixY: r.f32(),
    };
  }

  private event(): EventData {
    const r = this.r;
    return {
      name: this.string(),
      intValue: r.varint(),
      floatValue: r.f32(),
      stringValue: this.string(),
      audioPath: this.nullableString(),
      volume: r.f32(),
      balance: r.f32(),
    };
  }

  private sequence(): SequenceData | null {
    const r = this.r;
    if (!r.u8()) return null;
    return { count: r.varuint(), start: r.varuint(), digits: r.varuint(), setupIndex: r.varint() };
  }

  private vertexData(): VertexData {
    const r = this.r;
    const bones = r.u8() ? r.i32array() : null;
    return { bones, vertices: r.f32array(), worldVerticesLength: r.varuint() };
  }

  private attachmentTable(): void {
    const r = this.r;
    const count = r.varuint();
    const table = new Array<Attachment>(count);
    const timelineRefs: [MeshAttachment, number][] = [];
    for (let i = 0; i < count; i++) {
      const type = SLB_ATTACHMENT_TYPES[r.u8()];
      const name = this.string();
      switch (type) {
        case 'region':
          table[i] = {
            type, name, path: this.string(),
            x: r.f32(), y: r.f32(), scaleX: r.f32(), scaleY: r.f32(), rotation: r.f32(), width: r.f32(), height: r.f32(),
            color: this.color(), sequence: this.sequence(),
          };
          break;
        case 'mesh': {
          const path = this.string();
          const color = this.color();
          const width = r.f32();
          const height = r.f32();
          const sequence = this.sequence();
          const owner = r.varuint();
          let geometry: Pick<MeshAttachment, 'bones' | 'vertices' | 'worldVerticesLength' | 'regionUVs' | 'triangles' | 'hullLength'>;
          if (owner === 0) {
            const vd = this.vertexData();
            geometry = { ...vd, regionUVs: r.f32array(), triangles: r.u16array(), hullLength: r.varuint() };
          } else {
            const o = table[owner - 1] as MeshAttachment;
            geometry = { bones: o.bones, vertices: o.vertices, worldVerticesLength: o.worldVerticesLength, regionUVs: o.regionUVs, triangles: o.triangles, hullLength: o.hullLength };
          }
          const mesh: MeshAttachment = { type, name, path, color, width, height, sequence, ...geometry, timelineAttachment: null as unknown as Attachment };
          timelineRefs.push([mesh, r.varuint()]);
          table[i] = mesh;
          break;
        }
        case 'clipping': {
          const vd = this.vertexData();
          table[i] = { type, name, ...vd, endSlotIndex: r.varuint() - 1 };
          break;
        }
        case 'path': {
          const vd = this.vertexData();
          table[i] = { type, name, ...vd, closed: r.u8() === 1, constantSpeed: r.u8() === 1, lengths: r.f32array() };
          break;
        }
        case 'point':
          table[i] = { type, name, x: r.f32(), y: r.f32(), rotation: r.f32() };
          break;
        case 'boundingbox':
          table[i] = { type, name, ...this.vertexData() };
          break;
        default:
          throw new Error(`Corrupt .tabula: unknown attachment type at entry ${i}`);
      }
    }
    for (const [mesh, ref] of timelineRefs) mesh.timelineAttachment = table[ref]!;
    this.attachments = table;
  }

  private skin(): SkinData {
    const r = this.r;
    const skin: SkinData = { name: this.string(), attachments: new Map() };
    for (let n = r.varuint(); n > 0; n--) {
      const slotIndex = r.varuint();
      const map = new Map<string, Attachment>();
      for (let k = r.varuint(); k > 0; k--) {
        const key = this.string();
        map.set(key, this.attachments[r.varuint()]!);
      }
      skin.attachments.set(slotIndex, map);
    }
    return skin;
  }

  private curves(count: number): CurveData[] {
    const r = this.r;
    const types = r.raw(count);
    const perFrame = r.varuint();
    const points = r.f32array();
    const curves = new Array<CurveData>(count);
    for (let i = 0, p = 0; i < count; i++) {
      const type = types[i];
      if (type === SLB_CURVE_BEZIER) {
        curves[i] = points.subarray(p, p + perFrame);
        p += perFrame;
      } else {
        curves[i] = type === SLB_CURVE_STEPPED ? 'stepped' : null;
      }
    }
    return curves;
  }

  private boneList(): number[] {
    const bones: number[] = [];
    for (let n = this.r.varuint(); n > 0; n--) bones.push(this.r.varuint());
    return bones;
  }

  private ikConstraint(): IkConstraintData {
    const r = this.r;
    const name = this.string();
    const order = r.varuint();
    const flags = r.u8();
    const bones = this.boneList();
    const target = r.varuint();
    return {
      name, order, bones, target,
      skinRequired: (flags & 1) !== 0,
      bendDirection: flags & 2 ? 1 : -1,
      compress: (flags & 4) !== 0,
      stretch: (flags & 8) !== 0,
      uniform: (flags & 16) !== 0,
      mix: r.f32(),
      softness: r.f32(),
    };
  }

  private transformConstraint(): TransformConstraintData {
    const r = this.r;
    const name = this.string();
    const order = r.varuint();
    const flags = r.u8();
    const bones = this.boneList();
    const target = r.varuint();
    const f = (): number => r.f32();
    return {
      name, order, bones, target,
      skinRequired: (flags & 1) !== 0,
      local: (flags & 2) !== 0,
      relative: (flags & 4) !== 0,
      offsetRotation: f(), offsetX: f(), offsetY: f(), offsetScaleX: f(), offsetScaleY: f(), offsetShearY: f(),
      mixRotate: f(), mixX: f(), mixY: f(), mixScaleX: f(), mixScaleY: f(), mixShearY: f(),
    };
  }

  private physicsConstraint(): PhysicsConstraintData {
    const r = this.r;
    const name = this.string();
    const order = r.varuint();
    const flags = r.varuint();
    const bone = r.varuint();
    const f = (): number => r.f32();
    const bit = (i: number): boolean => (flags & (1 << i)) !== 0;
    return {
      name, order, bone,
      skinRequired: bit(0),
      inertiaGlobal: bit(1), strengthGlobal: bit(2), dampingGlobal: bit(3), massGlobal: bit(4), windGlobal: bit(5), gravityGlobal: bit(6), mixGlobal: bit(7),
      x: f(), y: f(), rotate: f(), scaleX: f(), shearX: f(), limit: f(), step: 1 / f(),
      inertia: f(), strength: f(), damping: f(), massInverse: 1 / f(), wind: f(), gravity: f(), mix: f(),
    };
  }

  private animation(): AnimationData {
    const r = this.r;
    const name = this.string();
    const duration = r.f32();
    const timelines: Timeline[] = [];
    for (let n = r.varuint(); n > 0; n--) timelines.push(this.timeline());
    return { name, duration, timelines };
  }

  private timeline(): Timeline {
    const r = this.r;
    const kind = SLB_TIMELINE_KINDS[r.u8()];
    switch (kind) {
      case 'inherit': {
        const target = r.varuint();
        const times = r.f32array();
        return { kind, target, times, inherits: Array.from(r.raw(times.length)) };
      }
      case 'attachment': {
        const target = r.varuint();
        const times = r.f32array();
        const names = new Array<string | null>(times.length);
        for (let i = 0; i < times.length; i++) names[i] = this.nullableString();
        return { kind, target, times, names };
      }
      case 'deform': {
        const target = r.varuint();
        const attachment = this.attachments[r.varuint()] as Extract<Timeline, { kind: 'deform' }>['attachment'];
        const times = r.f32array();
        const frames = new Array<Float32Array>(times.length);
        for (let i = 0; i < times.length; i++) frames[i] = r.f32array();
        return { kind, target, attachment, times, frames, curves: this.curves(times.length) };
      }
      case 'sequence': {
        const target = r.varuint();
        const attachment = this.attachments[r.varuint()] as Extract<Timeline, { kind: 'sequence' }>['attachment'];
        const times = r.f32array();
        const n = times.length;
        const modes = Array.from(r.raw(n));
        const indices = new Array<number>(n);
        for (let i = 0; i < n; i++) indices[i] = r.varint();
        return { kind, target, attachment, times, modes, indices, delays: Array.from(r.f32array()) };
      }
      case 'drawOrder': {
        const times = r.f32array();
        const orders = new Array<Int32Array | null>(times.length);
        for (let i = 0; i < times.length; i++) orders[i] = r.u8() ? r.i32array() : null;
        return { kind, times, orders };
      }
      case 'event': {
        const times = r.f32array();
        const events = new Array<EventKey>(times.length);
        for (let i = 0; i < times.length; i++) {
          events[i] = {
            time: times[i]!, name: this.string(), intValue: r.varint(), floatValue: r.f32(), stringValue: this.string(), volume: r.f32(), balance: r.f32(),
          };
        }
        return { kind, times, events };
      }
      case 'physicsReset': {
        const target = r.varint();
        return { kind, target, times: r.f32array() };
      }
      case undefined:
        throw new Error('Corrupt .tabula: unknown timeline kind');
      default: {
        const target = slbSignedTarget(kind) ? r.varint() : r.varuint();
        const channels = r.u8();
        const times = r.f32array();
        const values = r.f32array();
        const timeline: CurveTimeline = { kind, target, channels, times, values, curves: this.curves(times.length) };
        if (kind === 'ik') timeline.flags = r.raw(times.length).slice();
        return timeline;
      }
    }
  }

  private atlas(): AtlasData {
    const r = this.r;
    const pages: AtlasPage[] = [];
    for (let n = r.varuint(); n > 0; n--) {
      pages.push({
        name: this.string(), width: r.varuint(), height: r.varuint(), format: this.string(),
        minFilter: this.string(), magFilter: this.string(), uWrap: this.string(), vWrap: this.string(), pma: r.u8() === 1,
      });
    }
    const regions = new Map<string, AtlasRegion>();
    for (let n = r.varuint(); n > 0; n--) {
      const region: AtlasRegion = {
        name: this.string(), page: pages[r.varuint()]!, x: r.varuint(), y: r.varuint(), width: r.varuint(), height: r.varuint(),
        degrees: r.varuint(), offsetX: r.varint(), offsetY: r.varint(), originalWidth: r.varuint(), originalHeight: r.varuint(), index: r.varint(),
      };
      regions.set(region.name, region);
    }
    return { pages, regions };
  }
}
