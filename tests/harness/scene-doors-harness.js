// Dev harness (not loaded by Foundry): the REAL scripts/scene-doors.js (+ the real Map views window) on top of the
// Realm layer harness. scene-doors.html = realm-layer.html + this file. Stand-ins below: a few other scenes with
// drawn thumbnails, a small ApplicationV2, scene flags + setFlag, a Scenes sidebar to drag from, and three
// buttons standing in for the RealmScreen scene controls.

// ?noraf: a hidden browser pane runs no animation frames — use timers so the doors still draw.
if (new URLSearchParams(location.search).has("noraf")) window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16)
const wait = () => new Promise(r => { const t = () => window.__h ? r(window.__h) : setTimeout(t, 30); t() })
const { app, scene, D } = await wait()
const view = app.view
const SP = (x, y) => ({ x: Math.round(D.sceneX + x * D.sceneWidth), y: Math.round(D.sceneY + y * D.sceneHeight) })

// ── settings that remember (the realm harness's own get() answers false) ──
const store = {}, onCh = {}
const baseGet = game.settings.get
game.settings.register = (m, k, o) => { if (!(k in store) && o && "default" in o) store[k] = o.default; if (o?.onChange) onCh[k] = o.onChange }
game.settings.get = (m, k) => (k in store ? store[k] : baseGet(m, k))
game.settings.set = async (m, k, v) => { store[k] = v; onCh[k]?.(v); return v }
globalThis.ui = { notifications: { info: (m) => toast(m), warn: (m) => toast("⚠ " + m) }, controls: {} }

// ── a small ApplicationV2 (position left/top, height auto, actions, close) ──
const instances = new Map()
class ApplicationV2 {
  constructor(options = {}) {
    const chain = []; for (let c = this.constructor; c && c !== Object; c = Object.getPrototypeOf(c)) if (Object.hasOwn(c, "DEFAULT_OPTIONS")) chain.unshift(c.DEFAULT_OPTIONS)
    this.options = Object.assign({}, ...chain, options)
    this.options.position = Object.assign({}, ...chain.map(o => o.position || {}), options.position || {})
    this.options.actions = Object.assign({}, ...chain.map(o => o.actions || {}))
    this.options.classes = chain.flatMap(o => o.classes || [])
  }
  get id() { return this.options.id }
  async render() {
    if (!this.element) {
      const el = document.createElement("div")
      el.className = ["application", "sd-app", ...this.options.classes].join(" ")
      const p = this.options.position
      el.style.width = (p.width || 300) + "px"
      el.style.left = (p.left ?? 80) + "px"; el.style.top = (p.top ?? 80) + "px"
      el.innerHTML = `<header class="window-header"><i class="${this.options.window?.icon || ""}"></i><span class="t">${this.options.window?.title || ""}</span><a data-close>✕</a></header><section class="window-content"></section>`
      document.body.append(el)
      this.element = el
      el.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-close]")) return this.close()
        const t = ev.target.closest("[data-action]")
        if (!t || !el.contains(t)) return
        if (t.type === "checkbox" || t.type === "radio") { /* fallthrough */ }
        this.options.actions[t.dataset.action]?.call(this, ev, t)
      })
      instances.get(this.id)?.close?.()
      instances.set(this.id, this)
    }
    this._replaceHTML(await this._renderHTML(), this.element.querySelector(".window-content"))
    this._onRender?.()
    return this
  }
  close() { this.element?.remove(); this.element = null; if (instances.get(this.id) === this) instances.delete(this.id) }
  bringToFront() {}
}
globalThis.foundry.applications = { api: { ApplicationV2, DialogV2: { confirm: async () => true, prompt: async () => null } }, instances }

// ── the world's scenes ──
let seed = 7
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
function thumb(kind) {
  const w = 320, h = 200, s = []
  const pal = { cave: ['#1d1c22', '#4b4756'], rooms: ['#2a2420', '#8c7a63'], tomb: ['#16161a', '#55505c'], keep: ['#2c2a26', '#6f6a5c'], inn: ['#2a1f18', '#7d5a3c'], wild: ['#26331f', '#4e6a3a'], world: ['#2f5470', '#55603f'] }[kind]
  s.push(`<rect width="${w}" height="${h}" fill="${pal[0]}"/>`)
  if (kind === 'world') s.push(`<path d="M20 50 100 15 200 20 270 60 280 140 230 185 120 190 40 160 15 100z" fill="${pal[1]}"/>`)
  else if (kind === 'cave') for (let i = 0; i < 16; i++) s.push(`<ellipse cx="${30 + rnd() * 260}" cy="${20 + rnd() * 160}" rx="${18 + rnd() * 40}" ry="${12 + rnd() * 26}" fill="${pal[1]}"/>`)
  else if (kind === 'wild') { s.push(`<path d="M0 120 C80 90 160 150 320 100" stroke="#3f7590" stroke-width="16" fill="none"/>`); for (let i = 0; i < 40; i++) s.push(`<circle cx="${rnd() * w}" cy="${rnd() * h}" r="${6 + rnd() * 12}" fill="${pal[1]}"/>`) }
  else for (let i = 0; i < 6; i++) s.push(`<rect x="${20 + rnd() * 200}" y="${20 + rnd() * 110}" width="${50 + rnd() * 70}" height="${40 + rnd() * 50}" fill="${pal[1]}" stroke="#c9b48f" stroke-width="4"/>`)
  for (let x = 0; x < w; x += 20) s.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#000" stroke-opacity=".18"/>`)
  for (let y = 0; y < h; y += 20) s.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#000" stroke-opacity=".18"/>`)
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${s.join('')}</svg>`)
}
const flags = {}
Object.assign(scene, {
  name: "World Map", thumb: thumb("world"), width: D.sceneWidth, height: D.sceneHeight, grid: { size: 100, distance: 6, units: "mi" }, tokens: { size: 1 }, drawings: [], tiles: [], notes: [],
  async setFlag(m, k, v) {
    window.__flags[m] ??= {}; window.__flags[m][k] = v
    Hooks.callAll("updateScene", scene, { flags: { [m]: { [k]: v } } })
  },
})
// the realm harness keeps its flags in a closure: reach them through getFlag's object
window.__flags = (() => { const o = {}; const g = scene.getFlag; scene.getFlag = (m, k) => (o[m] && k in o[m]) ? o[m][k] : g(m, k); return o })()
const other = (id, name, kind, cols, rows, toks) => ({ id, name, thumb: thumb(kind), width: cols * 100, height: rows * 100, grid: { size: 100, distance: 5, units: "ft" }, tokens: { size: toks }, flags: {} })
const SCENES = [scene, other("sc1", "Rookwater Caves", "cave", 40, 28, 6), other("sc2", "Omacatl — Palace", "rooms", 32, 40, 12), other("sc3", "Tomb of Seven", "tomb", 30, 24, 9),
  other("sc4", "Fort Delta Keep", "keep", 36, 36, 4), other("sc5", "The Lame Goat (Burgen)", "inn", 20, 16, 3), other("sc6", "Ashe Ford ambush", "wild", 50, 30, 0)]
let active = scene
for (const s of SCENES) {
  s.getFlag ??= (m, k) => s.flags?.[m]?.[k]
  s.view = async () => goTo(s)
  s.activate = async () => { active = s; goTo(s) }
}
globalThis.game.scenes = { get: (id) => SCENES.find(s => s.id === id) || null, get contents() { return SCENES }, viewed: scene }

// "Viewing" another scene: an image over the canvas; canvas.scene changes so the back chips show.
function goTo(s) {
  Hooks.callAll("canvasTearDown")
  canvas.scene = s
  const ins = document.getElementById("sd-inside")
  if (s === scene) ins.style.display = "none"
  else { ins.querySelector("img").src = s.thumb; ins.querySelector("span").textContent = s === active ? `${s.name} — active for everyone` : `${s.name} — viewing (players are still on ${active.name})`; ins.style.display = "block" }
  Hooks.callAll("canvasReady")
}

// a few doors to start with
window.__flags["pendant-bridge"] = { doors: [
  { id: "d1", scene: "sc1", ...SP(0.37, 0.37) },
  { id: "d2", scene: "sc3", ...SP(0.4, 0.75), town: "t8" },
  { id: "d3", scene: "sc4", ...SP(0.18, 0.55), town: "t3" },
] }

// ── page chrome ──
const css = document.createElement("style")
css.textContent = `
#sd-wrap { display:flex; align-items:flex-start; }
#sd-stage { position:relative; }
#sd-ctrl { position:absolute; left:8px; top:8px; display:flex; flex-direction:column; gap:4px; }
#sd-ctrl button { width:36px; height:36px; background:rgba(11,10,19,.85); border:1px solid #48443c; border-radius:5px; color:#cfc8b8; cursor:pointer; font-size:15px; }
#sd-ctrl button:hover, #sd-ctrl button.on { border-color:#ff6400; color:#fff; }
#sd-side { width:240px; height:660px; overflow:auto; background:#0b0a13; border-left:1px solid #2c2a30; box-sizing:border-box; padding:8px; display:flex; flex-direction:column; gap:4px; }
#sd-side h3 { margin:2px 0; font-size:13px; text-transform:uppercase; color:#a8a194; }
.sd-sc { display:flex; gap:8px; align-items:center; padding:4px; border-radius:4px; cursor:grab; }
.sd-sc:hover { background:#1a1922; }
.sd-sc img { width:56px; height:35px; object-fit:cover; border-radius:2px; }
.sd-app { position:fixed; z-index:80; background:rgba(11,10,19,.97); border:1px solid #48443c; border-radius:6px; box-shadow:0 6px 24px #000a; color:#e7e1d4; }
.sd-app .window-header { display:flex; gap:6px; align-items:center; padding:5px 8px; border-bottom:1px solid #2c2a30; font-weight:600; }
.sd-app .window-header a { margin-left:auto; cursor:pointer; color:#a8a194; }
.sd-app .window-content { display:flex; flex-direction:column; }
.sd-app button { background:#2a2832; color:#e7e1d4; border:1px solid #48443c; border-radius:3px; padding:5px 8px; font:inherit; cursor:pointer; }
.sd-app select, .sd-app input[type=search] { background:#1a1922; color:#e7e1d4; border:1px solid #48443c; border-radius:3px; padding:4px 6px; font:inherit; }
.sd-app hr { border:0; border-top:1px solid #2c2a30; width:100%; }
.sd-app .pb-mv-range { display:grid; grid-template-columns: 90px 1fr 48px; gap:6px; align-items:center; }
.sd-app ul { list-style:none; padding:0; margin:0; }
#sd-inside { position:absolute; inset:0; display:none; background:#000; }
#sd-inside img { width:100%; height:100%; object-fit:cover; }
#sd-inside span { position:absolute; left:50%; bottom:12px; transform:translateX(-50%); background:#0b0a13ee; border:1px solid #48443c; border-radius:4px; padding:4px 12px; }
#sd-toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#0b0a13f2; border:1px solid #48443c; border-left:3px solid #ff6400; border-radius:4px; padding:8px 14px; display:none; z-index:90; }
`
document.head.append(css)
const vw = document.getElementById("view")
const wrap = document.createElement("div"); wrap.id = "sd-wrap"
const stage = document.createElement("div"); stage.id = "sd-stage"
vw.before(wrap); wrap.append(stage); stage.append(vw)
stage.insertAdjacentHTML("beforeend", `<div id="sd-inside"><img><span></span></div>
<div id="sd-ctrl">
  <button data-k="views" title="Map views">▤</button>
  <button data-k="place" title="Scene door — click the map, then pick the scene">⚑</button>
  <button data-k="show" class="on" title="Show scene doors">◎</button>
</div>`)
wrap.insertAdjacentHTML("beforeend", `<aside id="sd-side"><h3>Scenes</h3><p style="font-size:11.5px;color:#a8a194;margin:0">Drag one onto the map. Click to view it.</p>
${SCENES.map(s => `<div class="sd-sc" draggable="true" data-id="${s.id}"><img src="${s.thumb}"><span>${s.name}</span></div>`).join("")}</aside>`)
document.body.insertAdjacentHTML("beforeend", `<div id="sd-toast"></div>`)
let toastT = 0
function toast(m) { const t = document.getElementById("sd-toast"); if (!t) return; t.textContent = m; t.style.display = "block"; clearTimeout(toastT); toastT = setTimeout(() => { t.style.display = "none" }, 2600) }

// ── the real bridge ──
const doors = await import("/foundry-pendant-bridge/scripts/scene-doors.js")
const ui2 = await import("/foundry-pendant-bridge/scripts/mapviews-ui.js")
Hooks.callAll("init"); Hooks.callAll("ready"); Hooks.callAll("canvasReady")

document.querySelector("#sd-ctrl [data-k=place]").onclick = () => doors.setPlacing(true)
document.querySelector("#sd-ctrl [data-k=show]").onclick = async (e) => { await doors.setDoorsShown(!doors.doorsShown()); e.currentTarget.classList.toggle("on", doors.doorsShown()) }
document.querySelector("#sd-ctrl [data-k=views]").onclick = () => ui2.openMapViews()
for (const r of document.querySelectorAll("#sd-side .sd-sc")) {
  r.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", r.dataset.id))
  r.addEventListener("click", () => game.scenes.get(r.dataset.id).view())
}
view.addEventListener("dragover", (e) => e.preventDefault())
view.addEventListener("drop", (e) => {   // Foundry: Canvas#_onDrop → Hooks.call("dropCanvasData", canvas, data)
  e.preventDefault()
  const id = e.dataTransfer.getData("text/plain"), p = canvas.canvasCoordinatesFromClient({ x: e.clientX, y: e.clientY })
  Hooks.call("dropCanvasData", canvas, { type: "Scene", uuid: `Scene.${id}`, x: p.x, y: p.y })
})
view.addEventListener("wheel", (e) => { e.preventDefault(); const z = document.getElementById("zoom"); z.value = Math.max(0.5, Math.min(14, +z.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); z.dispatchEvent(new Event("input")) }, { passive: false })
window.__doors = { doors, store }
