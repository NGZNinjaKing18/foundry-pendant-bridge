// ──────────────────────────────────────────────────────────────
// Table log — players write into RealmScreen's session log from Foundry.
//
//   • a Table log tab in the sidebar (after the Calendar): the running game's
//     notes from the table, newest at the bottom, and a box to add one
//     ("Just me" keeps a line between you and the GM)
//   • `/note …` (or `/n …`) in the chat box files a line without posting it
//   • right-click any chat message: "Add to table log" / "Quote in table log"
//
// A note goes to RealmScreen as `tablelog.note` — a hidden whisper to the GMs,
// so Foundry stamps its real author (scripts/private.js `sendOp`); RealmScreen
// checks it (a game of your campaign is running, you're seated in it), files
// it, answers `tablelog.ack`, and sends the log back (`tablelog.set`). Each
// player sees only their part, from their private whisper slice
// (table-log-model.js `logFor`). The GM's own notes from the GM screen stay
// out of this log until the GM sorts them in RealmScreen.
//
// Native-first: Foundry's sidebar-tab class, its CSS variables and light/dark
// theme; CSS scoped to .pb-tablog (styles/table-log.css).
// ──────────────────────────────────────────────────────────────

import { mySlice, onSlice, setFull, fullTableLog, sendOp } from "./private.js"
import { realmLive } from "./live.js"
import { cleanLog, noteCommand, canUndo, canEdit, chatText, activeMark, suggestNames, completeMark } from "./table-log-model.js"

const MOD = "pendant-bridge"
const CHANNEL = `module.${MOD}`
const TAB = "realmtable"
const ICON = "fa-solid fa-feather-pointed"
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const str = (v) => (typeof v === "string" ? v.trim() : "")
const arr = (v) => (Array.isArray(v) ? v : [])

const isGM = () => !!game.user?.isGM
/** The log this user may see (GM: the full copy). */
function myLog() { return isGM() ? fullTableLog() : (mySlice().tablelog || null) }
const seated = (log) => !!log && (isGM() || arr(log.users).includes(game.user?.id))

/** The `tablelog.set` command (the linked GM window). */
export async function setTableLog(log) {
  if (!isGM()) throw new Error("Only the GM can set the table log")
  setFull("tablelog", cleanLog(log))
  redraw()
  return { ok: true }
}

// ── sending ───────────────────────────────────────────────────
const mine = new Map()            // clientId → { text, just, ts } still saving
let draft = ""
const VIS_KEY = `${MOD}.tablelogVis`
let boxVis = (() => { try { return localStorage.getItem(VIS_KEY) === "dm" ? "dm" : "public" } catch { return "public" } })()
function send(data) {
  const clientId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  if (!data.edit && !data.visOp && (data.text != null || data.quote)) mine.set(clientId, { text: data.quote ? `“${data.quote.text}”` : data.text, just: !!data.just, after: data.after || null, ts: Date.now() })
  if (!realmLive()) ui.notifications?.info("RealmScreen isn’t connected. Your note is sent when it is.")
  const op = data.visOp ? "tablelog.vis" : data.edit ? "tablelog.edit" : data.lineId ? "tablelog.undo" : "tablelog.note"
  Promise.resolve(sendOp(op, { ...data, clientId })).then((r) => {
    if (r !== false) return
    mine.delete(clientId)
    ui.notifications?.warn("Couldn’t reach RealmScreen. Try again.")
    redraw()
  }).catch(() => {})
  // No answer in a minute → stop showing it as saving (it may still arrive).
  setTimeout(() => { if (mine.delete(clientId)) redraw() }, 60000)
  redraw()
}
export function addNote(text, { vis = "public", after = null, dayKey = null } = {}) {
  const t = str(text)
  if (!t) return false
  send({ text: t, vis: VIS_OK.includes(vis) ? vis : "public", ...(after ? { after } : {}), ...(Number.isFinite(dayKey) ? { dayKey } : {}) })
  return true
}
const VIS_OK = ["public", "dm", "drop"]
/** Keep / GM / Drop for a line (your own; the GM any) — the sort's choice, which the GM can still change. */
export function setLineVis(lineId, vis) {
  if (!lineId || !VIS_OK.includes(vis)) return false
  send({ visOp: true, lineId, vis })
  return true
}
/** Change the words of a line (your own; the GM any). */
export function editNote(lineId, text) {
  const t = str(text)
  if (!t || !lineId) return false
  send({ edit: true, lineId, text: t })
  return true
}

/** RealmScreen answered one note (`tablelog.ack`) — here, and passed to every other window. */
export function tableLogAck(msg, { relay = true } = {}) {
  const id = str(msg?.clientId)
  const meant = arr(msg?.to).includes(game.user?.id)
  if (id && mine.has(id)) { mine.delete(id); redraw() }
  if (meant && str(msg?.text)) ui.notifications?.[msg?.ok ? "info" : "warn"](str(msg.text))
  if (relay) try { game.socket?.emit(CHANNEL, { t: "tablelog.ack", clientId: id, ok: !!msg?.ok, text: str(msg?.text), to: arr(msg?.to) }) } catch { /* no socket */ }
  return { ok: true }
}

// ── the sidebar tab ───────────────────────────────────────────
// ONE list (the user, 2026-11-18): everything the DM and the players capture during the game, with
// RealmScreen's own Stage / Clock / Foundry lines — the same list Session Over's Recap shows when the game
// ends, drawn the same way (its .pb-so-* look: a "Day N" badge + the date per in-world day, a spine with a
// dot per line, who wrote it). While the game runs:
//   • click your own words to change them (the GM: any line)
//   • "+" between two lines, or "Add a line" at the end of a day, puts one in there
//   • the box at the bottom adds what just happened; "Only me + GM" keeps a line private
// Keep / GM / Drop is not here: that's the GM's job when the game ends (Session Over, the sort).
const AUTO_ICON = { Stage: "fa-masks-theater", Shown: "fa-eye", Clock: "fa-clock", Foundry: "fa-dice-d20", Auto: "fa-wand-magic-sparkles" }
let keepScroll = null                     // where the list was scrolled, while a line is being changed
let editing = null                        // the line whose words are being changed
let inserting = null                      // { after, dayKey } — where a new line is being put in
const initialOf = (s) => esc(String(s || "?").trim().charAt(0).toUpperCase() || "?")
function whoHtml(l) {
  let pic
  if (l.auto) pic = `<span class="pb-so-whopic is-auto"><i class="fa-solid ${AUTO_ICON[l.who] || AUTO_ICON.Auto}" inert></i></span>`
  else if (l.gm) pic = `<span class="pb-so-whopic is-gm"><i class="fa-solid fa-crown" inert></i></span>`
  else {
    const u = l.uid ? game.users?.get?.(l.uid) : null
    const src = u?.character?.img || u?.avatar || ""
    pic = `<span class="pb-so-whopic">${src ? `<img src="${esc(src)}" alt="">` : initialOf(l.who)}</span>`
  }
  const name = l.gm ? "GM" : l.uid && l.uid === game.user?.id ? "You" : l.who
  return `<span class="pb-so-whochip" data-tooltip="${esc(name)}">${pic}<span class="pb-so-whoname">${esc(name)}</span></span>`
}
// "MistMorn 7, 98 – day 1" → "Day 1" badge + the date, on a thin rule (Session Over's day head)
function dayHeadHtml(h) {
  const i = h.lastIndexOf(" – ")
  const date = i > 0 ? h.slice(0, i) : h, n = i > 0 ? h.slice(i + 3) : ""
  return `<div class="pb-so-dayhead">${n ? `<span class="pb-so-dayn">${esc(n.replace(/^day/, "Day"))}</span>` : ""}<span class="pb-so-daydate">${esc(date)}</span></div>`
}
const fieldHtml = (name, placeholder, value = "") =>
  `<input type="text" class="pb-so-edit" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">`
function insHtml(after, dayKey, end = false) {
  const open = inserting && inserting.after === (after || null) && inserting.dayKey === dayKey && !!inserting.end === end
  if (open) return `<li class="pb-so-line pb-tl-adding"><span class="pb-so-dot" aria-hidden="true"></span>${fieldHtml("insert", "Add a line here…")}</li>`
  return `<li class="pb-so-ins${end ? " is-end" : ""}"><button type="button" data-action="insert" data-after="${esc(after || "")}" data-day="${dayKey ?? ""}" data-end="${end ? 1 : ""}" data-tooltip="Add a line here" aria-label="Add a line here"><i class="fa-solid fa-plus" inert></i>${end ? "<span>Add a line</span>" : ""}</button></li>`
}
function lineHtml(l) {
  const vis = VIS_IDS.includes(l.vis) ? l.vis : "public"
  const own = !l.gm && l.uid && l.uid === game.user?.id
  const priv = l.just || vis === "dm"
  if (editing === l.id) {
    return `<li class="pb-so-line is-${esc(vis)}"><span class="pb-so-dot is-${esc(vis)}" aria-hidden="true"></span>${fieldHtml("edit", "The line’s words", l.text)}${whoHtml(l)}</li>`
  }
  const can = canEdit(l, game.user?.id, isGM()) && !l.waiting
  const undo = !l.gm && !l.auto && canUndo(l, game.user?.id, isGM())
  const mark = priv ? `<i class="fa-solid fa-eye-slash pb-so-dmmark" data-tooltip="${esc(own || (isGM() && !l.uid) ? "Hidden from the players" : "Hidden from the players: only its writer and the GM")}" inert></i>` : ""
  const text = `<span class="pb-so-text${can ? " is-edit" : ""}"${can ? ` role="button" tabindex="0" data-action="edit" data-id="${esc(l.id)}" data-tooltip="Click to change the words"` : ""}>${mark}${esc(l.text)}${l.edited ? `<span class="pb-so-fixed">edited</span>` : ""}</span>`
  const x = undo ? `<a class="pb-tl-x" data-action="undo" data-id="${esc(l.id)}" data-tooltip="Take it back"><i class="fa-solid fa-xmark"></i></a>` : ""
  return `<li class="pb-so-line pb-tl-line is-${esc(vis)}${l.waiting ? " is-waiting" : ""}${l.kind === "quote" ? " is-quote" : ""}"><span class="pb-so-dot is-${esc(vis)}" aria-hidden="true"></span>${text}${whoHtml(l)}${x}${l.waiting ? "" : visHtml(l, vis)}</li>`
}
// Players / GM / Drop on the far right of every line, the same switch as the box (the user, 2026-11-18):
// anyone at the table can press it at any time. GM = hidden from everyone but the writer and the GM;
// Drop = left out of the recap, shown greyed and crossed out, and can still be pressed back.
const VIS_IDS = ["public", "dm", "drop"]
const VIS_SEG = [["public", "Players", "Everyone sees it"], ["dm", "GM", "Hidden from the players: only its writer and the GM"], ["drop", "Drop", "Left out of the recap"]]
function visHtml(l, cur) {
  return `<span class="pb-tl-seg pb-tl-seg--sm" role="radiogroup" aria-label="Who sees this line">${VIS_SEG.map(([id, label, tip]) => {
    const off = id === "public" && l.locked
    return `<button type="button" role="radio" class="${cur === id ? "active" : ""}" data-action="vis" data-id="${esc(l.id)}" data-vis="${id}" aria-checked="${cur === id}" data-tooltip="${esc(off ? "A GM-only line can’t go to the players" : tip)}"${off || cur === id ? " disabled" : ""}>${label}</button>`
  }).join("")}</span>`
}
function tabHtml() {
  const log = myLog()
  // A player only ever gets their OWN campaign's log, so "nothing" may mean another campaign is playing.
  if (!log || !log.live) {
    return `<p class="pb-so-faint pb-tl-off">${isGM() ? "No game running. Everything captured during your next session shows here." : "No game running. Everything captured during your session shows here."}</p>`
  }
  if (!seated(log)) return `<p class="pb-so-faint pb-tl-off">You aren’t seated in the game that’s running.</p>`
  const lines = arr(log.lines)
  // one block per in-world day, as Session Over groups them (a line without a day joins the day before)
  const days = []
  for (const l of lines) {
    const k = l.dayKey != null ? String(l.dayKey) : days.length ? days[days.length - 1].key : "u"
    let d = days[days.length - 1]
    if (!d || d.key !== k) { d = { key: k, dayKey: l.dayKey, header: l.day || "", rows: [] }; days.push(d) }
    if (!d.header && l.day) d.header = l.day
    d.rows.push(l)
  }
  const saving = [...mine.values()].map(o => `<li class="pb-so-line is-saving"><span class="pb-so-dot" aria-hidden="true"></span><span class="pb-so-text">${esc(o.text)}</span>${whoHtml({ uid: game.user?.id, who: "You" })}</li>`).join("")
  const body = days.map((d, di) => `<div class="pb-so-day">${d.header ? dayHeadHtml(d.header) : ""}<ol class="pb-so-lines">`
    + d.rows.map((l, i) => (i > 0 ? insHtml(d.rows[i - 1].id, d.dayKey) : "") + lineHtml(l)).join("")
    + (di === days.length - 1 ? saving : "")
    + insHtml(d.rows[d.rows.length - 1].id, d.dayKey, true)
    + `</ol></div>`).join("")
  return `
    <header class="pb-tl-head"><h4>${esc(log.live.name)}${log.live.number != null ? ` <span>Session ${log.live.number}</span>` : ""}</h4><i class="fa-solid fa-circle pb-tl-live" data-tooltip="Game running"></i></header>
    <div class="pb-tl-scroll pb-so-recap">${body || (saving ? `<div class="pb-so-day"><ol class="pb-so-lines">${saving}</ol></div>` : `<p class="pb-so-faint pb-tl-empty">Nothing yet. What happened first?</p>`)}</div>
    <form class="pb-tl-compose chat-form${boxVis === "dm" ? " is-private" : ""}" autocomplete="off">
      <div class="pb-tl-controls">
        <div class="pb-tl-seg" role="radiogroup" aria-label="Who sees your line">${[["public", "Players", "Everyone at the table sees it"], ["dm", "GM", "Hidden from the players"]].map(([id, label, tip]) =>
          `<button type="button" role="radio" class="${boxVis === id ? "active" : ""}" data-action="boxVis" data-vis="${id}" aria-checked="${boxVis === id}" data-tooltip="${tip}">${label}</button>`).join("")}</div>
        <div class="control-buttons">
          <button type="button" class="ui-control icon pb-tl-marksbtn" data-action="sheet" aria-pressed="${sheetOpen}" data-tooltip="${sheetOpen ? "Hide the marks" : "Show the marks"}" aria-label="Marks"><span>@#$</span></button>
        </div>
      </div>
      ${sheetOpen ? sheetHtml() : ""}
      <div class="pb-tl-inputwrap"><ul class="pb-tl-suggest" role="listbox" aria-label="Names" hidden></ul><textarea name="note" class="pb-tl-input" placeholder="${boxVis === "dm" ? "Just for the GM…" : "What just happened?"}"></textarea></div>
    </form>`
}

// The marks, as ONE faint line of hints — RealmScreen's own capture box pattern (SessionCapture.jsx CaptureHints:
// "@ person  # place  $ loot …", hover brightens, click puts the mark in). The user, 2026-11-18: the boxed cheat
// sheet was "bulky and ugly". A player's line can't be GM-only (~); time marks move the clock for anyone
// (the user, 2026-11-18: "players time marks can move the clock. and always do, unless dropped").
const MARKS = [
  ["@", "person", "Someone you met: @Varek"],
  ["#", "place", "Somewhere: #Saltreach"],
  ["$", "loot", "Treasure, money, an item: $40 gold"],
  ["?", "question", "Something to find out: ?who sent the letter"],
  ["!", "thread", "A hook to follow up later"],
  ["\u201C", "quote", "Word for word: \u201C\u2026\u201D @Who said it"],
  ["+2h", "time", "Time passing: +2h, +1d, +1w. Moves the clock now; dropping the line moves it back"],
]
const GM_MARKS = [
  ["~", "GM only", "Start the line with ~: never reaches the players"],
]
const SHEET_KEY = `${MOD}.tablelogMarks`
let sheetOpen = (() => { try { return localStorage.getItem(SHEET_KEY) !== "0" } catch { return true } })()   // shown until hidden
function sheetHtml() {
  const hint = ([m, label, tip]) => `<button type="button" class="pb-tl-hint" data-action="mark" data-mark="${esc(m)}" data-tooltip="${esc(tip)}"><b>${esc(m)}</b>${esc(label)}</button>`
  return `<div class="pb-tl-hints">${[...MARKS, ...(isGM() ? GM_MARKS : [])].map(hint).join("")}</div>`
}

let TabClass = null
function makeTab() {
  const Abs = foundry?.applications?.sidebar?.AbstractSidebarTab
  if (!Abs) return null
  TabClass = class RealmTableLogTab extends Abs {
    static tabName = TAB
    static DEFAULT_OPTIONS = {
      classes: ["pb-tablog", "pb-session-over", "flexcol"],
      window: { title: "Table log", icon: ICON },
      actions: {
        undo: function (ev, t) { send({ lineId: t.dataset.id }) },
        edit: function (ev, t) { editing = t.dataset.id; inserting = null; this.render() },
        vis: function (ev, t) { ev.stopPropagation(); setLineVis(t.dataset.id, t.dataset.vis) },
        sheet: function () {
          sheetOpen = !sheetOpen
          try { localStorage.setItem(SHEET_KEY, sheetOpen ? "1" : "0") } catch { /* private mode */ }
          this.render()
        },
        mark: function (ev, t) {
          const ta = this.element?.querySelector?.("textarea[name=note]")
          if (!ta) return
          const m = t.dataset.mark || ""
          const at = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? at
          const pre = at > 0 && !/\s$/.test(ta.value.slice(0, at)) ? " " : ""
          ta.value = ta.value.slice(0, at) + pre + m + ta.value.slice(end)
          draft = ta.value
          const pos = at + pre.length + m.length
          ta.focus(); ta.setSelectionRange(pos, pos)
        },
        boxVis: function (ev, t) {
          boxVis = t.dataset.vis === "dm" ? "dm" : "public"
          try { localStorage.setItem(VIS_KEY, boxVis) } catch { /* private mode */ }
          this.render()
        },
        insert: function (ev, t) {
          const dk = t.dataset.day === "" ? null : Number(t.dataset.day)
          inserting = { after: t.dataset.after || null, dayKey: Number.isFinite(dk) ? dk : null, end: !!t.dataset.end }
          editing = null; this.render()
        },
      },
    }
    async _renderHTML() { const el = document.createElement("div"); el.className = "pb-tablog-body"; el.innerHTML = tabHtml(); return el }
    _replaceHTML(result, content) {
      const had = content.querySelector?.("textarea[name=note]")
      const focused = had && document.activeElement === had
      const caret = focused ? [had.selectionStart, had.selectionEnd] : null
      const old = content.querySelector?.(".pb-tl-scroll")
      keepScroll = old && old.scrollHeight - old.scrollTop - old.clientHeight > 24 ? old.scrollTop : null   // not at the bottom: stay put
      content.replaceChildren(result)
      wire(content, focused, caret)
    }
  }
  return TabClass
}
function submit(root) {
  const ta = root?.querySelector?.("textarea[name=note]")
  const text = str(ta?.value ?? draft)
  if (!text) return
  if (addNote(text, { vis: boxVis })) { draft = ""; if (ta) ta.value = "" }
}
function wire(root, refocus = false, caret = null) {
  const ta = root.querySelector("textarea[name=note]")
  const list = root.querySelector(".pb-tl-scroll")
  if (list) list.scrollTop = keepScroll != null && (editing || inserting) ? keepScroll : list.scrollHeight
  if (!ta) return
  ta.value = draft
  const sug = wireSuggest(root, ta)
  ta.addEventListener("input", () => { draft = ta.value; sug.update() })
  ta.addEventListener("keydown", (e) => {
    if (sug.key(e)) return
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(root) }
  })
  root.querySelector("form.pb-tl-compose")?.addEventListener("submit", (e) => { e.preventDefault(); submit(root) })
  // the in-place fields: change a line's words / put a line in between (Enter or leaving saves, Esc cancels)
  const field = root.querySelector("input.pb-so-edit")
  if (field) {
    let over = false
    const finish = (save) => {
      if (over) return
      over = true
      const t = field.value.replace(/\s+/g, " ").trim()
      if (save && t) {
        if (field.name === "edit") { const l = arr(myLog()?.lines).find(x => x.id === editing); if (l && t !== l.text) editNote(l.id, t) }
        else if (inserting) addNote(t, { vis: boxVis, after: inserting.after, dayKey: inserting.dayKey })
      }
      editing = null; inserting = null
      redraw()
    }
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true) }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false) }
    })
    field.addEventListener("blur", () => finish(true))
    field.focus(); field.setSelectionRange(field.value.length, field.value.length)
    return
  }
  if (refocus) { ta.focus(); if (caret) ta.setSelectionRange(caret[0], caret[1]); sug.update() }
}

// @ / # suggestions under the caret: only the names RealmScreen says this user may see (the user, 2026-11-18:
// "only people the user is allowed to know / isn't hidden from"). ↑↓ pick, Enter / Tab put it in, Esc closes.
function myNames() {
  const book = myLog()?.names || {}
  return isGM() ? arr(book.gm) : arr(book[game.user?.id])
}
// The mark Esc closed (its start + the text before it): a re-render doesn't reopen it; typing on does.
let shut = null
function wireSuggest(root, ta) {
  const ul = root.querySelector(".pb-tl-suggest")
  let items = [], pick = 0, mark = null
  const close = () => { items = []; mark = null; if (ul) { ul.hidden = true; ul.replaceChildren() } }
  const draw = () => {
    if (!ul) return
    if (!items.length) return close()
    ul.innerHTML = items.map((x, i) => `<li role="option" class="pb-tl-sug${i === pick ? " active" : ""}" aria-selected="${i === pick}" data-i="${i}"><i class="fa-solid ${x.t === "l" ? "fa-location-dot" : "fa-user"}" inert></i><span>${esc(x.n)}</span></li>`).join("")
    ul.hidden = false
  }
  const choose = (x) => {
    if (!x || !mark) return
    const r = completeMark(ta.value, mark, x.n)
    ta.value = r.text; draft = r.text
    ta.focus(); ta.setSelectionRange(r.caret, r.caret)
    close()
  }
  const update = () => {
    mark = ta.selectionStart === ta.selectionEnd ? activeMark(ta.value, ta.selectionStart) : null
    if (mark && shut && shut.start === mark.start && shut.head === ta.value.slice(0, mark.end)) mark = null
    else shut = null
    items = mark ? suggestNames(myNames(), mark, { own: isGM() ? "" : str(game.user?.character?.name) }) : []
    pick = 0
    draw()
  }
  ul?.addEventListener("mousedown", (e) => {
    const li = e.target.closest?.("li[data-i]")
    if (!li) return
    e.preventDefault()   // keep the caret in the box
    choose(items[Number(li.dataset.i)])
  })
  ta.addEventListener("click", update)
  ta.addEventListener("blur", () => setTimeout(close, 120))
  const key = (e) => {
    if (!items.length) return false
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); pick = (pick + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length; draw(); return true }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(items[pick]); return true }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (mark) shut = { start: mark.start, head: ta.value.slice(0, mark.end) }; close(); return true }
    return false
  }
  return { update, key, close }
}

let drawT = 0
function redraw() {
  clearTimeout(drawT)
  drawT = setTimeout(() => {
    const t = ui?.[TAB]
    if (t?.rendered) t.render()
    if (t?.popout?.rendered) t.popout.render()
  }, 30)
}
function openTab() {
  try { ui.sidebar?.changeTab?.(TAB, "primary") } catch { /* older Foundry */ }
  try { ui.sidebar?.expand?.() } catch { /* already open */ }
}

// ── chat: /note, and the message menu ─────────────────────────
Hooks.on("chatMessage", (_log, message) => {
  const c = noteCommand(message)
  if (!c) return
  const log = myLog()
  if (!log || !log.live) { ui.notifications?.warn(isGM() ? "No game is running. Notes open when the session starts." : "No game of yours is running. Notes open when your session starts."); return false }
  if (!seated(log)) { ui.notifications?.warn("You aren’t seated in the game that’s running."); return false }
  if (!c.text) { openTab(); return false }
  addNote(c.text, { vis: boxVis })
  return false
})

const msgOf = (li) => {
  const el = li instanceof HTMLElement ? li : li?.[0]
  const id = el?.dataset?.messageId || el?.closest?.("[data-message-id]")?.dataset?.messageId
  return id ? game.messages?.get(id) : null
}
const canUse = (li) => { const m = msgOf(li); const log = myLog(); return !!m && !m.flags?.[MOD]?.hidden && !!log?.live && seated(log) }
function bodyOf(m) {
  const r = arr(m.rolls)[0]
  if (r && Number.isFinite(r.total)) return `${chatText(m.flavor) || r.formula}: ${r.total}`
  return chatText(m.content).slice(0, 500)
}
function speakerOf(m) {
  const a = m.speaker?.actor ? game.actors?.get(m.speaker.actor) : null
  return str(m.speaker?.alias) || str(a?.name) || str(m.author?.character?.name) || str(m.author?.name)
}
function menuItems() {
  return [
    {
      name: "Add to table log", icon: `<i class="${ICON}"></i>`, condition: canUse,
      callback: (li) => { const m = msgOf(li); if (!m) return; const b = bodyOf(m); if (b) addNote(`${speakerOf(m) ? speakerOf(m) + ": " : ""}${b}`, { just: false }) },
    },
    {
      name: "Quote in table log", icon: `<i class="fa-solid fa-quote-left"></i>`, condition: (li) => canUse(li) && !arr(msgOf(li)?.rolls).length,
      callback: (li) => { const m = msgOf(li); if (!m) return; const text = chatText(m.content); if (text) send({ quote: { text: text.slice(0, 500), speaker: speakerOf(m), msgId: m.id } }) },
    },
  ]
}
Hooks.on("getChatMessageContextOptions", (_app, options) => { if (Array.isArray(options)) options.push(...menuItems()) })   // V13+
Hooks.on("getChatLogEntryContext", (_html, options) => { if (Array.isArray(options)) options.push(...menuItems()) })       // V11/V12

// ── hooks ─────────────────────────────────────────────────────
Hooks.once("init", () => {
  const S = foundry?.applications?.sidebar?.Sidebar
  const C = makeTab()
  if (!S || !C || !S.TABS || S.TABS[TAB]) return
  // After the Calendar tab (or the Journal), as Foundry's own tabs do (right-click pops it out).
  const next = {}
  const after = S.TABS.realmcal ? "realmcal" : "journal"
  for (const [k, v] of Object.entries(S.TABS)) { next[k] = v; if (k === after) next[TAB] = { tooltip: "Table log", icon: ICON } }
  if (!next[TAB]) next[TAB] = { tooltip: "Table log", icon: ICON }
  S.TABS = next
  CONFIG.ui[TAB] = C
})
Hooks.once("ready", () => {
  try { game.socket?.on(CHANNEL, (m) => { if (m && m.t === "tablelog.ack") tableLogAck(m, { relay: false }) }) } catch { /* no socket */ }
})
onSlice(() => redraw())
Hooks.on("pendantBridgeLive", () => redraw())

// For a render harness outside Foundry (no effect in Foundry).
export const _test = { tabHtml, makeTab, mine }
