// ──────────────────────────────────────────────────────────────
// RealmScreen's people as NUMBERS (pendant-home worldmap/PeopleLayer.jsx; the user, 2026-11-11: "do the
// sizing, and the going into numbers when at settlements … for Foundry").
//
// party.js places everyone's token (about a road's width, on an arc above their town) and flags the spot
// it belongs to: flags[MOD].party = { key, spot: { key, road, nx, ny }, people }. Here, on EACH viewer's
// own canvas (nothing is written):
//   • every spot is one round number — how many people there that THIS viewer may see — and its tokens
//     are not drawn; the number is part of the map (it grows and shrinks with it, like the roads)
//   • once zoomed in far enough that faces are ~34 screen px (NOT Foundry's max zoom — the user, 2026-11-11),
//     the ONE town nearest the middle of the screen shows its tokens instead (road people never do)
//   • the change is ANIMATED ("it isn't smooth or beautiful", 2026-11-11): the number fades and shrinks while
//     copies of the faces glide out from the town to their places (and back in); the real tokens appear
//     only once the copies have landed
//   • the number's disc is 3/4 see-through (the user, 2026-11-11); the digits stay solid
//   • click a number: the view zooms in on that town just past that point, which spreads it
// Tokens without a spot (an older RealmScreen) are left alone.
// ──────────────────────────────────────────────────────────────
import { unitPx } from "./party.js"

const MOD = "pendant-bridge"
const SORT_LAYER = 750          // above tokens (700): the number sits on top of the town
const CHIP = 2.6                // map units across — RealmScreen's CHIP (worldmap/peopleLayer.mjs)
const LIFT = 0.8                // map units between the town and the bottom of its number
const BASE = 64                 // text is rasterised at this size and scaled (as realm-layer.js does)
const FONT = "'RealmScreen Plex', 'IBM Plex Sans', Signika, sans-serif"
const FILL = 0x9a4f62           // RealmScreen's muted rose (Glass accent fill)
const DISC_ALPHA = 0.25         // "3 quarters transparent"
const FACE = 4                  // map units across one face (RealmScreen's FACE)
const SPREAD_PX = 34            // a town spreads once a face is this many SCREEN px across
const MS = 320                  // one spread / gather
const S = { root: null, spots: new Map(), hidden: new Set(), raf: 0, ticking: false }

const flagOf = (t) => t?.document?.getFlag?.(MOD, "party") || null
const scale = () => canvas?.stage?.scale?.x || 1
const maxZoom = () => CONFIG.Canvas?.maxZoom ?? 3
const spreadZoom = (scene) => Math.min(maxZoom() * 0.98, SPREAD_PX / (FACE * unitPx(scene)))
const atSpread = (scene) => scale() >= spreadZoom(scene) * 0.999
const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2   // easeInOutCubic
const lerp = (a, b, t) => a + (b - a) * t

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
  S.spots.clear()
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

function makeChip(n, u) {
  const r = (CHIP / 2) * u
  const c = new PIXI.Container()
  const g = c.addChild(new PIXI.Graphics())
  g.lineStyle({ width: r * 0.09, color: FILL, alpha: 0.9 }).beginFill(FILL, DISC_ALPHA).drawCircle(0, 0, r).endFill()
  const txt = c.addChild(new PIXI.Text(String(n), new PIXI.TextStyle({
    fontFamily: FONT, fontSize: BASE, fontWeight: "600", fill: 0xffffff,
    dropShadow: true, dropShadowColor: 0x000000, dropShadowAlpha: 0.55, dropShadowBlur: 6, dropShadowDistance: 0,
  })))
  txt.resolution = 2
  txt.anchor.set(0.5, 0.48)
  const fit = n > 99 ? 0.36 : n > 9 ? 0.46 : 0.6           // RealmScreen's digit sizes
  txt.scale.set((CHIP * fit * u) / BASE)
  c.n = n
  return c
}

// Rebuild what each spot holds (who, how many, where the number sits). Animation state (t) survives.
function rebuild() {
  S.raf = 0
  const scene = canvas?.scene
  const root = ensureRoot()
  if (!scene || !root) return
  const d = canvas.dimensions
  const gm = !!game.user?.isGM
  const u = unitPx(scene), r = (CHIP / 2) * u
  const found = new Map()
  for (const t of canvas.tokens?.placeables || []) {
    const f = flagOf(t)
    if (!f?.spot?.key) { if (S.hidden.has(t.id)) show(t, true); continue }
    if (!found.has(f.spot.key)) found.set(f.spot.key, { spot: f.spot, tokens: [], n: 0 })
    const s = found.get(f.spot.key)
    s.tokens.push(t)
    if (gm || !t.document.hidden) s.n += Math.max(1, Number(f.people) || 1)
  }
  // Drop spots that emptied.
  for (const [k, s] of S.spots) if (!found.has(k)) { s.chip?.destroy({ children: true }); s.ghosts?.destroy({ children: true }); S.spots.delete(k) }
  for (const [k, f] of found) {
    const sx = d.sceneX + f.spot.nx * d.sceneWidth, sy = d.sceneY + f.spot.ny * d.sceneHeight
    let s = S.spots.get(k)
    if (!s) { s = { t: 0, target: 0 }; S.spots.set(k, s) }
    Object.assign(s, { spot: f.spot, tokens: f.tokens, n: f.n, sx, sy, cx: sx, cy: sy - (LIFT * u + r), r })
    if (!s.chip || s.chip.destroyed || s.chip.n !== f.n || s.u !== u) {
      s.chip?.destroy({ children: true })
      s.chip = root.addChild(makeChip(f.n, u))
      s.u = u
    }
    s.chip.position.set(s.cx, s.cy)
  }
  retarget(true)
}

// Which town spreads (at most one): the nearest to the middle of the screen, once zoomed in enough.
function retarget(force = false) {
  const scene = canvas?.scene
  if (!scene || !S.root) return
  let spread = null
  if (atSpread(scene)) {
    const c = canvas.stage.pivot
    let best = Infinity
    for (const [k, s] of S.spots) {
      if (s.spot.road || !s.n) continue
      const dist = Math.hypot(s.sx - c.x, s.sy - c.y)
      if (dist < best) { best = dist; spread = k }
    }
  }
  let moving = false
  for (const [k, s] of S.spots) {
    const target = k === spread ? 1 : 0
    if (s.target !== target) { s.target = target; s.from = s.t; s.start = performance.now() }
    if (s.t !== s.target) moving = true
  }
  if (moving) startTicker()
  if (force || moving) paint()
}

// Copies of the visible faces, for the glide (the real tokens can't be moved without Foundry fighting back).
function ghostsFor(s) {
  if (s.ghosts && !s.ghosts.destroyed) return s.ghosts
  const box = S.root.addChild(new PIXI.Container())
  box.items = []
  for (const t of s.tokens) {
    const m = t.mesh
    if (!m?.texture || !t.visible && !(game.user?.isGM)) continue
    if (!game.user?.isGM && t.document.hidden) continue
    const sp = box.addChild(new PIXI.Sprite(m.texture))
    sp.anchor.set(0.5)
    const w = Math.abs(m.width) || t.w, h = Math.abs(m.height) || t.h
    box.items.push({ sp, w, h, x: m.position?.x ?? t.center.x, y: m.position?.y ?? t.center.y, a: t.document.hidden ? 0.5 : 1 })
  }
  s.ghosts = box
  return box
}

function paint() {
  for (const s of S.spots.values()) {
    const e = ease(s.t)
    // The number: shrinks and fades as the town opens.
    if (s.chip && !s.chip.destroyed) {
      s.chip.visible = s.n > 0 && s.t < 1
      s.chip.alpha = 1 - e
      s.chip.scale.set(1 - 0.45 * e)
    }
    // The real tokens: only when fully open (and settled there).
    const open = s.t >= 1 && s.target === 1
    for (const t of s.tokens) {
      if (open) { if (S.hidden.has(t.id)) show(t, true) }
      else if (!S.hidden.has(t.id) || t.renderable) show(t, false)
    }
    // The glide: copies between the town and each face's place.
    if (s.t > 0 && s.t < 1) {
      const box = ghostsFor(s)
      box.visible = true
      for (const it of box.items) {
        it.sp.position.set(lerp(s.sx, it.x, e), lerp(s.sy, it.y, e))
        const k = lerp(0.35, 1, e)
        it.sp.width = it.w * k; it.sp.height = it.h * k
        it.sp.alpha = it.a * Math.min(1, e * 1.6)
      }
    } else if (s.ghosts && !s.ghosts.destroyed) { s.ghosts.destroy({ children: true }); s.ghosts = null }
  }
}

function tick() {
  const now = performance.now()
  let moving = false
  for (const s of S.spots.values()) {
    if (s.t === s.target) continue
    const p = Math.min(1, (now - (s.start ?? now)) / MS)
    s.t = s.target ? lerp(s.from ?? 0, 1, p) : lerp(s.from ?? 1, 0, p)
    if (p >= 1) s.t = s.target
    if (s.t !== s.target) moving = true
  }
  paint()
  if (!moving) stopTicker()
}
function startTicker() { if (S.ticking || !canvas?.app?.ticker) return; S.ticking = true; canvas.app.ticker.add(tick) }
function stopTicker() { if (!S.ticking) return; S.ticking = false; canvas?.app?.ticker?.remove(tick) }

const schedule = () => { if (!S.raf) S.raf = requestAnimationFrame(rebuild) }

// Click a number → zoom in on its town just past the spread point (which spreads it). A drag never counts.
let down = null
function onDown(e) { down = { x: e.clientX, y: e.clientY } }
function onUp(e) {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return }
  down = null
  const p = canvas?.mousePosition
  if (!p) return
  const hit = [...S.spots.values()].find(s => s.chip?.visible && s.t < 0.5 && Math.hypot(p.x - s.cx, p.y - s.cy) <= s.r * 1.15)
  if (hit) canvas.animatePan({ x: hit.sx, y: hit.sy, scale: Math.max(scale(), spreadZoom(canvas.scene) * 1.05), duration: 500 })
}

Hooks.on("canvasReady", () => {
  stopTicker(); S.root = null; S.spots.clear(); S.hidden.clear()
  schedule()
  const view = canvas?.app?.view
  if (view && !view._pbPeopleChips) { view._pbPeopleChips = true; view.addEventListener("pointerdown", onDown); view.addEventListener("pointerup", onUp) }
})
Hooks.on("canvasTearDown", () => { stopTicker(); S.root = null; S.spots.clear(); S.hidden.clear() })
Hooks.on("canvasPan", () => retarget())
// A token refreshed by Foundry keeps our choice; new / moved / removed people re-count.
Hooks.on("refreshToken", (t) => { if (S.hidden.has(t.id) && t.renderable) { t.renderable = false; if (t.mesh) t.mesh.renderable = false } })
for (const h of ["createToken", "updateToken", "deleteToken"]) Hooks.on(h, (doc) => { if (doc?.parent?.id === canvas?.scene?.id) schedule() })
Hooks.on("updateScene", (scene) => { if (scene?.id === canvas?.scene?.id) schedule() })   // realm records (the map's fit width)

export const _test = { S, rebuild, retarget, tick, paint, ease }
