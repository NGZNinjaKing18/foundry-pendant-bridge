// ──────────────────────────────────────────────────────────────
// Calendar — the pure parts (no Foundry): each player's cut of RealmScreen's
// calendar, and the GM's waiting changes laid over it. Tested in
// tests/calendar.test.mjs; drawn by scripts/calendar.js.
//
// RealmScreen sends the GM's full copy (`calendar.set`, built by pendant-home
// lib/foundryCalendarModel.mjs): months already laid out, every entry dated
// (`k` = absolute day) with `who`:
//   'all' · 'gm' · 'c:<campaignId>' · 'u:<userId>,<userId>'
// and each campaign's own date + players. A player gets ONLY:
//   • entries meant for them (everyone / a campaign they're in / them by name)
//   • …that have happened for them (a campaign's entry: by that campaign's date;
//     anything else: by their furthest-ahead campaign), unless shown early;
//     holidays and birthdays always
//   • their own campaigns (no other campaign's name, players or date)
// No `who`, no edit handles. The cut travels in their private whisper slice
// (scripts/private.js) — never a world setting.
// ──────────────────────────────────────────────────────────────

const str = (v) => (typeof v === "string" ? v.trim() : "")
const arr = (v) => (Array.isArray(v) ? v : [])
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

/** The parts of a `who` string → { t: 'all'|'gm'|'c'|'u', ids }. */
export function parseWho(who) {
  const w = str(who)
  if (w === "all") return { t: "all", ids: [] }
  if (w.startsWith("c:") && str(w.slice(2))) return { t: "c", ids: [str(w.slice(2))] }
  if (w.startsWith("u:")) { const ids = w.slice(2).split(",").map(str).filter(Boolean); if (ids.length) return { t: "u", ids } }
  return { t: "gm", ids: [] }
}

/** Which day is "today" for this player: the running campaign if they're in it, else their furthest-ahead one, else the world date. */
export function todayFor(cal, uid) {
  const mine = arr(cal?.camps).filter(c => arr(c.users).includes(uid) && num(c.k) != null)
  const live = mine.find(c => c.id === cal?.live)
  if (live) return live.k
  if (mine.length) return Math.max(...mine.map(c => c.k))
  return num(cal?.world)
}

/** May this player see this entry? (The same rule on every client and in tests.) */
export function playerSees(item, cal, uid) {
  if (!item || !uid) return false
  const w = parseWho(item.who)
  const mine = arr(cal?.camps).filter(c => arr(c.users).includes(uid))
  if (w.t === "gm") return false
  if (w.t === "c" && !mine.some(c => c.id === w.ids[0])) return false
  if (w.t === "u" && !w.ids.includes(uid)) return false
  if (item.rec || item.early || item.kind === "holiday" || item.kind === "bday") return true
  const k = num(item.k)
  if (k == null) return false
  const today = w.t === "c" ? num(mine.find(c => c.id === w.ids[0])?.k) : todayFor(cal, uid)
  return today != null && k <= today
}

/** One player's cut of the full calendar (see the header). */
export function calendarFor(cal, uid) {
  if (!cal || !uid) return null
  const items = arr(cal.items).filter(i => playerSees(i, cal, uid))
    .map(({ who, edit, early, ...rest }) => rest)
  const camps = arr(cal.camps).filter(c => arr(c.users).includes(uid)).map(c => ({ id: c.id, name: c.name, short: c.short, k: c.k, users: [uid] }))
  return {
    v: cal.v, calendarId: cal.calendarId, name: cal.name, dayNames: arr(cal.dayNames), years: arr(cal.years), months: arr(cal.months),
    items, camps, world: todayFor(cal, uid), live: camps.some(c => c.id === cal.live) ? cal.live : null,
  }
}

// ── the grid ──────────────────────────────────────────────────
/** The month (index into cal.months) holding day `k`, or -1. */
export function monthAt(cal, k) {
  const ms = arr(cal?.months)
  return ms.findIndex(m => k >= m.k0 && k < m.k0 + m.len)
}
/** A month's days: [{ k, n (day number, null on a festival day), w (weekday index), fest? }]. */
export function daysOf(m) {
  const out = []
  let n = 0
  for (let i = 0; i < (m?.len || 0); i++) {
    const fest = m.festival ? m.name : m.fest?.[i] || null
    if (!fest || m.festival) n++
    out.push({ k: m.k0 + i, n: m.festival ? n : fest ? null : n, w: parseInt(m.wd?.[i] || "0", 36) || 0, ...(fest ? { fest } : {}) })
  }
  return out
}
/** The year in the calendar's own words ("Winter 98 · StarFall"); older RealmScreen: the number. */
export function yearLabel(m) {
  return m ? (str(m.yl) || String(m.year)) : ""
}
/** The day exactly as RealmScreen writes it (its "Read as" pattern); older RealmScreen:
 *  "18 MistMorn 391" (a festival day: "Ward & Bond 391"). */
export function dayLabel(cal, k) {
  const m = arr(cal?.months)[monthAt(cal, k)]
  if (!m) return ""
  const own = str(arr(m.dl)[k - m.k0])
  if (own) return own
  const d = daysOf(m)[k - m.k0]
  if (m.festival) return `${m.name}${m.len > 1 ? ` ${d.n}` : ""} ${m.year}`
  return d.fest ? `${d.fest} ${m.year}` : `${d.n} ${m.name} ${m.year}`
}
export function weekdayName(cal, k) {
  const m = arr(cal?.months)[monthAt(cal, k)]
  if (!m) return ""
  return arr(cal.dayNames)[daysOf(m)[k - m.k0].w] || ""
}

// ── the GM's changes not yet in RealmScreen ───────────────────
/**
 * Lay waiting changes over the entries. `ops` = [{ clientId, op, list, id, kind, name, note, k, who, early, state }]
 * where `id` is RealmScreen's id (edit.id) for update/remove. → entries with `pending: state` on the changed ones.
 */
export function overlay(items, ops) {
  let out = arr(items).map(i => ({ ...i }))
  for (const o of arr(ops)) {
    if (!o) continue
    const state = o.state || "saving"
    if (o.op === "add") {
      out.push({ id: `p:${o.clientId}`, kind: o.kind || "event", name: str(o.name) || "Untitled", note: str(o.note), k: num(o.k), color: null, who: o.who || "gm", early: !!o.early, pending: state, rec: o.kind === "holiday" })
      continue
    }
    const hit = (i) => i.edit && i.edit.id === o.id && i.edit.type === (o.list || "event")
    if (o.op === "remove") { out = out.filter(i => !hit(i)); continue }
    if (o.op === "update") {
      out = out.map(i => {
        if (!hit(i)) return i
        const n = { ...i, pending: state }
        if (o.name !== undefined) n.name = str(o.name) || i.name
        if (o.note !== undefined) n.note = str(o.note)
        if (o.who !== undefined) n.who = o.who
        if (o.early !== undefined) n.early = !!o.early
        if (o.kind === "note" || o.kind === "event") if (i.kind === "note" || i.kind === "event") n.kind = o.kind
        // A move: a recurring holiday moves in every year by the same number of days.
        if (o.k !== undefined && num(o.k) != null && num(o.from) != null) n.k = i.k + (num(o.k) - num(o.from))
        else if (o.k !== undefined && num(o.k) != null) n.k = num(o.k)
        return n
      })
    }
  }
  return out.filter(i => num(i.k) != null).sort((a, b) => a.k - b.k)
}
