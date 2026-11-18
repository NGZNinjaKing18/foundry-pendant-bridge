// ──────────────────────────────────────────────────────────────
// Item watch — every client gathers each actor's item changes into a window
// that closes after 4 s of quiet (item-watch-model.js). Readers:
//   · item-capture.js — the linked GM window files "item handed out" lines;
//   · ration-guard.js — the client that ran a D&D Beyond import puts the
//     rations back.
// A change made with the operation option `pendantBridge` (our own restores)
// is marked `skip`.
// ──────────────────────────────────────────────────────────────

import { makeWatch, isDdbItem } from "./item-watch-model.js"

const listeners = new Set()
/** fn(win) for every closed window. */
export function onWindow(fn) { listeners.add(fn) }

/** Last known quantity of every item on a watched actor (so a stack that grew can be told). */
const qtyCache = new Map()
const qtyOf = (it) => Math.max(0, Math.floor(Number(it?.system?.quantity ?? 1) || 0))

const watch = makeWatch({
  quietMs: 4000,
  onClose: (win) => { for (const fn of listeners) { try { fn(win) } catch (e) { console.warn("[pendant-bridge] item watch reader", e) } } },
})

const actorOf = (item) => (item?.parent?.documentName === "Actor" ? item.parent : null)
function facts(item) {
  return {
    name: item.name, type: item.type, img: item.img, uuid: item.uuid,
    container: item.system?.container ?? null, qty: qtyOf(item),
    source: item._stats?.compendiumSource ?? item.flags?.core?.sourceId ?? "",
  }
}
const ours = (options) => !!options?.pendantBridge

Hooks.on("createItem", (item, options, userId) => {
  const a = actorOf(item)
  if (!a) return
  qtyCache.set(item.uuid, qtyOf(item))
  watch.record(a.id, { kind: "create", id: item.id, user: userId, ddb: isDdbItem(item), item: facts(item), skip: ours(options) })
})
Hooks.on("updateItem", (item, changes, options, userId) => {
  const a = actorOf(item)
  if (!a) return
  const before = qtyCache.has(item.uuid) ? qtyCache.get(item.uuid) : null
  const after = qtyOf(item)
  qtyCache.set(item.uuid, after)
  const gain = before != null && foundry.utils.hasProperty(changes ?? {}, "system.quantity") ? after - before : 0
  watch.record(a.id, { kind: "update", id: item.id, user: userId, ddb: isDdbItem(item), item: facts(item), gain, skip: ours(options) })
})
Hooks.on("deleteItem", (item, options, userId) => {
  const a = actorOf(item)
  if (!a) return
  qtyCache.delete(item.uuid)
  watch.record(a.id, { kind: "delete", id: item.id, user: userId, ddb: isDdbItem(item), item: facts(item), skip: ours(options) })
})
Hooks.on("updateActor", (actor, changes, _options, userId) => {
  const ddb = !!(changes?.flags && (changes.flags.ddbimporter || changes.flags["ddb-importer"]))
  const replaced = Array.isArray(changes?.items)
  if (ddb || replaced) watch.record(actor.id, { kind: "actor", user: userId, ddb, replaced })
})

function prime() {
  for (const a of game.actors ?? []) for (const it of a.items ?? []) qtyCache.set(it.uuid, qtyOf(it))
}
Hooks.once("ready", prime)
Hooks.on("createActor", (a) => { for (const it of a.items ?? []) qtyCache.set(it.uuid, qtyOf(it)) })

/** For a harness / the console. */
export const _watch = watch
