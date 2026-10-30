import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { rosterFor, pageFor, slicesOf } = await import("../scripts/private.js")

const roster = {
  active: { id: "b", name: "Bramble" },
  campaigns: [{ id: "a", name: "Ashfall", users: ["u1", "u2"] }, { id: "b", name: "Bramble", users: ["u3"] }],
}
const page = {
  users: ["u1", "u2"],
  overview: { name: "Ashfall", people: [{ id: "p1", name: "Dorn" }, { id: "p2", name: "Aske", hidden: true, manual: true }] },
  secrets: [
    { id: "s1", state: "given", to: ["u1"], toNames: { u1: "Velora" }, seen: ["u1"], shown: [], when: { kind: "now" }, how: "quiet" },
    { id: "s2", state: "given", to: ["u2"], toNames: { u2: "Brom" }, seen: ["u2"], shown: [] },
    { id: "s3", state: "waiting", to: ["u1"], toNames: {}, seen: [], shown: [] },
    { id: "s4", state: "given", to: ["u2"], toNames: { u2: "Brom" }, seen: ["u2"], shown: [{ id: "u2", name: "Brom" }] },
  ],
  asks: [{ id: "q1", from: "u2", text: "Is Dorn lying?" }],
  goals: [{ id: "g1", text: "Deliver the seal" }],
  finds: [{ id: "f1", name: "Seal" }, { id: "f2", name: "Key", hidden: true }],
  peoplePrefs: { hidden: ["p2"], pinned: ["p1"], notes: { p2: "GM note" }, recent: true },
  group: { actorId: "G", name: "Company", users: ["u1", "u2"], members: [{ id: "A1", name: "Doril" }] },
}

test("a player's roster: only their campaigns; another campaign's running session is just 'something else'", () => {
  assert.deepEqual(rosterFor(roster, "u1"), { active: { id: "_other", name: "" }, campaigns: [{ id: "a", name: "Ashfall", users: ["u1"] }] })
  assert.deepEqual(rosterFor(roster, "u3").active, { id: "b", name: "Bramble" })
  assert.deepEqual(rosterFor(roster, "u9"), { active: { id: "_other", name: "" }, campaigns: [] })
})

test("a player's page: their secrets + party-known ones, nothing waiting, no asks, no hidden finds/people, no GM prefs", () => {
  const p = pageFor(page, "u1")
  assert.deepEqual(p.secrets.map(s => s.id), ["s1", "s4"])
  assert.deepEqual(p.secrets[1].to, [])                  // shown to the party: who it was given to isn't theirs
  assert.equal(p.secrets[0].when, undefined)
  assert.deepEqual(p.asks, [])
  assert.deepEqual(p.finds.map(f => f.id), ["f1"])
  assert.deepEqual(p.overview.people, [{ id: "p1", name: "Dorn" }])
  assert.deepEqual(p.peoplePrefs, { hidden: [], pinned: [], notes: {}, recent: true })
  assert.deepEqual(p.group, { actorId: "G", name: "Company" })
  assert.deepEqual(p.users, ["u1"])
  assert.equal(pageFor(page, "u3"), null)               // not in the campaign → nothing
})

test("slices: the GM gets everything, each player only theirs, nobody else a slice", () => {
  const s = slicesOf({ roster, pages: { a: page } }, ["u1", "u2", "u3", "u9"])
  assert.deepEqual(Object.keys(s).sort(), ["gm", "u1", "u2", "u3", "u9"])
  assert.equal(s.gm.pages.a.asks.length, 1)
  assert.deepEqual(Object.keys(s.u3.pages), [])             // in Bramble (roster) but Ashfall's page isn't theirs
  assert.deepEqual(s.u2.pages.a.secrets.map(x => x.id), ["s2", "s4"])
  const none = slicesOf({ roster: { active: null, campaigns: [] }, pages: {} }, ["u9"])
  assert.deepEqual(Object.keys(none), ["gm"])
})
