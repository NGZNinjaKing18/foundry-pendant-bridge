import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { parseWho, todayFor, playerSees, calendarFor, monthAt, daysOf, dayLabel, yearLabel, overlay } = await import("../scripts/calendar-model.js")
const { slicesOf } = await import("../scripts/private.js")

// Two campaigns on one calendar: Ashfall (u1, u2) at day 120, Bramble (u3) at day 110.
const cal = {
  v: 1, calendarId: "cal", name: "Test", dayNames: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"], years: [1, 1],
  months: [
    { id: "A", name: "Alpha", year: 1, k0: 100, len: 28, wd: "0123456".repeat(4) },
    { id: "F", name: "Feast", year: 1, k0: 128, len: 1, wd: "0", festival: true },
    { id: "B", name: "Beta", year: 1, k0: 129, len: 28, wd: "1234560".repeat(4), fest: { 3: "Starfall" } },
  ],
  camps: [{ id: "a", name: "Ashfall", short: "AS", users: ["u1", "u2"], k: 120 }, { id: "b", name: "Bramble", short: "BR", users: ["u3"], k: 110 }],
  world: 120, live: null,
  items: [
    { id: "e1", kind: "event", name: "Past, everyone", k: 105, who: "all", early: false, edit: { type: "event", id: "1" } },
    { id: "e2", kind: "event", name: "Secret", k: 105, who: "gm", early: false, edit: { type: "event", id: "2" } },
    { id: "e3", kind: "event", name: "Ashfall past", k: 115, who: "c:a", early: false, edit: { type: "event", id: "3" } },
    { id: "e4", kind: "event", name: "Ashfall future", k: 125, who: "c:a", early: false, edit: { type: "event", id: "4" } },
    { id: "e5", kind: "event", name: "Ashfall early", k: 125, who: "c:a", early: true, edit: { type: "event", id: "5" } },
    { id: "e6", kind: "note", name: "For u2 only", k: 101, who: "u:u2", early: false, edit: { type: "event", id: "6" } },
    { id: "e7", kind: "event", name: "Everyone, day 115", k: 115, who: "all", early: false, edit: { type: "event", id: "7" } },
    { id: "h1", kind: "holiday", name: "Bloomtide", k: 140, who: "all", early: true, rec: true, edit: { type: "holiday", id: "h" } },
    { id: "h2", kind: "holiday", name: "GM holiday", k: 141, who: "gm", early: true, rec: true },
    { id: "s1", kind: "session", name: "Session 3", k: 108, who: "c:b", early: false },
  ],
}
const names = (c) => c.items.map(i => i.name).sort()

test("who strings", () => {
  assert.deepEqual(parseWho("all"), { t: "all", ids: [] })
  assert.deepEqual(parseWho("c:a"), { t: "c", ids: ["a"] })
  assert.deepEqual(parseWho("u:x, y"), { t: "u", ids: ["x", "y"] })
  assert.equal(parseWho("u:").t, "gm")
  assert.equal(parseWho("whatever").t, "gm", "anything unreadable is GM-only")
})

test("today: running campaign, else furthest ahead of theirs, else the world date", () => {
  assert.equal(todayFor(cal, "u1"), 120)
  assert.equal(todayFor(cal, "u3"), 110)
  assert.equal(todayFor(cal, "nobody"), 120)
  assert.equal(todayFor({ ...cal, camps: [...cal.camps, { id: "c", users: ["u1"], k: 90 }], live: "c" }, "u1"), 90)
})

test("an Ashfall player sees only what has happened for Ashfall, plus early entries and holidays", () => {
  assert.deepEqual(names(calendarFor(cal, "u1")), ["Ashfall early", "Ashfall past", "Bloomtide", "Everyone, day 115", "Past, everyone"])
  assert.deepEqual(names(calendarFor(cal, "u2")), ["Ashfall early", "Ashfall past", "Bloomtide", "Everyone, day 115", "For u2 only", "Past, everyone"])
})

test("a Bramble player never sees Ashfall, and their own date hides day 115", () => {
  const c = calendarFor(cal, "u3")
  assert.deepEqual(names(c), ["Bloomtide", "Past, everyone", "Session 3"])
  assert.deepEqual(c.camps.map(x => x.id), ["b"], "no other campaign's name or date")
  assert.equal(c.world, 110)
})

test("a player's copy carries no GM fields", () => {
  const c = calendarFor(cal, "u1")
  for (const i of c.items) { assert.ok(!("who" in i)); assert.ok(!("edit" in i)); assert.ok(!("early" in i)) }
  for (const k of c.camps) assert.deepEqual(k.users, ["u1"], "never the other players' ids")
  const json = JSON.stringify(c)
  for (const leak of ["Secret", "GM holiday", "Ashfall future", "For u2 only", "Bramble", "u2", "u3"]) assert.ok(!json.includes(leak), `leaked ${leak}`)
})

test("slices: GMs get the full calendar, each player only theirs", () => {
  const s = slicesOf({ roster: null, pages: {}, calendar: cal }, ["u1", "u3", "u9"])
  assert.equal(s.gm.calendar, cal)
  assert.ok(s.u1.calendar && s.u3.calendar)
  assert.ok(!JSON.stringify(s.u3).includes("Ashfall"))
  assert.ok(s.u9.calendar, "a player in no campaign still sees everyone's past and the holidays")
  assert.deepEqual(names(s.u9.calendar), ["Bloomtide", "Everyone, day 115", "Past, everyone"])
  assert.ok(!("calendar" in slicesOf({ roster: null, pages: {} }, ["u1"]).gm))
})

test("the grid: months, festival days, labels", () => {
  assert.equal(monthAt(cal, 128), 1)
  assert.equal(monthAt(cal, 99), -1)
  const b = daysOf(cal.months[2])
  assert.equal(b[2].n, 3)
  assert.equal(b[3].n, null); assert.equal(b[3].fest, "Starfall")
  assert.equal(b[4].n, 4, "a festival day takes no number")
  assert.equal(b[0].w, 1)
  assert.equal(dayLabel(cal, 120), "21 Alpha 1")
  assert.equal(dayLabel(cal, 128), "Feast 1")
  assert.equal(dayLabel(cal, 132), "Starfall 1")
})

test("the GM's waiting changes lay over the entries", () => {
  const ops = [
    { clientId: "x", op: "add", kind: "note", name: "New", k: 130, who: "gm", state: "waiting" },
    { clientId: "y", op: "update", list: "event", id: "1", k: 107, from: 105, name: "Moved" },
    { clientId: "z", op: "remove", list: "event", id: "2" },
    { clientId: "w", op: "update", list: "holiday", id: "h", k: 142, from: 140 },
  ]
  const out = overlay(cal.items, ops)
  const by = Object.fromEntries(out.map(i => [i.id, i]))
  assert.equal(by["p:x"].pending, "waiting")
  assert.equal(by.e1.k, 107); assert.equal(by.e1.name, "Moved"); assert.equal(by.e1.pending, "saving")
  assert.ok(!by.e2)
  assert.equal(by.h1.k, 142)
  assert.equal(cal.items.find(i => i.id === "e1").k, 105, "the input is not changed")
})

test("labels come from RealmScreen when it sends them (its own date format and year names)", () => {
  const own = { ...cal, months: cal.months.map(m => ({ ...m, yl: "Winter 1 · Thawen", dl: Array.from({ length: m.len }, (_, i) => `1 • 1/4 → ${m.name} • ${String(i + 1).padStart(2, "0")}`) })) }
  assert.equal(dayLabel(own, 120), "1 • 1/4 → Alpha • 21")
  assert.equal(dayLabel(cal, 120), "21 Alpha 1", "older RealmScreen: the plain label")
  assert.equal(yearLabel(own.months[0]), "Winter 1 · Thawen")
})

// ── multi-day entries (k → k2, 2026-11-07) ─────────────────────────────────
import { lastDay, coversDay } from "../scripts/calendar-model.js"
test("a multi-day entry runs through every day from k to k2; a one-day entry is just k", () => {
  assert.equal(lastDay({ k: 10, k2: 14 }), 14)
  assert.equal(lastDay({ k: 10 }), 10)
  assert.equal(lastDay({ k: 10, k2: 9 }), 10)                      // a bad end never runs backwards
  assert.equal(coversDay({ k: 10, k2: 14 }, 12), true)
  assert.equal(coversDay({ k: 10, k2: 14 }, 15), false)
  assert.equal(coversDay({ k: 10 }, 10), true)
})
test("moving a multi-day entry moves its last day with it", () => {
  const items = [{ id: "e:a", kind: "event", name: "Siege", k: 10, k2: 14, edit: { type: "event", id: "a" } }]
  const out = overlay(items, [{ op: "update", list: "event", id: "a", k: 20, from: 10 }])
  assert.equal(out[0].k, 20); assert.equal(out[0].k2, 24)
})
