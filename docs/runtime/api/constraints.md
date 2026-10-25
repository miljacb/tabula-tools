# Constraints

IK, transform, path and physics constraints are ported from spine-core and
run automatically whenever a clip poses its skeleton. Nothing needs to be
enabled. Example: [`docs/examples/constraints.ts`](../examples/constraints.ts).

## Accuracy

Validated numerically against the official runtimes (spine-core 4.1.56 for
4.1 exports, 4.2.120 for 4.2 exports) over every frame of test skeletons with
IK (1- and 2-bone, stretch, compress, uniform, bend direction, softness),
transform constraints (world/local, absolute/relative) and physics (fixed-step
simulation, reset keys, wind, gravity, inertia/strength/damping/mass/mix keys):
worst world-position difference **6.7·10⁻⁶ px**, matrix entries < 10⁻⁶
(`tests/constraints.test.ts`).

## Spine 4.1 vs 4.2 semantics

spine-core changed several formulas between 4.1 and 4.2 (single-bone IK at
non-unit scale, local transform-constraint rotation/shear wrapping, the sign of
applied shear, IK `compress` precedence, two-bone IK and inheritance,
`noRotationOrReflection`). Tabula follows the version the skeleton was
exported as (`skeleton.semantics41` is true for 4.1 data), so a 4.1 export
looks exactly as in a 4.1 runtime and a 4.2 export as in 4.2.

## Runtime access

| Member | What it does |
|---|---|
| `skeleton.ikConstraints`, `findIkConstraint(name)` | `IkConstraint`: `mix`, `softness`, `bendDirection`, `compress`, `stretch`, `target`, `bones`. |
| `skeleton.transformConstraints`, `findTransformConstraint(name)` | `TransformConstraint`: `mixRotate`, `mixX`, `mixY`, `mixScaleX`, `mixScaleY`, `mixShearY`. |
| `skeleton.pathConstraints` | `PathConstraint`: `position`, `spacing`, `mixRotate`, `mixX`, `mixY`. |
| `skeleton.physicsConstraints`, `findPhysicsConstraint(name)` | `PhysicsConstraint`: `inertia`, `strength`, `damping`, `massInverse`, `wind`, `gravity`, `mix`, `reset()`, `translate(x, y)`, `rotate(x, y, degrees)`. |

Values set from code are the base each frame's pose starts from only until an
animation key for that constraint overwrites them (as in Spine).

## Physics

| API | What it does |
|---|---|
| `ClipOptions.physics` (default `true`) | Simulate physics in `update(dt)`. `false`: physics bones take their animated pose without simulation. |
| `clip.resetPhysics()` | Restart the simulation from the current pose (after teleporting, re-showing a hidden view, switching scenes). Same as a physics reset key. |
| `skeleton.physicsTranslate(x, y)` / `physicsRotate(x, y, degrees)` | Tell physics the skeleton moved in world space, so hair/cloth swing with the motion. |
| `skeleton.time`, `skeleton.update(dt)` | Physics clock (the clip advances it). |
| `Physics` enum | `none`, `reset`, `update`, `pose`: how `updateWorldTransform(physics)` treats physics (spine-core semantics). |

Behaviour:

- The simulation uses spine-core's fixed step (`1 / fps` of the constraint) with an accumulator, so results do not depend on the frame rate.
- It keeps settling while the clip is paused or completed (`update()` still steps it).
- `clip.speed` scales physics time too.
- During a crossfade the outgoing pose is evaluated without stepping physics.
- **Physics skeletons are never baked**: their pose depends on history (frame rate, previous animations, movement). `canBakeSkeleton(data)` is false, `bake` writes no animations for them and the clip plays them live even if a `.baked` file was loaded.

## Validation

`tabula check` reports constraint problems that spine-core would throw on
(an IK bone without parent, a second IK bone that is not a direct child) as
errors, and warns about two-bone IK on bones without normal inheritance (a
no-op, as in spine-core).

## Skin-required bones and constraints

Bones and constraints marked "skin required" in Spine are active only while
the current skin includes them, exactly as in spine-core. `setSkin` rebuilds
the update order: inactive bones are not posed, their slots are not drawn,
hit-tested or included in bounds, and inactive constraints are skipped.

```ts
clip.setSkin('armed'); // the sword bone and its IK become active
clip.setSkin('default'); // both inactive again; sword slots are not drawn
```

Each bone has `active`; IK, transform, path and physics constraints have
`active` too. `.tbin` format 3 stores the flags (older files load with
everything active).
