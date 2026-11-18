// ──────────────────────────────────────────────────────────────
// Item panel — every Item this user can see, in one searchable window.
//
//   • Opened from the Compendium sidebar tab's header (GM only) and from the
//     Inventory tab of a character / NPC sheet (its owners).
//   • Rows = the world's Items + every Item compendium's INDEX (name, img, type;
//     full documents are only loaded to add one). Search by name (every word,
//     any order), filter by compendium and type; 200 rows shown at a time.
//   • Drag a row onto any sheet (standard Foundry drag data { type:"Item", uuid }).
//   • Opened from a sheet: each row has "+" to add it to that actor; double-click
//     opens the item's own sheet.
//   • Players: from their own sheet only; they see just the compendiums / world
//     items Foundry already lets them see, and add only to actors they own — no
//     more than dragging from the Compendium tab already allows.
// Native: ApplicationV2, Foundry's own form controls and CSS variables
// (styles/item-panel.css, scoped to .pb-item-panel).
// ──────────────────────────────────────────────────────────────

import { prepare, search, typesOf, dragData } from "./item-panel-model.js"

const APP_ID = "pb-item-panel"
const ICON = "fa-solid fa-box-open"
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const typeLabel = (t) => { try { const k = CONFIG.Item?.typeLabels?.[t]; return k ? game.i18n.localize(k) : t } catch { return t } }

let rowsCache = null            // prepared rows (rebuilt when items / packs change)
async function loadRows() {
  if (rowsCache) return rowsCache
  const rows = []
  for (const it of game.items ?? []) {
    if (!it.visible) continue
    rows.push({ uuid: it.uuid, name: it.name, img: it.img, type: it.type, source: "world", sourceLabel: "World" })
  }
  const packs = [...(game.packs ?? [])].filter(p => p.documentName === "Item" && p.visible !== false)
  await Promise.all(packs.map(async (p) => {
    try {
      const idx = await p.getIndex()
      for (const e of idx) rows.push({ uuid: e.uuid ?? `Compendium.${p.collection}.Item.${e._id}`, name: e.name, img: e.img, type: e.type, source: p.collection, sourceLabel: p.title })
    } catch (e) { console.warn("[pendant-bridge] Item panel: couldn't read", p.collection, e) }
  }))
  rowsCache = prepare(rows)
  return rowsCache
}
const dirty = () => { rowsCache = null; for (const app of openPanels()) app.refreshRows() }
for (const h of ["createItem", "updateItem", "deleteItem"]) Hooks.on(h, (item) => { if (!item.parent) dirty() })
Hooks.on("updateCompendium", () => dirty())

function* openPanels() {
  for (const app of foundry.applications?.instances?.values?.() ?? []) if (app?.id?.startsWith?.(APP_ID) && app.rendered) yield app
}

let PanelClass = null
function panelClass() {
  const AppV2 = foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  if (PanelClass) return PanelClass
  PanelClass = class ItemPanel extends AppV2 {
    static DEFAULT_OPTIONS = {
      classes: ["pb-item-panel"],
      window: { title: "Item panel", icon: ICON, resizable: true },
      position: { width: 440, height: 640 },
      actions: {
        add: function (ev, t) { this.addRow(t.closest("[data-uuid]")?.dataset.uuid) },
      },
    }
    // The actor is kept off the options (ApplicationV2 merges options; a Document mustn't be cloned).
    constructor(options = {}, actor = null) {
      super(options)
      this.actor = actor
      this.query = ""; this.source = ""; this.type = ""
    }
    get title() { return this.actor ? `Item panel — ${this.actor.name}` : "Item panel" }

    async _renderHTML() {
      const rows = await loadRows()
      const packs = [...new Map(rows.map(r => [r.source, r.sourceLabel])).entries()]
      const el = document.createElement("div")
      el.className = "pb-item-panel-body standard-form"
      el.innerHTML = `
        <div class="pb-ip-filters">
          <input type="search" name="q" placeholder="Search items…" value="${esc(this.query)}" autocomplete="off" aria-label="Search items">
          <div class="form-fields">
            <select name="source" aria-label="Compendium"><option value="">All compendiums</option>
              ${packs.map(([k, l]) => `<option value="${esc(k)}" ${k === this.source ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
            <select name="type" aria-label="Item type"><option value="">All types</option>
              ${typesOf(rows).map(t => `<option value="${esc(t.type)}" ${t.type === this.type ? "selected" : ""}>${esc(typeLabel(t.type))}</option>`).join("")}</select>
          </div>
        </div>
        ${this.actor ? `<p class="hint">Drag onto any sheet, or <i class="fa-solid fa-plus" inert></i> to give it to ${esc(this.actor.name)}.</p>` : `<p class="hint">Drag an item onto a sheet. Double-click to open it.</p>`}
        <ol class="pb-ip-list"></ol>
        <p class="pb-ip-more hint"></p>`
      return el
    }
    _replaceHTML(result, content) {
      content.replaceChildren(result)
      const q = result.querySelector("input[name=q]")
      let t = 0
      q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { this.query = q.value; this.refreshRows() }, 120) })
      result.querySelector("select[name=source]").addEventListener("change", (e) => { this.source = e.target.value; this.refreshRows() })
      result.querySelector("select[name=type]").addEventListener("change", (e) => { this.type = e.target.value; this.refreshRows() })
      const list = result.querySelector(".pb-ip-list")
      list.addEventListener("dragstart", (e) => {
        const li = e.target.closest?.("[data-uuid]")
        if (!li) return
        e.dataTransfer.setData("text/plain", JSON.stringify(dragData({ uuid: li.dataset.uuid })))
      })
      list.addEventListener("dblclick", async (e) => {
        const li = e.target.closest?.("[data-uuid]")
        if (!li || e.target.closest("button")) return
        const doc = await fromUuid(li.dataset.uuid)
        doc?.sheet?.render(true)
      })
      this.refreshRows()
      q.focus()
    }
    async refreshRows() {
      const list = this.element?.querySelector(".pb-ip-list")
      if (!list) return
      const rows = await loadRows()
      const { rows: hit, total } = search(rows, this.query, { source: this.source, type: this.type })
      const canAdd = !!this.actor?.isOwner
      list.innerHTML = hit.map(r => `
        <li class="pb-ip-row" draggable="true" data-uuid="${esc(r.uuid)}" data-tooltip="${esc(r.sourceLabel)}">
          <img src="${esc(r.img || "icons/svg/item-bag.svg")}" alt="" loading="lazy">
          <span class="pb-ip-name">${esc(r.name)}</span>
          <span class="pb-ip-type">${esc(typeLabel(r.type))}</span>
          ${canAdd ? `<button type="button" class="icon fa-solid fa-plus" data-action="add" data-tooltip="Give to ${esc(this.actor.name)}" aria-label="Give to ${esc(this.actor.name)}"></button>` : ""}
        </li>`).join("") || `<li class="hint">No items match.</li>`
      const more = this.element.querySelector(".pb-ip-more")
      if (more) more.textContent = total > hit.length ? `${hit.length} of ${total} shown — type more to narrow it down.` : `${total} item${total === 1 ? "" : "s"}`
    }
    async addRow(uuid) {
      const actor = this.actor
      if (!uuid || !actor?.isOwner) return
      const doc = await fromUuid(uuid)
      if (!doc) return ui.notifications?.warn("That item can't be found any more.")
      const data = doc.pack ? game.items.fromCompendium(doc) : doc.toObject()
      if (!data._stats) data._stats = {}
      data._stats.compendiumSource = doc.pack ? doc.uuid : (doc._stats?.compendiumSource ?? null)
      delete data._id
      await actor.createEmbeddedDocuments("Item", [data])
      ui.notifications?.info(`${doc.name} → ${actor.name}`)
    }
  }
  return PanelClass
}

/** Open the Item panel (for an actor: its own window, with "give to" buttons). */
export function openItemPanel(actor = null) {
  const C = panelClass()
  if (!C) return ui.notifications?.warn("This Foundry version has no ApplicationV2.")
  const id = actor ? `${APP_ID}-${actor.id}` : APP_ID
  const open = foundry.applications.instances?.get?.(id)
  if (open) { open.render({ force: true }); open.bringToFront?.(); return open }
  const app = new C({ id }, actor)
  app.render({ force: true })
  return app
}

// ── the Compendium tab button (GM) ────────────────────────────
function button(label) {
  const b = document.createElement("button")
  b.type = "button"
  b.className = "pb-item-panel-open"
  b.innerHTML = `<i class="${ICON}" inert></i> ${esc(label)}`
  return b
}
Hooks.on("renderCompendiumDirectory", (_app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0]
  if (!root || !game.user?.isGM) return
  root.querySelector(".pb-item-panel-open")?.remove()
  const host = root.querySelector(".header-actions") || root.querySelector(".directory-header") || root
  const b = button("Item panel")
  b.dataset.tooltip = "Every item, with search"
  b.addEventListener("click", (ev) => { ev.preventDefault(); openItemPanel(null) })
  host.append(b)
})

// ── the sheet's Inventory tab (owners) ────────────────────────
function inventoryHost(root) {
  for (const sel of ['.tab[data-tab="inventory"]', 'section[data-tab="inventory"]', 'div[data-tab="inventory"]', '.tab.inventory']) {
    const el = root.querySelector(sel); if (el) return el
  }
  return null
}
function onSheet(app, html) {
  const actor = app?.actor || (app?.document?.documentName === "Actor" ? app.document : null)
  if (!actor || !actor.isOwner || (actor.type !== "character" && actor.type !== "npc")) return
  const root = html instanceof HTMLElement ? html : html?.[0]
  if (!root?.querySelector) return
  root.querySelectorAll(".pb-ip-bar").forEach(n => n.remove())
  const host = inventoryHost(root)
  if (!host) return
  const bar = document.createElement("div")
  bar.className = "pb-ip-bar"
  const b = button("Item panel")
  b.dataset.tooltip = `Every item, with search — add to ${actor.name}`
  b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); openItemPanel(actor) })
  bar.append(b)
  host.prepend(bar)
}
Hooks.on("renderActorSheetV2", onSheet)
Hooks.on("renderActorSheet", onSheet)

globalThis.PendantBridgeItemPanel = { open: openItemPanel }
