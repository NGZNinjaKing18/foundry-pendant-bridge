// ──────────────────────────────────────────────────────────────
// Private delivery — who gets to see what, enforced by Foundry's SERVER.
//
// World settings and module socket messages reach every client, so anything put
// there can be read from any player's console. The one thing Foundry's server
// filters per user is a whispered ChatMessage. So everything campaign-private
// travels as hidden, flagged whispers (never drawn in the chat log):
//
//   • slices — the linked GM window keeps RealmScreen's full roster + pages in
//     memory and writes ONE message per player, whispered to that player only,
//     holding just their part (`rosterFor`, `pageFor`: their campaigns, the
//     secrets they may see, no questions from others, no "not found yet"
//     findings, no hidden people, no GM settings). GMs get the full copy in a
//     message whispered to GMs. Updated in place; a player with nothing left
//     has theirs deleted.
//   • ops — what a player does on the page (or "Yes, start session") is a
//     whisper TO the GMs. Foundry stamps its real author, so nobody can act as
//     someone else (or as a GM); the linked GM window passes it to RealmScreen
//     and deletes it. Ops waiting while no GM was linked are picked up later.
//   • notes — RealmScreen's answers to one player are a whisper to that player
//     (shown as a notification, deleted by the GM window soon after).
//
// GMs can read every whisper anyway, which is fine: they're the GM.
// ──────────────────────────────────────────────────────────────

import { linkedHere } from "./live.js"

const MOD = "pendant-bridge"
const str = (v) => (typeof v === "string" ? v.trim() : "")
const arr = (v) => (Array.isArray(v) ? v : [])
const flagsOf = (m) => m?.flags?.[MOD] || {}
const OP_TTL = 24 * 3600 * 1000      // an op older than a day is dropped, not replayed

// ── pure: each player's part (tests/private.test.mjs) ─────────
/** The roster as one player may know it: only their campaigns; another campaign's
 *  running session is just "something else is running". */
export function rosterFor(roster, uid) {
  const list = arr(roster?.campaigns).filter(c => c && str(c.id) && arr(c.users).includes(uid))
    .map(c => ({ id: str(c.id), name: str(c.name) || "Campaign", users: [uid] }))
  const a = roster?.active && str(roster.active.id) ? roster.active : null
  return { active: a ? (list.some(c => c.id === str(a.id)) ? { id: str(a.id), name: str(a.name) } : { id: "_other", name: "" }) : null, campaigns: list }
}

/** May this player see this secret? (RealmScreen's canSee — the same rule.) */
export function canSeeSecret(s, uid, party) {
  if (s?.state !== "given") return false
  if (arr(s.to).includes(uid)) return true
  return (!!s.revealed || arr(s.shown).length > 0) && arr(party).includes(uid)
}

/** One campaign page as one player may see it, or null if they aren't in it. */
export function pageFor(page, uid) {
  if (!page || !arr(page.users).includes(uid)) return null
  const o = page.overview || {}
  const prefs = page.peoplePrefs || {}
  return {
    overview: { ...o, people: arr(o.people).filter(p => p && !p.hidden).map(({ hidden, manual, ...p }) => p) },
    users: [uid],
    secrets: arr(page.secrets).filter(s => canSeeSecret(s, uid, page.users)).map(s => {
      const mine = arr(s.to).includes(uid)
      const { when, how, ...rest } = s
      return { ...rest, to: mine ? arr(s.to) : [], toNames: mine ? s.toNames || {} : {}, seen: arr(s.seen).includes(uid) ? [uid] : [] }
    }),
    asks: [],
    goals: arr(page.goals),
    info: arr(page.info),
    finds: arr(page.finds).filter(f => f && !f.hidden),
    peoplePrefs: { hidden: [], pinned: [], notes: {}, recent: !!prefs.recent },
    ptick: !!page.ptick,
    group: page.group ? { actorId: page.group.actorId, name: page.group.name } : null,
  }
}

/** Every slice to write: { gm: full, [userId]: theirs } (players with nothing are left out). */
export function slicesOf(full, playerIds) {
  const out = { gm: { roster: full.roster || null, pages: full.pages || {} } }
  for (const uid of playerIds) {
    const pages = {}
    for (const [cid, p] of Object.entries(full.pages || {})) { const x = pageFor(p, uid); if (x) pages[cid] = x }
    const roster = rosterFor(full.roster, uid)
    if (Object.keys(pages).length || roster.campaigns.length || roster.active) out[uid] = { roster, pages }
  }
  return out
}

// ── reading my slice ──────────────────────────────────────────
let cache = null
function sliceMsg(key) { return game.messages?.find(m => flagsOf(m).slice?.key === key) || null }
/** What this user may see: { roster, pages } (empty when nothing was sent). */
export function mySlice() {
  if (cache) return cache
  const key = game.user?.isGM ? "gm" : game.user?.id
  try { cache = JSON.parse(flagsOf(sliceMsg(key)).slice?.json || "null") } catch { cache = null }
  cache ||= { roster: null, pages: {} }
  return cache
}
const listeners = new Set()
/** Run `fn` whenever this user's slice changes. */
export function onSlice(fn) { listeners.add(fn) }

// ── writing the slices (the linked GM window) ─────────────────
const full = { roster: null, pages: null }
const written = new Map()            // key → json last written
/** RealmScreen sent part of the full picture (`roster` or `pages`). */
export function setFull(part, value) { full[part] = value; schedule() }
export const fullPages = () => full.pages || mySlice().pages || {}
let pubT = 0, busy = false, again = false
function schedule() { clearTimeout(pubT); pubT = setTimeout(publish, 150) }
const gmIds = () => (game.users?.filter(u => u.isGM) ?? []).map(u => u.id)

async function publish() {
  if (!game.user?.isGM || !linkedHere()) return
  if (busy) { again = true; return }
  busy = true
  try {
    if (!full.roster || !full.pages) {   // half the picture: fill from what GMs last had
      const had = (() => { try { return JSON.parse(flagsOf(sliceMsg("gm")).slice?.json || "null") } catch { return null } })()
      full.roster ??= had?.roster ?? null
      full.pages ??= had?.pages ?? {}
    }
    const players = (game.users?.filter(u => !u.isGM) ?? []).map(u => u.id)
    const want = slicesOf(full, players)
    for (const [key, data] of Object.entries(want)) {
      const json = JSON.stringify(data)
      const msg = sliceMsg(key)
      if (msg && (written.get(key) === json || flagsOf(msg).slice?.json === json)) { written.set(key, json); continue }
      const whisper = key === "gm" ? gmIds() : [key]
      if (msg) await msg.update({ whisper, [`flags.${MOD}.slice.json`]: json })
      else await ChatMessage.create({ speaker: { alias: "Campaign" }, content: "", whisper, flags: { [MOD]: { hidden: true, slice: { key, json } } } })
      written.set(key, json)
    }
    // A player who isn't in anything any more loses their slice.
    for (const m of game.messages?.filter(m => flagsOf(m).slice && !(flagsOf(m).slice.key in want)) ?? []) await m.delete()
  } catch (e) { console.warn(`${MOD} | private slices`, e) } finally {
    busy = false
    if (again) { again = false; schedule() }
  }
}

// ── ops: a player's action → the GMs (author stamped by Foundry) ─
let passer = null      // (type, data, userId) => bool — campaigns.js, linked GM window
export function setOpPasser(fn) { passer = typeof fn === "function" ? fn : null }
/** Send an action to RealmScreen as this user. */
export async function sendOp(type, data) {
  if (game.user?.isGM && linkedHere() && passer) return passer(type, data, game.user.id)
  await ChatMessage.create({ speaker: { alias: "Campaign" }, content: "", whisper: gmIds(), flags: { [MOD]: { hidden: true, op: { type, data } } } })
  return true
}
async function handleOp(m) {
  if (!game.user?.isGM || !linkedHere() || !passer) return
  const op = flagsOf(m).op
  const author = m.author ?? game.users?.get(m.user)
  if (op && author && Date.now() - (m.timestamp || 0) < OP_TTL) passer(str(op.type), op.data, author.id)
  try { await m.delete() } catch { /* another GM got it */ }
}
/** Pick up ops sent while no GM window was linked. */
export function drainOps() {
  for (const m of game.messages?.filter(m => flagsOf(m).op) ?? []) handleOp(m)
}

// ── notes: RealmScreen → one player (or a few) ─────────────────
export async function noteTo(ids, text, level = "info") {
  const to = [...new Set(arr(ids).filter(id => game.users?.get(id)))]
  if (!str(text) || !to.length) return { ok: false }
  if (to.includes(game.user?.id)) { ui.notifications?.[level === "warn" ? "warn" : "info"](text); Hooks.callAll("pendantBridgeNote", { level, text }) }
  const others = to.filter(id => id !== game.user?.id && !game.users.get(id)?.isGM)
  if (others.length) {
    const m = await ChatMessage.create({ speaker: { alias: "Campaign" }, content: "", whisper: others, flags: { [MOD]: { hidden: true, note: { text: str(text), level } } } })
    setTimeout(() => m?.delete?.().catch?.(() => {}), 20000)
  }
  return { ok: true }
}

// ── hooks ─────────────────────────────────────────────────────
const isOurs = (m) => !!flagsOf(m).hidden
function hide(m, html) {
  if (!isOurs(m)) return
  const el = html instanceof HTMLElement ? html : html?.[0]
  if (el) { el.style.display = "none"; el.classList.add("pb-hidden-msg") }
}
Hooks.on("renderChatMessageHTML", hide)     // V13+
Hooks.on("renderChatMessage", hide)         // V11/V12
function changed(m) {
  const f = flagsOf(m)
  if (f.slice) { cache = null; for (const fn of listeners) { try { fn() } catch (e) { console.warn(e) } } }
  return f
}
Hooks.on("createChatMessage", (m) => {
  const f = changed(m)
  if (f.op) handleOp(m)
  if (f.note && arr(m.whisper).includes(game.user?.id) && (m.author ?? game.users?.get(m.user))?.isGM) {
    ui.notifications?.[f.note.level === "warn" ? "warn" : "info"](f.note.text)
    Hooks.callAll("pendantBridgeNote", { level: f.note.level, text: f.note.text })      // the page drops what it showed ahead
  }
})
Hooks.on("updateChatMessage", (m) => { changed(m) })
Hooks.on("deleteChatMessage", (m) => { changed(m) })
Hooks.on("pendantBridgeLive", () => { if (linkedHere()) { drainOps(); schedule() } })
Hooks.once("ready", () => {
  if (!game.user?.isGM) return
  setTimeout(() => { if (linkedHere()) drainOps() }, 3000)
  // The old shared settings held everything for everyone — empty them.
  try {
    if (game.settings.get(MOD, "campaignPages") && Object.keys(game.settings.get(MOD, "campaignPages")).length) game.settings.set(MOD, "campaignPages", {})
    if (game.settings.get(MOD, "campaigns")) game.settings.set(MOD, "campaigns", null)
  } catch { /* not registered */ }
})
