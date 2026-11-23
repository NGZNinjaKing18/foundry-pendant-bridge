// ──────────────────────────────────────────────────────────────
// Zoom into a nested map — fade through to its scene (pendant-home lib/foundryNest.js, worldmap/useNestZoom.jsx).
//
// RealmScreen maps can sit inside other maps (a nested map's rectangle on its parent). When both maps are linked
// to Foundry scenes, RealmScreen sends each scene flags[MOD].nest:
//   kids    [{ sceneId, rect, cutout }]   the scenes nested in this one; rect = 0..1 of THIS scene's picture
//   parent  { sceneId, rect } | null      the scene this one sits in, and where (0..1 of the PARENT's picture)
//   self    { cutout }                    this map's used part (0..1 of its own picture), or null
// Zooming in over a nested map: its picture fades in over its spot once it covers half the screen; when it
// FULLY covers the screen you are moved to its scene, lined up, with Foundry's own fade. Zooming out of a nested
// scene until it no longer fills the screen takes you back to its parent, lined up, the picture fading out.
// Each person moves only their own view (the user, 2026-11-23); players only into scenes they can see.
// Under the cursor, the smallest nested map wins. The GM picks Off / DM only / Everyone in Map views.
// Cost: nothing while no nested map is near; one sprite and one alpha write per pan otherwise.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
const SORT_LAYER = 695          // above the Realm layer (650) and the sky (690), under tokens (700)
const FADE_FROM = 0.5           // share of the screen covered where the nested picture starts to show
const FULL = 0.999
const SWITCH_FADE_MS = 450      // Foundry's own scene transition at the switch

export const NEST_MODES = ["off", "gm", "all"]
export function nestMode() { try { const v = game.settings.get(MOD, "realmNest"); return NEST_MODES.includes(v) ? v : "all" } catch { return "all" } }
export function nestOnFor(mode, isGM) { return mode === "all" || (mode === "gm" && !!isGM) }

// ── maths (pendant-home lib/nestZoom.mjs, same rules) ──
const WHOLE = { x: 0, y: 0, w: 1, h: 1 }
export function fillOf(cutout) {
  if (!Array.isArray(cutout) || cutout.length < 3) return WHOLE
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0
  for (const p of cutout) {
    const x = Number(p?.[0]), y = Number(p?.[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y
  }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : WHOLE
}
export function fillInParent(rect, fill) {
  const f = fill || WHOLE
  return { x: rect.x + f.x * rect.w, y: rect.y + f.y * rect.h, w: f.w * rect.w, h: f.h * rect.h }
}
export function coverage(s, W, H) {
  if (!(W > 0) || !(H > 0)) return 0
  const w = Math.min(W, s.r) - Math.max(0, s.l), h = Math.min(H, s.b) - Math.max(0, s.t)
  return w > 0 && h > 0 ? (w * h) / (W * H) : 0
}
export function fadeAlpha(c) {
  const t = Math.max(0, Math.min(1, (c - FADE_FROM) / (FULL - FADE_FROM)))
  return t * t * (3 - 2 * t)
}
function inPoly(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside
  }
  return inside
}
export function kidAt(kids, u, v) {
  let best = null, bestA = Infinity
  for (const k of kids || []) {
    const r = k?.rect
    if (!r || !(r.w > 0) || !(r.h > 0)) continue
    if (u < r.x || v < r.y || u > r.x + r.w || v > r.y + r.h) continue
    if (Array.isArray(k.cutout) && k.cutout.length >= 3 && !inPoly((u - r.x) / r.w, (v - r.y) / r.h, k.cutout)) continue
    const f = fillOf(k.cutout), a = r.w * r.h * f.w * f.h
    if (a < bestA) { bestA = a; best = k }
  }
  return best
}
/**
 * The camera, as a place on a map's picture: the picture point at the screen's centre (u, v in 0..1) and how many
 * screen px one whole picture-width takes (ppw). Scene-independent, so it carries across a scene switch.
 */
export function toChildCam(cam, rect) { return { u: (cam.u - rect.x) / rect.w, v: (cam.v - rect.y) / rect.h, ppw: cam.ppw * rect.w } }
export function toParentCam(cam, rect) { return { u: rect.x + cam.u * rect.w, v: rect.y + cam.v * rect.h, ppw: cam.ppw / rect.w } }

// ── the viewed scene ──
const S = { root: null, sprite: null, kid: null, loading: null, lastScale: 0, pending: null, busy: false, settleT: 0 }
/** For tests and harnesses: what this client has on screen now. */
export const nestState = () => ({ kid: S.kid?.sceneId || null, alpha: S.sprite ? S.sprite.alpha : null, busy: S.busy, loading: !!S.loading })

const sceneRect = () => { const d = canvas?.dimensions; return d ? { x: d.sceneX || 0, y: d.sceneY || 0, w: d.sceneWidth || d.width, h: d.sceneHeight || d.height } : null }
const screenSize = () => { const s = canvas?.app?.renderer?.screen; return s ? { W: s.width, H: s.height } : null }
const nestFlag = () => canvas?.scene?.getFlag?.(MOD, "nest") || null
// Scene ↔ screen from the stage's pivot / scale / position. Not stage.worldTransform: canvas.pan() fires canvasPan
// before PIXI recomputes it, so it would be one step behind.
function toScreen(x, y) {
  const st = canvas.stage, k = st.scale?.x || 1
  return { x: (x - st.pivot.x) * k + st.position.x, y: (y - st.pivot.y) * k + st.position.y }
}
function toScene(x, y) {
  const st = canvas.stage, k = st.scale?.x || 1
  return { x: (x - st.position.x) / k + st.pivot.x, y: (y - st.position.y) / k + st.pivot.y }
}
/** A part (0..1) of this scene's picture → screen px. */
function partOnScreen(part) {
  const sr = sceneRect()
  const a = toScreen(sr.x + part.x * sr.w, sr.y + part.y * sr.h)
  const b = toScreen(sr.x + (part.x + part.w) * sr.w, sr.y + (part.y + part.h) * sr.h)
  return { l: Math.min(a.x, b.x), t: Math.min(a.y, b.y), r: Math.max(a.x, b.x), b: Math.max(a.y, b.y) }
}
function camNow() {
  const sr = sceneRect(), sz = screenSize()
  const c = toScene(sz.W / 2, sz.H / 2)
  return { u: (c.x - sr.x) / sr.w, v: (c.y - sr.y) / sr.h, ppw: (canvas.stage.scale?.x || 1) * sr.w }
}
const canSee = (sceneId) => {
  const sc = game.scenes?.get?.(sceneId)
  return !!sc && (game.user?.isGM || sc.visible !== false)
}
const sceneSrc = (sc) => { try { return sc?.firstLevel?.background?.src || sc?.background?.src || "" } catch { return "" } }

function teardown() {
  if (S.root && !S.root.destroyed) S.root.destroy({ children: true })
  S.root = null; S.sprite = null; S.kid = null; S.loading = null
}
function ensureRoot() {
  if (S.root && !S.root.destroyed && S.root.parent === canvas.primary) return S.root
  const root = new PIXI.Container()
  root.elevation = 0; root.sortLayer = SORT_LAYER; root.sort = 0
  root.eventMode = "none"; root.interactiveChildren = false
  canvas.primary.addChild(root)
  canvas.primary.sortDirty = true
  S.root = root
  return root
}
async function texFor(src) {
  const get = foundry?.canvas?.getTexture ?? globalThis.getTexture
  const hit = get?.(src)
  if (hit) return hit
  const load = foundry?.canvas?.loadTexture ?? globalThis.loadTexture
  return load ? load(src) : PIXI.Texture.from(src)
}
/** Show this nested map's picture over its spot (loads it once; alpha set by place()). */
function showKid(kid) {
  if (S.kid?.sceneId === kid.sceneId && (S.sprite || S.loading)) return
  const sc = game.scenes?.get?.(kid.sceneId), src = sceneSrc(sc)
  if (!src) return
  S.kid = kid
  const my = S.loading = src
  texFor(src).then(tex => {
    if (S.loading !== my || !tex || !canvas?.primary) return
    S.loading = null
    const root = ensureRoot()
    root.removeChildren().forEach(c => c.destroy?.())
    const sp = new PIXI.Sprite(tex)
    const sr = sceneRect(), r = kid.rect
    sp.position.set(sr.x + r.x * sr.w, sr.y + r.y * sr.h)
    sp.width = r.w * sr.w; sp.height = r.h * sr.h
    if (Array.isArray(kid.cutout) && kid.cutout.length >= 3) {
      const g = new PIXI.Graphics()
      g.beginFill(0xffffff).drawPolygon(kid.cutout.flatMap(([x, y]) => [sp.x + x * sp.width, sp.y + y * sp.height])).endFill()
      root.addChild(g); sp.mask = g
    }
    sp.alpha = 0
    root.addChild(sp)
    S.sprite = sp
    place()
  }).catch(e => { S.loading = null; console.warn("[pendant-bridge] nested map picture", e) })
}
/** The nested picture's alpha for this camera. */
function place() {
  if (!S.sprite || !S.kid) return
  const sz = screenSize()
  S.sprite.alpha = fadeAlpha(coverage(partOnScreen(fillInParent(S.kid.rect, fillOf(S.kid.cutout))), sz.W, sz.H))
}

async function go(sceneId, cam) {
  const sc = game.scenes?.get?.(sceneId)
  if (!sc || S.busy || canvas.loading) return false
  S.busy = true
  S.pending = { sceneId, cam }
  try { await sc.view({ transition: { type: "fade", duration: SWITCH_FADE_MS } }) }
  catch (e) { console.warn("[pendant-bridge] nested map: could not open the scene", e); S.pending = null }
  finally { S.busy = false }
  return true
}

/** After a pan or zoom: fade the nested picture, maybe switch scenes. dir: 1 = zoomed in, -1 = out, 0 = panned. */
export function onView(dir) {
  if (!canvas?.ready || !canvas.scene || S.busy || canvas.loading) return
  const nest = nestFlag()
  if (!nest || !nestOnFor(nestMode(), game.user?.isGM)) { teardown(); return }
  const sz = screenSize(), sr = sceneRect()
  if (!sz || !sr?.w) return
  // Out of a nested scene that no longer fills the screen → its parent, lined up.
  const par = nest.parent
  if (dir < 0 && par?.sceneId && par.rect && canSee(par.sceneId)) {
    if (coverage(partOnScreen(fillOf(nest.self?.cutout)), sz.W, sz.H) < FULL) {
      const back = { sceneId: canvas.scene.id, rect: par.rect, cutout: nest.self?.cutout || null }
      S.back = back
      go(par.sceneId, toParentCam(camNow(), par.rect))
      return
    }
  }
  const kids = (nest.kids || []).filter(k => k?.sceneId && k.rect && canSee(k.sceneId))
  if (!kids.length) { if (S.root) teardown(); return }
  // The nested map under the cursor (or the screen's centre) — the smallest there.
  const mp = canvas.mousePosition
  const at = mp && Number.isFinite(mp.x) ? { u: (mp.x - sr.x) / sr.w, v: (mp.y - sr.y) / sr.h } : camNow()
  const kid = (dir > 0 || !S.kid) ? kidAt(kids, at.u, at.v) : (kids.find(k => k.sceneId === S.kid.sceneId) || null)
  if (kid) {
    const c = coverage(partOnScreen(fillInParent(kid.rect, fillOf(kid.cutout))), sz.W, sz.H)
    if (c > 0.2) showKid(kid)
    if (S.kid?.sceneId === kid.sceneId) place()
    if (c >= FULL && dir >= 0) { go(kid.sceneId, toChildCam(camNow(), kid.rect)); return }
  } else if (S.kid) place()
}

// ── hooks ─────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MOD, "realmNest", {
    scope: "world", config: false, type: String, default: "all",
    onChange: () => { teardown(); onView(0) },
  })
})
// Line the new scene's camera up with the one we came from. canvasReady runs before Foundry plays its transition,
// so the fade goes from the old view to the lined-up new one.
Hooks.on("canvasReady", () => {
  const p = S.pending
  S.pending = null
  S.lastScale = canvas?.stage?.scale?.x || 0
  if (!p || p.sceneId !== canvas.scene?.id) return
  const sr = sceneRect(), sz = screenSize()
  if (!sr?.w || !sz) return
  canvas.pan({ x: sr.x + p.cam.u * sr.w, y: sr.y + p.cam.v * sr.h, scale: p.cam.ppw / sr.w })
  S.lastScale = canvas.stage.scale.x
  // Came back out of a nested scene: its picture is over its spot already, at the opacity this view gives it.
  const b = S.back
  S.back = null
  if (b) { const k = (nestFlag()?.kids || []).find(x => x.sceneId === b.sceneId) || b; showKid(k) }
})
Hooks.on("canvasTearDown", () => { teardown(); clearTimeout(S.settleT) })
Hooks.on("canvasPan", (c, pos) => {
  const s = Number(pos?.scale) || canvas?.stage?.scale?.x || 0
  const dir = S.lastScale && s > S.lastScale * 1.0001 ? 1 : S.lastScale && s < S.lastScale * 0.9999 ? -1 : 0
  S.lastScale = s
  onView(dir)
  // A pan that leaves a nested map filling the screen: open it once the camera rests.
  clearTimeout(S.settleT)
  if (dir === 0) S.settleT = setTimeout(() => onView(0), 200)
})
Hooks.on("updateScene", (scene, changes) => {
  if (scene?.id !== canvas?.scene?.id) return
  const f = changes?.flags?.[MOD]
  if (f && ("nest" in f || "-=nest" in f)) { teardown(); onView(0) }
})

// ── command (main.js): RealmScreen sends one scene's nesting ──
export async function nestSet(msg) {
  const scene = game.scenes?.get?.(msg?.sceneId)
  if (!scene) return { ok: false, error: "No such scene." }
  const n = msg?.nest
  if (!n) { await scene.unsetFlag(MOD, "nest"); return { ok: true } }
  const rect = (r) => (r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0 ? { x: r.x, y: r.y, w: r.w, h: r.h } : null)
  const cut = (c) => (Array.isArray(c) && c.length >= 3 ? c.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(p => [p[0], p[1]]) : null)
  const kids = (Array.isArray(n.kids) ? n.kids : []).map(k => ({ sceneId: String(k?.sceneId || ""), rect: rect(k?.rect), cutout: cut(k?.cutout) })).filter(k => k.sceneId && k.rect)
  const parent = n.parent?.sceneId && rect(n.parent.rect) ? { sceneId: String(n.parent.sceneId), rect: rect(n.parent.rect) } : null
  if (!kids.length && !parent) { await scene.unsetFlag(MOD, "nest"); return { ok: true } }
  // Replace, not merge (a removed nested map must go): clear then set.
  if (scene.getFlag(MOD, "nest")) await scene.unsetFlag(MOD, "nest")
  await scene.setFlag(MOD, "nest", { kids, parent, self: { cutout: cut(n.self?.cutout) } })
  return { ok: true }
}
