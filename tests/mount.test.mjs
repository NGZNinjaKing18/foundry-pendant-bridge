// scripts/mount-model.js — our Mount / Vehicle actor type: carry limits, tack → bags, packing, moving stacks.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  KINDS, SLOTS, tackOf, carryMax, bagsOf, packBags, hexLayout, planMove, planEquip, planTackUp, mayRelay,
  ownershipFor, kindSystem, abilityMod, sizeUp, totalWeight, spacesByWeight, MOUNT_TYPE,
} from "../scripts/mount-model.js"

test("the type name is the module-prefixed one Foundry gives a module sub-type", () => {
  assert.equal(MOUNT_TYPE, "pendant-bridge.mount")
})

test("5e carry limits: Str × 15 × size; Beast of Burden counts a size up; drawn = 5 × what pulls it", () => {
  assert.equal(carryMax({ kind: "ridingHorse", str: 16, size: "lg" }).max, 480)
  assert.equal(carryMax({ kind: "warhorse", str: 18, size: "lg" }).max, 540)
  assert.equal(carryMax({ kind: "pony", str: 15, size: "med" }).max, 225)
  assert.equal(carryMax({ kind: "mule", str: 14, size: "med" }).max, 420)            // Beast of Burden → Large
  assert.match(carryMax({ kind: "mule", str: 14, size: "med" }).rule, /Beast of Burden/)
  assert.equal(carryMax({ kind: "elephant", str: 22, size: "huge" }).max, 1320)
  assert.equal(carryMax({ kind: "cart", pullerMaxes: [480] }).max, 2400)
  assert.equal(carryMax({ kind: "wagon", pullerMaxes: [540, 540] }).max, 5400)
  assert.equal(carryMax({ kind: "cart", pullerMaxes: [] }).max, 0)
  assert.equal(carryMax({ kind: "rowboat" }).max, 1000)
  assert.equal(carryMax({ kind: "ridingHorse", str: 16, size: "lg", override: 300 }).max, 300)   // hand-set wins
  assert.equal(carryMax({ kind: "ridingHorse", str: 16, size: "lg", override: "" }).max, 480)
})

test("sizes step up and ability mods follow 5e", () => {
  assert.equal(sizeUp("med"), "lg"); assert.equal(sizeUp("grg"), "grg")
  assert.equal(abilityMod(16), 3); assert.equal(abilityMod(9), -1); assert.equal(abilityMod(10), 0)
})

test("tack is recognised by dnd5e's own names; saddlebags aren't a saddle; a flag wins", () => {
  assert.deepEqual(tackOf({ name: "Saddlebags" }).fits, ["flanks"])
  assert.equal(tackOf({ name: "Saddlebags" }).bags.length, 2)
  assert.deepEqual(tackOf({ name: "Saddle, Riding" }).fits, ["back"])
  assert.equal(tackOf({ name: "Saddle, Riding" }).rider, true)
  assert.deepEqual(tackOf({ name: "Saddle, Pack" }).bags.map(b => b[1]), ["Pack Frame"])
  assert.deepEqual(tackOf({ name: "Bit and bridle" }).fits, ["head"])
  assert.deepEqual(tackOf({ name: "Chain Mail Barding" }).fits, ["body"])
  assert.deepEqual(tackOf({ name: "Side Harness" }).fits, ["lside", "rside"])
  assert.equal(tackOf({ name: "Large Saddlebags" }).bags[0][2], 12)
  assert.equal(tackOf({ name: "Rope, Hempen" }), null)
  assert.equal(tackOf({ name: "Longsword" }), null)
  const custom = tackOf({ name: "Odd Thing", flags: { "pendant-bridge": { tack: { fits: ["rear", "nope"], bags: [["x", "Net", 3]] } } } })
  assert.deepEqual(custom.fits, ["rear"]); assert.equal(custom.bags[0][1], "Net")
})

const horseItems = () => [
  { id: "bridle", name: "Bit and Bridle", slot: "head" },
  { id: "saddle", name: "Saddle, Riding", slot: "back" },
  { id: "bags", name: "Saddlebags", slot: "flanks" },
  { id: "pann", name: "Panniers", slot: null },
  { id: "sideL", name: "Side Harness", slot: "lside" },
]

test("bags come only from tack that is ON; carts have their bed", () => {
  const b = bagsOf("ridingHorse", horseItems())
  assert.deepEqual(b.map(x => x.label), ["Left Saddlebag", "Right Saddlebag", "Left Side Harness"])
  assert.equal(b.find(x => x.label === "Left Side Harness").longOnly, true)
  assert.equal(b[0].where, "on Flanks")
  assert.deepEqual(bagsOf("ridingHorse", horseItems().map(i => ({ ...i, slot: null }))), [])
  // tack on a slot it doesn't fit gives nothing
  assert.deepEqual(bagsOf("ridingHorse", [{ id: "s", name: "Saddlebags", slot: "head" }]), [])
  assert.deepEqual(bagsOf("cart", []).map(x => [x.label, x.cap]), [["Cart Bed", 100]])
})

test("packing: pins first, biggest first, long-only bags take only long things, overflow is 'not packed'", () => {
  const bags = bagsOf("ridingHorse", horseItems())   // L8, R8, side 4 (long)
  const units = [{ id: "tent", spaces: 4 }, { id: "feed", spaces: 6 }, { id: "rations", spaces: 2 }, { id: "spear", spaces: 2, long: true }, { id: "anvil", spaces: 9 }]
  const r = packBags(bags, units, { rations: "bags:R" })
  assert.equal(r.where.rations, "bags:R")
  assert.equal(r.where.spear, "sideL:side")              // long → the long-only bag first
  assert.equal(r.where.feed, "bags:L")
  assert.equal(r.where.tent, "bags:R")
  assert.deepEqual(r.notPacked.map(u => u.id), ["anvil"])
  assert.equal(r.bags.find(b => b.id === "bags:R").used, 6)
  // a pin to a bag that can't take it falls back to normal packing
  const r2 = packBags(bags, [{ id: "tent", spaces: 4 }], { tent: "sideL:side" })
  assert.equal(r2.where.tent, "bags:L")
})

test("hex layout fits every item in a 4-row column-major grid", () => {
  const lay = hexLayout(8, [{ id: "a", spaces: 4 }, { id: "b", spaces: 2 }, { id: "c", spaces: 1 }])
  assert.equal(lay.cols, 2); assert.equal(lay.rows, 4)
  const all = lay.cells.flatMap(([, cs]) => cs.map(c => c.join(",")))
  assert.equal(new Set(all).size, all.length)            // no overlaps
  assert.equal(all.length, 7)
  assert.ok(all.every(k => { const [c, r] = k.split(",").map(Number); return c < 2 && r < 4 }))
})

test("moving a stack: takes n, leaves the rest, merges same name + type; tack never merges", () => {
  const target = [{ id: "t1", name: "Rations (1 day)", type: "consumable", qty: 4 }, { id: "t2", name: "Saddlebags", type: "container", qty: 1, tack: true }]
  assert.deepEqual(planMove({ id: "s", name: "rations (1 day)", type: "consumable", qty: 10 }, target, 6), { n: 6, sourceLeft: 4, mergeInto: "t1" })
  assert.deepEqual(planMove({ id: "s", name: "Rations (1 day)", type: "loot", qty: 10 }, target, 99), { n: 10, sourceLeft: 0, mergeInto: null })
  assert.deepEqual(planMove({ id: "s", name: "Saddlebags", type: "container", qty: 1, tack: true }, target, 1), { n: 1, sourceLeft: 0, mergeInto: null })
  assert.equal(planMove({ id: "s", name: "Torch", type: "consumable", qty: 5 }, [], 0).n, 5)   // no number → all
})

test("putting tack on: right slot only; it swaps off whatever was there", () => {
  const items = horseItems()
  assert.deepEqual(planEquip({ id: "pann", name: "Panniers" }, "flanks", items), { ok: true, off: ["bags"], why: "" })
  assert.equal(planEquip({ id: "pann", name: "Panniers" }, "head", items).ok, false)
  assert.match(planEquip({ id: "pann", name: "Panniers" }, "head", items).why, /Flanks/)
  assert.match(planEquip({ id: "x", name: "Rope" }, "head", items).why, /isn't tack/)
})

test("tack up puts each carried piece on its first free slot", () => {
  const items = [{ id: "a", name: "Side Harness", slot: "lside" }, { id: "b", name: "Side Harness", slot: null }, { id: "c", name: "Bedroll Straps", slot: null }, { id: "d", name: "Rope", slot: null }]
  assert.deepEqual(planTackUp(items), { b: "rside", c: "rear" })
})

test("GM relay: your character ↔ a mount you can see, nothing else", () => {
  const me = { isMount: false, userLevel: 3 }, myHorse = { isMount: true, userLevel: 3 }, seenWagon = { isMount: true, userLevel: 2 }
  const hidden = { isMount: true, userLevel: 1 }, otherPC = { isMount: false, userLevel: 2 }
  assert.equal(mayRelay(me, seenWagon), true)
  assert.equal(mayRelay(seenWagon, me), true)
  assert.equal(mayRelay(me, hidden), false)
  assert.equal(mayRelay(me, otherPC), false)
  assert.equal(mayRelay({ isMount: false, userLevel: 2 }, myHorse), false)  // can't put things on someone else's character
})

test("ownership: the owner character's players own the mount; old grants we made are removed, others kept", () => {
  assert.deepEqual(ownershipFor({ default: 0, gm: 3, u1: 3 }, ["u1"], ["u2"]), { default: 0, gm: 3, u2: 3 })
  assert.deepEqual(ownershipFor({ default: 2, u1: 3 }, [], ["u1"]), { default: 2, u1: 3 })
  assert.deepEqual(ownershipFor({ u9: 2 }, ["u9"], []), { u9: 2 })     // only OWNER grants are ours to take back
})

test("Start from a 5e kind fills stats, attacks and storage", () => {
  const s = kindSystem("warhorse")
  assert.equal(s.abilities.str.value, 18); assert.equal(s.attributes.hp.max, 19); assert.equal(s.attributes.movement.walk, 60)
  assert.deepEqual(s.attacks[0], { name: "Hooves", toHit: "+6", damage: "2d6 + 4", type: "bludgeoning" })
  assert.equal(kindSystem("cart").attacks.length, 0)
  assert.equal(kindSystem("nope").kind, "ridingHorse")
  for (const k of Object.keys(KINDS)) assert.ok(KINDS[k].tack || KINDS[k].bins, k + " has tack or built-in storage")
  for (const k of Object.keys(SLOTS)) assert.equal(SLOTS[k].length, 4)
})

test("weights and fallback spaces", () => {
  assert.equal(totalWeight([{ weight: 2, qty: 10 }, { weight: 25, qty: 1 }]), 45)
  assert.equal(spacesByWeight(2, 10), 4); assert.equal(spacesByWeight(0, 1), 1)
})
