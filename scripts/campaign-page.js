// ──────────────────────────────────────────────────────────────
// The campaign page — what the Campaigns button's "View details" opens, and what
// opens by itself for a campaign's players when its session starts.
//
// RealmScreen sends `campaigns.pages` (lib/foundryCampaignPages.js); the GM window
// stores it in the world setting `pendant-bridge.campaignPages`, so every client
// draws the same thing:
//
//   { [campaignId]: { overview: { name, date, played, running, lastTime, where,
//                                 party, people, coming },
//                     users: [Foundry user id],        // who is in the campaign
//                     secrets: [Secret], asks: [Ask], threads: [...], lastTime } }
//
// Two tabs: Overview and Secrets. A player sees the secrets given to them (and the
// ones shown to / revealed to the party); a GM sees all of them, who has read each,
// the players' questions, and "Give a secret". Everything done here goes back to
// RealmScreen as one `campaign.page` op (campaigns.js relay → the linked GM window),
// which decides, saves and re-sends the pages.
//
// A secret that is a place on the map is a real Map Note: the linked GM window keeps
// a JournalEntry per such secret (folder "RealmScreen secrets") owned by exactly the
// people who know it, and a Note on its scene — so Foundry itself hides it from
// everyone else (`syncSecretNotes`).
// ──────────────────────────────────────────────────────────────

import { relay } from "./campaigns.js"
import { linkedHere } from "./live.js"

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

// ── the setting ───────────────────────────────────────────────
const readPages = () => { try { return game.settings.get(MOD, KEY) || {} } catch { return {} } }

/** `campaigns.pages` (GM window): store, then keep the secret Map Notes true. */
export async function setPages(pages) {
  if (!game.user?.isGM) throw new Error("Only the GM can set the campaign pages")
  const clean = pages && typeof pages === "object" ? pages : {}
  await game.settings.set(MOD, KEY, clean)
  syncSecretNotes(clean).catch(e => console.warn(`${MOD} | secret notes`, e))
  return { ok: true }
}

/** `campaigns.whisper`: a chat card to these users (and the GMs). */
export async function whisperCampaign({ to, title, text, campaignId } = {}) {
  const ids = new Set(arr(to).filter(id => game.users?.get(id)))
  for (const u of game.users ?? []) if (u.isGM) ids.add(u.id)
  if (!ids.size) return { ok: false }
  await ChatMessage.create({
    speaker: { alias: "RealmScreen" },
    whisper: [...ids],
    content: `<div class="pb-secret-card"><h3><i class="fa-solid fa-key"></i> ${esc(title)}</h3>${text ? `<p>${escNl(text)}</p>` : ""}</div>`,
    flags: { [MOD]: { secretCard: true, campaignId: str(campaignId) || null } },
  })
  return { ok: true }
}

// ── secret Map Notes (linked GM window) ───────────────────────
let notesBusy = false
async function syncSecretNotes(pages) {
  if (!game.user?.isGM || !linkedHere() || notesBusy) return
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
      const ownership = { default: 0, ...Object.fromEntries(viewers.map(u => [u, 2])) }
      const content = `<p>${escNl(s.text || "")}</p>`
      let j = entries.get(id)
      if (!j) {
        j = await JournalEntry.create({ name: `🗝 ${s.title}`, folder: folder?.id ?? null, ownership, flags: { [MOD]: { secretId: id } },
          pages: [{ name: s.title, type: "text", text: { content } }] })
      } else {
        const same = JSON.stringify(j.ownership) === JSON.stringify(ownership) && j.name === `🗝 ${s.title}` && j.pages.contents[0]?.text?.content === content
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
        const data = { x: Math.round(w.s.place.x), y: Math.round(w.s.place.y), entryId: w.entry.id, text: w.s.title, global: true,
          texture: { src: "icons/svg/mystery-man.svg" }, iconSize: 40, flags: { [MOD]: { secretId: id } } }
        const n = have.get(id)
        if (!n) add.push(data)
        else if (n.x !== data.x || n.y !== data.y || n.text !== data.text || n.entryId !== data.entryId) upd.push({ _id: n.id, x: data.x, y: data.y, text: data.text, entryId: data.entryId })
      }
      if (add.length) await scene.createEmbeddedDocuments("Note", add)
      if (upd.length) await scene.updateEmbeddedDocuments("Note", upd)
    }
  } finally { notesBusy = false }
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

// ── the window ────────────────────────────────────────────────
const userName = (id) => { const u = game.users?.get(id); return u ? (u.character?.name || u.name) : "a player" }

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
      position: { width: 640, height: 720 },
      actions: {
        tab: CampaignPage.#tab,
        compose: CampaignPage.#compose, kind: CampaignPage.#kind, cancel: CampaignPage.#cancel, give: CampaignPage.#give,
        pickSpot: CampaignPage.#pickSpot, pickImage: CampaignPage.#pickImage, who: CampaignPage.#who,
        sendNow: CampaignPage.#simple, remove: CampaignPage.#remove, reveal: CampaignPage.#reveal, edit: CampaignPage.#edit,
        share: CampaignPage.#share, ask: CampaignPage.#ask, answer: CampaignPage.#answer, dropAsk: CampaignPage.#simple,
        panPlace: CampaignPage.#panPlace, panParty: CampaignPage.#panParty,
        editLast: CampaignPage.#editLast, saveLast: CampaignPage.#saveLast, editThreads: CampaignPage.#editThreads,
        addThread: CampaignPage.#addThread, dropThread: CampaignPage.#dropThread, saveThreads: CampaignPage.#saveThreads,
        toggleThread: CampaignPage.#toggleThread,
      },
    }
    tab = "over"
    comp = null           // the open "Give a secret" form
    lastDraft = null      // editing Last time…
    threadsDraft = null   // editing Open threads

    get title() { return this.options.campaign?.name || "Campaign" }
    get cid() { return this.options.campaign?.id }
    get page() { return readPages()[this.cid] || null }

    send(op, data = {}) { relay("campaign.page", { op, campaignId: this.cid, ...data }) }

    // Keep what's typed across re-renders (the setting changes under an open form).
    #keep() {
      const el = this.element
      if (!el) return
      const v = (sel) => el.querySelector(sel)?.value
      if (this.comp) {
        for (const [k, sel] of [["title", "[name=cTitle]"], ["text", "[name=cText]"], ["page", "[name=cPage]"], ["place", "[name=cWhere]"], ["days", "[name=cDays]"]]) {
          const x = v(sel); if (x !== undefined) this.comp[k === "place" ? "wherePlace" : k] = x
        }
        const how = el.querySelector("[name=cHow]:checked")?.value; if (how) this.comp.how = how
        const when = el.querySelector("[name=cWhen]:checked")?.value; if (when) this.comp.when = when
        const sh = el.querySelector("[name=cShare]"); if (sh) this.comp.share = sh.checked
      }
      if (this.lastDraft !== null) { const x = v("[name=lastText]"); if (x !== undefined) this.lastDraft = x }
      if (this.threadsDraft) {
        this.threadsDraft = [...el.querySelectorAll("[data-thread-row]")].map((row, i) => ({
          id: this.threadsDraft[i]?.id, text: row.querySelector("input[type=text]")?.value || "", done: !!row.querySelector("input[type=checkbox]")?.checked,
        }))
      }
      this.drafts = {}
      for (const t of el.querySelectorAll("textarea[data-draft]")) this.drafts[t.dataset.draft] = t.value
    }

    async _renderHTML() {
      this.#keep()
      const el = document.createElement("div")
      el.className = "pb-cp"
      const p = this.page
      if (!p) { el.innerHTML = `<p class="hint">RealmScreen hasn’t sent this campaign’s page yet. It does while it’s connected.</p>`; return el }
      const gm = !!game.user?.isGM, me = game.user?.id
      const o = p.overview || {}
      const vis = visibleSecrets(p, me, gm)
      const dot = !gm && unseenFor(p, me).length
      const sub = gm ? "You are the GM" : `${esc(game.user?.character?.name || game.user?.name)}`
      const sess = o.running ? `Session ${o.running.number ?? ""} <span class="pb-cp-live">running</span>` : `${o.played || 0} session${o.played === 1 ? "" : "s"} played`
      el.innerHTML = `
        <header class="pb-cp-hero">
          <div><h2>${esc(o.name || this.title)}</h2><div class="pb-cp-sub">${sub} · ${sess}</div></div>
          ${o.date ? `<div class="pb-cp-date"><span>${esc(o.name || "")}’s date</span><strong>${esc(o.date)}</strong></div>` : ""}
        </header>
        <nav class="tabs pb-cp-tabs">
          <a class="item ${this.tab === "over" ? "active" : ""}" data-action="tab" data-tab="over"><i class="fa-solid fa-house"></i> Overview</a>
          <a class="item ${this.tab === "sec" ? "active" : ""}" data-action="tab" data-tab="sec"><i class="fa-solid fa-key"></i> Secrets (${vis.length})${dot ? `<span class="pb-cp-dot"></span>` : ""}</a>
        </nav>
        <section class="pb-cp-body">${this.tab === "over" ? this.#overview(p, gm) : this.#secrets(p, vis, gm, me)}</section>`
      return el
    }
    _replaceHTML(result, content) { content.replaceChildren(result) }

    _onRender() {
      // Opening the Secrets tab is reading them.
      const p = this.page
      if (this.tab === "sec" && p && !game.user?.isGM) {
        const ids = unseenFor(p, game.user.id).map(s => s.id)
        if (ids.length && !this.#seenSent?.has(ids.join())) { (this.#seenSent ??= new Set()).add(ids.join()); this.send("seen", { ids }) }
      }
    }
    #seenSent = null

    // ── Overview ──
    #overview(p, gm) {
      const o = p.overview || {}
      const blocks = []
      const lt = o.lastTime
      if (this.lastDraft !== null) {
        blocks.push(`<fieldset class="pb-cp-blk wide"><legend>Last time…</legend>
          <textarea name="lastText" rows="4">${esc(this.lastDraft)}</textarea>
          <div class="pb-cp-row end"><button type="button" data-action="saveLast" data-use="recap">Use the recap</button><button type="button" data-action="editLast" data-off="1">Cancel</button><button type="button" data-action="saveLast"><i class="fa-solid fa-check"></i> Save</button></div></fieldset>`)
      } else if (lt || gm) {
        blocks.push(`<fieldset class="pb-cp-blk wide"><legend>Last time…${lt?.label ? ` <span class="pb-cp-r">${esc(lt.label)}</span>` : ""}</legend>
          ${lt ? `<p>${escNl(lt.text)}</p>` : `<p class="hint">No shared recap yet. Write one here, or share a session recap in RealmScreen.</p>`}
          ${gm ? `<div class="pb-cp-row end"><button type="button" data-action="editLast"><i class="fa-solid fa-pen"></i> Edit</button></div>` : ""}</fieldset>`)
      }
      if (o.where) {
        const tok = partyToken(this.cid)
        blocks.push(`<fieldset class="pb-cp-blk wide"><legend>Where we are</legend><p><i class="fa-solid fa-location-crosshairs"></i> ${esc(o.where.text)}</p>
          ${tok ? `<div class="pb-cp-row end"><button type="button" data-action="panParty"><i class="fa-solid fa-map"></i> Show on the map</button></div>` : ""}</fieldset>`)
      }
      const th = arr(p.threads)
      if (this.threadsDraft) {
        blocks.push(`<fieldset class="pb-cp-blk"><legend>Open threads</legend>
          ${this.threadsDraft.map((t, i) => `<div class="pb-cp-row" data-thread-row><input type="checkbox" ${t.done ? "checked" : ""} title="Done"><input type="text" value="${esc(t.text)}" placeholder="A quest or goal"><a data-action="dropThread" data-i="${i}" title="Remove"><i class="fa-solid fa-xmark"></i></a></div>`).join("")}
          <div class="pb-cp-row end"><button type="button" data-action="addThread"><i class="fa-solid fa-plus"></i> Add</button><button type="button" data-action="editThreads" data-off="1">Cancel</button><button type="button" data-action="saveThreads"><i class="fa-solid fa-check"></i> Save</button></div></fieldset>`)
      } else if (th.length || gm) {
        blocks.push(`<fieldset class="pb-cp-blk"><legend>Open threads</legend>
          ${th.length ? `<ul class="pb-cp-threads">${th.map((t, i) => `<li class="${t.done ? "done" : ""}">${gm ? `<input type="checkbox" ${t.done ? "checked" : ""} data-action="toggleThread" data-i="${i}">` : ""}${esc(t.text)}</li>`).join("")}</ul>` : `<p class="hint">Nothing listed yet.</p>`}
          ${gm ? `<div class="pb-cp-row end"><button type="button" data-action="editThreads"><i class="fa-solid fa-pen"></i> Edit</button></div>` : ""}</fieldset>`)
      }
      if (arr(o.coming).length) {
        blocks.push(`<fieldset class="pb-cp-blk"><legend>Coming up</legend>${o.coming.map(c => `<div class="pb-cp-row"><span>${esc(c.name)}</span><span class="pb-cp-r">${esc(c.rel)}</span></div>`).join("")}</fieldset>`)
      }
      if (arr(o.party).length) {
        blocks.push(`<fieldset class="pb-cp-blk wide"><legend>The party</legend><div class="pb-cp-party">${o.party.map(c => `
          <div class="pb-cp-person${c.away ? " away" : ""}">${c.cover ? `<img src="${esc(c.cover)}" alt="">` : `<span class="pb-cp-ini">${esc((c.name || "?")[0])}</span>`}
          <div><strong>${esc(c.name)}</strong><small>${esc([c.sub, c.player].filter(Boolean).join(" · "))}${c.away ? " · away" : ""}</small></div></div>`).join("")}</div></fieldset>`)
      }
      if (arr(o.people).length) {
        blocks.push(`<fieldset class="pb-cp-blk"><legend>People we’ve met</legend>${o.people.map(c => `
          <div class="pb-cp-row">${c.cover ? `<img class="pb-cp-av" src="${esc(c.cover)}" alt="">` : `<span class="pb-cp-ini sm">${esc((c.name || "?")[0])}</span>`}<span>${esc(c.name)}</span><span class="pb-cp-r">${esc(c.line)}</span></div>`).join("")}</fieldset>`)
      }
      return `<div class="pb-cp-grid">${blocks.join("")}</div>`
    }

    // ── Secrets ──
    #secrets(p, vis, gm, me) {
      const card = (s) => {
        const acts = []
        if (s.kind === "place" && s.place) acts.push(`<button type="button" data-action="panPlace" data-id="${esc(s.id)}"><i class="fa-solid fa-location-dot"></i> Show on map</button>`)
        if (!gm && s.share && arr(s.to).includes(me) && !arr(s.shown).some(x => x.id === me) && !s.revealed) acts.push(`<button type="button" data-action="share" data-id="${esc(s.id)}"><i class="fa-solid fa-users"></i> Show the party…</button>`)
        if (gm) {
          if (s.state === "waiting") acts.push(`<button type="button" data-action="sendNow" data-op="sendNow" data-id="${esc(s.id)}"><i class="fa-solid fa-paper-plane"></i> Send now</button>`)
          if (!s.revealed) acts.push(`<button type="button" data-action="reveal" data-id="${esc(s.id)}"><i class="fa-solid fa-bullhorn"></i> Reveal to all…</button>`)
          acts.push(`<button type="button" data-action="edit" data-id="${esc(s.id)}"><i class="fa-solid fa-pen"></i> Edit</button>`,
            `<button type="button" data-action="remove" data-id="${esc(s.id)}"><i class="fa-solid fa-rotate-left"></i> Take back</button>`)
        }
        const meta = gm
          ? [`To: ${arr(s.to).map(id => esc(s.toNames?.[id] || userName(id))).join(", ")}`,
              s.state === "waiting" ? `<span class="pb-cp-wait">waiting · ${esc(String(s.when?.label || "").toLowerCase())}</span>`
                : arr(s.to).map(id => `<span class="${arr(s.seen).includes(id) ? "pb-cp-seen" : "pb-cp-unseen"}">${arr(s.seen).includes(id) ? "✓" : "○"} ${esc(s.toNames?.[id] || userName(id))}</span>`).join(" "),
              s.given?.label ? `Given: ${esc(s.given.label)}` : ""]
          : [esc(whoLine(s, me, (id) => s.toNames?.[id] || userName(id))), s.given?.label ? `Learned: ${esc(s.given.label)}` : ""]
        const isNew = !gm && !arr(s.seen).includes(me)
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
        const asks = arr(p.asks)
        return `<div class="pb-cp-row"><span class="hint">${list.length} secret${list.length === 1 ? "" : "s"} · who knows what</span>${this.comp ? "" : `<button type="button" class="pb-cp-push" data-action="compose"><i class="fa-solid fa-key"></i> Give a secret</button>`}</div>
          ${this.comp ? this.#composer(p) : ""}
          ${asks.length ? `<fieldset class="pb-cp-blk"><legend>Questions from players</legend>${asks.map(a => `
            <div class="pb-cp-ask"><strong>${esc(a.name || userName(a.from))}</strong> asks: ${escNl(a.text)}
            <textarea data-draft="ans-${esc(a.id)}" rows="2" placeholder="Your answer. It reaches them as a secret.">${esc(this.drafts?.["ans-" + a.id] || "")}</textarea>
            <div class="pb-cp-row end"><button type="button" data-action="dropAsk" data-op="dropAsk" data-ask="${esc(a.id)}">Dismiss</button><button type="button" data-action="answer" data-ask="${esc(a.id)}"><i class="fa-solid fa-reply"></i> Answer</button></div></div>`).join("")}</fieldset>` : ""}
          <div class="pb-cp-secs">${list.map(card).join("") || `<p class="hint">No secrets yet.</p>`}</div>`
      }
      return `<p class="hint">Things you know that the others might not.</p>
        <div class="pb-cp-secs">${list.map(card).join("") || `<p class="hint">No secrets yet.</p>`}</div>
        <fieldset class="pb-cp-blk"><legend>Ask the GM, privately</legend>
          <textarea data-draft="ask" rows="2" placeholder="Only the GM sees this.">${esc(this.drafts?.ask || "")}</textarea>
          <div class="pb-cp-row end"><button type="button" data-action="ask"><i class="fa-solid fa-paper-plane"></i> Send</button></div></fieldset>`
    }

    #composer(p) {
      const c = this.comp
      const users = arr(p.users)
      const radio = (name, val, label, on) => `<label class="pb-cp-opt"><input type="radio" name="${name}" value="${val}" ${on ? "checked" : ""}> ${label}</label>`
      const editing = !!c.id
      return `<fieldset class="pb-cp-blk pb-cp-comp"><legend>${editing ? "Edit secret" : "Give a secret"}</legend>
        <div class="form-group"><label>What</label><div class="pb-cp-opts">${Object.keys(KIND_NAME).map(k => `<button type="button" class="${c.kind === k ? "active" : ""}" data-action="kind" data-kind="${k}" ${editing ? "disabled" : ""}><i class="fa-solid ${KIND_ICON[k]}"></i> ${KIND_NAME[k]}</button>`).join("")}</div></div>
        <div class="form-group"><label>Title</label><input type="text" name="cTitle" value="${esc(c.title || "")}" placeholder="e.g. The cellar door"></div>
        <div class="form-group"><label>To</label><div class="pb-cp-opts">${users.map(id => `<button type="button" class="${c.to.includes(id) ? "active" : ""}" data-action="who" data-user="${esc(id)}">${esc(userName(id))}</button>`).join("")}
          <button type="button" class="${users.length && users.every(id => c.to.includes(id)) ? "active" : ""}" data-action="who" data-user="*">Whole party</button></div>
          ${users.length ? "" : `<p class="hint">RealmScreen doesn’t know which Foundry accounts play this campaign yet (Players page).</p>`}</div>
        ${c.kind === "page" ? `<div class="form-group"><label>Which page</label><input type="text" name="cPage" value="${esc(c.page || "")}" placeholder="The page’s name in RealmScreen, e.g. Captain Dorn"></div>` : ""}
        ${c.kind === "pic" ? `<div class="form-group"><label>Picture</label><div class="pb-cp-row">${c.img ? `<img class="pb-cp-av" src="${esc(c.img)}" alt="">` : ""}<button type="button" data-action="pickImage"><i class="fa-solid fa-file-image"></i> ${c.img ? "Change" : "Choose"}…</button></div></div>` : ""}
        ${c.kind === "place" ? `<div class="form-group"><label>Spot</label><div class="pb-cp-row"><span class="hint">${c.place ? `${esc(c.place.sceneName || "This scene")} · placed` : "Not placed yet"}</span><button type="button" data-action="pickSpot"><i class="fa-solid fa-location-dot"></i> ${c.place ? "Move" : "Pick a spot on this scene"}</button></div></div>` : ""}
        <div class="form-group stacked"><label>${c.kind === "pic" ? "What it says (optional)" : c.kind === "page" ? "What they learn from it (optional)" : "What they learn"}</label><textarea name="cText" rows="3" placeholder="Write it the way they’d hear it">${esc(c.text || "")}</textarea></div>
        ${editing ? "" : `<div class="form-group"><label>When</label><div class="pb-cp-opts col">
          ${radio("cWhen", "now", "Now", c.when === "now")}
          ${radio("cWhen", "session", "When the next session starts", c.when === "session")}
          <label class="pb-cp-opt"><input type="radio" name="cWhen" value="place" ${c.when === "place" ? "checked" : ""}> When they reach <input type="text" name="cWhere" value="${esc(c.wherePlace || "")}" placeholder="a town" class="pb-cp-in"></label>
          <label class="pb-cp-opt"><input type="radio" name="cWhen" value="date" ${c.when === "date" ? "checked" : ""}> In <input type="number" name="cDays" min="1" value="${esc(c.days || "3")}" class="pb-cp-in num"> days on the campaign’s calendar</label></div></div>`}
        <div class="form-group"><label>How</label><div class="pb-cp-opts col">
          ${radio("cHow", "whisper", "A whisper card in their chat", c.how !== "quiet")}
          ${radio("cHow", "quiet", "Quietly (a dot on their Secrets tab)", c.how === "quiet")}
          <label class="pb-cp-opt"><input type="checkbox" name="cShare" ${c.share ? "checked" : ""}> They may show it to the party</label></div></div>
        <footer class="pb-cp-row end"><button type="button" data-action="cancel">Cancel</button><button type="button" class="pb-cp-push" data-action="give"><i class="fa-solid fa-key"></i> ${editing ? "Save" : "Give secret"}</button></footer>
      </fieldset>`
    }

    // ── actions (`this` = the window) ──
    static #tab(e, t) { this.tab = t.dataset.tab; this.render() }
    static #compose() { this.comp = { kind: "note", title: "", text: "", to: [], when: "now", how: "whisper", share: false, days: "3" }; this.render() }
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
        ev.stopPropagation(); ev.preventDefault()
        done()
        if (ev.button !== 0) return
        const pt = canvas.canvasCoordinatesFromClient
          ? canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY })
          : canvas.stage.worldTransform.applyInverse({ x: ev.clientX, y: ev.clientY })
        this.comp.place = { sceneId: canvas.scene.id, sceneName: canvas.scene.name, x: Math.round(pt.x), y: Math.round(pt.y) }
        this.render()
      }
      const tm = setTimeout(done, 30000)
      view.addEventListener("pointerdown", on, true)
    }
    static #give() {
      this.#keep()
      const c = this.comp
      if (!c.to.length) return ui.notifications?.warn("Pick who gets it.")
      const secret = {
        id: c.id, kind: c.kind, title: str(c.title), text: str(c.text), to: c.to, img: c.img || null, place: c.place || null,
        page: c.kind === "page" ? { name: str(c.page) } : null,
        when: { kind: c.when, place: str(c.wherePlace), days: Number(c.days) }, how: c.how, share: !!c.share,
      }
      this.send(c.id ? "edit" : "give", { secret })
      this.comp = null
      this.render()
    }
    static #simple(e, t) { this.send(t.dataset.op, { id: t.dataset.id, askId: t.dataset.ask }) }
    static async #remove(e, t) {
      const s = arr(this.page?.secrets).find(x => x.id === t.dataset.id)
      const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Take back" }, content: `<p>Take back <strong>${esc(s?.title)}</strong>? It’s gone for everyone, as if it was never given.</p>`, rejectClose: false })
      if (ok) this.send("remove", { id: t.dataset.id })
    }
    static async #reveal(e, t) {
      const s = arr(this.page?.secrets).find(x => x.id === t.dataset.id)
      const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Reveal to all" }, content: `<p>Show <strong>${esc(s?.title)}</strong> to the whole party? Their chat gets a card saying who knew all along.</p>`, rejectClose: false })
      if (ok) this.send("reveal", { id: t.dataset.id })
    }
    static #edit(e, t) {
      const s = arr(this.page?.secrets).find(x => x.id === t.dataset.id)
      if (!s) return
      this.comp = { id: s.id, kind: s.kind, title: s.title, text: s.text, to: arr(s.to).slice(), img: s.img, place: s.place, page: s.page?.name || "", how: s.how, share: s.share, when: s.when?.kind || "now" }
      this.render()
    }
    static async #share(e, t) {
      const s = arr(this.page?.secrets).find(x => x.id === t.dataset.id)
      const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Show the party" }, content: `<p>Show <strong>${esc(s?.title)}</strong> to the rest of the party? You can’t take it back.</p>`, rejectClose: false })
      if (ok) this.send("share", { id: t.dataset.id })
    }
    static #ask() {
      this.#keep()
      const text = str(this.drafts?.ask)
      if (!text) return
      this.send("ask", { text })
      this.element.querySelector("textarea[data-draft=ask]").value = ""
      this.drafts.ask = ""
    }
    static #answer(e, t) {
      this.#keep()
      const text = str(this.drafts?.["ans-" + t.dataset.ask])
      if (!text) return ui.notifications?.warn("Write the answer first.")
      this.send("answer", { askId: t.dataset.ask, text })
    }
    static #panPlace(e, t) {
      const s = arr(this.page?.secrets).find(x => x.id === t.dataset.id)
      if (s?.place) panTo(s.place.sceneId, s.place.x, s.place.y)
    }
    static #panParty() {
      const tok = partyToken(this.cid)
      if (tok) canvas.animatePan({ x: tok.center.x, y: tok.center.y })
    }
    static #editLast(e, t) { this.lastDraft = t.dataset.off ? null : (this.page?.lastTime || this.page?.overview?.lastTime?.text || ""); this.render() }
    static #saveLast(e, t) {
      this.#keep()
      this.send("lastTime", { text: t.dataset.use === "recap" ? "" : str(this.lastDraft) })
      this.lastDraft = null
      this.render()
    }
    static #editThreads(e, t) { this.threadsDraft = t.dataset.off ? null : arr(this.page?.threads).map(x => ({ ...x })); if (this.threadsDraft && !this.threadsDraft.length) this.threadsDraft.push({ text: "", done: false }); this.render() }
    static #addThread() { this.#keep(); this.threadsDraft.push({ text: "", done: false }); this.render() }
    static #dropThread(e, t) { this.#keep(); this.threadsDraft.splice(Number(t.dataset.i), 1); this.render() }
    static #saveThreads() { this.#keep(); this.send("threads", { threads: this.threadsDraft.filter(x => str(x.text)) }); this.threadsDraft = null; this.render() }
    static #toggleThread(e, t) {
      const list = arr(this.page?.threads).map(x => ({ ...x }))
      const i = Number(t.dataset.i)
      if (list[i]) { list[i].done = !!t.checked; this.send("threads", { threads: list }) }
    }
  }
  return PageClass
}

/** Open (or bring forward) a campaign's page. */
export function openPage(campaign, { tab } = {}) {
  const C = pageClass()
  if (!C) return ui.notifications?.info(campaign.name)
  const open = foundry.applications.instances?.get?.(APP_ID)
  if (open) {
    if (open.options.campaign?.id !== campaign.id) { open.comp = null; open.lastDraft = null; open.threadsDraft = null }
    open.options.campaign = campaign
    if (tab) open.tab = tab
    open.render({ force: true, window: { title: campaign.name } })
    return open.bringToFront?.()
  }
  const app = new C({ campaign })
  if (tab) app.tab = tab
  app.render({ force: true })
}

function rerender() { foundry?.applications?.instances?.get?.(APP_ID)?.render() }

// ── hooks ─────────────────────────────────────────────────────
Hooks.once("init", () => {
  game.settings.register(MOD, KEY, { scope: "world", config: false, type: Object, default: {}, onChange: () => rerender() })
})
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
