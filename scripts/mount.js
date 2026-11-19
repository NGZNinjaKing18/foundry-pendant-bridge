// ──────────────────────────────────────────────────────────────
// MOUNT / VEHICLE — our own actor type `pendant-bridge.mount` (module.json documentTypes). Works with RealmScreen
// NOT connected: nothing here touches the relay.
//
//   • a horse / mule / cart / wagon / boat a player can OWN (Details › Owner = a character → that character's
//     players get Owner on it, kept in step by the active GM)
//   • reach it from the character sheet: a "Mounts" card in the sidebar + a row at the top of the Inventory tab
//     (click = open, drop an item on it = store it there), and "Store on <mount>" in dnd5e's item menu
//   • moving things between a character and a mount MOVES them (never a copy); a stack asks how many (Shift = all).
//     Owning both → done here; otherwise the active GM does it (core User queries, V13+), with checks
//   • sheet: Inventory (default) · Anti-Hammer (tack slots → bags; world setting can hide it) · Details (5e stats,
//     attacks, owner, what pulls it, carry limit)
// Pure parts: mount-model.js (tested) + mount-view.js (HTML). Harness: tests/harness/mount.html.
// ──────────────────────────────────────────────────────────────

import { MOD, MOUNT_TYPE, KINDS, SIZES, ABILITIES, SLOTS, kindOf, tackOf, carryMax, totalWeight, bagsOf, packBags,
  spacesByWeight, planMove, planEquip, planTackUp, mayRelay, ownershipFor, kindSystem, abilityMod } from "./mount-model.js"
import { mountSheetHTML, mountCardsHTML, mountStripHTML } from "./mount-view.js"

const QUERY = `${MOD}.mountMove`
const DEFAULT_IMG = `modules/${MOD}/assets/mount.svg`
const NON_PHYSICAL = new Set(["feat", "spell", "class", "subclass", "background", "race", "species", "facility"])

export const isMount = (a) => a?.type === MOUNT_TYPE
const physical = (it) => !!it && !NON_PHYSICAL.has(it.type) && it.system?.quantity != null
const weightOf = (it) => { const w = it?.system?.weight; return typeof w === "number" ? w : Number(w?.value) || 0 }
const qtyOf = (it) => { const n = Number(it?.system?.quantity ?? 1); return Number.isFinite(n) ? n : 1 }
const slotOf = (it) => it?.flags?.[MOD]?.mountSlot || null
const pinOf = (it) => it?.flags?.[MOD]?.mountBag || null
const imgOf = (it) => it?.img || "icons/svg/item-bag.svg"
const amActiveGM = () => !!game.user?.isGM && (game.users?.activeGM ? game.users.activeGM.isSelf : true)
const say = (t, kind = "info") => { try { ui.notifications?.[kind]?.(t) } catch { /* no ui */ } }

/** Anti-Hammer tab on mount sheets (world setting, on by default). */
export function ahInUse() { try { return game.settings.get(MOD, "mountAH") !== false } catch { return true } }

/** Anti-Hammer's own spaces for an item when main.js exposes it, else 1 space per 5 lb. */
function unitOf(it) {
  let f = null
  try { f = globalThis.PendantBridge?.ahItemFoot?.(it) || null } catch { f = null }
  const spaces = f && Number.isFinite(Number(f.spaces)) ? Math.max(1, Math.ceil(Number(f.spaces))) : spacesByWeight(weightOf(it), qtyOf(it))
  const long = f ? !!f.long : /\b(spear|pike|lance|staff|quarterstaff|pole|shovel|halberd|glaive|longbow|ladder)\b/i.test(it.name || "")
  return { id: it.id, name: it.name, type: it.type, qty: qtyOf(it), spaces, long }
}
const tackItems = (actor) => actor.items.filter(physical).map(it => ({ id: it.id, name: it.name, flags: it.flags, slot: slotOf(it) }))

/** Carry limit of any actor that might pull a cart (our mounts, or a dnd5e creature's encumbrance max). */
function pullerMax(id, depth = 0) {
  const a = game.actors?.get(id); if (!a) return 0
  if (isMount(a)) return depth > 2 || kindOf(a.system.kind).drawn ? 0 : mountCarry(a, depth + 1).max
  return Number(a.system?.attributes?.encumbrance?.max) || 0
}
/** { value, max, rule } in pounds. */
export function mountCarry(actor, depth = 0) {
  const s = actor.system, k = kindOf(s.kind)
  const c = carryMax({ kind: s.kind, str: s.abilities?.str?.value, size: s.size, override: s.attributes?.carry, pullerMaxes: k.drawn ? (s.pulledBy || []).map(id => pullerMax(id, depth)) : [] })
  return { value: totalWeight(actor.items.filter(physical).map(it => ({ weight: weightOf(it), qty: qtyOf(it) }))), max: c.max, rule: c.rule }
}
/** The mounts a character owns that this user may at least see. */
export function mountsOf(actor) {
  if (!actor || isMount(actor)) return []
  return (game.actors?.contents || []).filter(a => isMount(a) && a.system.owner === actor.id && a.testUserPermission(game.user, "LIMITED"))
}
const mountCardVM = (m) => ({ id: m.id, name: m.name, img: m.img, kindLabel: kindOf(m.system.kind).label, carry: mountCarry(m) })

/** The Anti-Hammer side of a mount: tack on slots, its bags, what's in them. */
function ahVM(actor) {
  if (!ahInUse()) return null
  const k = kindOf(actor.system.kind), items = actor.items.filter(physical)
  const slots = {}
  if (k.tack) for (const it of items) {
    const s = slotOf(it), t = s && tackOf(it)
    if (!t || !t.fits.includes(s) || slots[s]) continue
    const owner = game.actors?.get(actor.system.owner)
    slots[s] = { id: it.id, name: it.name, gives: t.bags.length > 0, sub: t.rider && owner ? "rider: " + owner.name : t.note || "" }
  }
  const bags = bagsOf(actor.system.kind, tackItems(actor))
  const units = items.filter(it => !tackOf(it) && !it.system?.container).map(unitOf)
  const pins = Object.fromEntries(items.map(it => [it.id, pinOf(it)]).filter(([, p]) => p))
  const packed = packBags(bags, units, pins)
  return { tack: !!k.tack, slots, bags: packed.bags, notPacked: packed.notPacked, where: packed.where }
}

const SECTION_ORDER = [["weapon", "Weapons"], ["equipment", "Equipment"], ["consumable", "Consumables"], ["tool", "Tools"], ["container", "Containers"], ["loot", "Loot"]]
/** Everything the sheet shows. */
export function buildVM(actor, sheet = {}) {
  const s = actor.system, k = kindOf(s.kind), gm = !!game.user?.isGM
  const canEdit = actor.isOwner, ah = ahVM(actor)
  const notPacked = new Set((ah?.notPacked || []).map(u => u.id))
  const rows = actor.items.filter(physical).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name))
  const inside = (it) => it.system?.container ? actor.items.get(it.system.container)?.name : null
  const row = (it) => {
    const t = tackOf(it), sl = slotOf(it)
    const sub = t ? (sl && t.fits.includes(sl) ? "on " + SLOTS[sl][0] : "carried, not on") : inside(it) ? "in " + inside(it) : ""
    return { id: it.id, name: it.name, img: imgOf(it), weight: weightOf(it), qty: qtyOf(it), sub, notPacked: notPacked.has(it.id) }
  }
  const sections = []
  const tack = rows.filter(it => tackOf(it))
  if (tack.length) sections.push({ key: "tack", label: "Tack", items: tack.map(row) })
  const known = new Set(SECTION_ORDER.map(([t]) => t))
  for (const [type, label] of SECTION_ORDER) {
    const list = rows.filter(it => !tackOf(it) && (it.type === type || (type === "loot" && !known.has(it.type))))
    if (list.length || type === "consumable") sections.push({ key: type, label, items: list.map(row), always: type === "consumable" && !rows.length })
  }
  const owner = game.actors?.get(s.owner) || null
  const speed = k.drawn ? "pulled" : [s.attributes?.movement?.walk ? s.attributes.movement.walk + " ft" : "", s.attributes?.movement?.swim ? "swim " + s.attributes.movement.swim + " ft" : ""].filter(Boolean).join(", ")
  const carry = mountCarry(actor)
  const auto = carryMax({ kind: s.kind, str: s.abilities?.str?.value, size: s.size, pullerMaxes: k.drawn ? (s.pulledBy || []).map(id => pullerMax(id)) : [] })
  const owners = (game.actors?.contents || []).filter(a => !isMount(a) && (a.hasPlayerOwner || a.id === s.owner)).sort((a, b) => a.name.localeCompare(b.name)).map(a => ({ id: a.id, name: a.name }))
  const pullers = (game.actors?.contents || []).filter(a => a.id !== actor.id && isMount(a) && !kindOf(a.system.kind).drawn).map(a => ({ id: a.id, name: a.name, label: kindOf(a.system.kind).label }))
  return {
    id: actor.id, name: actor.name, img: actor.img || DEFAULT_IMG, kindKey: KINDS[s.kind] ? s.kind : "ridingHorse", kindLabel: k.label, icon: k.icon,
    sizeLabel: SIZES[s.size] || "Large", isVehicle: !!k.bins, canEdit, isGM: gm, tab: sheet.pbTab || "inventory", find: sheet.pbFind || "",
    ac: s.attributes?.ac?.value ?? 10, hp: { value: s.attributes?.hp?.value ?? 0, max: s.attributes?.hp?.max ?? 0 }, speed,
    owner: owner ? { id: owner.id, name: owner.name } : null, carry, sections, currency: s.currency || {}, ah,
    details: {
      kinds: Object.entries(KINDS).map(([key, v]) => ({ key, label: v.label, group: v.group })), owners, ownerId: s.owner || "",
      abil: k.abil || !k.bins ? ABILITIES.map(a => ({ key: a, value: s.abilities?.[a]?.value ?? 10, mod: abilityMod(s.abilities?.[a]?.value) })) : [],
      ac: s.attributes?.ac?.value ?? 10, speed: k.bins ? String(s.attributes?.movement?.swim || 0) : String(s.attributes?.movement?.walk || 0),
      attacks: s.attacks || [], drawn: !!k.drawn, pullers, pulledBy: s.pulledBy || [],
      carryOverride: s.attributes?.carry ?? null, carryAuto: auto.max, carryRule: auto.rule, description: s.description || "",
    },
  }
}

// ══ moving things ══════════════════════════════════════════════
const queues = new Map()
const queued = (key, fn) => { const p = (queues.get(key) || Promise.resolve()).then(fn, fn); queues.set(key, p.catch(() => {})); return p }

/** Ask how many of a stack (number + slider, all filled in). → n | null */
export async function askHowMany(item, verb, where) {
  const have = qtyOf(item)
  if (have <= 1) return have || 1
  const D = foundry?.applications?.api?.DialogV2
  if (!D?.prompt) return have
  const esc = (x) => String(x ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
  try {
    return await D.prompt({
      window: { title: verb + " " + where }, classes: ["pb-mount-qty"],
      content: '<p>How many <b>' + esc(item.name) + "</b>? <span class=\"hint\">(has " + have + ')</span></p><div class="pb-qty"><input type="range" name="r" min="1" max="' + have + '" value="' + have + '"><input type="number" name="n" min="1" max="' + have + '" value="' + have + '" autofocus></div>',
      render: (ev, dialog) => { const el = dialog?.element || ev?.target?.element; const r = el?.querySelector('[name="r"]'), n = el?.querySelector('[name="n"]'); if (r && n) { r.addEventListener("input", () => { n.value = r.value }); n.addEventListener("input", () => { r.value = n.value }); n.select?.() } },
      ok: { label: verb, icon: "fa-solid fa-check", callback: (e, btn) => Math.max(1, Math.min(have, Math.floor(Number(btn.form.elements.n.value) || have))) },
      rejectClose: false,
    })
  } catch { return null }
}

/** Move `n` of `item` onto actor `to` (optionally straight onto a tack slot / into a bag). */
export async function moveItem(item, to, n, { slot = null, bag = null } = {}) {
  const from = item?.parent
  if (!from || !to || from.uuid === to.uuid) return null
  const payload = { itemUuid: item.uuid, toUuid: to.uuid, n, slot, bag }
  if (from.isOwner && to.isOwner) return applyMove(payload, game.user)
  const gm = game.users?.activeGM
  if (!gm || typeof gm.query !== "function") { say("A GM must be online to move things " + (isMount(to) ? "onto " + to.name : "off " + from.name) + ".", "warn"); return null }
  try { return await gm.query(QUERY, payload, { timeout: 10000 }) }
  catch (e) { say("Couldn't move " + item.name + ": " + (e?.message || e), "error"); return null }
}
/** Store / take with the how-many prompt (Shift = all). */
export async function moveWithPrompt(item, to, { shift = false, slot = null, bag = null } = {}) {
  const from = item?.parent; if (!from) return null
  const verb = isMount(to) ? "Store" : "Take", where = isMount(to) ? "on " + to.name : "from " + from.name
  const n = shift || tackOf(item) ? qtyOf(item) : await askHowMany(item, verb, where)
  if (!n) return null
  const r = await moveItem(item, to, n, { slot, bag })
  if (r) say((isMount(to) ? "Stored " : "Took ") + (n > 1 ? n + " × " : "") + item.name + " " + where)
  return r
}

/** The actual move (on a client that owns both, or the active GM). Create first, then take from the source. */
export async function applyMove({ itemUuid, toUuid, n, slot, bag }, user) {
  const item = await fromUuid(itemUuid), to = await fromUuid(toUuid), from = item?.parent
  if (!item || !from || !to || to.documentName !== "Actor" || from.documentName !== "Actor") throw new Error("it isn't there any more")
  if (!physical(item)) throw new Error(item.name + " can't be stored")
  if (!(from.testUserPermission(user, "OWNER") && to.testUserPermission(user, "OWNER"))) {
    const side = (a) => ({ isMount: isMount(a), userLevel: a.getUserLevel ? a.getUserLevel(user) : (a.testUserPermission(user, "OWNER") ? 3 : a.testUserPermission(user, "OBSERVER") ? 2 : 0) })
    if (!user.isGM && !mayRelay(side(from), side(to))) throw new Error("you can only move things between your character and a mount you can see")
  }
  return queued(from.uuid + ">" + to.uuid, async () => {
    const isTack = !!tackOf(item), have = qtyOf(item)
    const plan = planMove({ id: item.id, name: item.name, type: item.type, qty: have, tack: isTack },
      to.items.filter(physical).filter(t => !t.system?.container).map(t => ({ id: t.id, name: t.name, type: t.type, qty: qtyOf(t), tack: !!tackOf(t) })), n)
    const onMount = isMount(to)
    const mountFlags = (data) => {
      data.flags = data.flags || {}; data.flags[MOD] = { ...(data.flags[MOD] || {}) }
      delete data.flags[MOD].mountSlot; delete data.flags[MOD].mountBag
      if (onMount && bag) data.flags[MOD].mountBag = bag
      return data
    }
    let landedId = null
    const contents = item.type === "container" && plan.sourceLeft === 0 ? (item.system?.contents?.size ?? 0) : 0
    if (contents && typeof CONFIG.Item.documentClass.createWithContents === "function") {
      // a container moves with everything in it (dnd5e's own helper keeps the nesting)
      const data = await CONFIG.Item.documentClass.createWithContents([item], { keepId: !to.items.has(item.id) })
      const top = data.find(d => !d.system?.container) || data[0]
      mountFlags(top); if (top.system) top.system.equipped = false
      const made = await CONFIG.Item.documentClass.createDocuments(data, { parent: to, keepId: true })
      landedId = (made.find(d => !d.system?.container) || made[0])?.id
      await item.delete({ deleteContents: true })
    } else {
      if (plan.mergeInto) {
        const t = to.items.get(plan.mergeInto)
        await t.update({ "system.quantity": qtyOf(t) + plan.n }); landedId = t.id
      } else {
        const data = mountFlags(item.toObject())
        const keepId = plan.sourceLeft === 0 && !to.items.has(item.id)
        if (!keepId) delete data._id
        data.system = { ...(data.system || {}), quantity: plan.n, container: null }
        if ("equipped" in data.system) data.system.equipped = false
        if (onMount && "attuned" in data.system) data.system.attuned = false   // a horse doesn't attune
        const [made] = await to.createEmbeddedDocuments("Item", [data], { keepId })
        landedId = made?.id
      }
      if (plan.sourceLeft <= 0) await item.delete()
      else await item.update({ "system.quantity": plan.sourceLeft })
    }
    if (onMount && slot && landedId) await equipOn(to, landedId, slot)
    return { id: landedId, n: plan.n }
  })
}

/** Put a piece of tack on a slot (whatever was there comes off). */
export async function equipOn(actor, itemId, slot) {
  const it = actor.items.get(itemId); if (!it) return false
  const p = planEquip({ id: it.id, name: it.name, flags: it.flags }, slot, tackItems(actor))
  if (!p.ok) { say(p.why, "warn"); return false }
  await actor.updateEmbeddedDocuments("Item", [{ _id: it.id, [`flags.${MOD}.mountSlot`]: slot }, ...p.off.map(id => ({ _id: id, [`flags.${MOD}.mountSlot`]: null }))])
  return true
}
const takeOff = (actor, itemId) => actor.updateEmbeddedDocuments("Item", [{ _id: itemId, [`flags.${MOD}.mountSlot`]: null }])
async function tackUp(actor) {
  const plan = planTackUp(tackItems(actor)), ups = Object.entries(plan).map(([_id, s]) => ({ _id, [`flags.${MOD}.mountSlot`]: s }))
  if (ups.length) await actor.updateEmbeddedDocuments("Item", ups); else say("Nothing more to put on " + actor.name)
}
const strip = (actor) => actor.updateEmbeddedDocuments("Item", actor.items.filter(it => slotOf(it)).map(it => ({ _id: it.id, [`flags.${MOD}.mountSlot`]: null })))
const packInto = (actor, itemId, bagId) => actor.updateEmbeddedDocuments("Item", [{ _id: itemId, [`flags.${MOD}.mountBag`]: bagId }])
async function splitStack(item) {
  const q = qtyOf(item); if (q < 2) return
  const half = Math.floor(q / 2), data = item.toObject(); delete data._id; data.system.quantity = half
  await item.update({ "system.quantity": q - half }); await item.parent.createEmbeddedDocuments("Item", [data])
}

/** "Start from" a 5e kind: stats, attacks, size (keeps name, Cover, inventory, owner, description). */
async function applyKind(actor, key, { stats }) {
  const sys = kindSystem(key)
  const up = { "system.kind": sys.kind, "system.size": sys.size }
  if (stats) Object.assign(up, { "system.abilities": sys.abilities, "system.attributes.ac": sys.attributes.ac, "system.attributes.hp": sys.attributes.hp, "system.attributes.movement": sys.attributes.movement, "system.attacks": sys.attacks })
  await actor.update(up)
}
/** Are the stats still exactly what the old kind started with? (then changing kind takes the new kind's stats) */
function statsUntouched(actor) {
  const s = actor.system, d = kindSystem(s.kind)
  return ABILITIES.every(a => s.abilities?.[a]?.value === d.abilities[a].value) && s.attributes?.hp?.max === d.attributes.hp.max && s.attributes?.ac?.value === d.attributes.ac.value
}

// ══ the sheet ══════════════════════════════════════════════════
function itemMenu(sheet, target) {
  const actor = sheet.actor, el = target.closest("[data-item-id]"), item = el && actor.items.get(el.dataset.itemId)
  if (!item) return []
  const out = [], ah = ahVM(actor), t = tackOf(item), sl = slotOf(item), edit = actor.isOwner
  if (edit && ah?.tack && t) {
    if (sl) out.push({ label: "Take off", icon: "fa-solid fa-arrow-down", onClick: () => takeOff(actor, item.id) })
    if (sl) for (const o of actor.items) if (o.id !== item.id && tackOf(o)?.fits.includes(sl)) out.push({ label: "Swap for " + o.name, icon: "fa-solid fa-right-left", onClick: () => equipOn(actor, o.id, sl) })
    for (const f of t.fits) if (f !== sl) out.push({ label: "Put on " + SLOTS[f][0] + (ah.slots[f] ? " (swap " + ah.slots[f].name + ")" : ""), icon: "fa-solid fa-arrow-up", onClick: () => equipOn(actor, item.id, f) })
  } else if (edit && ah && !t && !item.system?.container) {
    const here = ah.where[item.id], u = unitOf(item)
    for (const b of ah.bags) if (b.id !== here && (!b.longOnly || u.long) && b.used + u.spaces <= b.cap)
      out.push({ label: (here ? "Move to " : "Pack into ") + b.label + " (" + (b.cap - b.used) + " free)", icon: "fa-solid fa-suitcase", onClick: () => packInto(actor, item.id, b.id) })
  }
  const owner = game.actors?.get(actor.system.owner)
  if (owner) out.push({ label: "Give to " + owner.name, icon: "fa-solid fa-hand-holding", onClick: () => moveWithPrompt(item, owner) })
  if (edit && qtyOf(item) > 1) out.push({ label: "Split stack", icon: "fa-solid fa-arrows-split-up-and-left", onClick: () => splitStack(item) })
  out.push({ label: edit ? "Edit" : "View", icon: "fa-solid fa-" + (edit ? "pen-to-square" : "eye"), onClick: () => item.sheet?.render(true) })
  if (edit) out.push({ label: "Delete", icon: "fa-solid fa-trash", onClick: () => (item.deleteDialog ? item.deleteDialog() : item.delete()) })
  return out
}
function slotMenu(sheet, slot) {
  const actor = sheet.actor, out = []
  if (!actor.isOwner) return [{ label: actor.name + " isn't yours", icon: "fa-solid fa-lock", onClick: () => {} }]
  for (const it of actor.items) { const t = tackOf(it); if (t?.fits.includes(slot)) out.push({ label: it.name + (slotOf(it) ? " (on " + SLOTS[slotOf(it)][0] + ")" : ""), icon: "fa-solid fa-arrow-up", onClick: () => equipOn(actor, it.id, slot) }) }
  const owner = game.actors?.get(actor.system.owner)
  if (owner?.isOwner) for (const it of owner.items) { const t = tackOf(it); if (t?.fits.includes(slot)) out.push({ label: it.name + " (from " + owner.name + ")", icon: "fa-solid fa-arrow-up", onClick: () => moveItem(it, actor, qtyOf(it), { slot }) }) }
  if (!out.length) out.push({ label: "Nothing that fits. Drag " + SLOTS[slot][3] + " here", icon: "fa-solid fa-circle-info", onClick: () => {} })
  return out
}

export function wireSheet(sheet) {
  const root = sheet.element, actor = sheet.actor
  if (!root) return
  const on = (sel, ev, fn) => root.querySelectorAll(sel).forEach(el => el.addEventListener(ev, (e) => fn(e, el)))
  on("[data-pbm-tab]", "click", (e, el) => { e.preventDefault(); sheet.pbTab = el.dataset.pbmTab; sheet.render() })
  on("[data-find]", "input", (e, el) => {
    sheet.pbFind = el.value; const q = el.value.trim().toLowerCase()
    root.querySelectorAll(".pbm-row").forEach(r => { r.hidden = !!q && !(r.querySelector("b")?.textContent || "").toLowerCase().includes(q) })
  })
  const upd = (path, v) => actor.update({ [path]: v })
  on("[data-field]", "change", async (e, el) => {
    const f = el.dataset.field, v = el.value
    if (f === "name") return upd("name", v.trim() || actor.name)
    if (f === "hp") return upd("system.attributes.hp.value", Math.max(0, Math.floor(Number(v) || 0)))
    if (f === "ac") return upd("system.attributes.ac.value", Math.max(0, Math.floor(Number(v) || 0)))
    if (f === "speed") return upd(kindOf(actor.system.kind).bins ? "system.attributes.movement.swim" : "system.attributes.movement.walk", Math.max(0, Math.floor(Number(String(v).replace(/[^\d.]/g, "")) || 0)))
    if (f === "carry") return upd("system.attributes.carry", v === "" ? null : Math.max(0, Number(v) || 0))
    if (f === "description") return upd("system.description", v)
    if (f === "owner") return upd("system.owner", v)
    if (f === "pulledBy") return upd("system.pulledBy", v ? [v] : [])
    if (f === "kind") return applyKind(actor, v, { stats: statsUntouched(actor) })
  })
  on("[data-abil]", "change", (e, el) => upd("system.abilities." + el.dataset.abil + ".value", Math.max(0, Math.floor(Number(el.value) || 0))))
  on("[data-coin]", "change", (e, el) => upd("system.currency." + el.dataset.coin, Math.max(0, Math.floor(Number(el.value) || 0))))
  on("[data-restat]", "click", () => applyKind(actor, actor.system.kind, { stats: true }))
  on("[data-tackup]", "click", () => tackUp(actor))
  on("[data-strip]", "click", () => strip(actor))
  on("[data-open-actor]", "click", (e, el) => game.actors?.get(el.dataset.openActor)?.sheet?.render(true))
  on("[data-qty]", "click", (e, el) => {
    e.stopPropagation(); const it = actor.items.get(el.closest("[data-item-id]")?.dataset.itemId); if (!it) return
    it.update({ "system.quantity": Math.max(0, qtyOf(it) + Number(el.dataset.qty)) })
  })
  on(".pbm-row .pbm-nm", "click", (e, el) => actor.items.get(el.closest("[data-item-id]")?.dataset.itemId)?.sheet?.render(true))
  on("[data-edit-img]", "click", () => {
    const FP = foundry?.applications?.apps?.FilePicker?.implementation || globalThis.FilePicker
    if (FP) new FP({ type: "image", current: actor.img, callback: (path) => actor.update({ img: path }) }).browse?.()
  })
  on("[data-roll]", "click", async (e, el) => {
    const a = (actor.system.attacks || [])[Number(el.closest("[data-attack]")?.dataset.attack)]; if (!a) return
    const hit = el.dataset.roll === "hit", f = hit ? "1d20 " + (/^[+-]/.test(a.toHit.trim()) ? a.toHit : "+ " + a.toHit) : a.damage
    try { await new Roll(f).toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: a.name + (hit ? " · to hit" : " · damage (" + a.type + ")") }) } catch (err) { say("Can't roll " + f, "warn") }
  })
  // menus: right-click any item; click the ⋮, a hex or a tack slot
  const CM = foundry?.applications?.ux?.ContextMenu?.implementation || foundry?.applications?.ux?.ContextMenu
  if (CM && sheet._pbmMenus !== root) {   // the window element outlives re-renders: bind the menus once
    sheet._pbmMenus = root
    const right = new CM(root, "[data-item-id]", [], { jQuery: false, fixed: true, onOpen: (t) => { right.menuItems = itemMenu(sheet, t) } })
    const click = new CM(root, "[data-menu], .pbm-hit, .pbm-slot", [], { eventName: "click", jQuery: false, fixed: true,
      onOpen: (t) => { click.menuItems = t.matches(".pbm-slot.empty") ? slotMenu(sheet, t.dataset.slot) : itemMenu(sheet, t) } })
  }
}

let MountSheetClass = null
function defineSheet() {
  const Base = foundry?.applications?.sheets?.ActorSheetV2
  if (!Base) return null
  return class MountSheet extends Base {
    static DEFAULT_OPTIONS = { classes: ["pb-mount"], position: { width: 680, height: 720 }, window: { resizable: true }, form: { submitOnChange: false, closeOnSubmit: false } }
    pbTab = "inventory"
    pbFind = ""
    async _prepareContext(options) { const c = await super._prepareContext(options); c.pbm = buildVM(this.actor, this); return c }
    async _renderHTML(context) { return mountSheetHTML(context.pbm) }
    _replaceHTML(result, content) { content.innerHTML = result; content.classList.add("pbm") }
    async _onRender(context, options) {
      await super._onRender(context, options)
      // DragDrop is bound to ".draggable" by ActorSheetV2; mark what may be dragged
      if (this.isEditable) this.element.querySelectorAll(".pbm-row, .pbm-slot.filled, .pbm-biglist li").forEach(el => el.classList.add("draggable"))
      wireSheet(this)
    }
    _canDragStart() { return this.isEditable }
    _canDragDrop() { return true }   // players who can only see a shared wagon still drop → the GM does it
    _onDragStart(event) {
      const el = event.currentTarget?.closest?.("[data-item-id]"), it = el && this.actor.items.get(el.dataset.itemId)
      if (it) event.dataTransfer.setData("text/plain", JSON.stringify(it.toDragData()))
    }
    async _onDropItem(event, item) { return dropOnMount(this, event, item) }
    async _onDropActor(event, actor) {
      // drop a horse on a cart = it pulls the cart
      if (!game.user.isGM || !kindOf(this.actor.system.kind).drawn || !isMount(actor) || actor.id === this.actor.id) return
      await this.actor.update({ "system.pulledBy": [actor.id] })
    }
  }
}
export async function dropOnMount(sheet, event, item) {
  const mount = sheet.actor, slotEl = event.target?.closest?.("[data-slot]"), bagEl = event.target?.closest?.("[data-bag]")
  const slot = slotEl?.dataset.slot || null, bag = bagEl?.dataset.bag || null
  if (item.parent?.uuid === mount.uuid) {   // re-arranging on the same mount
    if (!mount.isOwner) return
    if (slot) return equipOn(mount, item.id, slot)
    if (bag) return packInto(mount, item.id, bag)
    return
  }
  if (slot && !tackOf(item)) { say(item.name + " isn't tack. Drop it on a bag instead", "warn"); return }
  if (!item.parent) {   // from the Items sidebar / a compendium: a new copy, like any sheet
    if (!mount.isOwner) return
    const [made] = await mount.createEmbeddedDocuments("Item", [item.toObject()])
    if (made && slot) await equipOn(mount, made.id, slot)
    if (made && bag) await packInto(mount, made.id, bag)
    return
  }
  return moveWithPrompt(item, mount, { shift: !!event.shiftKey, slot, bag })
}

// ══ the character sheet: Mounts card + Inventory row ═══════════
let lastDropShift = false
export function injectCharacter(app, html) {
  const actor = app?.actor || app?.document
  if (!actor || actor.documentName !== "Actor" || isMount(actor)) return
  const root = html instanceof HTMLElement ? html : html?.[0]
  if (!root?.querySelectorAll) return
  root.querySelectorAll(".pbm-cards, .pbm-strip").forEach(n => n.remove())
  const mounts = mountsOf(actor)
  if (!mounts.length) return
  const vms = mounts.map(mountCardVM)
  const sidebar = root.querySelector(".sidebar")
  if (sidebar) {
    const wrap = document.createElement("div"); wrap.innerHTML = mountCardsHTML(vms)
    const card = sidebar.querySelector(":scope > .card")
    card ? card.after(...wrap.children) : sidebar.prepend(...wrap.children)
  }
  const inv = root.querySelector('.tab[data-tab="inventory"], section[data-tab="inventory"]')
  if (inv) { const wrap = document.createElement("div"); wrap.innerHTML = mountStripHTML(vms); inv.prepend(...wrap.children) }
  root.querySelectorAll("[data-pbm-mount]").forEach(el => {
    const mount = game.actors.get(el.dataset.pbmMount); if (!mount) return
    el.addEventListener("click", (e) => { if (e.target.closest("button") && !e.target.closest("[data-pbm-open]")) return; mount.sheet?.render(true) })
    el.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add("drop-ok") })
    el.addEventListener("dragleave", () => el.classList.remove("drop-ok"))
    el.addEventListener("drop", async (e) => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove("drop-ok")
      let data = null; try { data = JSON.parse(e.dataTransfer.getData("text/plain")) } catch { return }
      if (data?.type !== "Item" || !data.uuid) return
      const item = await fromUuid(data.uuid)
      if (!item || item.parent?.uuid !== actor.uuid) { say("Drag things from " + actor.name + "'s own inventory onto " + mount.name, "warn"); return }
      moveWithPrompt(item, mount, { shift: e.shiftKey })
    })
  })
}

// ══ registration ═══════════════════════════════════════════════
function defineModel() {
  const TDM = foundry?.abstract?.TypeDataModel, f = foundry?.data?.fields
  if (!TDM || !f) return null
  const int = (initial, o = {}) => new f.NumberField({ required: true, nullable: false, integer: true, initial, ...o })
  return class MountData extends TDM {
    static defineSchema() {
      return {
        kind: new f.StringField({ required: true, blank: false, initial: "ridingHorse" }),
        size: new f.StringField({ required: true, blank: false, initial: "lg" }),
        abilities: new f.SchemaField(Object.fromEntries(ABILITIES.map((a, i) => [a, new f.SchemaField({ value: int(KINDS.ridingHorse.abil[i], { min: 0 }) })]))),
        attributes: new f.SchemaField({
          ac: new f.SchemaField({ value: int(10, { min: 0 }) }),
          hp: new f.SchemaField({ value: int(13, { min: 0 }), max: int(13, { min: 0 }), temp: int(0, { min: 0 }), tempmax: int(0) }),
          movement: new f.SchemaField({ walk: int(60, { min: 0 }), swim: int(0, { min: 0 }), fly: int(0, { min: 0 }), units: new f.StringField({ initial: "ft" }) }),
          carry: new f.NumberField({ required: false, nullable: true, initial: null, min: 0 }),
        }),
        attacks: new f.ArrayField(new f.SchemaField({ name: new f.StringField(), toHit: new f.StringField(), damage: new f.StringField(), type: new f.StringField() }),
          { initial: KINDS.ridingHorse.attacks.map(([name, toHit, damage, type]) => ({ name, toHit, damage, type })) }),
        owner: new f.StringField({ required: true, blank: true, initial: "" }),
        pulledBy: new f.ArrayField(new f.StringField()),
        currency: new f.SchemaField(Object.fromEntries(["pp", "gp", "ep", "sp", "cp"].map(c => [c, int(0, { min: 0 })]))),
        description: new f.HTMLField({ required: true, blank: true, initial: "" }),
      }
    }
    prepareDerivedData() {
      super.prepareDerivedData?.()
      for (const a of ABILITIES) if (this.abilities[a]) this.abilities[a].mod = abilityMod(this.abilities[a].value)
      const hp = this.attributes.hp
      hp.effectiveMax = Math.max(0, (hp.max || 0) + (hp.tempmax || 0)); hp.damage = hp.effectiveMax - (hp.value || 0)
      hp.pct = hp.effectiveMax ? Math.max(0, Math.min(100, (hp.value / hp.effectiveMax) * 100)) : 0
      // what dnd5e reads when a mount joins a fight (initiative) — a plain Dex check, no proficiency
      const dex = this.abilities.dex?.mod ?? 0
      this.attributes.init = { ability: "dex", mod: dex, bonus: 0, total: dex, prof: { multiplier: 0, hasProficiency: false, term: "0", flat: 0 } }
      this.attributes.prof = 2
    }
    getRollData() {
      const abilities = {}
      for (const a of ABILITIES) abilities[a] = { value: this.abilities[a]?.value ?? 10, mod: this.abilities[a]?.mod ?? 0 }
      return { abilities, attributes: { ac: this.attributes.ac.value, hp: { ...this.attributes.hp }, init: this.attributes.init, prof: 2, movement: { ...this.attributes.movement } }, prof: 2 }
    }
    async _preCreate(data, options, user) {
      if ((await super._preCreate?.(data, options, user)) === false) return false
      const grid = { tiny: 0.5, sm: 1, med: 1, lg: 2, huge: 3, grg: 4 }[this.size] || 1
      const up = { "prototypeToken.actorLink": true }
      if (!foundry.utils.hasProperty(data, "prototypeToken.width")) Object.assign(up, { "prototypeToken.width": grid, "prototypeToken.height": grid })
      if (!foundry.utils.hasProperty(data, "prototypeToken.disposition")) up["prototypeToken.disposition"] = CONST.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1
      this.parent.updateSource(up)
    }
  }
}

/** The active GM keeps a mount's ownership in step with its owner character's players. */
async function syncOwnership(mount) {
  if (!isMount(mount) || !amActiveGM()) return
  const owner = game.actors?.get(mount.system.owner)
  const users = owner ? game.users.filter(u => !u.isGM && owner.testUserPermission(u, "OWNER")).map(u => u.id) : []
  const granted = mount.getFlag(MOD, "granted") || []
  const next = ownershipFor(mount.ownership, granted, users), up = {}
  for (const id of new Set([...Object.keys(mount.ownership || {}), ...Object.keys(next)])) {
    if (next[id] === mount.ownership?.[id]) continue
    up["ownership." + id] = next[id] ?? (CONST.DOCUMENT_OWNERSHIP_LEVELS?.INHERIT ?? -1)
  }
  const same = granted.length === users.length && granted.every(id => users.includes(id))
  if (!Object.keys(up).length && same) return
  up[`flags.${MOD}.granted`] = users
  await mount.update(up)
}
const rerenderOwner = (mount) => { const o = game.actors?.get(mount?.system?.owner); if (o?.sheet?.rendered) o.sheet.render(false) }
const rerenderMounts = () => { for (const a of game.actors?.contents || []) if (isMount(a) && a.sheet?.rendered) a.sheet.render(false) }

Hooks.once("init", () => {
  // the GM side of a move (a player who doesn't own both actors asks the active GM; core User queries, V13+)
  if (CONFIG.queries) CONFIG.queries[QUERY] = async (data, ctx) => {
    if (!amActiveGM()) throw new Error("not the active GM")
    const user = ctx?.user
    if (!user) throw new Error("unknown user")
    return applyMove(data, user)
  }
  game.settings.register(MOD, "mountAH", {
    name: "Mount / Vehicle: Anti-Hammer tab", hint: "Show tack slots and bags on Mount / Vehicle sheets. Off = the inventory list and the pounds limit only.",
    scope: "world", config: true, type: Boolean, default: true, onChange: rerenderMounts,
  })
  const Model = defineModel()
  if (!Model) return
  CONFIG.Actor.dataModels[MOUNT_TYPE] = Model
  try { CONFIG.Actor.typeIcons = CONFIG.Actor.typeIcons || {}; CONFIG.Actor.typeIcons[MOUNT_TYPE] = "fa-solid fa-horse" } catch { /* older core */ }
  try { CONFIG.Actor.trackableAttributes = CONFIG.Actor.trackableAttributes || {}; CONFIG.Actor.trackableAttributes[MOUNT_TYPE] = { bar: ["attributes.hp"], value: ["attributes.ac.value", "attributes.movement.walk"] } } catch { /* older core */ }
  try { if (CONFIG.DND5E?.defaultArtwork?.Actor) CONFIG.DND5E.defaultArtwork.Actor[MOUNT_TYPE] = DEFAULT_IMG } catch { /* not dnd5e */ }
  MountSheetClass = defineSheet()
  if (MountSheetClass) {
    const DSC = foundry?.applications?.apps?.DocumentSheetConfig
    const opts = { types: [MOUNT_TYPE], makeDefault: true, label: "Mount / Vehicle" }
    if (DSC?.registerSheet) DSC.registerSheet(Actor, MOD, MountSheetClass, opts)
    else foundry?.documents?.collections?.Actors?.registerSheet?.(MOD, MountSheetClass, opts)
  }
})

Hooks.once("ready", () => {
  document.addEventListener("drop", (e) => { lastDropShift = !!e.shiftKey }, true)
  if (amActiveGM()) for (const a of game.actors?.contents || []) if (isMount(a) && a.system.owner) syncOwnership(a)
})

// a thing dragged OFF a mount onto a character sheet MOVES (dnd5e would copy it)
Hooks.on("dropActorSheetData", (actor, sheet, data) => {
  if (!actor || isMount(actor) || data?.type !== "Item" || !data.uuid) return
  let item = null; try { item = fromUuidSync(data.uuid) } catch { item = null }
  if (!item?.parent || !isMount(item.parent) || item.parent.uuid === actor.uuid) return
  moveWithPrompt(item, actor, { shift: lastDropShift })
  return false
})

for (const h of ["renderActorSheetV2", "renderActorSheet"]) Hooks.on(h, (app, html) => { try { injectCharacter(app, html) } catch (e) { console.warn("[pendant-bridge] mount card failed", e) } })

// dnd5e's item menu on a character: "Store on <mount>" / "Put on <mount> · <slot>"
Hooks.on("dnd5e.getItemContextOptions", (item, menuItems) => {
  const actor = item?.parent
  if (!actor || isMount(actor) || !physical(item) || !Array.isArray(menuItems)) return
  for (const m of mountsOf(actor)) {
    const t = tackOf(item)
    if (t && ahInUse() && kindOf(m.system.kind).tack) for (const s of t.fits) menuItems.push({ label: "Put on " + m.name + " · " + SLOTS[s][0], name: "Put on " + m.name, icon: "fa-solid fa-horse", group: "pendant-mount", onClick: () => moveItem(item, m, qtyOf(item), { slot: s }), callback: () => moveItem(item, m, qtyOf(item), { slot: s }) })
    else menuItems.push({ label: "Store on " + m.name, name: "Store on " + m.name, icon: "fa-solid fa-horse", group: "pendant-mount", onClick: () => moveWithPrompt(item, m), callback: () => moveWithPrompt(item, m) })
  }
})

// keep ownership + the character's mount card in step
Hooks.on("createActor", (a) => { if (isMount(a)) { syncOwnership(a); rerenderOwner(a) } })
Hooks.on("updateActor", (a, changes) => {
  if (isMount(a)) {
    if (foundry.utils.hasProperty(changes, "system.owner")) { syncOwnership(a); for (const o of game.actors?.contents || []) if (!isMount(o) && o.sheet?.rendered) o.sheet.render(false) }
    else rerenderOwner(a)
    // a cart pulled by this one recomputes its limit
    for (const c of game.actors?.contents || []) if (isMount(c) && (c.system.pulledBy || []).includes(a.id) && c.sheet?.rendered) c.sheet.render(false)
  } else if (changes?.ownership) for (const m of game.actors?.contents || []) if (isMount(m) && m.system.owner === a.id) syncOwnership(m)
})
for (const h of ["createItem", "updateItem", "deleteItem"]) Hooks.on(h, (it) => { const a = it?.parent; if (isMount(a)) rerenderOwner(a) })

export { MountSheetClass }
