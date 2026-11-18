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
import { cleanLog, noteCommand, canUndo, chatText } from "./table-log-model.js"

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
let draft = "", justMe = false
function send(data) {
  const clientId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  if (data.text != null || data.quote) mine.set(clientId, { text: data.quote ? `“${data.quote.text}”` : data.text, just: !!data.just, ts: Date.now() })
  if (!realmLive()) ui.notifications?.info("RealmScreen isn’t connected. Your note is sent when it is.")
  Promise.resolve(sendOp(data.lineId ? "tablelog.undo" : "tablelog.note", { ...data, clientId })).then((r) => {
    if (r !== false) return
    mine.delete(clientId)
    ui.notifications?.warn("Couldn’t reach RealmScreen. Try again.")
    redraw()
  }).catch(() => {})
  // No answer in a minute → stop showing it as saving (it may still arrive).
  setTimeout(() => { if (mine.delete(clientId)) redraw() }, 60000)
  redraw()
}
export function addNote(text, { just = false } = {}) {
  const t = str(text)
  if (!t) return false
  send({ text: t, just: !!just })
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
// Made for someone opening it the first time (the user, 2026-11-18): a plain "how this works" box (open
// until there are notes, then one line you can open), labelled buttons for the @ # $ ? marks instead of a
// cryptic placeholder, an example note while it's empty, and every line saying who can see it.
const KIND = { quote: "Quote", question: "Question" }
const MARKS = [
  ["@", "Person", "Link someone you know: @ then their name"],
  ["#", "Place", "Link a place: # then its name"],
  ["$", "Loot", "Treasure, a price, an item: $ then what it is"],
  ["?", "Question", "Something to ask or find out later: start with ?"],
]
const HELP_KEY = `${MOD}.tablelogHelp`
const helpPref = () => { try { return localStorage.getItem(HELP_KEY) } catch { return null } }   // "open" | "closed" | null
function lineHtml(l) {
  const me = !l.gm && l.uid && l.uid === game.user?.id
  const undo = !l.gm && canUndo(l, game.user?.id, isGM())
  const who = l.gm ? "You (GM)" : `${l.who}${me ? " (you)" : ""}`
  const seen = l.gm ? "Only you see this" : l.just ? "Only them + GM" : l.waiting ? "Waiting for the GM" : ""
  const tags = [seen, KIND[l.kind] || ""].filter(Boolean)
  return `<li class="pb-tablog-line${me || l.gm ? " is-mine" : ""}${l.just || l.gm ? " is-just" : ""}${l.waiting ? " is-waiting" : ""}">
    <header><strong>${esc(who)}</strong><span>${esc([l.when, ...tags].filter(Boolean).join(" · "))}</span></header>
    <p>${esc(l.text)}</p>
    ${undo ? `<a data-action="undo" data-id="${esc(l.id)}" data-tooltip="Take this note back"><i class="fa-solid fa-rotate-left"></i> Take back</a>` : ""}
  </li>`
}
function helpHtml(log, hasLines) {
  const pref = helpPref()
  const open = pref ? pref === "open" : !hasLines
  const steps = isGM()
    ? [
        "Your players write down what they notice: a name, a price, a clue, a great line. It shows up here as they write.",
        "Your own notes show here too, but only you see them.",
        "Everything stays here for the whole session. When it ends, you sort it into the recap in RealmScreen.",
      ]
    : [
        "Write down anything worth remembering: a name, a price, a clue, a great line.",
        log.showLog ? "Everyone at the table sees your notes." + (log.justMe ? " Tick <b>Only me + GM</b> to keep one private." : "") : "Only you and the GM see your notes.",
        "Your notes stay here for the whole session. Afterwards they go into the session recap.",
      ]
  return `<details class="pb-tablog-help"${open ? " open" : ""}>
    <summary><i class="fa-solid fa-circle-question"></i> How the table log works</summary>
    <ol>${steps.map(t => `<li>${t}</li>`).join("")}</ol>
    <p class="hint">Also: type <code>/note …</code> in chat, or right-click any chat message › <b>Add to table log</b>.</p>
  </details>`
}
function tabHtml() {
  const log = myLog()
  // A player only ever gets their OWN campaign's log, so "nothing" may mean another campaign is playing.
  if (!log || !log.live) {
    return `<section class="pb-tablog-off">
      <i class="${ICON}"></i>
      <h4>Table log</h4>
      <p>${isGM() ? "Opens when you start a session in RealmScreen." : "Opens when your GM starts your session."}</p>
      <p class="hint">During a session, everyone at the table can jot down names, prices, clues and great lines here. Everything written stays here until the session ends.</p>
    </section>`
  }
  if (!seated(log)) return `<section class="pb-tablog-off"><i class="${ICON}"></i><h4>Table log</h4><p>You aren’t seated in the game that’s running.</p><p class="hint">Ask your GM to add you to this campaign’s table.</p></section>`
  const saving = [...mine.values()].map(o => `<li class="pb-tablog-line is-mine is-saving"><header><strong>You</strong><span>Saving…</span></header><p>${esc(o.text)}</p></li>`).join("")
  const lines = arr(log.lines)
  const head = `${esc(log.live.name)}${log.live.number != null ? ` · Session ${log.live.number}` : ""}`
  const empty = !lines.length && !mine.size
  const example = `<li class="pb-tablog-line is-example" aria-hidden="true"><header><strong>Example</strong><span>what a note looks like</span></header>
      <p>@Harlan the smith wants 40 gold for the $silver sword. ?Why is he in a hurry</p></li>`
  return `
    <header class="pb-tablog-head"><h4>${head}</h4>
      <span class="pb-tablog-live"><i class="fa-solid fa-circle"></i> Session running · notes stay until it ends</span></header>
    ${helpHtml(log, !empty)}
    <ol class="pb-tablog-list">${empty ? example : lines.map(l => lineHtml(l)).join("") + saving}</ol>
    <form class="pb-tablog-form" autocomplete="off">
      <textarea name="note" rows="2" placeholder="Write a note…"></textarea>
      <div class="pb-tablog-marks">${MARKS.map(([c, label, tip]) => `<button type="button" data-mark="${esc(c)}" data-tooltip="${esc(tip)}"><b>${esc(c)}</b> ${esc(label)}</button>`).join("")}</div>
      <footer>
        ${log.justMe && !isGM() ? `<label class="pb-tablog-just" data-tooltip="Only you and the GM see this note"><input type="checkbox" name="just" ${justMe ? "checked" : ""}> Only me + GM</label>` : isGM() ? `<span class="hint">Only you see your notes</span>` : "<span></span>"}
        <button type="submit"><i class="${ICON}"></i> Add note</button>
      </footer>
      ${log.wait && !isGM() ? `<p class="hint">The GM approves each note before it joins the log.</p>` : ""}
    </form>`
}

let TabClass = null
function makeTab() {
  const Abs = foundry?.applications?.sidebar?.AbstractSidebarTab
  if (!Abs) return null
  TabClass = class RealmTableLogTab extends Abs {
    static tabName = TAB
    static DEFAULT_OPTIONS = {
      classes: ["pb-tablog", "flexcol"],
      window: { title: "Table log", icon: ICON },
      actions: {
        undo: function (ev, t) { send({ lineId: t.dataset.id }) },
      },
    }
    async _renderHTML() { const el = document.createElement("div"); el.className = "pb-tablog-body"; el.innerHTML = tabHtml(); return el }
    _replaceHTML(result, content) {
      const had = content.querySelector?.("textarea[name=note]")
      const focused = had && document.activeElement === had
      const caret = focused ? [had.selectionStart, had.selectionEnd] : null
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
  if (addNote(text, { just: justMe })) { draft = ""; if (ta) ta.value = "" }
}
function wire(root, refocus = false, caret = null) {
  const ta = root.querySelector("textarea[name=note]")
  const list = root.querySelector(".pb-tablog-list")
  if (list) list.scrollTop = list.scrollHeight
  if (!ta) return
  ta.value = draft
  ta.addEventListener("input", () => { draft = ta.value })
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(root) } })
  root.querySelector("form")?.addEventListener("submit", (e) => { e.preventDefault(); submit(root) })
  root.querySelector("input[name=just]")?.addEventListener("change", (e) => { justMe = !!e.target.checked })
  // the mark buttons put their symbol at the caret (with a space before it when needed)
  for (const b of root.querySelectorAll("[data-mark]")) b.addEventListener("click", (e) => {
    e.preventDefault()
    const c = b.dataset.mark, at = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? at
    const pre = at > 0 && !/\s$/.test(ta.value.slice(0, at)) ? " " : ""
    ta.value = ta.value.slice(0, at) + pre + c + ta.value.slice(end)
    draft = ta.value
    const pos = at + pre.length + c.length
    ta.focus(); ta.setSelectionRange(pos, pos)
  })
  // remember only what the user clicks ("toggle" also fires when a box is drawn open)
  const help = root.querySelector(".pb-tablog-help")
  help?.querySelector("summary")?.addEventListener("click", () => { try { localStorage.setItem(HELP_KEY, help.open ? "closed" : "open") } catch { /* private mode */ } })
  if (refocus) { ta.focus(); if (caret) ta.setSelectionRange(caret[0], caret[1]) }
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
  addNote(c.text, { just: justMe })
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
