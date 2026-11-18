// scripts/item-panel-model.js — the Item panel's search.
import { test } from "node:test"
import assert from "node:assert/strict"
import { prepare, search, typesOf, dragData } from "../scripts/item-panel-model.js"

const rows = prepare([
  { uuid: "a", name: "Potion of Healing", type: "consumable", source: "dnd5e.items" },
  { uuid: "b", name: "Potion of Greater Healing", type: "consumable", source: "dnd5e.items" },
  { uuid: "c", name: "Healing", type: "spell", source: "world" },
  { uuid: "d", name: "Longsword", type: "weapon", source: "world" },
  { uuid: "e", name: "Épée", type: "weapon", source: "world" },
  { uuid: "", name: "no uuid" }, null,
])

test("rows without a uuid or name are dropped", () => assert.equal(rows.length, 5))

test("every word, any order; exact, then starts-with, then the rest", () => {
  assert.deepEqual(search(rows, "healing").rows.map(r => r.uuid), ["c", "b", "a"])
  assert.deepEqual(search(rows, "healing potion").rows.map(r => r.uuid), ["b", "a"])
  assert.deepEqual(search(rows, "  POTION  ").rows.map(r => r.uuid), ["b", "a"])
  assert.deepEqual(search(rows, "epee").rows.map(r => r.uuid), ["e"])    // accents ignored
  assert.equal(search(rows, "zzz").total, 0)
})

test("filters and the limit", () => {
  assert.deepEqual(search(rows, "", { source: "world", type: "weapon" }).rows.map(r => r.uuid), ["e", "d"])
  const r = search(rows, "", { limit: 2 })
  assert.equal(r.rows.length, 2)
  assert.equal(r.total, 5)
})

test("types, most common first; drag data is Foundry's standard", () => {
  assert.deepEqual(typesOf(rows), [{ type: "consumable", n: 2 }, { type: "weapon", n: 2 }, { type: "spell", n: 1 }])
  assert.deepEqual(dragData({ uuid: "Compendium.x.Item.y" }), { type: "Item", uuid: "Compendium.x.Item.y" })
})
