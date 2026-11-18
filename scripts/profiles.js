// ──────────────────────────────────────────────────────────────
// Character Profiles — a GM-only sidebar tab, live from RealmScreen.
//
// A search box, then one row per character: their Cover · name · a send arrow. Send does what the
// RealmScreen Character Profiles bar's send does (Discord art channel / Foundry chat / the Command Center
// stage — by that tool's own switches). Nothing is kept in Foundry: the list and the little Cover squares
// are asked for while the tab is open and live only in this window's memory.
//
// Only the GM window holding the RealmScreen link talks to it (live.js). Another GM window asks through
// the module socket, like trips.js:
//   linked window → RealmScreen  `profiles.list` | `profiles.thumbs` { ids } | `profiles.send` { id }
//                                 (each with { qid, userId, gm })
//   RealmScreen → `profiles.answer` { qid, userId, rows | thumbs | done + text | error }
//   socket  { t: "profiles.ask", op, qid, user, payload }  → the linked window (GMs only)
//           { t: "profiles.ans", to, qid, body }          → back to the asker
//
// Native: an AbstractSidebarTab (V13+) with Foundry's own search input, CSS variables and icons;
// styles are scoped under `.pb-prof` (styles/profiles.css). Pop it out with a right-click, as any tab.
// ──────────────────────────────────────────────────────────────

import { realmLive, linkedHere } from "./live.js"

const MOD = "pendant-bridge"
const CHANNEL = `module.${MOD}`
const TAB = "realmprofiles"
const ICON = "fa-solid fa-id-badge"
const ASK_MS = 20000
const SEND_MS = 90000
const BATCH = 40

let sender = null
/** main.js hands over its send (only the linked window's reaches RealmScreen). */
export function setProfilesSender(fn) { sender = typeof fn === "function" ? fn : null }

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const isGM = () => !!game.user?.isGM
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

// ── pure: the search ──────────────────────────────────────────
/** Rows whose name or tags hold every word of `q` (any case, accents ignored). Exported for tests. */
export function filterRows(rows, q) {
  const list = Array.isArray(rows) ? rows : []
  const words = fold(q).split(/\s+/).filter(Boolean)
  if (!words.length) return list
  return list.filter(r => {
    const hay = fold([r?.name, ...(Array.isArray(r?.tags) ? r.tags : [])].join(" "))
    return words.every(w => hay.includes(w))
  })
}

/** The rows' ids still without a Cover square, in BATCH-sized asks. Exported for tests. */
export function thumbBatches(rows, have, size = BATCH) {
  const ids = (Array.isArray(rows) ? rows : []).filter(r => r && r.hasCover && !(have && have.has(r.id))).map(r => r.id)
  const out = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

// ── talking to RealmScreen ────────────────────────────────────
const pending = new Map()                    // qid → { resolve, reject, timer }
const newQid = () => `${game.user?.id || "u"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const emit = (msg) => { try { game.socket?.emit(CHANNEL, msg) } catch { /* socket not ready */ } }

function ask(op, payload = {}, ms = ASK_MS) {
  return new Promise((resolve, reject) => {
    if (!isGM()) { reject(new Error("Character Profiles is for the GM only.")); return }
    if (!realmLive()) { reject(new Error("RealmScreen isn’t connected.")); return }
    const qid = newQid()
    const timer = setTimeout(() => { pending.delete(qid); reject(new Error("RealmScreen didn’t answer.")) }, ms)
    pending.set(qid, { resolve, reject, timer })
    const msg = { qid, userId: game.user?.id || null, ...payload, gm: true }
    if (linkedHere() && sender) sender({ type: `profiles.${op}`, ...msg })
    else emit({ t: "profiles.ask", op, qid, user: game.user?.id || null, payload: msg })
  })
}
function settle(qid, body) {
  const p = pending.get(qid)
  if (!p) return
  pending.delete(qid)
  clearTimeout(p.timer)
  if (body && body.error) p.reject(new Error(body.error)); else p.resolve(body || {})
}

/** main.js: RealmScreen's `profiles.answer` (reaches the linked window) → whoever asked. */
export function profilesAnswer(msg) {
  const { qid, userId, type: _t, reqId: _r, ...body } = msg || {}
  if (!qid) return { ok: false }
  if (!userId || userId === game.user?.id) settle(qid, body)
  else emit({ t: "profiles.ans", to: userId, qid, body })
  return { ok: true }
}

Hooks.once("ready", () => {
  try {
    game.socket?.on(CHANNEL, (m) => {
      if (!m || typeof m.t !== "string" || !m.t.startsWith("profiles.")) return
      if (m.t === "profiles.ask" && linkedHere() && sender && m.op && m.payload) {
        // (worked out HERE from who asked — a player's window can't claim to be a GM)
        const gm = !!game.users?.get?.(m.user)?.isGM
        if (!gm) { emit({ t: "profiles.ans", to: m.user, qid: m.qid, body: { error: "Character Profiles is for the GM only." } }); return }
        sender({ type: `profiles.${m.op}`, ...m.payload, qid: m.qid, userId: m.user || null, gm })
      } else if (m.t === "profiles.ans" && m.to === game.user?.id) settle(m.qid, m.body)
    })
  } catch { /* no socket */ }
})

// ── the tab's state (this window only, never saved) ───────────
const state = { rows: null, loading: false, error: "", query: "", thumbs: new Map(), sending: new Set(), gen: 0 }

async function load() {
  if (state.loading) return
  if (!realmLive()) { state.rows = null; state.error = ""; redraw(); return }
  state.loading = true; state.error = ""
  const gen = ++state.gen
  redraw()
  try {
    const r = await ask("list")
    if (gen !== state.gen) return
    state.rows = Array.isArray(r.rows) ? r.rows : []
  } catch (e) {
    if (gen !== state.gen) return
    state.error = e?.message || String(e)
  } finally {
    if (gen === state.gen) state.loading = false
  }
  redraw()
  if (state.rows) loadThumbs(gen)
}

async function loadThumbs(gen) {
  for (const ids of thumbBatches(state.rows, state.thumbs)) {
    if (gen !== state.gen) return
    let r
    try { r = await ask("thumbs", { ids }, 45000) } catch { return }
    if (gen !== state.gen) return
    for (const [id, src] of Object.entries(r.thumbs || {})) {
      state.thumbs.set(id, typeof src === "string" && src.startsWith("data:image/") ? src : "")
      paintThumb(id)
    }
  }
}

async function sendRow(id) {
  if (!id || state.sending.has(id)) return
  state.sending.add(id); paintRow(id)
  try {
    const r = await ask("send", { id }, SEND_MS)
    ui.notifications?.info(r.text || "Sent.")
  } catch (e) {
    ui.notifications?.warn(e?.message || String(e))
  } finally {
    state.sending.delete(id); paintRow(id)
  }
}

// ── markup ────────────────────────────────────────────────────
function thumbHtml(row) {
  const src = state.thumbs.get(row.id)
  return src
    ? `<img class="pb-prof-thumb" src="${esc(src)}" alt="" data-id="${esc(row.id)}">`
    : `<span class="pb-prof-thumb pb-prof-none" data-id="${esc(row.id)}"><i class="fa-solid fa-user"></i></span>`
}
function rowHtml(row) {
  const busy = state.sending.has(row.id)
  return `<li class="pb-prof-row" data-id="${esc(row.id)}">
    ${thumbHtml(row)}
    <span class="pb-prof-name">${esc(row.name)}</span>
    <button type="button" class="icon pb-prof-send" data-action="send" data-id="${esc(row.id)}" data-tooltip="${row.hasCover ? "Send" : "No picture to send"}" aria-label="Send ${esc(row.name)}" ${busy || !row.hasCover ? "disabled" : ""}>
      <i class="fa-solid ${busy ? "fa-spinner fa-spin" : "fa-arrow-right"}"></i>
    </button>
  </li>`
}
function listHtml() {
  if (!realmLive()) return `<p class="pb-prof-empty hint">RealmScreen isn’t connected.</p>`
  if (state.error) return `<p class="pb-prof-empty hint">${esc(state.error)}</p>`
  if (!state.rows) return `<p class="pb-prof-empty hint">${state.loading ? "Loading…" : ""}</p>`
  if (!state.rows.length) return `<p class="pb-prof-empty hint">No characters in Character Profiles yet.</p>`
  const shown = filterRows(state.rows, state.query)
  return `<ol class="pb-prof-list">${shown.map(rowHtml).join("")}</ol>${shown.length ? "" : `<p class="pb-prof-empty hint">No one matches.</p>`}`
}
function tabHtml() {
  const off = !realmLive()
  return `
    <header class="pb-prof-head">
      <search><input type="search" name="search" value="${esc(state.query)}" placeholder="Search characters" autocomplete="off" ${off ? "disabled" : ""}></search>
      <button type="button" class="icon fa-solid fa-arrows-rotate" data-action="refresh" data-tooltip="Refresh" aria-label="Refresh" ${off ? "disabled" : ""}></button>
    </header>
    <div class="pb-prof-body">${listHtml()}</div>`
}

// ── in-place paints (no full render: the search box keeps its focus) ──
const roots = () => {
  const t = ui?.[TAB]
  return [t?.element, t?.popout?.element].filter(Boolean).map(el => (el instanceof HTMLElement ? el : el[0])).filter(Boolean)
}
function paintThumb(id) {
  const row = state.rows?.find(r => r.id === id)
  if (!row) return
  for (const root of roots()) {
    const el = root.querySelector(`.pb-prof-thumb[data-id="${CSS.escape(id)}"]`)
    if (el) el.outerHTML = thumbHtml(row)
  }
}
function paintRow(id) {
  const row = state.rows?.find(r => r.id === id)
  if (!row) return
  for (const root of roots()) {
    const el = root.querySelector(`.pb-prof-row[data-id="${CSS.escape(id)}"]`)
    if (el) el.outerHTML = rowHtml(row)
  }
}
function paintList() {
  for (const root of roots()) {
    const body = root.querySelector(".pb-prof-body")
    if (body) body.innerHTML = listHtml()
  }
}

let TabClass = null
function makeTab() {
  const Abs = foundry?.applications?.sidebar?.AbstractSidebarTab
  if (!Abs) return null
  TabClass = class RealmProfilesTab extends Abs {
    static tabName = TAB
    static DEFAULT_OPTIONS = {
      classes: ["pb-prof", "flexcol"],
      window: { title: "Character Profiles", icon: ICON },
      actions: {
        send: function (ev, t) { sendRow(t.dataset.id) },
        refresh: function () { state.thumbs.clear(); state.rows = null; state.gen++; state.loading = false; load() },
      },
    }
    async _renderHTML() { const el = document.createElement("div"); el.className = "pb-prof-wrap flexcol"; el.innerHTML = tabHtml(); return el }
    _replaceHTML(result, content) {
      const had = content.querySelector?.("input[name=search]")
      const focused = had && document.activeElement === had
      content.replaceChildren(result)
      const input = content.querySelector("input[name=search]")
      if (!input) return
      input.addEventListener("input", () => { state.query = input.value; paintList() })
      if (focused) { input.focus(); const n = input.value.length; input.setSelectionRange(n, n) }
    }
    _onRender(context, options) {
      super._onRender?.(context, options)
      if (!state.rows && !state.loading && !state.error && realmLive() && shown(this)) load()
    }
  }
  return TabClass
}

// Drawn where the GM can see it: the open tab, or its pop-out (asks wait until then).
const shown = (app) => !!app && (app.isPopout || app.options?.popOut === true || (app.active ?? true))
const anyShown = () => { const t = ui?.[TAB]; return !!((t?.rendered && shown(t)) || t?.popout?.rendered) }

let drawT = 0
function redraw() {
  clearTimeout(drawT)
  drawT = setTimeout(() => {
    const t = ui?.[TAB]
    if (t?.rendered) t.render()
    if (t?.popout?.rendered) t.popout.render()
  }, 30)
}

// GM only: the tab isn't added for players at all. (At "init" game.user may not be built yet — read the role.)
function gmAtInit() {
  try {
    if (game.user) return !!game.user.isGM
    const u = (game.data?.users || []).find(x => x?._id === game.userId)
    const assistant = globalThis.CONST?.USER_ROLES?.ASSISTANT ?? 3
    return (u?.role ?? 0) >= assistant
  } catch { return false }
}

Hooks.once("init", () => {
  if (!gmAtInit()) return
  const S = foundry?.applications?.sidebar?.Sidebar
  const C = makeTab()
  if (!S || !C || !S.TABS || S.TABS[TAB]) return
  // After the Actors tab, like Foundry's own document tabs (right-click pops it out).
  const conf = { tooltip: "Character Profiles", icon: ICON, gmOnly: true }
  const next = {}
  for (const [k, v] of Object.entries(S.TABS)) { next[k] = v; if (k === "actors") next[TAB] = conf }
  if (!next[TAB]) next[TAB] = conf
  S.TABS = next
  CONFIG.ui[TAB] = C
})
// RealmScreen came or went: start over (a fresh list next time the tab draws).
Hooks.on("pendantBridgeLive", (live) => {
  state.gen++; state.loading = false; state.error = ""
  if (!live) { state.rows = null; state.sending.clear() }
  if (live && anyShown()) { state.rows = null; load() } else redraw()
})
// Opening the tab fetches the list again (new characters show up; the Cover squares already here stay).
Hooks.on("changeSidebarTab", (app) => {
  if ((app?.tabName ?? app?.constructor?.tabName) !== TAB || !realmLive()) return
  state.gen++; state.loading = false; state.error = ""
  load()
})

// For a render harness / tests outside Foundry (no effect in Foundry).
export const _test = { tabHtml, listHtml, rowHtml, state, makeTab, ask, gmAtInit }
