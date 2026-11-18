// scripts/clock.js — a GM's clock step from a window that isn't the one linked to RealmScreen.
import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
const hooks = {}
globalThis.Hooks = { on(n, f) { (hooks[n] ||= []).push(f) }, once(n, f) { (hooks[n] ||= []).push(f) }, callAll() {} }
const settings = new Map()
globalThis.game = {
  user: { id: "gm1", isGM: true },
  users: { some: () => true, get: (id) => ({ gm1: { isGM: true, active: true }, gm2: { isGM: true, active: true }, p1: { isGM: false, active: true } })[id] },
  settings: { register(m, k, c) { if (!settings.has(k)) settings.set(k, c.default) }, get(m, k) { return settings.get(k) }, async set(m, k, v) { settings.set(k, v) } },
  socket: { emit() {}, on() {} },
}
globalThis.ui = { notifications: { warn() {} } }
globalThis.window = { addEventListener() {} }
const live = await import("../scripts/live.js")
const clock = await import("../scripts/clock.js")
const sent = []
clock.setClockSender((m) => { sent.push(m); return true })

test("the linked window passes on another GM's step; never a player's, never when it isn't linked", () => {
  assert.equal(clock.onClockAsk({ t: "clock.ask", user: "gm2", msg: { days: 0, hours: 1 } }), false, "not linked here")
  live.setLinked(true)
  assert.equal(clock.onClockAsk({ t: "clock.ask", user: "gm2", msg: { days: 0, hours: 1 } }), true)
  assert.deepEqual(sent.at(-1), { type: "clock.step", days: 0, hours: 1 })
  assert.equal(clock.onClockAsk({ t: "clock.ask", user: "p1", msg: { days: 1, hours: 0 } }), false, "a player can't move the date")
})

test("a player may ask for Next day (next day, 6 am) — nothing else", () => {
  live.setLinked(true)
  assert.equal(clock.onClockAsk({ t: "clock.ask", user: "p1", msg: { days: 1, hours: 0, atHour: 6 } }), true)
  assert.deepEqual(sent.at(-1), { type: "clock.step", days: 1, hours: 0, atHour: 6 })
  assert.equal(clock.onClockAsk({ t: "clock.ask", user: "p1", msg: { days: 1, hours: 0, atHour: 7 } }), false)
  assert.equal(clock.onClockAsk({ t: "clock.ask", user: "p1", msg: { days: 2, hours: 0, atHour: 6 } }), false)
  assert.equal(clock.onClockAsk({ t: "clock.ask", user: "nobody", msg: { days: 1, hours: 0, atHour: 6 } }), false)
})

test("Play / Pause from another GM window is passed on; a player's never", () => {
  live.setLinked(true)
  assert.equal(clock.onClockAsk({ t: "clock.ask", user: "gm2", msg: { type: "clock.play", on: true } }), true)
  assert.deepEqual(sent.at(-1), { type: "clock.play", on: true })
  assert.equal(clock.onClockAsk({ t: "clock.ask", user: "p1", msg: { type: "clock.play", on: true } }), false)
})

test("the running clock ticks every second on screen (hh:mm:ss), 2.5 in-world s a real s", () => {
  assert.equal(clock.tickLabel(6.5), "06:30:00")
  const c = { hour: 6, rate: 2.5, hoursPerDay: 24 }
  assert.equal(clock.tickLabel(clock.tickHour(c, 0)), "06:00:00")
  assert.equal(clock.tickLabel(clock.tickHour(c, 1000)), "06:00:02")
  assert.equal(clock.tickLabel(clock.tickHour(c, 10000)), "06:00:25")
  assert.equal(clock.tickLabel(clock.tickHour(c, 600000)), "06:00:50", "never counts on past 20 s without RealmScreen")
})
