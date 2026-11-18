// ──────────────────────────────────────────────────────────────
// Scenes sidebar upgrade — the user's pick "D" (mockup tests/harness/folder-concepts.html, 2026-11-17).
// Only while RealmScreen is connected (live.js); not connected = stock Foundry.
//
//   Top strip   Live + pinned scenes, then Recent (this account's last scenes), as small pictures; click = view,
//               right-click = Foundry's own scene menu (as on the scene's row).
//               Tags (the scenes' own flags[MOD].tags, set from RealmScreen's sorter) filter the tree below.
//   Pin         a ★ on each scene row (shown on hover, stays lit when pinned), or right-click a scene → Pin to
//               the top / Unpin. Pins are per account (user flag).
//   Fast folder a folder whose scenes aren't really in it: each still lives in its real folder and ALSO shows here,
//               as a full scene row (right-click, click, drag out — all as the real one). Drop a scene on a fast
//               folder to add it; right-click a copy → Remove from fast folder. Made with a Scene folder's
//               right-click → Make fast folder (or its Edit Folder window). flags[MOD].fast = { on, scenes: [ids] }.
//   Folders     quiet look: the folder colour is a thin left edge + the folder icon, not a full bar.
//               Each folder has two switches in its own Edit Folder window:
//                 • Show as pictures — its scenes as a 2-wide picture grid (concept C) instead of rows
//                 • Coloured bar     — its header keeps a bar in its colour (C's tinted bar); ON by default
//               Saved on the folder (flags[MOD].dir = { pictures, bar }), so everyone sees the same.
//
// Native-first: a render hook on Foundry's own SceneDirectory adds to its DOM; nothing is replaced. Clicks on
// rows stay Foundry's. Theme-aware through Foundry's CSS variables (styles/pendant-bridge.css `.pb-dir`).
// ──────────────────────────────────────────────────────────────

import {} from "./scene-cover.js"   // scenes tagged "scene cover": Lock View fit + zoom lock, no token vision, gridless
import { realmLive } from "./live.js"

const MOD = "pendant-bridge"
const RECENT_MAX = 8
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

// ── pure rules (tests/scene-dir.test.mjs) ─────────────────────

/** Recent list after viewing `id`: newest first, no repeats, at most `max`. */
export function pushRecent(list, id, max = RECENT_MAX) {
  if (!id) return Array.isArray(list) ? list.slice(0, max) : []
  return [id, ...(Array.isArray(list) ? list : []).filter(x => x !== id)].slice(0, max)
}
/** Every tag on these scenes, sorted, each once (case-insensitive; first spelling wins). */
export function allTags(scenes) {
  const seen = new Map()
  for (const s of scenes || []) for (const t of tagsOf(s)) { const k = t.toLowerCase(); if (!seen.has(k)) seen.set(k, t) }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}
export function tagsOf(scene) {
  const raw = scene?.flags?.[MOD]?.tags ?? scene?.getFlag?.(MOD, "tags")
  return Array.isArray(raw) ? raw.map(t => String(t).trim()).filter(Boolean) : []
}
/** The tag row: the `top` most-used tags (most scenes first, then A–Z), the picked one always among them; the rest fold. */
export function tagRows(scenes, picked = null, top = 8) {
  const n = new Map(), name = new Map()
  for (const s of scenes || []) for (const t of new Set(tagsOf(s).map(x => x.toLowerCase()))) n.set(t, (n.get(t) || 0) + 1)
  for (const s of scenes || []) for (const t of tagsOf(s)) if (!name.has(t.toLowerCase())) name.set(t.toLowerCase(), t)
  const order = [...n.keys()].sort((a, b) => (n.get(b) - n.get(a)) || name.get(a).localeCompare(name.get(b)))
  const shown = order.slice(0, top)
  const p = picked ? String(picked).toLowerCase() : null
  if (p && n.has(p) && !shown.includes(p)) shown.push(p)
  const rest = order.filter(t => !shown.includes(t)).sort((a, b) => name.get(a).localeCompare(name.get(b)))
  return { shown: shown.map(t => name.get(t)), rest: rest.map(t => name.get(t)) }
}
export const hasTag = (scene, tag) => !tag || tagsOf(scene).some(t => t.toLowerCase() === String(tag).toLowerCase())
/** A folder's own switches. */
export function dirOf(folder) {
  const d = folder?.flags?.[MOD]?.dir ?? folder?.getFlag?.(MOD, "dir") ?? {}
  return { pictures: !!d.pictures, bar: d.bar !== false }   // the coloured bar is on unless switched off (the user, 2026-11-17)
}
/** A folder's fast-folder state: { on, scenes } (scene ids, in the order added, no repeats). */
export function fastOf(folder) {
  const f = folder?.flags?.[MOD]?.fast ?? folder?.getFlag?.(MOD, "fast") ?? {}
  const scenes = Array.isArray(f.scenes) ? [...new Set(f.scenes.map(String).filter(Boolean))] : []
  return { on: !!f.on, scenes }
}
export const fastAdd = (ids, id) => (id && !ids.includes(id) ? [...ids, id] : ids)
export const fastRemove = (ids, id) => ids.filter(x => x !== id)
/** A Scene from a drag's text/plain JSON ({ type: "Scene", uuid: "Scene.<id>" } or { id }) → its id, else null. */
export function droppedSceneId(text) {
  let d = null
  try { d = JSON.parse(text) } catch { return null }
  if (!d || d.type !== "Scene") return null
  const id = d.uuid ? String(d.uuid).split(".").pop() : d.id
  return id ? String(id) : null
}

/** The strip's two rows: live + pinned (live first, no repeats, only scenes that still exist), recent (minus those). */
export function stripRows({ live, pins, recent, exists }) {
  const ok = (id) => !!id && exists(id)
  const top = [...new Set([live, ...(pins || [])])].filter(ok)
  const rest = (recent || []).filter(id => ok(id) && !top.includes(id)).slice(0, 5)
  return { top, recent: rest }
}

// ── per-account state ─────────────────────────────────────────
const pinsOf = () => { try { const v = game.user?.getFlag?.(MOD, "scenePins"); return Array.isArray(v) ? v : [] } catch { return [] } }
async function togglePin(id) {
  const pins = pinsOf()
  const next = pins.includes(id) ? pins.filter(x => x !== id) : [...pins, id]
  await game.user.setFlag(MOD, "scenePins", next)
}
const recentOf = () => { try { const v = game.settings.get(MOD, "sceneRecent"); return Array.isArray(v) ? v : [] } catch { return [] } }
let tagPick = null                      // the tag filter: this window only, not saved
let moreTags = false                    // every tag shown (the row of the most-used ones is always there)

Hooks.once("init", () => {
  game.settings.register(MOD, "sceneRecent", { scope: "client", config: false, type: Array, default: [] })
})

// ── the directory ─────────────────────────────────────────────
const on = () => { try { return realmLive() } catch { return false } }
const sceneDir = () => ui?.scenes || null
function rerender() { try { sceneDir()?.render?.() } catch { /* not ready */ } }

function face(scene, live) {
  // "directory-item" + data-entry-id: Foundry's own scene right-click menu (bound to ".directory-item[data-entry-id]"
  // on this sidebar) opens on the picture exactly as on the scene's row (the user, 2026-11-17).
  return `<a class="pb-dir-face directory-item${live ? " live" : ""}" data-entry-id="${esc(scene.id)}" data-pb-view="${esc(scene.id)}" data-tooltip="${esc(scene.name)}">
    ${scene.thumb ? `<img src="${esc(scene.thumb)}" alt="">` : `<span class="pb-dir-nothumb"><i class="fa-solid fa-map"></i></span>`}
    <span>${esc(scene.name)}</span></a>`
}
function strip(scenes) {
  const live = game.scenes?.active?.id || null
  const rows = stripRows({ live, pins: pinsOf(), recent: recentOf(), exists: (id) => !!scenes.get(id) && scenes.get(id).visible !== false })
  const tags = tagRows(scenes.contents || [...scenes], tagPick)
  if (!rows.top.length && !rows.recent.length && !tags.shown.length) return null
  const tagBtn = (t) => `<button type="button" class="pb-dir-tag${tagPick && tagPick.toLowerCase() === t.toLowerCase() ? " on" : ""}" data-pb-tag="${esc(t)}">${esc(t)}</button>`
  const el = document.createElement("section")
  el.className = "pb-dir-strip"
  el.innerHTML = `
    ${rows.top.length ? `<h4>${live && rows.top[0] === live ? "Live · pinned" : "Pinned"}</h4><div class="pb-dir-faces">${rows.top.map(id => face(scenes.get(id), id === live)).join("")}</div>` : ""}
    ${rows.recent.length ? `<h4>Recent</h4><div class="pb-dir-faces">${rows.recent.map(id => face(scenes.get(id), false)).join("")}</div>` : ""}
    ${tags.shown.length ? `<div class="pb-dir-tags">${tags.shown.map(tagBtn).join("")}${tags.rest.length ? `<button type="button" class="pb-dir-tag pb-dir-more" data-pb-more data-tooltip="${moreTags ? "Fewer tags" : "Every tag"}">${moreTags ? "Fewer" : `+${tags.rest.length}`}</button>` : ""}</div>
      ${moreTags && tags.rest.length ? `<div class="pb-dir-tags pb-dir-alltags">${tags.rest.map(tagBtn).join("")}</div>` : ""}` : ""}`
  return el
}

function decorate(root) {
  const scenes = game.scenes
  if (!root || !scenes) return
  root.classList.add("pb-dir")
  const list = root.querySelector(".directory-list")
  if (!list) return

  // The strip, above the tree (replaced on every render).
  root.querySelector(".pb-dir-strip")?.remove()
  const st = strip(scenes)
  if (st) list.before(st)

  // Folders: colour as a variable (the quiet edge + icon), and their two switches.
  for (const li of list.querySelectorAll("li.folder[data-folder-id]")) {
    const f = game.folders?.get(li.dataset.folderId)
    if (!f) continue
    // The colour Foundry itself draws on the header (a folder with no colour has none).
    const c = li.querySelector(":scope > .folder-header")?.style.backgroundColor || f.color?.css || null
    if (c) li.style.setProperty("--pb-c", c)
    const d = dirOf(f)
    li.classList.toggle("pb-pics", d.pictures)
    li.classList.toggle("pb-bar", d.bar)
  }

  // Fast folders: a copy of each of their scenes' rows, inside them (the real row stays where it is).
  for (const li of list.querySelectorAll("li.folder[data-folder-id]")) {
    const f = game.folders?.get(li.dataset.folderId)
    const fast = fastOf(f)
    li.classList.toggle("pb-fast", fast.on)
    for (const old of li.querySelectorAll(":scope > .subdirectory > .pb-fast-copy")) old.remove()
    const head = li.querySelector(":scope > .folder-header")
    head?.querySelector(".pb-fast-mark")?.remove()
    if (!fast.on) continue
    head?.querySelector(".folder-name")?.insertAdjacentHTML("beforebegin", `<i class="fa-solid fa-bolt pb-fast-mark" data-tooltip="Fast folder" inert></i>`)
    let sub = li.querySelector(":scope > .subdirectory")
    if (!sub) { sub = document.createElement("ol"); sub.className = "subdirectory plain"; li.append(sub) }
    const ids = fast.scenes.filter(id => scenes.get(id)).sort((a, b) => scenes.get(a).name.localeCompare(scenes.get(b).name))
    for (const id of ids) sub.append(copyRow(list, scenes.get(id)))
  }

  // Scene rows: a pin star (stays lit when pinned).
  const pins = new Set(pinsOf())
  for (const li of list.querySelectorAll("li[data-entry-id]")) {
    if (li.querySelector(":scope > .pb-dir-pin")) continue
    const id = li.dataset.entryId
    const a = document.createElement("a")
    a.className = `pb-dir-pin${pins.has(id) ? " on" : ""}`
    a.dataset.pbPin = id
    a.dataset.tooltip = pins.has(id) ? "Unpin" : "Pin to the top"
    a.innerHTML = `<i class="fa-solid fa-star"></i>`
    li.append(a)
  }
  applyTag(list)

  // One listener per render (the element is Foundry's and is replaced on re-render).
  if (!root._pbDir) {
    root._pbDir = true
    root.addEventListener("click", onClick, true)
    root.addEventListener("drop", onDrop, true)
  }
}

// A fast folder's row for a scene: Foundry's own row for it, cloned (same classes, picture, name, click action),
// marked as a copy; dragging it drags the real scene, exactly as the real row does.
function copyRow(list, scene) {
  const real = list.querySelector(`li[data-entry-id="${CSS.escape(scene.id)}"]:not(.pb-fast-copy)`)
  let li
  if (real) {
    li = real.cloneNode(true)
    li.querySelector(":scope > .pb-dir-pin")?.remove()
    li.classList.remove("pb-dir-out", "context")
  } else {
    li = document.createElement("li")
    li.className = "directory-item entry document scene"
    li.dataset.entryId = scene.id
    li.innerHTML = `${scene.thumb ? `<img class="thumbnail" src="${esc(scene.thumb)}" alt="${esc(scene.name)}" loading="lazy">` : ""}<a class="entry-name" data-action="activateEntry">${esc(scene.name)}</a>`
  }
  li.classList.add("pb-fast-copy")
  li.style.display = ""
  li.draggable = true
  li.querySelector(".entry-name")?.insertAdjacentHTML("afterbegin", `<i class="fa-solid fa-link pb-fast-link" data-tooltip="Also in its own folder" inert></i>`)
  li.addEventListener("dragstart", (ev) => {
    const data = scene.toDragData ? scene.toDragData() : { type: "Scene", uuid: `Scene.${scene.id}` }
    ev.dataTransfer?.setData("text/plain", JSON.stringify(data))
  })
  return li
}

// Dropping a scene on a fast folder adds it there (the scene stays in its real folder). Caught before Foundry's
// own drop (which would move the scene into the folder).
function onDrop(ev) {
  if (!on() || !game.user?.isGM) return
  const li = ev.target.closest?.("li.folder.pb-fast[data-folder-id]")
  if (!li) return
  const id = droppedSceneId(ev.dataTransfer?.getData("text/plain") || "")
  ev.preventDefault(); ev.stopPropagation()
  if (!id) return ui.notifications?.warn("Only scenes go in a fast folder.")
  const f = game.folders.get(li.dataset.folderId)
  const fast = fastOf(f)
  if (fast.scenes.includes(id)) return
  return f.setFlag(MOD, "fast", { on: true, scenes: fastAdd(fast.scenes, id) }).catch(e => ui.notifications?.warn(e?.message || String(e)))
}
async function setFast(folder, on) { await folder.setFlag(MOD, "fast", { ...fastOf(folder), on: !!on }) }
async function removeFromFast(folderId, sceneId) {
  const f = game.folders.get(folderId)
  if (!f) return
  const fast = fastOf(f)
  await f.setFlag(MOD, "fast", { ...fast, scenes: fastRemove(fast.scenes, sceneId) })
}

// Tag filter: hide scene rows without the tag and folders left empty; open the rest.
function applyTag(list) {
  const want = tagPick
  list.classList.toggle("pb-dir-filtering", !!want)
  for (const li of list.querySelectorAll("li[data-entry-id]")) {
    const s = game.scenes.get(li.dataset.entryId)
    li.classList.toggle("pb-dir-out", !!want && !hasTag(s, want))
  }
  const folders = [...list.querySelectorAll("li.folder[data-folder-id]")].reverse()   // deepest first
  for (const li of folders) {
    const any = !!li.querySelector("li[data-entry-id]:not(.pb-dir-out)")
    li.classList.toggle("pb-dir-out", !!want && !any)
    li.classList.toggle("pb-dir-open", !!want && any)
  }
}

async function onClick(ev) {
  if (!on()) return
  const pin = ev.target.closest("[data-pb-pin]")
  if (pin) {
    ev.preventDefault(); ev.stopPropagation()
    try { await togglePin(pin.dataset.pbPin) } catch (e) { ui.notifications?.warn(e?.message || String(e)) }
    return
  }
  const view = ev.target.closest("[data-pb-view]")
  if (view) {
    ev.preventDefault(); ev.stopPropagation()
    const s = game.scenes.get(view.dataset.pbView)
    if (s) { try { await s.view() } catch (e) { ui.notifications?.warn(e?.message || String(e)) } }
    return
  }
  if (ev.target.closest("[data-pb-more]")) { ev.preventDefault(); ev.stopPropagation(); moreTags = !moreTags; rerender(); return }
  const tag = ev.target.closest("[data-pb-tag]")
  if (tag) {
    ev.preventDefault(); ev.stopPropagation()
    const t = tag.dataset.pbTag
    tagPick = tagPick && tagPick.toLowerCase() === t.toLowerCase() ? null : t
    rerender()
  }
}

function undecorate(root) {
  if (!root) return
  root.classList.remove("pb-dir")
  root.querySelector(".pb-dir-strip")?.remove()
  for (const el of root.querySelectorAll(".pb-dir-pin, .pb-fast-copy, .pb-fast-mark")) el.remove()
  for (const el of root.querySelectorAll(".pb-pics, .pb-bar, .pb-dir-out, .pb-dir-open")) el.classList.remove("pb-pics", "pb-bar", "pb-dir-out", "pb-dir-open")
  for (const el of root.querySelectorAll(".pb-fast")) el.classList.remove("pb-fast")
}

Hooks.on("renderSceneDirectory", (app, element) => {
  const root = element instanceof HTMLElement ? element : element?.[0]
  if (!root) return
  if (on()) decorate(root); else undecorate(root)
})
Hooks.on("pendantBridgeLive", () => rerender())
// Pins and recents redraw the strip.
Hooks.on("updateUser", (user, changes) => { if (user?.id === game.user?.id && changes?.flags?.[MOD] && "scenePins" in changes.flags[MOD]) rerender() })
Hooks.on("updateFolder", (folder, changes) => { if (folder?.type === "Scene" && changes?.flags?.[MOD]) rerender() })
Hooks.on("updateScene", (scene, changes) => { if ("active" in (changes || {}) || "thumb" in (changes || {}) || changes?.flags?.[MOD]?.tags) rerender() })
Hooks.on("canvasReady", () => {
  const id = canvas?.scene?.id
  if (!id) return
  const next = pushRecent(recentOf(), id)
  try { game.settings.set(MOD, "sceneRecent", next).then(() => { if (on()) rerender() }) } catch { /* not ready */ }
})

// ── right-click menus (Foundry's own, on rows, strip pictures and fast-folder copies) ──
const isScenes = (app) => app?.documentName === "Scene" || app?.constructor?.tabName === "scenes" || app?.id === "scenes"
Hooks.on("getSceneContextOptions", (app, options) => {
  if (!Array.isArray(options)) return
  options.push({
    label: "Pin to the top", icon: "fa-solid fa-star",
    visible: (li) => on() && !pinsOf().includes(li.dataset.entryId),
    onClick: (_ev, li) => togglePin(li.dataset.entryId),
  }, {
    label: "Unpin", icon: "fa-regular fa-star",
    visible: (li) => on() && pinsOf().includes(li.dataset.entryId),
    onClick: (_ev, li) => togglePin(li.dataset.entryId),
  }, {
    label: "Remove from fast folder", icon: "fa-solid fa-link-slash",
    visible: (li) => on() && !!game.user?.isGM && li.classList.contains("pb-fast-copy"),
    onClick: (_ev, li) => removeFromFast(li.closest("li.folder[data-folder-id]")?.dataset.folderId, li.dataset.entryId),
  })
})
Hooks.on("getFolderContextOptions", (app, options) => {
  if (!Array.isArray(options) || !isScenes(app)) return
  const folderOf = (header) => game.folders.get(header.closest(".directory-item")?.dataset.folderId)
  options.push({
    label: "Make fast folder", icon: "fa-solid fa-bolt",
    visible: (header) => on() && !!game.user?.isGM && !fastOf(folderOf(header)).on,
    onClick: (_ev, header) => setFast(folderOf(header), true),
  }, {
    label: "Make normal folder", icon: "fa-solid fa-folder",
    visible: (header) => on() && !!game.user?.isGM && fastOf(folderOf(header)).on,
    onClick: (_ev, header) => setFast(folderOf(header), false),
  })
})

// ── the folder's own switches (Edit Folder) ───────────────────
Hooks.on("renderFolderConfig", (app, element) => {
  const root = element instanceof HTMLElement ? element : element?.[0]
  const folder = app?.document ?? app?.object
  if (!root || folder?.type !== "Scene" || root.querySelector(".pb-dir-switches")) return
  const d = dirOf(folder)
  const box = document.createElement("fieldset")
  box.className = "pb-dir-switches"
  box.innerHTML = `<legend>Scenes sidebar</legend>
    <div class="form-group"><label>Show as pictures</label><div class="form-fields"><input type="checkbox" name="flags.${MOD}.dir.pictures" ${d.pictures ? "checked" : ""}></div></div>
    <div class="form-group"><label>Coloured bar</label><div class="form-fields"><input type="checkbox" name="flags.${MOD}.dir.bar" ${d.bar ? "checked" : ""}></div></div>
    <div class="form-group"><label>Fast folder</label><div class="form-fields"><input type="checkbox" name="flags.${MOD}.fast.on" ${fastOf(folder).on ? "checked" : ""}></div></div>`
  const form = root.matches("form") ? root : root.querySelector("form") || root
  const foot = form.querySelector("footer, .form-footer") || form.querySelector("button[type=submit]")
  if (foot) foot.before(box); else form.append(box)
  app.setPosition?.({ height: "auto" })
})

// For the render harness (no effect in Foundry).
export const _test = { decorate, undecorate, applyTag, strip, onDrop, setTag: (t) => { tagPick = t } }
