// ──────────────────────────────────────────────────────────────
// Rations on a party (dnd5e Group) — GM ONLY.
//
//   • Count — each member's rations, read from their own inventory: every item
//     named "Ration(s)…" (dnd5e's "Rations (1 day)" is a food consumable), its
//     quantity summed. Shown as a number on each face of the Token HUD fan
//     (group-stack.js) and as a "Rations" strip on the group sheet's Members tab.
//   • Take — "Take rations…" (HUD wheat button / the strip's button): the GM
//     types X; the dialog previews each member's count before → after and who
//     runs short; OK takes X from every member's own stacks (never below 0,
//     items are kept at 0, never deleted) and whispers the GMs what happened.
//
// Nothing here is drawn or sent for a player: every entry point checks
// game.user.isGM, and the result goes only to GM whispers.
// ──────────────────────────────────────────────────────────────

const RATION = /\brations?\b/i
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

// ── pure helpers (tested) ─────────────────────────────────────

/** Is this item a ration? Any item named "Ration"/"Rations…" (not a container or a spell / feature). */
export function isRation(item) {
  if (!item || !RATION.test(String(item.name || ""))) return false
  return !["container", "spell", "feat", "class", "subclass", "background", "race", "species"].includes(item.type)
}
const qty = (item) => Math.max(0, Math.floor(Number(item?.system?.quantity ?? 1) || 0))

/** An actor's ration stacks → [{ id, name, qty }] (in inventory order). */
export function rationStacks(items) {
  const out = []
  for (const it of (items || [])) if (isRation(it)) out.push({ id: it.id ?? it._id, name: it.name, qty: qty(it) })
  return out
}
export const rationCount = (items) => rationStacks(items).reduce((n, s) => n + s.qty, 0)

/** Whole number ≥ 0 from what the GM typed (anything else → 0). */
export function takeAmount(v) {
  const n = Math.floor(Number(String(v ?? "").trim()))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * What taking `x` from each member does. members: [{ id, name, stacks: [{ id, qty }] }].
 * Takes from the smallest stack first (leftover single rations go before a full pack).
 * → [{ id, name, before, after, took, short, updates: [{ _id, "system.quantity" }] }]
 */
export function planTake(members, x) {
  const want = takeAmount(x)
  const seen = new Set()
  const out = []
  for (const m of (members || [])) {
    if (!m || seen.has(m.id)) continue
    seen.add(m.id)
    const stacks = (m.stacks || []).map(s => ({ ...s, qty: Math.max(0, s.qty | 0) }))
    const before = stacks.reduce((n, s) => n + s.qty, 0)
    let left = want
    const updates = []
    for (const s of [...stacks].sort((a, b) => a.qty - b.qty)) {
      if (!left) break
      if (!s.qty) continue
      const t = Math.min(s.qty, left)
      left -= t
      updates.push({ _id: s.id, "system.quantity": s.qty - t })
    }
    const took = want - left
    out.push({ id: m.id, name: m.name, before, after: before - took, took, short: left, updates })
  }
  return out
}

/** The plan as table rows (dialog preview + the GM whisper). */
export function planRows(plan) {
  return plan.map(p => `<tr class="${p.short ? "pb-rat-short" : ""}"><td>${esc(p.name)}</td><td class="pb-rat-n">${p.before} → ${p.after}</td>`
    + `<td>${p.short ? `short ${p.short}` : ""}</td></tr>`).join("")
}

// ── Foundry side ──────────────────────────────────────────────

const isParty = (a) => a?.type === "group"
const gm = () => !!globalThis.game?.user?.isGM

async function membersOf(group) {
  try { return ((await group.system.getMembers?.()) || []).filter(m => m.actor).map(m => m.actor) } catch { return [] }
}

/** GM-only: the ration count of an actor, or null for players / not a party member. */
export function rationsFor(actor) { return gm() && actor ? rationCount(actor.items) : null }

/** The number badge for a Token HUD fan face (group-stack.js). Players get nothing. */
export function rationBadge(group, actor) {
  if (!gm() || !isParty(group) || !actor) return null
  const n = rationCount(actor.items)
  const b = document.createElement("span")
  b.className = "pb-rat-badge" + (n ? "" : " empty")
  b.textContent = String(n)
  b.setAttribute("aria-label", `${n} ration${n === 1 ? "" : "s"}`)
  return b
}

/** "Take rations…" — type X, see who'd run short, OK takes them. */
export async function takeRations(group) {
  if (!gm() || !isParty(group)) return null
  const actors = await membersOf(group)
  if (!actors.length) { ui.notifications?.warn(`${group.name} has no members.`); return null }
  const members = () => actors.map(a => ({ id: a.id, name: a.name, stacks: rationStacks(a.items) }))
  const D = foundry.applications.api.DialogV2
  const x = await D.wait({
    window: { title: `Take rations — ${group.name}`, icon: "fa-solid fa-wheat-awn" },
    classes: ["pb-rat-dialog"],
    content: `<div class="form-group"><label>Rations from each member</label><div class="form-fields">`
      + `<input type="number" name="x" value="1" min="0" step="1" autofocus></div></div>`
      + `<table class="pb-rat-table"><tbody>${planRows(planTake(members(), 1))}</tbody></table>`
      + `<p class="hint">Takes from each member's own inventory; nobody goes below 0.</p>`,
    buttons: [
      { action: "take", label: "Take", icon: "fa-solid fa-check", default: true, callback: (_e, button) => ({ x: takeAmount(button.form.elements.x.value) }) },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => ({ x: 0 }) },
    ],
    render: (_e, dialog) => {
      const root = dialog?.element ?? dialog
      const input = root?.querySelector?.('input[name="x"]')
      const body = root?.querySelector?.(".pb-rat-table tbody")
      input?.addEventListener("input", () => { body.innerHTML = planRows(planTake(members(), input.value)) })
      input?.select?.()
    },
    rejectClose: false,
  }).catch(() => null)
  const want = takeAmount(x?.x)
  if (!want) return null

  // Re-read now: the preview may be stale by the time OK is pressed.
  const plan = planTake(members(), want)
  for (const p of plan) {
    if (!p.updates.length) continue
    const a = actors.find(y => y.id === p.id)
    try { await a.updateEmbeddedDocuments("Item", p.updates) } catch (e) { console.warn("[pendant-bridge] rations", a?.name, e); p.failed = true }
  }
  const short = plan.filter(p => p.short)
  const failed = plan.filter(p => p.failed)
  try {
    await ChatMessage.create({
      speaker: { alias: group.name },
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
      content: `<div class="pb-rat-chat"><p><strong>${want} ration${want === 1 ? "" : "s"}</strong> taken from each member of ${esc(group.name)}.</p>`
        + `<table class="pb-rat-table"><tbody>${planRows(plan)}</tbody></table>`
        + (failed.length ? `<p>Couldn't change: ${failed.map(p => esc(p.name)).join(", ")}.</p>` : "") + `</div>`,
    })
  } catch (e) { console.warn("[pendant-bridge] rations chat", e) }
  if (short.length) ui.notifications?.warn(`Ran short: ${short.map(p => `${p.name} (${p.short})`).join(", ")}`)
  else ui.notifications?.info(`Took ${want} ration${want === 1 ? "" : "s"} from everyone in ${group.name}.`)
  return plan
}

// ── Token HUD: the wheat button (kept in view by group-stack's fold) ──
Hooks.on("renderTokenHUD", (hud, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0]
  root?.querySelector?.(".pb-rat-hud")?.remove()
  const group = hud.document?.actor ?? hud.object?.actor
  if (!root || !gm() || !isParty(group)) return
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "control-icon pb-rat-hud"
  btn.dataset.action = "pb-rations"
  btn.dataset.tooltip = "Take rations…"
  btn.setAttribute("aria-label", "Take rations from every member")
  btn.innerHTML = '<i class="fa-solid fa-wheat-awn" inert></i>'
  btn.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); takeRations(group) })
  ;(root.querySelector(".col.right") || root).append(btn)
})

// ── group sheet: the "Rations" strip on the Members tab ──────
Hooks.on("renderActorSheetV2", async (app, html) => {
  const group = app.document
  if (!isParty(group)) return
  const root = html instanceof HTMLElement ? html : html?.[0]
  const part = root?.querySelector?.("[data-application-part=members]")
  if (!part) return
  part.querySelector(".pb-rat-strip")?.remove()
  if (!gm()) return
  const actors = await membersOf(group)
  part.querySelector(".pb-rat-strip")?.remove()          // a second render may have finished first
  if (!actors.length) return
  const strip = document.createElement("div")
  strip.className = "pb-rat-strip"
  strip.innerHTML = `<div class="pb-rat-head"><span class="pb-rat-title">Rations</span>`
    + `<span class="pb-rat-hint"><i class="fa-solid fa-eye-slash" inert></i> GM only</span>`
    + `<button type="button" class="pb-rat-take"><i class="fa-solid fa-wheat-awn" inert></i> Take…</button></div>`
    + `<ul class="pb-rat-list">${actors.map(a => { const n = rationCount(a.items); return `<li class="${n ? "" : "empty"}" data-tooltip="${esc(a.name)}">`
      + `<span class="pb-rat-name">${esc(a.name)}</span><span class="pb-rat-n">${n}</span></li>` }).join("")}</ul>`
  strip.querySelector(".pb-rat-take").addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); takeRations(group) })
  const host = part.querySelector(":scope > section") || part
  host.append(strip)
})

// A member's rations changed → redraw an open HUD / sheet of a party they're in.
function refresh(ids) {
  const holds = (g) => isParty(g) && (g.system?.toObject?.().members ?? []).some(m => ids.has(m.actor ?? m.uuid?.split(".").pop()))
  const hud = canvas?.hud?.token
  if (hud?.rendered && holds(hud.document?.actor ?? hud.object?.actor)) hud.render()
  for (const app of foundry.applications.instances?.values?.() ?? []) if (app.rendered && holds(app.document)) app.render()
}
// (one redraw for a whole Take: it changes several members' items at once)
const changed = new Set()
let pending = null
for (const h of ["createItem", "updateItem", "deleteItem"]) Hooks.on(h, (item) => {
  if (!gm() || !isRation(item) || !item.parent?.id) return
  changed.add(item.parent.id)
  pending ??= setTimeout(() => { pending = null; const ids = new Set(changed); changed.clear(); try { refresh(ids) } catch { /* best effort */ } }, 50)
})
