// ──────────────────────────────────────────────────────────────
// Campaign clock — RealmScreen's in-world date and time, shown in Foundry.
//
// RealmScreen sends `clock.set` whenever its clock moves (the running
// campaign's own date during a session, the world date otherwise). The GM
// client stores it in the world setting `pendant-bridge.clock` and moves
// Foundry's world time to match; every client draws it from that setting:
//
//   • a sky dial in the Players area (bottom left) — the upper half is the sky,
//     the sun and every moon (true relative size, real phase) travel round it.
//     Players see the dial INSTEAD of the player list; the GM sees it ABOVE the
//     list, with −1d −1h +1h +1d buttons (no session = they move the world date).
//     Only while RealmScreen is connected — otherwise the stock player list;
//   • a date bar at the top of chat — weekday over the date, moon phases.
//
// The buttons never change the date here: they send `clock.step` to
// RealmScreen, which moves its canon date and sends the new clock back.
// RealmScreen computes every angle and size; this file only draws.
//
// Native-first: render hooks add elements, Foundry's own CSS variables and
// button styles are used, nothing is replaced. No clock = stock Foundry.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"

let clock = null            // the clock being shown (null = none)
let sender = null           // (msg) => bool — the bridge's WebSocket send

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || "")) ? v : d)
const f1 = (v) => Math.round(v * 10) / 10

/** main.js hands over its send so the GM's buttons can reach RealmScreen. */
export function setClockSender(fn) { sender = typeof fn === "function" ? fn : null }
export const currentClock = () => clock

// ── drawing ───────────────────────────────────────────────────
// A moon disc lit to its phase (0 new … 0.5 full … 1), waxing from the right.
function moonPath(cx, cy, r, p) {
  const k = Math.cos(2 * Math.PI * p), w = Math.abs(k) * r
  const lit = p < 0.5 ? 1 : 0, s2 = k > 0 ? 1 - lit : lit
  return `M${f1(cx)},${f1(cy - r)}A${f1(r)},${f1(r)} 0 0 ${lit} ${f1(cx)},${f1(cy + r)}A${f1(w)},${f1(r)} 0 0 ${s2} ${f1(cx)},${f1(cy - r)}Z`
}
function moonSvg(cx, cy, r, m) {
  return `<g class="pb-moon"><title>${esc(m.name)}</title><circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" class="pb-moon-dark"/>` +
    `<path d="${moonPath(cx, cy, r, n(m.phase))}" fill="${hex(m.color, "#d8d4c8")}"/></g>`
}
const at = (R, a) => [60 + R * Math.sin(a), 60 - R * Math.cos(a)]
const MOON_MAX = 8, MOON_MIN = 1.2

function dialSvg(c) {
  const sky = ["day", "twilight", "night"].includes(c.sky) ? c.sky : "night"
  let s = `<svg class="pb-dial" viewBox="0 0 120 120" role="img" aria-label="${esc(c.time)} · ${esc(c.part)}">` +
    `<circle cx="60" cy="60" r="52" class="pb-ground"/>` +
    `<path d="M8,60A52,52 0 0 1 112,60Z" class="pb-sky pb-sky-${sky}"/>` +
    `<circle cx="60" cy="60" r="52" class="pb-ring"/>` +
    `<line x1="8" y1="60" x2="112" y2="60" class="pb-horizon"/>`
  for (const m of (c.moons || [])) {
    const [x, y] = at(40, n(m.angle))
    s += moonSvg(x, y, Math.max(MOON_MIN, MOON_MAX * Math.min(1, n(m.rel, 1))), m)
  }
  const [sx, sy] = at(40, n(c.sun?.angle))
  s += `<circle cx="${f1(sx)}" cy="${f1(sy)}" r="7" class="pb-sun"/>`
  s += `<text x="60" y="64.5" text-anchor="middle" class="pb-dial-time">${esc(c.time)}</text></svg>`
  return s
}

function phasesSvg(c) {
  const ms = c.moons || []
  if (!ms.length) return ""
  let x = 0, s = ""
  const parts = ms.map(m => { const r = Math.max(MOON_MIN, 9 * Math.min(1, n(m.rel, 1))); x += r; const cx = x; x += r + 4; return [cx, r, m] })
  for (const [cx, r, m] of parts) s += moonSvg(cx, 11, r, m)
  const w = f1(Math.max(1, x - 4))
  return `<svg class="pb-phases" viewBox="0 0 ${w} 22" width="${w}" height="22">${s}</svg>`
}

function clockHtml(c, gm) {
  const steps = gm
    ? `<div class="pb-clock-steps">` +
      [[-1, 0, "−1d", "Back a day"], [0, -1, "−1h", "Back an hour"], [0, 1, "+1h", "On an hour"], [1, 0, "+1d", "On a day"]]
        .map(([d, h, l, t]) => `<button type="button" data-days="${d}" data-hours="${h}" data-tooltip="${t}" aria-label="${t}">${l}</button>`).join("") +
      `</div>`
    : ""
  const head = gm ? `<div class="pb-clock-camp">${esc(c.session ? c.campaignName : "World date")}</div>` : ""
  const day = c.dateDay || c.date, year = c.dateDay ? c.dateYear : ""
  return `${head}${dialSvg(c)}<div class="pb-clock-date" title="${esc(c.date)}">${esc(day)}</div>` +
    `${year ? `<div class="pb-clock-year">${esc(year)}</div>` : ""}<div class="pb-clock-part">${esc(c.part)} · ${esc(c.time)}</div>${steps}`
}

function chatBarHtml(c) {
  // Three short lines that each fit the sidebar, instead of one crammed line:
  // weekday (accent) · the day ("13th of MistMorn") · the year and age.
  const day = c.dateDay || c.date, year = c.dateDay ? c.dateYear : ""
  return `<div class="pb-chatclock-text">${c.weekday ? `<div class="pb-chatclock-wd">${esc(c.weekday)}</div>` : ""}` +
    `<div class="pb-chatclock-date" title="${esc(c.date)} · ${esc(c.part)} · ${esc(c.time)}">${esc(day)}</div>` +
    `${year ? `<div class="pb-chatclock-year">${esc(year)}</div>` : ""}</div>${phasesSvg(c)}`
}

// ── placing ───────────────────────────────────────────────────
function onStepClick(ev) {
  const b = ev.target.closest?.("button[data-days]")
  if (!b) return
  ev.preventDefault()
  const msg = { type: "clock.step", days: n(b.dataset.days), hours: n(b.dataset.hours) }
  if (!sender || !sender(msg)) ui.notifications?.warn("RealmScreen isn’t connected, so the date can’t move from here.")
}

// The dial only shows while RealmScreen is connected: the GM's client keeps the
// world setting `clockLive` in step with its link, and a player also needs a GM
// logged in (a GM who closed the tab can't clear the setting). Otherwise the
// Players area is stock Foundry. The chat date bar stays — it is only a date.
function readLive() { try { return !!game.settings.get(MOD, "clockLive") } catch { return false } }
function anyActiveGM() { try { return game.users.some(u => u.active && u.isGM) } catch { return false } }
const dialOn = () => !!clock && readLive() && anyActiveGM()

const LIVE_GRACE_MS = 5000   // a dropped link retries every second — don't blink the dial
let liveOffT = 0
/** main.js calls this as the GM's link to RealmScreen comes and goes. */
export function setClockLive(on, { now = false } = {}) {
  if (!game.user?.isGM) return
  const write = () => {
    liveOffT = 0
    try { if (readLive() !== on) Promise.resolve(game.settings.set(MOD, "clockLive", on)).catch(() => {}) } catch { /* settings not ready */ }
  }
  if (on || now) { clearTimeout(liveOffT); write(); return }
  if (!liveOffT) liveOffT = setTimeout(write, LIVE_GRACE_MS)
}

function placePlayers(root) {
  if (!root) return
  let box = root.querySelector(":scope > .pb-clock")
  const on = dialOn()
  root.classList.toggle("pb-clock-player", on && !game.user?.isGM)
  root.classList.toggle("pb-has-clock", on)
  if (!on) { box?.remove(); return }
  if (!box) {
    box = document.createElement("section")
    box.className = "pb-clock"
    box.addEventListener("click", onStepClick)
    root.prepend(box)
  }
  box.innerHTML = clockHtml(clock, !!game.user?.isGM)
}

function placeChat(root) {
  if (!root) return
  let bar = root.querySelector(":scope > .pb-chatclock")
  if (!clock) { bar?.remove(); return }
  if (!bar) {
    bar = document.createElement("header")
    bar.className = "pb-chatclock"
    root.prepend(bar)
  }
  bar.innerHTML = chatBarHtml(clock)
}

function redraw() {
  placePlayers(document.getElementById("players"))
  for (const el of document.querySelectorAll("#chat, .chat-popout, #chat-popout")) placeChat(el)
}

// ── apply (every client) / set (GM, from the bridge command) ──
export function applyClock(c) {
  clock = c && typeof c === "object" && c.date ? c : null
  redraw()
}
function readSetting() { try { return game.settings.get(MOD, "clock") || null } catch { return null } }

export async function setClock(c) {
  if (!game.user?.isGM) throw new Error("Only the GM can set the campaign clock")
  const next = c && typeof c === "object" ? c : null
  await game.settings.set(MOD, "clock", next)
  // Foundry's own world time follows, so effect and spell durations count down.
  let worldTime = null
  const t = n(next?.worldTime, NaN)
  if (Number.isFinite(t) && t >= 0 && game.time && t !== game.time.worldTime) {
    try { await game.time.advance(t - game.time.worldTime); worldTime = game.time.worldTime } catch (e) { console.warn(`${MOD} | world time not set`, e) }
  }
  return { ok: true, campaignId: next?.campaignId || null, worldTime }
}

// ── hooks ─────────────────────────────────────────────────────
Hooks.once("init", () => {
  game.settings.register(MOD, "clock", { scope: "world", config: false, type: Object, default: null, onChange: (v) => applyClock(v) })
  game.settings.register(MOD, "clockLive", { scope: "world", config: false, type: Boolean, default: false, onChange: () => redraw() })
})
Hooks.once("ready", () => {
  // A GM arriving starts from "not connected"; the handshake (a moment later) turns it on.
  setClockLive(false, { now: true })
  applyClock(readSetting())
})
Hooks.on("userConnected", () => redraw())

const rootOf = (el) => (el instanceof HTMLElement ? el : el?.[0] || null)
Hooks.on("renderPlayers", (app, el) => { placePlayers(rootOf(el) || document.getElementById("players")) })
Hooks.on("renderChatLog", (app, el) => { placeChat(rootOf(el)) })

// For a render harness outside Foundry (no effect in Foundry).
export const _draw = { clockHtml, chatBarHtml }
