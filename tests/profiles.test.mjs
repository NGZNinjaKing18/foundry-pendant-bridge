// scripts/profiles.js — the GM Character Profiles tab: search, Cover batches, and who talks to RealmScreen.
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
const socketSent = []
let socketHandler = null
const users = { gm1: { active: true, isGM: true }, player2: { active: true, isGM: false } }
globalThis.game = {
  user: { id: "gm1", isGM: true, name: "GM" },
  users: { some: () => true, get: (id) => users[id] || null },
  settings: { register() {}, get() { return false }, async set() {} },
  socket: { emit: (ch, m) => socketSent.push(m), on: (ch, fn) => { socketHandler = fn } },
}
globalThis.ui = { notifications: { warn() {}, info() {} } }
globalThis.window = { addEventListener() {} }
globalThis.foundry = {}          // no ApplicationV2 under Node: the tab isn't made, the logic still runs
globalThis.CONFIG = { ui: {} }

const live = await import("../scripts/live.js")
const prof = await import("../scripts/profiles.js")
for (const fn of hooks.init || []) fn()
for (const fn of hooks.ready || []) fn()
const sent = []
prof.setProfilesSender((m) => { sent.push(m); return true })

const rows = [
  { id: "a", name: "Anton Vélez", tags: ["noble", "Ostmark"], hasCover: true },
  { id: "b", name: "Zara", tags: ["smuggler"], hasCover: true },
  { id: "c", name: "Old Bram", tags: [], hasCover: false },
]

test("search: every word, in the name or the tags, any case, accents ignored", () => {
  assert.equal(prof.filterRows(rows, "").length, 3)
  assert.deepEqual(prof.filterRows(rows, "velez").map(r => r.id), ["a"])
  assert.deepEqual(prof.filterRows(rows, "  ANTON  noble ").map(r => r.id), ["a"])
  assert.deepEqual(prof.filterRows(rows, "smug").map(r => r.id), ["b"])
  assert.deepEqual(prof.filterRows(rows, "anton smuggler"), [])
  assert.deepEqual(prof.filterRows(null, "x"), [])
})

test("Cover squares: only rows with a Cover, none already here, in batches", () => {
  assert.deepEqual(prof.thumbBatches(rows, new Set()), [["a", "b"]])
  assert.deepEqual(prof.thumbBatches(rows, new Set(["a"])), [["b"]])
  const many = Array.from({ length: 85 }, (_, i) => ({ id: "r" + i, hasCover: true }))
  assert.deepEqual(prof.thumbBatches(many, new Set(), 40).map(b => b.length), [40, 40, 5])
})

test("not connected: a quiet line, no list", () => {
  assert.match(prof._test.listHtml(), /RealmScreen isn’t connected/)
  assert.match(prof._test.tabHtml(), /disabled/)
})

test("the linked GM window asks RealmScreen directly; the answer settles the ask", async () => {
  live.setLinked(true)
  sent.length = 0
  const p = prof._test.ask("list")
  const m = sent.at(-1)
  assert.equal(m.type, "profiles.list"); assert.equal(m.gm, true); assert.equal(m.userId, "gm1")
  prof.profilesAnswer({ type: "profiles.answer", qid: m.qid, userId: "gm1", rows })
  assert.deepEqual((await p).rows, rows)
  // an error answer rejects
  const q = prof._test.ask("send", { id: "c" })
  prof.profilesAnswer({ qid: sent.at(-1).qid, userId: "gm1", error: "Old Bram has no picture to send." })
  await assert.rejects(q, /no picture/)
})

test("an answer for another GM window goes back over the socket", () => {
  socketSent.length = 0
  assert.equal(prof.profilesAnswer({ qid: "q9", userId: "gm2", done: true, text: "Sent" }).ok, true)
  assert.deepEqual(socketSent.at(-1), { t: "profiles.ans", to: "gm2", qid: "q9", body: { done: true, text: "Sent" } })
  assert.equal(prof.profilesAnswer({}).ok, false)
})

test("asks through the socket: a GM's reaches RealmScreen, a player's is refused", () => {
  sent.length = 0; socketSent.length = 0
  socketHandler({ t: "profiles.ask", op: "send", qid: "q1", user: "gm1", payload: { id: "a", gm: true } })
  assert.equal(sent.at(-1).type, "profiles.send"); assert.equal(sent.at(-1).id, "a"); assert.equal(sent.at(-1).gm, true)
  sent.length = 0
  socketHandler({ t: "profiles.ask", op: "send", qid: "q2", user: "player2", payload: { id: "a", gm: true } })
  assert.equal(sent.length, 0, "never forwarded")
  assert.match(socketSent.at(-1).body.error, /GM only/)
})

test("a player never asks", async () => {
  const was = game.user
  game.user = { id: "player2", isGM: false }
  await assert.rejects(prof._test.ask("list"), /GM only/)
  game.user = was
})
