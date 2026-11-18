// scripts/albuna-model.js — Albuna coins: 100 bronze = 1 silver, 25 silver = 1 gold.
import { test } from "node:test"
import assert from "node:assert/strict"
import { toBronze, fromBronze, convertUpdate, isAlbuna, coin, purseText, RATES } from "../scripts/albuna-model.js"

test("rates: 1 silver = 100 bronze, 1 gold = 25 silver = 2500 bronze", () => {
  assert.equal(RATES.sp, 100)
  assert.equal(RATES.gp, 25 * RATES.sp)
  assert.equal(toBronze({ gp: 1 }), 2500)
  assert.equal(toBronze({ gp: 2, sp: 3, cp: 7 }), 5307)
})

test("bronze → fewest coins, and back", () => {
  assert.deepEqual(fromBronze(2500), { gp: 1, sp: 0, cp: 0 })
  assert.deepEqual(fromBronze(2599), { gp: 1, sp: 0, cp: 99 })
  assert.deepEqual(fromBronze(2600), { gp: 1, sp: 1, cp: 0 })
  assert.deepEqual(fromBronze(0), { gp: 0, sp: 0, cp: 0 })
  for (const n of [1, 99, 100, 2499, 123456]) assert.equal(toBronze(fromBronze(n)), n)
})

test("junk values count as 0 (never negative, never fractions)", () => {
  assert.equal(toBronze({ gp: -3, sp: "abc", cp: 2.9 }), 2)
  assert.deepEqual(fromBronze(-5), { gp: 0, sp: 0, cp: 0 })
})

test("convert changes only gp/sp/cp; pp and ep are never touched", () => {
  const upd = convertUpdate({ pp: 4, ep: 7, gp: 0, sp: 30, cp: 250 })
  assert.deepEqual(upd, { "system.currency.gp": 1, "system.currency.sp": 7, "system.currency.cp": 50 })
  assert.equal(Object.keys(upd).some(k => /\.(pp|ep)$/.test(k)), false)
  assert.equal(convertUpdate({ gp: 1, sp: 24, cp: 99 }), null)   // already the fewest coins
})

test("the switch is a per-actor flag; coin names", () => {
  assert.equal(isAlbuna({ flags: { "pendant-bridge": { currency: "albuna" } } }), true)
  assert.equal(isAlbuna({ flags: {} }), false)
  assert.equal(isAlbuna({ getFlag: (m, k) => (m === "pendant-bridge" && k === "currency" ? "albuna" : null) }), true)
  assert.equal(isAlbuna(null), false)
  assert.equal(coin("cp").label, "Bronze")
  assert.equal(coin("pp"), null)
  assert.equal(purseText({ gp: 2, cp: 5 }), "2 gold, 5 bronze")
  assert.equal(purseText({}), "no coins")
})
