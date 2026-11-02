// ──────────────────────────────────────────────────────────────
// RealmScreen music — a small control panel in the Playlists tab.
//
// While RealmScreen is connected (live.js), the Playlists tab shows what
// RealmScreen is playing instead of Foundry's playlists, for the GM and the
// players. A button at the top flips back to Foundry's own playlists (per
// window, remembered).
//
//   • everyone sees ONLY the tracks playing — never RealmScreen's library;
//   • anyone can move a track's volume or stop it (RealmScreen whispers the GM
//     who did what);
//   • anyone can paste a web link to queue. It waits for the GM's OK (the GM's
//     panel lists it with Play / No) unless the GM ticks "Links start right away".
//
// The music itself plays in RealmScreen (out through Discord); this is only a
// remote. RealmScreen decides everything (music/foundryMusic.mjs there).
//
//   RealmScreen `music.state` { state } → the linked window → socket { t: "music.state" } → every client
//   a click → `music.do` (linked window: straight to RealmScreen; else socket { t: "music.do" } → linked window)
//   RealmScreen `music.note` { text, to } → a whisper (to the GMs, or to one player)
//
// Native-first: a render hook adds one section to the Playlists tab and hides
// Foundry's own parts with a class; nothing is replaced. Not connected = stock Foundry.
// ──────────────────────────────────────────────────────────────

import { realmLive, linkedHere } from "./live.js"

const MOD = "pendant-bridge"
const CHANNEL = `module.${MOD}`
const SHOW_KEY = `${MOD}.musicPanelFoundry`      // "1" = this window shows Foundry's playlists

let sender = null
/** main.js hands over its send (only the linked window's reaches RealmScreen). */
export function setMusicSender(fn) { sender = typeof fn === "function" ? fn : null }

let state = null                                 // { tracks, requests, auto } from RealmScreen
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const showFoundry = () => { try { return localStorage.getItem(SHOW_KEY) === "1" } catch { return false } }
const setShowFoundry = (on) => { try { localStorage.setItem(SHOW_KEY, on ? "1" : "0") } catch { /* private mode */ } }
const emit = (msg) => { try { game.socket?.emit(CHANNEL, msg) } catch { /* socket not ready */ } }
const isGM = (id) => { try { return !!game.users?.get?.(id)?.isGM } catch { return false } }
const nameOf = (id) => { try { return game.users?.get?.(id)?.name || "Someone" } catch { return "Someone" } }
const newAid = () => `${game.user?.id || "u"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

// ── drawing (pure, exported for tests) ────────────────────────
const linkLabel = (url) => { try { const u = new URL(url); return u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? u.pathname.slice(0, 18) + (u.pathname.length > 18 ? "…" : "") : "") } catch { return String(url || "") } }

export function panelHtml(s, { gm = false, me = null } = {}) {
  const tracks = Array.isArray(s?.tracks) ? s.tracks : []
  const allReqs = Array.isArray(s?.requests) ? s.requests : []
  const auto = !!s?.auto
  const list = tracks.length
    ? `<ol class="pb-music-tracks">${tracks.map(t => {
      const pct = Math.round((Number(t.vol) || 0) * 100)
      // Pause only where it really works: files always, a web page only when its player can be paused.
      const pause = t.canPause === false ? ""
        : t.paused
          ? `<button type="button" class="icon fa-solid fa-play" data-pbm="play" data-tooltip="Resume" aria-label="Resume ${esc(t.name)}"></button>`
          : `<button type="button" class="icon fa-solid fa-pause" data-pbm="pause" data-tooltip="Pause" aria-label="Pause ${esc(t.name)}"></button>`
      return `<li class="pb-music-track${t.paused ? " pb-music-paused" : ""}" data-id="${esc(t.id)}">` +
        `<div class="pb-music-row"><i class="fa-solid ${t.web ? "fa-globe" : "fa-music"}" inert></i>` +
        `<span class="pb-music-name" title="${esc(t.name)}">${esc(t.name)}</span>${t.paused ? `<span class="pb-music-tag">Paused</span>` : ""}` +
        pause +
        `<button type="button" class="icon fa-solid fa-stop" data-pbm="stop" data-tooltip="Stop" aria-label="Stop ${esc(t.name)}"></button></div>` +
        `<div class="pb-music-row"><i class="fa-solid ${t.mute ? "fa-volume-xmark" : "fa-volume-low"}" inert></i>` +
        `<input type="range" min="0" max="100" step="1" value="${pct}" data-pbm="vol" aria-label="Volume of ${esc(t.name)}">` +
        `<span class="pb-music-pct">${pct}%</span></div></li>`
    }).join("")}</ol>`
    : `<p class="hint pb-music-empty">Nothing is playing.</p>`

  // Adding a link: the GM (or "start right away") plays it now; otherwise the player asks the GM.
  const now = gm || auto
  const add = `<h4 class="pb-music-sub">${now ? "Play a link" : "Ask to play a link"}</h4>` +
    `<form class="pb-music-add"><input type="url" name="url" placeholder="YouTube or Spotify link" aria-label="Link" required>` +
    `<button type="submit">${now ? `<i class="fa-solid fa-play" inert></i> Play now` : `<i class="fa-solid fa-paper-plane" inert></i> Ask GM`}</button></form>` +
    `<p class="hint">${gm ? "Starts for everyone straight away." : now ? "Starts for everyone straight away." : "Your GM gets it and starts it when they press Play."}</p>`

  let reqs = ""
  if (gm) {
    reqs = allReqs.length
      ? `<h4 class="pb-music-sub">Players asking to play</h4><ol class="pb-music-reqs">${allReqs.map(r =>
        `<li class="pb-music-req" data-req="${esc(r.id)}"><div class="pb-music-req-text"><strong>${esc(r.userName)}</strong> ` +
        `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" title="${esc(r.url)}">${esc(linkLabel(r.url))}</a></div>` +
        `<button type="button" data-pbm="yes"><i class="fa-solid fa-play" inert></i> Play</button>` +
        `<button type="button" data-pbm="no"><i class="fa-solid fa-xmark" inert></i> No</button></li>`).join("")}</ol>`
      : ""
    reqs += `<label class="pb-music-auto checkbox"><input type="checkbox" data-pbm="auto"${auto ? " checked" : ""}> Players’ links play straight away (no asking)</label>`
  } else {
    const mine = allReqs.filter(r => me && r.user === me)
    if (mine.length) reqs = `<h4 class="pb-music-sub">Waiting for your GM</h4><ol class="pb-music-reqs">${mine.map(r =>
      `<li class="pb-music-req"><div class="pb-music-req-text"><i class="fa-solid fa-hourglass-half" inert></i> ${esc(linkLabel(r.url))}</div></li>`).join("")}</ol>`
  }

  return `<header class="pb-music-head"><h3><i class="fa-solid fa-music" inert></i> RealmScreen music</h3>` +
    `<button type="button" class="icon fa-solid fa-list" data-pbm="foundry" data-tooltip="Foundry’s playlists" aria-label="Show Foundry’s playlists"></button></header>` +
    list + add + reqs
}

// ── talking to RealmScreen ────────────────────────────────────
// What a press changes, drawn at once — RealmScreen's own state follows a moment later.
function shown(act, extra) {
  if (!state) return
  const tracks = (state.tracks || []).map(t => (t.id !== extra.id ? t
    : act === "pause" ? { ...t, paused: true }
    : act === "play" ? { ...t, paused: false }
    : act === "vol" ? { ...t, vol: extra.vol } : t)).filter(t => !(act === "stop" && t.id === extra.id))
  let requests = state.requests || []
  if (act === "answer") requests = requests.filter(r => r.id !== extra.reqId)
  if (act === "add" && !game.user?.isGM && !state.auto) requests = [...requests, { id: "local-" + Date.now(), url: extra.url, user: game.user?.id, userName: game.user?.name }]
  state = { ...state, tracks, requests, ...(act === "auto" ? { auto: !!extra.on } : {}) }
}

function send(act, extra = {}) {
  shown(act, extra)
  if (act !== "vol") redraw()
  const msg = { act, aid: newAid(), ...extra }
  if (linkedHere() && sender) { forward(msg, game.user?.id); return }
  if (!realmLive()) { ui.notifications?.warn("RealmScreen isn’t connected."); return }
  emit({ t: "music.do", msg, user: game.user?.id || null })
}
/** The linked window passes an action on, saying who it came from. */
function forward(msg, userId) {
  if (!sender || !msg) return false
  return !!sender({ type: "music.do", ...msg, user: userId || null, userName: nameOf(userId), isGM: isGM(userId) })
}

// ── placing ───────────────────────────────────────────────────
function onClick(ev) {
  const b = ev.target.closest?.("[data-pbm]")
  if (!b || b.dataset.pbm === "vol" || b.dataset.pbm === "auto") return
  ev.preventDefault()
  const id = b.closest("[data-id]")?.dataset.id
  const req = b.closest("[data-req]")?.dataset.req
  switch (b.dataset.pbm) {
    case "stop": if (id) send("stop", { id }); break
    case "pause": if (id) send("pause", { id }); break
    case "play": if (id) send("play", { id }); break
    case "yes": if (req) send("answer", { reqId: req, ok: true }); break
    case "no": if (req) send("answer", { reqId: req, ok: false }); break
    case "foundry": setShowFoundry(true); redraw(); break
    case "realm": setShowFoundry(false); redraw(); break
  }
}
// The slider is heard while it moves: a send every 150 ms, and the last value on release.
let volT = 0, volLast = 0
function sendVol(r) {
  const id = r.closest("[data-id]")?.dataset.id
  if (id) send("vol", { id, vol: Math.max(0, Math.min(100, Number(r.value) || 0)) / 100 })
}
function onInput(ev) {
  const r = ev.target
  if (r?.dataset?.pbm !== "vol") return
  const pct = r.closest(".pb-music-track")?.querySelector(".pb-music-pct")
  if (pct) pct.textContent = `${r.value}%`
  clearTimeout(volT)
  const wait = 150 - (Date.now() - volLast)
  volT = setTimeout(() => { volLast = Date.now(); sendVol(r) }, Math.max(0, wait))
}
function onChange(ev) {
  const r = ev.target
  if (r?.dataset?.pbm === "vol") { clearTimeout(volT); volLast = Date.now(); sendVol(r) } else if (r?.dataset?.pbm === "auto") send("auto", { on: !!r.checked })
}
function onSubmit(ev) {
  const f = ev.target.closest?.(".pb-music-add")
  if (!f) return
  ev.preventDefault()
  const url = String(f.elements.url?.value || "").trim()
  if (!url) return
  send("add", { url })
  f.reset()
}

// A slider being dragged (or a link half typed) isn't redrawn under the hand.
// (Focus alone isn't enough: a slider keeps focus after release, and the panel would stop updating.)
let dragging = false
const busy = (box) => {
  const a = document.activeElement
  if (!box.contains(a)) return false
  return a?.dataset?.pbm === "vol" ? dragging : (a?.type === "url" && !!a.value)
}

function place(root) {
  if (!root) return
  let box = root.querySelector(":scope > .pb-music")
  let back = root.querySelector(":scope > .pb-music-back")
  const on = realmLive()
  const foundryView = showFoundry()
  root.classList.toggle("pb-music-on", on && !foundryView)
  if (!on) { box?.remove(); back?.remove(); return }
  if (foundryView) {
    box?.remove()
    if (!back) {
      back = document.createElement("button")
      back.type = "button"
      back.className = "pb-music-back"
      back.dataset.pbm = "realm"
      back.innerHTML = `<i class="fa-solid fa-music" inert></i> RealmScreen music`
      back.addEventListener("click", onClick)
      root.prepend(back)
    }
    return
  }
  back?.remove()
  if (!box) {
    box = document.createElement("section")
    box.className = "pb-music"
    box.addEventListener("click", onClick)
    box.addEventListener("input", onInput)
    box.addEventListener("change", onChange)
    box.addEventListener("submit", onSubmit)
    box.addEventListener("pointerdown", (e) => { if (e.target?.dataset?.pbm === "vol") dragging = true })
    root.prepend(box)
  } else if (busy(box)) return
  box.innerHTML = panelHtml(state, { gm: !!game.user?.isGM, me: game.user?.id || null })
}

const roots = () => document.querySelectorAll("#playlists, #playlists-popout .window-content, .playlists-sidebar")
function redraw() { for (const el of roots()) place(el) }

// ── RealmScreen's commands (linked window) ────────────────────
/** `music.state` from RealmScreen → this window, then every client. */
export function setMusicState(s) {
  state = s && typeof s === "object" ? s : null
  emit({ t: "music.state", state })
  redraw()
  return { ok: true }
}

const noted = new Set()
/** `music.note` from RealmScreen → one whisper (each linked window gets the command; the reqId keeps it to one). */
export async function musicNote({ text, to, reqId } = {}) {
  if (!text || !game.user?.isGM) return { ok: false }
  const key = String(reqId || text)
  if (noted.has(key)) return { ok: true }
  noted.add(key)
  // Two linked windows get the same command: the later one sees the first one's message and stays quiet.
  await new Promise(r => setTimeout(r, Math.random() * 300))
  if ((game.messages?.contents || []).slice(-20).some(m => m.flags?.[MOD]?.musicNote === key)) return { ok: true }
  const ids = to && game.users?.get?.(to) ? [to] : (game.users?.filter?.(u => u.isGM) || []).map(u => u.id)
  if (!ids.length) return { ok: false }
  await ChatMessage.create({
    speaker: { alias: "RealmScreen music" },
    whisper: ids,
    content: `<div class="pb-music-note"><i class="fa-solid fa-music"></i> ${esc(text)}</div>`,
    flags: { [MOD]: { musicNote: key } },
  })
  return { ok: true }
}

// ── socket (every client) ─────────────────────────────────────
export function onMusicSocket(m, senderId) {
  if (!m || typeof m.t !== "string" || !m.t.startsWith("music.")) return false
  if (m.t === "music.state") { state = m.state && typeof m.state === "object" ? m.state : null; redraw(); return true }
  if (m.t === "music.ask" && linkedHere() && state) { emit({ t: "music.state", state }); return true }
  if (m.t === "music.do" && linkedHere()) return forward(m.msg, senderId || m.user || m.msg?.user)
  return false
}

Hooks.once("ready", () => {
  window.addEventListener("pointerup", () => { if (dragging) { dragging = false; setTimeout(redraw, 0) } })
  try { game.socket?.on(CHANNEL, (m, senderId) => onMusicSocket(m, typeof senderId === "string" ? senderId : null)) } catch { /* no socket */ }
  if (!linkedHere()) emit({ t: "music.ask" })
  redraw()
})
Hooks.on("pendantBridgeLive", (live) => { if (live && !state) emit({ t: "music.ask" }); redraw() })

const rootOf = (el) => (el instanceof HTMLElement ? el : el?.[0] || null)
Hooks.on("renderPlaylistDirectory", (app, el) => { place(rootOf(el)) })
