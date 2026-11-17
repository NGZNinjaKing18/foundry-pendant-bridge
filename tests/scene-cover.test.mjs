// scripts/scene-cover.js — scenes tagged "scene cover" get one look (Lock View fit + zoom lock, no token vision, gridless).
import { test } from "node:test"
import assert from "node:assert/strict"
globalThis.Hooks = { on() {}, once() {} }
const { coverUpdate, isCover } = await import("../scripts/scene-cover.js")

const scene = (tags, extra = {}) => ({ flags: { "pendant-bridge": { tags } }, tokenVision: true, fog: { exploration: true }, grid: { type: 1 }, ...extra })

test("only scenes tagged scene cover (any case, extra spaces)", () => {
  assert.equal(isCover(scene(["Scene Cover "])), true)
  assert.equal(isCover(scene(["scene", "cover"])), false)
  assert.equal(coverUpdate(scene(["map"])), null)
})

test("a fresh cover scene gets every setting", () => {
  assert.deepEqual(coverUpdate(scene(["scene cover"])), {
    tokenVision: false, "fog.exploration": false, "grid.type": 0,
    "flags.LockView.locks.pan": false, "flags.LockView.locks.zoom": true, "flags.LockView.locks.boundingBox": false,
    "flags.LockView.autoscale": "horizontal",
  })
})

test("already right = nothing written; Lock View left alone when that module is off", () => {
  const done = scene(["scene cover"], { tokenVision: false, fog: { exploration: false }, grid: { type: 0 },
    flags: { "pendant-bridge": { tags: ["scene cover"] }, LockView: { locks: { pan: false, zoom: true, boundingBox: false }, autoscale: "horizontal" } } })
  assert.equal(coverUpdate(done), null)
  assert.deepEqual(Object.keys(coverUpdate(scene(["scene cover"]), { lockView: false })), ["tokenVision", "fog.exploration", "grid.type"])
})
