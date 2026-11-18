// ──────────────────────────────────────────────────────────────
// Item watch — pure parts (tests/item-watch.test.mjs).
//
// Item changes on an actor are gathered into a WINDOW that closes after a
// quiet spell (no change on that actor for `quietMs`). The closed window is a
// summary the item capture (item-capture.js) and the D&D Beyond rations guard
// (ration-guard.js) read:
//   · was it an IMPORT (D&D Beyond re-import, bulk setup)? → the guard puts
//     the rations back; the capture records nothing;
//   · otherwise each new top-level item (and each stack that grew) is a thing
//     that came into the inventory.
// Timers are injected so the tests can drive time.
// ──────────────────────────────────────────────────────────────

export const PHYSICAL = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack", "equipmentpack"])
const str = (v) => (typeof v === "string" ? v.trim() : "")

/** Is this item from D&D Beyond (ddb-importer stamps `flags.ddbimporter`)? */
export const isDdbItem = (item) => !!(item && item.flags && (item.flags.ddbimporter || item.flags["ddb-importer"]))

/**
 * Is this closed window an import?
 *   · ddb-importer touched ≥ 5 distinct D&D Beyond items, or the actor's own
 *     ddbimporter flags changed alongside at least one D&D Beyond item; or
 *   · (only when `bulk` is given) ≥ `bulk` distinct items were created / deleted at once.
 */
export function isImport(win, { ddbMin = 5, bulk = 0 } = {}) {
  if (!win) return false
  const ddb = new Set()
  for (const c of [...win.creates, ...win.deletes, ...win.updates]) if (c.ddb && !c.skip) ddb.add(c.id)
  if (ddb.size >= ddbMin) return true
  if (win.actorDdb && ddb.size >= 1) return true
  if (win.itemsReplaced) return true
  if (bulk > 0) {
    const ids = new Set([...win.creates, ...win.deletes].filter(c => !c.skip).map(c => c.id))
    if (ids.size >= bulk) return true
  }
  return false
}

/** The user who made most of the window's changes (who should act on it). */
export function mainUser(win) {
  const n = new Map()
  for (const c of [...win.creates, ...win.deletes, ...win.updates]) if (c.user) n.set(c.user, (n.get(c.user) || 0) + 1)
  let best = null, max = 0
  for (const [u, k] of n) if (k > max) { best = u; max = k }
  return best
}

/**
 * One tracker for every actor. record(actorId, change) opens / extends that
 * actor's window; `onClose(win)` runs once it has been quiet for `quietMs`.
 * change = { kind: "create"|"delete"|"update"|"actor", id, user, ddb, item?, gain?, replaced? }
 */
export function makeWatch({ quietMs = 4000, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, onClose = () => {} } = {}) {
  const open = new Map()
  function close(actorId) {
    const w = open.get(actorId)
    if (!w) return
    open.delete(actorId)
    w.closedAt = now()
    try { onClose(w) } catch (e) { console.warn("[pendant-bridge] item watch", e) }
  }
  function record(actorId, change) {
    if (!actorId || !change) return
    let w = open.get(actorId)
    if (!w) { w = { actorId, openedAt: now(), creates: [], deletes: [], updates: [], actorDdb: false, itemsReplaced: false, timer: 0 }; open.set(actorId, w) }
    if (change.kind === "create") w.creates.push(change)
    else if (change.kind === "delete") w.deletes.push(change)
    else if (change.kind === "update") w.updates.push(change)
    else if (change.kind === "actor") { if (change.ddb) w.actorDdb = true; if (change.replaced) w.itemsReplaced = true }
    clearTimer(w.timer)
    w.timer = setTimer(() => close(actorId), quietMs)
  }
  return { record, open, flush: (id) => close(id), flushAll: () => [...open.keys()].forEach(close) }
}

/**
 * What came INTO the inventory in a (non-import) window → [{ id, name, img, type, uuid, qty, inside? , user }]
 *   · a new physical item that isn't inside a container made in the same window
 *     (a dropped Explorer's Pack is ONE thing: the pack, with what's inside);
 *   · a stack that grew (gain > 0) — only when `gains` allows that change.
 * Items deleted again in the same window, and items stamped `skip`, don't count.
 */
export function itemsIn(win, { gainOk = () => true } = {}) {
  if (!win) return []
  const deleted = new Set(win.deletes.map(c => c.id))
  const made = win.creates.filter(c => c.item && !c.skip && !deleted.has(c.id) && PHYSICAL.has(c.item.type))
  const madeIds = new Set(made.map(c => c.id))
  const out = []
  for (const c of made) {
    const parent = str(c.item.container)
    if (parent && madeIds.has(parent)) continue
    const inside = made.filter(x => str(x.item.container) === c.id).map(x => x.item.name)
    out.push({ id: c.id, name: str(c.item.name) || "Item", img: str(c.item.img), type: c.item.type, uuid: str(c.item.uuid), source: str(c.item.source), qty: Math.max(1, Math.floor(Number(c.item.qty) || 1)), user: c.user || null, ...(inside.length ? { inside } : {}) })
  }
  // Stacks that grew (dnd5e stacks a dropped potion onto the one you have).
  const gained = new Map()
  for (const c of win.updates) {
    if (!c.item || !(c.gain > 0) || c.skip || madeIds.has(c.id) || deleted.has(c.id) || !PHYSICAL.has(c.item.type) || !gainOk(c)) continue
    const g = gained.get(c.id)
    if (g) g.qty += Math.floor(c.gain)
    else gained.set(c.id, { id: c.id, name: str(c.item.name) || "Item", img: str(c.item.img), type: c.item.type, uuid: str(c.item.uuid), source: str(c.item.source), qty: Math.floor(c.gain), user: c.user || null, stacked: true })
  }
  for (const g of gained.values()) if (g.qty > 0) out.push(g)
  return out
}

/** The `item.handout` message for RealmScreen (one per item). */
export function handoutMessage({ item, actor, by, owners = [], campaignId = "", session = null, at = Date.now() }) {
  if (!item || !actor) return null
  const inside = Array.isArray(item.inside) ? item.inside.map(str).filter(Boolean).slice(0, 40) : []
  return {
    type: "item.handout",
    id: `h${at.toString(36)}${String(item.id || "").slice(-6)}`,
    at,
    campaignId: str(campaignId),
    session: Number.isFinite(session) ? session : null,
    item: {
      name: str(item.name) || "Item", uuid: str(item.uuid), img: str(item.img), type: str(item.type),
      qty: Math.max(1, Math.floor(Number(item.qty) || 1)), source: str(item.source),
      ...(item.stacked ? { stacked: true } : {}),
      ...(inside.length ? { inside } : {}),
    },
    actor: { id: str(actor.id), uuid: str(actor.uuid), name: str(actor.name) || "Someone", img: str(actor.img) },
    owners: (Array.isArray(owners) ? owners : []).map(str).filter(Boolean),
    by: by ? { userId: str(by.userId), name: str(by.name), isGM: !!by.isGM } : null,
  }
}
