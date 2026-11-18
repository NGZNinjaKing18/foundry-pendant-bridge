// ──────────────────────────────────────────────────────────────
// Best Moment — the winner of RealmScreen's Discord vote, at the next game.
//
//   · `bestmoment.grant` (from RealmScreen, when that campaign's game starts):
//     each winner's actor gets `flags.pendant-bridge.bestMoment`. Older grants of
//     the same campaign come off.
//   · Every client: a token whose actor holds the flag glows gold (a soft ring
//     around it, pulsing slowly) — players see it too.
//   · The roller's client: the first d20 test of that actor (check, save, skill,
//     tool, attack, death save, concentration, initiative) gets advantage.
//   · When that roll's chat card lands, the active GM takes the flag off (the
//     glow goes) and the window holding the RealmScreen link sends
//     `bestmoment.used` back.
//   · `bestmoment.clear` — the game ended with it unspent.
// The flag is the pending state, so a reload loses nothing.
// Pure parts: best-moment-model.js.
// ──────────────────────────────────────────────────────────────

import {
  FLAG, GOLD, PRE_ROLL_HOOKS, grantFlag, isPending, actorOfHookArgs, applyAdvantage, isD20Message,
  rollLabel, usedMessage, planGrant, planClear, pulseAlpha,
} from "./best-moment-model.js"
import { linkedHere } from "./live.js"

const MOD = "pendant-bridge"
let sender = null
/** main.js: (msg) => bridge.send(msg) */
export function setBestMomentSender(fn) { sender = typeof fn === "function" ? fn : null }

const flagOf = (actor) => { try { return actor?.getFlag?.(MOD, FLAG) ?? actor?.flags?.[MOD]?.[FLAG] ?? null } catch { return null } }
const worldActors = () => { try { return [...(game.actors ?? [])].map(a => ({ id: a.id, flag: flagOf(a) })) } catch { return [] } }
const amWriter = () => !!game.user?.isGM && (game.users?.activeGM ? game.users.activeGM.isSelf : true)

// ── commands (handleCommand runs them on the linked GM window) ──────────────
export async function bestMomentGrant(msg) {
  if (!game.user?.isGM) return { ok: false, error: "not a GM window" }
  const plan = planGrant(worldActors(), msg)
  const flag = grantFlag(msg)
  for (const id of plan.unset) { try { await game.actors.get(id)?.unsetFlag(MOD, FLAG) } catch (e) { console.warn("[pendant-bridge] best moment: unset failed", e) } }
  const done = []
  for (const id of plan.set) {
    try { await game.actors.get(id)?.setFlag(MOD, FLAG, flag); done.push(id) } catch (e) { console.warn("[pendant-bridge] best moment: grant failed", e) }
  }
  if (done.length) {
    const names = done.map(id => game.actors.get(id)?.name).filter(Boolean)
    ui.notifications?.info(`Best moment: ${names.join(", ")} — advantage on the first d20 roll this session.`)
  }
  return { ok: true, actors: done, missing: plan.missing }
}

export async function bestMomentClear(msg) {
  if (!game.user?.isGM) return { ok: false, error: "not a GM window" }
  const ids = planClear(worldActors(), msg)
  for (const id of ids) { try { await game.actors.get(id)?.unsetFlag(MOD, FLAG) } catch { /* gone */ } }
  return { ok: true, cleared: ids.length }
}

// ── advantage on the first d20 ───────────────────────────────────────────────
const ADV = () => CONFIG?.Dice?.D20Roll?.ADV_MODE?.ADVANTAGE ?? 1
for (const name of PRE_ROLL_HOOKS) {
  Hooks.on(name, (...args) => {
    try {
      const actor = actorOfHookArgs(args)
      if (!actor || !isPending(flagOf(actor))) return
      if (applyAdvantage(args, { ADVANTAGE: ADV() })) console.log(`[pendant-bridge] best moment: advantage for ${actor.name} (${name})`)
    } catch (e) { console.warn("[pendant-bridge] best moment: pre-roll failed", e) }
  })
}

// ── the roll that spends it ─────────────────────────────────────────────────
const spent = new Set()        // grantId|actorId already reported from this window
const isD20 = (r) => {
  const D20 = CONFIG?.Dice?.D20Roll
  return (D20 && r instanceof D20) || r?.constructor?.name === "D20Roll"
}
Hooks.on("createChatMessage", (message) => {
  try {
    const actorId = message?.speaker?.actor
    const actor = actorId ? game.actors?.get(actorId) : null
    const flag = flagOf(actor)
    if (!actor || !isPending(flag) || !isD20Message(message, isD20)) return
    const key = `${flag.grantId}|${actor.id}`
    if (spent.has(key)) return
    spent.add(key)
    if (amWriter()) actor.unsetFlag(MOD, FLAG).catch?.(() => {})
    if (sender && linkedHere()) sender(usedMessage({ flag, actorId: actor.id, roll: rollLabel(message) }))
  } catch (e) { console.warn("[pendant-bridge] best moment: spend failed", e) }
})

// ── the gold glow ────────────────────────────────────────────────────────────
const glows = new Set()        // live PIXI.Graphics
let ticking = false
function tick() {
  const a = pulseAlpha(performance.now())
  for (const g of glows) { if (g.destroyed) glows.delete(g); else g.alpha = a }
  if (!glows.size && ticking) { canvas?.app?.ticker?.remove(tick); ticking = false }
}
function drawGlow(token) {
  if (!token || token.destroyed) return
  const on = isPending(flagOf(token.actor))
  let g = token._pbBestMoment
  if (g && g.destroyed) g = token._pbBestMoment = null
  if (!on) {
    if (g) { glows.delete(g); g.parent?.removeChild(g); g.destroy(); token._pbBestMoment = null }
    return
  }
  if (!g) {
    g = token._pbBestMoment = new PIXI.Graphics()
    g.eventMode = "none"
    token.addChildAt(g, 0)
    glows.add(g)
    if (!ticking && canvas?.app?.ticker) { canvas.app.ticker.add(tick); ticking = true }
  }
  const w = token.w ?? token.width ?? 100, h = token.h ?? token.height ?? 100
  g.clear()
  for (let i = 0; i < 6; i++) {
    g.lineStyle({ width: 3, color: GOLD, alpha: 0.55 * (1 - i / 6) })
    g.drawEllipse(w / 2, h / 2, w / 2 + 1 + i * 3, h / 2 + 1 + i * 3)
  }
}
const redrawActor = (actor) => { try { for (const t of actor?.getActiveTokens?.() ?? []) drawGlow(t) } catch { /* no canvas */ } }

Hooks.on("refreshToken", (t) => drawGlow(t))
Hooks.on("updateActor", (actor, changes) => {
  const f = changes?.flags?.[MOD]
  if (f && (FLAG in f || `-=${FLAG}` in f)) redrawActor(actor)
})
Hooks.on("canvasReady", () => { for (const t of canvas?.tokens?.placeables ?? []) drawGlow(t) })
