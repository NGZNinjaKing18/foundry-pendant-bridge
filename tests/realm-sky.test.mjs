import { test } from "node:test"
import assert from "node:assert/strict"

const store = { realmSky: "off" }, flags = {}
globalThis.Hooks = { on() {}, once() {} }
globalThis.game = {
  settings: { get: (m, k) => store[k], register() {} },
  scenes: { get: (id) => (id === "s1" ? { id, dimensions: { sceneWidth: 3000, sceneHeight: 2000 }, setFlag: async (m, k, v) => { flags[k] = v } } : null) },
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
  store.realmSky = "gm"; assert.deepEqual(skyState(), { mode: "gm", aspects: {} })
})

test("sky.state reports each asked scene's width / height", () => {
  assert.deepEqual(skyState({ sceneIds: ["s1", "nope"] }).aspects, { s1: 1.5 })
})

test("sky.set stores an hour's three pictures on the scene, and refuses anything else", async () => {
  const png = "data:image/png;base64,AAAA"
  assert.equal((await skySet({ sceneId: "nope", sky: {} })).ok, false)
  assert.equal((await skySet({ sceneId: "s1", sky: { light: png, clouds: "javascript:x", wet: png } })).ok, false)
  assert.equal((await skySet({ sceneId: "s1", sky: { at: { day: 12, hour: 7 }, light: png, clouds: png, wet: png } })).ok, true)
  assert.deepEqual(flags.sky, { at: { day: 12, hour: 7 }, light: png, clouds: png, wet: png, wind: null, band: null, box: null })
})

test("sky.set keeps the wind rows and drops anything that isn't a pair of numbers", async () => {
  const png = "data:image/png;base64,AAAA"
  await skySet({ sceneId: "s1", sky: { light: png, clouds: png, wet: png, wind: [[0.9, -0.3], ["x", 1], [1], [-0.9, 0.3]] } })
  assert.deepEqual(flags.sky.wind, [[0.9, -0.3], [-0.9, 0.3]])
})

test("sky.set keeps the forecast band only with its box", async () => {
  const png = "data:image/png;base64,AAAA"
  await skySet({ sceneId: "s1", sky: { light: png, clouds: png, wet: png, band: png, box: [-0.01, -0.02, 1.01, 1.03] } })
  assert.equal(flags.sky.band, png); assert.deepEqual(flags.sky.box, [-0.01, -0.02, 1.01, 1.03])
  await skySet({ sceneId: "s1", sky: { light: png, clouds: png, wet: png, band: png, box: [0, 0, 1] } })
  assert.equal(flags.sky.band, null); assert.equal(flags.sky.box, null)
})
