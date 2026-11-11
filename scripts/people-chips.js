// ──────────────────────────────────────────────────────────────
// RealmScreen's people as NUMBERS (pendant-home worldmap/PeopleLayer.jsx; the user, 2026-11-11: "do the
// sizing, and the going into numbers when at settlements … for Foundry").
//
// party.js places everyone's token (about a road's width, on an arc above their town) and flags the spot
// it belongs to: flags[MOD].party = { key, spot: { key, road, nx, ny }, people }. Here, on EACH viewer's
// own canvas (nothing is written):
//   • every spot is one round number — how many people there that THIS viewer may see — and its tokens
//     are not drawn; the number is part of the map (it grows and shrinks with it, like the roads)
//   • only at Foundry's max zoom, the ONE town nearest the middle of the screen shows its tokens instead
//     (people out on the road never do — RealmScreen's rule)
//   • click a number: the view zooms all the way in on that town, which spreads it
// Tokens without a spot (an older RealmScreen) are left alone.
// ──────────────────────────────────────────────────────────────
import { unitPx } from "./party.js"

const MOD = "pendant-bridge"
const SORT_LAYER = 750          // above tokens (700): the number sits on top of the town
const CHIP = 2.6                // map units across — RealmScreen's CHIP (worldmap/peopleLayer.mjs)
const LIFT = 0.8                // map units between the town and the bottom of its number
const BASE = 64                 // text is rasterised at this size and scaled (as realm-layer.js does)
const FONT = "'RealmScreen Plex', 'IBM Plex Sans', Signika, sans-serif"
const FILL = 0x9a4f62           // RealmScreen's muted rose (Glass accent fill), white digits
const S = { root: null, chips: [], raf: 0, hidden: new Set() }

const flagOf = (t) => t?.document?.getFlag?.(MOD, "party") || null
const scale = () => canvas?.stage?.scale?.x || 1
const atMax = () => scale() >= (CONFIG.Canvas?.maxZoom ?? 3) * 0.98

function ensureRoot() {
  const primary = canvas?.primary
  if (!primary) return null
  if (S.root && !S.root.destroyed && S.root.parent === primary) return S.root
  const root = new PIXI.Container()
  root.elevation = 0; root.sortLayer = SORT_LAYER; root.sort = 0
  root.eventMode = "none"; root.interactiveChildren = false
  primary.addChild(root)
  primary.sortDirty = true
  S.root = root
  return root
}

// A token drawn or not on this canvas only (renderable: PIXI skips it; eventMode: no hover / click / drag).
function show(token, on) {
  if (!token || token.destroyed) return
  token.renderable = on
  if (token.mesh) token.mesh.renderable = on
  token.eventMode = on ? "static" : "none"
  if (on) S.hidden.delete(token.id); else S.hidden.add(token.id)
}

function draw() {
  S.raf = 0
  const scene = canvas?.scene
  const root = ensureRoot()
  if (!scene || !root) return
  for (const c of root.removeChildren()) c.destroy({ children: true })
  S.chips = []
  const d = canvas.dimensions
  const gm = !!game.user?.isGM
  // Everyone flagged with a spot, by spot. A viewer counts only the tokens Foundry lets them see.
  const spots = new Map()
  for (const t of canvas.tokens?.placeables || []) {
    const f = flagOf(t)
    if (!f?.spot?.key) { if (S.hidden.has(t.id)) show(t, true); continue }
    if (!spots.has(f.spot.key)) spots.set(f.spot.key, { spot: f.spot, tokens: [], n: 0 })
    const s = spots.get(f.spot.key)
    s.tokens.push(t)
    if (gm || !t.document.hidden) s.n += Math.max(1, Number(f.people) || 1)
  }
  // The one town that spreads: at max zoom, the nearest to the middle of the screen.
  let spread = null
  if (atMax()) {
    const c = canvas.stage.pivot
    let best = Infinity
    for (const [k, s] of spots) {
      if (s.spot.road || !s.n) continue
      const x = d.sceneX + s.spot.nx * d.sceneWidth, y = d.sceneY + s.spot.ny * d.sceneHeight
      const dist = Math.hypot(x - c.x, y - c.y)
      if (dist < best) { best = dist; spread = k }
    }
  }
  const u = unitPx(scene), r = (CHIP / 2) * u
  for (const [k, s] of spots) {
    const open = k === spread
    for (const t of s.tokens) show(t, open)
    if (open || !s.n) continue
    const x = d.sceneX + s.spot.nx * d.sceneWidth, y = d.sceneY + s.spot.ny * d.sceneHeight - (LIFT * u + r)
    const g = root.addChild(new PIXI.Graphics())
    g.beginFill(0x000000, 0.28).drawCircle(x, y + r * 0.08, r * 1.04).endFill()       // a soft lift off the map
    g.beginFill(FILL, 1).drawCircle(x, y, r).endFill()
    const n = s.n
    const txt = root.addChild(new PIXI.Text(String(n), new PIXI.TextStyle({ fontFamily: FONT, fontSize: BASE, fontWeight: "600", fill: 0xffffff })))
    txt.anchor.set(0.5, 0.46)
    const fit = n > 99 ? 0.36 : n > 9 ? 0.46 : 0.6           // RealmScreen's digit sizes
    txt.scale.set((CHIP * fit * u) / BASE)
    txt.position.set(x, y)
    S.chips.push({ x, y, r, sx: d.sceneX + s.spot.nx * d.sceneWidth, sy: d.sceneY + s.spot.ny * d.sceneHeight })
  }
}
const schedule = () => { if (!S.raf) S.raf = requestAnimationFrame(draw) }

// Click a number → zoom all the way in on its town (which spreads it). A drag never counts.
let down = null
function onDown(e) { down = { x: e.clientX, y: e.clientY } }
function onUp(e) {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return }
  down = null
  const p = canvas?.mousePosition
  if (!p) return
  const hit = S.chips.find(c => Math.hypot(p.x - c.x, p.y - c.y) <= c.r * 1.15)
  if (hit) canvas.animatePan({ x: hit.sx, y: hit.sy, scale: CONFIG.Canvas?.maxZoom ?? 3, duration: 400 })
}

Hooks.on("canvasReady", () => {
  S.root = null; S.hidden.clear()
  schedule()
  const view = canvas?.app?.view
  if (view && !view._pbPeopleChips) { view._pbPeopleChips = true; view.addEventListener("pointerdown", onDown); view.addEventListener("pointerup", onUp) }
})
Hooks.on("canvasTearDown", () => { S.root = null; S.chips = []; S.hidden.clear() })
Hooks.on("canvasPan", schedule)
// A token refreshed by Foundry keeps our choice (re-applied next frame); new / moved / removed people re-count.
Hooks.on("refreshToken", (t) => { if (S.hidden.has(t.id) && t.renderable) schedule() })
for (const h of ["createToken", "updateToken", "deleteToken"]) Hooks.on(h, (doc) => { if (doc?.parent?.id === canvas?.scene?.id) schedule() })
Hooks.on("updateScene", (scene) => { if (scene?.id === canvas?.scene?.id) schedule() })   // realm records (the map's fit width)
