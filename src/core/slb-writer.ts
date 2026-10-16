/**
 * Writer for the compiled skeleton format (`.tabula`); the layout and the reader
 * live in `core/slb.ts`. Used by `tabula compile`.
 */

import { ByteWriter } from './binary-io.js';
import {
  SLB_ATTACHMENT_TYPES, SLB_CURVE_BEZIER, SLB_CURVE_LINEAR, SLB_CURVE_STEPPED, SLB_FLAG_ATLAS, SLB_FORMAT_VERSION, SLB_MAGIC, SLB_TIMELINE_KINDS, slbSignedTarget,
} from './slb.js';
import { IR_VERSION } from './types.js';
import { regionPathsOf } from './regions.js';
import type {
  AtlasData, Attachment, Color, CurveData, MeshAttachment, SequenceData, SkeletonData, Timeline, VertexData,
} from './types.js';

/** Options for {@link writeSkeletonBinary}. */
export interface SlbWriteOptions {
  /** Atlas to embed (typically pruned to the skeleton's regions with {@link pruneAtlas}). */
  atlas?: AtlasData | null;
}

/** Serialize `data` (and optionally an atlas) to the `.tabula` format. */
export function writeSkeletonBinary(data: SkeletonData, options: SlbWriteOptions = {}): ArrayBuffer {
  const body = new SlbBodyWriter(data);
  const atlas = options.atlas ?? null;
  body.write(atlas);

  const out = new ByteWriter();
  out.u32(SLB_MAGIC);
  out.u16(SLB_FORMAT_VERSION);
  out.u16(IR_VERSION);
  out.u32(atlas ? SLB_FLAG_ATLAS : 0);
  out.str(data.name);
  out.str(data.hash);
  out.str(data.spineVersion);
  out.varuint(body.strings.length);
  for (const s of body.strings) out.str(s);
  while (out.length % 4 !== 0) out.u8(0); // body offsets are aligned relative to its start
  out.raw(new Uint8Array(body.finish()));
  return out.finish();
}

/** Copy of `atlas` with only the regions `paths` refers to, and only the pages those use. */
export function pruneAtlas(atlas: AtlasData, paths: Iterable<string>): AtlasData {
  const regions = new Map<string, AtlasData['regions'] extends Map<string, infer R> ? R : never>();
  for (const p of paths) {
    const region = atlas.regions.get(p);
    if (region) regions.set(p, region);
  }
  const used = new Set([...regions.values()].map((r) => r.page));
  return { pages: atlas.pages.filter((p) => used.has(p)), regions };
}

class SlbBodyWriter {
  readonly strings: string[] = [];
  private readonly stringIndex = new Map<string, number>();
  private readonly w = new ByteWriter();
  private readonly table: Attachment[] = [];
  private readonly tableIndex = new Map<Attachment, number>();

  constructor(private readonly data: SkeletonData) {}

  finish(): ArrayBuffer {
    return this.w.finish();
  }

  write(atlas: AtlasData | null): void {
    const { w, data } = this;
    w.f32(data.x);
    w.f32(data.y);
    w.f32(data.width);
    w.f32(data.height);

    w.varuint(data.bones.length);
    for (const b of data.bones) {
      this.string(b.name);
      w.varuint(b.parentIndex + 1);
      for (const v of [b.length, b.x, b.y, b.rotation, b.scaleX, b.scaleY, b.shearX, b.shearY]) w.f32(v);
      w.u8(b.inherit);
    }

    w.varuint(data.slots.length);
    for (const s of data.slots) {
      this.string(s.name);
      w.varuint(s.boneIndex);
      this.color(s.color);
      w.u8(s.darkColor ? 1 : 0);
      if (s.darkColor) for (const v of [s.darkColor.r, s.darkColor.g, s.darkColor.b]) w.u8(toByte(v));
      this.nullableString(s.attachmentName);
      w.u8(s.blendMode);
    }

    w.varuint(data.pathConstraints.length);
    for (const c of data.pathConstraints) {
      this.string(c.name);
      w.varuint(c.order);
      w.varuint(c.bones.length);
      for (const b of c.bones) w.varuint(b);
      w.varuint(c.targetSlotIndex);
      w.u8(c.positionMode);
      w.u8(c.spacingMode);
      w.u8(c.rotateMode);
      for (const v of [c.offsetRotation, c.position, c.spacing, c.mixRotate, c.mixX, c.mixY]) w.f32(v);
    }

    const boneList = (bones: number[]): void => {
      w.varuint(bones.length);
      for (const b of bones) w.varuint(b);
    };
    w.varuint(data.ikConstraints.length);
    for (const c of data.ikConstraints) {
      this.string(c.name);
      w.varuint(c.order);
      w.u8((c.skinRequired ? 1 : 0) | (c.bendDirection > 0 ? 2 : 0) | (c.compress ? 4 : 0) | (c.stretch ? 8 : 0) | (c.uniform ? 16 : 0));
      boneList(c.bones);
      w.varuint(c.target);
      w.f32(c.mix);
      w.f32(c.softness);
    }
    w.varuint(data.transformConstraints.length);
    for (const c of data.transformConstraints) {
      this.string(c.name);
      w.varuint(c.order);
      w.u8((c.skinRequired ? 1 : 0) | (c.local ? 2 : 0) | (c.relative ? 4 : 0));
      boneList(c.bones);
      w.varuint(c.target);
      for (const v of [c.offsetRotation, c.offsetX, c.offsetY, c.offsetScaleX, c.offsetScaleY, c.offsetShearY]) w.f32(v);
      for (const v of [c.mixRotate, c.mixX, c.mixY, c.mixScaleX, c.mixScaleY, c.mixShearY]) w.f32(v);
    }
    w.varuint(data.physicsConstraints.length);
    for (const c of data.physicsConstraints) {
      this.string(c.name);
      w.varuint(c.order);
      const bits = [c.skinRequired, c.inertiaGlobal, c.strengthGlobal, c.dampingGlobal, c.massGlobal, c.windGlobal, c.gravityGlobal, c.mixGlobal];
      w.varuint(bits.reduce((acc, b, i) => acc | ((b ? 1 : 0) << i), 0));
      w.varuint(c.bone);
      // fps and mass are stored (not step and 1/mass) so loading reproduces the JSON parser's values exactly.
      for (const v of [c.x, c.y, c.rotate, c.scaleX, c.shearX, c.limit, 1 / c.step]) w.f32(v);
      for (const v of [c.inertia, c.strength, c.damping, 1 / c.massInverse, c.wind, c.gravity, c.mix]) w.f32(v);
    }
    w.f32(data.referenceScale ?? 100);

    w.varuint(data.events.length);
    for (const e of data.events) {
      this.string(e.name);
      w.varint(e.intValue);
      w.f32(e.floatValue);
      this.string(e.stringValue);
      this.nullableString(e.audioPath);
      w.f32(e.volume);
      w.f32(e.balance);
    }

    this.attachmentTable();

    w.varuint(data.skins.length);
    for (const skin of data.skins) {
      this.string(skin.name);
      w.varuint(skin.attachments.size);
      for (const [slotIndex, map] of skin.attachments) {
        w.varuint(slotIndex);
        w.varuint(map.size);
        for (const [key, attachment] of map) {
          this.string(key);
          w.varuint(this.tableIndex.get(attachment)!);
        }
      }
    }
    w.varuint(data.defaultSkin ? data.skins.indexOf(data.defaultSkin) + 1 : 0);

    // Format 3: skin-required bones / path constraints and what each skin activates.
    const indicesWhere = <T>(list: readonly T[], pred: (item: T) => boolean): number[] => list.flatMap((item, i) => (pred(item) ? [i] : []));
    boneList(indicesWhere(data.bones, (b) => !!b.skinRequired));
    boneList(indicesWhere(data.pathConstraints, (c) => !!c.skinRequired));
    for (const skin of data.skins) {
      boneList(skin.bones ?? []);
      w.varuint(skin.constraints?.length ?? 0);
      for (const name of skin.constraints ?? []) this.string(name);
    }

    w.varuint(data.animations.length);
    for (const anim of data.animations) {
      this.string(anim.name);
      w.f32(anim.duration);
      w.varuint(anim.timelines.length);
      for (const tl of anim.timelines) this.timeline(tl);
    }

    w.varuint(data.unsupported.length);
    for (const u of data.unsupported) {
      this.string(u.feature);
      this.string(u.detail);
    }

    if (atlas) this.atlas(atlas);
  }

  private string(s: string): void {
    let i = this.stringIndex.get(s);
    if (i === undefined) {
      i = this.strings.length;
      this.strings.push(s);
      this.stringIndex.set(s, i);
    }
    this.w.varuint(i);
  }

  private nullableString(s: string | null): void {
    if (s === null) {
      this.w.varuint(0);
      return;
    }
    let i = this.stringIndex.get(s);
    if (i === undefined) {
      i = this.strings.length;
      this.strings.push(s);
      this.stringIndex.set(s, i);
    }
    this.w.varuint(i + 1);
  }

  private color(c: Color): void {
    for (const v of [c.r, c.g, c.b, c.a]) this.w.u8(toByte(v));
  }

  private sequence(s: SequenceData | null): void {
    const w = this.w;
    w.u8(s ? 1 : 0);
    if (!s) return;
    w.varuint(s.count);
    w.varuint(s.start);
    w.varuint(s.digits);
    w.varint(s.setupIndex);
  }

  private vertexData(v: VertexData): void {
    const w = this.w;
    w.u8(v.bones ? 1 : 0);
    if (v.bones) w.i32array(v.bones);
    w.f32array(v.vertices);
    w.varuint(v.worldVerticesLength);
  }

  /** Every attachment once: skins first, then any only referenced by timelines. */
  private attachmentTable(): void {
    const add = (a: Attachment): void => {
      if (this.tableIndex.has(a)) return;
      this.tableIndex.set(a, this.table.length);
      this.table.push(a);
    };
    for (const skin of this.data.skins) for (const map of skin.attachments.values()) for (const a of map.values()) add(a);
    for (const anim of this.data.animations) {
      for (const tl of anim.timelines) if (tl.kind === 'deform' || tl.kind === 'sequence') add(tl.attachment);
    }
    for (const a of this.table) if (a.type === 'mesh') add(a.timelineAttachment);

    const w = this.w;
    const geometryOwner = new Map<Float32Array, number>();
    w.varuint(this.table.length);
    this.table.forEach((a, index) => {
      w.u8(SLB_ATTACHMENT_TYPES.indexOf(a.type));
      this.string(a.name);
      switch (a.type) {
        case 'region':
          this.string(a.path);
          for (const v of [a.x, a.y, a.scaleX, a.scaleY, a.rotation, a.width, a.height]) w.f32(v);
          this.color(a.color);
          this.sequence(a.sequence);
          break;
        case 'mesh': {
          this.string(a.path);
          this.color(a.color);
          w.f32(a.width);
          w.f32(a.height);
          this.sequence(a.sequence);
          // Linked meshes share their parent's arrays: store them once.
          const owner = geometryOwner.get(a.regionUVs);
          if (owner !== undefined && sharesGeometry(this.table[owner] as MeshAttachment, a)) {
            w.varuint(owner + 1);
          } else {
            geometryOwner.set(a.regionUVs, index);
            w.varuint(0);
            this.vertexData(a);
            w.f32array(a.regionUVs);
            w.u16array(a.triangles);
            w.varuint(a.hullLength);
          }
          w.varuint(this.tableIndex.get(a.timelineAttachment)!);
          break;
        }
        case 'clipping':
          this.vertexData(a);
          w.varuint(a.endSlotIndex + 1);
          break;
        case 'path':
          this.vertexData(a);
          w.u8(a.closed ? 1 : 0);
          w.u8(a.constantSpeed ? 1 : 0);
          w.f32array(a.lengths);
          break;
        case 'point':
          w.f32(a.x);
          w.f32(a.y);
          w.f32(a.rotation);
          break;
        case 'boundingbox':
          this.vertexData(a);
          break;
      }
    });
  }

  /**
   * Curve types per frame, then bezier control points (4 per channel). Short
   * bezier arrays get the defaults `interpolate` uses (the segment's own
   * end points), so playback is unchanged.
   */
  private curves(curves: CurveData[], channels: number, times: ArrayLike<number>, segment: (frame: number, channel: number) => [number, number]): void {
    const w = this.w;
    const perFrame = channels * 4;
    const types = new Uint8Array(curves.length);
    const points: number[] = [];
    curves.forEach((c, i) => {
      if (c === null) {
        types[i] = SLB_CURVE_LINEAR;
      } else if (c === 'stepped') {
        types[i] = SLB_CURVE_STEPPED;
      } else {
        types[i] = SLB_CURVE_BEZIER;
        const t1 = times[i]!;
        const t2 = times[i + 1] ?? t1;
        for (let ch = 0; ch < channels; ch++) {
          const k = ch * 4;
          const [v1, v2] = segment(i, ch);
          points.push(c[k] ?? t1, c[k + 1] ?? v1, c[k + 2] ?? t2, c[k + 3] ?? v2);
        }
      }
    });
    w.raw(types);
    w.varuint(perFrame);
    w.f32array(points);
  }

  private timeline(tl: Timeline): void {
    const w = this.w;
    w.u8(SLB_TIMELINE_KINDS.indexOf(tl.kind));
    switch (tl.kind) {
      case 'inherit':
        w.varuint(tl.target);
        w.f32array(tl.times);
        w.raw(Uint8Array.from(tl.inherits));
        return;
      case 'attachment':
        w.varuint(tl.target);
        w.f32array(tl.times);
        for (const n of tl.names) this.nullableString(n);
        return;
      case 'deform':
        w.varuint(tl.target);
        w.varuint(this.tableIndex.get(tl.attachment)!);
        w.f32array(tl.times);
        for (const f of tl.frames) w.f32array(f);
        // Deform beziers interpolate a percentage: every segment runs 0 → 1.
        this.curves(tl.curves, 1, tl.times, () => [0, 1]);
        return;
      case 'sequence':
        w.varuint(tl.target);
        w.varuint(this.tableIndex.get(tl.attachment)!);
        w.f32array(tl.times);
        w.raw(Uint8Array.from(tl.modes));
        for (const i of tl.indices) w.varint(i);
        w.f32array(tl.delays);
        return;
      case 'drawOrder':
        w.f32array(tl.times);
        for (const order of tl.orders) {
          w.u8(order ? 1 : 0);
          if (order) w.i32array(order);
        }
        return;
      case 'event':
        w.f32array(tl.times);
        for (const e of tl.events) {
          this.string(e.name);
          w.varint(e.intValue);
          w.f32(e.floatValue);
          this.string(e.stringValue);
          w.f32(e.volume);
          w.f32(e.balance);
        }
        return;
      case 'physicsReset':
        w.varint(tl.target);
        w.f32array(tl.times);
        return;
      default:
        if (slbSignedTarget(tl.kind)) w.varint(tl.target);
        else w.varuint(tl.target);
        w.u8(tl.channels);
        w.f32array(tl.times);
        w.f32array(tl.values);
        this.curves(tl.curves, tl.channels, tl.times, (frame, ch) => {
          const v1 = tl.values[frame * tl.channels + ch]!;
          return [v1, tl.values[(frame + 1) * tl.channels + ch] ?? v1];
        });
        if (tl.kind === 'ik') w.raw(tl.flags ?? new Uint8Array(tl.times.length).fill(1));
    }
  }

  private atlas(atlas: AtlasData): void {
    const w = this.w;
    w.varuint(atlas.pages.length);
    for (const p of atlas.pages) {
      this.string(p.name);
      w.varuint(p.width);
      w.varuint(p.height);
      this.string(p.format);
      this.string(p.minFilter);
      this.string(p.magFilter);
      this.string(p.uWrap);
      this.string(p.vWrap);
      w.u8(p.pma ? 1 : 0);
    }
    w.varuint(atlas.regions.size);
    for (const r of atlas.regions.values()) {
      this.string(r.name);
      w.varuint(atlas.pages.indexOf(r.page));
      w.varuint(r.x);
      w.varuint(r.y);
      w.varuint(r.width);
      w.varuint(r.height);
      w.varuint(r.degrees);
      w.varint(r.offsetX);
      w.varint(r.offsetY);
      w.varuint(r.originalWidth);
      w.varuint(r.originalHeight);
      w.varint(r.index);
    }
  }
}

function sharesGeometry(a: MeshAttachment, b: MeshAttachment): boolean {
  return a.vertices === b.vertices && a.triangles === b.triangles && a.bones === b.bones && a.hullLength === b.hullLength;
}

/** Colors in the model come from 8-bit hex: store the byte. */
function toByte(v: number): number {
  return Math.round(v * 255);
}

/** Compile `data` to `.tabula` bytes, embedding the regions of `atlas` it uses. */
export function compileSkeleton(data: SkeletonData, atlas: AtlasData | null): ArrayBuffer {
  return writeSkeletonBinary(data, { atlas: atlas ? pruneAtlas(atlas, regionPathsOf(data)) : null });
}
