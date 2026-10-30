// ──────────────────────────────────────────────────────────────
// The campaign page — what the Campaigns button's "View details" opens, and what
// opens by itself for a campaign's players when its session starts.
//
// RealmScreen sends `campaigns.pages` (lib/foundryCampaignPages.js); the GM window
// stores it in the world setting `pendant-bridge.campaignPages`, so every client
// draws the same thing:
//
//   { [campaignId]: { overview: { name, date, played, running, where, party, people, coming },
//                     users: [Foundry user id],        // who is in the campaign (incl. a linked group's)
//                     secrets, goals, info, finds, peoplePrefs, ptick, group } }
//
// Laid out like the dnd5e group sheet (header with emblem + cards, tabs): Overview (the
// party with HP / Hit Dice / AC / passives, open goals, newest findings, secrets, and
// People we've met with the GM's pin / hide / note / add), Goals (party + per-character
// goals with steps, information, Codex links, an Old drawer), Findings (drop items,
// actors, journals, pictures; "not found yet"; Old) and Secrets. A player sees what's
// theirs; a GM gets every control. Everything done here goes back to RealmScreen as one
// `campaign.page` op (campaigns.js relay → the linked GM window), which decides, saves
// and re-sends the pages; ticks show at once (an optimistic copy until the answer lands).
//
// A GM can link the page to a Foundry group token (dnd5e Group actor): its members are
// the party here, and the linked GM window reports their owners to RealmScreen
// (`group.members`) so they're the campaign's players while they're in the group.
//
// A secret that is a place on the map is a real Map Note: the linked GM window keeps
// a JournalEntry per such secret (folder "RealmScreen secrets") owned by exactly the
// people who know it, and a Note on its scene — so Foundry itself hides it from
// everyone else (`syncSecretNotes`).
// ──────────────────────────────────────────────────────────────

import { relay } from "./campaigns.js"
import { linkedHere } from "./live.js"
import { mySlice, onSlice, setFull, fullPages } from "./private.js"

const MOD = "pendant-bridge"
const KEY = "campaignPages"
const APP_ID = "pendant-bridge-campaign"
const FOLDER = "RealmScreen secrets"

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const escNl = (s) => esc(s).replace(/\n/g, "<br>")
const str = (v) => (typeof v === "string" ? v.trim() : "")
const arr = (v) => (Array.isArray(v) ? v : [])
const KIND_ICON = { note: "fa-feather", place: "fa-location-dot", page: "fa-book-open", pic: "fa-image" }
const KIND_NAME = { note: "Note", place: "Place on the map", page: "Page", pic: "Picture" }
const FIND_ICON = { item: "fa-gem", picture: "fa-image", note: "fa-feather", journal: "fa-book-open", actor: "fa-user" }
const FIND_NAME = { item: "Item", picture: "Picture", note: "Note", journal: "Journal", actor: "Character" }

// ── pure (tests/campaign-page.test.mjs) ───────────────────────
/** The secrets this user may see — RealmScreen's canSee, the same rule. */
export function visibleSecrets(page, userId, isGM) {
  const party = arr(page?.users)
  return arr(page?.secrets).filter(s => {
    if (isGM) return true
    if (s?.state !== "given") return false
    if (arr(s.to).includes(userId)) return true
    return (s.revealed || arr(s.shown).length > 0) && party.includes(userId)
  })
}

/** Given secrets this user hasn't opened yet (the dot on the tab). */
export const unseenFor = (page, userId) =>
  visibleSecrets(page, userId, false).filter(s => !arr(s.seen).includes(userId))

/** Who knows a place secret → the JournalEntry's ownership (GMs own everything anyway). */
export function noteViewers(secret, party) {
  if (secret?.state !== "given") return []
  const who = new Set(arr(secret.to))
  if (secret.revealed || arr(secret.shown).length) for (const u of arr(party)) who.add(u)
  return [...who]
}

/** A player's line for a secret: who else knows it. */
export function whoLine(s, me, nameOf = (id) => id) {
  const others = arr(s.to).filter(id => id !== me).map(nameOf)
  if (s.revealed) return "Revealed to the party"
  if (!arr(s.to).includes(me) && arr(s.shown).length) return `${s.shown[0].name || "Someone"} showed this to the party`
  if (arr(s.shown).length) return "The party knows this"
  return others.length ? `You and ${others.join(" & ")} know this` : "Only you know this"
}

// ── the pages: this user's own part only (scripts/private.js) ──
// A player's slice has just their campaigns, the secrets they may see, and no GM-only
// data; a GM's has everything. Nothing campaign-private is in a shared setting any more.
const readPages = () => mySlice().pages || {}

/** `campaigns.pages` (GM window): kept in memory, written out per player, Map Notes kept true. */
export async function setPages(pages) {
  if (!game.user?.isGM) throw new Error("Only the GM can set the campaign pages")
  const clean = pages && typeof pages === "object" ? pages : {}
  setFull("pages", clean)
  syncSecretNotes(clean).catch(e => console.warn(`${MOD} | secret notes`, e))
  reportGroups(clean)
  return { ok: true }
}

/** `campaigns.whisper`: a chat card to these users (and the GMs). */
export async function whisperCampaign({ to, title, text, campaignId } = {}) {
  const ids = new Set(arr(to).filter(id => game.users?.get(id)))
  for (const u of game.users ?? []) if (u.isGM) ids.add(u.id)
  if (!ids.size) return { ok: false }
  await ChatMessage.create({
    speaker: { alias: game.user?.name || "GM" },
    whisper: [...ids],
    content: `<div class="pb-secret-card"><h3><i class="fa-solid fa-key"></i> ${esc(title)}</h3>${text ? `<p>${escNl(text)}</p>` : ""}</div>`,
    flags: { [MOD]: { secretCard: true, campaignId: str(campaignId) || null } },
  })
  return { ok: true }
}

// ── secret Map Notes (linked GM window) ───────────────────────
let notesBusy = false, notesAgain = null
async function syncSecretNotes(pages) {
  if (!game.user?.isGM || !linkedHere()) return
  if (notesBusy) { notesAgain = pages; return }      // run again with the newest pages, never skip
  notesBusy = true
  try {
    const want = new Map()        // secretId → { s, viewers }
    for (const p of Object.values(pages || {})) {
      for (const s of arr(p?.secrets)) {
        if (s?.kind !== "place" || !s.place?.sceneId) continue
        const viewers = noteViewers(s, p.users)
        if (viewers.length) want.set(s.id, { s, viewers })
      }
    }
    const flagOf = (d) => d?.flags?.[MOD]?.secretId || null
    // Journal entries
    let folder = game.folders?.find(f => f.type === "JournalEntry" && f.flags?.[MOD]?.secretFolder)
    if (!folder && want.size) folder = await Folder.create({ name: FOLDER, type: "JournalEntry", flags: { [MOD]: { secretFolder: true } } })
    const entries = new Map(game.journal.filter(j => flagOf(j)).map(j => [flagOf(j), j]))
    for (const [id, j] of entries) if (!want.has(id)) await j.delete()
    for (const [id, { s, viewers }] of want) {
      // Exactly who knows it can see it: everyone else (who isn't a GM) is set back to none.
      const ownership = { default: 0, ...Object.fromEntries(viewers.map(u => [u, 2])) }
      const old = entries.get(id)?.ownership || {}
      for (const u of Object.keys(old)) if (u !== "default" && !viewers.includes(u) && !game.users?.get(u)?.isGM) ownership[u] = 0
      const viewKey = (o) => JSON.stringify(Object.entries(o || {}).filter(([u, v]) => u === "default" || (!game.users?.get(u)?.isGM && v > 0)).sort())
      const content = `<p>${escNl(s.text || "")}</p>`
      let j = entries.get(id)
      if (!j) {
        j = await JournalEntry.create({ name: `🗝 ${s.title}`, folder: folder?.id ?? null, ownership, flags: { [MOD]: { secretId: id } },
          pages: [{ name: s.title, type: "text", text: { content } }] })
      } else {
        const same = viewKey(j.ownership) === viewKey(ownership) && j.name === `🗝 ${s.title}` && j.pages.contents[0]?.text?.content === content
        if (!same) {
          await j.update({ name: `🗝 ${s.title}`, ownership })
          const pg = j.pages.contents[0]
          if (pg) await pg.update({ name: s.title, "text.content": content })
        }
      }
      want.get(id).entry = j
    }
    // Notes, on every scene
    for (const scene of game.scenes ?? []) {
      const mine = scene.notes.filter(n => flagOf(n))
      const drop = mine.filter(n => { const w = want.get(flagOf(n)); return !w || w.s.place.sceneId !== scene.id }).map(n => n.id)
      if (drop.length) await scene.deleteEmbeddedDocuments("Note", drop)
      const have = new Map(mine.filter(n => !drop.includes(n.id)).map(n => [flagOf(n), n]))
      const add = [], upd = []
      for (const [id, w] of want) {
        if (w.s.place.sceneId !== scene.id || !w.entry) continue
        const data = { x: Math.round(w.s.place.x), y: Math.round(w.s.place.y), entryId: w.entry.id, text: "", global: true,
          texture: { src: "icons/svg/mystery-man.svg" }, iconSize: 40, flags: { [MOD]: { secretId: id } } }
        const n = have.get(id)
        if (!n) add.push(data)
        else if (n.x !== data.x || n.y !== data.y || (n.text || "") !== data.text || n.entryId !== data.entryId) upd.push({ _id: n.id, x: data.x, y: data.y, text: data.text, entryId: data.entryId })
      }
      if (add.length) await scene.createEmbeddedDocuments("Note", add)
      if (upd.length) await scene.updateEmbeddedDocuments("Note", upd)
    }
  } finally {
    notesBusy = false
    if (notesAgain) { const next = notesAgain; notesAgain = null; syncSecretNotes(next) }
  }
}

// ── panning ───────────────────────────────────────────────────
async function panTo(sceneId, x, y, label) {
  if (canvas?.scene?.id !== sceneId) {
    const sc = game.scenes?.get(sceneId)
    if (!sc) return ui.notifications?.info(`It’s on a scene you can’t open.`)
    try { await sc.view() } catch { return ui.notifications?.info(`It’s on ${sc.name}.`) }
  }
  try { canvas.notes?.activate?.() } catch { /* no notes layer */ }
  canvas?.animatePan?.({ x, y, scale: Math.max(canvas.stage?.scale?.x || 1, 1) })
  if (label) ui.notifications?.info(label)
}
function partyToken(campaignId) {
  return canvas?.tokens?.placeables?.find(t => t.document?.flags?.[MOD]?.party?.campaignId === campaignId && t.visible) || null
}

// ── the linked group token (dnd5e Group actor) ────────────────
/** A group actor's member actors (dnd5e 4+: system.members = [{ actor }]; older: a Set of ids). */
export function groupMemberActors(group) {
  const m = group?.system?.members
  if (!m) return []
  const list = Array.isArray(m) ? m.map(x => x?.actor ?? x) : [...m].map(x => (typeof x === "string" ? game.actors?.get(x) : x?.actor ?? x))
  return list.filter(a => a && a.id)
}
/** The non-GM users EXPLICITLY made owner of any of these actors — they become the campaign's
 *  players. "All players: Owner" (default ownership) does not count: it would put everyone in. */
export const OWNER = 3
export function ownersOf(actors, users) {
  return arr(users).filter(u => !u.isGM && actors.some(a => Number(a?.ownership?.[u.id]) >= OWNER)).map(u => u.id)
}
/** One member's numbers, as the dnd5e group sheet shows them (missing → null). */
export function memberStats(a) {
  const s = a?.system || {}, at = s.attributes || {}, sk = s.skills || {}
  const pair = (x) => (x && Number.isFinite(Number(x.max)) && Number(x.max) > 0 ? [Number(x.value) || 0, Number(x.max)] : null)
  const pas = (k) => (Number.isFinite(Number(sk[k]?.passive)) ? Number(sk[k].passive) : null)
  return { hp: pair(at.hp), hd: pair(at.hd), ac: Number.isFinite(Number(at.ac?.value)) ? Number(at.ac.value) : null, prc: pas("prc"), ste: pas("ste"), sur: pas("sur") }
}
const linkedGroup = (page) => (page?.group?.actorId ? game.actors?.get(page.group.actorId) || null : null)

// The linked GM window tells RealmScreen who is in each linked group, whenever that changes.
const groupSig = new Map()
function reportGroups(pages = fullPages()) {
  if (!game.user?.isGM || !linkedHere()) return
  for (const [cid, p] of Object.entries(pages || {})) {
    const g = linkedGroup(p)
    if (!g) continue
    const actors = groupMemberActors(g)
    const users = ownersOf(actors, game.users?.contents ?? [...(game.users ?? [])])
    const members = actors.map(a => ({ id: a.id, name: a.name }))
    const sig = JSON.stringify([users, members])
    const sent = JSON.stringify([arr(p.group.users), arr(p.group.members).map(m => ({ id: m.id, name: m.name }))])
    if (sig === sent || groupSig.get(cid) === sig) continue
    groupSig.set(cid, sig)
    relay("campaign.page", { op: "group.members", campaignId: cid, actorId: g.id, users, members })
  }
}
let reportT = 0
const scheduleReport = () => { clearTimeout(reportT); reportT = setTimeout(() => reportGroups(), 600) }

// ── the theme ─────────────────────────────────────────────────
// Foundry themes windows with `.themed.theme-dark|light` (Settings › Core › Applications colour
// scheme). If this window wasn't given one, take the setting's, so its variables are the right
// tier; a campaign look (body.pb-look) then overrides those same variables. Empty setting = follow
// the browser, which Foundry handles on body — nothing to add.
function themeOf() {
  try { const c = game.settings.get("core", "uiConfig")?.colorScheme; return c?.applications || c?.interface || "" } catch { return "" }
}
export function applyTheme(el) {
  if (!el || [...el.classList].some(c => c.startsWith("theme-") && el.classList.contains("themed"))) return
  const t = themeOf()
  if (t === "dark" || t === "light") el.classList.add("themed", `theme-${t}`)
}
Hooks.on("clientSettingChanged", (key) => {
  if (key !== "core.uiConfig") return
  const app = foundry?.applications?.instances?.get?.(APP_ID)
  if (!app?.element) return
  app.element.classList.remove("theme-dark", "theme-light")
  applyTheme(app.element)
})

/** Move a goal: before another (`before` id), after one (`after` id), else to the end — and
 *  into another section when `who` is given. Pure; RealmScreen's goal.move does the same. */
export function moveGoal(goals, id, { before = null, after = null, who } = {}) {
  const list = arr(goals).slice()
  const i = list.findIndex(g => g.id === id)
  if (i < 0) return list
  const [g] = list.splice(i, 1)
  const moved = who ? { ...g, who } : g
  let at = before ? list.findIndex(x => x.id === before) : after ? list.findIndex(x => x.id === after) + 1 : list.length
  if (at < 0) at = list.length
  list.splice(at, 0, moved)
  return list
}

// ── the window ────────────────────────────────────────────────
const userName = (id) => { const u = game.users?.get(id); return u ? (u.character?.name || u.name) : "a player" }
const DialogV2 = () => foundry.applications.api.DialogV2
const img = (src, cls = "") => (src ? `<img class="${cls}" src="${esc(src)}" alt="">` : "")
const ini = (name, cls = "") => `<span class="pb-cp-ini ${cls}">${esc((name || "?")[0])}</span>`
const pic = (src, name, cls = "") => (src ? img(src, cls) : ini(name, cls))
const clone = (x) => JSON.parse(JSON.stringify(x))
/** A new item's id, made here and kept by RealmScreen, so a just-added step can be ticked at once. */
export const newId = () => (globalThis.foundry?.utils?.randomID?.(16) ?? (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 16))
const PENDING_MS = 6000     // how long a change made here is laid over RealmScreen's copy
const lowFirst = (t) => (t ? t[0].toLowerCase() + t.slice(1) : "")
/** Item / journal HTML → readable text: links and rolls become their words, entities decoded. */
export function plainText(html, max = 1500) {
  let h = String(html || "")
    .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1")             // @UUID[…]{Longsword} → Longsword
    .replace(/@\w+\[([^\]]*)\]/g, (m, x) => x.split(".").pop())  // @UUID[…Item.abc] → abc (no label)
    .replace(/\[\[\/\w+\s+([^\]]+?)\]\](\{([^}]*)\})?/g, (m, f, l, lab) => lab || f)   // [[/r 1d6]] → 1d6
    .replace(/<\/(p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
  if (typeof document !== "undefined") { const t = document.createElement("textarea"); t.innerHTML = h; h = t.value }
  else h = h.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  h = h.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim()
  return h.length > max ? h.slice(0, max).replace(/\s+\S*$/, "") + "…" : h
}

/** A form dialog → its fields, or null on cancel. */
async function formDialog(title, html, okLabel = "Save") {
  const D = DialogV2()
  return D.prompt({
    window: { title, icon: "fa-solid fa-flag" },
    classes: ["pb-cp-dialog"],
    content: `<div class="standard-form">${html}</div>`,
    ok: { label: okLabel, icon: "fa-solid fa-check", callback: (ev, btn) => Object.fromEntries(new FormData(btn.form).entries()) },
    rejectClose: false,
  }).catch(() => null)
}
const field = (label, input, hint = "") => `<div class="form-group${input.startsWith("<textarea") ? " stacked" : ""}"><label>${label}</label>${input}${hint ? `<p class="hint">${hint}</p>` : ""}</div>`

let PageClass = null
function pageClass() {
  const AppV2 = foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  if (PageClass) return PageClass
  PageClass = class CampaignPage extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: APP_ID,
      classes: ["pb-campaign-page"],
      window: { icon: "fa-solid fa-flag", resizable: true },
      position: { width: 880, height: 760 },
      actions: {
        go: CampaignPage.#tab,
        // secrets
        compose: CampaignPage.#compose, kind: CampaignPage.#kind, cancel: CampaignPage.#cancel, give: CampaignPage.#give,
        pickSpot: CampaignPage.#pickSpot, pickImage: CampaignPage.#pickImage, who: CampaignPage.#who,
        sendNow: CampaignPage.#simple, remove: CampaignPage.#remove, reveal: CampaignPage.#reveal, edit: CampaignPage.#edit,
        share: CampaignPage.#share,
        panPlace: CampaignPage.#panPlace, panParty: CampaignPage.#panParty,
        // goals + information
        addGoal: CampaignPage.#addGoal, editGoal: CampaignPage.#editGoal, goalDone: CampaignPage.#goalDone, step: CampaignPage.#step,
        openStep: CampaignPage.#openStep, renameStep: CampaignPage.#renameStep, dropStep: CampaignPage.#dropStep, addInfo: CampaignPage.#addInfo, editInfo: CampaignPage.#editInfo,
        old: CampaignPage.#old, del: CampaignPage.#del, ptick: CampaignPage.#ptick, peek: CampaignPage.#peek, menu: CampaignPage.#menu,
        rename: CampaignPage.#rename, oldDone: CampaignPage.#oldDone,
        // findings
        addPicture: CampaignPage.#addPicture, addNote: CampaignPage.#addNote, openFind: CampaignPage.#openFind, editFind: CampaignPage.#editFind,
        found: CampaignPage.#found, openDoc: CampaignPage.#openDoc, showPic: CampaignPage.#showPic,
        // people
        pin: CampaignPage.#pin, hidePerson: CampaignPage.#hidePerson, notePerson: CampaignPage.#notePerson, unmeet: CampaignPage.#unmeet,
        addMet: CampaignPage.#addMet, recent: CampaignPage.#recent,
        // group
        linkGroup: CampaignPage.#linkGroup, openGroup: CampaignPage.#openGroup,
      },
    }
    tab = "over"
    comp = null           // the open "Give a secret" form
    pending = []          // changes made here, laid over RealmScreen's copy until it has them (PENDING_MS)
    openFindId = null
    menuKey = null
    peekKey = null
    oldOpen = new Set()

    get title() { return this.options.campaign?.name || "Campaign" }
    get cid() { return this.options.campaign?.id }
    // The page as shown: RealmScreen's copy with the changes made here in the last few seconds
    // on top (each change is safe to apply twice). A refusal from RealmScreen drops them.
    #pageMemo = null
    get page() {
      const base = readPages()[this.cid] || null
      const now = Date.now()
      this.pending = this.pending.filter(x => now - x.at < PENDING_MS)
      if (!base || !this.pending.length) return base
      const key = this.pending.map(x => x.at).join()
      if (this.#pageMemo?.base === base && this.#pageMemo.key === key) return this.#pageMemo.page
      const c = clone(base)
      for (const x of this.pending) { try { x.change(c) } catch { /* the thing it touched is gone */ } }
      this.#pageMemo = { base, key, page: c }
      return c
    }

    send(op, data = {}) { relay("campaign.page", { op, campaignId: this.cid, ...data }) }
    /** Change the page here at once (ticks feel instant), then ask RealmScreen. */
    act(op, data, change) {
      if (change && this.page) { this.pending.push({ at: Date.now() + this.pending.length * 1e-3, change }); this.render() }
      this.send(op, data)
      setTimeout(() => { if (this.rendered) this.render() }, PENDING_MS + 50)   // let an unanswered change fall away
    }
    /** RealmScreen said no: forget what was shown ahead of it, give a form back. */
    refused() {
      this.pending = []
      if (this.comp?.saving) this.comp.saving = false
      this.render()
    }

    // Keep what's typed across re-renders (the setting changes under an open form). An action that
    // already read the form must not be read again by the render it triggers (it re-read the OLD form).
    #keptAt = -1e9
    #keep() {
      const el = this.element
      if (!el) return
      this.#keptAt = performance.now()
      const v = (sel) => el.querySelector(sel)?.value
      if (this.comp) {
        for (const [k, sel] of [["title", "[name=cTitle]"], ["text", "[name=cText]"], ["page", "[name=cPage]"], ["place", "[name=cWhere]"], ["days", "[name=cDays]"]]) {
          const x = v(sel); if (x !== undefined) this.comp[k === "place" ? "wherePlace" : k] = x
        }
        const how = el.querySelector("[name=cHow]:checked")?.value; if (how) this.comp.how = how
        const when = el.querySelector("[name=cWhen]:checked")?.value; if (when) this.comp.when = when
        const sh = el.querySelector("[name=cShare]"); if (sh) this.comp.share = sh.checked
      }
      this.drafts ||= {}            // other tabs' half-typed lines survive switching tabs
      for (const t of el.querySelectorAll("[data-draft]")) this.drafts[t.dataset.draft] = t.value
      for (const d of el.querySelectorAll("details[data-old]")) { if (d.open) this.oldOpen.add(d.dataset.old); else this.oldOpen.delete(d.dataset.old) }
    }

    // ── the party: the linked group's members, else the campaign's characters ──
    #party(p) {
      const g = linkedGroup(p)
      if (g) return groupMemberActors(g).map(a => ({ name: a.name, img: a.img, actor: a, player: game.users?.find(u => !u.isGM && Number(a.ownership?.[u.id]) >= OWNER)?.name || "" }))
      return arr(p.overview?.party).map(c => {
        const a = game.actors?.find(x => x.type === "character" && x.name?.toLowerCase() === String(c.name || "").toLowerCase()) || null
        return { name: c.name, img: c.cover || a?.img || null, actor: a, player: c.player || "", away: c.away, sub: c.sub || "" }
      })
    }
    #characters(p) { return [...new Set([...this.#party(p).map(m => m.name), ...arr(p.goals).map(g => g.who).filter(w => w && w !== "party")])] }

    async _renderHTML() {
      if (performance.now() - this.#keptAt > 120) this.#keep()   // an action read it just now → don't re-read the old form
      const el = document.createElement("div")
      el.className = "pb-cp standard-form"
      const p = this.page
      if (!p) { el.innerHTML = `<p class="hint">${game.user?.isGM ? "RealmScreen hasn’t sent this campaign’s page yet. It does while it’s connected." : "This page isn’t ready yet."}</p>`; return el }
      const gm = !!game.user?.isGM, me = game.user?.id
      const o = p.overview || {}
      const vis = visibleSecrets(p, me, gm)
      const dot = !gm && unseenFor(p, me).length
      const g = linkedGroup(p)
      const sub = gm ? "You are the GM" : esc(game.user?.character?.name || game.user?.name)
      const sess = o.running ? `${Number.isFinite(o.running.number) ? `Session ${o.running.number}` : "A session"} <span class="pb-cp-live">running</span>` : `${o.played || 0} session${o.played === 1 ? "" : "s"} played`
      const next = arr(o.coming)[0]
      const tok = partyToken(this.cid)
      const btns = [
        gm ? `<button type="button" class="pb-cp-sq${g ? " on" : ""}" data-action="linkGroup" data-tooltip="${g ? `Linked to ${esc(g.name)} — change or unlink` : "Link a group token"}" aria-label="${g ? "Change the linked group" : "Link a group token"}"><i class="fa-solid fa-link"></i></button>` : "",
        g ? `<button type="button" class="pb-cp-sq" data-action="openGroup" data-tooltip="Open ${esc(g.name)}" aria-label="Open the group"><i class="fa-solid fa-users"></i></button>` : "",
        tok ? `<button type="button" class="pb-cp-sq" data-action="panParty" data-tooltip="Show the party on the map" aria-label="Show the party on the map"><i class="fa-solid fa-location-dot"></i></button>` : "",
      ].join("")
      const tabs = [["over", "Overview"], ["goals", "Goals"], ["finds", "Findings"], ["sec", `Secrets${dot ? `<span class="pb-cp-dot"></span>` : ""}`]]
      el.innerHTML = `
        <header class="pb-cp-hero">
          <div class="pb-cp-emblem"><div class="pb-cp-emb">${g?.img ? img(g.img) : `<i class="fa-solid fa-flag"></i>`}</div>${btns ? `<div class="pb-cp-sqs">${btns}</div>` : ""}</div>
          <div class="pb-cp-heads">
            <div class="pb-cp-titles"><h2>${esc(o.name || this.title)}</h2><span class="pb-cp-sub">${sub} · ${sess}${g ? ` · <i class="fa-solid fa-link"></i> ${esc(g.name)}` : ""}</span></div>
            <div class="pb-cp-cards">
              ${o.date ? `<div class="pb-cp-card" data-tooltip="${esc(o.date)}"><h4>Date</h4><strong>${esc(o.date)}</strong></div>` : ""}
              ${next ? `<div class="pb-cp-card" data-tooltip="${esc(arr(o.coming).map(c => `${c.name} — ${c.rel}`).join(" · "))}"><h4>Coming up</h4><strong>${esc(next.name)}</strong><small>${esc(next.rel)}${arr(o.coming).length > 1 ? ` · +${arr(o.coming).length - 1} more` : ""}</small></div>` : ""}
              ${o.where ? (() => { const place = o.where.place || o.where.text, more = o.where.place && !String(o.where.text).includes(o.where.place) ? o.where.text : o.where.place && o.where.text !== `In ${o.where.place}` ? o.where.text : ""
                return `<div class="pb-cp-card" data-tooltip="${esc(o.where.text)}"><h4>Where</h4><strong>${esc(place)}</strong>${more ? `<small>${esc(more)}</small>` : ""}</div>` })() : ""}
            </div>
          </div>
        </header>
        <nav class="sheet-tabs tabs pb-cp-tabs" role="tablist">${tabs.map(([k, l]) => `<a class="item ${this.tab === k ? "active" : ""}" data-action="go" data-tab="${k}" aria-selected="${this.tab === k}">${l}</a>`).join("")}</nav>
        <section class="pb-cp-body" data-drop="${this.tab === "finds" && gm ? "1" : ""}">${
          this.tab === "goals" ? this.#goals(p, gm) : this.tab === "finds" ? this.#finds(p, gm) : this.tab === "sec" ? this.#secrets(p, vis, gm, me) : this.#overview(p, gm, vis, me)}</section>`
      return el
    }
    _replaceHTML(result, content) {
      const body = content.querySelector(".pb-cp-body")
      const same = this.#shownTab === this.tab
      const scroll = body && same ? body.scrollTop : 0, outer = same ? content.scrollTop : 0
      const a = document.activeElement
      this.#refocus = a && content.contains(a) && a.matches?.("[data-draft], input[data-enter]")
        ? { sel: a.dataset.draft ? `[data-draft="${CSS.escape(a.dataset.draft)}"]` : a.dataset.enter === "saveRename" ? "input.pb-cp-rename" : a.dataset.enter === "saveStep" ? "input.pb-cp-steprename" : null, at: a.selectionStart }
        : null
      content.replaceChildren(result)
      const nb = content.querySelector(".pb-cp-body")
      if (nb) nb.scrollTop = scroll
      content.scrollTop = outer          // (in case a theme makes the window itself scroll)
      this.#shownTab = this.tab
    }
    #shownTab = null
    #refocus = null

    _onRender() {
      applyTheme(this.element)
      const p = this.page
      // Opening the Secrets tab is reading them.
      if (this.tab !== "sec") this.freshIds = null
      if (this.tab === "sec" && p && !game.user?.isGM) {
        const ids = unseenFor(p, game.user.id).map(s => s.id)
        this.freshIds = new Set([...(this.freshIds || []), ...ids])
        if (ids.length && !this.#seenSent?.has(ids.join())) { (this.#seenSent ??= new Set()).add(ids.join()); this.send("seen", { ids }) }
      }
      if (!this.#wired) this.#wire()
      // Cursor: back where it was before the redraw; or into a rename / line just opened.
      const want = this.focusNext ? this.element.querySelector(this.focusNext) : this.#refocus?.sel ? this.element.querySelector(this.#refocus.sel) : null
      if (want) {
        want.focus()
        if (this.focusNext && want.select && want.matches(".pb-cp-rename, .pb-cp-steprename")) want.select()
        else if (this.#refocus && Number.isFinite(this.#refocus.at)) want.setSelectionRange?.(this.#refocus.at, this.#refocus.at)
      }
      this.focusNext = null
      // A menu near the bottom opens upwards (it would be cut off by the scrolling body).
      const menu = this.element.querySelector(".pb-cp-menu"), body = this.element.querySelector(".pb-cp-body")
      if (menu && body && menu.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom) menu.classList.add("up")
      // Keyboard: every clickable link is a button you can Tab to.
      for (const a of this.element.querySelectorAll("a[data-action]:not([href]):not([tabindex])")) { a.tabIndex = 0; a.setAttribute("role", a.closest(".pb-cp-tabs") ? "tab" : "button") }
      if (this.scrollDetail) { this.element.querySelector(".pb-cp-detail")?.scrollIntoView({ block: "nearest" }); this.scrollDetail = false }
    }
    #wired = false
    #wire() {
      this.#wired = true
      const el = this.element
      el.addEventListener("keydown", (ev) => {
        const t = ev.target
        if (t.matches?.("a[data-action]") && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); t.click(); return }
        if (!t.matches?.("input[data-enter]")) return
        if (ev.key === "Escape") {
          if (t.dataset.enter === "saveRename") { ev.preventDefault(); this.renaming = null; return this.render() }
          if (t.dataset.enter === "saveStep") { ev.preventDefault(); this.stepRenaming = null; return this.render() }
          if (t.dataset.enter === "quickStep") { ev.preventDefault(); this.stepOpen = null; this.#keep(); this.drafts[t.dataset.draft] = ""; return this.render() }
        }
        if (ev.key !== "Enter") return
        ev.preventDefault()
        this.#onEnter(t)
      })
      // Leaving a rename saves it — after the click that moved the focus has landed.
      el.addEventListener("focusout", (ev) => {
        const t = ev.target
        if (!t.matches?.("input[data-enter=saveRename], input[data-enter=saveStep]")) return
        const was = t.dataset.enter === "saveRename" ? this.renaming : this.stepRenaming
        setTimeout(() => { if ((t.dataset.enter === "saveRename" ? this.renaming : this.stepRenaming) === was && was) this.#onEnter(t) }, 0)
      })
      // The secret form: typing a town or a day count picks that "When".
      el.addEventListener("focusin", (ev) => {
        const n = ev.target.name
        if (n === "cWhere" || n === "cDays") { const r = el.querySelector(`input[name=cWhen][value=${n === "cWhere" ? "place" : "date"}]`); if (r) r.checked = true }
      })
      el.addEventListener("change", (ev) => {
        const t = ev.target
        if (t.matches?.("select[data-enter=addFor]") && t.value) { this.addFor = t.value; this.focusNext = `[data-draft="${CSS.escape("g:" + t.value)}"]`; this.render() }
      })
      // A click anywhere outside an open ⋯ menu closes it.
      el.addEventListener("pointerdown", (ev) => {
        if (this.menuKey && !ev.target.closest?.(".pb-cp-menu, [data-action=menu]")) { this.menuKey = null; this.render() }
      }, true)
      if (!game.user?.isGM) return
      // Goals: only the grip starts a drag (a nudge on a checkbox or a text box never does).
      el.addEventListener("pointerdown", (ev) => { const g = ev.target.closest?.(".pb-cp-grip"); if (g) g.closest("[data-goal]")?.setAttribute("draggable", "true") })
      el.addEventListener("dragstart", (ev) => {
        const g = ev.target.closest?.("[data-goal]")
        if (!g || g.getAttribute("draggable") !== "true") return
        this.dragGoal = g.dataset.goal
        ev.dataTransfer.effectAllowed = "move"
        ev.dataTransfer.setData("text/plain", JSON.stringify({ pbGoal: g.dataset.goal }))
        g.classList.add("dragging")
      })
      const clearDrag = () => {
        this.dragGoal = null
        el.querySelectorAll("[data-goal][draggable]").forEach(e => e.removeAttribute("draggable"))
        el.querySelectorAll(".dragging, .pb-cp-drop-before, .pb-cp-drop-after, .pb-cp-drop.over").forEach(e => e.classList.remove("dragging", "pb-cp-drop-before", "pb-cp-drop-after", "over"))
      }
      el.addEventListener("dragend", clearDrag)
      el.addEventListener("pointerup", () => { if (!this.dragGoal) el.querySelectorAll("[data-goal][draggable]").forEach(e => e.removeAttribute("draggable")) })
      el.addEventListener("dragover", (ev) => {
        // Only where something can land: a goal being moved, or anything onto Findings (or a group anywhere).
        if (!this.dragGoal && this.tab !== "finds" && this.tab !== "over") return
        ev.preventDefault()
        el.querySelector(".pb-cp-drop")?.classList.toggle("over", !this.dragGoal)
        if (!this.dragGoal) return
        el.querySelectorAll(".pb-cp-drop-before, .pb-cp-drop-after").forEach(e => e.classList.remove("pb-cp-drop-before", "pb-cp-drop-after"))
        const g = ev.target.closest?.("[data-goal]")
        if (g && g.dataset.goal !== this.dragGoal) { const r = g.getBoundingClientRect(); g.classList.add(ev.clientY < r.top + r.height / 2 ? "pb-cp-drop-before" : "pb-cp-drop-after") }
      })
      el.addEventListener("dragleave", (ev) => { if (!el.contains(ev.relatedTarget)) el.querySelector(".pb-cp-drop")?.classList.remove("over") })
      el.addEventListener("drop", (ev) => { const goal = this.dragGoal; const r = goal ? this.#onGoalDrop(ev) : this.#onDrop(ev); clearDrag(); return r })
    }
    #seenSent = null

    // ── quick lines (Enter) and goal drags ──
    #onEnter(t) {
      const v = str(t.value)
      const kind = t.dataset.enter
      if (kind === "saveRename") {
        const id = t.dataset.id
        this.renaming = null
        const x = this.#find("goal", id)
        if (!v || !x || v === x.text) return this.render()
        return this.act("goal.edit", { id, goal: { text: v } }, (c) => { const g = c.goals.find(g => g.id === id); if (g) g.text = v })
      }
      if (kind === "saveStep") {
        const [id, sid] = String(this.stepRenaming || "").split("|")
        this.stepRenaming = null
        const x = this.#find("goal", id), st = x?.steps.find(s => s.id === sid)
        if (!v || !st || v === st.text) return this.render()
        return this.act("goal.editStep", { id, stepId: sid, text: v }, (c) => { const s = c.goals.find(g => g.id === id)?.steps.find(s => s.id === sid); if (s) s.text = v })
      }
      if (!v) return
      // Read every quick line first (other half-typed lines survive the redraw), then empty this one.
      const clear = (key) => { this.#keep(); this.drafts[key] = "" }
      if (kind === "quickGoal") {
        const who = t.dataset.who || "party", id = newId()
        clear("g:" + who)
        if (this.addFor === who) this.addFor = null
        return this.act("goal.add", { goal: { id, text: v, who } }, (c) => { c.goals = arr(c.goals); if (!c.goals.some(g => g.id === id)) c.goals.push({ id, who, text: v, note: "", done: false, old: false, link: null, steps: [] }) })
      }
      if (kind === "quickStep") {
        const id = t.dataset.id, sid = newId()
        clear("s:" + id)
        return this.act("goal.addStep", { id, stepId: sid, text: v }, (c) => { const g = c.goals.find(g => g.id === id); if (g && !g.steps.some(s => s.id === sid)) { g.steps.push({ id: sid, text: v, done: false }); g.done = false } })
      }
      if (kind === "quickInfo") {
        const id = newId()
        clear("info")
        return this.act("info.add", { info: { id, text: v } }, (c) => { c.info = arr(c.info); if (!c.info.some(i => i.id === id)) c.info.push({ id, text: v, link: null, old: false }) })
      }
    }
    #onGoalDrop(ev) {
      ev.preventDefault()
      const id = this.dragGoal
      const target = ev.target.closest?.("[data-goal]")
      const section = ev.target.closest?.("[data-who]")
      if (!id || (!target && !section)) return this.render()
      // Before / after the goal it was dropped on, in the STORED order (finished goals are only drawn last).
      let before = null, after = null
      if (target && target.dataset.goal !== id) {
        const r = target.getBoundingClientRect()
        if (ev.clientY < r.top + r.height / 2) before = target.dataset.goal; else after = target.dataset.goal
      } else if (!target) {
        const last = [...section.querySelectorAll("[data-goal]")].pop()
        if (last && last.dataset.goal !== id) after = last.dataset.goal
      }
      const who = section?.dataset.who || undefined
      this.act("goal.move", { id, before, after, who }, (c) => { c.goals = moveGoal(c.goals, id, { before, after, who }) })
    }

    async #onDrop(ev) {
      ev.preventDefault()
      const TE = foundry?.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor
      let data = null
      try { data = TE.getDragEventData(ev) } catch { data = null }
      if (!data) return
      const doc = data.uuid ? await fromUuid(data.uuid).catch(() => null) : null
      if (doc?.documentName === "Actor" && doc.type === "group") return this.#linkTo(doc)
      if (this.tab !== "finds") return ui.notifications?.info("Drop things on the Findings tab to add them.")
      let find = null
      if (doc?.documentName === "Item") {
        // An unidentified dnd5e item stays unidentified for the players.
        const unk = doc.system?.identified === false
        find = { kind: "item", name: unk ? (doc.system?.unidentified?.name || "Unidentified item") : doc.name, img: doc.img, uuid: doc.uuid,
          text: plainText(unk ? doc.system?.unidentified?.description : doc.system?.description?.value) }
      } else if (doc?.documentName === "Actor") find = { kind: "actor", name: doc.name, img: doc.img, uuid: doc.uuid, text: "" }
      else if (doc?.documentName === "JournalEntryPage") find = { kind: "journal", name: doc.name, img: doc.src || null, uuid: doc.uuid, text: plainText(doc.text?.content) }
      else if (doc?.documentName === "JournalEntry") {
        const first = [...(doc.pages?.contents ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))[0]
        find = { kind: "journal", name: doc.name, img: first?.src || null, uuid: doc.uuid, text: plainText(first?.text?.content) }
      } else if (doc?.documentName === "Tile" || data.texture?.src || data.src) find = { kind: "picture", name: doc?.name || "Picture", img: data.texture?.src || data.src || doc?.texture?.src, text: "" }
      if (!find) return ui.notifications?.warn("That can’t be a finding — drop an item, actor, journal or picture.")
      find.id = newId()
      find.hidden = !!ev.altKey          // Alt-drop: keep it for later ("not found yet")
      this.#addFind(find)
    }

    // ── Overview ──
    #overview(p, gm, vis, me) {
      const party = this.#party(p)
      const meName = game.user?.character?.name
      const row = (m) => {
        const s = memberStats(m.actor)
        const low = s.hp && s.hp[0] / s.hp[1] < 0.2
        const bar = (v, cls, label) => (v ? `<span class="pb-cp-bl">${label}</span><div class="pb-cp-meter ${cls}" data-tooltip="${label} ${v[0]} / ${v[1]}"><i style="width:${Math.max(0, Math.min(100, v[0] / v[1] * 100))}%"></i></div><span class="pb-cp-val">${v[0]}/${v[1]}</span>` : "")
        const sub = [m.player, m.sub && !s.hp ? m.sub : "", m.away ? "away" : ""].filter(Boolean).join(" · ")
        return `<div class="pb-cp-crow${low ? " low" : ""}${m.away ? " away" : ""}">${pic(m.img, m.name, "pb-cp-face")}
          <div class="pb-cp-cm"><div class="pb-cp-cn" data-tooltip="${esc(m.name)}">${esc(m.name)}</div>
            ${sub || low ? `<div class="pb-cp-csub">${esc(sub)}${low ? `<em>down to ${s.hp[0]} HP</em>` : ""}</div>` : ""}
            ${s.hp || s.hd ? `<div class="pb-cp-bars">${bar(s.hp, "hp", "HP")}${bar(s.hd, "hd", "HD")}</div>` : !sub ? `<span class="hint">${m.actor ? "No hit points on this actor yet" : "No Foundry actor matched yet"}</span>` : ""}</div>
          <div class="pb-cp-cs">${s.ac != null ? `<span data-tooltip="Armour Class"><i class="fa-solid fa-shield"></i>${s.ac}</span>` : ""}${s.prc != null ? `<span data-tooltip="Passive Perception"><i class="fa-solid fa-eye"></i>${s.prc}</span>` : ""}${s.ste != null ? `<span data-tooltip="Passive Stealth"><i class="fa-solid fa-user-ninja"></i>${s.ste}</span>` : ""}${s.sur != null ? `<span data-tooltip="Passive Survival"><i class="fa-solid fa-compass"></i>${s.sur}</span>` : ""}</div></div>`
      }
      const open = arr(p.goals).filter(x => !x.old && !x.done).slice(0, 5)
      const finds = arr(p.finds).filter(f => !f.old && (gm || !f.hidden)).slice(-4).reverse()
      const unseen = !gm ? unseenFor(p, me).length : 0
      const waiting = gm ? arr(p.secrets).filter(s => s.state === "waiting").length : 0
      const whoOf = (x) => (x.who === "party" ? "" : x.who === meName ? "You" : x.who)
      return `<div class="pb-cp-ov">
        <div class="pb-cp-col">
          <h3 class="pb-cp-h">The party${gm && !linkedGroup(p) ? `<a data-action="linkGroup">Link a group token</a>` : ""}</h3>
          ${party.map(row).join("") || `<p class="hint">${gm ? "Link a group token (the chain button) or add players to the campaign in RealmScreen." : "Nobody yet."}</p>`}
        </div>
        <div class="pb-cp-col">
          <div class="pb-cp-panel"><h4>Goals <a data-action="go" data-tab="goals">All ›</a></h4>
            ${open.map(x => { const d = x.steps.filter(s => s.done).length; return `<div class="pb-cp-prog"><span>${whoOf(x) ? `<small>${esc(whoOf(x))} · </small>` : ""}${esc(x.text)}</span>${x.steps.length ? `<span class="pb-cp-pbar" data-tooltip="${d}/${x.steps.length} steps"><i style="width:${d / x.steps.length * 100}%"></i></span>` : ""}</div>` }).join("") || `<p class="hint">No open goals.</p>`}</div>
          <div class="pb-cp-panel"><h4>Findings <a data-action="go" data-tab="finds">All ›</a></h4>
            ${finds.length ? `<div class="pb-cp-thumbs">${finds.map(f => `<a class="${f.hidden ? "pb-cp-concealed" : ""}" data-action="openFind" data-id="${esc(f.id)}" data-tooltip="${esc(f.name)}${f.hidden ? " — not found yet" : ""}">${f.img ? img(f.img, f.kind === "picture" ? "" : "fit") : `<i class="fa-solid ${FIND_ICON[f.kind] || "fa-gem"}"></i>`}</a>`).join("")}</div>` : `<p class="hint">Nothing found yet.</p>`}</div>
          <div class="pb-cp-panel"><h4>Secrets <a data-action="go" data-tab="sec">Open ›</a></h4>
            ${gm ? `<div class="pb-cp-row"><span><i class="fa-solid fa-key"></i> ${arr(p.secrets).filter(s => s.state === "given").length} given</span>${waiting ? `<span class="pb-cp-r">${waiting} waiting</span>` : ""}</div>`
              : `<div class="pb-cp-row"><span><i class="fa-solid fa-key"></i> ${vis.length} secret${vis.length === 1 ? "" : "s"}</span>${unseen ? `<span class="pb-cp-new">${unseen} new</span>` : ""}</div>`}</div>
        </div>
      </div>
      ${this.#people(p, gm)}`
    }

    #people(p, gm) {
      const prefs = p.peoplePrefs || {}
      const list = arr(p.overview?.people).filter(x => gm || !x.hidden)
      const card = (x) => `<div class="pb-cp-met${x.hidden ? " pb-cp-concealed" : ""}${x.pinned ? " pinned" : ""}">
        ${pic(x.cover, x.name, "pb-cp-metpic")}
        <div class="pb-cp-metm"><strong>${x.pinned ? `<i class="fa-solid fa-thumbtack"></i> ` : ""}${esc(x.name)}</strong>
          <small>${esc([x.line, x.times > 1 ? `met in ${x.times} sessions` : "", x.first && x.times > 1 ? `first ${x.first}` : ""].filter(Boolean).join(" · "))}</small>
          ${x.note ? `<p>${escNl(x.note)}</p>` : ""}${gm && x.hidden ? `<small class="pb-cp-wait"><i class="fa-solid fa-eye-slash"></i> hidden from players</small>` : ""}</div>
        ${gm ? `<div class="pb-cp-metacts">
          <a data-action="pin" data-id="${esc(x.id)}" data-tooltip="${x.pinned ? "Unpin" : "Pin to the top"}" aria-label="${x.pinned ? "Unpin" : "Pin"}"><i class="fa-solid fa-thumbtack${x.pinned ? "" : " pb-cp-off"}"></i></a>
          <a data-action="hidePerson" data-id="${esc(x.id)}" data-tooltip="${x.hidden ? "Show to players" : "Hide from players"}" aria-label="${x.hidden ? "Show to players" : "Hide from players"}"><i class="fa-solid fa-eye${x.hidden ? "-slash" : ""}"></i></a>
          <a data-action="notePerson" data-id="${esc(x.id)}" data-tooltip="What the party knows about them" aria-label="Note"><i class="fa-solid fa-pen"></i></a>
          ${x.manual ? `<a data-action="unmeet" data-id="${esc(x.id)}" data-tooltip="They haven’t met (remove)" aria-label="Remove"><i class="fa-solid fa-xmark"></i></a>` : ""}</div>` : ""}
      </div>`
      return `<section class="pb-cp-people">
        <h3 class="pb-cp-h">People we’ve met <small>${list.filter(x => !x.hidden).length}</small>
          ${gm ? `<span class="pb-cp-hacts"><span class="pb-cp-seg" role="group" aria-label="Who to list">
              <button type="button" class="${prefs.recent ? "" : "active"}" data-action="recent" data-on="0">Everyone</button><button type="button" class="${prefs.recent ? "active" : ""}" data-action="recent" data-on="1">Last 3 sessions</button></span>
            <a data-action="addMet"><i class="fa-solid fa-plus"></i> Someone they met</a></span>` : prefs.recent ? `<small>· last 3 sessions</small>` : ""}</h3>
        ${list.length ? `<div class="pb-cp-metgrid">${list.map(card).join("")}</div>` : `<p class="hint">Nobody yet. It fills in as you play${gm ? ", or add someone they met off-screen" : ""}.</p>`}
      </section>`
    }

    // ── Goals ──
    #more(key, items) {
      return `<span class="pb-cp-morew"><a data-action="menu" data-key="${esc(key)}" class="pb-cp-more"><i class="fa-solid fa-ellipsis"></i></a>${this.menuKey === key ? `<div class="pb-cp-menu">${items.join("")}</div>` : ""}</span>`
    }
    #link(l, key) {
      if (!l) return ""
      return `<a class="pb-cp-link" data-action="peek" data-key="${esc(key)}">${l.img ? img(l.img) : `<i class="fa-solid fa-book-open"></i>`}${esc(l.name)}</a>`
    }
    #peekBox(l, key) {
      return this.peekKey === key && l ? `<div class="pb-cp-peek">${l.img ? img(l.img) : ""}<div><strong>${esc(l.name)}</strong>${l.summary ? `<p>${esc(l.summary)}</p>` : `<p class="hint">From the Codex.</p>`}</div></div>` : ""
    }
    #goalCard(x, gm, ptick) {
      const d = x.steps.filter(s => s.done).length
      const key = "goal:" + x.id
      const live = !x.old
      const canTick = (gm || ptick) && live
      const edit = gm && live
      const pct = x.steps.length ? Math.round(d / x.steps.length * 100) : 0
      const title = this.renaming === x.id
        ? `<input type="text" class="pb-cp-rename" data-enter="saveRename" data-id="${esc(x.id)}" value="${esc(x.text)}" aria-label="Goal name">`
        : edit ? `<a class="pb-cp-gt" data-action="rename" data-id="${esc(x.id)}" data-tooltip="Click to rename">${esc(x.text)}</a>` : `<strong class="pb-cp-gt">${esc(x.text)}</strong>`
      const step = (s) => {
        const renaming = this.stepRenaming === `${x.id}|${s.id}`
        const box = canTick ? `<input type="checkbox" data-action="step" data-id="${esc(x.id)}" data-step="${esc(s.id)}" ${s.done ? "checked" : ""}>` : `<i class="fa-${s.done ? "solid fa-check" : "regular fa-square"} pb-cp-box"></i>`
        return `<li class="${s.done ? "done" : ""}">${renaming
          ? `${box}<input type="text" class="pb-cp-steprename" data-enter="saveStep" value="${esc(s.text)}" aria-label="Step">`
          : `<label class="pb-cp-stepl">${box}<span>${esc(s.text)}</span></label>`}
          ${edit && !renaming ? `<a data-action="renameStep" data-id="${esc(x.id)}" data-step="${esc(s.id)}" class="pb-cp-x" data-tooltip="Rename step" aria-label="Rename step"><i class="fa-solid fa-pen"></i></a><a data-action="dropStep" data-id="${esc(x.id)}" data-step="${esc(s.id)}" class="pb-cp-x" data-tooltip="Remove step" aria-label="Remove step"><i class="fa-solid fa-xmark"></i></a>` : ""}</li>`
      }
      const adding = edit && (this.stepOpen === x.id || !!this.drafts?.["s:" + x.id])
      return `<article class="pb-cp-goal${x.done ? " done" : ""}${edit ? " gm" : ""}" ${edit ? `data-goal="${esc(x.id)}"` : ""}>
        <div class="pb-cp-grow">${edit ? `<i class="fa-solid fa-grip-vertical pb-cp-grip" data-tooltip="Drag to reorder, or onto another section"></i>` : ""}
          ${gm ? `<input type="checkbox" data-action="goalDone" data-id="${esc(x.id)}" ${x.done ? "checked" : ""} data-tooltip="Done (ticks every step)">` : `<i class="fa-${x.done ? "solid fa-check" : "regular fa-square"} pb-cp-box"></i>`}
          ${title}${this.#link(x.link, key)}
          ${gm ? this.#more(key, [
            `<a data-action="editGoal" data-id="${esc(x.id)}"><i class="fa-solid fa-pen"></i> Edit details…</a>`,
            `<a data-action="old" data-area="goal" data-id="${esc(x.id)}" data-old="${x.old ? "0" : "1"}"><i class="fa-solid fa-box-archive"></i> ${x.old ? "Bring back" : "Move to Old"}</a>`,
            `<a data-action="del" data-area="goal" data-id="${esc(x.id)}" class="pb-cp-danger"><i class="fa-solid fa-trash"></i> Delete for good</a>`]) : ""}</div>
        <div class="pb-cp-gbody">
          ${x.note ? `<p class="pb-cp-gnote">${escNl(x.note)}</p>` : ""}
          ${this.#peekBox(x.link, key)}
          ${x.steps.length ? `<div class="pb-cp-gprog"><div class="pb-cp-gbar"><i style="width:${pct}%"></i></div><span>${d}/${x.steps.length}</span></div>
            <ul class="pb-cp-steps">${x.steps.map(step).join("")}</ul>` : ""}
          ${adding ? `<div class="pb-cp-quick step"><i class="fa-solid fa-plus"></i><input type="text" data-draft="s:${esc(x.id)}" data-enter="quickStep" data-id="${esc(x.id)}" placeholder="A step… (Enter adds, Esc closes)" value="${esc(this.drafts?.["s:" + x.id] || "")}"></div>`
            : edit ? `<a class="pb-cp-addstep" data-action="openStep" data-id="${esc(x.id)}"><i class="fa-solid fa-plus"></i> ${x.steps.length ? "Step" : "Add steps"}</a>` : ""}
        </div>
      </article>`
    }
    #infoCard(x, gm) {
      const key = "info:" + x.id
      return `<article class="pb-cp-goal pb-cp-info"><div class="pb-cp-grow"><i class="fa-solid fa-diamond pb-cp-gem"></i><span class="pb-cp-gt">${escNl(x.text)}</span>${this.#link(x.link, key)}
        ${gm ? this.#more(key, [
          `<a data-action="editInfo" data-id="${esc(x.id)}"><i class="fa-solid fa-pen"></i> Edit</a>`,
          `<a data-action="old" data-area="info" data-id="${esc(x.id)}" data-old="${x.old ? "0" : "1"}"><i class="fa-solid fa-box-archive"></i> ${x.old ? "Bring back" : "Move to Old"}</a>`,
          `<a data-action="del" data-area="info" data-id="${esc(x.id)}" class="pb-cp-danger"><i class="fa-solid fa-trash"></i> Delete for good</a>`]) : ""}</div>${this.#peekBox(x.link, key)}</article>`
    }
    #oldDrawer(key, label, items, wrap = "") {
      if (!items.length) return ""
      const inner = wrap ? `<div class="${wrap}">${items.join("")}</div>` : items.join("")
      return `<details class="pb-cp-old" data-old="${key}" ${this.oldOpen.has(key) ? "open" : ""}><summary><i class="fa-solid fa-box-archive"></i> Old ${label} (${items.length})</summary><div class="pb-cp-oldin">${inner}</div></details>`
    }
    #goals(p, gm) {
      const goals = arr(p.goals), info = arr(p.info)
      const live = goals.filter(x => !x.old)
      const chars = this.#characters(p)
      const me = game.user?.character?.name
      // Only sections with goals (the party's is always there for the GM); a player's own character first.
      const whoHas = new Set(live.map(x => x.who))
      const order = [...chars].sort((a, b) => (b === me) - (a === me))
      const sections = [["party", "Party goals"], ...order.filter(n => whoHas.has(n) || this.addFor === n).map(n => [n, n === me ? "Your goals" : `${n}’s goals`])]
      const quick = (who) => `<div class="pb-cp-quick"><i class="fa-solid fa-plus"></i><input type="text" data-draft="g:${esc(who)}" data-enter="quickGoal" data-who="${esc(who)}" placeholder="Add a goal${who === "party" ? "" : ` for ${esc(who)}`}… (Enter)" value="${esc(this.drafts?.["g:" + who] || "")}"></div>`
      const sec = ([who, title]) => {
        const list = live.filter(x => x.who === who)
        if (!gm && !list.length) return ""
        const done = list.filter(x => x.done).length   // (a goal is done when it's ticked; ticking all its steps ticks it)
        const sorted = [...list.filter(x => !x.done), ...list.filter(x => x.done)]   // finished ones sink
        return `<section class="pb-cp-gsec" data-who="${esc(who)}"><h3 class="pb-cp-h">${esc(title)}${list.length ? `<small>${done}/${list.length} done</small>` : ""}</h3>
          ${sorted.map(x => this.#goalCard(x, gm, p.ptick)).join("") || (gm ? "" : `<p class="hint">Nothing yet.</p>`)}
          ${gm ? quick(who) : ""}</section>`
      }
      const doneLive = live.filter(x => x.done).length
      const missing = chars.filter(n => !whoHas.has(n) && this.addFor !== n)
      const liveInfo = info.filter(x => !x.old)
      return `${gm ? `<div class="pb-cp-row pb-cp-tools">
          ${missing.length ? `<select data-enter="addFor" data-tooltip="Start goals for a character"><option value="">Add goals for…</option>${missing.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}</select>` : ""}
          <button type="button" data-action="addGoal" data-who="party" data-tooltip="A goal with steps, notes and a Codex link"><i class="fa-solid fa-list-check"></i> Detailed goal…</button>
          ${doneLive ? `<button type="button" data-action="oldDone"><i class="fa-solid fa-box-archive"></i> Put finished away (${doneLive})</button>` : ""}
          <label class="pb-cp-opt pb-cp-push"><input type="checkbox" data-action="ptick" ${p.ptick ? "checked" : ""}> Players can tick steps</label></div>` : ""}
        ${sections.map(sec).join("")}
        <section class="pb-cp-gsec"><h3 class="pb-cp-h">Information <small>things worth remembering</small></h3>
          ${liveInfo.length ? `<div class="pb-cp-infogrid">${liveInfo.map(x => this.#infoCard(x, gm)).join("")}</div>` : gm ? "" : `<p class="hint">Nothing yet.</p>`}
          ${gm ? `<div class="pb-cp-quick"><i class="fa-solid fa-plus"></i><input type="text" data-draft="info" data-enter="quickInfo" placeholder="Something worth remembering… (Enter)" value="${esc(this.drafts?.info || "")}"></div>` : ""}</section>
        ${this.#oldDrawer("goals", "goals", goals.filter(x => x.old).map(x => this.#goalCard(x, gm, false)))}
        ${this.#oldDrawer("info", "information", info.filter(x => x.old).map(x => this.#infoCard(x, gm)))}`
    }

    // ── Findings ──
    #finds(p, gm) {
      const all = arr(p.finds).filter(f => gm || !f.hidden)
      const fitCls = (f) => (f.kind === "picture" ? "" : "fit")     // icons and portraits are shown whole
      const tile = (f) => `<a class="pb-cp-find${f.hidden ? " pb-cp-concealed" : ""}${this.openFindId === f.id ? " active" : ""}" data-action="openFind" data-id="${esc(f.id)}">
        <span class="pb-cp-fk">${esc(FIND_NAME[f.kind] || f.kind)}</span>
        <span class="pb-cp-fimg">${f.img ? img(f.img, fitCls(f)) : `<i class="fa-solid ${FIND_ICON[f.kind] || "fa-gem"}"></i>`}${f.hidden ? `<span class="pb-cp-fh"><i class="fa-solid fa-eye-slash"></i> Not found yet</span>` : ""}</span>
        <span class="pb-cp-fb"><strong>${esc(f.name)}</strong>${f.where ? `<small>${esc(f.where)}</small>` : ""}</span></a>`
      const f = all.find(x => x.id === this.openFindId)
      const key = f ? "find:" + f.id : ""
      const canOpen = (x) => {
        if (!x?.uuid) return false
        if (game.user?.isGM) return true
        try { const d = fromUuidSync?.(x.uuid); return !!d && (d.testUserPermission?.(game.user, "LIMITED") ?? d.visible ?? true) } catch { return false }
      }
      const detail = f ? `<div class="pb-cp-detail"><span class="pb-cp-dimg">${f.img ? img(f.img, fitCls(f)) : `<i class="fa-solid ${FIND_ICON[f.kind] || "fa-gem"}"></i>`}</span>
        <div class="pb-cp-dm"><strong>${esc(f.name)}</strong><small>${esc([FIND_NAME[f.kind], f.holder ? `${f.holder} carries it` : "", f.where ? `found ${f.where}` : f.hidden ? "not found yet" : ""].filter(Boolean).join(" · "))}</small>
          ${f.text ? `<p>${escNl(f.text)}</p>` : ""}${f.link ? `<div>${this.#link(f.link, key)}</div>${this.#peekBox(f.link, key)}` : ""}
          <div class="pb-cp-row">${canOpen(f) ? `<button type="button" data-action="openDoc" data-id="${esc(f.id)}"><i class="fa-solid fa-up-right-from-square"></i> Open</button>` : ""}
            ${f.img && gm && !f.hidden && (f.kind === "picture" || f.kind === "journal") ? `<button type="button" data-action="showPic" data-id="${esc(f.id)}"><i class="fa-solid fa-eye"></i> Show to players</button>` : ""}
            ${gm ? `<button type="button" data-action="found" data-id="${esc(f.id)}">${f.hidden ? `<i class="fa-solid fa-flag-checkered"></i> Mark found` : `<i class="fa-solid fa-eye-slash"></i> Hide again`}</button>
              <button type="button" data-action="editFind" data-id="${esc(f.id)}"><i class="fa-solid fa-pen"></i> Edit</button>
              <button type="button" data-action="old" data-area="find" data-id="${esc(f.id)}" data-old="${f.old ? "0" : "1"}"><i class="fa-solid fa-box-archive"></i> ${f.old ? "Bring back" : "Move to Old"}</button>
              <button type="button" data-action="del" data-area="find" data-id="${esc(f.id)}" class="pb-cp-danger" data-tooltip="Delete for good" aria-label="Delete for good"><i class="fa-solid fa-trash"></i></button>` : ""}</div></div></div>` : ""
      const live = all.filter(x => !x.old)
      return `${gm ? `<div class="pb-cp-drop"><strong>Drop things here</strong><span>An item, actor, journal page or picture from the sidebar or a compendium. Hold <kbd>Alt</kbd> to keep it for later (not found yet).</span>
          <div class="pb-cp-row"><button type="button" data-action="addPicture"><i class="fa-solid fa-image"></i> Add a picture</button><button type="button" data-action="addNote"><i class="fa-solid fa-feather"></i> Add a note</button></div></div>` : ""}
        ${detail}
        <h3 class="pb-cp-h">Found <small>${live.filter(x => !x.hidden).length}${gm && live.some(x => x.hidden) ? ` · ${live.filter(x => x.hidden).length} not found yet` : ""}</small></h3>
        ${live.length ? `<div class="pb-cp-fgrid">${live.map(tile).join("")}</div>` : `<p class="hint">Nothing yet.</p>`}
        ${this.#oldDrawer("finds", "findings", all.filter(x => x.old).map(tile), "pb-cp-fgrid")}`
    }

    // ── Secrets ──
    #secrets(p, vis, gm, me) {
      const card = (s) => {
        const acts = []
        if (s.kind === "place" && s.place) acts.push(`<button type="button" data-action="panPlace" data-id="${esc(s.id)}"><i class="fa-solid fa-location-dot"></i> Show on map</button>`)
        if (!gm && s.share && arr(s.to).includes(me) && !arr(s.shown).some(x => x.id === me) && !s.revealed) acts.push(`<button type="button" data-action="share" data-id="${esc(s.id)}"><i class="fa-solid fa-users"></i> Show the party…</button>`)
        if (gm) {
          if (s.state === "waiting") acts.push(`<button type="button" data-action="sendNow" data-id="${esc(s.id)}"><i class="fa-solid fa-paper-plane"></i> Send now</button>`)
          if (!s.revealed) acts.push(`<button type="button" data-action="reveal" data-id="${esc(s.id)}"><i class="fa-solid fa-bullhorn"></i> Reveal to all…</button>`)
          acts.push(`<button type="button" data-action="edit" data-id="${esc(s.id)}"><i class="fa-solid fa-pen"></i> Edit</button>`,
            `<button type="button" data-action="remove" data-id="${esc(s.id)}"><i class="fa-solid fa-rotate-left"></i> Take back</button>`)
        }
        const nm = (id) => esc(s.toNames?.[id] || userName(id))
        const mine = arr(s.to).includes(me)
        const meta = gm
          ? (s.state === "waiting"
              ? [`For ${arr(s.to).map(nm).join(", ")}`, `<span class="pb-cp-wait">waiting · ${esc(lowFirst(String(s.when?.label || "")))}</span>`]
              : [arr(s.to).map(id => `<span class="${arr(s.seen).includes(id) ? "pb-cp-seen" : "pb-cp-unseen"}" data-tooltip="${arr(s.seen).includes(id) ? "Has read it" : "Hasn’t opened it yet"}">${arr(s.seen).includes(id) ? "✓" : "○"} ${nm(id)}</span>`).join(" "),
                 s.given?.label ? `Given: ${esc(s.given.label)}` : ""])
          : [esc(whoLine(s, me, (id) => s.toNames?.[id] || userName(id))), mine && s.given?.label ? `Learned: ${esc(s.given.label)}` : ""]
        const isNew = !gm && (!arr(s.seen).includes(me) || this.freshIds?.has(s.id))
        const tags = [isNew ? `<span class="pb-cp-new">New</span>` : "", gm && s.share ? `<span class="pb-cp-tag">can share</span>` : "", (s.revealed || arr(s.shown).length) ? `<span class="pb-cp-tag">party knows</span>` : ""].join("")
        const body = s.kind === "pic" && s.img ? `<img class="pb-cp-handout" src="${esc(s.img)}" alt="">${s.text ? `<p>${escNl(s.text)}</p>` : ""}`
          : s.kind === "page" ? `<div class="pb-cp-pagesec">${s.img ? `<img src="${esc(s.img)}" alt="">` : ""}<div><strong>${esc(s.page?.name || "")}</strong>${s.text ? `<p>${escNl(s.text)}</p>` : ""}</div></div>`
          : s.text ? `<p>${escNl(s.text)}</p>` : ""
        return `<article class="pb-cp-sec ${s.state === "waiting" ? "waiting" : (s.revealed || arr(s.shown).length) ? "shared" : ""}">
          <i class="fa-solid ${KIND_ICON[s.kind] || "fa-key"} pb-cp-kind" title="${esc(KIND_NAME[s.kind] || "")}"></i>
          <div class="pb-cp-secm"><div class="pb-cp-sect">${esc(s.title)} ${tags}</div>${body}
          <div class="pb-cp-meta">${meta.filter(Boolean).map(x => `<span>${x}</span>`).join("")}</div>
          ${acts.length ? `<div class="pb-cp-row">${acts.join("")}</div>` : ""}</div></article>`
      }
      const list = vis.slice().sort((a, b) => (b.given?.at || b.createdAt || 0) - (a.given?.at || a.createdAt || 0))
      if (gm) {
        return `<div class="pb-cp-row"><span class="hint">${list.length} secret${list.length === 1 ? "" : "s"} · ✓ = has read it</span>${this.comp ? "" : `<button type="button" class="pb-cp-push" data-action="compose"><i class="fa-solid fa-key"></i> Give a secret</button>`}</div>
          ${this.comp ? this.#composer(p) : ""}
          <div class="pb-cp-secs">${list.map(card).join("") || `<p class="hint">No secrets yet.</p>`}</div>`
      }
      return `<p class="hint">Things you know that the others might not.</p>
        <div class="pb-cp-secs">${list.map(card).join("") || `<p class="hint">No secrets yet.</p>`}</div>`
    }

    #composer(p) {
      const c = this.comp
      const users = arr(p.users)
      const radio = (name, val, label, on) => `<label class="pb-cp-opt"><input type="radio" name="${name}" value="${val}" ${on ? "checked" : ""}> ${label}</label>`
      const editing = !!c.id
      const given = editing && c.state === "given"
      const row = (label, inner, cls = "") => `<div class="form-group ${cls}"><label>${label}</label><div class="form-fields">${inner}</div></div>`
      return `<fieldset class="pb-cp-blk pb-cp-comp"${c.saving ? " disabled" : ""}><legend>${editing ? "Edit secret" : "Give a secret"}</legend>
        ${row("What", `<div class="pb-cp-opts">${Object.keys(KIND_NAME).map(k => `<button type="button" class="${c.kind === k ? "active" : ""}" data-action="kind" data-kind="${k}" ${editing ? "disabled" : ""}><i class="fa-solid ${KIND_ICON[k]}"></i> ${KIND_NAME[k]}</button>`).join("")}</div>`)}
        ${row("Title", `<input type="text" name="cTitle" value="${esc(c.title || "")}" placeholder="e.g. The cellar door">`)}
        ${row("To", `<div class="pb-cp-opts">${users.map(id => `<button type="button" class="${c.to.includes(id) ? "active" : ""}" data-action="who" data-user="${esc(id)}" aria-pressed="${c.to.includes(id)}">${esc(userName(id))}</button>`).join("")}
          <button type="button" class="${users.length && users.every(id => c.to.includes(id)) ? "active" : ""}" data-action="who" data-user="*">Whole party</button></div>
          ${users.length ? "" : `<p class="hint">RealmScreen doesn’t know which Foundry accounts play this campaign yet (Players page, or link a group token).</p>`}`)}
        ${c.kind === "page" ? row("Which page", `<input type="text" name="cPage" value="${esc(c.page || "")}" placeholder="The page’s name in RealmScreen, e.g. Captain Dorn">`) : ""}
        ${c.kind === "pic" ? row("Picture", `${c.img ? `<img class="pb-cp-av" src="${esc(c.img)}" alt="">` : ""}<button type="button" data-action="pickImage"><i class="fa-solid fa-file-image"></i> ${c.img ? "Change" : "Choose"}…</button>`) : ""}
        ${c.kind === "place" ? row("Spot", `<span class="hint">${c.place ? `${esc(c.place.sceneName || "This scene")} · placed` : "Not placed yet"}</span><button type="button" data-action="pickSpot"><i class="fa-solid fa-location-dot"></i> ${c.place ? "Move" : "Pick a spot on this scene"}</button>`) : ""}
        <div class="form-group stacked"><label>${c.kind === "pic" ? "What it says (optional)" : c.kind === "page" ? "What they learn from it (optional)" : "What they learn"}</label><textarea name="cText" rows="3" placeholder="Write it the way they’d hear it">${esc(c.text || "")}</textarea></div>
        ${given ? "" : row("When", `<div class="pb-cp-opts col">
          ${radio("cWhen", "now", editing ? "Now (send it)" : "Now", c.when === "now")}
          ${radio("cWhen", "session", "When the next session starts", c.when === "session")}
          <div class="pb-cp-opt"><input type="radio" name="cWhen" value="place" id="pbw-place-${this.id}" ${c.when === "place" ? "checked" : ""}><label for="pbw-place-${this.id}">When they reach</label> <input type="text" name="cWhere" value="${esc(c.wherePlace || "")}" placeholder="a town" class="pb-cp-in" aria-label="Town"></div>
          <div class="pb-cp-opt"><input type="radio" name="cWhen" value="date" id="pbw-date-${this.id}" ${c.when === "date" ? "checked" : ""}><label for="pbw-date-${this.id}">In</label> <input type="number" name="cDays" min="1" value="${esc(c.days || "3")}" class="pb-cp-in num" aria-label="Days"> <span>days on the campaign’s calendar</span></div></div>`)}
        ${row("How", `<div class="pb-cp-opts col">
          ${given ? `<span class="hint">Already given — new people you add get it the same way.</span>` : `${radio("cHow", "whisper", "A whisper card in their chat", c.how !== "quiet")}
          ${radio("cHow", "quiet", "Quietly (a dot on their Secrets tab)", c.how === "quiet")}`}
          <label class="pb-cp-opt"><input type="checkbox" name="cShare" ${c.share ? "checked" : ""}> They may show it to the party</label></div>`)}
        <footer class="pb-cp-row end"><button type="button" data-action="cancel">Cancel</button><button type="button" class="pb-cp-push" data-action="give">${c.saving ? `<i class="fa-solid fa-spinner fa-spin"></i> Saving…` : `<i class="fa-solid fa-key"></i> ${editing ? "Save" : "Give secret"}`}</button></footer>
      </fieldset>`
    }

    // ── actions (`this` = the window) ──
    static #tab(e, t) { this.tab = t.dataset.tab; this.menuKey = null; this.peekKey = null; this.render() }
    // secrets
    static #compose() { this.#keptAt = performance.now(); this.comp = { kind: "note", title: "", text: "", to: [], when: "now", how: "whisper", share: false, days: "3" }; this.render() }
    static #kind(e, t) { this.#keep(); this.comp.kind = t.dataset.kind; this.render() }
    static #cancel() { this.comp = null; this.render() }
    static #who(e, t) {
      this.#keep()
      const users = arr(this.page?.users), id = t.dataset.user
      const c = this.comp
      if (id === "*") c.to = users.every(u => c.to.includes(u)) ? [] : users.slice()
      else c.to = c.to.includes(id) ? c.to.filter(x => x !== id) : [...c.to, id]
      this.render()
    }
    static #pickImage() {
      this.#keep()
      const FP = foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker
      if (!FP) return
      new FP({ type: "image", current: this.comp.img || "", callback: (path) => { this.comp.img = path; this.render() } }).render(true)
    }
    static #pickSpot() {
      this.#keep()
      if (!canvas?.ready || !canvas.scene) return ui.notifications?.warn("Open a scene first.")
      const view = canvas.app?.view
      if (!view) return
      this.minimize?.()
      ui.notifications?.info("Click the spot on the scene. Right-click cancels.")
      const done = () => { view.removeEventListener("pointerdown", on, true); clearTimeout(tm); this.maximize?.() }
      const on = (ev) => {
        ev.stopImmediatePropagation(); ev.preventDefault()     // the canvas must not also select / deselect
        done()
        if (ev.button !== 0) return
        const pt = canvas.canvasCoordinatesFromClient
          ? canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY })
          : canvas.stage.worldTransform.applyInverse({ x: ev.clientX, y: ev.clientY })
        this.comp.place = { sceneId: canvas.scene.id, sceneName: canvas.scene.name, x: Math.round(pt.x), y: Math.round(pt.y) }
        this.render()
      }
      const tm = setTimeout(() => { done(); ui.notifications?.info("Stopped picking a spot.") }, 30000)
      view.addEventListener("pointerdown", on, true)
    }
    static #give() {
      this.#keep()
      const c = this.comp
      // Everything RealmScreen would refuse, said here — so the form never empties on a mistake.
      const why = !c.to.length ? "Pick who gets it."
        : c.kind === "pic" && !c.img ? "Choose the picture first."
        : c.kind === "place" && !c.place ? "Pick the spot on the map first."
        : c.kind === "page" && !str(c.page) && !str(c.title) ? "Say which page."
        : c.state !== "given" && c.when === "place" && !str(c.wherePlace) ? "Say which town they have to reach."
        : c.state !== "given" && c.when === "date" && !(Number(c.days) >= 1) ? "Say how many days from now (1 or more)."
        : !str(c.title) && !str(c.text) && c.kind === "note" ? "Write what they learn."
        : ""
      if (why) return ui.notifications?.warn(why)
      const secret = {
        id: c.id, kind: c.kind, title: str(c.title), text: str(c.text), to: c.to, img: c.img || null, place: c.place || null,
        page: c.kind === "page" ? { name: str(c.page) } : null,
        how: c.how, share: !!c.share,
        ...(c.state === "given" ? {} : { when: { kind: c.when, place: str(c.wherePlace), days: Number(c.days) } }),
      }
      c.saving = true          // the form stays until RealmScreen says yes (a refusal gives it back)
      this.send(c.id ? "edit" : "give", { secret })
      this.render()
    }
    static #simple(e, t) {
      const id = t.dataset.id
      if (t.dataset.action === "sendNow") this.act("sendNow", { id }, (c) => { const s = c.secrets.find(x => x.id === id); if (s) s.state = "given" })
    }
    static async #remove(e, t) {
      const s = arr(this.page?.secrets).find(x => x.id === t.dataset.id)
      const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Take back" }, content: `<p>Take back <strong>${esc(s?.title)}</strong>? It’s removed from everyone’s page. Chat cards already sent stay in chat.</p>`, rejectClose: false })
      if (ok) this.act("remove", { id: t.dataset.id }, (c) => { c.secrets = c.secrets.filter(x => x.id !== t.dataset.id) })
    }
    static async #reveal(e, t) {
      const s = arr(this.page?.secrets).find(x => x.id === t.dataset.id)
      const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Reveal to all" }, content: `<p>Show <strong>${esc(s?.title)}</strong> to the whole party? Their chat gets a card saying who knew all along.</p>`, rejectClose: false })
      if (ok) this.act("reveal", { id: t.dataset.id }, (c) => { const x = c.secrets.find(x => x.id === t.dataset.id); if (x) { x.revealed = true; x.state = "given" } })
    }
    static #edit(e, t) {
      const s = arr(this.page?.secrets).find(x => x.id === t.dataset.id)
      if (!s) return
      this.#keptAt = performance.now()           // don't read the open form into this one
      const today = this.page?.overview?.dayKey
      const daysLeft = s.when?.kind === "date" && Number.isFinite(s.when.dayKey) && Number.isFinite(today) ? Math.max(1, s.when.dayKey - today) : 3
      this.comp = { id: s.id, state: s.state, kind: s.kind, title: s.title, text: s.text, to: arr(s.to).slice(), img: s.img, place: s.place, page: s.page?.name || "",
        how: s.how, share: s.share, when: s.when?.kind || "now", wherePlace: s.when?.place || "", days: String(daysLeft) }
      this.render()
    }
    static async #share(e, t) {
      const s = arr(this.page?.secrets).find(x => x.id === t.dataset.id)
      const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Show the party" }, content: `<p>Show <strong>${esc(s?.title)}</strong> to the rest of the party? You can’t take it back.</p>`, rejectClose: false })
      if (ok) this.send("share", { id: t.dataset.id })
    }
    static #panPlace(e, t) {
      const s = arr(this.page?.secrets).find(x => x.id === t.dataset.id)
      if (s?.place) panTo(s.place.sceneId, s.place.x, s.place.y)
    }
    static #panParty() {
      const tok = partyToken(this.cid)
      if (tok) canvas.animatePan({ x: tok.center.x, y: tok.center.y })
    }

    // ── goals + information ──
    #find(area, id) { return arr(this.page?.[area === "goal" ? "goals" : area === "info" ? "info" : "finds"]).find(x => x.id === id) }
    async #goalForm(x, who) {
      const chars = this.#characters(this.page)
      const opts = [["party", "The party"], ...chars.map(n => [n, n])].map(([v, l]) => `<option value="${esc(v)}" ${(x?.who || who) === v ? "selected" : ""}>${esc(l)}</option>`).join("")
      return formDialog(x ? "Edit goal" : "New goal", [
        field("Goal", `<input type="text" name="text" value="${esc(x?.text || "")}" placeholder="e.g. Deliver the seal to Harrowgate" autofocus>`),
        field("For", `<select name="who">${opts}</select>`),
        // Steps are edited on the card itself (tick, rename, remove, add) — so they keep who ticked what.
        x ? "" : field("Steps", `<textarea name="steps" rows="4" placeholder="One per line (optional) — a checklist under the goal"></textarea>`),
        field("Notes", `<textarea name="note" rows="3" placeholder="Optional">${esc(x?.note || "")}</textarea>`, "Players see this."),
        field("Codex page", `<input type="text" name="link" value="${esc(x?.link?.name || "")}" placeholder="Optional — a page's name in RealmScreen">`, "Leave empty for no link."),
      ].join(""), x ? "Save" : "Add goal")
    }
    static async #addGoal(e, t) {
      const f = await this.#goalForm(null, t.dataset.who || this.addFor || "party")
      if (!f || !str(f.text)) return
      const id = newId()
      const steps = String(f.steps || "").split("\n").map(s => s.trim()).filter(Boolean).map(text => ({ id: newId(), text, done: false }))
      this.act("goal.add", { goal: { id, text: f.text, who: f.who, note: f.note, steps, link: str(f.link) } },
        (c) => { c.goals = arr(c.goals); if (!c.goals.some(g => g.id === id)) c.goals.push({ id, who: f.who, text: f.text, note: f.note, done: false, old: false, link: str(f.link) ? { name: f.link } : null, steps: steps.map(s => ({ ...s })) }) })
    }
    static async #editGoal(e, t) {
      this.menuKey = null
      const x = this.#find("goal", t.dataset.id)
      if (!x) return this.render()
      const f = await this.#goalForm(x)
      if (!f || !str(f.text)) return this.render()
      const goal = { text: f.text, who: f.who, note: f.note }
      if (str(f.link) !== str(x.link?.name)) goal.link = str(f.link)     // only a changed link is looked up again
      this.act("goal.edit", { id: x.id, goal }, (c) => { const g = c.goals.find(g => g.id === x.id); if (g) Object.assign(g, { text: f.text, who: f.who, note: f.note }, "link" in goal ? { link: goal.link ? { ...(x.link || {}), name: goal.link } : null } : {}) })
    }
    static #goalDone(e, t) {
      const done = !!t.checked
      this.act("goal.done", { id: t.dataset.id, done }, (c) => { const g = c.goals.find(g => g.id === t.dataset.id); if (g) { g.done = done; if (done) g.steps.forEach(s => { s.done = true }) } })
    }
    static #step(e, t) {
      const done = !!t.checked
      this.act("goal.step", { id: t.dataset.id, stepId: t.dataset.step, done }, (c) => {
        const g = c.goals.find(g => g.id === t.dataset.id), s = g?.steps.find(s => s.id === t.dataset.step)
        if (s) { s.done = done; g.done = g.steps.every(x => x.done) }        // the goal follows its steps
      })
    }
    static #openStep(e, t) { this.stepOpen = t.dataset.id; this.focusNext = `[data-draft="${CSS.escape("s:" + t.dataset.id)}"]`; this.render() }
    static #renameStep(e, t) { this.stepRenaming = `${t.dataset.id}|${t.dataset.step}`; this.focusNext = "input.pb-cp-steprename"; this.render() }
    static #dropStep(e, t) {
      this.act("goal.dropStep", { id: t.dataset.id, stepId: t.dataset.step }, (c) => { const g = c.goals.find(x => x.id === t.dataset.id); if (g) { g.steps = g.steps.filter(s => s.id !== t.dataset.step); if (g.steps.length && g.steps.every(s => s.done)) g.done = true } })
    }
    async #infoForm(x) {
      return formDialog(x ? "Edit information" : "Something worth remembering", [
        field("What", `<textarea name="text" rows="3" autofocus>${esc(x?.text || "")}</textarea>`),
        field("Codex page", `<input type="text" name="link" value="${esc(x?.link?.name || "")}" placeholder="Optional — a page's name in RealmScreen">`, "Leave empty for no link."),
      ].join(""), x ? "Save" : "Add")
    }
    static async #addInfo() {
      const f = await this.#infoForm(null)
      if (!f || !str(f.text)) return
      const id = newId()
      this.act("info.add", { info: { id, text: f.text, link: str(f.link) } }, (c) => { c.info = arr(c.info); if (!c.info.some(i => i.id === id)) c.info.push({ id, text: f.text, link: str(f.link) ? { name: f.link } : null, old: false }) })
    }
    static async #editInfo(e, t) {
      this.menuKey = null
      const x = this.#find("info", t.dataset.id)
      const f = x && await this.#infoForm(x)
      if (!f || !str(f.text)) return this.render()
      const info = { text: f.text }
      if (str(f.link) !== str(x.link?.name)) info.link = str(f.link)
      this.act("info.edit", { id: x.id, info }, (c) => { const i = c.info.find(i => i.id === x.id); if (i) Object.assign(i, { text: f.text }, "link" in info ? { link: info.link ? { name: info.link } : null } : {}) })
    }
    static #old(e, t) {
      const { area, id } = t.dataset, old = t.dataset.old === "1"
      this.menuKey = null
      if (area === "find" && old) this.openFindId = null
      this.act(`${area}.old`, { id, old }, (c) => { const k = area === "goal" ? "goals" : area === "info" ? "info" : "finds"; const x = c[k]?.find(x => x.id === id); if (x) x.old = old })
    }
    static async #del(e, t) {
      const { area, id } = t.dataset
      this.menuKey = null
      const x = this.#find(area, id)
      const ok = await DialogV2().confirm({ window: { title: "Delete for good" }, content: `<p>Delete <strong>${esc(x?.text || x?.name || "this")}</strong> for good? <em>Move to Old</em> keeps it out of the way instead.</p>`, rejectClose: false })
      if (!ok) return this.render()
      if (area === "find") this.openFindId = null
      this.act(`${area}.remove`, { id }, (c) => { const k = area === "goal" ? "goals" : area === "info" ? "info" : "finds"; c[k] = c[k].filter(x => x.id !== id) })
    }
    static #rename(e, t) { this.renaming = t.dataset.id; this.focusNext = "input.pb-cp-rename"; this.render() }
    static #oldDone() {
      const ids = arr(this.page?.goals).filter(x => x.done && !x.old).map(x => x.id)
      if (!ids.length) return
      this.act("goal.oldDone", {}, (c) => { for (const g of c.goals) if (ids.includes(g.id) && g.done) g.old = true })
    }
    static #ptick(e, t) { const on = !!t.checked; this.act("ptick.set", { on }, (c) => { c.ptick = on }) }
    static #peek(e, t) { this.peekKey = this.peekKey === t.dataset.key ? null : t.dataset.key; this.render() }
    static #menu(e, t) { this.menuKey = this.menuKey === t.dataset.key ? null : t.dataset.key; this.render() }

    // ── findings ──
    async #findForm(x, extra = "") {
      const party = this.#party(this.page).map(m => m.name)
      return formDialog(x?.id ? "Edit finding" : "New finding", [
        extra,
        field("Name", `<input type="text" name="name" value="${esc(x?.name || "")}" autofocus>`),
        field("Who carries it", `<input type="text" name="holder" value="${esc(x?.holder || "")}" list="pb-cp-holders" placeholder="Optional"><datalist id="pb-cp-holders">${party.map(n => `<option value="${esc(n)}">`).join("")}</datalist>`),
        field("Notes", `<textarea name="text" rows="3">${esc(x?.text || "")}</textarea>`),
        field("Codex page", `<input type="text" name="link" value="${esc(x?.link?.name || "")}" placeholder="Optional">`),
        x?.id ? "" : field("Found yet?", `<select name="hidden"><option value="">Yes — players see it now</option><option value="1">Not yet — keep it for later</option></select>`),
      ].join(""), x?.id ? "Save" : "Add")
    }
    static async #addPicture() {
      const FP = foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker
      const path = await new Promise((res) => new FP({ type: "image", callback: res }).render(true))
      if (!path) return
      const f = await this.#findForm({ name: String(path).split("/").pop().replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ") }, `<img class="pb-cp-dlgimg" src="${esc(path)}" alt="">`)
      if (!f) return
      this.#addFind({ kind: "picture", img: path, ...f })
    }
    static async #addNote() {
      const f = await this.#findForm(null)
      if (!f || !str(f.name)) return
      this.#addFind({ kind: "note", ...f })
    }
    #addFind(f) {
      const id = f.id || newId()
      const find = { id, kind: f.kind, name: f.name, img: f.img || null, text: f.text || "", holder: f.holder || "", hidden: !!f.hidden, uuid: f.uuid || null, link: str(f.link) }
      this.act("find.add", { find }, (c) => { c.finds = arr(c.finds); if (!c.finds.some(x => x.id === id)) c.finds.push({ ...find, link: find.link ? { name: find.link } : null, where: find.hidden ? "" : "just now", old: false }) })
      this.openFindId = id
      this.scrollDetail = true
    }
    static #openFind(e, t) {
      const again = this.tab === "finds" && this.openFindId === t.dataset.id
      this.tab = "finds"
      this.openFindId = again ? null : t.dataset.id
      this.scrollDetail = !again
      this.render()
    }
    static async #editFind(e, t) {
      const x = this.#find("find", t.dataset.id)
      const f = x && await this.#findForm(x)
      if (!f) return
      const find = { name: f.name, holder: f.holder, text: f.text }
      if (str(f.link) !== str(x.link?.name)) find.link = str(f.link)
      this.act("find.edit", { id: x.id, find }, (c) => { const i = c.finds.find(i => i.id === x.id); if (i) Object.assign(i, { name: f.name, holder: f.holder, text: f.text }, "link" in find ? { link: find.link ? { name: find.link } : null } : {}) })
    }
    static #found(e, t) {
      const x = this.#find("find", t.dataset.id)
      if (!x) return
      const hidden = !x.hidden
      this.act("find.found", { id: x.id, hidden }, (c) => { const i = c.finds.find(i => i.id === x.id); if (i) { i.hidden = hidden; if (!hidden && !i.where) i.where = "just now" } })
    }
    static async #openDoc(e, t) {
      const x = this.#find("find", t.dataset.id)
      const doc = x?.uuid ? await fromUuid(x.uuid).catch(() => null) : null
      if (!doc) return ui.notifications?.warn("That isn’t in this world any more.")
      if (!doc.testUserPermission?.(game.user, "LIMITED")) return ui.notifications?.info("You can’t open that one.")
      // A journal page opens inside its journal, at that page.
      if (doc.documentName === "JournalEntryPage" && doc.parent?.sheet) return doc.parent.sheet.render(true, { pageId: doc.id })
      doc.sheet?.render(true)
    }
    static #showPic(e, t) {
      const x = this.#find("find", t.dataset.id)
      if (!x?.img) return
      const IP = foundry?.applications?.apps?.ImagePopout ?? globalThis.ImagePopout
      const pop = new IP({ src: x.img, window: { title: x.name }, uuid: x.uuid || undefined })
      pop.render(true)
      pop.shareImage?.()
    }

    // ── people we've met ──
    #person(id) { return arr(this.page?.overview?.people).find(x => x.id === id) }
    static #pin(e, t) {
      const x = this.#person(t.dataset.id); if (!x) return
      this.act("people.pin", { personId: x.id, pinned: !x.pinned }, (c) => { c.overview.people.find(p => p.id === x.id).pinned = !x.pinned })
    }
    static #hidePerson(e, t) {
      const x = this.#person(t.dataset.id); if (!x) return
      this.act("people.hide", { personId: x.id, hidden: !x.hidden }, (c) => { c.overview.people.find(p => p.id === x.id).hidden = !x.hidden })
    }
    static async #notePerson(e, t) {
      const x = this.#person(t.dataset.id); if (!x) return
      const f = await formDialog(`What the party knows: ${x.name}`, field("Note", `<textarea name="text" rows="3" autofocus placeholder="Players see this under their name">${esc(x.note || "")}</textarea>`))
      if (!f) return
      this.act("people.note", { personId: x.id, text: f.text }, (c) => { c.overview.people.find(p => p.id === x.id).note = str(f.text) })
    }
    static async #unmeet(e, t) {
      const x = this.#person(t.dataset.id); if (!x) return
      const ok = await DialogV2().confirm({ window: { title: "They haven’t met" }, content: `<p>Take <strong>${esc(x.name)}</strong> off the list? Only meetings you added by hand can be taken back.</p>`, rejectClose: false })
      if (ok) this.act("people.remove", { personId: x.id }, (c) => { c.overview.people = c.overview.people.filter(p => p.id !== x.id) })
    }
    static async #addMet() {
      const f = await formDialog("Someone they met", field("Who", `<input type="text" name="name" autofocus placeholder="A character's name in RealmScreen">`, "Dated at the campaign’s day. Meetings in play are added for you."), "Add")
      if (f && str(f.name)) this.send("people.add", { name: f.name })
    }
    // Not shown ahead of RealmScreen: it alone can work out who was met in the last 3 sessions.
    static #recent(e, t) { const on = t.dataset.on === "1"; if (!!this.page?.peoplePrefs?.recent !== on) this.send("people.recent", { on }) }

    // ── the group token ──
    #linkTo(actor) {
      this.act("group.link", { actorId: actor?.id || "", name: actor?.name || "" }, (c) => { c.group = actor ? { actorId: actor.id, name: actor.name, users: [], members: [] } : null })
      setTimeout(() => reportGroups(), 1200)
    }
    static async #linkGroup() {
      const groups = game.actors?.filter(a => a.type === "group") ?? []
      const cur = this.page?.group?.actorId || ""
      if (!groups.length) return ui.notifications?.info("There’s no group actor in this world yet. Make one (Actors › Create › Group), then link it here.")
      const mine = groups.find(a => a.flags?.[MOD]?.partyGroup?.campaignId === this.cid)
      const f = await formDialog("Link a group token", field("Group", `<select name="actorId"><option value="">— not linked —</option>${groups.map(a => `<option value="${a.id}" ${(cur || mine?.id) === a.id ? "selected" : ""}>${esc(a.name)}${a.id === mine?.id ? " (this campaign’s party)" : ""}</option>`).join("")}</select>`,
        "Its members show on this page, can see it and get its secrets, for as long as they’re in the group and it stays linked. You can also drag a group actor onto the page."), "Link")
      if (!f) return
      this.#linkTo(f.actorId ? game.actors.get(f.actorId) : null)
    }
    static #openGroup() { linkedGroup(this.page)?.sheet?.render(true) }
  }
  return PageClass
}

/** Open (or bring forward) a campaign's page. */
export function openPage(campaign, { tab } = {}) {
  // Only someone in the campaign (or a GM) — their slice has no page for anything else.
  if (!game.user?.isGM && !readPages()[campaign?.id]) return
  const C = pageClass()
  if (!C) return ui.notifications?.info(campaign.name)
  const open = foundry.applications.instances?.get?.(APP_ID)
  if (open) {
    if (open.options.campaign?.id !== campaign.id) { open.comp = null; open.pending = []; open.openFindId = null; open.menuKey = null }
    open.options.campaign = campaign
    if (tab) open.tab = tab
    open.render({ force: true, window: { title: campaign.name } })
    return open.bringToFront?.()
  }
  const app = new C({ campaign })
  if (tab) app.tab = tab
  app.render({ force: true })
}

// RealmScreen's answer arrived: a secret form that was saving is done; redraw from the new copy.
function rerender() {
  const app = foundry?.applications?.instances?.get?.(APP_ID)
  if (!app) return
  if (app.comp?.saving) app.comp = null
  app.render()
}

// ── hooks ─────────────────────────────────────────────────────
Hooks.once("init", () => {
  // No longer written (it reached every client): kept registered so the GM can empty it (private.js).
  game.settings.register(MOD, KEY, { scope: "world", config: false, type: Object, default: {} })
})
onSlice(() => rerender())
// RealmScreen refused something (a warning note to this user): drop what was shown ahead of it.
Hooks.on("pendantBridgeNote", (n) => { if (n?.level === "warn") foundry?.applications?.instances?.get?.(APP_ID)?.refused?.() })
// A linked group's members changing (or one of them: HP, a new owner) → report + redraw.
for (const h of ["createActor", "updateActor", "deleteActor"]) {
  Hooks.on(h, (actor) => {
    const pages = fullPages()
    const touched = Object.values(pages).some(p => p?.group?.actorId === actor.id || groupMemberActors(linkedGroup(p)).some(a => a.id === actor.id) || actor.type === "group")
    if (touched) scheduleReport()
    // Any character's HP / stats changing redraws an open page (the party may be matched by name).
    const app = foundry?.applications?.instances?.get?.(APP_ID)
    if (app && (touched || actor.type === "character")) app.render()
  })
}
Hooks.on("updateUser", () => scheduleReport())
// Clicking a secret's chat card opens its campaign page on Secrets.
Hooks.on("renderChatMessageHTML", (msg, html) => {
  if (!msg?.flags?.[MOD]?.secretCard) return
  const el = html instanceof HTMLElement ? html : html?.[0]
  el?.querySelector?.(".pb-secret-card")?.addEventListener("click", () => {
    const pages = readPages()
    const cid = msg.flags[MOD].campaignId || Object.keys(pages).find(id => visibleSecrets(pages[id], game.user.id, game.user.isGM).length)
    if (cid) openPage({ id: cid, name: pages[cid]?.overview?.name || "Campaign" }, { tab: "sec" })
  })
})
