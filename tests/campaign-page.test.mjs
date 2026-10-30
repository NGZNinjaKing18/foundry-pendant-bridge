import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { visibleSecrets, unseenFor, noteViewers, whoLine } = await import("../scripts/campaign-page.js")

const page = {
  users: ["u1", "u2", "u3"],
  secrets: [
    { id: "a", state: "given", to: ["u1"], seen: [], shown: [] },
    { id: "b", state: "given", to: ["u2"], seen: ["u2"], shown: [{ id: "u2", name: "Brom" }] },
    { id: "c", state: "waiting", to: ["u1"], seen: [], shown: [] },
    { id: "d", state: "given", to: ["u3"], seen: [], shown: [], revealed: true },
  ],
}

test("a player sees what was given to them, plus what was shown or revealed to the party", () => {
  assert.deepEqual(visibleSecrets(page, "u1", false).map(s => s.id), ["a", "b", "d"])
  assert.deepEqual(visibleSecrets(page, "u9", false).map(s => s.id), [])      // not in the campaign
  assert.equal(visibleSecrets(page, "gm", true).length, 4)                     // GMs see all, waiting too
})

test("unseen = visible and not opened yet", () => {
  assert.deepEqual(unseenFor(page, "u2").map(s => s.id), ["d"])
  assert.deepEqual(unseenFor(page, "u1").map(s => s.id), ["a", "b", "d"])
})

test("a place note is owned by who knows it; nobody before it's given", () => {
  assert.deepEqual(noteViewers(page.secrets[0], page.users), ["u1"])
  assert.deepEqual(noteViewers(page.secrets[1], page.users).sort(), ["u1", "u2", "u3"])
  assert.deepEqual(noteViewers(page.secrets[2], page.users), [])
})

test("who-knows line", () => {
  const nm = (id) => ({ u1: "Velora", u2: "Brom" }[id])
  assert.equal(whoLine({ to: ["u1"], shown: [] }, "u1", nm), "Only you know this")
  assert.equal(whoLine({ to: ["u1", "u2"], shown: [] }, "u1", nm), "You and Brom know this")
  assert.equal(whoLine(page.secrets[1], "u1", nm), "Brom showed this to the party")
  assert.equal(whoLine(page.secrets[3], "u1", nm), "Revealed to the party")
})

const { groupMemberActors, ownersOf, memberStats } = await import("../scripts/campaign-page.js")

test("a linked group: its member actors (dnd5e 4+ and the old id set) and their owners", () => {
  const a = { id: "a1", ownership: { default: 0, u1: 3 } }, b = { id: "a2", ownership: { default: 3, u2: 3 } }   // b: "All players: Owner"
  assert.deepEqual(groupMemberActors({ system: { members: [{ actor: a }, { actor: b }, { actor: null }] } }).map(x => x.id), ["a1", "a2"])
  globalThis.game = { actors: { get: (id) => ({ a1: a, a2: b }[id]) } }
  assert.deepEqual(groupMemberActors({ system: { members: new Set(["a2"]) } }).map(x => x.id), ["a2"])
  assert.deepEqual(groupMemberActors(null), [])
  const users = [{ id: "gm", isGM: true }, { id: "u1" }, { id: "u2" }, { id: "u3" }]
  assert.deepEqual(ownersOf([a, b], users), ["u1", "u2"])          // only the explicit owners — default ownership doesn't add u3
  assert.deepEqual(ownersOf([{ id: "x", ownership: { default: 3 } }], users), [])
})

test("member stats read like the group sheet; missing numbers stay null", () => {
  const s = memberStats({ system: { attributes: { hp: { value: 1, max: 73 }, hd: { value: 8, max: 8 }, ac: { value: 15 } }, skills: { prc: { passive: 16 }, ste: { passive: 19 }, sur: { passive: 10 } } } })
  assert.deepEqual(s, { hp: [1, 73], hd: [8, 8], ac: 15, prc: 16, ste: 19, sur: 10 })
  assert.deepEqual(memberStats({ system: {} }), { hp: null, hd: null, ac: null, prc: null, ste: null, sur: null })
})

const { moveGoal } = await import("../scripts/campaign-page.js")
test("moveGoal: before / after / end, and into another section", () => {
  const g = [{ id: "a", who: "party" }, { id: "b", who: "party" }, { id: "c", who: "party" }]
  assert.deepEqual(moveGoal(g, "c", { before: "a" }).map(x => x.id), ["c", "a", "b"])
  assert.deepEqual(moveGoal(g, "a", { after: "b" }).map(x => x.id), ["b", "a", "c"])
  assert.deepEqual(moveGoal(g, "a", {}).map(x => x.id), ["b", "c", "a"])
  assert.equal(moveGoal(g, "b", { who: "Doril" }).find(x => x.id === "b").who, "Doril")
  assert.deepEqual(moveGoal(g, "zz", { before: "a" }).map(x => x.id), ["a", "b", "c"])
})

const { plainText, newId } = await import("../scripts/campaign-page.js")
test("item text: links and rolls become their words, entities decoded, paragraphs kept, cut with an ellipsis", () => {
  const html = "<p>Hit with @UUID[Compendium.dnd5e.items.Item.abc]{Longsword} for [[/r 1d6]] &amp; more&nbsp;damage.</p><p>Second</p>"
  assert.equal(plainText(html), "Hit with Longsword for 1d6 & more damage.\nSecond")
  assert.equal(plainText("<p>" + "word ".repeat(400) + "</p>", 50).endsWith("…"), true)
  assert.equal(plainText(""), "")
})
test("new ids are unique", () => {
  const s = new Set(Array.from({ length: 500 }, () => newId()))
  assert.equal(s.size, 500)
})
