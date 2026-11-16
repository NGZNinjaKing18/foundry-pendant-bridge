// ──────────────────────────────────────────────────────────────
// Realm menu — the hotbar's hooded-figure button (Foundry's ☰ "menu" button,
// re-iconed in pendant-bridge.css) opens a second bar in the hotbar's place:
// the same black slot boxes — no key numbers, no volume button, no page
// arrows, no lock, no trash. Pressing it again brings the normal hotbar back.
// Foundry's main menu stays on Esc.
//
// Boxes so far (the rest stay empty):
//   1  Grid      — RealmScreen's world-map grid, this account only (my-view.js)
//   2  Nations   — the nation borders RealmScreen sent, this account only
//   3  Next day  — the running campaign's date (no session = the world date) moves
//                  to the next day, 6 am. RealmScreen moves it (clock.js askStep).
//                  Players get it too, behind an "are you sure"; the GM doesn't.
// Grid / Nations = the same switches as the eye's column; lit = showing.
// Icons: assets/icon-*.svg, drawn as masks in the button's text colour (pendant-bridge.css).
//
// Native-first: Foundry's hotbar element and buttons are kept; the stock
// parts are only hidden (visibility, so nothing shifts) while the bar is open.
// ──────────────────────────────────────────────────────────────

import { seeing, toggleSee } from "./my-view.js"
import { askStep, PLAYER_STEP } from "./clock.js"

export const SLOT_COUNT = 10
/** The boxes that do something, in order from the left. */
export const SLOTS = [
  { see: "grid", label: "Grid", icon: "grid" },
  { see: "borders", label: "Nations", icon: "nations" },
  { act: "nextDay", label: "Next day (6 am)", icon: "next-day" },
]
/** What an action box asks for. */
export const ACTS = { nextDay: PLAYER_STEP }

/** A player's "are you sure" before an action box (the GM goes straight through). → true = go. */
export async function confirmAct(a, gm = !!globalThis.game?.user?.isGM) {
  if (gm) return true
  const D = globalThis.foundry?.applications?.api?.DialogV2
  if (!D) return false
  const s = SLOTS.find(x => x.act === a)
  return !!(await D.confirm({
    window: { title: s?.label || "Are you sure?" },
    content: "<p>Move the day on? It becomes the next day, 6 am, for the whole table.</p>",
    yes: { label: "Next day" }, no: { label: "Cancel" },
    rejectClose: false,
  }).catch(() => false))
}
const doAct = async (a) => { if (await confirmAct(a)) askStep(ACTS[a]) }
const OPEN = "pb-realm-open"
let open = false

/** The bar's markup: the boxes in SLOTS first (GM-only ones only for a GM), then empty ones up to `n`. */
export function barHtml(n = SLOT_COUNT, gm = !!globalThis.game?.user?.isGM) {
  const slots = SLOTS.filter(s => !s.gm || gm)
  let html = ""
  for (let i = 0; i < n; i++) {
    const s = slots[i]
    const icon = s ? `<span class="pb-realm-icon" data-icon="${s.icon}" inert></span>` : ""
    html += !s ? '<li class="pb-realm-slot"></li>'
      : s.see ? `<li class="pb-realm-slot pb-realm-toggle" data-see="${s.see}" role="button" tabindex="0">${icon}</li>`
      : `<li class="pb-realm-slot pb-realm-act" data-act="${s.act}" role="button" tabindex="0" data-tooltip="${s.label}" aria-label="${s.label}">${icon}</li>`
  }
  return `<ol class="pb-realm-bar">${html}</ol>`
}

/** Light each toggle box by its switch. */
export function paintBar(root = document.getElementById("hotbar"), see = seeing) {
  for (const b of root?.querySelectorAll(".pb-realm-toggle") ?? []) {
    const s = SLOTS.find(x => x.see === b.dataset.see), on = !!see(s.see)
    b.classList.toggle("active", on)
    b.setAttribute("aria-pressed", on ? "true" : "false")
    b.dataset.tooltip = `${s.label}: ${on ? "shown" : "hidden"}`
    b.setAttribute("aria-label", b.dataset.tooltip)
  }
}

/** Wire one rendered hotbar (Foundry re-renders it, so this runs each time). */
export function wireHotbar(el, flip = toggleSee, see = seeing, act = doAct) {
  if (!el) return
  const btn = el.querySelector('button[data-action="menu"]')
  if (!btn) return
  let bar = el.querySelector(".pb-realm-bar")
  if (!bar) {
    el.querySelector("#action-bar")?.insertAdjacentHTML("afterend", barHtml())
    bar = el.querySelector(".pb-realm-bar")
    for (const b of bar?.querySelectorAll(".pb-realm-toggle") ?? []) {
      const go = async (e) => {
        e.preventDefault(); e.stopPropagation()
        await flip(b.dataset.see)
        paintBar(el, see)
      }
      b.addEventListener("click", go)
      b.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") go(e) })
    }
    for (const b of bar?.querySelectorAll(".pb-realm-act") ?? []) {
      const go = (e) => { e.preventDefault(); e.stopPropagation(); act(b.dataset.act) }
      b.addEventListener("click", go)
      b.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") go(e) })
    }
  }
  paintBar(el, see)
  btn.dataset.tooltip = "Menu"
  btn.setAttribute("aria-label", "Menu")
  // Capture on the button itself: runs before ApplicationV2's delegated
  // action listener on the hotbar, which would open the main menu.
  if (!btn.dataset.pbRealm) {
    btn.dataset.pbRealm = "1"
    btn.addEventListener("click", ev => {
      ev.preventDefault()
      ev.stopPropagation()
      open = !open
      el.classList.toggle(OPEN, open)
    }, { capture: true })
  }
  el.classList.toggle(OPEN, open)
}

Hooks.on("renderHotbar", (_app, html) => {
  wireHotbar(html instanceof HTMLElement ? html : html?.[0] ?? document.getElementById("hotbar"))
})
// The eye's column (or another device) flipped a switch: keep the boxes in step.
Hooks.on("pendantSeeChanged", () => paintBar())
