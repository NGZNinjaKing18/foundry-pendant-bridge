// ──────────────────────────────────────────────────────────────
// D&D Beyond import guard — a re-import never adds, removes or changes a
// character's rations.
//
// How: every client keeps a snapshot of the ration stacks (rations.js
// `isRation`, full item data) of each actor it owns, refreshed whenever that
// actor's item changes settle WITHOUT an import. When a window of changes
// closes and it was a D&D Beyond import (item-watch-model.js `isImport`: ≥ 5
// D&D Beyond items touched at once, or the actor's ddbimporter flags changed
// with them), the client of the user who ran it puts the rations back from the
// snapshot (ration-guard-model.js `planRestore`) and whispers the GMs.
//
// ddb-importer exposes no stable public hook for "import finished", so this
// reads the import itself through Foundry's own document hooks. Off entirely
// when ddb-importer isn't active. A character's FIRST import (no snapshot yet,
// or the actor made in the last minute) is left as D&D Beyond gives it.
// ──────────────────────────────────────────────────────────────

import { isRation } from "./rations.js"
import { onWindow } from "./item-watch.js"
import { isImport, mainUser } from "./item-watch-model.js"
import { snapshotRations, planRestore, sameRations } from "./ration-guard-model.js"

const MOD = "pendant-bridge"
const snaps = new Map()          // actorId → [{ id, name, qty, data }]
const born = new Map()           // actorId → ms it was created here
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

const ddbOn = () => { try { return !!game.modules?.get("ddb-importer")?.active } catch { return false } }
const watched = (a) => !!a && a.type !== "group" && a.type !== "vehicle" && !a.pack && a.isOwner

function snap(a) { if (watched(a)) snaps.set(a.id, snapshotRations(a.items, isRation)) }

async function restore(actor, before) {
  const plan = planRestore(before, actor.items, isRation)
  if (!plan.changed) return null
  const opts = { pendantBridge: "ration-guard", render: true }
  try {
    if (plan.deletes.length) await actor.deleteEmbeddedDocuments("Item", plan.deletes, opts)
    if (plan.updates.length) await actor.updateEmbeddedDocuments("Item", plan.updates, opts)
    if (plan.creates.length) await actor.createEmbeddedDocuments("Item", plan.creates, { ...opts, keepId: true })
  } catch (e) {
    console.warn("[pendant-bridge] rations guard: couldn't put rations back on", actor.name, e)
    ui.notifications?.warn(`D&D Beyond import: couldn’t put ${actor.name}’s rations back. Check them by hand.`)
    return null
  }
  const n = before.reduce((k, s) => k + s.qty, 0)
  try {
    await ChatMessage.create({
      speaker: { alias: "Rations" },
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
      content: `<p><strong>${esc(actor.name)}</strong> was re-imported from D&amp;D Beyond. Rations kept as they were: ${n}.</p>`,
    })
  } catch { /* chat is a courtesy */ }
  return plan
}

onWindow((win) => {
  if (!ddbOn()) return
  const actor = game.actors?.get(win.actorId)
  if (!watched(actor)) return
  const before = snaps.get(actor.id)
  if (!isImport(win)) {
    // An ordinary change (or our own restore) → the new normal.
    const now = snapshotRations(actor.items, isRation)
    if (!before || !sameRations(before, now)) snaps.set(actor.id, now)
    return
  }
  // An import. Only the client that ran it acts (it surely may edit the actor).
  const fresh = born.has(actor.id) && Date.now() - born.get(actor.id) < 60000
  if (!before || fresh) { snap(actor); return }
  if (mainUser(win) !== game.user?.id) return
  restore(actor, before).finally(() => snap(actor))
})

Hooks.once("ready", () => {
  if (!ddbOn()) return
  for (const a of game.actors ?? []) snap(a)
})
Hooks.on("createActor", (a) => { born.set(a.id, Date.now()); if (ddbOn()) snap(a) })
Hooks.on("deleteActor", (a) => { snaps.delete(a.id); born.delete(a.id) })
// An actor this user just got (ownership changed) → start watching it.
Hooks.on("updateActor", (a, changes) => { if (changes?.ownership && ddbOn() && !snaps.has(a.id)) snap(a) })

/** For a harness / the console. */
export const _guard = { snaps, restore }
