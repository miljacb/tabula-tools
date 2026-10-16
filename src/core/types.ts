/**
 * Intermediate representation (IR) of a skeleton: the version-independent data
 * model produced by the build-tool adapters and consumed by the runtime,
 * the validator and the baker. Only adapters know Spine file formats.
 *
 * Conventions:
 * - Angles are in degrees, as authored.
 * - Colors are straight (non-premultiplied) floats in [0, 1].
 * - Vertex attachments use Spine's split layout: `bones` is `null` for unweighted
 *   vertices (`vertices` = x,y pairs in bone space); otherwise `bones` holds, per
 *   vertex, an influence count followed by that many bone indices, and `vertices`
 *   holds x,y,weight triplets (one per influence).
 * - Every curve timeline stores one representation (see {@link CurveTimeline}).
 *
 * Design ref: tabula-runtime-design.md §7.3.
 */

/**
 * Version of this data model. Stored in compiled skeleton files (`.tabula`), so
 * a runtime refuses files compiled against a different model. Bump it on any
 * change to the shapes below that affects stored data.
 */
export const IR_VERSION = 2;

// ============================================================================
// Basic value types
// ============================================================================

/** Straight-alpha RGBA color, each channel in [0, 1]. */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** RGB "dark" color for two-color tint (tint black), each channel in [0, 1]. */
export interface DarkColor {
  r: number;
  g: number;
  b: number;
}

/** Slot blend modes. Normal and additive share one PMA blend state. */
export enum BlendMode {
  Normal = 0,
  Additive = 1,
  Multiply = 2,
  Screen = 3,
}

/** How a bone inherits its parent's transform (Spine "transform"/"inherit" mode). */
export enum Inherit {
  Normal = 0,
  OnlyTranslation = 1,
  NoRotationOrReflection = 2,
  NoScale = 3,
  NoScaleOrReflection = 4,
}

// ============================================================================
// Skeleton
// ============================================================================

/** Version-independent skeleton model (setup pose, skins, animations, constraints) produced by the adapters and stored in `.tabula`. */
export interface SkeletonData {
  name: string;
  hash: string;
  /** Source version string as found in the export, for diagnostics only. */
  spineVersion: string;
  x: number;
  y: number;
  width: number;
  height: number;

  /** Bones, parents always before children. */
  bones: BoneData[];
  /** Slots in setup draw order. */
  slots: SlotData[];
  skins: SkinData[];
  /** Skin named "default", if any. Used as fallback for attachment lookups. */
  defaultSkin: SkinData | null;
  animations: AnimationData[];
  events: EventData[];
  pathConstraints: PathConstraintData[];
  ikConstraints: IkConstraintData[];
  transformConstraints: TransformConstraintData[];
  /** Spine 4.2 physics constraints (empty for 4.1 data). */
  physicsConstraints: PhysicsConstraintData[];
  /** Spine 4.2 `referenceScale` (physics wind/gravity units), default 100. */
  referenceScale: number;
  /** Features the adapter recognized but the runtime cannot play (validator errors). */
  unsupported: UnsupportedFeature[];
  /** Adapter notes for the validator's warnings, e.g. a newer Spine version read best-effort (not serialized). */
  notes?: string[];

  boneIndex: Map<string, number>;
  slotIndex: Map<string, number>;
}

/** A feature the adapter recognized but the runtime cannot play (reported by the validator). */
export interface UnsupportedFeature {
  feature: string;
  detail: string;
}

/** Bone setup pose. Angles in degrees. */
export interface BoneData {
  index: number;
  name: string;
  /** Parent bone index, -1 for the root. */
  parentIndex: number;
  length: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
  inherit: Inherit;
  /** Active only when the current skin lists this bone (or a descendant); Spine "skin required". */
  skinRequired?: boolean;
}

/** Slot setup state: bone, colors, setup attachment, blend mode. */
export interface SlotData {
  index: number;
  name: string;
  boneIndex: number;
  color: Color;
  /** Present only when the slot uses two-color tint. */
  darkColor: DarkColor | null;
  attachmentName: string | null;
  blendMode: BlendMode;
}

/** Named set of attachments, keyed by slot and attachment key. */
export interface SkinData {
  name: string;
  /** slot index -> attachment key -> attachment */
  attachments: Map<number, Map<string, Attachment>>;
  /** Skin-required bones this skin activates (bone indices). */
  bones?: number[];
  /** Skin-required constraints this skin activates (constraint names; unique across constraint types). */
  constraints?: string[];
}

/** Event defaults; keys in an {@link EventTimeline} override them. */
export interface EventData {
  name: string;
  intValue: number;
  floatValue: number;
  stringValue: string;
  audioPath: string | null;
  volume: number;
  balance: number;
}

// ============================================================================
// Constraints
// ============================================================================

/** Path constraint position units: fixed (world units) or percent of the path length. */
export enum PositionMode {
  Fixed = 0,
  Percent = 1,
}

/** How path constraint spacing is interpreted (spine-core `SpacingMode`). */
export enum SpacingMode {
  Length = 0,
  Fixed = 1,
  Percent = 2,
  Proportional = 3,
}

/** How path-constrained bones are rotated (spine-core `RotateMode`). */
export enum RotateMode {
  Tangent = 0,
  Chain = 1,
  ChainScale = 2,
}

/** Path constraint setup (spine-core `PathConstraintData`). */
export interface PathConstraintData {
  name: string;
  order: number;
  /** Active only when the current skin lists this constraint. */
  skinRequired?: boolean;
  /** Constrained bone indices, in constraint order. */
  bones: number[];
  /** Slot whose path attachment drives the constraint. */
  targetSlotIndex: number;
  positionMode: PositionMode;
  spacingMode: SpacingMode;
  rotateMode: RotateMode;
  /** Degrees. */
  offsetRotation: number;
  position: number;
  spacing: number;
  mixRotate: number;
  mixX: number;
  mixY: number;
}

/** IK constraint setup (spine-core 4.2 `IkConstraintData`). */
export interface IkConstraintData {
  name: string;
  order: number;
  /** Only active when the current skin lists it (Spine "skin required"); see {@link Skeleton.updateCache}. */
  skinRequired: boolean;
  /** 1 or 2 constrained bones (parent, then child). */
  bones: number[];
  target: number;
  /** 1 or -1. */
  bendDirection: number;
  compress: boolean;
  stretch: boolean;
  uniform: boolean;
  mix: number;
  softness: number;
}

/** Transform constraint setup (spine-core 4.2 `TransformConstraintData`). */
export interface TransformConstraintData {
  name: string;
  order: number;
  skinRequired: boolean;
  bones: number[];
  target: number;
  local: boolean;
  relative: boolean;
  /** Degrees. */
  offsetRotation: number;
  offsetX: number;
  offsetY: number;
  offsetScaleX: number;
  offsetScaleY: number;
  offsetShearY: number;
  mixRotate: number;
  mixX: number;
  mixY: number;
  mixScaleX: number;
  mixScaleY: number;
  mixShearY: number;
}

/** Physics constraint setup (spine-core 4.2 `PhysicsConstraintData`). */
export interface PhysicsConstraintData {
  name: string;
  order: number;
  skinRequired: boolean;
  bone: number;
  /** Influence per degree of freedom (0 = off). */
  x: number;
  y: number;
  rotate: number;
  scaleX: number;
  shearX: number;
  /** Max velocity applied from bone movement, per second. */
  limit: number;
  /** Fixed simulation step, seconds (1 / fps). */
  step: number;
  inertia: number;
  strength: number;
  damping: number;
  massInverse: number;
  wind: number;
  gravity: number;
  mix: number;
  inertiaGlobal: boolean;
  strengthGlobal: boolean;
  dampingGlobal: boolean;
  massGlobal: boolean;
  windGlobal: boolean;
  gravityGlobal: boolean;
  mixGlobal: boolean;
}

// ============================================================================
// Attachments
// ============================================================================

/** Attachment kinds of the model. */
export type AttachmentType = 'region' | 'mesh' | 'clipping' | 'path' | 'point' | 'boundingbox';

/** Spine 4.1 attachment sequence: frame regions are `path + zeroPad(start + i, digits)`. */
export interface SequenceData {
  count: number;
  start: number;
  digits: number;
  /** Frame shown when no sequence timeline is active. */
  setupIndex: number;
}

/** Textured quad. Offsets and size are in the attachment's bone space. */
export interface RegionAttachment {
  type: 'region';
  name: string;
  path: string;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  width: number;
  height: number;
  color: Color;
  sequence: SequenceData | null;
}

/** Shared shape of attachments whose vertices are bound to bones. */
export interface VertexData {
  /** Influence counts + bone indices (weighted), or null (unweighted). */
  bones: Int32Array | null;
  /** x,y pairs (unweighted) or x,y,weight triplets (weighted). */
  vertices: Float32Array;
  /** Number of floats produced by computing world vertices (vertexCount * 2). */
  worldVerticesLength: number;
}

/** Textured triangle mesh, optionally weighted to several bones. */
export interface MeshAttachment extends VertexData {
  type: 'mesh';
  name: string;
  path: string;
  /** Normalized UVs within the (untrimmed) region, x,y pairs. */
  regionUVs: Float32Array;
  triangles: Uint16Array;
  hullLength: number;
  color: Color;
  width: number;
  height: number;
  sequence: SequenceData | null;
  /**
   * Attachment that deform and sequence timelines target. Itself, or the parent
   * mesh for a linked mesh that inherits deform.
   */
  timelineAttachment: Attachment;
}

/** Polygon that clips the slots from its own up to `endSlotIndex` in draw order. */
export interface ClippingAttachment extends VertexData {
  type: 'clipping';
  name: string;
  /** Slot index after which clipping ends (inclusive), -1 = until the end. */
  endSlotIndex: number;
}

/** Bezier path used by path constraints (never drawn). */
export interface PathAttachment extends VertexData {
  type: 'path';
  name: string;
  closed: boolean;
  constantSpeed: boolean;
  /** Cumulative curve lengths authored in the editor. */
  lengths: Float32Array;
}

/** Named point with a rotation, e.g. a spawn location ({@link Clip.getPointTransform}). */
export interface PointAttachment {
  type: 'point';
  name: string;
  x: number;
  y: number;
  rotation: number;
}

/** Hit-test polygon (parsed, not drawn). */
export interface BoundingBoxAttachment extends VertexData {
  type: 'boundingbox';
  name: string;
}

/** Attachments whose vertices are bound to bones. */
export type VertexAttachment = MeshAttachment | ClippingAttachment | PathAttachment | BoundingBoxAttachment;

/** Any attachment in a skin. */
export type Attachment =
  | RegionAttachment
  | MeshAttachment
  | ClippingAttachment
  | PathAttachment
  | PointAttachment
  | BoundingBoxAttachment;

// ============================================================================
// Animations
// ============================================================================

/**
 * Curve between frame i and i+1: `null` = linear, `'stepped'`, or bezier control
 * points `[cx1, cy1, cx2, cy2]` per channel in absolute (time, value) units —
 * exactly as Spine 4.x exports them. Compiled skeletons store the control
 * points as views into the file buffer.
 */
export type CurveData = null | 'stepped' | number[] | Float32Array;

/** Kinds of keyframed float timelines. */
export type CurveTimelineKind =
  | 'rotate' | 'translate' | 'translatex' | 'translatey'
  | 'scale' | 'scalex' | 'scaley'
  | 'shear' | 'shearx' | 'sheary'
  | 'rgba' | 'rgb' | 'alpha' | 'rgba2' | 'rgb2'
  | 'pathPosition' | 'pathSpacing' | 'pathMix'
  | 'ik' | 'transformMix'
  | 'physicsInertia' | 'physicsStrength' | 'physicsDamping' | 'physicsMass' | 'physicsWind' | 'physicsGravity' | 'physicsMix';

/**
 * A keyframed timeline with `channels` float values per frame.
 * Channel layouts: translate/scale/shear = x,y; rgba = r,g,b,a; rgb = r,g,b;
 * rgba2 = r,g,b,a,dr,dg,db; rgb2 = r,g,b,dr,dg,db; pathMix = rotate,x,y;
 * ik = mix,softness (+ stepped {@link CurveTimeline.flags}); transformMix =
 * rotate,x,y,scaleX,scaleY,shearY; physics* = one value (physicsMass: mass).
 */
export interface CurveTimeline {
  kind: CurveTimelineKind;
  /** Bone, slot or path constraint index depending on `kind`. */
  target: number;
  channels: number;
  times: Float32Array;
  /** frameCount * channels values. */
  values: Float32Array;
  /** One entry per frame (the last one is unused). */
  curves: CurveData[];
  /**
   * `ik` only, per frame (stepped): bit 0 = bend positive, bit 1 = compress,
   * bit 2 = stretch. Physics timelines use `target` -1 for "all constraints
   * with the global flag".
   */
  flags?: Uint8Array;
}

/** IK flags bits in {@link CurveTimeline.flags}. */
export const IK_FLAG_BEND_POSITIVE = 1;
/** IK timeline flag bit: compress. */
export const IK_FLAG_COMPRESS = 2;
/** IK timeline flag bit: stretch. */
export const IK_FLAG_STRETCH = 4;

/** Spine 4.2 physics reset keys: physics state restarts when playback crosses a key. */
export interface PhysicsResetTimeline {
  kind: 'physicsReset';
  /** Physics constraint index, or -1 for all. */
  target: number;
  times: Float32Array;
}

/** Spine 4.2 inherit-mode keys (stepped). */
export interface InheritTimeline {
  kind: 'inherit';
  target: number;
  times: Float32Array;
  inherits: Inherit[];
}

/** Switches a slot's attachment (null = none). */
export interface AttachmentTimeline {
  kind: 'attachment';
  target: number;
  times: Float32Array;
  names: (string | null)[];
}

/** Animates mesh vertex offsets. */
export interface DeformTimeline {
  kind: 'deform';
  target: number;
  /** Attachment this timeline deforms (matched against the slot's timeline attachment). */
  attachment: VertexAttachment;
  times: Float32Array;
  /**
   * Per-frame vertices. Unweighted: absolute bone-space positions.
   * Weighted: offsets per influence (2 floats per influence).
   */
  frames: Float32Array[];
  /** Interpolation curve per frame; bezier values are in [0, 1] (percent). */
  curves: CurveData[];
}

/** Playback mode of a sequence (frame-by-frame) attachment. */
export enum SequenceMode {
  Hold = 0,
  Once = 1,
  Loop = 2,
  Pingpong = 3,
  OnceReverse = 4,
  LoopReverse = 5,
  PingpongReverse = 6,
}

/** Starts or changes a sequence attachment's playback. */
export interface SequenceTimeline {
  kind: 'sequence';
  target: number;
  attachment: RegionAttachment | MeshAttachment;
  times: Float32Array;
  modes: SequenceMode[];
  indices: number[];
  delays: number[];
}

/** Reorders slots for drawing. */
export interface DrawOrderTimeline {
  kind: 'drawOrder';
  times: Float32Array;
  /** Per frame: slot indices in draw order, or null for the setup order. */
  orders: (Int32Array | null)[];
}

/** One event firing; values override the {@link EventData} defaults. */
export interface EventKey {
  time: number;
  name: string;
  intValue: number;
  floatValue: number;
  stringValue: string;
  volume: number;
  balance: number;
}

/** Events fired at authored times. */
export interface EventTimeline {
  kind: 'event';
  times: Float32Array;
  events: EventKey[];
}

/** Any timeline of an animation. */
export type Timeline =
  | CurveTimeline
  | InheritTimeline
  | AttachmentTimeline
  | DeformTimeline
  | SequenceTimeline
  | DrawOrderTimeline
  | EventTimeline
  | PhysicsResetTimeline;

/** A named animation: its timelines and duration. */
export interface AnimationData {
  name: string;
  duration: number;
  /** Applied in this order (Spine's order: slots, bones, constraints, deform/sequence, draw order). */
  timelines: Timeline[];
}

// ============================================================================
// Atlas
// ============================================================================

/** Parsed atlas: pages and regions by name. */
export interface AtlasData {
  pages: AtlasPage[];
  regions: Map<string, AtlasRegion>;
}

/** One texture page of a libGDX/Spine `.atlas`. */
export interface AtlasPage {
  name: string;
  width: number;
  height: number;
  format: string;
  minFilter: string;
  magFilter: string;
  uWrap: string;
  vWrap: string;
  /** True if the page image is already premultiplied. */
  pma: boolean;
}

/** A packed image within an atlas page. */
export interface AtlasRegion {
  name: string;
  page: AtlasPage;
  /** Packed position in the page, pixels. */
  x: number;
  y: number;
  /** Packed (trimmed) size, unrotated orientation, pixels. */
  width: number;
  height: number;
  /** Packing rotation in degrees (0 or 90 in practice; 180/270 supported). */
  degrees: number;
  /** Trim offsets from the bottom-left of the original image, pixels. */
  offsetX: number;
  offsetY: number;
  originalWidth: number;
  originalHeight: number;
  /** Legacy frame index, -1 if none. */
  index: number;
}
