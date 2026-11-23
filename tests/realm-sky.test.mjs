import { test } from "node:test"
import assert from "node:assert/strict"

const store = { realmSky: "off" }, flags = {}
globalThis.Hooks = { on() {}, once() {} }
globalThis.game = {
  settings: { get: (m, k) => store[k], register() {} },
  scenes: { get: (id) => (id === "s1" ? { id, setFlag: async (m, k, v) => { flags[k] = v } } : null) },
}
const { skyShownFor, skyMode, skyState, skySet } = await import("../scripts/realm-sky.js")

test("who sees the sky: Off nobody, DM only the GM, Everyone everyone", () => {
  assert.equal(skyShownFor("off", true), false)
  assert.equal(skyShownFor("gm", true), true)
  assert.equal(skyShownFor("gm", false), false)
  assert.equal(skyShownFor("all", false), true)
})

test("the mode falls back to Off for anything unknown", () => {
  store.realmSky = "weird"; assert.equal(skyMode(), "off")
  store.realmSky = "gm"; assert.deepEqual(skyState(), { mode: "gm" })
})

test("sky.set stores an hour's three pictures on the scene, and refuses anything else", async () => {
  const png = "data:image/png;base64,AAAA"
  assert.equal((await skySet({ sceneId: "nope", sky: {} })).ok, false)
  assert.equal((await skySet({ sceneId: "s1", sky: { light: png, clouds: "javascript:x", wet: png } })).ok, false)
  assert.equal((await skySet({ sceneId: "s1", sky: { at: { day: 12, hour: 7 }, light: png, clouds: png, wet: png } })).ok, true)
  assert.deepEqual(flags.sky, { at: { day: 12, hour: 7 }, light: png, clouds: png, wet: png, wind: null })
})

test("sky.set keeps the wind rows and drops anything that isn't a pair of numbers", async () => {
  const png = "data:image/png;base64,AAAA"
  await skySet({ sceneId: "s1", sky: { light: png, clouds: png, wet: png, wind: [[0.9, -0.3], ["x", 1], [1], [-0.9, 0.3]] } })
  assert.deepEqual(flags.sky.wind, [[0.9, -0.3], [-0.9, 0.3]])
})
