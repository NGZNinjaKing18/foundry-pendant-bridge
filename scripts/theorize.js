// ──────────────────────────────────────────────────────────────
// Theorize a trip — draw a possible route from a token and see what it would take (pendant-home
// _handoffs/theorize-trip-mockup.html, approved 2026-11-02).
//
// Start from a token you control (the GM: any): its right-click HUD button, the "Theorize a trip" key
// (Shift+R to start; Configure Controls), or RealmScreen controls › Theorize a trip and a click on the token. A line
// follows the cursor. Click (or F, as Foundry's own ruler) to bend it. Hover a road and it lights up; click ON it
// and the line locks to it and follows it as you move (click on the road again = a stop, stay on it; click off it
// = leave the road there). Drag a corner to move it. Right-click, Alt+F or Backspace takes back the last click;
// double-click or Enter finishes; Esc cancels. Pace + rushing: the bar at the bottom (or 1 / 2 / 3, R).
//
// RealmScreen prices the line as it lies (`trip.line`: painted ground, roads on it, water, the map's own
// cell size) and hands back the roads to snap to (`trip.roads` — a player gets only the roads players may
// see). Foundry never works a trip out. Nothing is saved: the finish card offers Plan this trip (the trip
// card, going exactly along the line), Show the table (chat) or Just looking.
//
// While drawing, everyone else on the scene sees the line live (each viewer's own setting can turn that off
// for what THEY draw: "Others see my theorized line"), over the module socket: { t: "theo.line" | "theo.clear" }.
// Drawn on canvas.interface (above tokens), in screen-constant widths.
// ──────────────────────────────────────────────────────────────

import { realmLive } from "./live.js"
import { askRealm, openTripCard } from "./trips.js"

const MOD = "pendant-bridge"
const CHANNEL = `module.${MOD}`
const SNAP_PX = 14                 // how close (screen px) a click must be to lock onto a road
const CLICK_PX = 5                 // a press that moves less than this is a click, not a drag
const DBL_MS = 230
const ACCENT = 0xff6400

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const hex = (c) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : ACCENT)

// ── the switch ────────────────────────────────────────────────
let on = false
export const theorizeOn = () => on
export function setTheorize(v) {
  on = !!v
  S.auto = false
  if (!on) cancel()
  hint()
}
/** Start from a token without the switch (its HUD button, the key): on for this one line, off again after. */
export function theorizeFrom(token) {
  if (!token || !realmLive()) { ui.notifications?.warn("RealmScreen isn’t connected — ask your GM to open it."); return }
  if (!on) { on = true; S.auto = true }
  start(token)
}
const autoOff = () => { if (S.auto) { S.auto = false; on = false; hint() } }
Hooks.once("init", () => {
  game.settings.register(MOD, "theorizeShare", {
    name: "Others see my theorized line",
    hint: "While you draw with Theorize a trip, everyone else on the scene sees your line live.",
    scope: "client", config: true, type: Boolean, default: true,
  })
})
Hooks.once("init", () => {
  game.keybindings?.register?.(MOD, "theorize", {
    name: "Theorize a trip",
    hint: "Draw a possible route from the selected token; RealmScreen prices it.",
    editable: [{ key: "KeyR", modifiers: ["Shift"] }],
    onDown: () => {
      const t = canvas.tokens?.controlled?.[0]
      if (!t || !realmLive() || S.drawing) return false
      theorizeFrom(t)
      return true
    },
  })
})
// The token HUD (right-click a token): a Theorize button with Foundry's own HUD buttons.
Hooks.on("renderTokenHUD", (hud, html) => {
  if (!realmLive()) return
  const root = html instanceof HTMLElement ? html : html?.[0]
  const col = root?.querySelector?.(".col.left") || root?.querySelector?.(".left")
  const token = hud.object
  if (!col || !token || (!game.user?.isGM && !token.document?.isOwner) || col.querySelector(".pb-theo-hud")) return
  const b = document.createElement("button")
  b.type = "button"; b.className = "control-icon pb-theo-hud"; b.dataset.tooltip = "Theorize a trip"
  b.innerHTML = `<i class="fa-solid fa-draw-polygon"></i>`
  b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); hud.close?.(); theorizeFrom(token) })
  col.appendChild(b)
})
const shareOn = () => { try { return game.settings.get(MOD, "theorizeShare") !== false } catch { return true } }

// ── geometry (scene px) ───────────────────────────────────────
function dims() {
  const d = canvas.scene?.dimensions
  return d ? { x: d.sceneX, y: d.sceneY, w: d.sceneWidth, h: d.sceneHeight } : null
}
const toNorm = (p, d) => [(p[0] - d.x) / d.w, (p[1] - d.y) / d.h]
const fromNorm = (p, d) => [d.x + p[0] * d.w, d.y + p[1] * d.h]
const scale = () => canvas.stage?.scale?.x || 1
function lengths(pts) { const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return L }
/** A polyline's nearest point to p → { d, pt, s } (s = distance along it). Exported for tests. */
export function nearestOn(pts, L, p) {
  let best = { d: Infinity, pt: null, s: 0 }
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2)), x = ax + t * dx, y = ay + t * dy, d = Math.hypot(p[0] - x, p[1] - y)
    if (d < best.d) best = { d, pt: [x, y], s: L[i - 1] + t * Math.sqrt(L2) }
  }
  return best
}
function pointAt(pts, L, s) {
  for (let i = 1; i < pts.length; i++) if (s <= L[i] + 1e-9) { const t = (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1); return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])] }
  return pts[pts.length - 1].slice()
}
/** The stretch of a polyline between two distances along it, either way. Exported for tests. */
export function stretch(pts, L, s0, s1) {
  const out = [pointAt(pts, L, s0)], fwd = s1 >= s0
  const mid = []
  for (let i = 0; i < pts.length; i++) if (fwd ? (L[i] > s0 && L[i] < s1) : (L[i] < s0 && L[i] > s1)) mid.push(i)
  if (!fwd) mid.reverse()
  for (const i of mid) out.push(pts[i].slice())
  out.push(pointAt(pts, L, s1))
  return out
}
/** The part of a polyline between fractions f0…f1 of its length (for colouring by RealmScreen's legs). */
export function slice(pts, L, f0, f1) { const T = L[L.length - 1] || 1; return stretch(pts, L, f0 * T, f1 * T) }

// ── state ─────────────────────────────────────────────────────
const S = {
  drawing: false, token: null, sceneId: null, key: null, name: "",
  roads: [], paces: [], cell: null, baseHpd: 8,
  pieces: [],                      // [{ pts: [[x, y]…] (scene px), road: index | null }] — one per click
  lock: null,                      // { r: road index, s } — the road the line follows from distance s
  cursor: null, client: null,      // scene px · client px (for the read-out)
  pace: "foot", rush: false,
  quote: null, ver: 0, asking: false, again: false, error: null,
}
const lastPt = () => { const p = S.pieces[S.pieces.length - 1]; return p ? p.pts[p.pts.length - 1] : S.origin }
function preview() {
  if (!S.cursor) return null
  if (S.lock) {
    const r = S.roads[S.lock.r], n = nearestOn(r.pts, r.L, S.cursor)
    return { pts: stretch(r.pts, r.L, S.lock.s, n.s), road: S.lock.r, s1: n.s }
  }
  return { pts: [lastPt(), S.cursor], road: null }
}
/** Every click's piece (+ the one following the cursor) as ONE polyline, no repeated points. */
function fullPath(withPreview = true) {
  const out = [S.origin]
  const pv = withPreview ? preview() : null
  for (const pc of pv ? [...S.pieces, pv] : S.pieces) for (const p of pc.pts) { const l = out[out.length - 1]; if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.5) out.push(p) }
  return out
}
function nearestRoad(p) {
  let best = null
  S.roads.forEach((r, i) => { const n = nearestOn(r.pts, r.L, p); if (!best || n.d < best.n.d) best = { i, n } })
  return best
}
const hpd = () => (S.rush ? Math.max(10, S.baseHpd + 2) : S.baseHpd)

// ── drawing on the canvas ─────────────────────────────────────
let G = null
function layer() {
  if (G && !G.destroyed && G.parent) return G
  const host = canvas.interface || canvas.controls || canvas.stage
  G = new PIXI.Container()
  G.eventMode = "none"
  G.others = G.addChild(new PIXI.Graphics())
  G.line = G.addChild(new PIXI.Graphics())
  G.marks = G.addChild(new PIXI.Container())
  host.addChild(G)
  return G
}
const others = new Map()          // userId → { pts (norm), color, name }
function drawOthers() {
  const g = layer().others, d = dims(), k = 1 / scale()
  g.clear()
  if (!d) return
  for (const [, o] of others) {
    if (o.sceneId !== canvas.scene?.id || !Array.isArray(o.pts) || o.pts.length < 2) continue
    const pts = o.pts.map(p => fromNorm(p, d))
    g.lineStyle({ width: 4 * k, color: hex(o.color), alpha: o.shown ? 0.9 : 0.55, cap: "round", join: "round" })
    g.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) g.lineTo(p[0], p[1])
  }
}
function draw() {
  const L0 = layer()
  const g = L0.line, k = 1 / scale()
  g.clear()
  L0.marks.removeChildren().forEach(c => c.destroy?.())
  drawOthers()
  if (!S.drawing && !S.kept) return
  const pts = S.kept ? S.kept.pts : fullPath()
  if (pts.length < 2) return
  const L = lengths(pts)
  const q = S.kept ? S.kept.quote : (S.quote && S.quote.ver === S.ver ? S.quote : null)
  // the line: dark under-stroke, then each leg in its tone (or the accent while RealmScreen works it out)
  g.lineStyle({ width: 8 * k, color: 0x111111, alpha: 0.55, cap: "round", join: "round" })
  g.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) g.lineTo(p[0], p[1])
  const legs = q && Array.isArray(q.legs) && q.legs.length ? q.legs : [{ f0: 0, f1: 1, tone: null }]
  for (const l of legs) {
    const part = slice(pts, L, l.f0, l.f1)
    g.lineStyle({ width: 5 * k, color: l.tone ? hex(l.tone) : ACCENT, alpha: l.kind === "blocked" ? 0.6 : 0.95, cap: "round", join: "round" })
    g.moveTo(part[0][0], part[0][1]); for (const p of part.slice(1)) g.lineTo(p[0], p[1])
  }
  // corners
  if (!S.kept) S.pieces.forEach((pc, i) => {
    const e = pc.pts[pc.pts.length - 1], can = draggable(i), hot = i === S.hotCorner || i === S.dragging
    g.lineStyle({ width: (hot ? 2.5 : 1.5) * k, color: hot ? ACCENT : 0x111111 }); g.beginFill(0xffffff); g.drawCircle(e[0], e[1], (can ? 6 : 4.5) * k); g.endFill()
  })
  // day marks: a ring and the day's number where each travel day ends
  for (const [i, f] of ((q && q.days) || []).entries()) {
    const p = pointAt(pts, L, f * L[L.length - 1])
    g.lineStyle({ width: 2 * k, color: 0xff9a3c }); g.beginFill(0x111111, 0.9); g.drawCircle(p[0], p[1], 9 * k); g.endFill()
    const t = new PIXI.Text(String(i + 1), { fontFamily: "Signika", fontSize: 22, fontWeight: "bold", fill: 0xff9a3c })
    t.anchor.set(0.5); t.scale.set(0.5 * k); t.position.set(p[0], p[1])
    L0.marks.addChild(t)
  }
  // snapping: a ring on the road under the cursor; while locked, a thin tie from the cursor to the road
  if (S.drawing && S.cursor) {
    if (!S.lock) {
      const nr = S.dragging == null ? nearestRoad(S.cursor) : null
      if (nr && nr.n.d * scale() < SNAP_PX) {
        const r = S.roads[nr.i]
        g.lineStyle({ width: 7 * k, color: 0xffd27a, alpha: 0.35, cap: "round", join: "round" })
        g.moveTo(r.pts[0][0], r.pts[0][1]); for (const p of r.pts.slice(1)) g.lineTo(p[0], p[1])
        g.lineStyle({ width: 2 * k, color: 0xffd27a }); g.drawCircle(nr.n.pt[0], nr.n.pt[1], 8 * k)
      }
    } else {
      const r = S.roads[S.lock.r], n = nearestOn(r.pts, r.L, S.cursor)
      g.lineStyle({ width: 1 * k, color: 0xffd27a, alpha: 0.7 }); g.moveTo(S.cursor[0], S.cursor[1]); g.lineTo(n.pt[0], n.pt[1])
    }
  }
}
let rafT = 0
const schedule = () => { cancelAnimationFrame(rafT); rafT = requestAnimationFrame(() => { draw(); readout(); tag(); dock() }) }

// ── the read-out (HTML, follows the cursor) + the hint bar ────
const fmt = (h) => { if (!Number.isFinite(h)) return "—"; const m = Math.round(h * 60); if (m < 60) return `${m} min`; const H = Math.floor(m / 60), M = m % 60; return M ? `${H} h ${M} min` : `${H} h` }
const daysWords = (h, per) => { if (!(h > 0)) return ""; const d = Math.floor(h / per + 1e-9), rest = h - d * per; return d < 1 ? "under a day" : `${d} day${d === 1 ? "" : "s"}${rest > 0.05 ? ` + ${fmt(rest)}` : ""}` }
const cells = (mi) => (S.cell && S.cell.mi > 0 ? ` · ${Math.round(mi / S.cell.mi * 10) / 10} ${S.cell.noun === "hex" ? "hexes" : "squares"}` : "")
function el(id, cls) { let e = document.getElementById(id); if (!e) { e = document.createElement("div"); e.id = id; e.className = cls; document.body.appendChild(e) } return e }
function readout() {
  const R = el("pb-theo-readout", "pb-theo-readout")
  if (!S.drawing || !S.client) { R.hidden = true; return }
  const q = S.quote, fresh = q && q.ver === S.ver
  const per = hpd()
  const rows = q ? (q.legs || []).filter(l => l.miles > 0.05).slice(-6).map(l => `<div class="pb-theo-row"><span><i style="background:${esc(l.color)}"></i>${esc(l.label)}</span><span>${l.kind === "blocked" ? "—" : fmt(l.hours)}</span></div>`).join("") : ""
  R.innerHTML = `
    ${S.error ? `<p class="pb-theo-bad">${esc(S.error)}</p>` : !q ? `<p class="hint"><i class="fa-solid fa-spinner fa-spin"></i> Asking RealmScreen…</p>` : `
    <div class="pb-theo-big${fresh ? "" : " stale"}">${q.blocked ? "Can’t get there this way" : fmt(q.hours)}</div>
    <div class="hint">${q.blocked ? "" : `${esc(daysWords(q.hours, per))} at ${per} h a day · `}${Math.round(q.miles * 10) / 10} mi${cells(q.miles)}${S.lock ? ` · on <b>${esc(S.roads[S.lock.r]?.name || "a road")}</b>` : ""}</div>
    ${rows}
    ${q.blocked ? `<p class="pb-theo-bad"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(q.blocked)} — bend around it.</p>` : ""}
    ${S.rush && q.savesPerDay ? `<p class="pb-theo-warn">Rushing: ${q.savesPerDay} Con save${q.savesPerDay === 1 ? "" : "s"} a day</p>` : ""}`}
    <div class="hint">${esc((S.paces.find(p => p.key === S.pace) || {}).label || S.pace)}${S.rush ? ", rushing" : ""}</div>`
  R.hidden = false
  const x = Math.min(window.innerWidth - R.offsetWidth - 10, S.client[0] + 18), y = Math.min(window.innerHeight - R.offsetHeight - 10, S.client[1] + 18)
  R.style.left = `${Math.max(4, x)}px`; R.style.top = `${Math.max(4, y)}px`
}
// A few words beside the cursor about what a click does here: follow a road, leave it, move a corner.
function tag() {
  const T = el("pb-theo-tag", "pb-theo-tag")
  if (!S.drawing || !S.client || !S.cursor) { T.hidden = true; return }
  let words = ""
  if (S.dragging != null || S.hotCorner != null) words = "Drag to move this corner"
  else if (S.lock) {
    const r = S.roads[S.lock.r], n = nearestOn(r.pts, r.L, S.cursor)
    words = n.d * scale() < SNAP_PX ? `Click: a stop on ${r.name || "the road"}` : `Click: leave ${r.name || "the road"} here`
  } else {
    const nr = nearestRoad(S.cursor)
    if (nr && nr.n.d * scale() < SNAP_PX) words = `Click to follow ${S.roads[nr.i].name || "this road"}`
  }
  T.hidden = !words
  if (!words) return
  T.textContent = words
  T.style.left = `${S.client[0] + 16}px`; T.style.top = `${S.client[1] - 30}px`
}
// The pace + hours, as buttons at the bottom (they used to be keys only).
const PACES0 = [{ key: "foot", label: "On foot" }, { key: "horse", label: "Horse" }, { key: "ship", label: "Ship" }]
function dock() {
  const D = el("pb-theo-dock", "pb-theo-dock")
  if (!S.drawing) { D.hidden = true; return }
  const ps = S.paces.length ? S.paces : PACES0
  D.innerHTML = `${ps.map(p => `<button type="button" data-pace="${esc(p.key)}" class="${p.key === S.pace ? "active" : ""}">${esc(p.label)}</button>`).join("")}<span class="pb-theo-sep"></span><button type="button" data-rush="1" class="${S.rush ? "active" : ""}" data-tooltip="Travel ${Math.max(10, S.baseHpd + 2)} hours a day (Con saves)">Rushing</button>`
  if (!D.dataset.wired) {
    D.dataset.wired = "1"
    D.addEventListener("pointerdown", (ev) => ev.stopPropagation())
    D.addEventListener("click", (ev) => {
      const b = ev.target.closest("button"); if (!b) return
      if (b.dataset.pace) S.pace = b.dataset.pace
      if (b.dataset.rush) S.rush = !S.rush
      changed()
    })
  }
  D.hidden = false
}
function hint() {
  const H = el("pb-theo-hint", "pb-theo-hint")
  if (!on) { H.hidden = true; return }
  H.hidden = false
  H.innerHTML = !S.drawing ? `<i class="fa-solid fa-draw-polygon"></i> <b>Theorize a trip</b> — click a token to start from it`
    : S.lock ? `Following <b>${esc(S.roads[S.lock.r]?.name || "the road")}</b> — <b>click on it</b> for a stop · <b>click off it</b> to leave · right-click / <kbd>Alt</kbd>+<kbd>F</kbd> back · <kbd>Enter</kbd> done`
      : `Click or <kbd>F</kbd> to bend · <b>click a lit road</b> to follow it · drag a corner to move it · right-click / <kbd>Alt</kbd>+<kbd>F</kbd> back · double-click / <kbd>Enter</kbd> done · <kbd>Esc</kbd> cancel`
}

// ── asking RealmScreen (newest line wins; one question at a time) ──
async function requote() {
  if (!S.drawing) return
  if (S.asking) { S.again = true; return }
  const pts = fullPath(), d = dims()
  if (pts.length < 2 || !d) return
  const ver = S.ver
  S.asking = true
  try {
    const r = await askRealm("line", { sceneId: S.sceneId, key: S.key, path: pts.map(p => toNorm(p, d)), pace: S.pace, hpd: hpd() })
    if (S.drawing) { S.quote = { ...(r.line || {}), ver }; S.error = null }
  } catch (e) { S.error = e.message || String(e) }
  S.asking = false
  schedule()
  if (S.again || ver !== S.ver) { S.again = false; requote() }
}
let shareT = 0
function share(shown = false) {
  if (!shareOn() && !shown) return
  if (shareT && !shown) return                    // (at most every 120 ms while the cursor moves)
  clearTimeout(shareT)
  shareT = setTimeout(() => {
    shareT = 0
    const d = dims(), pts = S.kept ? S.kept.pts : fullPath()
    if (!d || pts.length < 2) return
    try { game.socket?.emit(CHANNEL, { t: "theo.line", user: game.user?.id, color: game.user?.color?.css ?? String(game.user?.color ?? ""), sceneId: S.sceneId, pts: pts.map(p => toNorm(p, d)), shown }) } catch { /* */ }
  }, shown ? 0 : 120)
}
function unshare() { clearTimeout(shareT); shareT = 0; try { game.socket?.emit(CHANNEL, { t: "theo.clear", user: game.user?.id }) } catch { /* */ } }
function changed() { S.ver++; schedule(); requote(); share() }

// ── start / click / back / finish / cancel ───────────────────
async function start(token) {
  const d = dims()
  if (!d || !realmLive()) { ui.notifications?.warn("RealmScreen isn’t connected — ask your GM to open it."); return }
  clearKept()
  Object.assign(S, { drawing: true, token, sceneId: canvas.scene.id, key: token.document.getFlag?.(MOD, "party")?.key || null, name: token.document.name || "", origin: [token.center.x, token.center.y], pieces: [], lock: null, quote: null, error: null, ver: 0 })
  hint(); schedule()
  try {
    const r = await askRealm("roads", { sceneId: S.sceneId, key: S.key })
    S.roads = (r.roads || []).map(x => { const pts = x.pts.map(p => fromNorm(p, d)); return { name: x.name || "", pts, L: lengths(pts) } }).filter(x => x.pts.length > 1)
    S.paces = Array.isArray(r.paces) ? r.paces : []
    S.cell = r.cell || null
    S.baseHpd = Number(r.hpd) || 8
  } catch (e) { S.error = e.message || String(e) }
  changed()
}
function click(p) {
  const snap = SNAP_PX / scale()
  if (S.lock) {
    const r = S.roads[S.lock.r], n = nearestOn(r.pts, r.L, p), pv = preview()
    if (n.d < snap) { S.pieces.push({ pts: pv.pts, road: S.lock.r }); S.lock = { r: S.lock.r, s: pv.s1 } }   // a stop on the road: stay on it
    else { S.pieces.push({ pts: stretch(r.pts, r.L, S.lock.s, n.s), road: S.lock.r }); S.pieces.push({ pts: [lastPt(), p], road: null }); S.lock = null }   // off it: leave there
  } else {
    const nr = nearestRoad(p)
    if (nr && nr.n.d < snap) { S.pieces.push({ pts: [lastPt(), nr.n.pt], road: null }); S.lock = { r: nr.i, s: nr.n.s } }   // onto a road: follow it
    else S.pieces.push({ pts: [lastPt(), p], road: null })
  }
  hint(); changed()
}
// A corner between two free stretches can be dragged (one that starts or ends a stretch of road can't —
// that point belongs to the road).
function draggable(i) {
  const a = S.pieces[i], b = S.pieces[i + 1]
  return !!a && a.road == null && (!b || b.road == null) && !(i === S.pieces.length - 1 && S.lock)
}
function cornerAt(p) {
  const r = 9 / scale()
  for (let i = S.pieces.length - 1; i >= 0; i--) {
    if (!draggable(i)) continue
    const e = S.pieces[i].pts[S.pieces[i].pts.length - 1]
    if (Math.hypot(e[0] - p[0], e[1] - p[1]) < r) return i
  }
  return null
}
function moveCorner(i, p) {
  const a = S.pieces[i], b = S.pieces[i + 1]
  a.pts[a.pts.length - 1] = p.slice()
  if (b) b.pts[0] = p.slice()
}
function back() {
  if (S.lock) S.lock = null
  else if (S.pieces.length) S.pieces.pop()
  else { cancel(); return }
  // (backing onto the end of a stretch of road picks that road back up)
  const lp = S.pieces[S.pieces.length - 1]
  if (lp && lp.road != null) { const r = S.roads[lp.road]; S.lock = { r: lp.road, s: nearestOn(r.pts, r.L, lastPt()).s } }
  hint(); changed()
}
export function cancel() {
  if (S.drawing) unshare()
  Object.assign(S, { drawing: false, pieces: [], lock: null, cursor: null, client: null, quote: null, error: null, dragging: null, hotCorner: null })
  autoOff(); hint(); schedule()
}
// What stays on the board after finishing (until the next line, Esc, or the switch off).
function clearKept() { if (S.kept) { S.kept = null; unshare() } }
async function finish() {
  if (!S.drawing || !S.pieces.length) return
  const pts = fullPath(false), d = dims()
  // the final price, for exactly the clicked line (not the cursor's)
  let q = null, err = null
  try { q = (await askRealm("line", { sceneId: S.sceneId, key: S.key, path: pts.map(p => toNorm(p, d)), pace: S.pace, hpd: hpd() })).line || null } catch (e) { err = e.message || String(e) }
  const drop = { sceneId: S.sceneId, key: S.key, name: S.name, by: S.pace, hpd: hpd(), path: pts.map(p => toNorm(p, d)), end: toNorm(pts[pts.length - 1], d) }
  S.kept = { pts, quote: q }
  Object.assign(S, { drawing: false, pieces: [], lock: null, cursor: null, client: null, dragging: null, hotCorner: null })
  autoOff(); hint(); schedule()
  if (shareOn()) share()
  openCard({ drop, q, err, per: drop.hpd })
}

// ── the finish card ───────────────────────────────────────────
let Card = null, card = null
function openCard(data) {
  const AppV2 = globalThis.foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return
  if (!Card) {
    Card = class TheorizeCard extends AppV2 {
      static DEFAULT_OPTIONS = {
        id: "pb-theorize-card", classes: ["pb-trip", "pb-theo"],
        window: { title: "Theorize a trip", icon: "fa-solid fa-draw-polygon" },
        position: { width: 400, height: "auto" },
        actions: { look: TheorizeCard.onLook, plan: TheorizeCard.onPlan, show: TheorizeCard.onShow },
      }
      async _renderHTML() {
        const { drop, q, err, per } = this.data
        const e = document.createElement("div")
        const legs = q ? (q.legs || []).filter(l => l.miles > 0.05) : []
        const canPlan = !!(q && !q.blocked && drop.key)
        e.innerHTML = `
          <p class="pb-trip-head"><strong>${esc(drop.name || "Token")}</strong> <i class="fa-solid fa-arrow-right"></i> a possible route · ${esc((S.paces.find(p => p.key === drop.by) || {}).label || drop.by)}${per > S.baseHpd ? ", rushing" : ""}</p>
          ${err ? `<p class="pb-trip-bad">${esc(err)}</p>` : !q ? "" : `
          <div class="pb-theo-big">${q.blocked ? "Can’t get there this way" : fmt(q.hours)}</div>
          <p class="hint">${q.blocked ? esc(q.blocked) + " on the line" : `${esc(daysWords(q.hours, per))} at ${per} h a day`} · ${Math.round(q.miles * 10) / 10} mi${cells(q.miles)}</p>
          <div class="pb-theo-legs">${legs.map(l => `<div class="pb-theo-row"><span><i style="background:${esc(l.color)}"></i>${esc(l.label)}</span><span>${l.kind === "blocked" ? "—" : fmt(l.hours)} · ${Math.round(l.miles * 10) / 10} mi</span></div>`).join("")}</div>`}
          <p class="hint">Priced by RealmScreen. Nothing is saved unless you plan it.${drop.key ? "" : " (Plan this trip is for RealmScreen’s people — this token isn’t one.)"}</p>
          <footer class="form-footer">
            <button type="button" data-action="look"><i class="fa-solid fa-eye"></i> Just looking</button>
            <button type="button" data-action="plan" ${canPlan ? "" : "disabled"}><i class="fa-solid fa-route"></i> Plan this trip</button>
            <button type="button" data-action="show" ${q ? "" : "disabled"}><i class="fa-solid fa-comment"></i> Show the table</button>
          </footer>`
        return e
      }
      _replaceHTML(result, content) { content.replaceChildren(result) }
      static onLook() { this.close() }
      static onPlan() {
        const { drop } = this.data
        this.keep = false
        this.close()
        openTripCard({ sceneId: drop.sceneId, key: drop.key, nx: drop.end[0], ny: drop.end[1], name: drop.name, path: drop.path, by: drop.by, hpd: drop.hpd })
      }
      static async onShow() {
        const { drop, q, per } = this.data
        if (!q) return
        const legs = (q.legs || []).filter(l => l.miles > 0.05).map(l => `${esc(l.label)} ${l.kind === "blocked" ? "—" : fmt(l.hours)}`).join(" · ")
        try {
          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ token: S.token?.document }),
            content: `<div class="pb-theo-chat"><p><i class="fa-solid fa-draw-polygon"></i> <strong>A possible route</strong> for ${esc(drop.name || "them")}</p>
              <p><strong>${q.blocked ? "Can’t get there this way" : fmt(q.hours)}</strong>${q.blocked ? ` — ${esc(q.blocked)}` : ` (${esc(daysWords(q.hours, per))} at ${per} h a day)`}, ${Math.round(q.miles * 10) / 10} mi${cells(q.miles)}</p><p>${legs}</p></div>`,
          })
        } catch (e) { ui.notifications?.warn(`Couldn’t post it (${e.message || e}).`) }
        this.keep = true
        share(true)                 // everyone sees the line until it's cleared
        this.close()
      }
      async close(options) {
        if (!this.keep) clearKept()
        schedule()
        card = null
        return super.close(options)
      }
    }
  }
  card?.close?.()
  card = new Card()
  card.data = data
  card.render({ force: true })
}

// ── input: the canvas element, before Foundry sees it ─────────
let down = null, clickT = null
const onCanvas = (ev) => !!canvas?.ready && ev.target === canvas.app?.view
function scenePoint(ev) {
  const p = canvas.canvasCoordinatesFromClient ? canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY }) : canvas.stage.toLocal({ x: ev.clientX, y: ev.clientY })
  return [p.x, p.y]
}
function tokenAt(p) {
  const mine = (t) => game.user?.isGM || t.document?.isOwner
  const hits = (canvas.tokens?.placeables || []).filter(t => t.visible && mine(t) && t.bounds?.contains?.(p[0], p[1]))
  return hits.sort((a, b) => (b.document.sort ?? 0) - (a.document.sort ?? 0))[0] || null
}
function onDown(ev) {
  if (!on || !onCanvas(ev)) return
  down = { x: ev.clientX, y: ev.clientY, button: ev.button }
  if (ev.button !== 0) return                      // right-drag still pans
  if (S.drawing) {
    ev.stopPropagation(); ev.preventDefault()
    const i = cornerAt(scenePoint(ev))
    if (i != null) S.dragging = i                 // (a corner grabbed: moving drags it; letting go without moving is a click)
    return
  }
  const t = tokenAt(scenePoint(ev))
  if (t) { ev.stopPropagation(); ev.preventDefault(); start(t) }
}
function onUp(ev) {
  if (!on || !down) return
  const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > CLICK_PX, b = down.button
  down = null
  if (S.dragging != null) {                       // a corner grabbed: moved = it's moved; not moved = nothing (no double corner)
    S.dragging = null
    ev.stopPropagation()
    changed()
    return
  }
  if (!S.drawing || moved || !onCanvas(ev)) return
  if (b === 2) { back(); return }
  if (b !== 0) return
  ev.stopPropagation()
  const p = scenePoint(ev)
  if (clickT) { clearTimeout(clickT); clickT = null; click(p); finish(); return }   // a double-click: that point, then done
  clickT = setTimeout(() => { clickT = null; click(p) }, DBL_MS)
}
function onMove(ev) {
  if (!on || !S.drawing || !onCanvas(ev)) return
  S.cursor = scenePoint(ev); S.client = [ev.clientX, ev.clientY]
  if (S.dragging != null && down) moveCorner(S.dragging, S.cursor)
  const hot = S.dragging != null ? S.dragging : cornerAt(S.cursor)
  S.hotCorner = hot
  const view = canvas.app?.view
  if (view) view.style.cursor = S.dragging != null ? "grabbing" : hot != null ? "grab" : ""
  changed()                                        // redraw, and RealmScreen prices the line under the cursor as it goes
}
function onKey(ev) {
  if (!on) return
  const tag = ev.target?.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ev.target?.isContentEditable) return
  if (!S.drawing) { if (ev.key === "Escape" && S.kept) { clearKept(); card?.close?.(); schedule() } return }
  const k = ev.key
  // Foundry's own ruler keys: F places a waypoint (here: a corner at the cursor), Alt+F takes the last one back
  if (ev.code === "KeyF" && !ev.ctrlKey && !ev.metaKey) { if (ev.altKey) back(); else if (S.cursor) click(S.cursor) }
  else if (k === "Escape") cancel()
  else if (k === "Enter") finish()
  else if (k === "Backspace") back()
  else if (k === "1" || k === "2" || k === "3") { const p = (S.paces.length ? S.paces : [{ key: "foot" }, { key: "horse" }, { key: "ship" }])[Number(k) - 1]; if (p) { S.pace = p.key; changed() } }
  else if (k === "r" || k === "R") { S.rush = !S.rush; changed() }
  else return
  ev.preventDefault(); ev.stopPropagation()
}
function onContext(ev) { if (on && S.drawing && onCanvas(ev)) ev.preventDefault() }

Hooks.once("ready", () => {
  window.addEventListener("pointerdown", onDown, true)
  window.addEventListener("pointerup", onUp, true)
  window.addEventListener("pointermove", onMove, true)
  window.addEventListener("keydown", onKey, true)
  window.addEventListener("contextmenu", onContext, true)
  try {
    game.socket?.on(CHANNEL, (m) => {
      if (!m || typeof m.t !== "string" || !m.t.startsWith("theo.") || m.user === game.user?.id) return
      if (m.t === "theo.line") others.set(m.user, { pts: m.pts, color: m.color, sceneId: m.sceneId, shown: !!m.shown })
      else if (m.t === "theo.clear") others.delete(m.user)
      schedule()
    })
  } catch { /* no socket */ }
})
Hooks.on("canvasPan", () => { if (S.drawing || S.kept || others.size) schedule() })
Hooks.on("canvasReady", () => { G = null; cancel(); S.kept = null; schedule() })
Hooks.on("pendantBridgeLive", () => { if (!realmLive()) { cancel(); setTheorize(false) } })
Hooks.on("userConnected", (user, connected) => { if (!connected && others.delete(user?.id)) schedule() })
