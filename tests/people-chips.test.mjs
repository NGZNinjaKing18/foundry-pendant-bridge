// scripts/people-chips.js — a token hidden behind its town's number must come back as a real, visible,
// clickable token when the town opens (Foundry turns mesh.visible off on refresh while renderable is false).
import { test } from "node:test"
import assert from "node:assert/strict"

const hooks = {}
globalThis.Hooks = { on(n, fn) { (hooks[n] ||= []).push(fn) }, once() {}, callAll() {} }
globalThis.CONFIG = { Canvas: { maxZoom: 3 } }
const { _test } = await import("../scripts/people-chips.js")

// A stand-in for Foundry's Token: its own refresh does what Token#_refreshVisibility / _refreshState do.
function fakeToken(id) {
  const t = {
    id, visible: true, renderable: true, eventMode: "static", mesh: { renderable: true, visible: true },
    refresh() {   // Foundry's refresh, then the refreshToken hook (as applyRenderFlags does)
      t.mesh.visible = t.visible && t.renderable
      t.eventMode = "static"
      for (const fn of hooks.refreshToken || []) fn(t)
    },
    renderFlags: { set(f) { if (f.refreshVisibility || f.refreshState) t.refresh() } },
  }
  return t
}

test("hidden at a town, then the town opens: the real token is visible and clickable again", () => {
  const t = fakeToken("a")
  _test.show(t, false)
  t.refresh()                                       // Foundry refreshes it while hidden (a move, a hover, a light change)
  assert.equal(t.mesh.visible, false); assert.equal(t.eventMode, "none"); assert.equal(t.renderable, false)
  _test.show(t, true)
  assert.equal(t.renderable, true); assert.equal(t.mesh.renderable, true)
  assert.equal(t.mesh.visible, true)               // the bug: this stayed false, so the people vanished
  assert.equal(t.eventMode, "static")
  t.refresh()                                       // and stays shown through later refreshes
  assert.equal(t.mesh.visible, true)
})

test("a token a player can't see stays unseen when shown", () => {
  const t = fakeToken("b"); t.visible = false
  _test.show(t, false); _test.show(t, true)
  assert.equal(t.mesh.visible, false)
})
