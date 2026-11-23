import { test } from "node:test"
import assert from "node:assert/strict"

const store = {}, flags = {}
globalThis.Hooks = { on() {}, once() {} }
globalThis.game = {
  settings: { get: (m, k) => store[k], register() {} },
  scenes: { get: (id) => (id === "s1" ? { id, getFlag: (m, k) => flags[k], setFlag: async (m, k, v) => { flags[k] = v }, unsetFlag: async (m, k) => { delete flags[k] } } : null) },
}
const N = await import("../scripts/realm-nest.js")

test("who zooms through: Off nobody, DM only the GM, Everyone everyone; default Everyone", () => {
  assert.equal(N.nestOnFor("off", true), false)
  assert.equal(N.nestOnFor("gm", false), false)
  assert.equal(N.nestOnFor("gm", true), true)
  assert.equal(N.nestOnFor("all", false), true)
  assert.equal(N.nestMode(), "all")
})

test("the camera carries across: into a nested map and back out is the same place", () => {
  const rect = { x: 0.55, y: 0.35, w: 0.12, h: 0.1 }
  const cam = { u: 0.6, v: 0.4, ppw: 50000 }
  const kid = N.toChildCam(cam, rect)
  assert.ok(Math.abs(kid.u - (0.05 / 0.12)) < 1e-12)
  assert.ok(Math.abs(kid.ppw - 6000) < 1e-9)
  const back = N.toParentCam(kid, rect)
  for (const k of ["u", "v", "ppw"]) assert.ok(Math.abs(back[k] - cam[k]) < 1e-9)
})

test("kidAt: the smallest under the point; a cutout counts", () => {
  const big = { sceneId: "big", rect: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 } }
  const small = { sceneId: "small", rect: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, cutout: [[0, 0], [1, 0], [0, 1]] }
  assert.equal(N.kidAt([big, small], 0.32, 0.32).sceneId, "small")
  assert.equal(N.kidAt([big, small], 0.38, 0.38).sceneId, "big")    // outside the small one's cutout
  assert.equal(N.kidAt([big, small], 0.9, 0.9), null)
})

test("fade: nothing below half the screen, all of it when filling", () => {
  assert.equal(N.fadeAlpha(0.4), 0)
  assert.ok(N.fadeAlpha(0.999) > 0.999)
  assert.equal(N.coverage({ l: -5, t: -5, r: 105, b: 105 }, 100, 100), 1)
})

test("nest.set keeps clean records and replaces the old ones", async () => {
  await N.nestSet({ sceneId: "s1", nest: { kids: [{ sceneId: "k", rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, cutout: [[0, 0], [1, 0], [0, 1], ["x", 2]] }, { sceneId: "bad", rect: { x: 0, y: 0, w: 0, h: 1 } }], parent: null, self: { cutout: null } } })
  assert.equal(flags.nest.kids.length, 1)
  assert.equal(flags.nest.kids[0].cutout.length, 3)
  await N.nestSet({ sceneId: "s1", nest: null })
  assert.equal(flags.nest, undefined)
  assert.equal((await N.nestSet({ sceneId: "nope", nest: null })).ok, false)
})
