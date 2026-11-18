// ──────────────────────────────────────────────────────────────
// Albuna coins on a character sheet (dnd5e) — per actor.
//
//   • Switch: the sheet's header menu (⋮) → "Coins: Albuna" / "Coins: standard".
//     Stored as flags.pendant-bridge.currency = "albuna" (owners may switch).
//   • On an Albuna sheet the currency row reads Gold · Silver · Bronze (the
//     coins stay in dnd5e's gp / sp / cp fields — nothing is rewritten), pp and
//     ep are hidden while empty, and an "Albuna" mark shows the rates.
//   • Converting coins up on an Albuna sheet uses Albuna rates (our own Convert
//     button; dnd5e's own converters are routed here for an Albuna actor).
//
// Limits: dnd5e's CONFIG.DND5E.currencies is world-wide, so item prices, the
// /award command, coin weight and other windows keep their standard names and
// rates. See albuna-model.js.
// ──────────────────────────────────────────────────────────────

import { ALBUNA, FLAG, RATE_TEXT, coin, convertUpdate, isAlbuna, NOT_ALBUNA } from "./albuna-model.js"

const MOD = "pendant-bridge"
const ACTION = "pbAlbunaCoins"
const actorOfSheet = (app) => app?.actor || (app?.document?.documentName === "Actor" ? app.document : null)
const sheetActor = (a) => !!a && (a.type === "character" || a.type === "npc")

export async function setAlbuna(actor, on) {
  if (!actor?.isOwner) return
  if (on) await actor.setFlag(MOD, FLAG, ALBUNA)
  else await actor.unsetFlag(MOD, FLAG)
  ui.notifications?.info(on ? `${actor.name} now counts coins the Albuna way (${RATE_TEXT}).` : `${actor.name} uses standard coins again.`)
}
export async function convertAlbuna(actor) {
  const upd = convertUpdate(actor?.system?.currency)
  if (upd) await actor.update(upd)
  return upd
}

// ── the switch in the sheet's header menu ─────────────────────
function addControl(app, controls) {
  const actor = actorOfSheet(app)
  if (!sheetActor(actor) || !actor.isOwner || !Array.isArray(controls)) return
  if (controls.some(c => c?.action === ACTION)) return
  const on = isAlbuna(actor)
  const toggle = () => setAlbuna(actor, !isAlbuna(actor))
  try { if (app.options?.actions && !app.options.actions[ACTION]) app.options.actions[ACTION] = toggle } catch { /* frozen options */ }
  controls.push({
    action: ACTION, icon: "fa-solid fa-coins",
    label: on ? "Coins: standard (pp/gp/ep/sp/cp)" : "Coins: Albuna (gold/silver/bronze)",
    visible: true, onClick: toggle,
  })
}
Hooks.on("getHeaderControlsActorSheetV2", addControl)      // V13+ (dnd5e 4/5 sheets)
// V1 sheets (older Foundry / dnd5e): the title-bar buttons.
Hooks.on("getActorSheetHeaderButtons", (app, buttons) => {
  const actor = actorOfSheet(app)
  if (!sheetActor(actor) || !actor.isOwner || !Array.isArray(buttons)) return
  buttons.unshift({ class: "pb-albuna-toggle", icon: "fa-solid fa-coins", label: isAlbuna(actor) ? "Standard coins" : "Albuna coins", onclick: () => setAlbuna(actor, !isAlbuna(actor)) })
})

// ── the currency row ──────────────────────────────────────────
function relabel(root, actor) {
  const inputs = root.querySelectorAll('input[name^="system.currency."]')
  if (!inputs.length) return
  const cur = actor.system?.currency || {}
  let row = null
  for (const input of inputs) {
    const key = input.name.split(".").pop()
    const box = input.closest("label, li, .currency-item, .denomination") || input.parentElement
    row ||= input.closest(".currency, .currency-list, ol, ul, .form-fields") || box?.parentElement
    if (NOT_ALBUNA.includes(key)) {
      if (!Number(cur[key])) { box.classList.add("pb-albuna-hide"); continue }
      box.dataset.tooltip = `${key.toUpperCase()}: not an Albuna coin (kept as it is)`
      box.classList.add("pb-albuna-foreign")
      continue
    }
    const c = coin(key)
    if (!c) continue
    box.dataset.tooltip = `${c.label}: ${RATE_TEXT}`
    input.setAttribute("aria-label", c.label)
    if (box.getAttribute("aria-label")) box.setAttribute("aria-label", c.label)   // dnd5e 6: <label aria-label="Copper">…</label>
    input.placeholder = c.abbr
    // dnd5e writes the abbreviation / name as a label or an icon's tooltip; rename what is text.
    for (const el of box.querySelectorAll(".denomination, .label, span")) {
      if (el.children.length) continue
      const t = el.textContent.trim().toLowerCase()
      if (t === key) el.textContent = c.abbr
      else if (/^(gold|silver|copper)$/i.test(t)) el.textContent = c.label
    }
    for (const el of box.querySelectorAll("[data-tooltip], [aria-label]")) {
      if (el === input) continue
      if (el.dataset.tooltip) el.dataset.tooltip = c.label
      if (el.getAttribute("aria-label")) el.setAttribute("aria-label", c.label)
    }
    if (key === "cp") box.classList.add("pb-albuna-bronze")
  }
  if (!row || row.querySelector(":scope > .pb-albuna-mark")) return
  const mark = document.createElement("button")
  mark.type = "button"
  mark.className = "pb-albuna-mark"
  mark.dataset.tooltip = `Albuna coins: ${RATE_TEXT}. Click to change coins up.`
  mark.setAttribute("aria-label", "Albuna coins: change up")
  mark.innerHTML = '<i class="fa-solid fa-coins" inert></i> Albuna'
  mark.disabled = !actor.isOwner
  mark.addEventListener("click", async (ev) => {
    ev.preventDefault(); ev.stopPropagation()
    const upd = await convertAlbuna(actor)
    if (!upd) ui.notifications?.info("Already the fewest coins.")
  })
  row.append(mark)
}
function onSheet(app, html) {
  const actor = actorOfSheet(app)
  if (!sheetActor(actor) || !isAlbuna(actor)) return
  const root = html instanceof HTMLElement ? html : html?.[0]
  if (!root?.querySelectorAll) return
  root.querySelectorAll(".pb-albuna-mark").forEach(n => n.remove())
  try { relabel(root, actor) } catch (e) { console.warn("[pendant-bridge] Albuna coins", e) }
}
Hooks.on("renderActorSheetV2", onSheet)
Hooks.on("renderActorSheet", onSheet)

// ── dnd5e's own "convert currency" → Albuna rates for an Albuna actor ──
function wrapConverters() {
  const wrapStatic = (obj, name) => {
    const orig = obj?.[name]
    if (typeof orig !== "function" || orig._pbAlbuna) return
    const w = function (doc, ...rest) { return (doc?.documentName === "Actor" && isAlbuna(doc)) ? convertAlbuna(doc) : orig.call(this, doc, ...rest) }
    w._pbAlbuna = true
    obj[name] = w
  }
  // dnd5e 4/5: dnd5e.applications.CurrencyManager · dnd5e 6 (the user's world runs 6.0.5): dnd5e.applications.shared.
  // Its Convert button calls `this.constructor.convertCurrency(doc)`, so wrapping the static covers it.
  for (const ns of [globalThis.dnd5e?.applications, globalThis.dnd5e?.applications?.shared]) {
    try { wrapStatic(ns?.CurrencyManager, "convertCurrency") } catch { /* other dnd5e */ }
  }
  try {
    const proto = CONFIG.Actor?.documentClass?.prototype
    const orig = proto?.convertCurrency
    if (typeof orig === "function" && !orig._pbAlbuna) {
      const w = function (...args) { return isAlbuna(this) ? convertAlbuna(this) : orig.apply(this, args) }
      w._pbAlbuna = true
      proto.convertCurrency = w
    }
  } catch { /* no such method */ }
}
Hooks.once("ready", wrapConverters)
