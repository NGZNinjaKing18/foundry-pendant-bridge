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

test("a grid of people on open ground is always their tokens, never a number", () => {
  const { S, retarget } = _test
  S.root = {}
  globalThis.canvas = { scene: { dimensions: {}, getFlag: () => null }, stage: { scale: { x: 0.01 }, pivot: { x: 0, y: 0 } } }
  S.spots.clear()
  S.spots.set("g", { spot: { key: "g", grid: true }, grid: true, n: 3, t: 1, target: 1, tokens: [], sx: 0, sy: 0 })
  S.spots.set("town", { spot: { key: "town" }, n: 3, t: 0, target: 0, tokens: [], sx: 0, sy: 0 })
  try { retarget() } catch { /* paint needs a canvas */ }
  assert.equal(S.spots.get("g").target, 1)
  assert.equal(S.spots.get("town").target, 0, "a town still shows its number when zoomed out")
  S.spots.clear(); S.root = null; delete globalThis.canvas
})

// A tiny PIXI stand-in: enough for rebuild() to make numbers and glide copies.
class Obj { constructor() { this.children = []; this.position = { set() {} }; this.scale = { set() {} }; this.anchor = { set() {} } } addChild(c) { this.children.push(c); c.parent = this; return c } destroy() { this.destroyed = true } }
class Gfx extends Obj { lineStyle() { return this } beginFill() { return this } drawCircle() { return this } endFill() { return this } }
function stage({ tokens, scale = 0.01 }) {
  globalThis.PIXI = { Container: Obj, Graphics: Gfx, Text: Obj, TextStyle: class {}, Sprite: class extends Obj { constructor(tex) { super(); this.texture = tex } } }
  globalThis.game = { user: { isGM: true } }
  const primary = new Obj()
  globalThis.canvas = {
    primary, dimensions: { sceneX: 0, sceneY: 0, sceneWidth: 1200, sceneHeight: 800 },
    scene: { dimensions: { sceneWidth: 1200 }, getFlag: () => null },
    stage: { scale: { x: scale }, pivot: { x: 600, y: 400 } },
    tokens: { placeables: tokens }, app: { ticker: { add() {}, remove() {} } },
  }
  _test.S.root = null; _test.S.spots.clear(); _test.S.hidden.clear()
}
const partyTok = (id, { group = false, people = 1, key = "town" } = {}) => {
  const t = fakeToken(id)
  t.center = { x: 600, y: 400 }; t.w = t.h = 10
  t.mesh.texture = { valid: true, baseTexture: {} }
  t.actor = group ? { type: "group" } : { type: "npc" }
  t.document = { hidden: false, getFlag: () => ({ spot: { key, nx: 0.5, ny: 0.5 }, people }) }
  return t
}

test("a party's Group token (one actor, 5 people) is always that token, never a 5", () => {
  const g = partyTok("grp", { group: true, people: 5 })
  stage({ tokens: [g] })
  _test.rebuild()
  const s = _test.S.spots.get("town")
  assert.equal(s.n, 5)
  assert.equal(s.grid, true)
  assert.equal(s.target, 1)
  assert.equal(g.renderable, true, "the group token stays drawn")
})

test("the zoom animation never throws into Foundry's render loop (a dead picture just isn't glided)", () => {
  const a = partyTok("a"), b = partyTok("b")
  stage({ tokens: [a, b], scale: 5 })                  // zoomed in: the town spreads
  _test.rebuild()
  const s = _test.S.spots.get("town")
  assert.equal(s.target, 1)
  a.mesh.texture.baseTexture.destroyed = true        // Foundry redrew the token: its old picture is gone
  s.t = 0.5
  assert.doesNotThrow(() => _test.paint())
  s.ghosts.items.forEach(it => { it.sp.position = null })   // even a copy PIXI already tore down
  assert.doesNotThrow(() => _test.tick())
  delete globalThis.canvas; delete globalThis.PIXI; delete globalThis.game
})
