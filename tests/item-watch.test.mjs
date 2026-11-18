// scripts/item-watch-model.js — item change windows: imports vs things handed out.
import { test } from "node:test"
import assert from "node:assert/strict"
import { makeWatch, isImport, itemsIn, mainUser, handoutMessage, isDdbItem } from "../scripts/item-watch-model.js"

function clock() {
  let t = 0, seq = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id },
    clearTimer: (id) => timers.delete(id),
    advance(ms) { t += ms; for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); x.fn() } },
  }
}
const item = (name, type = "consumable", extra = {}) => ({ name, type, img: "i.png", uuid: `Actor.a.Item.${name}`, qty: 1, container: null, ...extra })
const win = (o = {}) => ({ actorId: "a", creates: [], deletes: [], updates: [], actorDdb: false, itemsReplaced: false, ...o })

test("a window closes after a quiet spell, once, with everything in it", () => {
  const c = clock(), closed = []
  const w = makeWatch({ quietMs: 4000, ...c, onClose: (x) => closed.push(x) })
  w.record("a", { kind: "create", id: "1", user: "u", item: item("Rope", "loot") })
  c.advance(3000)
  w.record("a", { kind: "create", id: "2", user: "u", item: item("Torch", "loot") })
  c.advance(3999)
  assert.equal(closed.length, 0)
  c.advance(1)
  assert.equal(closed.length, 1)
  assert.deepEqual(closed[0].creates.map(x => x.id), ["1", "2"])
  w.record("b", { kind: "delete", id: "3", user: "u" })
  c.advance(5000)
  assert.equal(closed.length, 2)
  assert.equal(closed[1].actorId, "b")
})

test("D&D Beyond import: 5+ ddb items, or actor ddb flags with one; bulk only when asked", () => {
  const five = win({ creates: [1, 2, 3, 4, 5].map(i => ({ id: String(i), ddb: true })) })
  assert.equal(isImport(five), true)
  const four = win({ creates: [1, 2, 3, 4].map(i => ({ id: String(i), ddb: true })) })
  assert.equal(isImport(four), false)
  assert.equal(isImport({ ...four, actorDdb: true }), true)
  // the same ddb item updated many times (arrows fired) is one item
  assert.equal(isImport(win({ updates: Array(9).fill({ id: "arrows", ddb: true }) })), false)
  // our own restores never count
  assert.equal(isImport(win({ creates: [1, 2, 3, 4, 5].map(i => ({ id: String(i), ddb: true, skip: true })) })), false)
  const many = win({ creates: Array.from({ length: 15 }, (_, i) => ({ id: "x" + i })) })
  assert.equal(isImport(many), false)
  assert.equal(isImport(many, { bulk: 15 }), true)
  assert.equal(isImport(win({ itemsReplaced: true })), true)
})

test("what came in: physical items; a pack is one thing with its contents; deleted again = nothing", () => {
  const w = win({
    creates: [
      { id: "p", user: "gm", item: item("Explorer's Pack", "container") },
      { id: "r", user: "gm", item: item("Rations", "consumable", { container: "p", qty: 10 }) },
      { id: "t", user: "gm", item: item("Torch", "consumable", { container: "p" }) },
      { id: "s", user: "gm", item: item("Second Wind", "feat") },
      { id: "x", user: "gm", item: item("Oops", "loot") },
      { id: "k", user: "gm", item: item("Key", "loot"), skip: true },
    ],
    deletes: [{ id: "x" }],
  })
  const got = itemsIn(w)
  assert.deepEqual(got.map(g => g.name), ["Explorer's Pack"])
  assert.deepEqual(got[0].inside, ["Rations", "Torch"])
})

test("a stack that grew counts (when allowed), summed per item", () => {
  const w = win({ updates: [
    { id: "pot", user: "gm", gain: 1, item: item("Potion of Healing") },
    { id: "pot", user: "gm", gain: 2, item: item("Potion of Healing") },
    { id: "arr", user: "pl", gain: 5, item: item("Arrows") },
    { id: "rat", user: "gm", gain: -1, item: item("Rations") },
  ] })
  const got = itemsIn(w, { gainOk: (c) => c.user === "gm" })
  assert.deepEqual(got.map(g => [g.name, g.qty, g.stacked]), [["Potion of Healing", 3, true]])
  assert.equal(itemsIn(w).length, 2)
})

test("who acted; ddb flag; the message RealmScreen gets", () => {
  assert.equal(mainUser(win({ creates: [{ id: 1, user: "a" }, { id: 2, user: "b" }, { id: 3, user: "b" }] })), "b")
  assert.equal(isDdbItem({ flags: { ddbimporter: { id: 1 } } }), true)
  assert.equal(isDdbItem({ flags: {} }), false)
  const m = handoutMessage({
    item: { id: "abc123", name: "Potion", uuid: "Actor.a.Item.abc123", img: "p.png", type: "consumable", qty: 2, source: "Compendium.dnd5e.items.Item.x", inside: ["  "] },
    actor: { id: "a", uuid: "Actor.a", name: "Hilde", img: "h.png" },
    by: { userId: "g", name: "GM", isGM: true }, campaignId: "c1", session: 4, at: 1000,
  })
  assert.equal(m.type, "item.handout")
  assert.deepEqual(m.item, { name: "Potion", uuid: "Actor.a.Item.abc123", img: "p.png", type: "consumable", qty: 2, source: "Compendium.dnd5e.items.Item.x" })
  assert.deepEqual(m.actor, { id: "a", uuid: "Actor.a", name: "Hilde", img: "h.png" })
  assert.equal(m.campaignId, "c1"); assert.equal(m.session, 4); assert.equal(m.by.isGM, true)
  assert.equal(handoutMessage({ item: null, actor: {} }), null)
})
