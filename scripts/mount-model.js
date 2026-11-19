// ──────────────────────────────────────────────────────────────
// MOUNT / VEHICLE — the pure parts (no Foundry globals; node-tested in tests/mount.test.mjs).
//
// Our own actor type `pendant-bridge.mount` (the user, 2026-11-18): a horse, mule, cart, wagon or boat a player
// can own, open from their character, and store things on. One type; "Start from" a 5e stat block.
//   • carry limit in POUNDS (5e: Str × 15 × size; Beast of Burden counts one size up; drawn = 5 × what pulls it)
//   • Anti-Hammer side: TACK goes on SLOTS around the animal (Head, Body, Back, Flanks, sides, Rear, Harness);
//     each piece of tack that is ON gives its BAGS (saddlebags → two 8-space bags…). Carts/boats have a built-in bed.
//   • moving things between a character and a mount MOVES them (never a copy), a stack can be split.
// Plan + answers: pendant-home graphify-out/obsidian/_handoffs/mount-actor-plan.md
// ──────────────────────────────────────────────────────────────

export const MOD = "pendant-bridge"
export const MOUNT_TYPE = `${MOD}.mount`
export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"]
export const SIZES = { tiny: "Tiny", sm: "Small", med: "Medium", lg: "Large", huge: "Huge", grg: "Gargantuan" }
export const SIZE_MULT = { tiny: 0.5, sm: 1, med: 1, lg: 2, huge: 4, grg: 8 }
const SIZE_ORDER = ["tiny", "sm", "med", "lg", "huge", "grg"]
export const DRAFT_MULT = 5

// "Start from" — the 5e (2014 SRD) stat blocks for mounts, plus vehicles. `bins` = built-in storage (no tack).
export const KINDS = {
  ridingHorse: { label: "Riding Horse", group: "Mounts", icon: "fa-horse", size: "lg", ac: 10, hp: 13, walk: 60, abil: [16, 10, 12, 2, 11, 7], attacks: [["Hooves", "+5", "2d4 + 3", "bludgeoning"]], tack: true },
  warhorse:    { label: "Warhorse",     group: "Mounts", icon: "fa-horse-head", size: "lg", ac: 11, hp: 19, walk: 60, abil: [18, 12, 13, 2, 12, 7], attacks: [["Hooves", "+6", "2d6 + 4", "bludgeoning"]], tack: true },
  draftHorse:  { label: "Draft Horse",  group: "Mounts", icon: "fa-horse", size: "lg", ac: 10, hp: 19, walk: 40, abil: [18, 10, 12, 2, 11, 7], attacks: [["Hooves", "+6", "2d4 + 4", "bludgeoning"]], tack: true },
  pony:        { label: "Pony",         group: "Mounts", icon: "fa-horse", size: "med", ac: 10, hp: 11, walk: 40, abil: [15, 10, 13, 2, 11, 7], attacks: [["Hooves", "+4", "2d4 + 2", "bludgeoning"]], tack: true },
  mule:        { label: "Mule",         group: "Mounts", icon: "fa-horse", size: "med", burden: true, ac: 10, hp: 11, walk: 40, abil: [14, 10, 13, 2, 10, 5], attacks: [["Hooves", "+4", "1d4 + 2", "bludgeoning"]], tack: true },
  camel:       { label: "Camel",        group: "Mounts", icon: "fa-horse", size: "lg", ac: 9, hp: 15, walk: 50, abil: [16, 8, 14, 2, 8, 5], attacks: [["Bite", "+5", "1d4", "bludgeoning"]], tack: true },
  elephant:    { label: "Elephant",     group: "Mounts", icon: "fa-horse-head", size: "huge", ac: 12, hp: 76, walk: 40, abil: [22, 9, 17, 3, 11, 6], attacks: [["Gore", "+8", "3d8 + 6", "piercing"], ["Stomp", "+8", "3d10 + 6", "bludgeoning"]], tack: true },
  mastiff:     { label: "Mastiff",      group: "Mounts", icon: "fa-dog", size: "med", ac: 12, hp: 5, walk: 40, abil: [13, 14, 12, 3, 12, 7], attacks: [["Bite", "+3", "1d6 + 1", "piercing"]], tack: true },
  cart:        { label: "Cart",         group: "Vehicles", icon: "fa-cart-flatbed", size: "lg", ac: 15, hp: 25, walk: 0, drawn: true, bins: [["bed", "Cart Bed", 100]] },
  wagon:       { label: "Wagon",        group: "Vehicles", icon: "fa-trailer", size: "lg", ac: 15, hp: 40, walk: 0, drawn: true, bins: [["bed", "Wagon Bed", 200]] },
  coveredWagon:{ label: "Covered Wagon", group: "Vehicles", icon: "fa-trailer", size: "lg", ac: 15, hp: 45, walk: 0, drawn: true, bins: [["bed", "Wagon Bed", 250]] },
  canoe:       { label: "Canoe",        group: "Vehicles", icon: "fa-sailboat", size: "lg", ac: 11, hp: 20, walk: 0, swim: 20, fixedCarry: 600, bins: [["hull", "Hull", 80]] },
  rowboat:     { label: "Rowboat",      group: "Vehicles", icon: "fa-sailboat", size: "lg", ac: 11, hp: 50, walk: 0, swim: 15, fixedCarry: 1000, bins: [["hull", "Hull", 120]] },
}
export const kindOf = (key) => KINDS[key] || KINDS.ridingHorse

// Tack spots on an animal — two columns that line up like the Anti-Hammer body ([label, side, row, hint]).
export const SLOTS = {
  head:  ["Head", "l", 1, "bridle"],              body:    ["Body", "r", 1, "barding"],
  back:  ["Back", "l", 2, "saddle, pack saddle"], flanks:  ["Flanks", "r", 2, "saddlebags, panniers"],
  lside: ["Left side", "l", 3, "side harness"],   rside:   ["Right side", "r", 3, "side harness"],
  rear:  ["Rear", "l", 4, "bedroll straps"],      harness: ["Harness", "r", 4, "draft harness"],
}
export const SLOT_KEYS = Object.keys(SLOTS)

// Tack, recognised by NAME (dnd5e's own "Saddlebags", "Saddle, Riding", "Bit and bridle"… and ours). A per-item
// flag `flags.pendant-bridge.tack = { fits, bags, note }` wins over the name. bags: [key, label, spaces, longOnly].
export const TACK_RULES = [
  { re: /\bbit and bridle\b|\bbridle\b/i, fits: ["head"], bags: [] },
  { re: /barding/i, fits: ["body"], bags: [] },
  { re: /saddle,?\s*pack|pack\s*saddle/i, fits: ["back"], bags: [["frame", "Pack Frame", 16]], note: "no rider" },
  { re: /saddlebags?/i, large: /large|big/i, fits: ["flanks"], bags: [["L", "Left Saddlebag", 8], ["R", "Right Saddlebag", 8]] },
  { re: /panniers?/i, fits: ["flanks"], bags: [["L", "Left Pannier", 12], ["R", "Right Pannier", 12]] },
  { re: /saddle/i, fits: ["back"], bags: [], rider: true },
  { re: /bedroll straps?|rear pack/i, fits: ["rear"], bags: [["rear", "Rear Cargo", 6]] },
  { re: /side harness/i, fits: ["lside", "rside"], bags: [["side", "Side Harness", 4, true]], note: "long things" },
  { re: /draft harness|harness,?\s*draft|\byoke\b/i, fits: ["harness"], bags: [], note: "can pull a cart" },
]

/** Tack info for an item-ish `{ name, flags }` → { fits, bags, rider, note } or null (not tack). */
export function tackOf(item) {
  const f = item?.flags?.[MOD]?.tack
  if (f && Array.isArray(f.fits) && f.fits.length) return { fits: f.fits.filter(s => SLOTS[s]), bags: Array.isArray(f.bags) ? f.bags : [], rider: !!f.rider, note: f.note || "" }
  const name = String(item?.name || "")
  for (const r of TACK_RULES) if (r.re.test(name)) {
    let bags = r.bags
    if (r.large && r.large.test(name)) bags = bags.map(([k, l, n, lo]) => [k, l, Math.round(n * 1.5), lo])
    return { fits: r.fits.slice(), bags, rider: !!r.rider, note: r.note || (r.rider ? "rider seat" : "") }
  }
  return null
}

export const abilityMod = (score) => Math.floor(((Number(score) || 10) - 10) / 2)

/** The size one step up (Beast of Burden / Powerful Build). */
export const sizeUp = (size) => SIZE_ORDER[Math.min(SIZE_ORDER.length - 1, Math.max(0, SIZE_ORDER.indexOf(size)) + 1)] || size

/**
 * Carry limit in pounds.
 * { kind, str, size, burden, override, pullerMaxes: [lb…] } → { max, rule }
 */
export function carryMax({ kind, str, size, burden, override, pullerMaxes }) {
  const k = kindOf(kind)
  if (override != null && override !== "" && Number.isFinite(Number(override)) && Number(override) > 0) return { max: Number(override), rule: "set by hand" }
  if (k.drawn) {
    const sum = (pullerMaxes || []).reduce((s, n) => s + (Number(n) || 0), 0)
    return { max: sum * DRAFT_MULT, rule: sum ? DRAFT_MULT + " × what pulls it" : "nothing pulling it" }
  }
  if (k.fixedCarry) return { max: k.fixedCarry, rule: "set by its kind" }
  const sz = (burden ?? k.burden) ? sizeUp(size || k.size) : (size || k.size)
  const s = Number(str) || 10
  return { max: s * 15 * (SIZE_MULT[sz] || 1), rule: "Str " + s + " × 15 × " + (SIZE_MULT[sz] || 1) + ((burden ?? k.burden) ? " (Beast of Burden)" : "") }
}

/** Pounds an item list weighs (items: { weight, qty }). */
export const totalWeight = (items) => Math.round(items.reduce((s, i) => s + (Number(i.weight) || 0) * (Number(i.qty) || 0), 0) * 100) / 100

/**
 * The bags a mount has right now.
 * items: [{ id, name, flags, slot }] (slot = the tack spot it is ON, or null) · kind key
 * → [{ id, label, cap, longOnly, where }]
 */
export function bagsOf(kind, items) {
  const k = kindOf(kind)
  if (k.bins) return k.bins.map(([key, label, cap]) => ({ id: key, label, cap, longOnly: false, where: "built in" }))
  const out = []
  for (const it of items) {
    if (!it.slot) continue
    const t = tackOf(it); if (!t || !t.fits.includes(it.slot)) continue
    for (const [key, label, cap, longOnly] of t.bags) {
      const side = key === "side" ? (it.slot === "lside" ? "Left " : "Right ") : ""
      out.push({ id: it.id + ":" + key, label: side + label, cap: Number(cap) || 0, longOnly: !!longOnly, where: "on " + SLOTS[it.slot][0] })
    }
  }
  return out
}

/**
 * Put things into bags: pinned first (when it fits), then biggest first into the first bag that takes it.
 * bags from bagsOf · units: [{ id, spaces, long }] · pins: { itemId: bagId }
 * → { bags: [{ ...bag, used, items: [unit] }], where: { itemId: bagId }, notPacked: [unit] }
 */
export function packBags(bags, units, pins) {
  const bs = bags.map(b => ({ ...b, used: 0, items: [] })), where = {}, notPacked = []
  const put = (u, b) => { const s = Math.max(0, Number(u.spaces) || 0); if (b.longOnly && !u.long) return false; if (b.used + s > b.cap) return false; b.used += s; b.items.push(u); where[u.id] = b.id; return true }
  const order = units.slice().sort((a, b) => (Number(b.spaces) || 0) - (Number(a.spaces) || 0) || String(a.id).localeCompare(String(b.id)))
  for (const u of order) {
    const pin = pins && pins[u.id], pb = pin && bs.find(b => b.id === pin)
    if (pb && put(u, pb)) continue
    // long things try the long-only bags first, everything else skips them
    const cands = bs.filter(b => !b.longOnly || u.long).sort((x, y) => (u.long ? Number(y.longOnly) - Number(x.longOnly) : 0))
    if (!cands.some(b => put(u, b))) notPacked.push(u)
  }
  return { bags: bs, where, notPacked }
}

/** Fallback spaces when Anti-Hammer's own rule isn't available: 1 space per 5 lb, at least 1. */
export const spacesByWeight = (weight, qty) => Math.max(1, Math.ceil(((Number(weight) || 0) * (Number(qty) || 1)) / 5))

/**
 * Lay a bag out as hexes (4 rows, column-major, biggest first — the Anti-Hammer bag look).
 * → { cols, rows, cells: [[itemId, [[c, r]…]]…] }
 */
const SHAPES = { 1: [[0, 0]], 2: [[0, 0], [1, 0]], 3: [[0, 0], [1, 0], [2, 0]], 4: [[0, 0], [1, 0], [0, 1], [1, 1]], 6: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]] }
export function hexLayout(cap, units) {
  const rows = 4, cols = Math.max(1, Math.ceil(cap / rows)), valid = new Set(), occ = new Set(), cells = []
  for (let i = 0; i < cap; i++) valid.add(Math.floor(i / rows) + "," + (i % rows))
  for (const u of units.slice().sort((a, b) => (Number(b.spaces) || 0) - (Number(a.spaces) || 0) || String(a.id).localeCompare(String(b.id)))) {
    const n = Math.max(1, Math.ceil(Number(u.spaces) || 1)), sh = SHAPES[n] || Array.from({ length: n }, (_, i) => [Math.floor(i / rows), i % rows])
    let got = null
    for (let c = 0; c < cols && !got; c++) for (let r = 0; r < rows && !got; r++) {
      const cs = sh.map(([dc, dr]) => [c + dc, r + dr])
      if (cs.every(([x, y]) => valid.has(x + "," + y) && !occ.has(x + "," + y))) got = cs
    }
    if (!got) got = [...valid].filter(k => !occ.has(k)).slice(0, n).map(k => k.split(",").map(Number))
    got.forEach(([x, y]) => occ.add(x + "," + y)); cells.push([u.id, got])
  }
  return { cols, rows, cells }
}

/**
 * How a move of `n` from a stack lands.
 * src: { id, name, type, qty, tack } · target: [{ id, name, type, qty, tack }] · n
 * → { n, sourceLeft (0 = the source item goes), mergeInto: targetItemId | null }
 * Tack never merges (each saddle is its own thing); otherwise same name + same type stacks.
 */
export function planMove(src, target, n) {
  const have = Math.max(0, Math.floor(Number(src.qty) || 0)) || 1
  const take = Math.max(1, Math.min(have, Math.floor(Number(n) || have)))
  const norm = (s) => String(s || "").trim().toLowerCase()
  const same = src.tack ? null : (target || []).find(t => !t.tack && t.type === src.type && norm(t.name) === norm(src.name))
  return { n: take, sourceLeft: have - take, mergeInto: same ? same.id : null }
}

/** Put on: the slot must be one the tack fits; whatever else is on that slot comes off. → { ok, off: [itemId], why } */
export function planEquip(item, slot, items) {
  const t = tackOf(item)
  if (!t) return { ok: false, off: [], why: (item?.name || "That") + " isn't tack" }
  if (!t.fits.includes(slot)) return { ok: false, off: [], why: item.name + " goes on " + t.fits.map(s => SLOTS[s][0]).join(" or ") }
  return { ok: true, off: (items || []).filter(o => o.id !== item.id && o.slot === slot).map(o => o.id), why: "" }
}

/** Tack up: every carried piece of tack onto its first free slot. items: [{ id, name, flags, slot }] → { itemId: slot } */
export function planTackUp(items) {
  const taken = new Set(items.filter(i => i.slot).map(i => i.slot)), out = {}
  for (const i of items) {
    if (i.slot) continue
    const t = tackOf(i); if (!t) continue
    const s = t.fits.find(f => !taken.has(f)); if (s) { taken.add(s); out[i.id] = s }
  }
  return out
}

/**
 * Who may move things between two actors through the GM (the requester doesn't own both).
 * a, b: { isMount, ownerId (mount's owner character id), id, userLevel (requester's ownership level 0–3) }
 * Rule: one side must be the requester's (OWNER), the other a MOUNT they can at least see (OBSERVER) —
 * or a character that owns that mount (taking things back from a horse you can see).
 */
export function mayRelay(from, to) {
  const OWNER = 3, OBSERVER = 2
  const ok = (mine, other) => mine.userLevel >= OWNER && other.isMount && other.userLevel >= OBSERVER
  return ok(from, to) || ok(to, from)
}

/** Ownership for a mount whose owner character is owned by `userIds` (non-GM). Keeps others; removes our past grants. */
export function ownershipFor(current, granted, userIds) {
  const next = { ...(current || {}) }, OWNER = 3
  for (const id of granted || []) if (!userIds.includes(id) && next[id] === OWNER) delete next[id]
  for (const id of userIds) next[id] = OWNER
  return next
}

/** Fresh system data for "Start from <kind>". */
export function kindSystem(key) {
  const k = kindOf(key)
  const abil = {}
  ABILITIES.forEach((a, i) => { abil[a] = { value: k.abil ? k.abil[i] : 10 } })
  return {
    kind: KINDS[key] ? key : "ridingHorse", size: k.size,
    abilities: abil,
    attributes: { ac: { value: k.ac }, hp: { value: k.hp, max: k.hp, temp: 0, tempmax: 0 }, movement: { walk: k.walk || 0, swim: k.swim || 0, fly: 0, units: "ft" }, carry: null },
    attacks: (k.attacks || []).map(([name, toHit, damage, type]) => ({ name, toHit, damage, type })),
  }
}
