// scripts/best-moment-model.js — the Best Moment winner's buff: who gets the flag, advantage on the first d20, the spend.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  grantFlag, isPending, actorOfHookArgs, applyAdvantage, isD20Message, rollLabel, usedMessage,
  planGrant, planClear, PRE_ROLL_HOOKS, pulseAlpha,
} from "../scripts/best-moment-model.js"

const actor = (id = "a1") => ({ documentName: "Actor", id, name: "Hilde" })

test("the flag is the pending state", () => {
  const f = grantFlag({ grantId: "g1", campaignId: "c1", sessionId: "s2", label: "Best moment of Albuna 4" }, 5)
  assert.deepEqual(f, { grantId: "g1", campaignId: "c1", sessionId: "s2", label: "Best moment of Albuna 4", at: 5 })
  assert.equal(isPending(f), true)
  assert.equal(isPending(null), false)
  assert.equal(isPending({}), false)
})

test("which actor a pre-roll hook is about: 4.x config, attacks, 3.x, initiative", () => {
  const a = actor()
  assert.equal(actorOfHookArgs([{ subject: a, rolls: [] }, {}, {}]), a)                       // skill / check / save
  assert.equal(actorOfHookArgs([{ subject: { actor: a, type: "attack" }, rolls: [] }]), a)   // an attack activity
  assert.equal(actorOfHookArgs([a, { parts: [] }, "ste"]), a)                                // 3.x skill
  assert.equal(actorOfHookArgs([{ documentName: "Item", actor: a }, {}]), a)                 // 3.x attack
  assert.equal(actorOfHookArgs([{ subject: null }]), null)
})

test("advantage: 4.x config + each roll; 3.x config; initiative roll; nothing else touched", () => {
  const c4 = { subject: actor(), rolls: [{ parts: ["@mod"], options: { foo: 1 } }, { parts: [] }] }
  assert.equal(applyAdvantage([c4, { configure: true }, {}]), true)
  assert.equal(c4.advantage, true)
  assert.deepEqual(c4.rolls.map(r => r.options.advantage), [true, true])
  assert.equal(c4.rolls[0].options.foo, 1)
  const c3 = { parts: [] }
  assert.equal(applyAdvantage([actor(), c3, "ste"]), true)
  assert.equal(c3.advantage, true)
  let reconfigured = 0
  const init = { terms: [], options: {}, configureModifiers() { reconfigured++ } }
  assert.equal(applyAdvantage([actor(), init], { ADVANTAGE: 1 }), true)
  assert.equal(init.options.advantageMode, 1)
  assert.equal(reconfigured, 1)
  assert.equal(applyAdvantage([actor(), { terms: [], options: {}, _evaluated: true }]), false)   // already rolled
  assert.equal(applyAdvantage([actor()]), false)
})

test("the spending roll: a system d20 roll only; label; the frame RealmScreen hears", () => {
  const isD20 = (r) => r.kind === "d20"
  assert.equal(isD20Message({ rolls: [{ kind: "plain" }] }, isD20), false)                 // /r 1d20
  assert.equal(isD20Message({ rolls: [{ kind: "damage" }, { kind: "d20" }] }, isD20), true)
  assert.equal(isD20Message({}, isD20), false)
  assert.equal(rollLabel({ flavor: "<span>Stealth</span> Skill Check" }), "Stealth Skill Check")
  assert.equal(rollLabel({ flags: { dnd5e: { roll: { type: "attack" } } } }), "attack")
  assert.equal(rollLabel({}), "a d20 roll")
  const m = usedMessage({ flag: { grantId: "g1", campaignId: "c1", sessionId: "s2" }, actorId: "a1", roll: "Stealth", at: 9 })
  assert.deepEqual(m, { type: "bestmoment.used", grantId: "g1", campaignId: "c1", sessionId: "s2", actorId: "a1", roll: "Stealth", at: 9 })
})

test("grant: winners get it, an older grant of the same campaign comes off, others are left alone", () => {
  const actors = [
    { id: "a1", flag: null },
    { id: "a2", flag: { grantId: "old", campaignId: "c1" } },
    { id: "a3", flag: { grantId: "x", campaignId: "c2" } },
    { id: "a4", flag: null },
  ]
  const p = planGrant(actors, { grantId: "g1", campaignId: "c1", grants: [{ actorId: "a1" }, { actorId: "a4" }, { actorId: "gone" }] })
  assert.deepEqual(p.set, ["a1", "a4"])
  assert.deepEqual(p.unset, ["a2"])
  assert.deepEqual(p.missing, ["gone"])
  // a shared win re-sent (same grant) keeps both
  assert.deepEqual(planGrant([{ id: "a1", flag: { grantId: "g1", campaignId: "c1" } }], { grantId: "g1", campaignId: "c1", grants: [{ actorId: "a1" }] }).unset, [])
})

test("clear: by grant, or by campaign; never everything", () => {
  const actors = [{ id: "a1", flag: { grantId: "g1", campaignId: "c1" } }, { id: "a2", flag: { grantId: "g2", campaignId: "c1" } }, { id: "a3", flag: null }]
  assert.deepEqual(planClear(actors, { grantId: "g1" }), ["a1"])
  assert.deepEqual(planClear(actors, { campaignId: "c1" }), ["a1", "a2"])
  assert.deepEqual(planClear(actors, {}), [])
})

test("hooks cover new and old dnd5e; the glow pulses softly", () => {
  for (const h of ["dnd5e.preRollD20TestV2", "dnd5e.preRollAttackV2", "dnd5e.preRollSkill", "dnd5e.preRollInitiative"]) assert.ok(PRE_ROLL_HOOKS.includes(h))
  for (let t = 0; t < 4000; t += 97) { const a = pulseAlpha(t); assert.ok(a >= 0.4 && a <= 1) }
})
