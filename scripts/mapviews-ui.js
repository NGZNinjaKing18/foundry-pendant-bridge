// ──────────────────────────────────────────────────────────────
// Map views — the GM's two buttons in the RealmScreen control set
// (pendant-home _handoffs/map-to-foundry-views-build-plan.md, P6).
//
//   Map views              which view players see (All, or one of the views RealmScreen made), rename /
//                          move / delete a view, "Show me everything" (this GM only), name size / gap, and
//                          Nation names (change what a sent nation's name reads on this scene)
//   Sent from RealmScreen  every World Map thing on this scene, its views and date; click one to go to it
//
// Native: ApplicationV2 windows built from Foundry's own markup and CSS variables (styles/pendant-bridge.css
// `.pb-mv`). The rules live in scripts/mapviews.js; this only shows them.
// ──────────────────────────────────────────────────────────────

import { viewsOf, mapViewsState, mapViewsSet, mapReveal, mapRemove, showEverything, setShowEverything, realmRecords, renamedText, renameNationLabel } from "./mapviews.js"
import { nameScale, nameGap } from "./realm-layer.js"

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const KIND_ICON = { settlement: "fa-solid fa-house", road: "fa-solid fa-road", river: "fa-solid fa-water", nation: "fa-solid fa-flag" }

// The scene the GM is looking at.
const viewedScene = () => canvas?.scene || game.scenes?.viewed || null

const warn = (e) => ui.notifications?.warn(e?.message || String(e))

let ViewsClass = null, SentClass = null

function viewsClass() {
  const AppV2 = foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  if (ViewsClass) return ViewsClass
  ViewsClass = class MapViewsApp extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: "pb-map-views",
      classes: ["pb-mv"],
      window: { title: "Map views", icon: "fa-solid fa-layer-group" },
      position: { width: 280, height: "auto" },
      actions: {
        pick: MapViewsApp.pick, rename: MapViewsApp.rename, up: MapViewsApp.up, down: MapViewsApp.down,
        remove: MapViewsApp.remove, everything: MapViewsApp.everything, resetName: MapViewsApp.resetName,
      },
    }
    async _renderHTML() {
      const el = document.createElement("div")
      const scene = viewedScene()
      if (!scene) { el.innerHTML = `<p class="hint">No scene is open.</p>`; return el }
      const st = mapViewsState({ sceneId: scene.id })
      const count = (id) => st.items.filter(it => id === "all" || (it.views || []).includes(id)).length
      const row = (id, name, i) => `
        <li class="pb-mv-opt${st.current === id ? " active" : ""}">
          <label><input type="radio" name="pbView" data-action="pick" data-id="${esc(id)}" ${st.current === id ? "checked" : ""}> ${esc(name)}</label>
          <span class="pb-mv-n">${count(id)}</span>
          ${id === "all" ? "" : `<span class="pb-mv-acts">
            <a data-action="rename" data-id="${esc(id)}" data-tooltip="Rename"><i class="fa-solid fa-pen"></i></a>
            <a data-action="up" data-id="${esc(id)}" data-tooltip="Move up" ${i === 0 ? 'class="disabled"' : ""}><i class="fa-solid fa-caret-up"></i></a>
            <a data-action="down" data-id="${esc(id)}" data-tooltip="Move down" ${i === st.views.length - 1 ? 'class="disabled"' : ""}><i class="fa-solid fa-caret-down"></i></a>
            <a data-action="remove" data-id="${esc(id)}" data-tooltip="Delete view"><i class="fa-solid fa-trash"></i></a></span>`}
        </li>`
      el.innerHTML = `
        <ul class="pb-mv-list">${row("all", "All")}${st.views.map((v, i) => row(v.id, v.name, i)).join("")}</ul>
        ${st.views.length ? "" : `<p class="hint">No views yet. Make them in RealmScreen — the Foundry chip on its map.</p>`}
        <hr>
        <label class="pb-mv-check"><input type="checkbox" data-action="everything" ${showEverything() ? "checked" : ""}> Show me everything (only you)</label>
        <hr>
        <div class="form-group pb-mv-range"><label>Name size</label><input type="range" name="realmNameScale" min="0.5" max="1.5" step="0.05" value="${nameScale()}"><span class="pb-mv-n">${Math.round(nameScale() * 100)}%</span></div>
        <div class="form-group pb-mv-range"><label>Name gap</label><input type="range" name="realmNameGap" min="0" max="20" step="1" value="${nameGap()}"><span class="pb-mv-n">${nameGap()} px</span></div>
        <p class="hint">Players see the view you pick. Things not in it are hidden for them.</p>
        ${nationNames(scene)}`
      return el
    }
    _replaceHTML(result, content) { content.replaceChildren(result) }

    // The two name sliders: shown live while dragging, saved (for everyone) when let go.
    // A nation name box: saved when you leave it or press Enter; empty = RealmScreen's name again.
    _onRender() {
      for (const input of this.element.querySelectorAll(".pb-mv-nation input")) {
        const save = () => {
          const scene = viewedScene()
          if (!scene || input.value.trim() === input.dataset.now) return
          renameNationLabel(scene, input.dataset.id, input.dataset.from, input.value).catch(warn)
        }
        input.addEventListener("change", save)
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur() } })
      }
      for (const input of this.element.querySelectorAll(".pb-mv-range input")) {
        const out = input.parentElement.querySelector(".pb-mv-n")
        const say = () => { out.textContent = input.name === "realmNameScale" ? `${Math.round(input.value * 100)}%` : `${input.value} px` }
        input.addEventListener("input", say)
        input.addEventListener("change", () => { say(); game.settings.set("pendant-bridge", input.name, Number(input.value)).catch(warn) })
      }
    }

    static async run(op, target, extra = {}) {
      const scene = viewedScene()
      if (!scene) return
      try { await mapViewsSet({ sceneId: scene.id, op, id: target?.dataset?.id, ...extra }) } catch (e) { warn(e) }
    }
    static pick(_e, target) { return MapViewsApp.run("pick", target) }
    static up(_e, target) { return MapViewsApp.run("move", target, { delta: -1 }) }
    static down(_e, target) { return MapViewsApp.run("move", target, { delta: 1 }) }
    static async rename(_e, target) {
      const v = viewsOf(viewedScene()).views.find(x => x.id === target.dataset.id)
      if (!v) return
      const DialogV2 = foundry.applications.api.DialogV2
      const name = await DialogV2.prompt({
        window: { title: "Rename view" },
        content: `<div class="form-group"><label>Name</label><input type="text" name="name" value="${esc(v.name)}" autofocus></div>`,
        ok: { label: "Rename", callback: (_ev, button) => button.form.elements.name.value },
        rejectClose: false,
      }).catch(() => null)
      if (name && name.trim()) return MapViewsApp.run("rename", target, { name: name.trim() })
    }
    static async remove(_e, target) {
      const scene = viewedScene()
      const v = viewsOf(scene).views.find(x => x.id === target.dataset.id)
      if (!v) return
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Delete view" },
        content: `<p>Delete the view <strong>${esc(v.name)}</strong>? What's in it stays on the scene, under All.</p>`,
        rejectClose: false,
      }).catch(() => false)
      if (ok) return MapViewsApp.run("delete", target)
    }
    static async resetName(_e, target) {
      const scene = viewedScene()
      try { await renameNationLabel(scene, target.dataset.id, target.dataset.from, "") } catch (e) { warn(e) }
    }
    static async everything(_e, target) {
      await setShowEverything(!!target.checked)
      this.render()
    }
  }
  return ViewsClass
}

// Every name each sent nation shows on this scene (one per piece that has a name), as a box to change it.
function nationNames(scene) {
  const rows = realmRecords(scene).filter(r => r.kind === "nation" && (r.labels || []).length)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .flatMap(r => [...new Set(r.labels.map(l => l.text))].map(from => {
      const now = renamedText(r, from), changed = now !== from
      return `<li class="pb-mv-nation">
          <input type="text" value="${esc(now)}" placeholder="${esc(from)}" data-id="${esc(r.id)}" data-from="${esc(from)}" data-now="${esc(now)}" aria-label="Name of ${esc(from)}">
          ${changed ? `<a data-action="resetName" data-id="${esc(r.id)}" data-from="${esc(from)}" data-tooltip="Back to RealmScreen's name: ${esc(from)}"><i class="fa-solid fa-rotate-left"></i></a>` : ""}
        </li>`
    }))
  if (!rows.length) return ""
  return `<hr><h4 class="pb-mv-head">Nation names</h4><ul class="pb-mv-nations">${rows.join("")}</ul>
    <p class="hint">Changes the name on this scene only. Sending the nation again keeps it.</p>`
}

function sentClass() {
  const AppV2 = foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  if (SentClass) return SentClass
  SentClass = class SentApp extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: "pb-map-sent",
      classes: ["pb-mv"],
      window: { title: "Sent from RealmScreen", icon: "fa-solid fa-list", resizable: true },
      position: { width: 340, height: 420 },
      actions: { go: SentApp.go, remove: SentApp.remove, removeAll: SentApp.removeAll },
    }
    async _renderHTML() {
      const el = document.createElement("div")
      const scene = viewedScene()
      if (!scene) { el.innerHTML = `<p class="hint">No scene is open.</p>`; return el }
      const st = mapViewsState({ sceneId: scene.id })
      const name = (id) => st.views.find(v => v.id === id)?.name || id
      el.innerHTML = st.items.length
        ? `<div class="pb-mv-sent-head"><span>${st.items.length} on this scene</span><button type="button" data-action="removeAll"><i class="fa-solid fa-trash"></i> Remove all</button></div>
          <ul class="pb-mv-sent">${st.items.map(it => `
            <li data-action="go" data-id="${esc(it.id)}" data-tooltip="Go to it">
              <i class="${KIND_ICON[it.kind] || "fa-solid fa-map"}"></i>
              <span class="pb-mv-name">${esc(it.name || it.kind)}${it.gm ? ` <i class="fa-solid fa-lock" data-tooltip="Hidden from players"></i>` : ""}</span>
              <span class="pb-mv-views">${esc((it.views || []).map(name).join(", ") || "All only")}</span>
              <span class="pb-mv-date">${esc(it.sentAt || "")}</span>
              <a class="pb-mv-x" data-action="remove" data-id="${esc(it.id)}" data-tooltip="Remove from this scene"><i class="fa-solid fa-xmark"></i></a>
            </li>`).join("")}</ul>`
        : `<p class="hint">Nothing on this scene came from RealmScreen yet. Send towns, roads, rivers and nations from their cards on RealmScreen's map.</p>`
      return el
    }
    _replaceHTML(result, content) { content.replaceChildren(result) }
    static async go(_e, target) {
      const scene = viewedScene()
      try { await mapReveal({ sceneId: scene?.id, id: target.dataset.id }) } catch (e) { warn(e) }
    }
    // × on a row: take that thing off this scene (every view). It can be sent again from RealmScreen.
    static async remove(event, target) {
      event?.stopPropagation?.()
      const scene = viewedScene()
      try { await mapRemove({ sceneId: scene?.id, id: target.dataset.id }) } catch (e) { warn(e) }
    }
    // Everything RealmScreen sent to this scene, after a yes.
    static async removeAll() {
      const scene = viewedScene()
      if (!scene) return
      const items = mapViewsState({ sceneId: scene.id }).items
      if (!items.length) return
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Remove everything" },
        content: `<p>Take all <strong>${items.length}</strong> things RealmScreen sent off <strong>${esc(scene.name)}</strong>? You can send them again from RealmScreen.</p>`,
        rejectClose: false,
      }).catch(() => false)
      if (!ok) return
      for (const it of items) { try { await mapRemove({ sceneId: scene.id, id: it.id }) } catch (e) { warn(e) } }
      ui.notifications?.info(`Removed ${items.length} from ${scene.name}.`)
    }
  }
  return SentClass
}

function open(cls) {
  if (!game.user?.isGM) return
  const C = cls()
  if (!C) return ui.notifications?.warn("This Foundry version has no ApplicationV2.")
  const id = C.DEFAULT_OPTIONS.id
  const live = foundry.applications.instances?.get?.(id)
  if (live) { live.render({ force: true }); live.bringToFront?.(); return }
  new C().render({ force: true })
}
export const openMapViews = () => open(viewsClass)
export const openSentList = () => open(sentClass)

// Keep open windows current: a view picked or renamed, a thing sent, moved between views or removed.
function rerender() {
  for (const id of ["pb-map-views", "pb-map-sent"]) foundry.applications?.instances?.get?.(id)?.render()
}
const ours = (doc) => !!doc?.flags?.["pendant-bridge"]?.rs
Hooks.on("updateScene", (scene, changes) => {
  const f = changes?.flags?.["pendant-bridge"]
  if (f && ("mapViews" in f || "realm" in f)) rerender()   // views, or the Realm layer's records
})
for (const type of ["Drawing", "Tile", "Note"]) {
  Hooks.on(`create${type}`, (doc) => { if (ours(doc)) rerender() })
  Hooks.on(`update${type}`, (doc) => { if (ours(doc)) rerender() })
  Hooks.on(`delete${type}`, (doc) => { if (ours(doc)) rerender() })
}
Hooks.on("canvasReady", () => rerender())
