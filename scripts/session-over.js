// ──────────────────────────────────────────────────────────────
// Session Over — the end-of-session window in Foundry (pendant-home
// _handoffs/session-over-plan.md, workstream C).
//
// RealmScreen owns the panel; Foundry draws it and sends the GM's changes back.
//
//   RealmScreen → `sessionover.set` { sessionId, open, gm: View, players: PlayerView }
//       open: true when a game has just ENDED (the window pops up), false = refresh only.
//   bridge → `sessionover.get` { qid, sessionId?, userId, gm }  (no sessionId = the last ended game)
//   bridge → `sessionover.update` { qid, sessionId, userId, gm, change }   (GM only)
//   RealmScreen → `sessionover.answer` { qid, userId, view | error }
//   bridge → `sessionover.closed` { sessionId, userId }   a GM closed the window a game's END popped up;
//       RealmScreen holds its own Session Over + Recap until then (main.js lists the command so it knows).
//
// Privacy (the campaign page's rules, scripts/private.js): nothing goes in a world setting or
// a module socket message. The GM view is a hidden chat message WHISPERED TO GMs; the players'
// copy is a hidden message whispered ONLY to that campaign's players (RealmScreen's roster),
// rebuilt here from an allow-list (session-over-model.js `forPlayer`: Public lines only, no
// rations, no edited flags). Foundry's server only delivers a whisper to its recipients, so a
// DM line never reaches a player's client. A GM in a window that doesn't hold the RealmScreen
// link asks through a whisper to the GMs (Foundry stamps the real author; a player's ask is
// thrown away); the answer comes back as the GM message itself, never over the socket.
//
// The window: a native ApplicationV2 (Foundry's own header, fieldsets, form-groups, theme).
// Laid out like the app's panel: party circles · Stats | Awarded · Map (route strip with a
// small time-lapse of the party dot) · Recap by day · Met · (GM) Rations. Players get the same
// window read-only. Reopen: the realm menu's "Session over" box (realm-menu.js).
// ──────────────────────────────────────────────────────────────

import { linkedHere, realmLive } from "./live.js"
import { mySlice } from "./private.js"
import { applyTheme } from "./campaign-page.js"
import { rationStacks, planTake, planRows } from "./rations.js"
import {
  esc, fmt, plural, moneyLabel, parseMoney, forPlayer, dayBlocks, stripOf, lapseOf, mapOf, lapsePlan, lapseAt,
  findActorFor, rationMembers, rationN, recipientsOf, opAllowed,
} from "./session-over-model.js"

const MOD = "pendant-bridge"
const CHANNEL = `module.${MOD}`
const APP_ID = "pb-session-over"
const ASK_MS = 20000
const OPEN_FRESH_MS = 30 * 60 * 1000        // a pop-up older than this (a reload later) doesn't pop again
const RATION_OPT = { pendantBridge: "session-over-rations" }   // item-watch marks it `skip`: no capture, no guard

let sender = null
/** main.js hands over its send (only the linked window's reaches RealmScreen). */
export function setSessionOverSender(fn) { sender = typeof fn === "function" ? fn : null }

const arr = (v) => (Array.isArray(v) ? v : [])
const flagsOf = (m) => m?.flags?.[MOD] || {}
const gmIds = () => (game.users?.filter(u => u.isGM) ?? []).map(u => u.id)
const isGM = () => !!game.user?.isGM
const newId = (p) => `${p}${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`

// ── the stored copies (hidden whispers) ───────────────────────
//   flags[MOD] = { hidden: true, so: { key: "gm" | "p:<campaignId>", sessionId, json, at, openAt?, taken? } }
const soOf = (m) => flagsOf(m).so || null
const soMsg = (key) => game.messages?.find(m => soOf(m)?.key === key) || null
const parse = (m) => { try { return JSON.parse(soOf(m)?.json || "null") } catch { return null } }

/** What THIS user may open: { role, view, msg } or null. GMs: the GM copy. Players: their latest. */
function mine() {
  if (isGM()) { const m = soMsg("gm"); const v = m && parse(m); return v ? { role: "gm", view: v, msg: m } : null }
  const me = game.user?.id
  const list = (game.messages?.filter(m => String(soOf(m)?.key || "").startsWith("p:") && arr(m.whisper).includes(me)) ?? [])
    .sort((a, b) => (soOf(b).at || 0) - (soOf(a).at || 0))
  const v = list[0] && parse(list[0])
  return v ? { role: "player", view: forPlayer(v), msg: list[0] } : null
}

async function write(key, whisper, sessionId, view, { open = false } = {}) {
  const json = JSON.stringify(view)
  const at = Date.now()
  const msg = soMsg(key)
  if (msg) {
    const f = soOf(msg)
    if (f.json === json && !open && f.sessionId === sessionId) return
    const upd = { whisper, [`flags.${MOD}.so.json`]: json, [`flags.${MOD}.so.sessionId`]: sessionId, [`flags.${MOD}.so.at`]: at }
    if (open) upd[`flags.${MOD}.so.openAt`] = at
    await msg.update(upd)
  } else {
    await ChatMessage.create({ speaker: { alias: "Session over" }, content: "", whisper,
      flags: { [MOD]: { hidden: true, so: { key, sessionId, json, at, ...(open ? { openAt: at } : {}) } } } })
  }
}

/** `sessionover.set` (the linked GM window). */
export async function setSessionOver(msg = {}) {
  if (!isGM()) throw new Error("Only the GM window takes the Session Over panel")
  const view = msg.gm && typeof msg.gm === "object" ? msg.gm : null
  const sessionId = String(msg.sessionId || view?.sessionId || "")
  if (!view || !sessionId) return { ok: false }
  const open = !!msg.open
  await write("gm", gmIds(), sessionId, view, { open })
  // The players' copy: that campaign's players only (none known → nobody, never everyone).
  let players = 0
  const cid = view.campaignId
  if (cid) {
    const to = recipientsOf(mySlice().roster, cid, game.users?.contents ?? [...(game.users ?? [])])
    const pv = forPlayer(msg.players && typeof msg.players === "object" ? msg.players : view)
    const had = soMsg(`p:${cid}`)
    if (to.length) { await write(`p:${cid}`, to, sessionId, pv, { open }); players = to.length }
    else if (had) await had.delete()
  }
  return { ok: true, players }
}

// ── asking RealmScreen ─────────────────────────────────────────
const pending = new Map()
function settle(qid, body) {
  const p = pending.get(qid)
  if (!p) return
  pending.delete(qid); clearTimeout(p.timer)
  if (body?.error) p.reject(new Error(body.error)); else p.resolve(body || {})
}
/** GM only: `get` / `update`. → { view } (the GM view) */
function ask(kind, payload) {
  return new Promise((resolve, reject) => {
    if (!isGM()) { reject(new Error("Only the GM can change this.")); return }
    if (!realmLive()) { reject(new Error("RealmScreen isn’t connected.")); return }
    const qid = `${game.user.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const timer = setTimeout(() => { pending.delete(qid); reject(new Error("RealmScreen didn’t answer.")) }, ASK_MS)
    pending.set(qid, { resolve, reject, timer })
    if (linkedHere() && sender) sender({ type: `sessionover.${kind}`, ...payload, qid, userId: game.user.id, gm: true })
    else ChatMessage.create({ speaker: { alias: "Session over" }, content: "", whisper: gmIds(),
      flags: { [MOD]: { hidden: true, soOp: { kind, qid, data: payload } } } }).catch(e => settle(qid, { error: e.message || String(e) }))
  })
}

// The linked window: a GM's ask from another window → RealmScreen. Foundry stamps the author.
async function passOp(m) {
  if (!isGM() || !linkedHere() || !sender) return
  const op = flagsOf(m).soOp
  const author = m.author ?? game.users?.get(m.user)
  if (op && author?.isGM && opAllowed(op.kind) && Date.now() - (m.timestamp || 0) < 60000) {
    const { qid: _q, userId: _u, gm: _g, type: _t, ...data } = op.data && typeof op.data === "object" ? op.data : {}
    sender({ type: `sessionover.${op.kind}`, ...data, ...(op.qid ? { qid: op.qid } : {}), userId: author.id, gm: true })
  }
  try { await m.delete() } catch { /* another GM got it */ }
}

/** `sessionover.answer` (reaches only the linked window). The view goes into the GM copy (GMs
 *  only); the asker in another window gets just "done" over the socket, then reads that copy. */
export async function sessionOverAnswer(msg = {}) {
  const { qid, userId, view, error } = msg
  if (!qid) return { ok: false }
  const asker = userId ? game.users?.get(userId) : game.user
  if (view && asker?.isGM && view.sessionId) { try { await write("gm", gmIds(), view.sessionId, view) } catch (e) { console.warn(`${MOD} | session over`, e) } }
  if (!userId || userId === game.user?.id) settle(qid, error ? { error } : { view })
  else { try { game.socket?.emit(CHANNEL, { t: "so.ans", to: userId, qid, ...(error ? { error: String(error) } : { ok: true }) }) } catch { /* */ } }
  return { ok: true }
}

// ── rations ───────────────────────────────────────────────────
const actorsList = () => game.actors?.contents ?? [...(game.actors ?? [])]
function rationPreview(view, n) {
  const { members, missing } = rationMembers(view.party, actorsList(), rationStacks)
  return { plan: planTake(members, n), missing }
}
const takenKey = (id) => String(id || "").replace(/[^\w-]/g, "_")
const takenOf = (view, msg) => view?.rations?.takenAt || soOf(msg)?.taken?.[takenKey(view?.sessionId)]?.at || null

async function applyRations(app) {
  const view = app.view, n = rationN(app.ratN)
  if (!isGM() || !view || !n) return
  const taken = takenOf(view, soMsg("gm"))
  if (taken) {
    const D = foundry.applications.api.DialogV2
    const again = await D.confirm({ window: { title: "Remove rations again?" },
      content: `<p>Rations were already removed for this session (${esc(new Date(taken).toLocaleString())}). Remove ${n} more from each who came?</p>`,
      rejectClose: false }).catch(() => false)
    if (!again) return
  }
  const { plan, missing } = rationPreview(view, n)
  for (const p of plan) {
    if (!p.updates.length) continue
    try { await game.actors.get(p.id).updateEmbeddedDocuments("Item", p.updates, RATION_OPT) } catch (e) { console.warn(`${MOD} | session over rations`, p.name, e); p.failed = true }
  }
  const at = Date.now()
  // Recorded twice: in RealmScreen (the panel's own record) and on the GM copy here (in case RealmScreen is away).
  try { const gm = soMsg("gm"); if (gm) await gm.update({ [`flags.${MOD}.so.taken.${takenKey(view.sessionId)}`]: { n, at } }) } catch { /* */ }
  ask("update", { sessionId: view.sessionId, change: { op: "rations", n, takenAt: at } }).then(r => { if (r.view) app.setView(r.view) }).catch(e => ui.notifications?.warn(`Rations removed in Foundry, but RealmScreen didn’t note it: ${e.message}`))
  const short = plan.filter(p => p.short), failed = plan.filter(p => p.failed)
  try {
    await ChatMessage.create({ speaker: { alias: "Session over" }, whisper: gmIds(),
      content: `<div class="pb-rat-chat"><p><strong>${n} ration${n === 1 ? "" : "s"}</strong> removed from each who came${view.campaignName ? ` (${esc(view.campaignName)})` : ""}.</p>`
        + `<table class="pb-rat-table"><tbody>${planRows(plan)}</tbody></table>`
        + (missing.length ? `<p>No Foundry character: ${missing.map(esc).join(", ")}.</p>` : "")
        + (failed.length ? `<p>Couldn't change: ${failed.map(p => esc(p.name)).join(", ")}.</p>` : "") + `</div>` })
  } catch { /* chat is a courtesy */ }
  if (short.length) ui.notifications?.warn(`Ran short: ${short.map(p => `${p.name} (${p.short})`).join(", ")}`)
  else ui.notifications?.info(`Removed ${n} ration${n === 1 ? "" : "s"} from everyone who came.`)
  app.render()
}

// ── drawing ───────────────────────────────────────────────────
const tokenOf = (p) => { const a = findActorFor(p, actorsList()); return a ? (a.prototypeToken?.texture?.src || a.img || "") : "" }
const initial = (s) => esc((String(s || "?").trim()[0] || "?").toUpperCase())
const reduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches } catch { return false } }

function partyHtml(v, gm) {
  if (!arr(v.party).length) return `<p class="hint">No players on this campaign.</p>`
  return v.party.map(p => {
    // big = the character token, small badge = the player's Discord picture (the user, 2026-11-18)
    const tok = tokenOf(p), face = tok || p.discordAvatar
    const tip = `${p.name} — ${p.attended ? "came" : "away"}${gm && p.edited ? " (set by you · right-click: back to auto)" : ""}${gm ? ". Click to change." : ""}`
    const inner = `<span class="pb-so-face">${face ? `<img src="${esc(face)}" alt="">` : `<span class="pb-so-ini">${initial(p.name)}</span>`}`
      + `${p.discordAvatar && tok ? `<img class="pb-so-badge" src="${esc(p.discordAvatar)}" alt="">` : ""}</span><span class="pb-so-pname">${esc(p.name)}</span>`
    const cls = `pb-so-pc${p.attended ? "" : " away"}${p.edited ? " edited" : ""}`
    return gm
      ? `<button type="button" class="${cls}" data-action="attend" data-key="${esc(p.key)}" aria-pressed="${p.attended}" data-tooltip="${esc(tip)}">${inner}</button>`
      : `<div class="${cls}" data-tooltip="${esc(tip)}">${inner}</div>`
  }).join("")
}

function numRow(label, item, gm, { op, field = "", step = 1, autoText } = {}) {
  const val = item?.value ?? 0
  if (!gm) return `<div class="form-group pb-so-num"><label>${label}</label><div class="form-fields"><strong>${esc(fmt(val))}</strong></div></div>`
  return `<div class="form-group pb-so-num"><label>${label}</label><div class="form-fields">`
    + `<input type="number" min="0" step="${step}" value="${esc(fmt(val))}" data-op="${op}" data-field="${field}">`
    + (item?.edited ? `<button type="button" class="icon fa-solid fa-rotate-left" data-action="reset" data-op="${op}" data-field="${field}" data-tooltip="${esc(`Back to worked out (${autoText ?? fmt(item.auto)})`)}" aria-label="Back to worked out"></button>` : `<span class="pb-so-gap"></span>`)
    + `</div></div>`
}

function awardedHtml(v, gm) {
  const a = v.awarded || {}, t = a.training || {}, rate = t.rate || {}
  const came = arr(v.party).filter(p => p.attended).length
  let h = numRow("Training rolls", t, gm, { op: "training" })
  if (gm) h += `<p class="hint">${rate.days ? `${esc(plural(rate.days, "day"))} = ${esc(fmt(rate.rolls))} · each of ${came} who came` : "No rate set — RealmScreen › Campaigns › Time."}</p>`
  const money = moneyLabel(a.money?.value)
  h += gm
    ? `<div class="form-group pb-so-num"><label>Money</label><div class="form-fields"><input type="text" value="${esc(money)}" placeholder="none" data-op="money">`
      + (a.money?.edited ? `<button type="button" class="icon fa-solid fa-rotate-left" data-action="reset" data-op="money" data-tooltip="${esc(`Back to worked out (${moneyLabel(a.money.auto) || "none"})`)}" aria-label="Back to worked out"></button>` : `<span class="pb-so-gap"></span>`) + `</div></div>`
    : `<div class="form-group pb-so-num"><label>Money</label><div class="form-fields"><strong>${esc(money || "none")}</strong></div></div>`
  const who = arr(v.party).map(p => p.name)
  const items = arr(a.misc).map(it => {
    const tip = it.to ? `To ${it.to}` : "Not given to anyone yet"
    const name = `${esc(it.name)}${it.qty > 1 ? ` ×${esc(it.qty)}` : ""}`
    if (!gm) return `<li class="pb-so-item" data-tooltip="${esc(tip)}">${it.img ? `<img src="${esc(it.img)}" alt="">` : ""}<span>${name}</span></li>`
    return `<li class="pb-so-item" data-tooltip="${esc(tip)}">${it.img ? `<img src="${esc(it.img)}" alt="">` : ""}<span>${name}</span>`
      + `<select data-op="item.to" data-id="${esc(it.id)}" aria-label="Who got ${esc(it.name)}"><option value="">Nobody</option>${who.map(n => `<option value="${esc(n)}" ${n === it.to ? "selected" : ""}>${esc(n)}</option>`).join("")}${it.to && !who.includes(it.to) ? `<option selected>${esc(it.to)}</option>` : ""}</select>`
      + `<button type="button" class="icon fa-solid fa-xmark" data-action="itemHide" data-id="${esc(it.id)}" data-tooltip="${it.from === "dm" ? "Remove" : "Leave off"}" aria-label="Leave off"></button></li>`
  }).join("")
  h += `<div class="pb-so-misc"><label>Misc</label><ul class="pb-so-items">${items || (gm ? "" : `<li class="hint">Nothing.</li>`)}</ul>`
  if (gm) {
    h += `<input type="text" placeholder="+ item" data-op="item.add" aria-label="Add an item">`
    const hidden = arr(a.hiddenItems)
    if (hidden.length) h += `<p class="hint">Left off: ${hidden.map(it => `<a data-action="itemShow" data-id="${esc(it.id)}" data-tooltip="Put back">${esc(it.name)}</a>`).join(", ")}</p>`
  }
  return h + `</div>`
}

function stripHtml(legs) {
  const { W, H, pts } = stripOf(legs)
  if (!pts.length) return `<p class="hint pb-so-noroute">No travel or stays this session.</p>`
  const line = pts.map(p => `${p.x},${p.y}`).join(" ")
  const lapse = reduced() ? null : lapseOf(pts)
  let g = ""
  pts.forEach((p, i) => {
    const prev = i > 0 ? pts[i - 1] : null
    if (p.leg != null && prev) g += `<text class="pb-so-leg" x="${(prev.x + p.x) / 2}" y="${(prev.y + p.y) / 2 - 5}" text-anchor="middle">${esc(plural(p.leg, "day"))}</text>`
    g += `<circle class="pb-so-dot${p.stay ? " stay" : ""}" cx="${p.x}" cy="${p.y}" r="${p.stay ? 4.5 : 3}"/>`
    if (p.label) g += `<text class="pb-so-pl" x="${p.x}" y="${p.y + 14}" text-anchor="middle">${esc(p.label)}</text>`
    if (p.stay && p.days > 0) {
      const t = plural(p.days, "day")
      g += `<g transform="translate(${p.x + 7},${p.y - 18})"><rect class="pb-so-box" width="${t.length * 5.6 + 8}" height="13" rx="2"/><text class="pb-so-boxt" x="4" y="9.5">${esc(t)}</text></g>`
    }
  })
  const walker = lapse ? `<circle class="pb-so-walker" r="5"><animateMotion dur="${lapse.dur}s" repeatCount="indefinite" calcMode="linear" keyPoints="${lapse.keyPoints.join(";")}" keyTimes="${lapse.keyTimes.join(";")}" path="M${pts.map(p => `${p.x},${p.y}`).join(" L")}"/></circle>` : ""
  return `<svg class="pb-so-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="The party's route"><polyline class="pb-so-line" points="${line}"/>${g}${walker}</svg>`
}

// ── the map box: the World Map round the route + the party's group token walking it ──
// RealmScreen sends `route.map` (session-over-model.js mapOf): the cropped map picture, the stops in its
// frame and the campaign crest. The token = that crest, else the first attendee's actor token, else their
// Discord picture, else a dot. Drawn finished (token at the end, every stay's "N days" box); playMap then
// runs it once (reduced motion: stays finished). No map → the strip above.
const MAP_W = 480
function mapTokenSrc(map, v) {
  if (map.token) return map.token
  for (const p of arr(v.party)) {
    if (!p || p.attended === false) continue
    const src = tokenOf(p)
    if (src) return src
    if (p.discordAvatar) return p.discordAvatar
  }
  return ""
}
const boxesSvg = (S, boxes) => boxes.map(b => {
  const p = S[b.at], t = plural(b.days, "day")
  return `<g transform="translate(${p.x + 14},${p.y - 20})"><rect class="pb-so-mbox" width="${t.length * 6 + 10}" height="15" rx="2"/><text class="pb-so-mboxt" x="5" y="11">${esc(t)}</text></g>`
}).join("")
function mapHtml(map, v) {
  const W = MAP_W, H = Math.round(W / map.aspect), R = 11
  const S = map.stops.map(s => ({ ...s, x: s.x * W, y: s.y * H }))
  const end = lapseAt(lapsePlan(map.stops), S, Infinity)
  const tok = mapTokenSrc(map, v)
  const clip = `pb-so-clip-${Math.random().toString(36).slice(2, 8)}`
  let g = ""
  for (const p of S) {
    g += `<circle class="pb-so-mdot${p.stay ? " stay" : ""}" cx="${p.x}" cy="${p.y}" r="${p.stay ? 3.5 : 2.5}"/>`
    if (p.label) g += `<text class="pb-so-mname" x="${p.x}" y="${p.y + 15}" text-anchor="middle">${esc(p.label)}</text>`
  }
  return `<div class="pb-so-mapview"><svg class="pb-so-msvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Where the party travelled">`
    + `<defs><clipPath id="${clip}"><circle r="${R}"/></clipPath></defs>`
    + `<image href="${esc(map.src)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>`
    + `<polyline class="pb-so-mline" points="${S.map(p => `${p.x},${p.y}`).join(" ")}"/>${g}`
    + `<g class="pb-so-mboxes">${boxesSvg(S, end.boxes)}</g>`
    + `<g class="pb-so-tok" transform="translate(${end.x},${end.y})"><circle class="pb-so-tokring" r="${R + 1.5}"/>`
    + (tok ? `<image href="${esc(tok)}" x="${-R}" y="${-R}" width="${R * 2}" height="${R * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>` : `<circle class="pb-so-tokdot" r="${R - 3}"/>`)
    + `</g></svg>`
    + (reduced() ? "" : `<button type="button" class="pb-so-replay" data-tooltip="Play it again"><i class="fa-solid fa-play" inert></i> Replay</button>`)
    + `</div>`
}
/** Run the time-lapse once in `root`'s map box (stops by itself when the window re-renders or closes). */
function playMap(root, map) {
  const svg = root?.querySelector(".pb-so-msvg")
  if (!svg || !map || reduced()) return
  const W = MAP_W, H = Math.round(W / map.aspect)
  const S = map.stops.map(s => ({ ...s, x: s.x * W, y: s.y * H }))
  const plan = lapsePlan(map.stops)
  if (!plan.steps.length) return
  const tok = svg.querySelector(".pb-so-tok"), bx = svg.querySelector(".pb-so-mboxes")
  const btn = root.querySelector(".pb-so-replay")
  let t0 = 0, last = ""
  const frame = (now) => {
    if (!svg.isConnected) return
    if (!t0) t0 = now
    const t = (now - t0) / 1000
    const at = lapseAt(plan, S, t)
    tok.setAttribute("transform", `translate(${Math.round(at.x * 10) / 10},${Math.round(at.y * 10) / 10})`)
    const sig = at.boxes.map(b => `${b.at}:${b.days}`).join("|")
    if (sig !== last) { bx.innerHTML = boxesSvg(S, at.boxes); last = sig }
    if (t < plan.dur) requestAnimationFrame(frame); else if (btn) btn.disabled = false
  }
  const start = () => { t0 = 0; last = "?"; if (btn) btn.disabled = true; requestAnimationFrame(frame) }
  btn?.addEventListener("click", start)
  start()
}

function legsHtml(route) {
  const rows = arr(route.legs).map((l, i) => `<li class="pb-so-legrow">`
    + `<select data-op="leg.kind" data-i="${i}" aria-label="Stay or travel"><option value="stay" ${l.kind === "stay" ? "selected" : ""}>Stayed at</option><option value="travel" ${l.kind === "travel" ? "selected" : ""}>Travelled</option></select>`
    + (l.kind === "stay"
      ? `<input type="text" class="wide" value="${esc(l.place || "")}" placeholder="Where" data-op="leg.place" data-i="${i}">`
      : `<input type="text" value="${esc(l.from || "")}" placeholder="From" data-op="leg.from" data-i="${i}"><i class="fa-solid fa-arrow-right" inert></i><input type="text" value="${esc(l.to || "")}" placeholder="To" data-op="leg.to" data-i="${i}">`)
    + `<input type="number" min="0" step="0.5" value="${esc(fmt(l.days))}" data-op="leg.days" data-i="${i}" aria-label="Days" data-tooltip="Days">`
    + `<button type="button" class="icon fa-solid fa-xmark" data-action="legDrop" data-i="${i}" data-tooltip="Remove" aria-label="Remove"></button></li>`).join("")
  return `<ol class="pb-so-legs">${rows}</ol><div class="pb-so-row">`
    + `<button type="button" data-action="legAdd" data-kind="travel"><i class="fa-solid fa-plus" inert></i> Travel</button>`
    + `<button type="button" data-action="legAdd" data-kind="stay"><i class="fa-solid fa-plus" inert></i> Stay</button>`
    + (route.edited ? `<button type="button" data-action="legReset"><i class="fa-solid fa-rotate-left" inert></i> Back to the trail</button>` : "") + `</div>`
}

const VIS = [["public", "Public"], ["dm", "DM"], ["drop", "Drop"]]
function recapHtml(v, gm) {
  const blocks = dayBlocks(v.recap, { gm })
  if (!blocks.length) return `<p class="hint">${gm ? "No lines this session. Lines written in Quick Capture, at the table or by Foundry show here." : "Nothing in the recap yet."}</p>`
  return blocks.map(b => `<section class="pb-so-day">${b.header ? `<h4 class="pb-so-dayhead">${esc(b.header)}</h4>` : ""}<ol class="pb-so-lines">`
    + b.rows.map(r => `<li class="pb-so-line${gm ? ` is-${esc(r.vis)}` : ""}"><span class="pb-so-text">${esc(r.text)}</span><span class="pb-so-who">${esc(r.who || "")}</span>`
      + (gm ? `<span class="pb-so-vis" role="group" aria-label="Who sees it">${VIS.map(([id, label]) => `<button type="button" class="${r.vis === id ? "active" : ""}" data-action="vis" data-line="${esc(r.id)}" data-vis="${id}" ${id === "public" && r.locked ? `disabled data-tooltip="GM-only line — can’t go Public"` : ""} aria-pressed="${r.vis === id}">${label}</button>`).join("")}</span>` : "")
      + `</li>`).join("") + `</ol></section>`).join("")
}

function metHtml(v, gm) {
  const rows = arr(v.met).map(m => `<li>${esc(m.name)}${gm ? `<button type="button" class="icon fa-solid fa-xmark" data-action="metHide" data-id="${esc(m.id)}" data-tooltip="Take off" aria-label="Take ${esc(m.name)} off"></button>` : ""}</li>`).join("")
  return `<ul class="pb-so-met">${rows || `<li class="hint">Nobody new.</li>`}</ul>${gm ? `<input type="text" placeholder="+ someone" data-op="met.add" aria-label="Add who they met">` : ""}`
}

function rationsHtml(app) {
  const v = app.view
  const n = rationN(app.ratN)
  const { plan, missing } = rationPreview(v, n)
  const taken = takenOf(v, soMsg("gm"))
  return `<fieldset class="pb-so-rations"><legend>Rations <small><i class="fa-solid fa-eye-slash" inert></i> GM only</small></legend>`
    + `<div class="pb-so-row"><span>Remove rations</span>`
    + `<button type="button" class="icon fa-solid fa-minus" data-action="ratStep" data-d="-1" aria-label="One fewer"></button>`
    + `<input type="number" min="0" step="1" value="${n}" data-op="ratN" aria-label="Rations from each">`
    + `<button type="button" class="icon fa-solid fa-plus" data-action="ratStep" data-d="1" aria-label="One more"></button>`
    + `<span class="hint">each, from ${plan.length} who came${v.rations?.suggested != null ? ` · ${esc(plural(v.rations.suggested, "day"))} travelled` : ""}</span>`
    + `<button type="button" class="pb-so-push" data-action="ratApply" ${n && plan.length ? "" : "disabled"}><i class="fa-solid fa-wheat-awn" inert></i> ${taken ? "Remove again…" : "Remove"}</button></div>`
    + (taken ? `<p class="hint">Removed for this session on ${esc(new Date(taken).toLocaleString())}${v.rations?.n != null ? ` (${esc(v.rations.n)} each)` : ""}.</p>` : "")
    + (plan.length ? `<table class="pb-rat-table"><tbody>${planRows(plan)}</tbody></table>` : "")
    + (missing.length ? `<p class="hint">No Foundry character for: ${missing.map(esc).join(", ")} — link them in Codex Of Faces.</p>` : "")
    + `</fieldset>`
}

// ── the window ────────────────────────────────────────────────
let WinClass = null
function winClass() {
  const AppV2 = foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  if (WinClass) return WinClass
  WinClass = class SessionOverWindow extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: APP_ID,
      classes: ["pb-session-over"],
      window: { icon: "fa-regular fa-star", resizable: true, title: "Session over" },
      position: { width: 920, height: 740 },
      actions: {
        attend: SessionOverWindow.#attend, reset: SessionOverWindow.#reset, itemHide: SessionOverWindow.#itemHide, itemShow: SessionOverWindow.#itemShow,
        legAdd: SessionOverWindow.#legAdd, legDrop: SessionOverWindow.#legDrop, legReset: SessionOverWindow.#legReset,
        vis: SessionOverWindow.#vis, metHide: SessionOverWindow.#metHide, ratStep: SessionOverWindow.#ratStep, ratApply: SessionOverWindow.#ratApply,
      },
    }
    view = null
    role = "player"
    busy = false
    ratN = null
    poppedFor = null       // the session whose END popped this window (GM) — closing it tells RealmScreen
    async _onClose(options) {
      await super._onClose?.(options)
      const id = this.poppedFor
      this.poppedFor = null
      if (id) reportClosed(id)
    }
    get title() {
      const v = this.view
      if (!v) return "Session over"
      const s = Number.isFinite(v.number) ? `Session ${v.number}` : "Session"
      return `${v.campaignName || "Session over"} — ${s}${v.title ? `: ${v.title}` : ""}`
    }
    get gm() { return this.role === "gm" && isGM() }
    setView(view, role = this.role) {
      const changed = !this.view || this.view.sessionId !== view?.sessionId
      this.view = role === "gm" ? view : forPlayer(view)
      this.role = role
      if (changed || this.ratN == null) this.ratN = this.view?.rations?.n ?? 0
      if (this.rendered) this.render({ window: { title: this.title } })
    }
    async _renderHTML() {
      const el = document.createElement("div")
      const v = this.view, gm = this.gm
      if (!v) { el.innerHTML = `<p class="hint"><i class="fa-solid fa-spinner fa-spin" inert></i> Asking RealmScreen…</p>`; return el }
      const st = v.stats || {}
      el.className = `pb-so${gm ? " is-gm" : ""}${this.busy ? " busy" : ""}`
      el.innerHTML = `
        <div class="pb-so-top">
          <div class="pb-so-left">
            <div class="pb-so-party" aria-label="Who came">${partyHtml(v, gm)}</div>
            <div class="pb-so-boxes">
              <fieldset class="pb-so-box"><legend>Stats</legend>
                ${numRow("Days passed", st.days, gm, { op: "stat", field: "days", step: 0.5 })}
                ${numRow("Rolls", st.rolls, gm, { op: "stat", field: "rolls" })}
                ${numRow("20s", st.nat20, gm, { op: "stat", field: "nat20" })}
                ${numRow("1s", st.nat1, gm, { op: "stat", field: "nat1" })}
                ${gm && st.counted === false ? `<p class="hint">Rolls weren’t counted (Foundry wasn’t connected when it ended).</p>` : ""}
              </fieldset>
              <fieldset class="pb-so-box"><legend>Awarded</legend>${awardedHtml(v, gm)}</fieldset>
            </div>
          </div>
          <fieldset class="pb-so-map"><legend>Map <small>${esc(plural(v.route?.days || 0, "day"))} · ${esc(plural(v.route?.travelled || 0, "day"))} travelling</small></legend>
            ${mapOf(v.route?.map) ? mapHtml(mapOf(v.route.map), v) : stripHtml(v.route?.legs)}
            ${gm ? legsHtml(v.route || {}) : ""}
          </fieldset>
        </div>
        <div class="pb-so-bottom">
          <fieldset class="pb-so-recap"><legend>Recap</legend>${recapHtml(v, gm)}</fieldset>
          <fieldset class="pb-so-metbox"><legend>Met</legend>${metHtml(v, gm)}</fieldset>
        </div>
        ${gm ? rationsHtml(this) : ""}`
      return el
    }
    _replaceHTML(result, content) {
      const keep = content.scrollTop
      const recap = content.querySelector(".pb-so-recap")?.scrollTop || 0
      content.replaceChildren(result)
      content.scrollTop = keep
      const r = content.querySelector(".pb-so-recap"); if (r) r.scrollTop = recap
    }
    _onRender() {
      applyTheme(this.element)
      // the map time-lapse: plays when the window opens and when the route (its picture or stops) changes
      const map = mapOf(this.view?.route?.map)
      const mk = map ? map.src + JSON.stringify(map.stops) : ""
      if (map && mk !== this._mapKey) playMap(this.element, map)
      this._mapKey = mk
      if (this._wired) return
      this._wired = true
      // inputs commit on change (blur / Enter), like Foundry's own sheets
      this.element.addEventListener("change", (ev) => this.#changed(ev.target))
      this.element.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.matches?.("input[type=text][data-op]")) ev.target.blur() })
      this.element.addEventListener("contextmenu", (ev) => {
        const b = ev.target.closest?.("[data-action=attend]")
        if (!b || !this.gm) return
        ev.preventDefault()
        this.send({ op: "attend", key: b.dataset.key, on: null })
      })
    }
    async send(change) {
      if (!this.gm || !this.view) return
      this.busy = true
      this.element?.querySelector(".pb-so")?.classList.add("busy")
      try {
        const r = await ask("update", { sessionId: this.view.sessionId, change })
        this.busy = false
        if (r.view) this.setView(r.view, "gm"); else this.render()
      } catch (e) {
        this.busy = false
        ui.notifications?.warn(`Not saved: ${e.message || e}`)
        this.render()
      }
    }
    legsWith(fn) { return fn(arr(this.view?.route?.legs).map(({ auto: _a, ...l }) => ({ ...l }))) }
    #changed(t) {
      const op = t?.dataset?.op
      if (!op) return
      const v = t.value
      if (op === "ratN") { this.ratN = rationN(v); return this.render() }
      if (!this.gm) return
      if (op === "stat") return this.send({ op, field: t.dataset.field, value: Math.max(0, Number(v) || 0) })
      if (op === "training") return this.send({ op, value: Math.max(0, Math.floor(Number(v) || 0)) })
      if (op === "money") return this.send({ op, value: String(v).trim() ? parseMoney(v) : {} })
      if (op === "item.to") return this.send({ op, id: t.dataset.id, to: v })
      if (op === "item.add") { const name = String(v).trim(); t.value = ""; return name ? this.send({ op, item: { name } }) : null }
      if (op === "met.add") { const name = String(v).trim(); t.value = ""; return name ? this.send({ op, id: "character:" + name.toLowerCase().replace(/\s+/g, " "), name }) : null }
      if (op.startsWith("leg.")) {
        const i = Number(t.dataset.i), k = op.slice(4)
        return this.send({ op: "route", route: this.legsWith(legs => legs.map((l, j) => {
          if (j !== i) return l
          if (k === "kind") return v === "stay" ? { id: l.id, kind: "stay", place: l.place || l.to || "", days: l.days } : { id: l.id, kind: "travel", from: l.from || l.place || "", to: l.to || "", days: l.days }
          if (k === "days") return { ...l, days: Math.max(0, Number(v) || 0) }
          return { ...l, [k]: String(v) }
        })) })
      }
    }
    static #attend(_e, b) { const p = arr(this.view?.party).find(x => x.key === b.dataset.key); if (p) this.send({ op: "attend", key: p.key, on: !p.attended }) }
    static #reset(_e, b) {
      const op = b.dataset.op
      if (op === "stat") this.send({ op, field: b.dataset.field, value: null })
      else this.send({ op, value: null })
    }
    static #itemHide(_e, b) { this.send({ op: "item.hide", id: b.dataset.id }) }
    static #itemShow(_e, b) { this.send({ op: "item.hide", id: b.dataset.id, on: false }) }
    static #legAdd(_e, b) {
      const kind = b.dataset.kind
      this.send({ op: "route", route: this.legsWith(legs => {
        const last = legs[legs.length - 1]
        const here = last ? (last.kind === "stay" ? last.place : last.to) : ""
        return [...legs, kind === "stay" ? { id: newId("g"), kind, place: here || "", days: 1 } : { id: newId("g"), kind, from: here || "", to: "", days: 1 }]
      }) })
    }
    static #legDrop(_e, b) { const i = Number(b.dataset.i); this.send({ op: "route", route: this.legsWith(legs => legs.filter((_, j) => j !== i)) }) }
    static #legReset() { this.send({ op: "route", route: null }) }
    static #vis(_e, b) { this.send({ op: "line", lineId: b.dataset.line, vis: b.dataset.vis }) }
    static #metHide(_e, b) { this.send({ op: "met.hide", id: b.dataset.id }) }
    static #ratStep(_e, b) { this.ratN = Math.max(0, rationN(this.ratN) + Number(b.dataset.d || 0)); this.render() }
    static #ratApply() { applyRations(this) }
  }
  return WinClass
}

const openApp = () => foundry?.applications?.instances?.get?.(APP_ID) || null

// A GM closed the window the END of a game popped up → RealmScreen opens its own Session Over panel
// and Recap, which it held back until now (pendant-home lib/sessionEndGate.js). The first GM to close
// releases them; a later close is ignored there. From a window without the RealmScreen link it goes as
// a whisper to the GMs, which the linked window passes on (passOp).
function reportClosed(sessionId) {
  if (!isGM() || !sessionId) return
  const data = { sessionId: String(sessionId) }
  if (linkedHere() && sender) sender({ type: "sessionover.closed", ...data, userId: game.user.id, gm: true })
  else ChatMessage.create({ speaker: { alias: "Session over" }, content: "", whisper: gmIds(),
    flags: { [MOD]: { hidden: true, soOp: { kind: "closed", data } } } }).catch(() => {})
}

/** Show a view (GM view for a GM, the players' copy otherwise). */
function show(view, role, { popped = false } = {}) {
  const C = winClass()
  if (!C || !view) return null
  let app = openApp()
  if (!app) app = new C()
  if (popped && role === "gm") app.poppedFor = view.sessionId || null   // the end of a game opened it
  app.setView(view, role)
  app.render({ force: true, window: { title: app.title } })
  app.bringToFront?.()
  return app
}

/** Reopen (the realm menu): what this user already holds, then (GM) RealmScreen's latest. */
export async function openSessionOver() {
  const had = mine()
  if (had) show(had.view, had.role)
  if (!isGM()) { if (!had) ui.notifications?.info("No finished session to show yet."); return }
  if (!realmLive()) { if (!had) ui.notifications?.info("RealmScreen isn’t connected, and no session has been sent yet."); return }
  try {
    const r = await ask("get", {})
    const v = r.view || mine()?.view
    if (v) show(v, "gm")
  } catch (e) { if (!had) ui.notifications?.warn(e.message || String(e)) }
}

// ── hooks ─────────────────────────────────────────────────────
const opened = new Map()          // key → openAt this window has popped for
function onCopy(m) {
  const f = soOf(m)
  if (!f) return
  const key = String(f.key || "")
  const forMe = isGM() ? key === "gm" : key.startsWith("p:") && arr(m.whisper).includes(game.user?.id)
  if (!forMe) return
  const role = isGM() ? "gm" : "player"
  const view = parse(m)
  if (!view) return
  if (f.openAt && opened.get(key) !== f.openAt && Date.now() - f.openAt < OPEN_FRESH_MS) {
    opened.set(key, f.openAt)
    show(view, role, { popped: true })
    return
  }
  // a refresh: only an open window showing that session (a player's: their campaign's copy)
  const app = openApp()
  if (app?.rendered && app.role === role && app.view?.sessionId === view.sessionId) app.setView(view, role)
}
Hooks.on("createChatMessage", (m) => {
  if (flagsOf(m).soOp) passOp(m)
  else onCopy(m)
})
Hooks.on("updateChatMessage", (m) => onCopy(m))
// Ops left while no GM window was linked are dropped (a stale edit replayed later would surprise).
Hooks.on("pendantBridgeLive", () => {
  if (!isGM() || !linkedHere()) return
  for (const m of game.messages?.filter(x => flagsOf(x).soOp) ?? []) passOp(m)
})
Hooks.once("ready", () => {
  // the first copy this window sees isn't "new": don't pop up on a reload
  for (const m of game.messages?.filter(x => soOf(x)?.openAt) ?? []) opened.set(String(soOf(m).key), soOf(m).openAt)
  try {
    game.socket?.on(CHANNEL, (m) => {
      if (m?.t !== "so.ans" || m.to !== game.user?.id) return
      if (m.error) return settle(m.qid, { error: m.error })
      settle(m.qid, { view: mine()?.view || null })
    })
  } catch { /* no socket */ }
})
Hooks.on("pendantOpenSessionOver", () => openSessionOver())
// Foundry's colour scheme changed → the open window follows.
Hooks.on("clientSettingChanged", (key) => {
  if (key !== "core.uiConfig") return
  const app = openApp()
  if (!app?.element) return
  app.element.classList.remove("theme-dark", "theme-light")
  applyTheme(app.element)
})
