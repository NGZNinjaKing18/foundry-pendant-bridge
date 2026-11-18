// ──────────────────────────────────────────────────────────────
// Session Over › Travel — the bigger window for fixing where the party went this session
// (pendant-home _handoffs/session-over-plan.md § Contract, "one truth", 2026-11-18).
//
// Opened from the Session Over window's map box (GM). The route is the party's REAL People plans in
// RealmScreen (no overlay): every change here goes into those plans for the whole party — so RealmScreen's
// map, People, Foundry's party tokens and the calendar all agree. RealmScreen decides (pendant-home
// lib/sessionTravel.mjs): a trip or stay made longer / shorter is taken up by the next stay (later dates
// stay put); a trip added from a stay is priced like the trip card (roads, pace, hours a day) unless days
// are typed; a trip taken off = they stayed where they were. Undo puts the last change back.
// Done closes this and brings the Session Over window back, refreshed.
//
//   bridge → `sessionover.get { sessionId, travel: true }`   → { view, travel: { towns, paces, hpd, leadName, … } }
//   bridge → `sessionover.update { sessionId, change }`       change = session-over-model.js legOp / addOp, or
//                                                              { op: 'travel.undo' } → { view, note }
// The offer (`travel`) and "who moved" (`note`) only reach the GM window holding the RealmScreen link (never a
// socket message), so this window works there.
//
// Native: an ApplicationV2 with Foundry's own buttons, inputs and colour variables (styles: `.pb-so-travel`).
// ──────────────────────────────────────────────────────────────

import { askSessionOver, mapHtml, playMap } from "./session-over.js"
import { esc, fmt, plural, mapOf, legOp, addOp } from "./session-over-model.js"

const APP_ID = "pb-so-travel"
const MAP_W = 720
const arr = (v) => (Array.isArray(v) ? v : [])
const isGM = () => !!game.user?.isGM
const reduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches } catch { return false } }

let WinClass = null
function winClass() {
  const AppV2 = foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  if (WinClass) return WinClass
  WinClass = class SessionTravelWindow extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: APP_ID,
      classes: ["pb-session-over", "pb-so-travel"],
      window: { icon: "fa-solid fa-route", resizable: true, title: "Travel" },
      position: { width: 1040, height: 640 },
      actions: {
        step: SessionTravelWindow.#step, remove: SessionTravelWindow.#remove, addOpen: SessionTravelWindow.#addOpen,
        addSend: SessionTravelWindow.#addSend, addCancel: SessionTravelWindow.#addCancel, undo: SessionTravelWindow.#undo, done: SessionTravelWindow.#done,
      },
    }
    view = null           // the GM view (its route = the party's trail this session)
    travel = null         // RealmScreen's offer: { towns, paces, hpd, leadName, priced } | { error }
    back = null           // Done → the Session Over window
    busy = false
    note = ""             // who the last change moved
    canUndo = false
    addFor = null         // the stay (leg id) whose "trip from here" form is open
    draft = { to: "", by: "foot", hpd: 8, after: 0, days: "" }
    get title() {
      const v = this.view
      if (!v) return "Travel"
      return `Travel — ${v.campaignName || "Session"}${Number.isFinite(v.number) ? ` · Session ${v.number}` : ""}`
    }
    get legs() { return arr(this.view?.route?.legs) }
    async _renderHTML() {
      const el = document.createElement("div")
      const v = this.view, t = this.travel
      el.className = `pb-sot${this.busy ? " busy" : ""}`
      if (!v) { el.innerHTML = `<p class="hint"><i class="fa-solid fa-spinner fa-spin" inert></i> Asking RealmScreen…</p>`; return el }
      const map = mapOf(v.route?.map)
      const can = !!(t && !t.error)
      const first = this.legs[0]
      const sub = [t?.leadName ? `${t.leadName} and the party` : "The party", first?.when ? `from ${first.when}` : ""].filter(Boolean).join(" · ")
      el.innerHTML = `
        <section class="pb-sot-map"><div class="pb-so-mapbox">${map ? mapHtml(map, v, { W: MAP_W }) : `<p class="pb-so-noroute">No placed stops to draw.</p>`}
          <span class="pb-so-mcap">${esc(plural(v.route?.days || 0, "day"))} · ${esc(plural(v.route?.travelled || 0, "day"))} travelling</span>
          ${map && !reduced() ? `<button type="button" class="pb-so-replay" data-tooltip="Play it again"><i class="fa-solid fa-play" inert></i> Replay</button>` : ""}</div></section>
        <section class="pb-sot-side">
          <p class="pb-so-faint pb-sot-sub">${esc(sub)}</p>
          ${t?.error ? `<p class="pb-sot-warn">${esc(t.error)}</p>` : !t ? `<p class="pb-so-faint">Travel can be changed from the GM window linked to RealmScreen.</p>` : ""}
          <ol class="pb-sot-legs">${this.legs.map(l => this.rowHtml(l, can)).join("") || `<li class="pb-so-faint">No travel or stays this session.</li>`}</ol>
          ${arr(v.route?.otherMaps).map(m => `<p class="pb-so-faint">Also on ${esc(m.name)} (${esc(plural(m.stops, "stop"))}) — change those on RealmScreen's map.</p>`).join("")}
        </section>
        <footer class="pb-sot-foot">
          <span class="pb-sot-note">${esc(this.note)}</span>
          ${this.canUndo ? `<button type="button" data-action="undo"><i class="fa-solid fa-rotate-left" inert></i> Undo</button>` : ""}
          <button type="button" data-action="done" class="pb-sot-done"><i class="fa-solid fa-check" inert></i> Done</button>
        </footer>`
      return el
    }
    rowHtml(l, can) {
      const id = esc(l.id)
      const where = l.kind === "stay" ? esc(l.place || "somewhere") : `${esc(l.from || "…")} <i class="fa-solid fa-arrow-right" inert></i> ${esc(l.to || "…")}`
      const kindIcon = l.kind === "stay" ? "fa-campground" : "fa-route"
      let ctl
      if (l.jump) ctl = `<span class="pb-so-faint" data-tooltip="Moved with no trip on record — take it off by adding the trip from the stay before">no trip</span>`
      else if (!can || l.t0 == null) ctl = `<span class="pb-sot-days">${esc(plural(l.days, "day"))}</span>`
      else {
        const min = l.kind === "travel" ? 0.5 : 0
        ctl = `<span class="pb-sot-step"><button type="button" data-action="step" data-id="${id}" data-d="-0.5" aria-label="Half a day less" ${Number(l.days) - 0.5 < min ? "disabled" : ""}><i class="fa-solid fa-minus" inert></i></button>`
          + `<input type="number" min="${min}" step="0.5" value="${esc(fmt(l.days))}" data-days="${id}" aria-label="Days">`
          + `<button type="button" data-action="step" data-id="${id}" data-d="0.5" aria-label="Half a day more"><i class="fa-solid fa-plus" inert></i></button><span class="pb-so-faint">days</span></span>`
          + (l.kind === "travel"
            ? `<button type="button" class="pb-sot-x" data-action="remove" data-id="${id}" data-tooltip="They never made this trip — they stayed where they were"><i class="fa-solid fa-xmark" inert></i></button>`
            : `<button type="button" class="pb-sot-x" data-action="addOpen" data-id="${id}" data-tooltip="A trip from here"><i class="fa-solid fa-person-walking-arrow-right" inert></i></button>`)
      }
      return `<li class="pb-sot-leg ${l.kind}${l.jump ? " jump" : ""}"><span class="pb-sot-what"><span class="pb-sot-where"><i class="fa-solid ${kindIcon}" inert></i> ${where}</span>`
        + `<span class="pb-sot-when">${esc(l.when || "")}</span></span>${ctl}</li>`
        + (this.addFor === l.id && can ? this.addHtml(l) : "")
    }
    addHtml(l) {
      const t = this.travel || {}, d = this.draft
      const towns = arr(t.towns)
      return `<li class="pb-sot-add"><div class="form-group"><label>To</label><select data-draft="to"><option value="">—</option>`
        + towns.map(x => `<option value="${esc(x.itemKind + ":" + x.itemId)}" ${d.to === x.itemKind + ":" + x.itemId ? "selected" : ""}>${esc(x.name)}</option>`).join("") + `</select></div>`
        + `<div class="form-group"><label>By</label><select data-draft="by">${arr(t.paces).map(p => `<option value="${esc(p.key)}" ${d.by === p.key ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></div>`
        + `<div class="form-group"><label>Hours a day</label><select data-draft="hpd">${arr(t.hpd).map(h => `<option value="${h}" ${Number(d.hpd) === h ? "selected" : ""}>${h} h</option>`).join("")}</select></div>`
        + `<div class="form-group"><label>Leaves after</label><input type="number" min="0" max="${esc(fmt(l.days))}" step="0.5" value="${esc(fmt(d.after))}" data-draft="after"><span class="pb-so-faint">days</span></div>`
        + `<div class="form-group"><label>Days on the road</label><input type="number" min="0" step="0.5" value="${esc(d.days)}" placeholder="${t.priced ? "priced" : "needed"}" data-draft="days"></div>`
        + `<div class="pb-sot-addbtns"><button type="button" data-action="addCancel">Cancel</button><button type="button" data-action="addSend" data-id="${esc(l.id)}" ${d.to ? "" : "disabled"}><i class="fa-solid fa-check" inert></i> Plan this trip</button></div></li>`
    }
    _replaceHTML(result, content) {
      const keep = content.querySelector(".pb-sot-legs")?.scrollTop || 0
      content.replaceChildren(result)
      const l = content.querySelector(".pb-sot-legs"); if (l) l.scrollTop = keep
    }
    _onRender() {
      const map = mapOf(this.view?.route?.map)
      const mk = map ? map.src + JSON.stringify(map.stops) : ""
      if (map) playMap(this.element, map, { W: MAP_W, autoplay: mk !== this._mapKey })   // (Replay is wired on every render)
      this._mapKey = mk
      if (this._wired) return
      this._wired = true
      // a typed number commits on change (leaving the field / Enter), like Foundry's own sheets
      this.element.addEventListener("change", (ev) => {
        const t = ev.target
        if (t?.dataset?.days) { const leg = this.legs.find(x => x.id === t.dataset.days); const c = legOp("days", leg, Number(t.value)); if (c) this.send(c); else this.render() }
        else if (t?.dataset?.draft) { const k = t.dataset.draft; this.draft = { ...this.draft, [k]: k === "to" || k === "by" ? t.value : t.value === "" ? "" : Number(t.value) }; if (k === "to") this.render() }
      })
      this.element.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.matches?.("input[type=number]")) ev.target.blur() })
    }
    async send(change, { undo = false } = {}) {
      if (!change || !this.view || this.busy) return
      this.busy = true
      this.element?.querySelector(".pb-sot")?.classList.add("busy")
      try {
        const r = await askSessionOver("update", { sessionId: this.view.sessionId, change })
        if (r.view) this.view = r.view
        this.note = r.note || (undo ? "Put back." : "Saved.")
        this.canUndo = !undo
        this.addFor = null
      } catch (e) {
        ui.notifications?.warn(`Not changed: ${e.message || e}`)
      }
      this.busy = false
      this.render({ window: { title: this.title } })
    }
    static #step(_e, b) {
      const leg = this.legs.find(x => x.id === b.dataset.id)
      if (leg) this.send(legOp("days", leg, Math.max(0, Number(leg.days) + Number(b.dataset.d || 0))))
    }
    static #remove(_e, b) { const leg = this.legs.find(x => x.id === b.dataset.id); if (leg) this.send(legOp("remove", leg)) }
    static #addOpen(_e, b) { this.addFor = this.addFor === b.dataset.id ? null : b.dataset.id; this.draft = { to: "", by: arr(this.travel?.paces)[0]?.key || "foot", hpd: 8, after: 0, days: "" }; this.render() }
    static #addCancel() { this.addFor = null; this.render() }
    static #addSend(_e, b) {
      const leg = this.legs.find(x => x.id === b.dataset.id)
      const town = arr(this.travel?.towns).find(x => `${x.itemKind}:${x.itemId}` === this.draft.to)
      const c = addOp(leg, { to: town, by: this.draft.by, hpd: this.draft.hpd, after: this.draft.after, days: this.draft.days === "" ? null : this.draft.days })
      if (c) this.send(c); else ui.notifications?.warn("Pick where they went.")
    }
    static #undo() { this.send({ op: "travel.undo" }, { undo: true }) }
    static #done() {
      const view = this.view, back = this.back
      this.close()
      try { back?.(view) } catch { /* the Session Over window is gone */ }
    }
  }
  return WinClass
}

/** Open the Travel window on a Session Over GM view; `back(view)` runs on Done (the refreshed view). */
export async function openTravel(view, { back = null } = {}) {
  if (!isGM() || !view?.sessionId) return null
  const C = winClass()
  if (!C) return null
  let app = foundry?.applications?.instances?.get?.(APP_ID) || null
  if (!app) app = new C()
  app.view = view
  app.back = back
  app.travel = null
  app.note = ""
  app.canUndo = false
  app.addFor = null
  await app.render({ force: true, window: { title: app.title } })
  app.bringToFront?.()
  try {
    const r = await askSessionOver("get", { sessionId: view.sessionId, travel: true })
    if (r.view) app.view = r.view
    app.travel = r.travel || null
  } catch (e) { app.travel = { error: e.message || String(e) } }
  app.render({ window: { title: app.title } })
  return app
}
