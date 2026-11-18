// ──────────────────────────────────────────────────────────────
// Item capture — an item that lands in a player character's inventory while a
// RealmScreen game is running goes to RealmScreen's session log as an "item
// handed out" line (what → who), for Session Over's Awarded › Misc.
//
// Only the GM window holding the RealmScreen link sends (one copy). Counted:
//   · a game is running (the live table log RealmScreen sends, table-log.js);
//   · the actor is owned by a player seated in that game (any player, when the
//     log names nobody);
//   · physical items only; a dropped pack is ONE thing (its contents ride along);
//   · a stack that grew counts when a GM made it grow (dnd5e stacks a dropped
//     potion onto the one you have).
// Not counted: D&D Beyond / bulk imports (and the 30 s after one, which covers
// the rations guard putting rations back), more than 5 new things at once
// (sheet setup), our own writes.
// Sent as `item.handout` (item-watch-model.js `handoutMessage`).
// ──────────────────────────────────────────────────────────────

import { onWindow } from "./item-watch.js"
import { isImport, itemsIn, handoutMessage } from "./item-watch-model.js"
import { linkedHere } from "./live.js"
import { fullTableLog } from "./private.js"

const MAX_AT_ONCE = 5
const AFTER_IMPORT_MS = 30000
let sender = null
/** main.js: (msg) => bridge.send(msg) */
export function setItemCaptureSender(fn) { sender = typeof fn === "function" ? fn : null }

const imported = new Map()       // actorId → ms an import window closed
const arr = (v) => (Array.isArray(v) ? v : [])

function seatedOwners(actor, log) {
  const owners = (game.users ?? []).filter(u => !u.isGM && actor.testUserPermission?.(u, "OWNER"))
  const seated = arr(log?.users)
  return seated.length ? owners.filter(u => seated.includes(u.id)) : owners
}

onWindow((win) => {
  if (isImport(win, { bulk: 15 })) { imported.set(win.actorId, Date.now()); return }
  if (!sender || !game.user?.isGM || !linkedHere()) return
  const log = fullTableLog()
  if (!log?.live?.campaignId) return
  if (Date.now() - (imported.get(win.actorId) || 0) < AFTER_IMPORT_MS) return
  const actor = game.actors?.get(win.actorId)
  if (!actor || actor.type === "group" || actor.type === "vehicle") return
  const owners = seatedOwners(actor, log).map(u => u.id)
  if (!owners.length) return
  const things = itemsIn(win, { gainOk: (c) => !!game.users?.get(c.user)?.isGM })
  if (!things.length || things.length > MAX_AT_ONCE) return
  for (const t of things) {
    const u = t.user ? game.users?.get(t.user) : null
    const msg = handoutMessage({
      item: t, actor, owners,
      by: u ? { userId: u.id, name: u.name, isGM: u.isGM } : null,
      campaignId: log.live.campaignId, session: log.live.number,
    })
    if (msg) sender(msg)
  }
})
