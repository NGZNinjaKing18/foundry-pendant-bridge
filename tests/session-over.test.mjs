// scripts/session-over-model.js — Session Over in Foundry: privacy cut, recap by day, route strip
// + time-lapse, who the rations come from, who gets the players' copy.
import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
globalThis.game = { user: { isGM: true } }
globalThis.HTMLElement = class {}
const M = await import("../scripts/session-over-model.js")
const { rationStacks, planTake } = await import("../scripts/rations.js")

const gmView = () => ({
  v: 1, sessionId: "s1", number: 4, title: "", campaignId: "c1", campaignName: "Ashes", campaignColor: "#a55", endedAt: 5, live: false,
  start: { key: 10 }, end: { key: 12 },
  party: [
    { key: "ana", name: "Ana", discordId: "111", attended: true, autoAttended: true, edited: false, discordAvatar: "https://cdn.discordapp.com/a.png", actorId: "A1" },
    { key: "bo", name: "Bo", discordId: "222", attended: false, autoAttended: true, edited: true },
  ],
  stats: { days: { value: 3, auto: 2, edited: true, clock: 2 }, rolls: { value: 40, auto: 40, edited: false }, nat20: { value: 2, auto: 2, edited: false }, nat1: { value: 1, auto: 1, edited: false }, counted: true },
  awarded: {
    training: { value: 1, auto: 1, edited: false, rate: { days: 3, rolls: 1 }, to: ["ana"] },
    money: { value: { gp: 40, sp: 5 }, auto: { gp: 40 }, edited: true },
    misc: [{ id: "i1", name: "Potion", qty: 2, to: "Ana", from: "given", edited: false, img: "icons/p.webp" }],
    hiddenItems: [{ id: "i9", name: "Cursed ring" }],
  },
  route: { legs: [{ id: "g1", kind: "stay", place: "Mill", days: 1, x: 0.1, y: 0.2, auto: true }], edited: false, trail: [{ id: "t" }], days: 1, travelled: 0 },
  recap: [
    { dayKey: 10, n: 1, header: "3 Frost – day 1", rows: [
      { id: "l1", ids: ["l1"], text: "They met the miller", who: "Ana", vis: "public", locked: false, kind: "note" },
      { id: "l2", ids: ["l2"], text: "The miller is the spy", who: "DM", vis: "dm", locked: true, kind: "gm" },
    ] },
    { dayKey: 11, n: 2, header: "4 Frost – day 2", rows: [{ id: "l3", text: "Cut joke", who: "Bo", vis: "drop" }] },
  ],
  met: [{ id: "character:miller", name: "Miller", dayKey: 10, added: true }],
  rations: { n: 2, suggested: 0, takenAt: null },
  secretFutureField: "GM only",
})

test("players get only what the allow-list says: Public lines, plain numbers, no rations", () => {
  const p = M.forPlayer(gmView())
  const flat = JSON.stringify(p)
  for (const leak of ["spy", "Cut joke", "Cursed ring", "rations", "edited", "auto", "locked", "secretFutureField", "discordId", "trail", "counted", "rate"]) {
    assert.ok(!flat.includes(leak), `players' copy holds "${leak}"`)
  }
  assert.deepEqual(p.recap, [{ dayKey: 10, n: 1, header: "3 Frost – day 1", rows: [{ id: "l1", text: "They met the miller", who: "Ana" }] }])
  assert.deepEqual(p.stats.days, { value: 3 })
  assert.deepEqual(p.awarded.money, { value: { gp: 40, sp: 5 } })
  assert.equal(p.awarded.misc[0].to, "Ana")
  assert.deepEqual(p.party.map(x => [x.key, x.attended]), [["ana", true], ["bo", false]])
  assert.equal(p.party[0].actorId, "A1")
  assert.deepEqual(p.met, [{ id: "character:miller", name: "Miller" }])
  assert.equal(M.forPlayer(null), null)
})

test("the cut is stable: RealmScreen's own players' copy (no vis) comes out the same", () => {
  const once = M.forPlayer(gmView())
  assert.deepEqual(M.forPlayer(once), once)
})

test("recap by day: GM sees every line, players Public only; a day with nothing left is dropped", () => {
  const v = gmView()
  const gm = M.dayBlocks(v.recap, { gm: true })
  assert.deepEqual(gm.map(b => [b.header, b.rows.length]), [["3 Frost – day 1", 2], ["4 Frost – day 2", 1]])
  const pl = M.dayBlocks(v.recap)
  assert.deepEqual(pl.map(b => [b.header, b.rows.map(r => r.id)]), [["3 Frost – day 1", ["l1"]]])
  // undated groups get a key of their own
  assert.equal(M.dayBlocks([{ dayKey: null, header: "", rows: [{ id: "x", text: "t" }] }])[0].key, "u0")
})

test("route strip: placed on the map when every stop knows where it is, else in a row", () => {
  const legs = [
    { kind: "stay", place: "Mill", days: 2, x: 0.1, y: 0.1 },
    { kind: "travel", from: "Mill", to: "Ford", days: 1.5, x: 0.1, y: 0.1, x2: 0.5, y2: 0.3 },
    { kind: "stay", place: "Ford", days: 0.5, x: 0.5, y: 0.3 },
  ]
  const s = M.stripOf(legs)
  // arriving at Ford and staying there = one stop with its days
  assert.deepEqual(s.pts.map(p => [p.label, p.stay, p.leg ?? null, p.days ?? null]), [["Mill", true, null, 2], ["Ford", true, 1.5, 0.5]])
  for (const p of s.pts) { assert.ok(p.x >= 0 && p.x <= s.W); assert.ok(p.y >= 0 && p.y <= s.H) }
  const row = M.stripOf([{ kind: "travel", from: "A", to: "B", days: 1 }])
  assert.deepEqual(row.pts.map(p => p.y), [75, 75])
  assert.equal(M.stripOf([]).pts.length, 0)
})

test("time-lapse: walks each leg for its days, waits at each stay, rests at the end", () => {
  const { pts } = M.stripOf([
    { kind: "travel", from: "A", to: "B", days: 2 },
    { kind: "stay", place: "B", days: 3 },
    { kind: "travel", from: "B", to: "C", days: 1 },
  ])
  const l = M.lapseOf(pts)
  assert.equal(l.keyPoints.length, l.keyTimes.length)
  assert.equal(l.keyTimes[0], 0); assert.equal(l.keyTimes.at(-1), 1)
  assert.equal(l.keyPoints[0], 0); assert.equal(l.keyPoints.at(-1), 1)
  for (let i = 1; i < l.keyTimes.length; i++) assert.ok(l.keyTimes[i] >= l.keyTimes[i - 1])
  for (let i = 1; i < l.keyPoints.length; i++) assert.ok(l.keyPoints[i] >= l.keyPoints[i - 1])
  // the stay at B: two keys at the same point, 3 days apart (of 6 days + the end rest)
  const atB = l.keyPoints.map((k, i) => [k, l.keyTimes[i]]).filter(([k]) => k > 0 && k < 1)
  assert.ok(atB.length >= 2 && atB[0][0] === atB[1][0])
  assert.ok(Math.abs((atB[1][1] - atB[0][1]) - 3 / (6 / 0.85)) < 0.01)
  assert.ok(l.dur >= 3 && l.dur <= 12)
  assert.equal(M.lapseOf(pts.slice(0, 1)), null)
  assert.equal(M.lapseOf([]), null)
})

test("rations come from everyone who came, through their linked (or one exactly-named) actor", () => {
  const item = (id, name, quantity) => ({ id, name, type: "consumable", system: { quantity } })
  const actors = [
    { id: "A1", name: "Ana the Bold", type: "character", items: [item("r1", "Rations (1 day)", 5)] },
    { id: "C1", name: "Cy", type: "character", items: [item("r2", "Rations", 1)] },
    { id: "D1", name: "Dee", type: "character", items: [] }, { id: "D2", name: "Dee", type: "npc", items: [] },
    { id: "G1", name: "Eve", type: "group", items: [] },
  ]
  const party = [
    { key: "ana", name: "Ana", attended: true, actorId: "A1" },     // linked by RealmScreen
    { key: "bo", name: "Bo", attended: false },                      // away: never touched
    { key: "cy", name: "Cy", attended: true },                       // one actor with that name
    { key: "dee", name: "Dee", attended: true },                     // two → nobody (no guessing)
    { key: "eve", name: "Eve", attended: true },                     // a group isn't a person
  ]
  const { members, missing } = M.rationMembers(party, actors, rationStacks)
  assert.deepEqual(members.map(m => m.id), ["A1", "C1"])
  assert.deepEqual(missing, ["Dee", "Eve"])
  const plan = planTake(members, M.rationN("2"))
  assert.deepEqual(plan.map(p => [p.name, p.before, p.after, p.short]), [["Ana", 5, 3, 0], ["Cy", 1, 0, 1]])
  assert.equal(M.rationN("-3"), 0); assert.equal(M.rationN("2.7"), 2); assert.equal(M.rationN(""), 0)
})

test("the players' copy goes to that campaign's players only — never a GM, never another campaign", () => {
  const roster = { campaigns: [{ id: "c1", users: ["p1", "p2", "gm1", "gone"] }, { id: "c2", users: ["p3"] }] }
  const users = [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "gm1", isGM: true }]
  assert.deepEqual(M.recipientsOf(roster, "c1", users), ["p1", "p2"])
  assert.deepEqual(M.recipientsOf(roster, "nope", users), [])
  assert.deepEqual(M.recipientsOf(null, "c1", users), [])
})

test("money: the app's own words and label", () => {
  assert.deepEqual(M.parseMoney("40 gold and 5 sp, 3 bronze"), { gp: 40, sp: 5, cp: 3 })
  assert.equal(M.moneyLabel({ gp: 40, sp: 5 }), "40 gp · 5 sp")
  assert.equal(M.moneyLabel({}), "")
  assert.equal(M.esc(`<a href="x">`), "&lt;a href=&quot;x&quot;&gt;")
})

test("a GM's whisper may pass on get, update and the window-closed note — nothing else", () => {
  assert.deepEqual(M.SO_OPS, ["get", "update", "closed"])
  assert.equal(M.opAllowed("closed"), true)
  assert.equal(M.opAllowed("answer"), false)
  assert.equal(M.opAllowed(undefined), false)
})

// ── the map box ──────────────────────────────────────────────
test("mapOf: allow-listed, odd input → no map, players keep it", () => {
  assert.equal(M.mapOf(null), null)
  assert.equal(M.mapOf({ src: "", stops: [{ x: 0, y: 0 }] }), null)
  assert.equal(M.mapOf({ src: "javascript:alert(1)", stops: [{ x: 0, y: 0 }] }), null)
  assert.equal(M.mapOf({ src: "a.webp", stops: [] }), null)
  const m = M.mapOf({ src: "a.webp", aspect: 99, secret: 1, stops: [{ x: 0.5, y: 0.5, label: "Ford", stay: true, days: 2, gm: 1 }, { x: "no" }] })
  assert.deepEqual(m, { src: "a.webp", aspect: 1.6, stops: [{ x: 0.5, y: 0.5, label: "Ford", stay: true, days: 2 }] })
  const pv = M.forPlayer({ sessionId: "s", route: { legs: [], map: { src: "a.webp", aspect: 2, token: "c.webp", stops: [{ x: 0.1, y: 0.2 }] } } })
  assert.equal(pv.route.map.token, "c.webp")
  assert.equal(M.forPlayer({ sessionId: "s", route: { legs: [] } }).route.map, undefined)
})

test("lapse: legs take their days, stays count up, ends at the last stop", () => {
  const stops = [{ x: 0, y: 0, stay: true, days: 2 }, { x: 10, y: 0, leg: 2, stay: true, days: 3 }]
  const p = M.lapsePlan(stops, { secPerDay: 1, min: 0, max: 99, rest: 0 })
  assert.deepEqual(p.steps.map(s => s.kind), ["stay", "move", "stay"])
  assert.deepEqual(M.lapseAt(p, stops, 0.6).boxes, [{ at: 0, days: 1, live: true }])
  assert.equal(M.lapseAt(p, stops, 3).x, 5)
  const e = M.lapseAt(p, stops, Infinity)
  assert.equal(e.x, 10); assert.deepEqual(e.boxes.map(b => b.days), [2, 3])
  assert.equal(M.lapsePlan([], {}).steps.length, 0)
})
