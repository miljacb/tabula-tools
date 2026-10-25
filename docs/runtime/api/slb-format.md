# The .tbin format

`tabula compile` (and `repack --compile`) turns a Spine JSON export plus
its atlas into a compact little-endian binary, so the browser never parses
JSON or atlas text. It is ~24% of the JSON + atlas size (39% gzipped) and loads
~18× faster.

## Layout

| Part | Content |
|---|---|
| Header | magic `SLSK` (u32 `0x4b534c53`), format version (u16), IR version (u16), flags (u32; bit 0 `SLB_FLAG_ATLAS` = atlas embedded), then skeleton name, content hash and source Spine version (e.g. `4.1-from-4.2.43`) as strings. `readSlbHeader` reads only this. |
| String table | every other string once; the body refers to strings by index. |
| Body (4-byte aligned) | bones, slots, path constraints, IK / transform / physics constraints and reference scale (format 2+), skin-required bone/path-constraint lists and per-skin bone/constraint lists (format 3+), events, an attachment table shared by skins and timelines, skins, animations, unsupported-feature notes, the optional atlas (pages + only the regions this skeleton uses). |

Typed arrays (vertices, UVs, triangles, key times/values, bezier points) are
stored aligned and loaded as **views into the file buffer**: no copies, but
keep the buffer alive while the data is used. Physics constraint steps are
stored as fps (and mass as mass, not its inverse), so the simulation
accumulator gets exactly the values spine-core computes.

## Versions

| Constant | Value | Meaning |
|---|---|---|
| `SLB_FORMAT_VERSION` | 3 | Written by this compiler (2 added IK, transform, physics; 3 added skin-required bones/constraints). |
| `SLB_MIN_FORMAT_VERSION` | 1 | Oldest format still read (format 1 files load unchanged). |
| `IR_VERSION` | 2 | Version of the in-memory model. |

A file with another IR version or a format outside 1–3 is rejected:
"Unsupported .tbin format version N (this runtime reads 1-3); recompile the
skeleton" / ".tbin compiled for IR version N, this runtime uses 2; recompile the
skeleton". Corrupt files throw "Corrupt .tbin: …".

Timeline kinds are coded by index in `SLB_TIMELINE_KINDS`, attachment types in
`SLB_ATTACHMENT_TYPES`, curves as `SLB_CURVE_LINEAR` / `STEPPED` / `BEZIER`.
Physics timelines whose target is "all constraints" store a signed varint
(`slbSignedTarget`).

## API

| Function | What it does |
|---|---|
| `loadSkeletonBinary(bytes)` | → `{ header, data, atlas }` (`atlas` null when compiled with `--no-atlas`). |
| `readSlbHeader(bytes)` | → `SlbHeader { formatVersion, irVersion, flags, name, hash, sourceSpineVersion }`. |
| `compileSkeleton(data, atlas?)` (export engine, `tabula-tools`: `src/export/compile.ts`) | IR → `.tbin` bytes. |

`ByteReader` / `ByteWriter` (core) are the little-endian reader/writer used
by `.tbin` and `.baked`.
