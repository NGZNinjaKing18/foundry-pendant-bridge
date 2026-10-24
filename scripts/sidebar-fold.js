// ──────────────────────────────────────────────────────────────
// Sidebar fold — tuck some sidebar tabs away for players.
//
// While RealmScreen is connected (the same `clockLive` rule the clock dial
// uses), a player's sidebar tab strip shows the folded tabs only behind one
// "More" button. Clicking it opens the group in place; clicking again closes
// it. The GM always sees every tab. Not connected = stock Foundry.
//
// Which tabs fold is a world setting the GM picks in Module Settings ▸
// "Folded sidebar tabs". Until the GM saves a pick, the built-in pick is used
// (Items, Roll Tables, Card Stacks, Macros, Playlists, Dice So Nice,
// conversations). Tidying only — a folded tab is still reachable.
//
// Native-first: Foundry's own tab <li>s are moved into the group, the button
// copies a real tab button's classes, nothing is replaced.
// ──────────────────────────────────────────────────────────────

import { realmLive } from "./clock.js"

const MOD = "pendant-bridge"
const KEY = "sidebarFold"
const OPEN_KEY = `${MOD}.sidebarFoldOpen`

// The built-in pick: core tab ids, plus module tabs found by id or tooltip.
export const DEFAULT_IDS = ["items", "tables", "cards", "macros", "playlists"]
const DEFAULT_MATCH = /dice|convers/i
const NEVER = new Set(["chat", "settings"])   // a player always keeps these

/**
 * The tab ids to fold.
 * @param {{id:string, tooltip?:string}[]} tabs   the tabs in the strip
 * @param {{tabs?:string[]}|null} saved           the GM's pick (null = built-in)
 */
export function pickFolded(tabs, saved) {
  const ids = Array.isArray(saved?.tabs)
    ? tabs.filter(t => saved.tabs.includes(t.id))
    : tabs.filter(t => DEFAULT_IDS.includes(t.id) || DEFAULT_MATCH.test(t.id) || DEFAULT_MATCH.test(t.tooltip || ""))
  return ids.map(t => t.id).filter(id => !NEVER.has(id))
}

const readSaved = () => { try { return game.settings.get(MOD, KEY) || null } catch { return null } }
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) === "1" } catch { return false } }
const writeOpen = (on) => { try { localStorage.setItem(OPEN_KEY, on ? "1" : "0") } catch { /* private mode */ } }

const tipOf = (btn) => {
  const t = btn?.dataset?.tooltip || btn?.getAttribute?.("aria-label") || ""
  try { return game.i18n?.localize(t) || t } catch { return t }
}

/** Every tab button in the strip, in order, as { id, tooltip, li }. */
function stripTabs(menu) {
  return [...menu.querySelectorAll(':scope > li [data-action="tab"][data-tab]')]
    .map(b => ({ id: b.dataset.tab, tooltip: tipOf(b), li: b.closest("li") }))
    .filter(t => t.li && t.li.parentElement === menu)
}

// ── placing ───────────────────────────────────────────────────
function unfold(menu) {
  const group = menu.querySelector(":scope > .pb-fold-group")
  if (group) group.replaceWith(...group.children)   // tabs go back where the group was
  menu.querySelector(":scope > .pb-fold")?.remove()
  menu.closest("#sidebar-tabs")?.classList.remove("pb-folding")
}

function place() {
  const menu = document.querySelector("#sidebar-tabs > menu")
  if (!menu) return
  unfold(menu)
  if (game.user?.isGM || !realmLive()) return

  const tabs = stripTabs(menu)
  const folded = new Set(pickFolded(tabs, readSaved()))
  const lis = tabs.filter(t => folded.has(t.id)).map(t => t.li)
  const shown = lis.filter(l => !l.hidden).length   // Foundry hides tabs a player can't use
  if (!shown) return

  // Keep the group above the Compendium / Settings pair at the bottom.
  const anchor = tabs.find(t => t.id === "compendium" && !folded.has(t.id))?.li
    || tabs.find(t => t.id === "settings")?.li || null

  const sample = menu.querySelector('[data-action="tab"]')
  const li = document.createElement("li")
  li.className = "pb-fold"
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = (sample?.className || "ui-control plain icon")
    .split(/\s+/).filter(c => c && !/^fa-/.test(c) && c !== "active").join(" ")
  btn.classList.add("fa-solid")
  li.append(btn)

  const group = document.createElement("li")
  group.className = "pb-fold-group"
  const inner = document.createElement("menu")
  inner.className = "pb-fold-tabs"
  group.append(inner)
  // The group holds Foundry's own <li>s; a wrapper <li> with a <menu> keeps the list valid.
  inner.append(...lis)

  menu.insertBefore(li, anchor)
  menu.insertBefore(group, anchor)
  menu.closest("#sidebar-tabs")?.classList.add("pb-folding")

  // A folded tab that is the open one keeps the group open.
  const activeFolded = lis.some(l => l.querySelector('[data-tab].active, [data-tab][aria-pressed="true"]'))
  const setOpen = (on) => {
    group.hidden = !on
    btn.classList.toggle("fa-ellipsis", !on)
    btn.classList.toggle("fa-chevron-up", on)
    btn.dataset.tooltip = on ? "Fewer tabs" : `More tabs (${shown})`
    btn.ariaLabel = btn.dataset.tooltip
    btn.setAttribute("aria-expanded", on ? "true" : "false")
  }
  setOpen(readOpen() || activeFolded)
  btn.addEventListener("click", (ev) => {
    ev.preventDefault(); ev.stopPropagation()
    const on = group.hidden
    writeOpen(on); setOpen(on)
  })
}

// ── GM picker (Module Settings ▸ Folded sidebar tabs) ─────────
function makeMenuClass() {
  const AppV2 = foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  return class SidebarFoldConfig extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: "pendant-bridge-sidebar-fold",
      tag: "form",
      window: { title: "Folded sidebar tabs", icon: "fa-solid fa-ellipsis" },
      position: { width: 420 },
      form: { handler: SidebarFoldConfig.#onSubmit, closeOnSubmit: true },
    }

    async _renderHTML() {
      const menu = document.querySelector("#sidebar-tabs > menu")
      // Read the strip with the fold opened up so the order is Foundry's own.
      const tabs = []
      if (menu) {
        for (const b of menu.querySelectorAll('[data-action="tab"][data-tab]')) tabs.push({ id: b.dataset.tab, tooltip: tipOf(b) })
      }
      const picked = new Set(pickFolded(tabs, readSaved()))
      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
      const rows = tabs.filter(t => !NEVER.has(t.id)).map(t =>
        `<div class="form-group"><label for="pb-fold-${esc(t.id)}">${esc(t.tooltip || t.id)}</label>` +
        `<div class="form-fields"><input type="checkbox" id="pb-fold-${esc(t.id)}" name="${esc(t.id)}" ${picked.has(t.id) ? "checked" : ""}></div></div>`).join("")
      const el = document.createElement("div")
      el.innerHTML =
        `<p class="hint">Ticked tabs sit behind one “More” button on players’ sidebars while RealmScreen is connected. You always see every tab. It only tidies — a folded tab is still reachable.</p>` +
        `<fieldset>${rows || `<p class="hint">No sidebar tabs found.</p>`}</fieldset>` +
        `<footer class="form-footer"><button type="button" data-action="resetDefault"><i class="fa-solid fa-rotate-left"></i><span>Built-in pick</span></button>` +
        `<button type="submit"><i class="fa-solid fa-floppy-disk"></i><span>Save</span></button></footer>`
      return el
    }

    _replaceHTML(result, content) { content.replaceChildren(...result.children) }

    _onRender(context, options) {
      super._onRender?.(context, options)
      this.element.querySelector('[data-action="resetDefault"]')?.addEventListener("click", async (ev) => {
        ev.preventDefault()
        await game.settings.set(MOD, KEY, null)
        this.render()
      })
    }

    static async #onSubmit(event, form, formData) {
      const data = formData.object || {}
      const tabs = Object.keys(data).filter(k => data[k] === true)
      await game.settings.set(MOD, KEY, { tabs })
    }
  }
}

// ── hooks ─────────────────────────────────────────────────────
Hooks.once("init", () => {
  game.settings.register(MOD, KEY, {
    scope: "world", config: false, type: Object, default: null, onChange: () => place()
  })
  const type = makeMenuClass()
  if (type) {
    game.settings.registerMenu(MOD, `${KEY}Menu`, {
      name: "Folded sidebar tabs",
      label: "Choose tabs",
      hint: "While RealmScreen is connected, players see these sidebar tabs only behind a “More” button.",
      icon: "fa-solid fa-ellipsis",
      type,
      restricted: true,
    })
  }
})
Hooks.on("renderSidebar", () => place())
Hooks.on("changeSidebarTab", () => place())
Hooks.on("pendantBridgeLive", () => place())
Hooks.once("ready", () => place())
