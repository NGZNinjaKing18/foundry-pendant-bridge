// ──────────────────────────────────────────────────────────────
// Plan a trip — moving RealmScreen's people from Foundry (pendant-home
// _handoffs/foundry-people-remake-plan.md, 2026-10-30).
//
// RealmScreen holds where everyone is at the date and hour Foundry shows (scripts/party.js places them;
// every date/hour change moves them). The GM's "Plan a trip" switch (RealmScreen controls) decides what a
// drag does:
//
//   • OFF (default): tokens move freely, as Foundry allows. The GM's Resync button — or the next date or hour
//     change — puts everyone back where RealmScreen has them.
//   • ON: whoever drops one of these tokens gets a trip card: roads, 8 hours a day to start, every choice
//     RealmScreen's own card has (9–12 hours say "ask your DM" — a warning, not a lock). RealmScreen prices
//     each choice (Foundry never works a trip out); "Plan this trip" writes it into RealmScreen. Mid-route,
//     the trip under way is cut where they are at this hour and the new one starts there. Cancel puts the
//     token back.
//
// Only the GM window holding the RealmScreen link talks to it (live.js). A player's card goes over the module
// socket to that window and its answer comes back the same way:
//   socket  { t: "trip.ask", op: quote|commit, qid, payload }  → the linked window → RealmScreen `trip.<op>`
//   RealmScreen `trip.answer` { qid, userId, … } → the linked window → socket { t: "trip.ans", to, qid, body }
//
// Native: an ApplicationV2 window built from Foundry's own form markup and CSS variables (styles: `.pb-trip`).
// ──────────────────────────────────────────────────────────────

import { realmLive, linkedHere } from "./live.js"

const MOD = "pendant-bridge"
const CHANNEL = `module.${MOD}`
const SYNC = "pendantPartySync"              // (party.js tags its own moves with this)
const ASK_MS = 20000

let sender = null
/** main.js hands over its send (only the linked window's reaches RealmScreen). */
export function setTripSender(fn) { sender = typeof fn === "function" ? fn : null }

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const partyFlag = (doc) => doc?.getFlag?.(MOD, "party") || null

// ── the GM's switch ───────────────────────────────────────────
export const planTripsOn = () => { try { return game.settings.get(MOD, "planTrips") === true } catch { return false } }
export async function setPlanTrips(on) { if (game.user?.isGM) await game.settings.set(MOD, "planTrips", !!on) }

Hooks.once("init", () => {
  game.settings.register(MOD, "planTrips", {
    scope: "world", config: false, type: Boolean, default: false,
    onChange: () => { try { ui.controls?.render?.() } catch { /* */ } },
  })
})

// ── talking to RealmScreen (directly, or through the linked GM window) ──
const pending = new Map()                    // qid → { resolve, reject, timer }
const newQid = () => `${game.user?.id || "u"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const emit = (msg) => { try { game.socket?.emit(CHANNEL, msg) } catch { /* socket not ready */ } }

function ask(op, payload) {
  return new Promise((resolve, reject) => {
    if (!realmLive()) { reject(new Error("RealmScreen isn’t connected — ask your GM to open it.")); return }
    const qid = newQid()
    const timer = setTimeout(() => { pending.delete(qid); reject(new Error("RealmScreen didn’t answer. Is your GM’s RealmScreen open?")) }, ASK_MS)
    pending.set(qid, { resolve, reject, timer })
    const msg = { qid, userId: game.user?.id || null, ...payload }
    if (linkedHere() && sender) sender({ type: `trip.${op}`, ...msg })
    else emit({ t: "trip.ask", op, qid, user: game.user?.id || null, payload: msg })
  })
}
function settle(qid, body) {
  const p = pending.get(qid)
  if (!p) return
  pending.delete(qid)
  clearTimeout(p.timer)
  if (body && body.error) p.reject(new Error(body.error)); else p.resolve(body || {})
}

/** main.js: RealmScreen's `trip.answer` (only ever reaches the linked window) → whoever asked. */
export function tripAnswer(msg) {
  const { qid, userId, type: _t, reqId: _r, ...body } = msg || {}
  if (!qid) return { ok: false }
  if (!userId || userId === game.user?.id) settle(qid, body)
  else emit({ t: "trip.ans", to: userId, qid, body })
  return { ok: true }
}

/** Put every token back where RealmScreen has them (the GM's Resync; a cancelled card). */
export function resync() {
  if (linkedHere() && sender) sender({ type: "party.resync" })
  else emit({ t: "trip.resync" })
}

Hooks.once("ready", () => {
  try {
    game.socket?.on(CHANNEL, (m) => {
      if (!m || typeof m.t !== "string" || !m.t.startsWith("trip.")) return
      if (m.t === "trip.ask" && linkedHere() && sender && m.op && m.payload) sender({ type: `trip.${m.op}`, ...m.payload, qid: m.qid, userId: m.user || m.payload.userId || null })
      else if (m.t === "trip.resync" && linkedHere() && sender) sender({ type: "party.resync" })
      else if (m.t === "trip.ans" && m.to === game.user?.id) settle(m.qid, m.body)
    })
  } catch { /* no socket */ }
})

// ── a drop ────────────────────────────────────────────────────
function dims(scene) {
  const d = scene.dimensions
  return { x: d.sceneX, y: d.sceneY, w: d.sceneWidth, h: d.sceneHeight, size: d.size || scene.grid?.size || 100 }
}
function mapFraction(scene, t) {
  const d = dims(scene)
  return { nx: (t.x + ((t.width || 1) * d.size) / 2 - d.x) / d.w, ny: (t.y + ((t.height || 1) * d.size) / 2 - d.y) / d.h }
}

Hooks.on("updateToken", (doc, changes, options, userId) => {
  if (options?.[SYNC] || !changes || (!("x" in changes) && !("y" in changes))) return
  if (userId !== game.user?.id || !planTripsOn() || !realmLive()) return     // the mover's own window only
  const f = partyFlag(doc)
  const scene = doc.parent
  if (!f || !scene) return
  const { nx, ny } = mapFraction(scene, { x: changes.x ?? doc.x, y: changes.y ?? doc.y, width: doc.width, height: doc.height })
  openTripCard({ sceneId: scene.id, key: f.key, nx, ny, name: doc.name })
})

// ── the trip card ─────────────────────────────────────────────
const HOURS = [8, 9, 10, 12]
let CardClass = null
const open = new Map()                       // token key → card (one per token)

function cardClass() {
  const AppV2 = globalThis.foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  if (CardClass) return CardClass
  CardClass = class TripCard extends AppV2 {
    static DEFAULT_OPTIONS = {
      classes: ["pb-trip"],
      window: { title: "Plan a trip", icon: "fa-solid fa-route" },
      position: { width: 420, height: "auto" },
      actions: { cancel: TripCard.onCancel, commit: TripCard.onCommit },
    }
    constructor(drop, options = {}) {
      super({ ...options, id: `pb-trip-${String(drop.key).replace(/[^\w-]/g, "_").slice(0, 60)}` })
      this.drop = drop
      this.opts = { by: "foot", hpd: 8, route: "roads", hour: null, mode: "insert" }
      this.quote = null
      this.error = null
      this.busy = true
      this.done = false
      this.tip = ""
      this.requote()
    }
    get title() { return `Plan a trip — ${this.quote?.who?.join(" & ") || this.drop.name || "Party"}` }

    async requote() {
      const n = (this.n = (this.n || 0) + 1)
      this.busy = true
      if (this.rendered) this.render()
      try {
        const r = await ask("quote", { sceneId: this.drop.sceneId, key: this.drop.key, nx: this.drop.nx, ny: this.drop.ny, opts: this.opts })
        if (n !== this.n) return
        this.quote = r.quote || null
        this.error = null
        // RealmScreen picks the way when it isn't chosen yet: the quicker one.
        if (!this.picked && this.quote && this.quote.other && !this.quote.other.warn && this.quote.other.elapsed != null && this.quote.elapsed != null
          && this.quote.other.elapsed < this.quote.elapsed - 1e-6 && this.quote.other.route !== this.opts.route) {
          this.picked = true
          this.opts.route = this.quote.other.route
          return this.requote()
        }
      } catch (e) { if (n === this.n) { this.error = e.message || String(e); this.quote = null } }
      if (n !== this.n) return
      this.busy = false
      this.render({ force: true })
    }

    async _renderHTML() {
      const el = document.createElement("div")
      const q = this.quote, o = this.opts
      if (this.error && !q) {
        el.innerHTML = `<p class="pb-trip-bad">${esc(this.error)}</p>
          <footer class="form-footer"><button type="button" data-action="cancel"><i class="fa-solid fa-rotate-left"></i> Put them back</button></footer>`
        return el
      }
      if (!q) { el.innerHTML = `<p class="hint"><i class="fa-solid fa-spinner fa-spin"></i> Asking RealmScreen…</p>`; return el }
      const other = q.other || {}
      const label = (route) => (route === "roads" ? "Roads" : "Straight")
      const wayTime = (route) => (route === o.route ? (q.warn ? "no way" : q.days) : (other.warn ? (other.warn === "noRoute" ? "no way" : "—") : other.days))
      const noRoad = (route) => route === "roads" && (route === o.route ? (!q.warn && !q.viaRoads) : (!other.warn && !other.viaRoads))
      const radio = (name, value, cur, text, extra = "") => `<label class="pb-trip-opt${String(value) === String(cur) ? " active" : ""}"><input type="radio" name="${name}" value="${esc(value)}" ${String(value) === String(cur) ? "checked" : ""} ${extra}> ${text}</label>`
      const saves = (h) => (q.saves && q.saves[h]) || 0
      const legs = Array.isArray(q.legs) ? q.legs : []
      const moving = legs.reduce((s, l) => s + (l.hours || 0), 0) || 1
      let acc = 0
      const strip = legs.map(l => {
        const a = acc / moving, w = (l.hours || 0) / moving
        acc += l.hours || 0
        const cls = l.kind === "road" ? (/poor|ruined/.test(l.condition || "") ? "bad" : "road") : "open"
        const words = l.kind === "walk" ? `${mi(l.miles)} of open ground where the roads don’t meet` : l.kind === "open" ? `${mi(l.miles)} straight across country` : `${mi(l.miles)} along ${l.name || "an unnamed road"}${l.tierLabel ? ` (${l.tierLabel}${l.condition && l.condition !== "good" ? `, ${l.condition}` : ""})` : ""}${l.through && l.through.length ? `, through ${l.through.join(", ")}` : ""}`
        const dots = (l.through || []).map((t, i, all) => `<span class="pb-trip-town" style="left:${(a + w * ((i + 1) / (all.length + 1))) * 100}%" data-tooltip="${esc(t)} — they pass through"></span>`).join("")
        return `<span class="pb-trip-seg ${cls}" style="left:${a * 100}%;width:${Math.max(0.5, w * 100)}%" data-tooltip="${esc(words)}"></span>${dots}`
      }).join("") + (q.nights || []).map((nt, i) => `<i class="fa-solid fa-campground pb-trip-camp" style="left:${nt.frac * 100}%" data-tooltip="Night ${i + 1}: camps ${esc(nt.at)} until ${esc(nt.until)}"></i>`).join("")
      const walk = legs.filter(l => l.kind === "walk").reduce((s, l) => s + (l.miles || 0), 0)
      el.innerHTML = `
        <p class="pb-trip-head"><strong>${esc((q.who || []).join(" & "))}</strong> <i class="fa-solid fa-arrow-right"></i> <strong>${esc(q.toName || "open country")}</strong></p>
        ${this.error ? `<p class="pb-trip-bad">${esc(this.error)}</p>` : ""}
        <div class="form-group"><label>By</label><div class="form-fields"><select name="by">${(q.paces || []).map(p => `<option value="${esc(p.key)}" ${p.key === o.by ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></div></div>
        <div class="form-group"><label>Way</label><div class="form-fields pb-trip-radios">
          ${["roads", "straight"].map(r => radio("route", r, o.route, `${label(r)} · ${esc(noRoad(r) ? "no road" : wayTime(r))}`, noRoad(r) ? "disabled" : "")).join("")}</div></div>
        <div class="form-group"><label>Hours a day</label><div class="form-fields pb-trip-radios">
          ${HOURS.map(h => radio("hpd", h, o.hpd, `${h} h`)).join("")}</div>
          <p class="hint">${o.hpd > 8 ? `<i class="fa-solid fa-triangle-exclamation"></i> Over 8 hours: ask your DM. ${saves(o.hpd)} Constitution save${saves(o.hpd) === 1 ? "" : "s"} a day, or exhaustion.` : "A normal day’s travel — no saves."}</p></div>
        <div class="form-group"><label>Leaves</label><div class="form-fields"><select name="hour">${(q.leaves || []).map(l => `<option value="${l.id == null ? "" : l.id}" ${String(l.id ?? "") === String(o.hour ?? "") ? "selected" : ""}>${esc(l.label)}</option>`).join("")}</select></div></div>
        ${q.hasRest ? `<div class="form-group"><label>Afterwards</label><div class="form-fields pb-trip-radios">${radio("mode", "insert", o.mode, "Back to their plan")}${radio("mode", "replace", o.mode, "Stay there")}</div></div>` : ""}
        ${q.warn ? `<p class="pb-trip-bad">${esc(q.warnText || "That trip can’t be planned.")}</p>` : `
        <div class="pb-trip-strip">
          <span class="pb-trip-end">${esc(q.fromName || "Here")}<small>${esc(q.go)}</small></span>
          <div class="pb-trip-bar">${strip}</div>
          <span class="pb-trip-end to">${esc(q.toName || "open country")}<small>${esc(q.arrive)}</small></span>
        </div>
        <div class="pb-trip-facts">
          <div><strong>${esc(q.days)}</strong><span>door to door</span></div>
          <div><strong>${esc(mi(q.miles) || "—")}</strong><span>${walk > 0 ? `${esc(mi(walk))} over gaps between roads` : q.viaRoads ? "on roads" : "across country"}</span></div>
          <div><strong>${(q.nights || []).length}</strong><span>night${(q.nights || []).length === 1 ? "" : "s"} camped</span></div>
          <div><strong>${saves(o.hpd) || "No"}</strong><span>Con save${saves(o.hpd) === 1 ? "" : "s"} a day</span></div>
        </div>
        <p class="hint">Arrives <strong>${esc(q.arrive)}</strong>. ${(q.who || []).length > 1 ? `Everyone in this token goes.` : ""} Mid-trip, they stop where they are now and set off from there.</p>`}
        <footer class="form-footer">
          <button type="button" data-action="cancel"><i class="fa-solid fa-xmark"></i> Cancel</button>
          <button type="button" data-action="commit" ${this.busy || q.warn || !q.ok ? "disabled" : ""}><i class="fa-solid fa-route"></i> Plan this trip</button>
        </footer>`
      return el
    }
    _replaceHTML(result, content) { content.replaceChildren(result) }
    _onRender() {
      for (const input of this.element.querySelectorAll("select, input[type=radio]")) {
        input.addEventListener("change", () => {
          const v = input.value
          if (input.name === "hpd") this.opts.hpd = Number(v)
          else if (input.name === "hour") this.opts.hour = v === "" ? null : Number(v)
          else if (input.name === "route") { this.opts.route = v; this.picked = true }
          else this.opts[input.name] = v
          this.requote()
        })
      }
    }
    static onCancel() { this.close() }
    static async onCommit() {
      if (this.busy) return
      this.busy = true
      this.render()
      try {
        const r = await ask("commit", { sceneId: this.drop.sceneId, key: this.drop.key, nx: this.drop.nx, ny: this.drop.ny, opts: this.opts })
        this.done = true
        ui.notifications?.info(r.text || "Trip planned in RealmScreen.")
        this.close()
      } catch (e) { this.busy = false; this.error = e.message || String(e); this.render() }
    }
    async close(options) {
      open.delete(this.drop.key)
      if (!this.done) resync()                // not planned: the token goes back to where RealmScreen has them
      return super.close(options)
    }
  }
  return CardClass
}
const mi = (x) => (!Number.isFinite(x) ? "" : x < 1 ? `${Math.round(x * 10) / 10} mi` : `${Math.round(x)} mi`)

export function openTripCard(drop) {
  const Cls = cardClass()
  if (!Cls) { ui.notifications?.warn("Plan a trip needs Foundry V12 or newer."); resync(); return }
  const had = open.get(drop.key)
  if (had) { had.drop = drop; had.requote(); had.bringToFront?.(); return }
  const card = new Cls(drop)
  open.set(drop.key, card)
  card.render({ force: true })
}
