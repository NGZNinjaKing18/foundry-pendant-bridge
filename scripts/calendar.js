// ──────────────────────────────────────────────────────────────
// Calendar — RealmScreen's Chronicle Calendar in Foundry.
//
//   • a Calendar tab in the sidebar (V13+: a real sidebar tab, right-click pops
//     it out like any other): today, what's coming up, what happened lately
//   • the Calendar window (ApplicationV2): a month grid, a day panel
//
// Players can only look. They see their own cut, from their private whisper
// slice (scripts/private.js + calendar-model.js `calendarFor`).
//
// The GM can add an event, a note or a holiday (+ on a day, or double-click it),
// edit or remove one in the day panel, and drag one to another day. Each change
// goes to RealmScreen as `calendar.edit` — straight from the linked window, or as
// a hidden whisper to the GMs that the linked window passes on (private.js
// `sendOp`). While RealmScreen is closed those whispers wait and are sent when it
// reconnects; the window shows them as waiting. RealmScreen saves the change,
// answers `calendar.ack`, and sends the calendar back (`calendar.set`).
//
// RealmScreen owns the calendar and does all the date maths; this only draws.
// Native-first: Foundry's sidebar-tab and window classes, its CSS variables and
// light/dark theme; CSS scoped to .pb-calendar / .pb-caltab.
// ──────────────────────────────────────────────────────────────

import { mySlice, onSlice, setFull, fullCalendar, sendOp } from "./private.js"
import { realmLive } from "./live.js"
import { applyTheme } from "./campaign-page.js"
import { parseWho, monthAt, daysOf, dayLabel, yearLabel, weekdayName, overlay } from "./calendar-model.js"

const MOD = "pendant-bridge"
const CHANNEL = `module.${MOD}`
const APP_ID = "pb-calendar"
const TAB = "realmcal"
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const str = (v) => (typeof v === "string" ? v.trim() : "")
const arr = (v) => (Array.isArray(v) ? v : [])
const flagsOf = (m) => m?.flags?.[MOD] || {}
const KIND = { event: "Event", note: "Note", holiday: "Holiday", session: "Session", bday: "Birthday" }
const KCOL = { event: "#38bdf8", note: "#8fd0a3", holiday: "#f59e0b", session: "#b49be8", bday: "#ff69b4" }

// ── the data ──────────────────────────────────────────────────
const isGM = () => !!game.user?.isGM
/** The calendar this user may see (GM: the full copy). */
export function myCalendar() { return isGM() ? fullCalendar() : (mySlice().calendar || null) }

/** The `calendar.set` command (the linked GM window). */
export async function setCalendar(cal) {
  if (!isGM()) throw new Error("Only the GM can set the calendar")
  setFull("calendar", cal && typeof cal === "object" && Array.isArray(cal.months) ? cal : null)
  redraw()
  return { ok: true }
}

// The GM's changes RealmScreen doesn't have yet: sent from here (in memory, by clientId) and
// whispers still waiting for a linked window (they survive a reload).
const mine = new Map()          // clientId → op with state: 'saving' | 'waiting' | 'done'
function waitingOps() {
  if (!isGM()) return []
  const out = []
  for (const m of game.messages?.filter(m => flagsOf(m).op?.type === "calendar.edit") ?? []) {
    const d = flagsOf(m).op.data || {}
    if (d.clientId && !mine.has(d.clientId)) out.push({ ...d, state: "waiting" })
  }
  return out
}
function pendingOps() {
  const live = realmLive()
  const local = [...mine.values()].map(o => ({ ...o, state: o.state === "done" ? "saving" : (o.state === "saving" && !live ? "waiting" : o.state) }))
  return [...local, ...waitingOps()]
}
/** Every entry as shown: RealmScreen's, with the GM's waiting changes over it. */
function entries(cal) { return isGM() ? overlay(cal?.items, pendingOps()) : arr(cal?.items) }

function send(op) {
  const cal = myCalendar()
  const clientId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const data = { ...op, clientId, calendarId: cal?.calendarId || null }
  mine.set(clientId, { ...data, state: realmLive() ? "saving" : "waiting" })
  if (!realmLive()) ui.notifications?.info("RealmScreen isn’t connected. This saves to it when it is.")
  Promise.resolve(sendOp("calendar.edit", data)).then((r) => {
    if (r !== false) return
    mine.delete(clientId)
    ui.notifications?.warn("Couldn’t reach RealmScreen. Try again.")
    redraw()
  }).catch(() => {})
  redraw()
  // Never leave a change hanging: no answer in a minute → it's shown as waiting.
  setTimeout(() => { const o = mine.get(clientId); if (o && o.state === "saving") { o.state = "waiting"; redraw() } }, 60000)
}

/** RealmScreen answered one change (`calendar.ack`) — here, and passed to every other window. */
export function calendarAck(msg, { relay = true } = {}) {
  const id = str(msg?.clientId)
  const o = id ? mine.get(id) : null
  if (o) {
    if (msg.ok) { o.state = "done"; setTimeout(() => { if (mine.get(id)?.state === "done") { mine.delete(id); redraw() } }, 4000) }
    else { mine.delete(id); ui.notifications?.warn(str(msg.text) || "RealmScreen couldn’t save that.") }
    redraw()
  } else if (!msg?.ok && !relay && arr(msg?.to).includes(game.user?.id) && str(msg?.text)) {
    ui.notifications?.warn(str(msg.text))
  }
  if (relay) try { game.socket?.emit(CHANNEL, { t: "calendar.ack", clientId: id, ok: !!msg?.ok, text: str(msg?.text), to: arr(msg?.to) }) } catch { /* no socket */ }
  return { ok: true }
}

/** A festival day (no entries from Foundry yet — RealmScreen can't place them). */
function isFest(cal, k) {
  const m = arr(cal?.months)[monthAt(cal, k)]
  return !m || !!m.festival || !!daysOf(m)[k - m.k0]?.fest
}

// ── words ─────────────────────────────────────────────────────
function whoOptions(cal) {
  const opts = [["all", "Everyone"]]
  for (const c of arr(cal?.camps)) {
    const names = arr(c.users).map(id => game.users?.get(id)?.name).filter(Boolean)
    opts.push([`c:${c.id}`, `${c.name}${names.length ? ` (${names.join(", ")})` : ""}`])
  }
  for (const u of game.users?.filter(u => !u.isGM) ?? []) opts.push([`u:${u.id}`, `Only ${u.name}`])
  opts.push(["gm", "Only me"])
  return opts
}
function whoLabel(cal, who) {
  const w = parseWho(who)
  if (w.t === "all") return "Everyone"
  if (w.t === "gm") return "Only you"
  if (w.t === "c") return arr(cal?.camps).find(c => c.id === w.ids[0])?.name || "One campaign"
  return w.ids.map(id => game.users?.get(id)?.name || "a player").join(", ")
}
const statusWord = (p) => (p === "waiting" ? "Waits for RealmScreen" : p ? "Saving…" : "")

// ── the window ────────────────────────────────────────────────
let WinClass = null
function winClass() {
  const AppV2 = foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  if (WinClass) return WinClass
  WinClass = class CalendarWindow extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: APP_ID,
      classes: ["pb-calendar"],
      window: { title: "Calendar", icon: "fa-solid fa-calendar-days", resizable: true },
      position: { width: 860, height: 640 },
      actions: {
        prev: CalendarWindow.#prev, next: CalendarWindow.#next, today: CalendarWindow.#today,
        pick: CalendarWindow.#pick, add: CalendarWindow.#add, edit: CalendarWindow.#edit, remove: CalendarWindow.#remove,
        kind: CalendarWindow.#kind, cancel: CalendarWindow.#cancel, save: CalendarWindow.#save,
      },
    }
    mi = null          // the month shown (index into cal.months)
    sel = null         // the selected day (absolute key)
    form = null        // the open add / edit form

    #cal() { return myCalendar() }
    #todayK(cal) { return Number.isFinite(cal?.world) ? cal.world : arr(cal?.camps)[0]?.k ?? null }
    showDay(k) {
      const cal = this.#cal()
      const i = cal ? monthAt(cal, k) : -1
      if (i >= 0) { this.mi = i; this.sel = k }
    }
    #ensure(cal) {
      if (this.mi != null && arr(cal.months)[this.mi]) return
      const t = this.#todayK(cal)
      const i = t != null ? monthAt(cal, t) : -1
      this.mi = i >= 0 ? i : 0
      this.sel = i >= 0 ? t : arr(cal.months)[0]?.k0 ?? null
    }
    #keep() {
      const el = this.element
      if (!el || !this.form) return
      const v = (n) => el.querySelector(`[name=${n}]`)
      if (v("cName")) this.form.name = v("cName").value
      if (v("cNote")) this.form.note = v("cNote").value
      if (v("cWho")) this.form.who = v("cWho").value
      if (v("cEarly")) this.form.early = v("cEarly").checked
    }

    async _renderHTML() {
      this.#keep()
      const el = document.createElement("div")
      el.className = "pb-cal standard-form"
      const cal = this.#cal()
      if (!cal || !arr(cal.months).length) {
        el.innerHTML = `<p class="hint">${isGM() ? "RealmScreen hasn’t sent the calendar yet. It does while it’s connected." : "The calendar isn’t ready yet."}</p>`
        return el
      }
      this.#ensure(cal)
      const gm = isGM()
      const m = cal.months[this.mi]
      const items = entries(cal)
      const today = this.#todayK(cal)
      const cols = Math.max(1, arr(cal.dayNames).length || 7)
      const days = daysOf(m)
      const lead = m.festival ? 0 : (days[0]?.w || 0) % cols
      const byDay = new Map()
      for (const it of items) { if (it.k >= m.k0 && it.k < m.k0 + m.len) { if (!byDay.has(it.k)) byDay.set(it.k, []); byDay.get(it.k).push(it) } }
      const flags = (k) => gm ? arr(cal.camps).filter(c => c.k === k).map(c => `<span class="pb-cal-flag" data-tooltip="${esc(c.name)} is here">${esc(c.short)}</span>`).join("") : ""
      const chip = (it) => `<div class="pb-cal-chip${it.who === "gm" && gm ? " gmonly" : ""}" style="--k:${esc(it.color || KCOL[it.kind] || KCOL.event)}" data-id="${esc(it.id)}"${gm && it.edit ? ` draggable="true"` : ""} data-tooltip="${esc(it.name)}"><span>${esc(it.name)}</span>${it.pending ? `<i class="pb-cal-dot ${it.pending}"></i>` : ""}</div>`
      let cells = ""
      for (let i = 0; i < lead; i++) cells += `<div class="pb-cal-cell blank"></div>`
      for (const d of days) {
        const list = byDay.get(d.k) || []
        const cls = ["pb-cal-cell", d.k === today ? "today" : "", today != null && d.k < today ? "past" : "", d.k === this.sel ? "sel" : "", d.fest && !m.festival ? "fest" : ""].filter(Boolean).join(" ")
        cells += `<div class="${cls}" data-action="pick" data-k="${d.k}" tabindex="0" aria-label="${esc(dayLabel(cal, d.k))}">
          <div class="pb-cal-dn"><b>${d.n != null ? d.n : esc(d.fest)}</b>${flags(d.k)}</div>
          ${list.slice(0, 3).map(chip).join("")}${list.length > 3 ? `<div class="pb-cal-more">+${list.length - 3} more</div>` : ""}
          ${gm && !isFest(cal, d.k) ? `<button type="button" class="pb-cal-add" data-action="add" data-k="${d.k}" data-tooltip="Add on this day" aria-label="Add on this day"><i class="fa-solid fa-plus"></i></button>` : ""}
        </div>`
      }
      const dow = m.festival ? "" : arr(cal.dayNames).map(n => `<div>${esc(n)}</div>`).join("")
      const waiting = gm ? pendingOps().filter(o => o.state === "waiting").length : 0
      const live = realmLive()
      el.innerHTML = `
        <header class="pb-cal-tools">
          <button type="button" data-action="prev" data-tooltip="Previous" aria-label="Previous month"><i class="fa-solid fa-chevron-left"></i></button>
          <h2 class="pb-cal-mon">${esc(m.name)} <span>${esc(yearLabel(m))}</span></h2>
          <button type="button" data-action="next" data-tooltip="Next" aria-label="Next month"><i class="fa-solid fa-chevron-right"></i></button>
          <button type="button" data-action="today">Today</button>
          <span class="pb-cal-sp"></span>
          <span class="pb-cal-legend">${["event", "holiday", "session", "note", "bday"].map(k => `<span><i style="--k:${KCOL[k]}"></i>${KIND[k]}</span>`).join("")}</span>
        </header>
        <div class="pb-cal-body">
          <div class="pb-cal-gridwrap">
            ${dow ? `<div class="pb-cal-dow" style="--cols:${cols}">${dow}</div>` : ""}
            <div class="pb-cal-grid" style="--cols:${m.festival ? Math.min(cols, m.len) : cols}">${cells}</div>
          </div>
          <aside class="pb-cal-day">${this.#dayPanel(cal, items, gm)}</aside>
        </div>
        <footer class="pb-cal-foot">
          <i class="pb-cal-live ${live ? "on" : "off"}"></i>
          <span>${live ? "RealmScreen connected" : "RealmScreen isn’t connected"}</span>
          <span class="pb-cal-sp"></span>
          <span>${gm ? (waiting ? `${waiting} change${waiting === 1 ? "" : "s"} waiting to save` : live ? "Changes save to RealmScreen as you make them" : "You can still add. It saves when RealmScreen connects.") : "View only"}</span>
        </footer>`
      return el
    }

    #dayPanel(cal, items, gm) {
      const k = this.sel
      if (k == null) return ""
      const list = items.filter(i => i.k === k)
      const here = gm ? arr(cal.camps).filter(c => c.k === k).map(c => c.name) : []
      const wd = weekdayName(cal, k)
      let h = `<h3>${esc(dayLabel(cal, k))}</h3>${wd ? `<p class="hint">${esc(wd)}</p>` : ""}`
      if (here.length) h += `<p class="hint">${esc(here.join(", "))} ${here.length > 1 ? "are" : "is"} here</p>`
      if (gm && this.form && this.form.k === k) h += this.#formHtml(cal)
      if (!list.length && !(this.form && this.form.k === k)) h += `<p class="hint">${gm ? "Nothing on this day yet." : "Nothing you know of happens on this day."}</p>`
      for (const it of list) {
        const editable = gm && it.edit && !it.pending
        h += `<article class="pb-cal-item" style="--k:${esc(it.color || KCOL[it.kind] || KCOL.event)}">
          <strong>${esc(it.name)}</strong>
          ${it.note ? `<p>${esc(it.note)}</p>` : ""}
          <div class="pb-cal-meta"><span>${KIND[it.kind] || "Event"}</span>${gm ? `<span class="pb-cal-who${it.who === "gm" ? " gm" : ""}">${esc(whoLabel(cal, it.who))}</span>${it.early && it.kind !== "holiday" && it.kind !== "bday" && it.who !== "gm" ? `<span>shows early</span>` : ""}${it.pending ? `<span>${statusWord(it.pending)}</span>` : ""}` : ""}</div>
          ${editable ? `<div class="pb-cal-acts"><button type="button" data-action="edit" data-id="${esc(it.id)}"><i class="fa-solid fa-pen"></i> Edit</button><button type="button" data-action="remove" data-id="${esc(it.id)}"><i class="fa-solid fa-trash"></i> Remove</button></div>` : ""}
          ${gm && !it.edit && (it.kind === "session" || it.kind === "bday") ? `<p class="hint">${it.kind === "session" ? "Sessions are set by running one in RealmScreen." : "Birthdays are set in Character Profiles."}</p>` : ""}
        </article>`
      }
      if (gm && !(this.form && this.form.k === k) && !isFest(cal, k))
        h += `<button type="button" class="pb-cal-addday" data-action="add" data-k="${k}"><i class="fa-solid fa-plus"></i> Add on this day</button>`
      if (!gm) h += `<p class="hint pb-cal-only">View only. Your GM keeps this calendar.</p>`
      return h
    }

    #formHtml(cal) {
      const f = this.form
      const kinds = f.editing ? (f.kind === "holiday" ? ["holiday"] : ["event", "note"]) : ["event", "note", "holiday"]
      const opts = whoOptions(cal).map(([v, l]) => `<option value="${esc(v)}"${f.who === v ? " selected" : ""}>${esc(l)}</option>`).join("")
      return `<div class="pb-cal-form">
        <div class="pb-cal-kinds">${kinds.map(k => `<button type="button" class="${f.kind === k ? "active" : ""}" data-action="kind" data-kind="${k}">${KIND[k]}</button>`).join("")}</div>
        <div class="form-group stacked"><label>Name</label><input type="text" name="cName" value="${esc(f.name)}" placeholder="What happens?" autocomplete="off"></div>
        <div class="form-group stacked"><label>Note</label><textarea name="cNote" rows="2" placeholder="Optional">${esc(f.note)}</textarea></div>
        <div class="form-group stacked"><label>Who sees it</label><select name="cWho">${opts}</select></div>
        ${f.kind === "holiday" ? `<p class="hint">Holidays come back every year and everyone it’s for can see them ahead of time.</p>`
          : `<label class="pb-cal-check"><input type="checkbox" name="cEarly"${f.early ? " checked" : ""}${f.who === "gm" ? " disabled" : ""}> Players can see it before the day comes</label>`}
        <div class="pb-cal-row"><button type="button" data-action="cancel">Cancel</button><button type="button" data-action="save" class="bright"><i class="fa-solid fa-check"></i> ${f.editing ? "Save changes" : "Save"}</button></div>
      </div>`
    }

    _replaceHTML(result, content) {
      const day = content.querySelector(".pb-cal-day")
      const scroll = day ? day.scrollTop : 0
      const focusName = document.activeElement?.name
      content.replaceChildren(result)
      const nd = content.querySelector(".pb-cal-day")
      if (nd) nd.scrollTop = scroll
      if (this.form?.focus) { content.querySelector("[name=cName]")?.focus(); this.form.focus = false }
      else if (focusName) content.querySelector(`[name=${focusName}]`)?.focus()
    }

    _onRender() {
      applyTheme(this.element)
      const root = this.element
      if (root.dataset.pbWired) return
      root.dataset.pbWired = "1"
      root.addEventListener("dblclick", (ev) => {
        const c = ev.target.closest?.(".pb-cal-cell[data-k]")
        if (c && isGM() && !c.classList.contains("fest")) this.openForm(Number(c.dataset.k))
      })
      root.addEventListener("keydown", (ev) => {
        const c = ev.target.closest?.(".pb-cal-cell[data-k]")
        if (c && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); this.sel = Number(c.dataset.k); this.render() }
        if (ev.key === "Enter" && ev.target.name === "cName") { ev.preventDefault(); CalendarWindow.#save.call(this) }
      })
      root.addEventListener("change", (ev) => { if (ev.target.name === "cWho") { this.#keep(); this.render() } })
      // Drag an entry to another day (GM).
      let drag = null
      root.addEventListener("dragstart", (ev) => {
        const c = ev.target.closest?.(".pb-cal-chip[draggable]")
        if (!c) return
        drag = c.dataset.id
        ev.dataTransfer.effectAllowed = "move"
        ev.dataTransfer.setData("text/plain", drag)
      })
      root.addEventListener("dragover", (ev) => {
        const c = ev.target.closest?.(".pb-cal-cell[data-k]")
        if (!c || !drag || c.classList.contains("fest")) return
        ev.preventDefault()
        for (const x of root.querySelectorAll(".pb-cal-cell.drop")) if (x !== c) x.classList.remove("drop")
        c.classList.add("drop")
      })
      root.addEventListener("dragleave", (ev) => { const c = ev.target.closest?.(".pb-cal-cell"); if (c && !c.contains(ev.relatedTarget)) c.classList.remove("drop") })
      root.addEventListener("dragend", () => { drag = null; for (const x of root.querySelectorAll(".pb-cal-cell.drop")) x.classList.remove("drop") })
      root.addEventListener("drop", (ev) => {
        const c = ev.target.closest?.(".pb-cal-cell[data-k]")
        if (!c || !drag) return
        ev.preventDefault()
        const it = entries(this.#cal()).find(i => i.id === drag)
        drag = null
        const k = Number(c.dataset.k)
        if (!it?.edit || it.k === k) return this.render()
        this.sel = k
        send({ op: "update", list: it.edit.type, id: it.edit.id, k, from: it.k })
      })
    }

    openForm(k, it = null) {
      this.sel = k
      this.form = it
        ? { k, editing: true, list: it.edit.type, id: it.edit.id, kind: it.kind, name: it.name, note: it.note || "", who: it.who || "all", early: !!it.early, focus: true }
        : { k, editing: false, kind: "event", name: "", note: "", who: this.lastWho || "all", early: false, focus: true }
      this.render()
    }

    static #prev() { const cal = this.#cal(); if (!cal) return; this.mi = Math.max(0, this.mi - 1); this.sel = cal.months[this.mi].k0; this.form = null; this.render() }
    static #next() { const cal = this.#cal(); if (!cal) return; this.mi = Math.min(cal.months.length - 1, this.mi + 1); this.sel = cal.months[this.mi].k0; this.form = null; this.render() }
    static #today() { const cal = this.#cal(); const t = this.#todayK(cal); if (t != null) this.showDay(t); this.form = null; this.render() }
    static #pick(ev, t) {
      const k = Number(t.dataset.k)
      if (this.sel === k) return
      this.sel = k
      if (this.form && this.form.k !== k) this.form = null
      this.render()
    }
    static #add(ev, t) { ev.stopPropagation(); this.openForm(Number(t.dataset.k)) }
    static #edit(ev, t) { const it = entries(this.#cal()).find(i => i.id === t.dataset.id); if (it?.edit) this.openForm(it.k, it) }
    static async #remove(ev, t) {
      const it = entries(this.#cal()).find(i => i.id === t.dataset.id)
      if (!it?.edit) return
      const D = foundry.applications.api.DialogV2
      const every = it.kind === "holiday" && it.rec ? " It comes off every year." : ""
      const ok = await D.confirm({ window: { title: "Remove from the calendar" }, content: `<p>Remove <strong>${esc(it.name)}</strong> from the calendar in RealmScreen?${every}</p>`, rejectClose: false })
      if (!ok) return
      if (this.form?.id === it.edit.id) this.form = null
      send({ op: "remove", list: it.edit.type, id: it.edit.id })
    }
    static #kind(ev, t) { this.#keep(); this.form.kind = t.dataset.kind; this.render() }
    static #cancel() { this.form = null; this.render() }
    static #save() {
      this.#keep()
      const f = this.form
      if (!f) return
      if (!str(f.name)) return ui.notifications?.warn("Give it a name first.")
      const early = f.kind !== "holiday" && f.who !== "gm" && !!f.early
      this.lastWho = f.who
      if (f.editing) send({ op: "update", list: f.list, id: f.id, kind: f.kind, name: f.name, note: f.note, who: f.who, early })
      else send({ op: "add", kind: f.kind, name: f.name, note: f.note, k: f.k, who: f.who, early })
      this.form = null
      this.render()
    }
  }
  return WinClass
}

/** Open the Calendar window (at a day, if given). */
export function openCalendar(k = null) {
  const C = winClass()
  if (!C) return ui.notifications?.warn("The calendar needs Foundry V12 or later.")
  const open = foundry.applications.instances?.get?.(APP_ID) || new C()
  if (Number.isFinite(k)) open.showDay(k)
  open.render({ force: true })
  if (open.rendered) open.bringToFront?.()
}

// ── the sidebar tab ───────────────────────────────────────────
function tabHtml() {
  const cal = myCalendar()
  if (!cal || !arr(cal.months).length) return `<p class="hint">${isGM() ? "RealmScreen hasn’t sent the calendar yet. It does while it’s connected." : "The calendar isn’t ready yet."}</p>`
  const t = Number.isFinite(cal.world) ? cal.world : null
  const items = entries(cal)
  const mineC = arr(cal.camps)
  const head = isGM() ? "World date" : (mineC.find(c => c.id === cal.live) || mineC.find(c => c.k === t) || mineC[0])?.name || "Today"
  const li = (it) => `<li><a data-action="jump" data-k="${it.k}"><span class="pb-caltab-when">${esc(shortDay(cal, it.k))}</span><span class="pb-caltab-what" style="--k:${esc(it.color || KCOL[it.kind] || KCOL.event)}">${esc(it.name)}</span></a></li>`
  const up = t == null ? [] : items.filter(i => i.k > t).slice(0, 6)
  const late = t == null ? [] : items.filter(i => i.k <= t).slice(-6).reverse()
  return `
    <section class="pb-caltab-now">
      <h4>${esc(head)}</h4>
      ${t != null ? `<a class="pb-caltab-date" data-action="jump" data-k="${t}">${esc(dayLabel(cal, t))}</a><span class="hint">${esc(weekdayName(cal, t))}</span>` : ""}
      ${isGM() && mineC.length ? `<ul class="pb-caltab-camps">${mineC.map(c => `<li><span>${esc(c.name)}</span><span>${esc(shortDay(cal, c.k))}</span></li>`).join("")}</ul>` : ""}
    </section>
    <button type="button" data-action="open"><i class="fa-solid fa-calendar-days"></i> Open the calendar</button>
    <h4 class="pb-caltab-h">Coming up</h4>
    ${up.length ? `<ul class="pb-caltab-list">${up.map(li).join("")}</ul>` : `<p class="hint">Nothing announced yet.</p>`}
    <h4 class="pb-caltab-h">Lately</h4>
    ${late.length ? `<ul class="pb-caltab-list">${late.map(li).join("")}</ul>` : `<p class="hint">Nothing yet.</p>`}`
}
// "18 Bloo" — with the year when it isn't this year ("4 Bloo · StarFall", the year's own name).
function shortDay(cal, k) {
  const m = arr(cal.months)[monthAt(cal, k)]
  if (!m) return ""
  const d = daysOf(m)[k - m.k0]
  const t = Number.isFinite(cal.world) ? arr(cal.months)[monthAt(cal, cal.world)] : null
  const yr = t && t.year !== m.year ? ` · ${yearLabel(m).split(" · ").pop()}` : ""
  return (m.festival ? m.name : d.fest ? d.fest : `${d.n} ${m.name.slice(0, 4)}`) + yr
}

let TabClass = null
function makeTab() {
  const Abs = foundry?.applications?.sidebar?.AbstractSidebarTab
  if (!Abs) return null
  TabClass = class RealmCalendarTab extends Abs {
    static tabName = TAB
    static DEFAULT_OPTIONS = {
      classes: ["pb-caltab", "flexcol"],
      window: { title: "Calendar", icon: "fa-solid fa-calendar-days" },
      actions: { open: () => openCalendar(), jump: (ev, t) => openCalendar(Number(t.dataset.k)) },
    }
    async _renderHTML() { const el = document.createElement("div"); el.className = "pb-caltab-body"; el.innerHTML = tabHtml(); return el }
    _replaceHTML(result, content) { content.replaceChildren(result) }
  }
  return TabClass
}

// ── redraw / hooks ────────────────────────────────────────────
let drawT = 0
function redraw() {
  clearTimeout(drawT)
  drawT = setTimeout(() => {
    const w = foundry?.applications?.instances?.get?.(APP_ID)
    if (w?.rendered) w.render()
    const t = ui?.[TAB]
    if (t?.rendered) t.render()
    if (t?.popout?.rendered) t.popout.render()
  }, 30)
}

Hooks.once("init", () => {
  const S = foundry?.applications?.sidebar?.Sidebar
  const C = makeTab()
  if (!S || !C || !S.TABS || S.TABS[TAB]) return
  // Our tab sits after the Journal, as Foundry's own tabs do (right-click pops it out).
  const next = {}
  for (const [k, v] of Object.entries(S.TABS)) { next[k] = v; if (k === "journal") next[TAB] = { tooltip: "Calendar", icon: "fa-solid fa-calendar-days" } }
  if (!next[TAB]) next[TAB] = { tooltip: "Calendar", icon: "fa-solid fa-calendar-days" }
  S.TABS = next
  CONFIG.ui[TAB] = C
})
Hooks.once("ready", () => {
  try { game.socket?.on(CHANNEL, (m) => { if (m && m.t === "calendar.ack") calendarAck(m, { relay: false }) }) } catch { /* no socket */ }
})
// A new calendar from RealmScreen holds the changes it confirmed: stop laying them over it.
onSlice(() => { for (const [id, o] of mine) if (o.state === "done") mine.delete(id); redraw() })
Hooks.on("pendantBridgeLive", () => redraw())
Hooks.on("pendantBridgeOpenCalendar", (k) => openCalendar(Number.isFinite(k) ? k : null))
const opMsg = (m) => { if (flagsOf(m).op?.type === "calendar.edit") redraw() }
Hooks.on("createChatMessage", opMsg)
Hooks.on("deleteChatMessage", opMsg)
Hooks.on("clientSettingChanged", (key) => {
  if (key !== "core.uiConfig") return
  const w = foundry?.applications?.instances?.get?.(APP_ID)
  if (!w?.element) return
  w.element.classList.remove("theme-dark", "theme-light")
  applyTheme(w.element)
})

// For a render harness outside Foundry (no effect in Foundry).
export const _test = { tabHtml, winClass, makeTab, entries, pendingOps, mine }
