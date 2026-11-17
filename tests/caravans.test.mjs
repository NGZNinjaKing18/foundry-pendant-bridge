// scripts/caravans.js — a caravan token is as wide as its road, as long as its picture.
import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { caravanSize } = await import("../scripts/caravans.js")

test("as wide as the road: wide enough → no scaling; the picture's length along", () => {
  const s = caravanSize(100, 3, 100)               // a road 1 cell wide, a 3:1 cart
  assert.deepEqual(s, { width: 1, height: 3, scale: 1 })
})

test("a thin road: Foundry's half-cell minimum, the picture scaled down to the road's width", () => {
  const s = caravanSize(10, 3, 100)                // 0.1 cell wide
  assert.equal(s.width, 0.5); assert.equal(s.height, 1.5)
  assert.ok(Math.abs(s.width * s.scale - 0.1) < 1e-3)   // drawn 0.1 cell wide, like the road
})
