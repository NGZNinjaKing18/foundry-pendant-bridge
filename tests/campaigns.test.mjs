import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { buttonFor, cleanRoster } = await import("../scripts/campaigns.js")

const roster = {
  active: null,
  campaigns: [
    { id: "a", name: "Ashfall", users: ["u1", "u2"] },
    { id: "b", name: "Bramble", users: ["u2"] },
    { id: "c", name: "Cinder", users: [] },
  ],
}

test("no session: a player sees only the campaigns they're in", () => {
  assert.deepEqual(buttonFor(roster, "u1", false).campaigns.map(c => c.id), ["a"])
  assert.deepEqual(buttonFor(roster, "u2", false).campaigns.map(c => c.id), ["a", "b"])
  assert.deepEqual(buttonFor(roster, "u9", false).campaigns, [])
})

test("no session: a GM sees every campaign", () => {
  assert.deepEqual(buttonFor(roster, "gm", true).campaigns.map(c => c.id), ["a", "b", "c"])
})

test("a session running: its players and GMs get its page, others nothing", () => {
  const live = { ...roster, active: { id: "b", name: "Bramble" } }
  assert.equal(buttonFor(live, "u2", false).kind, "page")
  assert.equal(buttonFor(live, "u2", false).campaign.id, "b")
  assert.equal(buttonFor(live, "u1", false).kind, "none")
  assert.equal(buttonFor(live, "gm", true).kind, "page")
})

test("a bad roster is cleaned, not trusted", () => {
  assert.deepEqual(cleanRoster(null), { active: null, campaigns: [] })
  assert.deepEqual(cleanRoster({ campaigns: [{ name: "no id" }, { id: "x", users: [1, "u"] }] }).campaigns,
    [{ id: "x", name: "Untitled campaign", users: ["u"] }])
  assert.equal(buttonFor(undefined, "u1", false).kind, "list")
})

const { roomFor } = await import("../scripts/scene-control.js")
test("the control column gets the room down to the Players box (else the screen), never less than a minimum", () => {
  assert.equal(roomFor(60, 700, 1000), 632)
  assert.equal(roomFor(60, NaN, 1000), 932)
  assert.equal(roomFor(60, 40, 1000), 932)      // Players box above (another layout) → the screen
  assert.equal(roomFor(600, 650, 1000), 120)
})
