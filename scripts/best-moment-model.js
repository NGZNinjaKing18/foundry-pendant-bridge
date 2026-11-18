// ──────────────────────────────────────────────────────────────
// Best Moment — pure parts (tests/best-moment.test.mjs).
//
// RealmScreen runs a "Best Moment" vote on Discord after each game. When that
// campaign's next game starts it sends `bestmoment.grant`: the winner's actor
// gets a flag (`flags.pendant-bridge.bestMoment`), its tokens glow gold, and
// the first d20 roll that actor makes has advantage. That roll spends it: the
// flag goes and RealmScreen hears `bestmoment.used`. A flag survives reloads —
// it IS the "pending" state. Unspent at the game's end → `bestmoment.clear`.
//
// dnd5e 4.x/5.x: every d20 test fires `dnd5e.preRoll<Name>V2(config, dialog,
// message)` for each of its hook names (…, "d20Test"), with `config.subject`
// = the actor (checks, saves, skills, tools) or an activity/item (attacks).
// dnd5e 3.x: `dnd5e.preRollSkill(actor, config, id)`, `preRollAttack(item, config)` …
// Initiative (both): `dnd5e.preRollInitiative(actor, roll)` with a D20Roll.
// ──────────────────────────────────────────────────────────────

export const FLAG = "bestMoment"
export const GOLD = 0xf2c14e

/** Every pre-roll hook a d20 test can fire, new and old dnd5e. Applying twice is harmless. */
export const PRE_ROLL_HOOKS = [
  // dnd5e 4.x / 5.x
  "dnd5e.preRollD20TestV2", "dnd5e.preRollAttackV2", "dnd5e.preRollAbilityCheckV2", "dnd5e.preRollSavingThrowV2",
  "dnd5e.preRollSkillV2", "dnd5e.preRollToolV2", "dnd5e.preRollConcentrationV2", "dnd5e.preRollDeathSaveV2",
  // dnd5e 3.x
  "dnd5e.preRollAttack", "dnd5e.preRollAbilityTest", "dnd5e.preRollAbilitySave", "dnd5e.preRollSkill",
  "dnd5e.preRollToolCheck", "dnd5e.preRollDeathSave",
  // both
  "dnd5e.preRollInitiative",
]

const isDoc = (x, name) => !!x && typeof x === "object" && x.documentName === name
const isRollLike = (x) => !!x && typeof x === "object" && x.options && typeof x.options === "object" && Array.isArray(x.terms)

/** The flag RealmScreen's grant puts on an actor. */
export function grantFlag({ grantId, campaignId, sessionId, label }, at = Date.now()) {
  return { grantId: String(grantId || ""), campaignId: String(campaignId || ""), sessionId: String(sessionId || ""), label: String(label || "Best moment").slice(0, 120), at }
}

/** Is a buff waiting on this flag value? */
export const isPending = (flag) => !!(flag && typeof flag === "object" && flag.grantId)

/** The actor a pre-roll hook is about. args = the hook's arguments. */
export function actorOfHookArgs(args) {
  const a = Array.isArray(args) ? args : []
  const first = a[0]
  if (isDoc(first, "Actor")) return first                                  // 3.x actor hooks, preRollInitiative
  if (isDoc(first, "Item")) return first.actor || first.parent || null      // 3.x preRollAttack / ToolCheck
  const subject = first?.subject                                            // 4.x+ config
  if (isDoc(subject, "Actor")) return subject
  if (subject?.actor && isDoc(subject.actor, "Actor")) return subject.actor   // an activity or an item
  if (subject?.item?.actor) return subject.item.actor
  return null
}

/**
 * Set advantage on whatever the hook handed over. → true when something was set.
 *   4.x+: (config, dialog, message) — config.advantage + every config.rolls[i].options.advantage
 *   3.x:  (doc, config, …)          — config.advantage
 *   initiative: (actor, roll)        — roll.options advantage + re-apply its d20 modifiers
 */
export function applyAdvantage(args, { ADVANTAGE = 1 } = {}) {
  const a = Array.isArray(args) ? args : []
  let did = false
  const cfg = (x) => !!x && typeof x === "object" && !isDoc(x, "Actor") && !isDoc(x, "Item") && !isRollLike(x)
  const first = a[0]
  if (cfg(first) && ("subject" in first || Array.isArray(first.rolls))) {
    first.advantage = true
    for (const r of Array.isArray(first.rolls) ? first.rolls : []) {
      if (!r || typeof r !== "object") continue
      r.options = { ...(r.options || {}), advantage: true }
    }
    return true
  }
  const second = a[1]
  if (isRollLike(second)) {
    if (second._evaluated) return false
    second.options.advantage = true
    second.options.advantageMode = ADVANTAGE
    try { second.configureModifiers?.() } catch { /* the option still stands */ }
    return true
  }
  if (cfg(second)) { second.advantage = true; did = true }
  return did
}

/** Does this chat message carry a system d20 roll? `isD20(roll)` decides per roll (CONFIG.Dice.D20Roll). */
export function isD20Message(message, isD20) {
  const rolls = Array.isArray(message?.rolls) ? message.rolls : []
  return rolls.some(r => { try { return !!isD20(r) } catch { return false } })
}

/** "Stealth check" — what the spending roll was, short and plain. */
export function rollLabel(message) {
  const flavor = String(message?.flavor || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  if (flavor) return flavor.slice(0, 80)
  const t = message?.flags?.dnd5e?.roll?.type
  return t ? String(t).slice(0, 80) : "a d20 roll"
}

/** The frame RealmScreen hears when the buff is spent. */
export function usedMessage({ flag, actorId, roll, at = Date.now() }) {
  return { type: "bestmoment.used", grantId: flag?.grantId || "", campaignId: flag?.campaignId || "", sessionId: flag?.sessionId || "", actorId: String(actorId || ""), roll: String(roll || "").slice(0, 80), at }
}

/**
 * The grant: which actors get the flag, which flags of the same campaign go
 * (an older grant), and which actor ids weren't found.
 * actors: [{ id, flag }] (every world actor with its current flag) · msg: the grant command
 */
export function planGrant(actors, msg) {
  const want = new Set((Array.isArray(msg?.grants) ? msg.grants : []).map(g => String(g?.actorId || "")).filter(Boolean))
  const have = new Set((actors || []).map(a => a.id))
  const set = [...want].filter(id => have.has(id))
  const missing = [...want].filter(id => !have.has(id))
  const unset = (actors || []).filter(a => isPending(a.flag) && !want.has(a.id)
    && a.flag.campaignId === String(msg?.campaignId || "") && a.flag.grantId !== String(msg?.grantId || "")).map(a => a.id)
  return { set, unset, missing }
}

/** Which actors a clear takes the flag off: that grant's (or, with only a campaign, that campaign's). */
export function planClear(actors, msg) {
  const gid = String(msg?.grantId || "")
  const cid = String(msg?.campaignId || "")
  if (!gid && !cid) return []
  return (actors || []).filter(a => isPending(a.flag) && (gid ? a.flag.grantId === gid : a.flag.campaignId === cid)).map(a => a.id)
}

/** Glow pulse: alpha for time t (ms). Slow and soft. */
export const pulseAlpha = (t) => 0.7 + 0.3 * Math.sin((t / 900) * Math.PI)
