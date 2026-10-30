// scripts/trips.js — Plan a trip: who talks to RealmScreen, and when a drop opens a card.
import { test } from "node:test"
import assert from "node:assert/strict"

// (live.js beats every 20 s: no real timers here, or Node never exits)
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
const hooks = {}
globalThis.Hooks = {
  on(name, fn) { (hooks[name] ||= []).push(fn) },
  once(name, fn) { (hooks[name] ||= []).push(fn) },
  callAll() {},
}
const settings = new Map()
const socketSent = []
let socketHandler = null
const warned = []
globalThis.game = {
  user: { id: "gm1", isGM: true, name: "GM" },
  users: { some: () => true, get: () => ({ active: true }) },
  settings: {
    register(mod, key, cfg) { if (!settings.has(key)) settings.set(key, cfg.default) },
    get(mod, key) { return settings.get(key) },
    async set(mod, key, v) { settings.set(key, v) },
  },
  socket: { emit: (ch, m) => socketSent.push(m), on: (ch, fn) => { socketHandler = fn } },
}
globalThis.ui = { notifications: { warn: (m) => warned.push(m), info() {} }, controls: { render() {} } }
globalThis.window = { addEventListener() {} }

const live = await import("../scripts/live.js")
const trips = await import("../scripts/trips.js")
for (const fn of hooks.init || []) fn()
for (const fn of hooks.ready || []) fn()
const sent = []
trips.setTripSender((m) => { sent.push(m); return true })

test("the switch: off by default; the GM turns it on", async () => {
  assert.equal(trips.planTripsOn(), false)
  await trips.setPlanTrips(true)
  assert.equal(trips.planTripsOn(), true)
})

test("the linked GM window talks to RealmScreen directly", async () => {
  live.setLinked(true)
  sent.length = 0
  // a resync from the linked window goes straight to RealmScreen
  trips.resync()
  assert.deepEqual(sent.at(-1), { type: "party.resync" })
})

test("an answer for someone else goes back over the socket; one for me is mine", () => {
  socketSent.length = 0
  const r = trips.tripAnswer({ type: "trip.answer", qid: "q1", userId: "player2", quote: { ok: true } })
  assert.equal(r.ok, true)
  assert.deepEqual(socketSent.at(-1), { t: "trip.ans", to: "player2", qid: "q1", body: { quote: { ok: true } } })
  assert.equal(trips.tripAnswer({}).ok, false, "no qid: nothing")
})

test("a player's question reaches RealmScreen through the linked window, with who asked", () => {
  sent.length = 0
  socketHandler({ t: "trip.ask", op: "quote", qid: "q2", user: "player2", payload: { sceneId: "s", key: "pc|c|arin", nx: 0.5, ny: 0.5, opts: {} } })
  assert.equal(sent.at(-1).type, "trip.quote")
  assert.equal(sent.at(-1).qid, "q2")
  assert.equal(sent.at(-1).userId, "player2")
  socketHandler({ t: "trip.resync" })
  assert.deepEqual(sent.at(-1), { type: "party.resync" })
})

test("a drop opens a card only with the switch on, for the mover, on one of RealmScreen's tokens", async () => {
  const onUpdate = hooks.updateToken.at(-1)
  const doc = { name: "Arin", x: 0, y: 0, width: 1, height: 1, getFlag: () => ({ key: "pc|c|arin" }), parent: { id: "s", dimensions: { sceneX: 0, sceneY: 0, sceneWidth: 1000, sceneHeight: 1000, size: 100 } } }
  sent.length = 0; warned.length = 0
  onUpdate(doc, { x: 500 }, {}, "someone-else")
  onUpdate(doc, { x: 500 }, { pendantPartySync: true }, "gm1")
  onUpdate({ ...doc, getFlag: () => null }, { x: 500 }, {}, "gm1")
  assert.equal(sent.length + warned.length, 0, "nothing happens for those")
  await trips.setPlanTrips(false)
  onUpdate(doc, { x: 500 }, {}, "gm1")
  assert.equal(sent.length + warned.length, 0, "switch off: a free move")
  await trips.setPlanTrips(true)
  onUpdate(doc, { x: 500 }, {}, "gm1")
  // (no ApplicationV2 under Node: the card can't open, says so and puts the token back)
  assert.equal(warned.length, 1)
  assert.deepEqual(sent.at(-1), { type: "party.resync" })
})
