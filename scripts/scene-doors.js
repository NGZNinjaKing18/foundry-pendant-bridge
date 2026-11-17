// ──────────────────────────────────────────────────────────────
// Scene doors — GM-only signs on a scene that say "there's another map here" and lead to it.
// (Mockup approved 2026-11-17: tests/harness/scene-doors.html.)
//
//   Look     a small card: the target scene's thumbnail + name, dashed edge, eye-slash badge, a stalk down to
//            the spot. A little roof on the corner = pinned to a Realm-layer town.
//   Size     the same size on screen while zoomed in; zoomed out past "Stop growing at" (Map views) it locks to
//            the map and shrinks with it. Size and stop point are world settings (doorSize, doorLock).
//   Hover    a bigger thumbnail, grid size, token count.
//   Click    the door card: Look (view it yourself) · Take players (activate) · Goes to · Pinned to · Remove.
//   Drag     moves it.
//   Place    the "Scene door" tool in the RealmScreen controls (click the map → pick a scene), or drag a scene
//            from the Scenes sidebar onto the canvas.
//   Back     on a scene some door leads to, a "← <that scene>" chip (top of the screen) goes back.
//
// GM ONLY: nothing is drawn, hit-tested or shown unless game.user.isGM. Doors are data in the scene's flags
// (flags[pendant-bridge].doors) — no Note/Tile/Drawing is created, so players get nothing on their canvas.
// Input is caught on the canvas element before Foundry sees it (as scripts/theorize.js does).
// ──────────────────────────────────────────────────────────────

import { doorsOf, addDoor, patchDoor, removeDoor, doorsInto, doorScale, gridLine, newDoorId } from "./scene-doors-model.js"
import { realmRecords } from "./mapviews.js"

const MOD = "pendant-bridge"
const FONT = "'RealmScreen Plex', 'IBM Plex Sans', Signika, sans-serif"
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const warn = (e) => ui.notifications?.warn(e?.message || String(e))
const isGM = () => !!game.user?.isGM

// card geometry in screen px (before the size setting)
const TW = 76, TH = 48, P = 4, NAME = 15, CW = TW + P * 2, CH = TH + P * 2 + NAME, LIFT = 12
const INK = 0xd8cfbf, BG = 0x15141c, TEXT = 0xe7e1d4

// ── settings ──────────────────────────────────────────────────
const setting = (k, d) => { try { const v = game.settings.get(MOD, k); return v ?? d } catch { return d } }
const preview = {}                                    // Map views sliders, live while dragging
export const doorSize = () => preview.doorSize ?? setting("doorSize", 1)
export const doorLock = () => preview.doorLock ?? setting("doorLock", 1)
export const doorsShown = () => setting("doorsShown", true)
export function previewDoorLook(key, v) { preview[key] = Number(v); schedule() }
export function endDoorPreview(key) { delete preview[key] }
export async function setDoorsShown(on) { await game.settings.set(MOD, "doorsShown", !!on); schedule() }

Hooks.once("init", () => {
  game.settings.register(MOD, "doorSize", { scope: "world", config: false, type: Number, default: 1, onChange: () => schedule() })
  game.settings.register(MOD, "doorLock", { scope: "world", config: false, type: Number, default: 1, onChange: () => schedule() })
  game.settings.register(MOD, "doorsShown", { scope: "client", config: false, type: Boolean, default: true, onChange: () => schedule() })
})

// ── the canvas ────────────────────────────────────────────────
const S = { root: null, tex: new Map(), drag: null, hover: null, hoverT: 0, tip: null, raf: 0, placing: false, chips: null }

const viewed = () => canvas?.scene || null
const sceneById = (id) => game.scenes?.get?.(id) || null
const stageScale = () => canvas?.stage?.scale?.x || 1
function fit() {
  const d = canvas?.dimensions, scr = canvas?.app?.renderer?.screen
  if (!d?.sceneWidth || !scr?.width) return stageScale()
  return Math.min(scr.width / d.sceneWidth, scr.height / d.sceneHeight)
}
const kNow = () => doorScale({ stageScale: stageScale(), fit: fit(), size: doorSize(), lock: doorLock() })
const mapZoom = () => stageScale() / fit()

function host() { return canvas?.controls || canvas?.interface || canvas?.stage || null }
function root() {
  if (S.root && !S.root.destroyed && S.root.parent) return S.root
  const h = host()
  if (!h) return null
  S.root = new PIXI.Container()
  S.root.eventMode = "none"           // hit-testing is ours (onDown), so Foundry's layers keep their clicks
  S.root.zIndex = 1000
  h.addChild(S.root)
  return S.root
}

const loadTex = (src) => { const f = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture; return f ? f(src) : PIXI.Texture.from(src) }
function texFor(src) {
  if (!src) return null
  const have = S.tex.get(src)
  if (have) return have.tex
  const entry = { tex: null }
  S.tex.set(src, entry)
  Promise.resolve().then(() => loadTex(src)).then(t => { entry.tex = t || null; schedule() }).catch(() => {})
  return null
}

function dashedRect(g, x, y, w, h, dash = 5, gap = 3) {
  const edge = (x0, y0, x1, y1) => {
    const len = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / len, uy = (y1 - y0) / len
    for (let t = 0; t < len; t += dash + gap) { const e = Math.min(t + dash, len); g.moveTo(x0 + ux * t, y0 + uy * t).lineTo(x0 + ux * e, y0 + uy * e) }
  }
  edge(x, y, x + w, y); edge(x + w, y, x + w, y + h); edge(x + w, y + h, x, y + h); edge(x, y + h, x, y)
}

function drawDoor(d) {
  const target = sceneById(d.scene)
  const c = new PIXI.Container()
  const top = -(CH + LIFT), left = -CW / 2
  const g = new PIXI.Graphics()
  g.beginFill(0x000000, 0.35).drawRoundedRect(left + 1, top + 2, CW, CH, 4).endFill()
  g.beginFill(BG, 0.9).drawRoundedRect(left, top, CW, CH, 4).endFill()
  g.lineStyle(1.2, INK, 0.85); dashedRect(g, left, top, CW, CH)
  g.lineStyle(1.2, INK, 0.85).moveTo(0, top + CH).lineTo(0, -3)
  g.lineStyle(1.5, BG).beginFill(INK).drawCircle(0, 0, 3.5).endFill()
  if (!target) {   // the scene it led to was deleted
    g.lineStyle(1.5, 0xc96a6a).moveTo(left + P + 10, top + P + 8).lineTo(left + P + TW - 10, top + P + TH - 8)
  }
  c.addChild(g)
  const tex = texFor(target?.thumb)
  if (tex) { const sp = new PIXI.Sprite(tex); sp.position.set(left + P, top + P); sp.width = TW; sp.height = TH; c.addChild(sp) }
  else { const ph = new PIXI.Graphics(); ph.beginFill(0x2a2832).drawRect(left + P, top + P, TW, TH).endFill(); c.addChild(ph) }
  const raw = target?.name || "(scene deleted)"
  const t = new PIXI.Text(raw.length > 15 ? raw.slice(0, 14) + "…" : raw, { fontFamily: FONT, fontSize: 10.5, fontWeight: "600", fill: TEXT })
  t.resolution = Math.min(4, (window.devicePixelRatio || 1) * 2.5); t.anchor.set(0.5, 0); t.position.set(0, top + P + TH + 2)
  c.addChild(t)
  const b = new PIXI.Graphics(), bx = left + CW - 2, by = top + 2
  b.beginFill(BG, 0.95).lineStyle(1, INK, 0.9).drawCircle(bx, by, 8).endFill()
  b.lineStyle(1.3, TEXT).drawEllipse(bx, by, 5, 3).beginFill(TEXT).drawCircle(bx, by, 1.4).endFill()
  b.lineStyle(1.6, TEXT).moveTo(bx - 5, by + 4).lineTo(bx + 5, by - 4)
  if (d.town) {
    b.lineStyle(1, INK, 0.9).beginFill(BG).drawRoundedRect(left - 6, top - 6, 12, 12, 2).endFill()
    b.lineStyle(1.4, TEXT).moveTo(left - 3, top + 2).lineTo(left, top - 3).lineTo(left + 3, top + 2)
  }
  c.addChild(b)
  return c
}

function build() {
  const r = root()
  if (!r) return
  for (const ch of r.removeChildren()) ch.destroy({ children: true })
  r.visible = isGM() && doorsShown()
  if (!r.visible) return
  const k = kNow()
  for (const d of currentDoors()) {
    const c = drawDoor(d); c.position.set(d.x, d.y); c.scale.set(k); r.addChild(c)
  }
}
function schedule() {
  if (S.raf) return
  S.raf = requestAnimationFrame(() => { S.raf = 0; try { build() } catch (e) { console.warn("[pendant-bridge] scene doors", e) } })
}
export const redrawDoors = () => schedule()

// While dragging, the door being moved is drawn from S.drag (saved on let-go).
function currentDoors() {
  const list = doorsOf(viewed())
  if (!S.drag?.moved) return list
  return list.map(d => d.id === S.drag.id ? { ...d, x: S.drag.x, y: S.drag.y } : d)
}

async function saveDoors(scene, doors) {
  if (!scene || !isGM()) return
  await scene.setFlag(MOD, "doors", doors)
}

// ── hit-testing (screen px → scene px) ───────────────────────
function scenePoint(ev) {
  const p = canvas.canvasCoordinatesFromClient ? canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY }) : canvas.stage.toLocal({ x: ev.clientX, y: ev.clientY })
  return { x: p.x, y: p.y }
}
function doorAt(p) {
  const k = kNow(), list = doorsOf(viewed())
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i]
    const x0 = d.x + (-CW / 2 - 8) * k, x1 = d.x + (CW / 2 + 8) * k
    const y0 = d.y - (CH + LIFT + 8) * k, y1 = d.y + 6 * k
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return d
  }
  return null
}
const onCanvas = (ev) => !!canvas?.ready && ev.target === canvas.app?.view
const live = () => isGM() && doorsShown() && !!viewed()

function onDown(ev) {
  if (!isGM() || !onCanvas(ev) || ev.button !== 0) return
  if (S.placing) {
    ev.stopPropagation(); ev.preventDefault()
    openPicker(scenePoint(ev), { x: ev.clientX, y: ev.clientY })
    return
  }
  if (!live()) return
  const d = doorAt(scenePoint(ev))
  if (!d) return
  ev.stopPropagation(); ev.preventDefault()
  hideTip()
  S.drag = { id: d.id, sx: ev.clientX, sy: ev.clientY, x: d.x, y: d.y, moved: false, client: { x: ev.clientX, y: ev.clientY } }
}
function onMove(ev) {
  if (S.drag) {
    if (!S.drag.moved && Math.hypot(ev.clientX - S.drag.sx, ev.clientY - S.drag.sy) < 4) return
    S.drag.moved = true
    const p = scenePoint(ev); S.drag.x = p.x; S.drag.y = p.y
    ev.stopPropagation()
    schedule()
    return
  }
  if (!live() || !onCanvas(ev)) { if (S.hover) hideTip(); return }
  const d = doorAt(scenePoint(ev))
  const view = canvas.app?.view
  if (view && !S.placing) view.style.cursor = d ? "pointer" : (view.style.cursor === "pointer" ? "" : view.style.cursor)
  if ((d?.id || null) === (S.hover?.id || null)) { if (d && S.tip && !S.tip.hidden) placeTip(ev); return }
  hideTip()
  if (!d) return
  S.hover = d
  S.hoverT = setTimeout(() => showTip(d, ev), 250)
}
async function onUp(ev) {
  const g = S.drag
  if (!g) return
  S.drag = null
  ev.stopPropagation()
  const scene = viewed()
  if (g.moved) {
    try { await saveDoors(scene, patchDoor(doorsOf(scene), g.id, { x: Math.round(g.x), y: Math.round(g.y) })) } catch (e) { warn(e) }
    schedule()
    return
  }
  const d = doorsOf(scene).find(x => x.id === g.id)
  if (d) openCard(scene, d, g.client)
}
function onKey(ev) {
  if (ev.key !== "Escape" || !S.placing) return
  const tag = ev.target?.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
  setPlacing(false)
}

// ── hover tip ─────────────────────────────────────────────────
function tipEl() {
  if (S.tip?.isConnected) return S.tip
  const el = document.createElement("div")
  el.className = "pb-door-tip"; el.hidden = true
  document.body.appendChild(el)
  return (S.tip = el)
}
function showTip(d, ev) {
  const sc = sceneById(d.scene), el = tipEl()
  const toks = sc?.tokens?.size ?? 0
  el.innerHTML = sc
    ? `${sc.thumb ? `<img src="${esc(sc.thumb)}" alt="">` : ""}<strong>${esc(sc.name)}</strong>
       <span>${esc([gridLine(sc), `${toks} token${toks === 1 ? "" : "s"}`].filter(Boolean).join(" · "))}</span>
       <em>Click to open · drag to move</em>`
    : `<strong>Scene deleted</strong><em>Click to point it at another scene</em>`
  el.hidden = false
  placeTip(ev)
}
function placeTip(ev) {
  const el = S.tip
  if (!el) return
  const w = el.offsetWidth || 240, h = el.offsetHeight || 200
  el.style.left = `${Math.min(window.innerWidth - w - 8, ev.clientX + 18)}px`
  el.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, ev.clientY - h - 12))}px`
}
function hideTip() { clearTimeout(S.hoverT); S.hover = null; if (S.tip) S.tip.hidden = true }

// ── the door card ─────────────────────────────────────────────
let CardClass = null
function cardClass() {
  const AppV2 = foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  if (CardClass) return CardClass
  CardClass = class SceneDoorCard extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: "pb-scene-door",
      classes: ["pb-door"],
      window: { title: "Scene door", icon: "fa-solid fa-signs-post" },
      position: { width: 260, height: "auto" },
      actions: { look: SceneDoorCard.look, take: SceneDoorCard.take, remove: SceneDoorCard.remove },
    }
    get door() { return doorsOf(sceneById(this.sceneId)).find(d => d.id === this.doorId) || null }
    async _renderHTML() {
      const el = document.createElement("div")
      const d = this.door, sc = d && sceneById(d.scene)
      if (!d) { el.innerHTML = `<p class="hint">This door is gone.</p>`; return el }
      const scenes = (game.scenes?.contents || []).filter(s => s.id !== this.sceneId).sort((a, b) => a.name.localeCompare(b.name))
      const towns = realmRecords(sceneById(this.sceneId)).filter(r => r.kind === "settlement" && r.name)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      const toks = sc?.tokens?.size ?? 0
      el.innerHTML = `
        <p class="pb-door-gm"><i class="fa-solid fa-eye-slash"></i> Only you see this</p>
        ${sc?.thumb ? `<img class="pb-door-big" src="${esc(sc.thumb)}" alt="">` : ""}
        <div class="pb-door-title"><strong>${esc(sc?.name || "Scene deleted")}</strong>
          ${sc ? `<span>${esc([gridLine(sc), `${toks} token${toks === 1 ? "" : "s"}`].filter(Boolean).join(" · "))}</span>` : ""}</div>
        <div class="pb-door-row">
          <button type="button" data-action="look" ${sc ? "" : "disabled"} data-tooltip="Open it for you only; players stay where they are"><i class="fa-solid fa-eye"></i> Look</button>
          <button type="button" data-action="take" ${sc ? "" : "disabled"} data-tooltip="Make it the active scene for everyone"><i class="fa-solid fa-person-walking-arrow-right"></i> Take players</button>
        </div>
        <div class="form-group stacked"><label>Goes to</label>
          <select name="scene">${sc ? "" : `<option value="" selected>— pick a scene —</option>`}${scenes.map(s => `<option value="${esc(s.id)}" ${s.id === d.scene ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>
        <div class="form-group stacked"><label>Pinned to</label>
          <select name="town"><option value="">Nothing — stands alone</option>${towns.map(t => `<option value="${esc(t.id)}" ${t.id === d.town ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
        <button type="button" class="pb-door-remove" data-action="remove"><i class="fa-solid fa-trash"></i> Remove door</button>`
      return el
    }
    _replaceHTML(result, content) { content.replaceChildren(result) }
    _onRender() {
      for (const sel of this.element.querySelectorAll("select")) {
        sel.addEventListener("change", async () => {
          const scene = sceneById(this.sceneId)
          if (sel.name === "scene" && !sel.value) return
          try { await saveDoors(scene, patchDoor(doorsOf(scene), this.doorId, { [sel.name]: sel.value })) } catch (e) { warn(e) }
          this.render()
        })
      }
    }
    static async look() {
      const sc = sceneById(this.door?.scene)
      this.close()
      try { await sc?.view() } catch (e) { warn(e) }
    }
    static async take() {
      const sc = sceneById(this.door?.scene)
      if (!sc) return
      this.close()
      try { await sc.activate(); ui.notifications?.info(`Players are now on ${sc.name}.`) } catch (e) { warn(e) }
    }
    static async remove() {
      const scene = sceneById(this.sceneId)
      try { await saveDoors(scene, removeDoor(doorsOf(scene), this.doorId)) } catch (e) { warn(e) }
      this.close()
    }
  }
  return CardClass
}
function openCard(scene, d, at) {
  const C = cardClass()
  if (!C || !scene) return
  foundry.applications.instances?.get?.("pb-scene-door")?.close()
  const app = new C({ position: { left: Math.max(8, Math.min(window.innerWidth - 270, at.x + 24)), top: Math.max(8, Math.min(window.innerHeight - 480, at.y - 180)) } })
  app.sceneId = scene.id; app.doorId = d.id
  app.render({ force: true })
}

// ── placing: the tool (click → pick a scene) ─────────────────
let PickClass = null
function pickClass() {
  const AppV2 = foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  if (PickClass) return PickClass
  PickClass = class SceneDoorPick extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: "pb-scene-door-pick",
      classes: ["pb-door"],
      window: { title: "New scene door", icon: "fa-solid fa-signs-post" },
      position: { width: 260, height: "auto" },
      actions: { pick: SceneDoorPick.pick },
    }
    async _renderHTML() {
      const el = document.createElement("div")
      const scenes = (game.scenes?.contents || []).filter(s => s.id !== this.sceneId).sort((a, b) => a.name.localeCompare(b.name))
      el.innerHTML = `<input type="search" name="q" placeholder="Search scenes…" autocomplete="off">
        <ul class="pb-door-pick">${scenes.map(s => `<li data-action="pick" data-id="${esc(s.id)}">
          ${s.thumb ? `<img src="${esc(s.thumb)}" alt="">` : `<span class="pb-door-nothumb"></span>`}<span>${esc(s.name)}</span></li>`).join("")}</ul>
        ${scenes.length ? "" : `<p class="hint">No other scenes in this world yet.</p>`}`
      return el
    }
    _replaceHTML(result, content) { content.replaceChildren(result) }
    _onRender() {
      const q = this.element.querySelector("input[name=q]")
      q?.addEventListener("input", () => {
        const t = q.value.trim().toLowerCase()
        for (const li of this.element.querySelectorAll(".pb-door-pick li")) li.hidden = !!t && !li.textContent.toLowerCase().includes(t)
      })
      setTimeout(() => q?.focus(), 0)
    }
    static async pick(_e, target) {
      this.close()
      await placeDoor(sceneById(this.sceneId), target.dataset.id, this.at)
    }
  }
  return PickClass
}
function openPicker(p, client) {
  const C = pickClass(), scene = viewed()
  if (!C || !scene) return
  foundry.applications.instances?.get?.("pb-scene-door-pick")?.close()
  const app = new C({ position: { left: Math.max(8, Math.min(window.innerWidth - 270, client.x + 16)), top: Math.max(8, Math.min(window.innerHeight - 380, client.y - 40)) } })
  app.sceneId = scene.id; app.at = p
  app.render({ force: true })
}
async function placeDoor(scene, targetId, at) {
  const target = sceneById(targetId)
  if (!scene || !target || !at) return
  if (target.id === scene.id) return ui.notifications?.warn("A door can't lead to the scene it's on.")
  try {
    await saveDoors(scene, addDoor(doorsOf(scene), { id: newDoorId(), scene: target.id, x: Math.round(at.x), y: Math.round(at.y) }))
    setPlacing(false)
    if (!doorsShown()) await setDoorsShown(true)
    ui.notifications?.info(`Door to ${target.name} placed — only you can see it.`)
  } catch (e) { warn(e) }
}

export const placingDoor = () => S.placing
export function setPlacing(on) {
  S.placing = !!on && isGM()
  const view = canvas?.app?.view
  if (view) view.style.cursor = S.placing ? "crosshair" : ""
  if (S.placing) ui.notifications?.info("Click the map where the door goes (Esc to cancel).")
}

// A scene dragged from the Scenes sidebar onto the canvas = a door to it.
Hooks.on("dropCanvasData", (cnv, data) => {
  if (!isGM() || data?.type !== "Scene") return
  const uuid = data.uuid || (data.id ? `Scene.${data.id}` : null)
  const id = uuid?.split(".").pop()
  if (!id || !viewed()) return
  placeDoor(viewed(), id, { x: data.x, y: data.y })
  return false
})

// ── "back" chips: on a scene a door leads to ─────────────────
function chips() {
  S.chips?.remove(); S.chips = null
  const here = viewed()
  if (!isGM() || !here || !doorsShown()) return
  const from = doorsInto(game.scenes?.contents || [], here.id)
  if (!from.length) return
  const bar = document.createElement("div")
  bar.className = "pb-door-back"
  for (const { from: s } of from.slice(0, 4)) {
    const b = document.createElement("button")
    b.type = "button"
    b.dataset.tooltip = `Back to ${s.name} (only you see this)`
    b.innerHTML = `<i class="fa-solid fa-arrow-left"></i>${s.thumb ? `<img src="${esc(s.thumb)}" alt="">` : ""}<span>${esc(s.name)}</span>`
    b.addEventListener("click", () => s.view())
    bar.append(b)
  }
  document.body.append(bar)
  S.chips = bar
}

// ── hooks ─────────────────────────────────────────────────────
Hooks.once("ready", () => {
  window.addEventListener("pointerdown", onDown, true)
  window.addEventListener("pointermove", onMove, true)
  window.addEventListener("pointerup", onUp, true)
  window.addEventListener("keydown", onKey, true)
})
function dropRoot() { if (S.root && !S.root.destroyed) { S.root.parent?.removeChild(S.root); S.root.destroy({ children: true }) } S.root = null }
Hooks.on("canvasReady", () => { dropRoot(); S.drag = null; hideTip(); schedule(); chips() })
Hooks.on("canvasTearDown", () => { dropRoot(); S.drag = null; hideTip(); S.chips?.remove(); S.chips = null })
Hooks.on("canvasPan", () => schedule())
Hooks.on("updateScene", (scene, changes) => {
  const f = changes?.flags?.[MOD]
  const touched = f && ("doors" in f || "-=doors" in f)
  if (touched && scene?.id === viewed()?.id) { schedule(); foundry.applications?.instances?.get?.("pb-scene-door")?.render() }
  if (touched || "name" in (changes || {}) || "thumb" in (changes || {})) chips()
  if ("thumb" in (changes || {})) { S.tex.clear(); schedule() }
})
Hooks.on("deleteScene", () => { schedule(); chips() })
Hooks.on("pendantRealmRedraw", () => { schedule(); chips() })
