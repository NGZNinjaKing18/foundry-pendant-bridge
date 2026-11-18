// ──────────────────────────────────────────────────────────────
// Session Over — pure parts (tests/session-over.test.mjs).
//
// RealmScreen works the panel out (pendant-home lib/sessionOver.mjs `sessionOverView`) and
// sends it; Foundry only draws it (scripts/session-over.js). What lives here:
//   · forPlayer   — belt and braces: whatever RealmScreen sent as the players' copy, cut it
//                   again to what a player may see (Public lines only, no rations, no
//                   worked-out-vs-edited flags, no left-off items). A player's whisper is
//                   only ever written from this.
//   · dayBlocks   — the recap as drawn: one block per in-world day, "‹date› – day N" above
//                   its first line (players: Public lines only, empty days dropped).
//   · stripOf / lapseOf — the route strip (same drawing rules as the app's) and the little
//                   time-lapse: a party dot walks the strip, waiting at each stay for its days.
//   · mapOf / lapsePlan / lapseAt — the map box: RealmScreen's cropped World Map picture round the
//                   route (allow-listed), and the group token's walk over it with the "N days" boxes.
//   · rationMembers / findActorFor — who the rations come from (attendees with a Foundry actor).
//   · recipientsOf — which Foundry users get the players' copy (that campaign's players only).
//   · money helpers — the app's own parse / label (lib/sessionOver.mjs), copied.
// ──────────────────────────────────────────────────────────────

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const arr = (v) => (Array.isArray(v) ? v : [])
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v))
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
export const fmt = (n) => (Number.isFinite(Number(n)) ? String(Math.round(Number(n) * 10) / 10) : "0")
export const plural = (n, w) => `${fmt(n)} ${w}${Number(n) === 1 ? "" : "s"}`

// ── money (lib/sessionOver.mjs) ───────────────────────────────
export const COINS = ["pp", "gp", "ep", "sp", "cp"]
const COIN_WORD = { pp: "pp", platinum: "pp", gp: "gp", gold: "gp", g: "gp", ep: "ep", electrum: "ep", sp: "sp", silver: "sp", s: "sp", cp: "cp", copper: "cp", bronze: "cp", c: "cp", b: "cp" }
const MONEY_RE = /(\d[\d,]*(?:\.\d+)?)\s*(platinum|gold|electrum|silver|copper|bronze|pp|gp|ep|sp|cp|g|s|c|b)\b/gi
/** "40 gold and 5 sp" → { gp: 40, sp: 5 } */
export function parseMoney(text) {
  const out = {}
  for (const m of String(text || "").matchAll(MONEY_RE)) {
    const coin = COIN_WORD[m[2].toLowerCase()]
    const n = Number(m[1].replace(/,/g, ""))
    if (coin && Number.isFinite(n) && n > 0) out[coin] = (out[coin] || 0) + n
  }
  return out
}
export const moneyLabel = (m) => COINS.filter(c => m && m[c]).map(c => `${m[c]} ${c}`).join(" · ")

// ── privacy ───────────────────────────────────────────────────
const plainNum = (o) => ({ value: num(o && typeof o === "object" ? o.value : o) })
const coins = (m) => { const o = {}; for (const c of COINS) { const n = num(m && m[c]); if (n > 0) o[c] = n } return o }

/**
 * What a PLAYER may see — built field by field from an allow-list (never "copy all, delete some"),
 * so anything RealmScreen adds to the GM view later stays GM-only until it's listed here.
 * Accepts the GM view or RealmScreen's own players' copy; both come out the same.
 */
export function forPlayer(view) {
  if (!view || typeof view !== "object") return null
  const st = view.stats || {}, aw = view.awarded || {}, rt = view.route || {}
  const leg = (l) => {
    const o = { id: str(l.id), kind: l.kind === "travel" ? "travel" : "stay", days: num(l.days) }
    for (const k of ["place", "from", "to", "mapId"]) if (l[k] != null) o[k] = str(l[k])
    for (const k of ["x", "y", "x2", "y2"]) if (Number.isFinite(l[k])) o[k] = l[k]
    return o
  }
  return {
    v: view.v ?? 1, sessionId: str(view.sessionId), number: Number.isFinite(view.number) ? view.number : null,
    title: str(view.title), campaignId: view.campaignId ? str(view.campaignId) : null,
    campaignName: str(view.campaignName), campaignColor: view.campaignColor ? str(view.campaignColor) : null,
    endedAt: view.endedAt || null, start: view.start || null, end: view.end || null,
    party: arr(view.party).filter(Boolean).map(p => ({
      key: str(p.key), name: str(p.name), attended: p.attended !== false,
      ...(p.discordAvatar ? { discordAvatar: str(p.discordAvatar) } : {}), ...(p.actorId ? { actorId: str(p.actorId) } : {}),
    })),
    stats: { days: plainNum(st.days), rolls: plainNum(st.rolls), nat20: plainNum(st.nat20), nat1: plainNum(st.nat1) },
    awarded: {
      training: { value: num(aw.training && aw.training.value), to: arr(aw.training && aw.training.to).map(str) },
      money: { value: coins(aw.money && aw.money.value) },
      misc: arr(aw.misc).filter(Boolean).map(it => ({ id: str(it.id), name: str(it.name), ...(num(it.qty) > 1 ? { qty: num(it.qty) } : {}), to: str(it.to), ...(it.img ? { img: str(it.img) } : {}) })),
    },
    route: { legs: arr(rt.legs).filter(Boolean).map(leg), days: num(rt.days), travelled: num(rt.travelled), ...(mapOf(rt.map) ? { map: mapOf(rt.map) } : {}) },
    recap: arr(view.recap).filter(Boolean).map(g => ({
      dayKey: g.dayKey ?? null, n: g.n ?? null, header: str(g.header),
      // (RealmScreen's players' copy has no `vis` — it only holds Public lines; the GM view does)
      rows: arr(g.rows).filter(r => r && (r.vis == null || r.vis === "public")).map(r => ({ id: str(r.id), text: str(r.text), who: str(r.who) })),
    })).filter(g => g.rows.length),
    met: arr(view.met).filter(Boolean).map(m => ({ id: str(m.id), name: str(m.name) })),
  }
}

/**
 * The map box's picture (RealmScreen crops the World Map round the route and uploads it): the same stops
 * as the legs, in the picture's frame (x, y 0..1). Allow-listed field by field; anything odd → no map
 * (the window falls back to the strip). The party lived this route, so players get it too.
 */
export function mapOf(m) {
  if (!m || typeof m !== "object" || typeof m.src !== "string" || !m.src) return null
  if (/^\s*javascript:/i.test(m.src)) return null
  const stops = arr(m.stops).filter(s => s && Number.isFinite(s.x) && Number.isFinite(s.y)).map(s => ({
    x: Math.min(1.5, Math.max(-0.5, s.x)), y: Math.min(1.5, Math.max(-0.5, s.y)), label: str(s.label), stay: !!s.stay, days: num(s.days),
    ...(s.leg != null ? { leg: num(s.leg) } : {}),
  }))
  if (!stops.length) return null
  const aspect = num(m.aspect) > 0.2 && num(m.aspect) < 5 ? num(m.aspect) : 1.6
  return { src: m.src, aspect, stops, ...(typeof m.token === "string" && m.token ? { token: m.token } : {}) }
}

// ── the map time-lapse (pendant-home lib/sessionOverMap.mjs lapsePlan / lapseAt / stayCount — keep the same) ──
/** The token's walk: a leg takes its days, a stay holds for its days, squeezed into min..max s, then a rest.
 *  → { dur, rest, steps: [{ kind:'move', from, to, t0, t1 } | { kind:'stay', at, days, t0, t1 }] } */
export function lapsePlan(stops, { secPerDay = 0.7, min = 3, max = 12, rest = 1.6, floor = 0.35 } = {}) {
  const S = arr(stops)
  const raw = []
  if (S.length && S[0].stay) raw.push({ kind: "stay", at: 0, days: num(S[0].days), w: Math.max(floor, num(S[0].days)) })
  for (let i = 1; i < S.length; i++) {
    raw.push({ kind: "move", from: i - 1, to: i, w: Math.max(floor, num(S[i].leg) || 0.5) })
    if (S[i].stay) raw.push({ kind: "stay", at: i, days: num(S[i].days), w: Math.max(floor, num(S[i].days)) })
  }
  const days = raw.reduce((n, s) => n + s.w, 0)
  if (!raw.length || !(days > 0)) return { dur: 0, rest: 0, steps: [] }
  const run = Math.min(max, Math.max(min, days * secPerDay))
  const k = run / days
  let t = 0
  const steps = raw.map(({ w, ...s }) => { const t0 = t; t += w * k; return { ...s, t0: r3(t0), t1: r3(t) } })
  steps[steps.length - 1].t1 = r3(run)
  return { dur: r3(run + rest), rest, steps }
}
/** A stay box's number while it counts up: 1…N (halves kept), the full number once done. */
export function stayCount(days, f) {
  const d = num(days)
  if (f >= 1 || d <= 1) return d
  return Math.min(d, Math.max(1, Math.ceil(Math.max(0, f) * d * 2) / 2))
}
/** Where the token is at t seconds + the stay boxes to show. → { x, y, boxes: [{ at, days, live }] } */
export function lapseAt(plan, stops, t) {
  const S = arr(stops)
  const boxes = []
  if (!S.length) return { x: 0, y: 0, boxes }
  let x = S[0].x, y = S[0].y
  const steps = (plan && plan.steps) || []
  const end = !steps.length || t >= steps[steps.length - 1].t1
  for (const s of steps) {
    if (t < s.t0) break
    const f = s.t1 > s.t0 ? Math.min(1, (t - s.t0) / (s.t1 - s.t0)) : 1
    if (s.kind === "move") { const a = S[s.from], b = S[s.to]; x = a.x + (b.x - a.x) * f; y = a.y + (b.y - a.y) * f }
    else { x = S[s.at].x; y = S[s.at].y; if (s.days > 0) boxes.push({ at: s.at, days: stayCount(s.days, f), live: f < 1 }) }
  }
  if (end) { const last = S[S.length - 1]; x = last.x; y = last.y }
  return { x, y, boxes }
}

// ── the recap ─────────────────────────────────────────────────
/** → [{ key, header, rows }] — a block per in-world day (players: Public lines only; empty days dropped). */
export function dayBlocks(recap, { gm = false } = {}) {
  const out = []
  for (const [i, g] of arr(recap).entries()) {
    const rows = arr(g && g.rows).filter(r => r && (gm || r.vis == null || r.vis === "public"))
    if (!rows.length) continue
    out.push({ key: g.dayKey != null ? String(g.dayKey) : `u${i}`, header: str(g.header), rows })
  }
  return out
}

// ── the route strip + time-lapse ──────────────────────────────
const r1 = (n) => Math.round(n * 10) / 10
const r3 = (n) => Math.round(n * 1000) / 1000
/**
 * Stops along the legs, placed where they are on the map when every stop knows (x, y map
 * fractions), else in a row. Same rules as the app's RouteStrip. → { pts, W, H }
 * pts: [{ x, y, label, stay, days?, leg? }] in strip pixels; `leg` = the days of the leg INTO it.
 */
export function stripOf(legs, { W = 320, H = 150, P = 18 } = {}) {
  const pts = []
  for (const l of arr(legs)) {
    if (!l) continue
    if (l.kind === "stay") {
      const last = pts[pts.length - 1], label = str(l.place) || "camp"
      // arrived here and stayed: one stop (the app draws two dots for it in a row layout)
      if (last && !last.stay && last.label === label) { last.stay = true; last.days = num(l.days); continue }
      pts.push({ mx: l.x, my: l.y, label, days: num(l.days), stay: true })
    }
    else {
      if (!pts.length || pts[pts.length - 1].label !== str(l.from)) pts.push({ mx: l.x, my: l.y, label: str(l.from), stay: false })
      pts.push({ mx: l.x2, my: l.y2, label: str(l.to), stay: false, leg: num(l.days) })
    }
  }
  const placed = pts.length > 0 && pts.every(p => Number.isFinite(p.mx) && Number.isFinite(p.my))
  if (placed) {
    const xs = pts.map(p => p.mx), ys = pts.map(p => p.my)
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    const s = Math.min((W - 2 * P) / Math.max(1e-6, x1 - x0), (H - 2 * P) / Math.max(1e-6, y1 - y0))
    const ox = (W - (x1 - x0) * s) / 2, oy = (H - (y1 - y0) * s) / 2
    for (const p of pts) { p.x = r1(ox + (p.mx - x0) * s); p.y = r1(oy + (p.my - y0) * s) }
  } else {
    pts.forEach((p, i) => { p.x = r1(P + (pts.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (pts.length - 1))); p.y = H / 2 })
  }
  return { W, H, pts: pts.map(({ mx: _x, my: _y, ...p }) => p) }
}

/**
 * The time-lapse: the party dot walks the strip's line, a leg taking its days, a stay holding
 * for its days (a 0-day leg or stop still gets a moment), then rests at the end before it loops.
 * → null (nothing to walk) | { keyPoints, keyTimes, dur }   (SVG animateMotion, calcMode linear)
 */
export function lapseOf(pts, { secPerDay = 0.6, min = 3, max = 12, tail = 0.15 } = {}) {
  const P = arr(pts)
  if (P.length < 2) return null
  const lens = [0]
  for (let i = 1; i < P.length; i++) lens.push(lens[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y))
  const total = lens[lens.length - 1]
  if (!(total > 0)) return null
  const steps = []                                   // { at, t } = wait there · { to, t } = walk there
  const hold = (i, d) => steps.push({ at: lens[i] / total, t: Math.max(0.25, num(d)) })
  if (P[0].stay) hold(0, P[0].days)
  for (let i = 1; i < P.length; i++) {
    steps.push({ to: lens[i] / total, t: Math.max(0.25, num(P[i].leg) || (P[i].stay ? 0.25 : 0.5)) })
    if (P[i].stay) hold(i, P[i].days)
  }
  const days = steps.reduce((n, s) => n + s.t, 0)
  const run = days / (1 - tail)
  const keyPoints = [0], keyTimes = [0]
  let t = 0
  for (const s of steps) {
    t += s.t
    keyPoints.push(r3(s.to != null ? s.to : s.at)); keyTimes.push(r3(t / run))
  }
  keyPoints.push(1); keyTimes.push(1)               // rest at the end, then loop
  for (let i = 1; i < keyTimes.length; i++) if (keyTimes[i] < keyTimes[i - 1]) keyTimes[i] = keyTimes[i - 1]
  return { keyPoints, keyTimes, dur: Math.round(Math.min(max, Math.max(min, days * secPerDay)) * 10) / 10 }
}

// ── rations ───────────────────────────────────────────────────
const lc = (s) => str(s).trim().toLowerCase().replace(/\s+/g, " ")
/** The Foundry actor for a party member: the one RealmScreen linked (actorId), else the ONE
 *  person-actor with exactly their name (the app-wide identity rule; two of them → nobody). */
export function findActorFor(p, actors) {
  const list = arr(actors)
  if (p && p.actorId) { const a = list.find(x => x && (x.id ?? x._id) === p.actorId); if (a) return a }
  const n = lc(p && p.name)
  if (!n) return null
  const same = list.filter(a => a && a.type !== "group" && a.type !== "vehicle" && lc(a.name) === n)
  return same.length === 1 ? same[0] : null
}

/** Who the rations come from: everyone who came, with their actor's ration stacks.
 *  → { members: [{ id, name, key, stacks }], missing: [name] } */
export function rationMembers(party, actors, stacksOf) {
  const members = [], missing = [], seen = new Set()
  for (const p of arr(party)) {
    if (!p || p.attended === false) continue
    const a = findActorFor(p, actors)
    if (!a) { missing.push(str(p.name) || str(p.key)); continue }
    const id = a.id ?? a._id
    if (seen.has(id)) continue
    seen.add(id)
    members.push({ id, name: str(p.name) || str(a.name), key: str(p.key), stacks: stacksOf(a.items) })
  }
  return { members, missing }
}

/** The −/+ number: whole, ≥ 0. */
export const rationN = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0 }

// ── who gets the players' copy ────────────────────────────────
/** That campaign's players (Foundry user ids from RealmScreen's roster), never a GM, never anyone else. */
export function recipientsOf(roster, campaignId, users) {
  const c = arr(roster && roster.campaigns).find(x => x && x.id && x.id === campaignId)
  if (!c) return []
  const ok = new Map(arr(users).filter(Boolean).map(u => [u.id, u]))
  return [...new Set(arr(c.users))].filter(id => ok.has(id) && !ok.get(id).isGM)
}

/** What a GM's whisper may ask the linked window to pass on to RealmScreen (session-over.js passOp). */
export const SO_OPS = ["get", "update", "closed"]
export const opAllowed = (kind) => SO_OPS.includes(kind)
