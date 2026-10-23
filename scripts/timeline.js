// ──────────────────────────────────────────────────────────────
// RealmScreen chronicle → the "⏳ Timeline Builder" module (id `timeline-builder`).
//
// RealmScreen builds whole timelines (its world history, each campaign's games) and sends them
// with `timeline.apply`. Timeline Builder keeps ALL its data in one world setting
// (`timeline-builder.data`, an array of timelines → entries) and rewrites the whole array on
// every change, so this file does the same: read, merge in memory, one `game.settings.set`.
//
// What is ours: every timeline and entry RealmScreen made carries a `realm` stamp
// ({ feed } / { key, day, hash }). Timeline Builder keeps unknown keys on every path. Anything
// without a stamp is the GM's own and is never touched.
//
// The merge (pure — tests/timeline.test.mjs):
//   · our timeline missing   → created, unless RealmScreen says it synced it before (`known`):
//                              then the GM deleted it, and it stays deleted (reported).
//   · our timeline present   → its name, look and "players see it" stay the GM's; only its
//                              entries and the date settings (free text, no auto-sort) are ours.
//   · our entry, unchanged   → replaced by the new one.
//   · our entry, GM-edited   → kept as the GM left it (its fields no longer hash to its stamp),
//                              reported as skipped. Only OUR fields are hashed: Timeline Builder
//                              saves display extras (displayColor, tags…) into its data.
//   · our entry, gone from what RealmScreen sends → removed, unless GM-edited.
//   · our entry, missing here but sent → (re-)added. A drag in an out-of-date Manager window
//                              can drop entries; that is never read as "the GM deleted it".
//   · the GM's own entries in our timeline → kept, right after the entry they followed.
//   · order: RealmScreen's; `sort` is renumbered from the final order.
//
// Only the ONE writing client applies (an active GM with settings rights, lowest id wins — the
// relay sends every command to every Foundry tab). Everyone else stays silent.
// ──────────────────────────────────────────────────────────────

export const TB = "timeline-builder"

// ── pure ──
// cyrb53, as RealmScreen's lib/foundryTimelineModel.mjs: the same hash on both sides.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}
const b36 = (n, len) => n.toString(36).padStart(len, "0").slice(-len)
export const entryHash = (e) => b36(cyrb53(JSON.stringify([e.name, e.period, e.description, e.color, e.img])), 9)

const clone = (v) => JSON.parse(JSON.stringify(v ?? null))
const ours = (x) => !!(x && x.realm && typeof x.realm === "object")
const isEdited = (e) => ours(e) && e.realm.hash && entryHash(e) !== e.realm.hash

/** Merge one incoming timeline into the existing one (both plain objects). → { timeline, skipped } */
export function mergeTimeline(existing, incoming) {
  const skipped = []
  const byKey = new Map()
  for (const e of existing.entries || []) if (ours(e)) byKey.set(e.realm.key, e)
  // The GM's own entries, each anchored to the entry before it (null = at the start).
  const anchored = new Map()
  let prev = null
  for (const e of existing.entries || []) {
    if (ours(e)) { prev = e.realm.key; continue }
    if (!anchored.has(prev)) anchored.set(prev, [])
    anchored.get(prev).push(e)
  }
  const out = [...(anchored.get(null) || [])]
  const sent = new Set()
  for (const inc of incoming.entries || []) {
    const key = inc.realm && inc.realm.key
    if (!key) continue
    sent.add(key)
    const old = byKey.get(key)
    if (old && isEdited(old)) { out.push(old); skipped.push({ key, why: "edited-in-foundry" }) }
    else out.push(clone(inc))
    for (const g of anchored.get(key) || []) out.push(g)
  }
  // Ours no longer sent: dropped, unless the GM edited it (then it stays, at the end).
  for (const [key, old] of byKey) {
    if (sent.has(key)) continue
    if (isEdited(old)) { out.push(old); skipped.push({ key, why: "edited-in-foundry" }) }
    for (const g of anchored.get(key) || []) out.push(g)
  }
  out.forEach((e, i) => { e.sort = i })
  return {
    timeline: { ...existing, timeframeMode: "free", autoSort: false, realm: clone(incoming.realm), entries: out },
    skipped,
  }
}

/**
 * The whole setting after an apply. `data`: the current array (never mutated).
 * `incoming`: RealmScreen's timelines. `known`: ids RealmScreen synced before. `remove`: feeds to take out.
 * → { data, created, updated, removed, deletedByGm, skipped }
 */
export function applyTimelines(data, incoming = [], { known = [], remove = [] } = {}) {
  const next = clone(Array.isArray(data) ? data : [])
  const res = { created: [], updated: [], removed: [], deletedByGm: [], skipped: [] }
  const knownIds = new Set(known)
  for (const inc of incoming) {
    if (!inc || !inc.id || !ours(inc)) continue
    const i = next.findIndex(t => t && t.id === inc.id)
    if (i < 0) {
      if (knownIds.has(inc.id)) { res.deletedByGm.push(inc.realm.feed); continue }
      const t = clone(inc)
      t.entries = (t.entries || []).map((e, n) => ({ ...e, sort: n }))
      next.push(t)
      res.created.push(inc.realm.feed)
      continue
    }
    const { timeline, skipped } = mergeTimeline(next[i], inc)
    next[i] = timeline
    res.updated.push(inc.realm.feed)
    for (const s of skipped) res.skipped.push({ feed: inc.realm.feed, ...s })
  }
  const drop = new Set(remove)
  if (drop.size) {
    for (let i = next.length - 1; i >= 0; i--) {
      const t = next[i]
      if (ours(t) && drop.has(t.realm.feed)) { res.removed.push(t.realm.feed); next.splice(i, 1) }
    }
  }
  return { data: next, ...res }
}

/** What RealmScreen needs to know about our timelines. */
export const summarize = (data) => (Array.isArray(data) ? data : []).filter(ours).map(t => ({
  id: t.id, feed: t.realm.feed, name: t.name, visible: !!t.visible,
  entries: (t.entries || []).length, edited: (t.entries || []).filter(isEdited).length,
}))

// ── Foundry ──
const mod = () => (typeof game !== "undefined" ? game.modules.get(TB) : null)
const readData = () => { try { return game.settings.get(TB, "data") || [] } catch { return [] } }

/** The ONE client that writes: an active GM who may change settings, lowest id wins. */
export function isTimelineWriter() {
  try {
    const me = game.user
    if (!me || !me.isGM || !me.can("SETTINGS_MODIFY")) return false
    const gms = game.users.filter(u => u.active && u.isGM && u.can("SETTINGS_MODIFY"))
    return !gms.length || gms.reduce((a, b) => (String(a.id) <= String(b.id) ? a : b)).id === me.id
  } catch { return false }
}

export function timelineStatus() {
  const m = mod()
  return {
    installed: !!m, active: !!m?.active, version: m?.version || null,
    writer: isTimelineWriter(),
    timelines: m?.active ? summarize(readData()) : [],
  }
}

function needWriter() {
  const m = mod()
  if (!m) throw new Error("Timeline Builder isn't installed in this world")
  if (!m.active) throw new Error("Timeline Builder is installed but not turned on in this world")
}

let writing = Promise.resolve()
/** { timelines, known, remove } → summary. Queued, so two applies never interleave. */
export function applyFromRealm(msg) {
  needWriter()
  const run = async () => {
    const before = readData()
    const r = applyTimelines(before, Array.isArray(msg.timelines) ? msg.timelines : [], { known: msg.known || [], remove: msg.remove || [] })
    await game.settings.set(TB, "data", r.data, { realmBridge: true })
    // Verify: what is stored now must hold every timeline we wrote (a GM click can race us).
    const after = summarize(readData())
    const missing = r.data.filter(t => ours(t) && !after.some(a => a.id === t.id)).map(t => t.realm.feed)
    const { data, ...rest } = r
    return { ...rest, missing, timelines: after }
  }
  const p = writing.then(run, run)
  writing = p.catch(() => {})
  return p
}

/** { feed, reveal } → Timeline Builder opens that timeline on every player's screen. */
export async function broadcastFromRealm(msg) {
  needWriter()
  const data = clone(readData())
  const t = data.find(x => ours(x) && x.realm.feed === msg.feed)
  if (!t) throw new Error("That chronicle isn't in Foundry yet — sync first")
  if (!t.visible) {
    if (!msg.reveal) return { ok: false, hidden: true }
    t.visible = true
    await game.settings.set(TB, "data", data, { realmBridge: true })
  }
  await game.settings.set(TB, "broadcast", { timelineId: t.id, timestamp: Date.now() })
  return { ok: true, id: t.id }
}
