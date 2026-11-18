// scripts/ration-guard-model.js — a D&D Beyond re-import leaves rations exactly as they were.
import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
globalThis.game = { user: { isGM: true } }
globalThis.HTMLElement = class {}
const { isRation } = await import("../scripts/rations.js")
const { snapshotRations, planRestore, sameRations } = await import("../scripts/ration-guard-model.js")

const it = (id, name, quantity, extra = {}) => ({ id, name, type: "consumable", system: { quantity, ...(extra.system || {}) }, flags: extra.flags || {} })

test("snapshot keeps every ration stack with its full data", () => {
  const s = snapshotRations([it("r1", "Rations (1 day)", 4), it("x", "Rope", 1), it("r2", "Iron Rations", 2)], isRation)
  assert.deepEqual(s.map(x => [x.id, x.qty]), [["r1", 4], ["r2", 2]])
  assert.equal(s[0].data.name, "Rations (1 day)")
  assert.equal(sameRations(s, snapshotRations([it("r2", "Iron Rations", 2), it("r1", "Rations", 4)], isRation)), true)
  assert.equal(sameRations(s, snapshotRations([it("r1", "Rations", 5), it("r2", "Iron Rations", 2)], isRation)), false)
})

test("import changed quantities, removed one, added one → all put back; nothing else touched", () => {
  const before = snapshotRations([it("r1", "Rations (1 day)", 4), it("r2", "Iron Rations", 2, { system: { container: "bag" } })], isRation)
  const after = [it("r1", "Rations (1 day)", 10), it("new", "Rations", 5, { flags: { ddbimporter: {} } }), it("sw", "Longsword", 1)]
  const p = planRestore(before, after, isRation)
  assert.deepEqual(p.deletes, ["new"])
  assert.deepEqual(p.updates, [{ _id: "r1", "system.quantity": 4 }])
  assert.equal(p.creates.length, 1)
  assert.equal(p.creates[0]._id, "r2")
  assert.equal(p.creates[0].system.quantity, 2)
  assert.equal(p.creates[0].system.container, null)          // its bag is gone → loose, not lost
  assert.equal(p.changed, true)
})

test("a ration whose bag survived goes back in the bag", () => {
  const before = snapshotRations([it("r2", "Rations", 2, { system: { container: "bag" } })], isRation)
  const p = planRestore(before, [{ id: "bag", name: "Backpack", type: "container", system: {} }], isRation)
  assert.equal(p.creates[0].system.container, "bag")
})

test("nothing changed → nothing to do; no rations before → the import's rations go", () => {
  const items = [it("r1", "Rations", 3)]
  assert.equal(planRestore(snapshotRations(items, isRation), items, isRation).changed, false)
  const p = planRestore([], [it("r9", "Rations", 3), it("s", "Shield", 1)], isRation)
  assert.deepEqual(p.deletes, ["r9"])
  assert.equal(p.updates.length + p.creates.length, 0)
})

test("the import renamed a ration (same id) → name and quantity set back", () => {
  const before = snapshotRations([it("r1", "Rations", 3)], isRation)
  const p = planRestore(before, [it("r1", "Trail food", 7)], isRation)
  assert.deepEqual(p.updates, [{ _id: "r1", name: "Rations", "system.quantity": 3 }])
})
