# Hit testing and bounds

Hit tests use the skeleton's **bounding box attachments** in the current pose
(animated, skinned, hidden when not attached). Polygons may be concave
(even-odd rule). Results are reused buffers: no allocation per call, but copy
what you need before the next call.

## Pixi views

```ts
view.eventMode = 'static';               // pointer events reach the view only inside a visible bounding box
view.on('pointertap', () => spin());

const box = view.hitTest(event.global);  // topmost box under a stage point, or null
if (box) console.log(box.attachment.name, box.slot.data.name);

const r = view.getPoseBounds();          // local Rectangle of everything drawn
```

| Member | What it does |
|---|---|
| `ClipView#hitTest(globalPoint)` | Topmost visible bounding box (last in draw order) containing the point, or null. |
| `ClipView#containsPoint(globalPoint)` | Pixi's hook; `true` iff `hitTest` finds a box. A view without bounding boxes is never hit: set `view.hitArea` (e.g. `view.getPoseBounds()`) for a rectangular area instead. |
| `ClipView#getPoseBounds(out?)` | Local bounds of the drawn vertices (clipping applied). `getBounds()` / `getLocalBounds()` use the same data. |

## Core (skeleton space)

| Member | What it does |
|---|---|
| `clip.hitTest(x, y)` | Topmost box containing the skeleton-space point, or null. |
| `clip.getBoundingBoxes()` | All visible boxes: `BoundingBoxPolygon { slot, attachment, vertices, vertexCount }` (x,y pairs in skeleton space). |
| `new SkeletonBounds().update(skeleton)` | Standalone: `polygons`, `containsPoint(x, y)`, `find(attachmentName)`. |
| `polygonContainsPoint(vertices, count, x, y)` | Even-odd point-in-polygon test. |
| `clip.getPointTransform(name, out)` | Transform of a point attachment (or bone) for anchoring effects, coins, particles. |

Skeleton space for views is the view's local space (y down). Convert with
Pixi: `view.toLocal(globalPoint)` / `view.toGlobal(new Point(m.tx, m.ty))`.

```ts
const m = clip.getPointTransform('coinSpawn', { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
emitter.position.copyFrom(view.toGlobal(new Point(m.tx, m.ty)));
```
