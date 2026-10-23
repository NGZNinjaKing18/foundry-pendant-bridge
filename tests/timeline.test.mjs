// timeline.js — merging RealmScreen's chronicle into Timeline Builder's data without touching the GM's.
import { test } from "node:test"
import assert from "node:assert/strict"
import { applyTimelines, mergeTimeline, entryHash, summarize } from "../scripts/timeline.js"

const entry = (key, name, extra = {}) => {
  const e = { id: "rs_" + key, name, period: "P " + key, description: "", color: "", img: "", hidden: false, tagIds: [], sort: 0, effect: "default", ...extra }
  e.realm = { key, day: 1, hash: entryHash(e) }
  return e
}
const tl = (id, feed, entries, extra = {}) => ({ id, name: feed, visible: false, userPermissions: {}, timeframeMode: "free", autoSort: false, entries, realm: { feed, v: 1 }, ...extra })
const gmTimeline = () => ({ id: "gm1", name: "My notes", visible: true, entries: [{ id: "x", name: "Mine", period: "", sort: 0 }] })

test("a new timeline is created; the GM's own timeline is byte-identical after", () => {
  const before = [gmTimeline()]
  const snapshot = JSON.stringify(before)
  const r = applyTimelines(before, [tl("rsA", "world", [entry("a", "A"), entry("b", "B")])])
  assert.deepEqual(r.created, ["world"])
  assert.equal(JSON.stringify(before), snapshot, "input never mutated")
  assert.equal(JSON.stringify([r.data[0]]), snapshot, "the GM's timeline untouched")
  assert.deepEqual(r.data[1].entries.map(e => [e.name, e.sort]), [["A", 0], ["B", 1]])
})

test("a timeline RealmScreen synced before but the GM deleted stays deleted", () => {
  const r = applyTimelines([], [tl("rsA", "world", [entry("a", "A")])], { known: ["rsA"] })
  assert.deepEqual(r.created, [])
  assert.deepEqual(r.deletedByGm, ["world"])
  assert.equal(r.data.length, 0)
})

test("update: new entries in, gone ones out, order RealmScreen's; name, look and visibility stay the GM's", () => {
  const existing = tl("rsA", "world", [entry("a", "A"), entry("b", "B")], { name: "Renamed by GM", visible: true, lineStyle: "rough" })
  const r = applyTimelines([existing], [tl("rsA", "world", [entry("c", "C"), entry("a", "A2")])])
  const t = r.data[0]
  assert.deepEqual(r.updated, ["world"])
  assert.equal(t.name, "Renamed by GM")
  assert.equal(t.visible, true)
  assert.equal(t.lineStyle, "rough")
  assert.deepEqual(t.entries.map(e => e.name), ["C", "A2"])
  assert.deepEqual(t.entries.map(e => e.sort), [0, 1])
})

test("an entry the GM edited in Foundry is kept and reported, even when RealmScreen drops it", () => {
  const edited = entry("a", "A"); edited.description = "GM rewrote this"
  const gone = entry("b", "B"); gone.name = "GM renamed"
  const existing = tl("rsA", "world", [edited, gone])
  const r = applyTimelines([existing], [tl("rsA", "world", [entry("a", "A new words")])])
  assert.deepEqual(r.data[0].entries.map(e => e.name), ["A", "GM renamed"])
  assert.equal(r.data[0].entries[0].description, "GM rewrote this")
  assert.deepEqual(r.skipped.map(s => s.key), ["a", "b"])
})

test("Timeline Builder's display extras do not count as a GM edit", () => {
  const viewed = { ...entry("a", "A"), displayColor: "#fff", displayEffect: "none", hasMystery: false, isFilteredOut: false, tags: [], pageName: "x", sort: 9 }
  const r = applyTimelines([tl("rsA", "world", [viewed])], [tl("rsA", "world", [entry("a", "A updated")])])
  assert.deepEqual(r.skipped, [])
  assert.equal(r.data[0].entries[0].name, "A updated")
})

test("the GM's own entries in our timeline stay, right after the entry they followed", () => {
  const mine = { id: "m", name: "GM note", period: "" }
  const first = { id: "f", name: "GM first", period: "" }
  const existing = tl("rsA", "world", [first, entry("a", "A"), mine, entry("b", "B")])
  const r = mergeTimeline(existing, tl("rsA", "world", [entry("z", "Z"), entry("a", "A"), entry("b", "B")]))
  assert.deepEqual(r.timeline.entries.map(e => e.name), ["GM first", "Z", "A", "GM note", "B"])
})

test("an entry missing here (a stale Manager drag) is simply added back", () => {
  const r = applyTimelines([tl("rsA", "world", [entry("b", "B")])], [tl("rsA", "world", [entry("a", "A"), entry("b", "B")])])
  assert.deepEqual(r.data[0].entries.map(e => e.name), ["A", "B"])
  assert.deepEqual(r.skipped, [])
})

test("the date settings are forced back to free text, no auto-sort", () => {
  const existing = tl("rsA", "world", [entry("a", "A")], { timeframeMode: "date", autoSort: true })
  const t = applyTimelines([existing], [tl("rsA", "world", [entry("a", "A")])]).data[0]
  assert.equal(t.timeframeMode, "free")
  assert.equal(t.autoSort, false)
})

test("remove takes out only our timeline of that feed", () => {
  const r = applyTimelines([gmTimeline(), tl("rsA", "world", []), tl("rsB", "campaign:x", [])], [], { remove: ["world"] })
  assert.deepEqual(r.removed, ["world"])
  assert.deepEqual(r.data.map(t => t.id), ["gm1", "rsB"])
})

test("summarize lists only ours, with edited counts", () => {
  const e = entry("a", "A"); e.name = "changed"
  const s = summarize([gmTimeline(), tl("rsA", "world", [e, entry("b", "B")], { visible: true })])
  assert.deepEqual(s, [{ id: "rsA", feed: "world", name: "world", visible: true, entries: 2, edited: 1 }])
})
