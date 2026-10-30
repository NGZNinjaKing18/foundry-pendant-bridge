// ──────────────────────────────────────────────────────────────
// The Realm layer — RealmScreen's World Map, drawn by this module itself (no Foundry Drawings / Tiles)
// (pendant-home _handoffs/foundry-realm-layer-plan.md, R2–R4).
//
// What RealmScreen sent is ONE record per thing in flags[MOD].realm (scripts/mapviews.js; the records are
// built by pendant-home lib/foundryRealm.mjs). This draws them on one PIXI container in Foundry's primary
// group, sortLayer 650: above tiles (500) and drawings (600), UNDER tokens (700).
//
// Every size follows RealmScreen's map exactly. "Map zoom" 1 = the scene fits the screen:
//   map     part of the land (grows as you zoom in): scene px = RealmScreen px × sceneWidth / fitPx
//   screen  the same size on screen at any zoom:     scene px = RealmScreen px / canvas scale
//   towns + their names: map unless "Fixed on screen" · roads: map · rivers + borders: screen unless set
//   to grow · nation names: fit their land, up to their size, then hold (RealmScreen's own formula)
// Zoom bands hide things outside them; the nation fill fades across its band, as on the map.
// Who sees what: views, GM-only and "Show me everything" are worked out here on each client.
// Hover a town: a small card (name, type, population).
// ──────────────────────────────────────────────────────────────

import { viewsOf, realmRecords, showEverything, inView } from "./mapviews.js"

const SORT_LAYER = 650
// RealmScreen's own font (bundled: styles/pendant-bridge.css @font-face, OFL licence in assets/fonts).
const FONT = "'RealmScreen Plex', 'IBM Plex Sans', Signika, sans-serif"
const MOD = "pendant-bridge"
// Name size and the gap between a town and its name — the GM tunes them in Map views (the user, 2026-10-30:
// "a wee bit too close and too big" against RealmScreen's 1:1). World settings, so every viewer gets the same.
const setting = (k, d) => { try { const v = game.settings.get(MOD, k); return Number.isFinite(v) ? v : d } catch { return d } }
export const nameScale = () => setting("realmNameScale", 0.85)
export const nameGap = () => setting("realmNameGap", 4)
const BASE = 64                 // text is rasterised at this size and scaled; re-sharpened when zooming stops
const ZMIN = 0.2, ZMAX = 30, FADE = Math.log(1.45)

// ── zoom bands (pendant-home lib/zoomBand.mjs: inZoomBand, zoomBandFade) ──
const inBand = (z, b) => {
  if (!b) return true
  const lo = Number.isFinite(b.min) ? b.min : ZMIN, hi = Number.isFinite(b.max) ? b.max : ZMAX
  return z >= lo - 1e-6 && (hi >= ZMAX - 1e-6 || z < hi - 1e-6)
}
const bandFade = (z, b) => {
  if (!b) return 1
  const lo = Number.isFinite(b.min) ? b.min : ZMIN, hi = Number.isFinite(b.max) ? b.max : ZMAX
  let a = 1
  if (lo > ZMIN + 1e-6) a = Math.min(a, Math.log(z / lo) / FADE)
  if (hi < ZMAX - 1e-6) a = Math.min(a, Math.log(hi / z) / FADE)
  return Math.max(0, Math.min(1, a))
}
// A nation name's size on screen (pendant-home lib/foundryRealm.mjs nationNameSize = MapView ~:14303).
export function nationNameSize(text, boxW, boxH, s) {
  const size = s.size ?? 13
  const textW = String(text || "").length * size * 0.55
  const fitW = textW > 0 ? Math.min(1, (boxW * (s.fitW ?? 0.85)) / textW) : 1
  const fitH = size > 0 ? Math.min(1, (boxH * (s.fitH ?? 0.6)) / size) : 1
  let eff = s.noShrink ? size : size * Math.min(fitW, fitH)
  if ((s.maxScreen ?? 0) > 0 && eff > s.maxScreen) eff = s.maxScreen
  return eff
}

const colour = (c, d = 0xffffff) => {
  if (typeof c !== "string") return d
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return d
  const h = m[1].length === 3 ? m[1].split("").map(x => x + x).join("") : m[1]
  return parseInt(h, 16)
}

// ── the canvas ────────────────────────────────────────────────

const S = { root: null, parts: null, items: [], tex: new Map(), raf: 0, sharpT: 0, tip: null, hover: null }

function dims() { return canvas?.dimensions || null }
function scale() { return canvas?.stage?.scale?.x || 1 }
function mapZoom() {
  const d = dims(), scr = canvas?.app?.renderer?.screen
  if (!d?.sceneWidth || !scr?.width) return 1
  return scale() / Math.min(scr.width / d.sceneWidth, scr.height / d.sceneHeight)
}
const toScene = (p) => { const d = dims(); return [d.sceneX + p[0] * d.sceneWidth, d.sceneY + p[1] * d.sceneHeight] }
// A RealmScreen px size → scene px: fixed to the land, or the same on screen now.
function px(v, map, fitPx) {
  const d = dims()
  return map ? (v * d.sceneWidth) / (fitPx > 0 ? fitPx : 1200) : v / scale()
}

function visibleFor(r, current) {
  if (r.gm && !game.user?.isGM) return false
  if (game.user?.isGM && showEverything()) return true
  return inView(r, current)
}

function ensureRoot() {
  const primary = canvas?.primary
  if (!primary) return null
  if (S.root && !S.root.destroyed && S.root.parent === primary) return S.root
  const root = new PIXI.Container()
  root.elevation = 0; root.sortLayer = SORT_LAYER; root.sort = 0
  root.eventMode = "none"; root.interactiveChildren = false
  const names = ["fills", "borders", "rivers", "roads", "markers", "townNames", "nationNames"]
  S.parts = {}
  for (const n of names) S.parts[n] = root.addChild(new PIXI.Container())
  primary.addChild(root)
  primary.sortDirty = true
  S.root = root
  return root
}

// Load a picture once; every town with the same picture shares it.
function texture(src) {
  if (!src) return null
  if (S.tex.has(src)) return S.tex.get(src)
  const load = foundry?.canvas?.loadTexture ?? globalThis.loadTexture
  const entry = { tex: null, waiting: [] }
  S.tex.set(src, entry)
  Promise.resolve(load ? load(src) : PIXI.Texture.from(src)).then(t => {
    entry.tex = t
    for (const sp of entry.waiting) if (!sp.destroyed) { sp.texture = t; sp.visible = sp._want !== false }
    entry.waiting = []
    schedule()
  }).catch(e => console.warn("[pendant-bridge] realm layer: picture failed", src, e))
  return entry
}

function textOf(str, style) {
  const t = new PIXI.Text(String(str), new PIXI.TextStyle({ fontFamily: FONT, fontSize: BASE, lineJoin: "round", ...style }))
  t.anchor.set(0.5)
  return t
}

// ── building (when the records change) ────────────────────────

function build() {
  const root = ensureRoot()
  if (!root) return
  for (const c of Object.values(S.parts)) for (const ch of c.removeChildren()) ch.destroy({ children: true })
  S.items = []
  const recs = realmRecords(canvas.scene)
  for (const r of recs) {
    try {
      if (r.kind === "nation") S.items.push(buildNation(r))
      else if (r.kind === "road" || r.kind === "river") S.items.push(buildRoute(r))
      else if (r.kind === "settlement") S.items.push(buildTown(r))
    } catch (e) { console.warn("[pendant-bridge] realm layer: could not draw", r?.name || r?.id, e) }
  }
  update(true)
}

function buildNation(r) {
  const it = { r, fill: null, border: S.parts.borders.addChild(new PIXI.Graphics()), labels: [] }
  if (r.fill?.on) {
    const g = it.fill = S.parts.fills.addChild(new PIXI.Graphics())
    g.beginFill(colour(r.fill.color, 0xffd166), 1)
    for (const { outer, holes } of r.land || []) {
      g.drawPolygon((outer || []).flatMap(toScene))
      for (const h of holes || []) { g.beginHole(); g.drawPolygon(h.flatMap(toScene)); g.endHole() }
    }
    g.endFill()
  }
  const st = r.nameStyle || {}
  for (const l of r.labels || []) {
    const t = S.parts.nationNames.addChild(textOf(l.text, {
      fill: st.color || "#ffffff", fontWeight: String(st.weight ?? 700), fontStyle: st.italic ? "italic" : "normal",
      stroke: "rgba(0,0,0,0.7)", strokeThickness: BASE * 0.27,
    }))
    const [x, y] = toScene(l.at)
    t.position.set(x, y)
    it.labels.push({ t, l })
  }
  return it
}

function buildRoute(r) {
  const it = { r, under: null, line: S.parts[r.kind === "river" ? "rivers" : "roads"].addChild(new PIXI.Graphics()) }
  if (r.kind === "river" || r.casing) it.under = it.line.parent.addChildAt(new PIXI.Graphics(), it.line.parent.getChildIndex(it.line))
  it.pts = (r.pts || []).map(toScene)
  return it
}

function buildTown(r) {
  const it = { r, sprite: null, name: null }
  const m = r.marker
  if (m && (m.src || m.art)) {
    const sp = it.sprite = S.parts.markers.addChild(new PIXI.Sprite(PIXI.Texture.EMPTY))
    sp.anchor.set(0.5)
    const [x, y] = toScene([r.x, r.y])
    sp.position.set(x, y)
    sp.alpha = r.opacity ?? 1
  }
  if (r.label) {
    it.name = S.parts.townNames.addChild(textOf(r.label.text, {
      fill: "#ffffff", fontWeight: String(r.label.weight ?? 600), stroke: "rgba(0,0,0,0.72)", strokeThickness: BASE / 9,
    }))
    it.name.rotation = ((r.label.rotate || 0) * Math.PI) / 180
  }
  return it
}

// ── sizing (every zoom) ───────────────────────────────────────

function strokePoly(g, pts, w, closed) {
  if (pts.length < 2) return
  g.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
  if (closed) g.closePath()
}

// RealmScreen's dotted roads (ROAD_DASH dotted: round dots w across, every 2.4w), as filled circles.
function dotted(g, pts, w, colour) {
  const step = w * 2.4
  let left = 0
  g.lineStyle(0); g.beginFill(colour, 1)
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]
    const seg = Math.hypot(x1 - x0, y1 - y0)
    let at = left
    while (at <= seg) { const f = seg ? at / seg : 0; g.drawCircle(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, w / 2); at += step }
    left = at - seg
  }
  g.endFill()
}

// RealmScreen's dashed roads (ROAD_DASH dashed): 3w on / 2w off.
function dashed(g, pts, w, kind) {
  const on = kind === "dashed" ? w * 3 : 0.0001, off = kind === "dashed" ? w * 2 : w * 2.4
  let drawing = true, left = on
  for (let i = 1; i < pts.length; i++) {
    let [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    let seg = Math.hypot(x1 - x0, y1 - y0)
    const ux = (x1 - x0) / (seg || 1), uy = (y1 - y0) / (seg || 1)
    while (seg > 0) {
      const step = Math.min(left, seg)
      const nx = x0 + ux * step, ny = y0 + uy * step
      if (drawing) { g.moveTo(x0, y0); g.lineTo(nx === x0 && ny === y0 ? nx + 0.01 : nx, ny) }
      x0 = nx; y0 = ny; seg -= step; left -= step
      if (left <= 1e-6) { drawing = !drawing; left = drawing ? on : off }
    }
  }
}

function update(full = false) {
  if (!S.root || S.root.destroyed) return
  const z = mapZoom(), k = scale(), d = dims()
  const { current } = viewsOf(canvas.scene)
  // A view showing borders → the ink markers in RealmScreen's colours; none → more of the nation's colour.
  const borders = S.items.some(it => it.r.kind === "nation" && visibleFor(it.r, current))
  for (const it of S.items) {
    const r = it.r
    const shown = visibleFor(r, current)
    if (r.kind === "nation") {
      if (it.fill) { it.fill.visible = shown; it.fill.alpha = (r.fill.opacity ?? 0.3) * bandFade(z, r.fill.zoom) }
      const g = it.border
      g.visible = shown
      if (shown && (full || !r.border?.map)) {
        g.clear()
        g.lineStyle({ width: px(r.border?.px ?? 2, !!r.border?.map, r.fitPx), color: colour(r.border?.color, 0xffd166), alpha: 1, join: "round", cap: "round" })
        for (const { outer, holes } of r.land || []) {
          strokePoly(g, (outer || []).map(toScene), 0, true)
          for (const h of holes || []) strokePoly(g, h.map(toScene), 0, true)
        }
        for (const line of r.lines || []) strokePoly(g, line.map(toScene), 0, false)
      }
      const nameOn = shown && inBand(z, r.nameZoom)
      for (const { t, l } of it.labels) {
        t.visible = nameOn
        if (!nameOn) continue
        const size = nationNameSize(l.text, l.box[0] * d.sceneWidth * k, l.box[1] * d.sceneHeight * k, r.nameStyle || {}) * nameScale()
        t.scale.set(size / BASE / k)
        const ls = (r.nameStyle?.letterSpacing || 0) * (BASE / Math.max(size, 1))
        if (Math.abs((t.style.letterSpacing || 0) - ls) > 0.05) t.style.letterSpacing = ls
      }
    } else if (r.kind === "road" || r.kind === "river") {
      const on = shown && inBand(z, r.zoom)
      it.line.visible = on; if (it.under) it.under.visible = on
      if (!on || (!full && r.map)) continue
      const w = px(r.px ?? 2, !!r.map, r.fitPx)
      const g = it.line
      g.clear(); g.alpha = r.opacity ?? 1
      if (it.under) {
        it.under.clear(); it.under.alpha = r.opacity ?? 1
        if (r.kind === "river") it.under.lineStyle({ width: w + 3 / k, color: colour(r.color, 0x3f7590), alpha: 0.3, join: "round", cap: "round" })
        else it.under.lineStyle({ width: w * 1.55, color: 0x140c04, alpha: 0.6, join: "round", cap: "round" })
        strokePoly(it.under, it.pts, 0, false)
      }
      g.lineStyle({ width: w, color: colour(r.color, 0xb0a080), alpha: 1, join: "round", cap: "round" })
      if (r.dash === "dotted") dotted(g, it.pts, w, colour(r.color, 0xb0a080))
      else if (r.dash === "dashed") dashed(g, it.pts, w, r.dash)
      else strokePoly(g, it.pts, 0, false)
    } else if (r.kind === "settlement") {
      const markerOn = shown && inBand(z, r.markerZoom)
      const map = r.map !== false
      if (it.sprite) {
        const m = r.marker
        const src = m.art ? (borders ? m.art.rs : (m.art.more || m.art.rs)) : m.src
        if (it.sprite._src !== src) {
          it.sprite._src = src
          const e = texture(src)
          if (e?.tex) it.sprite.texture = e.tex; else if (e) { it.sprite.visible = false; e.waiting.push(it.sprite) }
        }
        it.sprite._want = markerOn
        it.sprite.visible = markerOn && it.sprite.texture !== PIXI.Texture.EMPTY
        let w = px(m.w ?? m.px ?? 16, map, r.fitPx), h = px(m.h ?? m.px ?? 16, map, r.fitPx)
        const tex = it.sprite.texture
        if (m.contain && tex && tex !== PIXI.Texture.EMPTY && tex.width > 0) {   // a place's own picture keeps its proportions
          const f = Math.min(w / tex.width, h / tex.height); w = tex.width * f; h = tex.height * f
        }
        it.sprite.width = w; it.sprite.height = h
      }
      if (it.name) {
        const L = r.label
        const on = markerOn && inBand(z, r.nameZoom)
        it.name.visible = on
        if (!on) continue
        // MarkerName: the name's middle sits at its offset, pushed out by half its own size along that way.
        const s = px(L.px * nameScale(), map, r.fitPx) / BASE
        it.name.scale.set(s)
        const w = it.name.width, h = it.name.height
        const len = Math.hypot(L.dx, L.dy) || 1, ux = L.dx / len, uy = L.dy / len
        const u = px(1, map, r.fitPx), gap = nameGap()
        const [x, y] = toScene([r.x, r.y])
        it.name.position.set(x + (L.dx + ux * gap) * u + ux * w / 2, y + (L.dy + uy * gap) * u + uy * h / 2)
      }
    }
  }
  clearTimeout(S.sharpT)
  S.sharpT = setTimeout(sharpen, 160)
}

// Text is rasterised at BASE px; when zooming stops, give every visible name enough pixels for its size now.
function sharpen() {
  if (!S.root || S.root.destroyed) return
  const k = scale(), dpr = window.devicePixelRatio || 1
  for (const t of [...S.parts.townNames.children, ...S.parts.nationNames.children]) {
    if (!t.visible) continue
    const onScreen = BASE * t.scale.x * k
    const res = Math.max(1, Math.min(4, (onScreen / BASE) * dpr * 1.25))
    if (Math.abs((t.resolution || 1) - res) > 0.2) { t.resolution = res; t.updateText?.(true) }
  }
}

function schedule() {
  if (S.raf) return
  S.raf = requestAnimationFrame(() => { S.raf = 0; try { update(false) } catch (e) { console.warn("[pendant-bridge] realm layer", e) } })
}

export function redrawRealm() { try { build() } catch (e) { console.warn("[pendant-bridge] realm layer", e) } }

// ── hover card ───────────────────────────────────────────────

function tipEl() {
  if (S.tip?.isConnected) return S.tip
  const el = document.createElement("div")
  el.id = "pb-realm-tip"; el.className = "pb-realm-tip"; el.hidden = true
  document.body.appendChild(el)
  S.tip = el
  return el
}
function onMove(e) {
  if (!S.root || S.root.destroyed || !canvas?.ready) return
  let p = null
  try { p = canvas.canvasCoordinatesFromClient?.({ x: e.clientX, y: e.clientY }) } catch { p = null }
  if (!p) return
  const k = scale()
  let best = null, bestD = Infinity
  for (const it of S.items) {
    if (it.r.kind !== "settlement" || !it.sprite?.visible) continue
    const r = Math.max(it.sprite.width, it.sprite.height) / 2 + 4 / k
    const dd = Math.hypot(p.x - it.sprite.x, p.y - it.sprite.y)
    if (dd <= r && dd < bestD) { best = it; bestD = dd }
  }
  const el = tipEl()
  if (!best) { if (!el.hidden) el.hidden = true; S.hover = null; return }
  if (S.hover !== best) {
    S.hover = best
    const r = best.r
    const line = [r.kindLine, r.population != null && r.population !== "" ? Number(r.population).toLocaleString() : null].filter(Boolean).join(" · ")
    el.replaceChildren()
    const b = document.createElement("strong"); b.textContent = r.name || ""
    el.append(b)
    if (line) { const s = document.createElement("span"); s.textContent = line; el.append(s) }
  }
  el.style.left = `${e.clientX + 14}px`; el.style.top = `${e.clientY + 12}px`
  el.hidden = false
}

// ── hooks ─────────────────────────────────────────────────────

Hooks.once("init", () => {
  for (const [key, def] of [["realmNameScale", 0.85], ["realmNameGap", 4]]) {
    game.settings.register(MOD, key, { scope: "world", config: false, type: Number, default: def, onChange: () => redrawRealm() })
  }
})

Hooks.on("canvasReady", () => {
  S.root = null; S.tex.clear()
  redrawRealm()
  // Names drawn before the bundled font arrives would keep the fallback's shapes: redraw once it's in.
  document.fonts?.load?.("600 16px 'RealmScreen Plex'").then(() => redrawRealm()).catch(() => {})
  const view = canvas?.app?.view
  if (view && !view._pbRealmTip) { view._pbRealmTip = true; view.addEventListener("pointermove", onMove); view.addEventListener("pointerleave", () => { if (S.tip) S.tip.hidden = true }) }
})
Hooks.on("canvasTearDown", () => { S.root = null; S.items = []; if (S.tip) S.tip.hidden = true })
Hooks.on("canvasPan", () => schedule())
Hooks.on("updateScene", (scene, changes) => {
  if (scene?.id !== canvas?.scene?.id) return
  const f = changes?.flags?.["pendant-bridge"]
  if (f && ("realm" in f || "mapViews" in f || Object.keys(f).some(x => x.startsWith("-=realm")))) redrawRealm()
})
Hooks.on("pendantRealmRedraw", () => redrawRealm())
