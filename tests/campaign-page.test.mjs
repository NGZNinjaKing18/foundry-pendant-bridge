import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { visibleSecrets, unseenFor, noteViewers, whoLine } = await import("../scripts/campaign-page.js")

const page = {
  users: ["u1", "u2", "u3"],
  secrets: [
    { id: "a", state: "given", to: ["u1"], seen: [], shown: [] },
    { id: "b", state: "given", to: ["u2"], seen: ["u2"], shown: [{ id: "u2", name: "Brom" }] },
    { id: "c", state: "waiting", to: ["u1"], seen: [], shown: [] },
    { id: "d", state: "given", to: ["u3"], seen: [], shown: [], revealed: true },
  ],
}

test("a player sees what was given to them, plus what was shown or revealed to the party", () => {
  assert.deepEqual(visibleSecrets(page, "u1", false).map(s => s.id), ["a", "b", "d"])
  assert.deepEqual(visibleSecrets(page, "u9", false).map(s => s.id), [])      // not in the campaign
  assert.equal(visibleSecrets(page, "gm", true).length, 4)                     // GMs see all, waiting too
})

test("unseen = visible and not opened yet", () => {
  assert.deepEqual(unseenFor(page, "u2").map(s => s.id), ["d"])
  assert.deepEqual(unseenFor(page, "u1").map(s => s.id), ["a", "b", "d"])
})

test("a place note is owned by who knows it; nobody before it's given", () => {
  assert.deepEqual(noteViewers(page.secrets[0], page.users), ["u1"])
  assert.deepEqual(noteViewers(page.secrets[1], page.users).sort(), ["u1", "u2", "u3"])
  assert.deepEqual(noteViewers(page.secrets[2], page.users), [])
})

test("who-knows line", () => {
  const nm = (id) => ({ u1: "Velora", u2: "Brom" }[id])
  assert.equal(whoLine({ to: ["u1"], shown: [] }, "u1", nm), "Only you know this")
  assert.equal(whoLine({ to: ["u1", "u2"], shown: [] }, "u1", nm), "You and Brom know this")
  assert.equal(whoLine(page.secrets[1], "u1", nm), "Brom showed this to the party")
  assert.equal(whoLine(page.secrets[3], "u1", nm), "Revealed to the party")
})
