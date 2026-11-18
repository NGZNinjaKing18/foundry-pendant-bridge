// scripts/scene-dir.js — the Scenes sidebar upgrade's rules.
import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { pushRecent, allTags, hasTag, dirOf, stripRows } = await import("../scripts/scene-dir.js")
const sc = (id, tags) => ({ id, flags: { "pendant-bridge": { tags } } })

test("recent: newest first, no repeats, capped", () => {
  assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"])
  assert.deepEqual(pushRecent(["a", "b"], "c", 2), ["c", "a"])
  assert.deepEqual(pushRecent(null, "x"), ["x"])
  assert.deepEqual(pushRecent(["a"], null), ["a"])
})

test("tags: each once (any case), sorted; a scene matches ignoring case", () => {
  assert.deepEqual(allTags([sc("1", ["Town", "battle"]), sc("2", ["town", " Dungeon "]), sc("3", null)]), ["battle", "Dungeon", "Town"])
  assert.equal(hasTag(sc("1", ["Town"]), "town"), true)
  assert.equal(hasTag(sc("1", ["Town"]), "Battle"), false)
  assert.equal(hasTag(sc("1", []), null), true)
})

test("a folder's switches: pictures off, coloured bar on, by default", () => {
  assert.deepEqual(dirOf({}), { pictures: false, bar: true })
  assert.deepEqual(dirOf({ flags: { "pendant-bridge": { dir: { pictures: true, bar: false } } } }), { pictures: true, bar: false })
})

test("strip: live first, pinned after, recent without those; gone scenes dropped", () => {
  const exists = (id) => id !== "gone"
  assert.deepEqual(stripRows({ live: "w", pins: ["p", "w", "gone"], recent: ["r1", "p", "w", "r2", "gone"], exists }), { top: ["w", "p"], recent: ["r1", "r2"] })
  assert.deepEqual(stripRows({ live: null, pins: [], recent: [], exists }), { top: [], recent: [] })
})

test("tag row: most-used first, capped, picked one kept, rest A–Z", async () => {
  const { tagRows } = await import("../scripts/scene-dir.js")
  const scenes = [sc("1", ["Town", "zz"]), sc("2", ["town", "Battle"]), sc("3", ["Town", "Battle", "aa"]), sc("4", ["Cave"])]
  assert.deepEqual(tagRows(scenes, null, 2), { shown: ["Town", "Battle"], rest: ["aa", "Cave", "zz"] })
  assert.deepEqual(tagRows(scenes, "zz", 2), { shown: ["Town", "Battle", "zz"], rest: ["aa", "Cave"] })
  assert.deepEqual(tagRows([], null), { shown: [], rest: [] })
})

test("fast folders: state, add (no repeats), remove, and what a drop carries", async () => {
  const { fastOf, fastAdd, fastRemove, droppedSceneId } = await import("../scripts/scene-dir.js")
  assert.deepEqual(fastOf({}), { on: false, scenes: [] })
  assert.deepEqual(fastOf({ flags: { "pendant-bridge": { fast: { on: true, scenes: ["a", "a", "b", ""] } } } }), { on: true, scenes: ["a", "b"] })
  assert.deepEqual(fastAdd(["a"], "b"), ["a", "b"]); assert.deepEqual(fastAdd(["a"], "a"), ["a"])
  assert.deepEqual(fastRemove(["a", "b"], "a"), ["b"])
  assert.equal(droppedSceneId(JSON.stringify({ type: "Scene", uuid: "Scene.abc" })), "abc")
  assert.equal(droppedSceneId(JSON.stringify({ type: "Actor", uuid: "Actor.x" })), null)
  assert.equal(droppedSceneId("not json"), null)
})
