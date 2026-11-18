// scripts/party.js placeOptions — "be there now" without Foundry's deprecated `teleport` option (V13+).
import { test } from "node:test"
import assert from "node:assert/strict"
globalThis.Hooks ??= { on() {}, once() {}, callAll() {} }
globalThis.game = { release: { generation: 13 } }
const { placeOptions } = await import("../scripts/party.js")

const scene = { tokens: { get: (id) => ({ t1: { _source: { x: 0, y: 0, elevation: 0, width: 1, height: 1, shape: 4 } } })[id] } }

test("V13+: one displace waypoint per moved token, walls ignored, no teleport", () => {
  const o = placeOptions(scene, [{ _id: "t1", x: 300, y: 400 }, { _id: "t1x", x: 1 }, { _id: "t1", name: "rename only" }])
  assert.equal("teleport" in o, false)
  assert.deepEqual(Object.keys(o.movement), ["t1"])
  const m = o.movement.t1
  assert.equal(m.waypoints[0].action, "displace")
  assert.deepEqual([m.waypoints[0].x, m.waypoints[0].y, m.waypoints[0].shape], [300, 400, 4])
  assert.deepEqual(m.constrainOptions, { ignoreWalls: true, ignoreCost: true })
})
test("nothing moved → no movement options; V12 → the old teleport", () => {
  assert.deepEqual(placeOptions(scene, [{ _id: "t1", hidden: true }]), {})
  game.release.generation = 12
  assert.deepEqual(placeOptions(scene, [{ _id: "t1", x: 1 }]), { teleport: true })
  game.release.generation = 13
})
