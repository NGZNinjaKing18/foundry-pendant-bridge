// scripts/rations.js — GM-only ration counts and "take X from everyone".
import { test } from "node:test"
import assert from "node:assert/strict"

const hooks = {}
globalThis.Hooks = { on(n, fn) { (hooks[n] ||= []).push(fn) }, once() {}, callAll() {} }
globalThis.game = { user: { isGM: true } }
globalThis.HTMLElement = class {}
const { isRation, rationStacks, rationCount, takeAmount, planTake, planRows, rationsFor } = await import("../scripts/rations.js")

const item = (id, name, quantity, type = "consumable") => ({ id, name, type, system: { quantity } })

test("rations are found by name; quantities summed; spells / containers don't count", () => {
  const items = [item("a", "Rations (1 day)", 3), item("b", "Iron Rations", 2), item("c", "Rope", 1),
    item("d", "Ration", 1), item("e", "Rations pouch", 1, "container"), item("f", "Operation", 4), item("g", "Generations", 2)]
  assert.deepEqual(rationStacks(items).map(s => s.id), ["a", "b", "d"])
  assert.equal(rationCount(items), 6)
  assert.equal(isRation(item("x", "rations", 1, "loot")), true)
  assert.equal(rationCount([]), 0)
  assert.equal(rationCount([item("z", "Rations", -2)]), 0)
})

test("what the GM types: whole numbers above 0, anything else is nothing", () => {
  assert.equal(takeAmount("3"), 3)
  assert.equal(takeAmount(" 2.9 "), 2)
  for (const v of ["", "0", "-1", "abc", null, undefined]) assert.equal(takeAmount(v), 0)
})

test("take X from each: never below 0, smallest stack first, who ran short", () => {
  const plan = planTake([
    { id: "ari", name: "Ari", stacks: [{ id: "p", qty: 5 }, { id: "s", qty: 1 }] },
    { id: "bo", name: "Bo", stacks: [] },
    { id: "cy", name: "Cy", stacks: [{ id: "q", qty: 1 }] },
    { id: "ari", name: "Ari again", stacks: [{ id: "p", qty: 5 }] },   // listed twice → once
  ], "2")
  assert.equal(plan.length, 3)
  const [ari, bo, cy] = plan
  assert.deepEqual([ari.before, ari.after, ari.took, ari.short], [6, 4, 2, 0])
  assert.deepEqual(ari.updates, [{ _id: "s", "system.quantity": 0 }, { _id: "p", "system.quantity": 4 }])
  assert.deepEqual([bo.before, bo.after, bo.short, bo.updates.length], [0, 0, 2, 0])
  assert.deepEqual([cy.after, cy.took, cy.short], [0, 1, 1])
  assert.deepEqual(cy.updates, [{ _id: "q", "system.quantity": 0 }])
})

test("taking 0 changes nothing", () => {
  const plan = planTake([{ id: "a", name: "A", stacks: [{ id: "p", qty: 3 }] }], "")
  assert.deepEqual([plan[0].after, plan[0].updates.length, plan[0].short], [3, 0, 0])
})

test("preview rows escape names and mark who runs short", () => {
  const html = planRows(planTake([{ id: "a", name: "<b>Bo</b>", stacks: [] }], 1))
  assert.match(html, /&lt;b&gt;Bo/)
  assert.match(html, /pb-rat-short/)
  assert.match(html, /short 1/)
})

test("players get no counts and no buttons", () => {
  const actor = { items: [item("a", "Rations", 4)] }
  assert.equal(rationsFor(actor), 4)
  game.user.isGM = false
  assert.equal(rationsFor(actor), null)
  // HUD hook draws nothing for a player
  const root = Object.assign(new HTMLElement(), { querySelector: () => null, append() { throw new Error("drew for a player") } })
  for (const fn of hooks.renderTokenHUD) fn({ document: { actor: { type: "group" } } }, root)
  game.user.isGM = true
})
