import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { barHtml, SLOT_COUNT, SLOTS, ACTS } = await import("../scripts/realm-menu.js")

test("the realm menu bar is ten boxes, no key numbers", () => {
  const html = barHtml()
  assert.equal(SLOT_COUNT, 10)
  assert.equal(html.match(/pb-realm-slot/g).length, 10)
  assert.doesNotMatch(html, /class="key"/)
})

test("boxes 1 and 2 switch the grid and the nation borders", () => {
  assert.deepEqual(SLOTS.filter(s => s.see).map(s => s.see), ["grid", "borders"])
  const html = barHtml()
  assert.equal(html.match(/pb-realm-toggle/g).length, 2)
  assert.ok(html.indexOf('data-see="grid"') < html.indexOf('data-see="borders"'))
})

test("box 3 = Next day (next day, 6 am) — GM only", () => {
  assert.deepEqual(ACTS.nextDay, { days: 1, atHour: 6 })
  assert.match(barHtml(10, true), /data-act="nextDay"/)
  assert.doesNotMatch(barHtml(10, false), /data-act/)
  assert.equal(barHtml(10, false).match(/pb-realm-slot/g).length, 10)
})
