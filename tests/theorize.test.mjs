// scripts/theorize.js — the road maths behind snapping and following a road.
import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.Hooks = { on() {}, once() {}, callAll() {} }
globalThis.game = { user: { id: "u1", isGM: true }, users: { get: () => null }, settings: { register() {}, get() { return true } }, socket: { emit() {}, on() {} } }
globalThis.ui = { notifications: { warn() {}, info() {} } }
globalThis.window = { addEventListener() {} }
const { nearestOn, stretch, slice } = await import("../scripts/theorize.js")
const lengths = (pts) => { const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return L }

const road = [[0, 0], [100, 0], [100, 100]]
const L = lengths(road)

test("the nearest point on a road, and how far along it is", () => {
  const n = nearestOn(road, L, [40, 7])
  assert.deepEqual(n.pt, [40, 0]); assert.equal(n.d, 7); assert.equal(n.s, 40)
  assert.equal(nearestOn(road, L, [108, 50]).s, 150, "round the corner")
})

test("a stretch of road between two points, either way, keeping its corner", () => {
  assert.deepEqual(stretch(road, L, 40, 150), [[40, 0], [100, 0], [100, 50]])
  assert.deepEqual(stretch(road, L, 150, 40), [[100, 50], [100, 0], [40, 0]], "walking it backwards")
  assert.deepEqual(stretch(road, L, 10, 30), [[10, 0], [30, 0]], "no corner in between")
})

test("a line cut by fractions of its length (RealmScreen's legs → colours)", () => {
  assert.deepEqual(slice(road, L, 0, 0.5), [[0, 0], [100, 0]])
  assert.deepEqual(slice(road, L, 0.25, 0.75), [[50, 0], [100, 0], [100, 50]])
})
