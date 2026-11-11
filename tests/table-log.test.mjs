// Table log (scripts/table-log-model.js) — each player sees only their part.
import { test } from "node:test"
import assert from "node:assert/strict"
const { cleanLog, logFor, noteCommand, canUndo, chatText } = await import("../scripts/table-log-model.js")
globalThis.Hooks ??= { on() {}, once() {}, callAll() {} }
const { slicesOf } = await import("../scripts/private.js")

const log = {
  live: { campaignId: "c1", name: "Ashfall", number: 14 },
  users: ["u1", "u2"], showLog: true, justMe: true, wait: false,
  lines: [
    { id: "a", ts: 1, text: "Toll is 12 silver", who: "Nira", uid: "u1" },
    { id: "b", ts: 2, text: "my sister", who: "Brannoc", uid: "u2", just: "u2" },
    { id: "c", ts: 3, text: "waiting one", who: "Nira", uid: "u1", waiting: true },
    { id: "d", ts: 4, text: "Why the password?", who: "Brannoc", uid: "u2", kind: "question" },
  ],
}

test("an unseated player gets nothing", () => {
  assert.equal(logFor(log, "u9"), null)
})
test("nobody else's Just me or waiting lines", () => {
  assert.deepEqual(logFor(log, "u1").lines.map(l => l.id), ["a", "c", "d"])
  assert.deepEqual(logFor(log, "u2").lines.map(l => l.id), ["a", "b", "d"])
  assert.deepEqual(logFor(log, "u1").users, ["u1"])
})
test("log hidden from the table → only your own lines", () => {
  assert.deepEqual(logFor({ ...log, showLog: false }, "u2").lines.map(l => l.id), ["b", "d"])
})
test("cleaning drops junk and unknown kinds", () => {
  const c = cleanLog({ ...log, lines: [{ id: "x", text: "hi", kind: "evil", extra: 1 }, { text: "no id" }] })
  assert.equal(c.lines.length, 1)
  assert.equal(c.lines[0].kind, "note")
  assert.equal(c.lines[0].extra, undefined)
  assert.equal(cleanLog({ live: null }), null)
})
test("slices carry each player's part; the GM gets it all", () => {
  const s = slicesOf({ roster: { active: null, campaigns: [] }, pages: {}, tablelog: log }, ["u1", "u3"])
  assert.equal(s.gm.tablelog.lines.length, 4)
  assert.deepEqual(s.u1.tablelog.lines.map(l => l.id), ["a", "c", "d"])
  assert.equal(s.u3, undefined)
})
test("/note in chat", () => {
  assert.deepEqual(noteCommand("/note the toll went up"), { text: "the toll went up" })
  assert.deepEqual(noteCommand("/n hi"), { text: "hi" })
  assert.deepEqual(noteCommand("/note"), { text: "" })
  assert.equal(noteCommand("/notes are fun"), null)
  assert.equal(noteCommand("hello /note"), null)
})
test("take back: your own, ten minutes; a GM any", () => {
  assert.equal(canUndo({ uid: "u1", ts: 1000 }, "u1", false, 1000 + 9 * 60000), true)
  assert.equal(canUndo({ uid: "u1", ts: 1000 }, "u1", false, 1000 + 11 * 60000), false)
  assert.equal(canUndo({ uid: "u1", ts: 1000 }, "u2", false, 1001), false)
  assert.equal(canUndo({ uid: "u1", ts: 1000 }, "g", true, 1e12), true)
})
test("chat HTML to text", () => {
  assert.equal(chatText("<p>I <em>relocated</em> my&nbsp;knife</p>"), "I relocated my knife")
})
