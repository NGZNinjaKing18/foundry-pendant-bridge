import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { barHtml, SLOT_COUNT, SLOTS, ACTS, confirmAct } = await import("../scripts/realm-menu.js")

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

test("box 3 = Next day (next day, 6 am) — GM and players alike", () => {
  assert.deepEqual(ACTS.nextDay, { days: 1, hours: 0, atHour: 6 })
  assert.match(barHtml(10, true), /data-act="nextDay"/)
  assert.match(barHtml(10, false), /data-act="nextDay"/)
  assert.equal(barHtml(10, false).match(/pb-realm-slot/g).length, 10)
})

test("a player is asked first; the GM isn't", async () => {
  let asked = 0, answer = false
  globalThis.foundry = { applications: { api: { DialogV2: { confirm: async () => { asked++; return answer } } } } }
  assert.equal(await confirmAct("nextDay", true), true)
  assert.equal(asked, 0)
  assert.equal(await confirmAct("nextDay", false), false, "Cancel = nothing moves")
  answer = true
  assert.equal(await confirmAct("nextDay", false), true)
  assert.equal(asked, 2)
})

test("Play / Pause is a GM box; players never get it", () => {
  assert.match(barHtml(10, true), /data-act="play"/)
  assert.doesNotMatch(barHtml(10, false), /data-act="play"/)
})
