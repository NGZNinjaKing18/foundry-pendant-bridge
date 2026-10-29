// ──────────────────────────────────────────────────────────────
// Map views — World Map things RealmScreen sent "into views"
// (pendant-home _handoffs/map-to-foundry-views-build-plan.md, P1).
//
// The scene keeps its views: flags[MOD].mapViews = { views: [{ id, name }], current: "all" | id }.
// Every document RealmScreen sent carries flags[MOD].rs = { id, kind, name, views: [viewId], gm, sentAt, art? }
// (one thing = several documents: a town's marker + label, a nation's parts + name).
//   current "all"  every sent thing shows
//   current <id>   only the things in that view; the rest are hidden for everyone (the GM too, unless
//                  "Show me everything" is on — a client setting)
// GM-only things are hidden from players always (Drawings and Tiles natively, older Notes by the render rule).
// A town's picture marker is a Tile (ink drawing or its own icon); before v0.140.4 it was a Map Note — those
// are still read, recoloured and replaced on the next send.
// Ink markers carry two pictures (art.rs / art.more): a view with no borders shows "more" — more of the
// nation's colour, so you can still tell whose town it is (the user's rule, 2026-10-28).
// The view rules mirror pendant-home lib/foundryMapViews.mjs — keep the two in step.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
const ALL = "all", NONE = "none"
const KINDS = ["settlement", "road", "river", "nation"]
const DOC_TYPES = ["Drawing", "Tile", "Note"]

// main.js hands over its scene-document builders (they share settlement.push / road.push's code).
let B = null
export function setMapBuilders(builders) { B = builders }

// ── reading ──────────────────────────────────────────────────

const rsOf = doc => { try { return doc?.getFlag?.(MOD, "rs") || null } catch { return null } }
const collection = (scene, type) => (type === "Note" ? scene.notes : type === "Tile" ? scene.tiles : scene.drawings)

export function viewsOf(scene) {
  const f = scene?.getFlag?.(MOD, "mapViews")
  return { views: Array.isArray(f?.views) ? f.views : [], current: f?.current || ALL }
}

function sentDocs(scene, id = null) {
  const out = []
  for (const type of DOC_TYPES) {
    for (const doc of collection(scene, type)) {
      const rs = rsOf(doc)
      if (rs && (id == null || rs.id === id)) out.push({ type, doc, rs })
    }
  }
  return out
}

// One entry per sent thing (its documents share the same rs).
function sentItems(scene) {
  const by = new Map()
  for (const { rs } of sentDocs(scene)) {
    if (!by.has(rs.id)) by.set(rs.id, { id: rs.id, kind: rs.kind, name: rs.name || null, views: rs.views || [], gm: !!rs.gm, sentAt: rs.sentAt || null })
  }
  return [...by.values()]
}

const inView = (rs, current) => current === ALL || !current || (rs.views || []).includes(current)

function sceneOf(msg) {
  const scene = msg.sceneId ? game.scenes.get(msg.sceneId) : game.scenes.active
  if (!scene) throw new Error("Scene not found: " + (msg.sceneId || "(no active scene)"))
  return scene
}

function stateReply(scene) {
  const st = viewsOf(scene)
  return { sceneId: scene.id, views: st.views, current: st.current, items: sentItems(scene) }
}

/** `mapviews.state { sceneId }` → { sceneId, views, current, items: [{ id, kind, name, views, gm, sentAt }] } */
export function mapViewsState(msg) { return stateReply(sceneOf(msg)) }

// ── views ────────────────────────────────────────────────────

function freeName(views, name, exceptId = null) {
  const base = String(name || "").trim() || "New view"
  const taken = new Set(views.filter(v => v.id !== exceptId).map(v => v.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let i = 2
  while (taken.has(`${base} ${i}`.toLowerCase())) i++
  return `${base} ${i}`
}

function nextId(views) {
  let n = 0
  for (const v of views) { const m = /^v(\d+)$/.exec(v.id); if (m) n = Math.max(n, +m[1]) }
  return "v" + (n + 1)
}

// Write rs.views on every document of the things `fn` changes. fn(rs) → new views array or null (no change).
async function rewriteViews(scene, fn) {
  for (const type of DOC_TYPES) {
    const updates = []
    for (const doc of collection(scene, type)) {
      const rs = rsOf(doc)
      if (!rs) continue
      const views = fn(rs)
      if (views) updates.push({ _id: doc.id, [`flags.${MOD}.rs.views`]: views })
    }
    if (updates.length) await scene.updateEmbeddedDocuments(type, updates)
  }
}

/**
 * `mapviews.set { sceneId, op, … }` — GM only. → the new state (as mapviews.state), plus `id` for "add".
 *   add { name }  ·  rename { id, name }  ·  delete { id } (its things stay, under All)
 *   move { id, delta }  ·  pick { id } ("all" or a view: what players see)
 */
export async function mapViewsSet(msg) {
  if (!game.user?.isGM) throw new Error("Only the GM can change map views")
  const scene = sceneOf(msg)
  const st = viewsOf(scene)
  let views = [...st.views], current = st.current, newId = null
  switch (msg.op) {
    case "add":
      newId = nextId(views)
      views.push({ id: newId, name: freeName(views, msg.name) })
      break
    case "rename":
      if (!String(msg.name || "").trim()) break
      views = views.map(v => (v.id === msg.id ? { ...v, name: freeName(views, msg.name, v.id) } : v))
      break
    case "delete":
      views = views.filter(v => v.id !== msg.id)
      if (current === msg.id) current = ALL
      await rewriteViews(scene, rs => ((rs.views || []).includes(msg.id) ? rs.views.filter(v => v !== msg.id) : null))
      break
    case "move": {
      const i = views.findIndex(v => v.id === msg.id), j = i + (Number(msg.delta) || 0)
      if (i >= 0 && j >= 0 && j < views.length) [views[i], views[j]] = [views[j], views[i]]
      break
    }
    case "pick":
      if (msg.id === ALL || views.some(v => v.id === msg.id)) current = msg.id
      break
    default:
      throw new Error("Unknown map views change: " + msg.op)
  }
  await scene.setFlag(MOD, "mapViews", { views, current })
  await applyMarkerArt(scene)
  return { ...stateReply(scene), id: newId }
}

// ── sending ──────────────────────────────────────────────────

async function deleteDocs(scene, list) {
  for (const type of DOC_TYPES) {
    const ids = list.filter(d => d.type === type).map(d => d.doc.id)
    if (ids.length) await scene.deleteEmbeddedDocuments(type, ids)
  }
}

// Earlier copies of this thing: its own sends, and the old settlement.push / road.push copies of it.
function staleOf(scene, id) {
  const out = sentDocs(scene, id)
  for (const type of DOC_TYPES) {
    for (const doc of collection(scene, type)) {
      if (rsOf(doc)) continue
      if (doc.getFlag(MOD, "settlementId") === id || doc.getFlag(MOD, "routeId") === id) out.push({ type, doc, rs: null })
    }
  }
  return out
}

/**
 * `map.send { sceneId, kind, id, name, into?, views?, gm, sentAt, payload }` — send (or re-send) one thing.
 * `into` = the view it lands in ("none"/absent = in no view); it keeps the views it was already in.
 * `views` (optional) sets them outright instead. payload = lib/foundryMapViews settlement/route/nation
 * payload; a settlement's `art: { rs, more }` = its two ink pictures (already uploaded).
 * → { id, views, ids }
 */
export async function mapSend(msg) {
  if (!B) throw new Error("Map builders not ready")
  const scene = sceneOf(msg)
  const kind = String(msg.kind || "")
  if (!KINDS.includes(kind)) throw new Error("Can't send a " + kind)
  const id = String(msg.id || "")
  if (!id) throw new Error("Nothing to send (no id)")
  const known = new Set(viewsOf(scene).views.map(v => v.id))
  const stale = staleOf(scene, id)
  let views
  if (Array.isArray(msg.views)) views = msg.views.filter(v => known.has(v))
  else {
    views = [...new Set(stale.flatMap(s => s.rs?.views || []))].filter(v => known.has(v))
    if (msg.into && msg.into !== NONE && known.has(msg.into) && !views.includes(msg.into)) views.push(msg.into)
  }
  const gm = !!msg.gm
  const p = msg.payload || {}
  const art = kind === "settlement" && p.art?.rs ? { rs: String(p.art.rs), more: String(p.art.more || p.art.rs) } : null
  const rs = { id, kind, name: msg.name || p.name || null, views, gm, sentAt: msg.sentAt || null, ...(art ? { art } : {}) }
  const tag = { rs }
  await deleteDocs(scene, stale)
  let ids
  if (kind === "settlement") ids = await B.settlement(scene, art ? { ...p, iconSrc: art.rs, iconTint: "#ffffff" } : p, tag, gm)
  else if (kind === "nation") ids = await B.nation(scene, p, tag, gm)
  else ids = await B.route(scene, p, tag, gm)
  await applyMarkerArt(scene)
  return { id, views, ids }
}

/** `map.views { sceneId, id, add?, remove? }` — put a sent thing into / take it out of a view, no re-send. */
export async function mapViewsEdit(msg) {
  const scene = sceneOf(msg)
  const known = new Set(viewsOf(scene).views.map(v => v.id))
  let out = null
  await rewriteViews(scene, rs => {
    if (rs.id !== msg.id) return null
    let views = (rs.views || []).filter(v => known.has(v))
    if (msg.add && known.has(msg.add) && !views.includes(msg.add)) views = [...views, msg.add]
    if (msg.remove) views = views.filter(v => v !== msg.remove)
    out = views
    return views
  })
  if (!out) throw new Error("That isn't on this scene")
  await applyMarkerArt(scene)
  return { id: msg.id, views: out }
}

/** `map.remove { sceneId, id }` — take a sent thing off the scene (every view). */
export async function mapRemove(msg) {
  const scene = sceneOf(msg)
  const stale = staleOf(scene, String(msg.id || ""))
  await deleteDocs(scene, stale)
  await applyMarkerArt(scene)
  return { id: msg.id, removed: stale.length }
}

/** `map.reveal { sceneId, id }` — the GM's canvas goes to the scene and pans to the thing. */
export async function mapReveal(msg) {
  const scene = sceneOf(msg)
  const list = sentDocs(scene, String(msg.id || ""))
  if (!list.length) throw new Error("That isn't on this scene")
  // a town's marker first (its Tile, or an older Note), else the first of its drawings
  const { type, doc } = list.find(d => d.type === "Tile" || d.type === "Note") || list[0]
  const x = type === "Note" ? doc.x : type === "Tile" ? doc.x + (doc.width || 0) / 2 : doc.x + (doc.shape?.width || 0) / 2
  const y = type === "Note" ? doc.y : type === "Tile" ? doc.y + (doc.height || 0) / 2 : doc.y + (doc.shape?.height || 0) / 2
  if (canvas?.scene?.id !== scene.id) await scene.view()
  try { await canvas.animatePan({ x, y }) } catch {}
  try { canvas.ping?.({ x, y }) } catch {}
  return { id: msg.id, x, y }
}

// ── marker colour ────────────────────────────────────────────

// GM only (players can't update the scene). Borders in the view on screen → the RealmScreen colours,
// none → "more". Only touches markers (Tiles, older Notes) whose picture would change.
async function applyMarkerArt(scene) {
  if (!game.user?.isGM) return
  const { current } = viewsOf(scene)
  const docs = sentDocs(scene)
  const borders = docs.some(d => d.rs.kind === "nation" && inView(d.rs, current))
  const updates = { Tile: [], Note: [] }
  for (const { type, doc, rs } of docs) {
    if (!updates[type] || !rs.art) continue
    const want = borders ? rs.art.rs : rs.art.more
    if (want && doc.texture?.src !== want) updates[type].push({ _id: doc.id, "texture.src": want })
  }
  for (const [type, list] of Object.entries(updates)) if (list.length) await scene.updateEmbeddedDocuments(type, list)
}

// ── who sees what (every client) ─────────────────────────────

export function showEverything() {
  try { return !!game.user?.isGM && !!game.settings.get(MOD, "mapViewsShowAll") } catch { return false }
}

export async function setShowEverything(on) {
  await game.settings.set(MOD, "mapViewsShowAll", !!on)
  refreshSent()
}

// false = keep it off the canvas; null = not ours, leave Foundry's own rule.
function sentVisible(doc) {
  const rs = rsOf(doc)
  if (!rs) return null
  if (rs.gm && !game.user?.isGM) return false
  if (game.user?.isGM && showEverything()) return null
  return inView(rs, viewsOf(doc.parent).current) ? null : false
}

function applyRule(obj) {
  if (sentVisible(obj?.document) === false || !inNameZoom(obj?.document)) obj.visible = false
  inkPin(obj)
  labelLook(obj)
}

// Town and nation names styled like RealmScreen's map, not Foundry's default text (an outline that turns WHITE on
// dark text, plus a blurred drop shadow). flags[MOD].labelStyle = { weight, italic, letterSpacing, stroke,
// strokeRatio, shadow }. Foundry rebuilds the text style on every refresh (Drawing#_refreshText), and this
// runs in the refresh hook right after, so it holds.
function labelLook(obj) {
  const t = obj?.text
  let ls = null
  try { ls = obj?.document?.getFlag?.(MOD, "labelStyle") || null } catch { ls = null }
  if (!t?.style || !ls) return
  const s = t.style
  const fs = Number(obj.document.fontSize) || s.fontSize || 24
  s.fontWeight = String(ls.weight ?? 700)
  s.fontStyle = ls.italic ? "italic" : "normal"
  s.letterSpacing = Number(ls.letterSpacing) || 0
  s.stroke = ls.stroke || "rgba(0,0,0,0.7)"
  s.strokeThickness = Math.max(1, fs * (Number(ls.strokeRatio) || 0.12))
  s.lineJoin = "round"
  if (ls.shadow) {
    s.dropShadow = true; s.dropShadowColor = "#000000"; s.dropShadowAlpha = 0.9
    s.dropShadowBlur = Math.max(1, fs * 0.18); s.dropShadowDistance = Math.max(0.5, fs * 0.06); s.dropShadowAngle = Math.PI / 2
  } else s.dropShadow = false
}

// ── names that come and go with zoom, as on RealmScreen's map ──
// A nation's name carries flags[MOD].nameZoom = { min, max } in RealmScreen's map zoom (1 = the whole map
// fits the window). Foundry's equivalent: the canvas scale over the scale at which the scene fits the screen.
// Same rule as pendant-home lib/zoomBand.mjs inZoomBand: from min, gone from max; 0.2 / 30 = no limit.
const ZMIN = 0.2, ZMAX = 30
function mapZoom() {
  const d = canvas?.dimensions, scr = canvas?.app?.renderer?.screen
  const scale = canvas?.stage?.scale?.x
  if (!d?.sceneWidth || !scr?.width || !scale) return 1
  return scale / Math.min(scr.width / d.sceneWidth, scr.height / d.sceneHeight)
}
function inNameZoom(doc, z = mapZoom()) {
  let band = null
  try { band = doc?.getFlag?.(MOD, "nameZoom") || null } catch { band = null }
  if (!band) return true
  const lo = Number.isFinite(band.min) ? band.min : ZMIN, hi = Number.isFinite(band.max) ? band.max : ZMAX
  return z >= lo - 1e-6 && (hi >= ZMAX - 1e-6 || z < hi - 1e-6)
}
// On zoom: re-run the refresh of each name whose side of its band changed (Foundry works out its own
// visibility first, then the rules above apply), so panning alone costs a comparison per name.
const nameSide = new Map()
function zoomNames() {
  if (!canvas?.ready) return
  const z = mapZoom()
  for (const obj of canvas.drawings?.placeables || []) {
    const doc = obj.document
    if (!doc?.flags?.[MOD]?.nameZoom) continue
    const inside = inNameZoom(doc, z)
    if (nameSide.get(doc.id) === inside) continue
    nameSide.set(doc.id, inside)
    if (obj.renderFlags?.set) obj.renderFlags.set({ refreshState: true })
    else { try { obj.refresh() } catch {} }
  }
}

// An ink marker (rs.art) is the drawing alone, like on RealmScreen's map: no dark square behind it and no
// border except while it's hovered or picked. Foundry's ControlIcon redraws its `bg` and `border` but never
// sets their `visible`, so this sticks between refreshes.
function inkPin(obj) {
  const icon = obj?.controlIcon
  if (!icon || !rsOf(obj.document)?.art) return
  if (icon.bg) icon.bg.visible = false
  if (icon.border) icon.border.visible = !!(obj.hover || obj.controlled || obj.layer?.highlightObjects)
}

// Re-run every sent thing's refresh (the rule runs in its refresh hook).
export function refreshSent() {
  if (!canvas?.ready) return
  for (const layer of [canvas.drawings, canvas.tiles, canvas.notes]) {
    for (const obj of layer?.placeables || []) {
      if (!rsOf(obj.document)) continue
      if (obj.renderFlags?.set) obj.renderFlags.set({ refreshState: true })
      else { try { obj.refresh() } catch {} }
      applyRule(obj)
    }
  }
}

Hooks.once("init", () => {
  game.settings.register(MOD, "mapViewsShowAll", {
    name: "Map views: show me everything", scope: "client", config: false, type: Boolean, default: false,
  })
})
Hooks.on("refreshDrawing", applyRule)
Hooks.on("refreshNote", applyRule)
Hooks.on("refreshTile", applyRule)
Hooks.on("canvasReady", () => { nameSide.clear(); refreshSent() })
Hooks.on("canvasPan", () => zoomNames())
Hooks.on("updateScene", (scene, changes) => {
  if (scene?.id !== canvas?.scene?.id) return
  if (changes?.flags?.[MOD] && "mapViews" in changes.flags[MOD]) refreshSent()
})
