// ──────────────────────────────────────────────────────────────
// Scenes sidebar upgrade — the user's pick "D" (mockup tests/harness/folder-concepts.html, 2026-11-17).
// Only while RealmScreen is connected (live.js); not connected = stock Foundry.
//
//   Top strip   Live + pinned scenes, then Recent (this account's last scenes), as small pictures; click = view.
//               Tags (the scenes' own flags[MOD].tags, set from RealmScreen's sorter) filter the tree below.
//   Pin         a ★ on each scene row (shown on hover, stays lit when pinned). Pins are per account (user flag).
//   Folders     quiet look: the folder colour is a thin left edge + the folder icon, not a full bar.
//               Each folder has two switches in its own Edit Folder window:
//                 • Show as pictures — its scenes as a 2-wide picture grid (concept C) instead of rows
//                 • Coloured bar     — its header keeps a bar in its colour (C's tinted bar); ON by default
//               Saved on the folder (flags[MOD].dir = { pictures, bar }), so everyone sees the same.
//
// Native-first: a render hook on Foundry's own SceneDirectory adds to its DOM; nothing is replaced. Clicks on
// rows stay Foundry's. Theme-aware through Foundry's CSS variables (styles/pendant-bridge.css `.pb-dir`).
// ──────────────────────────────────────────────────────────────

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
  return `<a class="pb-dir-face${live ? " live" : ""}" data-pb-view="${esc(scene.id)}" data-tooltip="${esc(scene.name)}">
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
  }
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
  for (const el of root.querySelectorAll(".pb-dir-pin")) el.remove()
  for (const el of root.querySelectorAll(".pb-pics, .pb-bar, .pb-dir-out, .pb-dir-open")) el.classList.remove("pb-pics", "pb-bar", "pb-dir-out", "pb-dir-open")
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
    <div class="form-group"><label>Coloured bar</label><div class="form-fields"><input type="checkbox" name="flags.${MOD}.dir.bar" ${d.bar ? "checked" : ""}></div></div>`
  const form = root.matches("form") ? root : root.querySelector("form") || root
  const foot = form.querySelector("footer, .form-footer") || form.querySelector("button[type=submit]")
  if (foot) foot.before(box); else form.append(box)
  app.setPosition?.({ height: "auto" })
})

// For the render harness (no effect in Foundry).
export const _test = { decorate, undecorate, applyTag, strip, setTag: (t) => { tagPick = t } }
