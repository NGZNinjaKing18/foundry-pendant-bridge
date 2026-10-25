import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { liveFrom } = await import("../scripts/live.js")

const base = { linkedHere: false, peers: new Map(), at: 100000, socketHeard: false, setting: false, isActive: () => true, anyGM: true }

test("the window holding the link is live", () => {
  assert.equal(liveFrom({ ...base, linkedHere: true }), true)
})

test("a player hears a fresh beat from a logged-in GM window", () => {
  const peers = new Map([["w1", { user: "gm", at: 90000 }]])
  assert.equal(liveFrom({ ...base, peers, socketHeard: true }), true)
})

test("a beat older than 50 s, or from a user who left, does not count", () => {
  const stale = new Map([["w1", { user: "gm", at: 40000 }]])
  assert.equal(liveFrom({ ...base, peers: stale, socketHeard: true }), false)
  const fresh = new Map([["w1", { user: "gm", at: 90000 }]])
  assert.equal(liveFrom({ ...base, peers: fresh, socketHeard: true, isActive: () => false }), false)
})

test("once the socket works the old switch is ignored", () => {
  assert.equal(liveFrom({ ...base, socketHeard: true, setting: true }), false)
})

test("before the socket is heard the old switch counts, only with a GM on", () => {
  assert.equal(liveFrom({ ...base, setting: true }), true)
  assert.equal(liveFrom({ ...base, setting: true, anyGM: false }), false)
})
