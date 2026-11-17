// scripts/scene-doors-model.js — scene doors: stored list, edits, "back" lookups, size against zoom.
import { test } from "node:test"
import assert from "node:assert/strict"
import { doorsOf, cleanDoors, addDoor, patchDoor, removeDoor, doorsInto, doorScale, gridLine } from "../scripts/scene-doors-model.js"

const sc = (id, doors) => ({ id, flags: { "pendant-bridge": { doors } } })

test("bad entries are dropped; duplicates keep the first", () => {
  const out = cleanDoors([{ id: "a", scene: "s2", x: 1, y: 2 }, { id: "a", scene: "s3", x: 0, y: 0 }, { id: "b", x: 1, y: 1 },
    { id: "c", scene: "s2", x: "nope", y: 1 }, null, { id: "d", scene: "s4", x: "5", y: 6, town: "" }])
  assert.deepEqual(out, [{ id: "a", scene: "s2", x: 1, y: 2 }, { id: "d", scene: "s4", x: 5, y: 6 }])
  assert.deepEqual(cleanDoors("x"), [])
  assert.deepEqual(doorsOf(null), [])
  assert.deepEqual(doorsOf({ getFlag: () => [{ id: "z", scene: "s9", x: 0, y: 0 }] }).map(d => d.id), ["z"])
})

test("add / patch / remove never mutate, and clearing the town drops the key", () => {
  const start = [{ id: "a", scene: "s2", x: 1, y: 2, town: "t1" }]
  const added = addDoor(start, { id: "b", scene: "s3", x: 5, y: 5 })
  assert.equal(start.length, 1); assert.equal(added.length, 2)
  const moved = patchDoor(added, "a", { x: 10, y: 20, town: "" })
  assert.deepEqual(moved[0], { id: "a", scene: "s2", x: 10, y: 20 })
  assert.equal(added[0].x, 1)
  assert.deepEqual(removeDoor(moved, "a").map(d => d.id), ["b"])
})

test("doorsInto: every other scene with a door to here, once each", () => {
  const scenes = [sc("world", [{ id: "1", scene: "cave", x: 0, y: 0 }, { id: "2", scene: "cave", x: 9, y: 9 }]), sc("cave", [{ id: "3", scene: "cave", x: 0, y: 0 }]),
    sc("region", [{ id: "4", scene: "cave", x: 1, y: 1 }]), sc("town", [{ id: "5", scene: "world", x: 1, y: 1 }])]
  assert.deepEqual(doorsInto(scenes, "cave").map(r => r.from.id), ["world", "region"])
  assert.deepEqual(doorsInto(scenes, "nowhere"), [])
})

test("doorScale: same on screen above the stop point, locked to the map below it, continuous at the stop", () => {
  const fit = 0.25
  // zoomed in (map zoom 4 ≥ lock 1): 1 / stage scale → always the same size on screen
  assert.equal(doorScale({ stageScale: 1, fit, size: 1, lock: 1 }), 1)
  assert.equal(doorScale({ stageScale: 2, fit, size: 1, lock: 1 }) * 2, 1)
  // zoomed out past the stop (map zoom 0.5 < lock 1): a fixed scene size → shrinks on screen with the map
  const k = doorScale({ stageScale: 0.125, fit, size: 1, lock: 1 })
  assert.equal(k, doorScale({ stageScale: 0.1, fit, size: 1, lock: 1 }))
  assert.equal(k * 0.125, 0.5)                                    // on screen: half size at half the stop zoom
  // continuous at the stop
  assert.ok(Math.abs(doorScale({ stageScale: fit * 2, fit, lock: 2 }) - doorScale({ stageScale: fit * 2 * 0.999999, fit, lock: 2 })) < 1e-3)
  // size multiplies; bad input falls back
  assert.equal(doorScale({ stageScale: 1, fit, size: 1.5, lock: 1 }), 1.5)
  assert.ok(Number.isFinite(doorScale({ stageScale: 0, fit: 0, size: -1, lock: 0 })))
})

test("gridLine reads distance + size in squares", () => {
  assert.equal(gridLine({ width: 4000, height: 2800, grid: { size: 100, distance: 5, units: "ft" } }), "5 ft · 40 × 28")
  assert.equal(gridLine({ grid: {} }), "")
})
