// ──────────────────────────────────────────────────────────────
// Campaigns — the "Campaigns" button in the RealmScreen scene control.
//
// RealmScreen sends `campaigns.set` with its roster whenever campaigns, the
// players or the running session change. The GM window stores it in the world
// setting `pendant-bridge.campaigns`, so every client reads the same thing:
//
//   { active: { id, name } | null,
//     campaigns: [{ id, name, users: [Foundry user id] }] }   // users = who is in it
//
// Pressing the button:
//   • a session is running → a user in that campaign (or a GM) gets its page;
//     anyone else gets nothing at all
//   • no session → the campaigns this user is in (a GM: every campaign); pick
//     one → "Start a session?" → Yes asks RealmScreen to start it, or "Just
//     view details" opens its page
//
// A player's window can't reach RealmScreen, so "Yes" goes over the module
// socket to the GM window holding the link, which passes `campaign.start` on.
// RealmScreen decides (it checks again) and answers with `campaigns.note`,
// which comes back to that one user as a notification.
//
// The page itself is scripts/campaign-page.js. When a session starts, its players get it
// opened for them (the roster's `active` changing to a campaign they're in).
// ──────────────────────────────────────────────────────────────

import { linkedHere } from "./live.js"
import { openPage } from "./campaign-page.js"

const MOD = "pendant-bridge"
const KEY = "campaigns"
const CHANNEL = `module.${MOD}`

let sender = null   // (msg) => bool — the bridge's WebSocket send (GM window only)
/** main.js hands over its send so a linked window can pass requests on. */
export function setCampaignSender(fn) { sender = typeof fn === "function" ? fn : null }

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const str = (v) => (typeof v === "string" ? v.trim() : "")

// ── the roster ────────────────────────────────────────────────
/** Clean a roster from RealmScreen (exported for tests). */
export function cleanRoster(r) {
  const campaigns = (Array.isArray(r?.campaigns) ? r.campaigns : [])
    .map(c => ({ id: str(c?.id), name: str(c?.name) || "Untitled campaign", users: (Array.isArray(c?.users) ? c.users : []).map(str).filter(Boolean) }))
    .filter(c => c.id)
  const a = r?.active && str(r.active.id) ? { id: str(r.active.id), name: str(r.active.name) || campaigns.find(c => c.id === str(r.active.id))?.name || "Campaign" } : null
  return { active: a, campaigns }
}

/**
 * What the button does for this user (exported for tests).
 * → { kind: "page", campaign } · { kind: "none" } · { kind: "list", campaigns }
 */
export function buttonFor(roster, userId, isGM) {
  const r = cleanRoster(roster)
  const inIt = (c) => isGM || c.users.includes(userId)
  if (r.active) {
    const c = r.campaigns.find(x => x.id === r.active.id) || { ...r.active, users: [] }
    return inIt(c) ? { kind: "page", campaign: c } : { kind: "none" }
  }
  return { kind: "list", campaigns: r.campaigns.filter(inIt) }
}

const readRoster = () => { try { return game.settings.get(MOD, KEY) || null } catch { return null } }

/** The `campaigns.set` command (GM window). */
export async function setCampaigns(roster) {
  if (!game.user?.isGM) throw new Error("Only the GM can set the campaigns")
  await game.settings.set(MOD, KEY, cleanRoster(roster))
  return { ok: true }
}

/** The `campaigns.note` command: tell one user (or everyone) something. */
export function noteCampaigns({ userId, text, level } = {}) {
  const msg = { t: "camp.note", to: str(userId) || null, text: str(text), level: level === "warn" ? "warn" : "info" }
  if (!msg.text) return { ok: false }
  showNote(msg)
  try { game.socket?.emit(CHANNEL, msg) } catch { /* no socket */ }
  return { ok: true }
}

function showNote(m) {
  if (m.to && m.to !== game.user?.id) return
  ui.notifications?.[m.level === "warn" ? "warn" : "info"](m.text)
}

// ── asking RealmScreen to start a session ─────────────────────
function passOn(campaignId, userId) {
  const u = game.users?.get(userId)
  if (!u || !sender) return false
  return sender({ type: "campaign.start", campaignId, userId, userName: u.name, isGM: !!u.isGM })
}

/** What the campaign page does goes to RealmScreen the same way (only these types). */
const RELAYED = new Set(["campaign.page"])
function passMsg(type, data, userId) {
  const u = game.users?.get(userId)
  if (!u || !sender || !RELAYED.has(type)) return false
  return sender({ ...(data && typeof data === "object" ? data : {}), type, userId: u.id, userName: u.character?.name || u.name, isGM: !!u.isGM })
}
export function relay(type, data) {
  if (linkedHere() && passMsg(type, data, game.user.id)) return true
  try { game.socket?.emit(CHANNEL, { t: "camp.relay", type, data, user: game.user.id }) } catch { /* no socket */ }
  return true
}

function askStart(campaign) {
  if (linkedHere() && passOn(campaign.id, game.user.id)) return ui.notifications?.info(`Asking RealmScreen to start ${campaign.name}…`)
  try { game.socket?.emit(CHANNEL, { t: "camp.start", campaignId: campaign.id, user: game.user.id }) } catch { /* no socket */ }
  ui.notifications?.info(`Asking RealmScreen to start ${campaign.name}…`)
}

function onSocket(m, senderId) {
  if (!m || typeof m.t !== "string" || !m.t.startsWith("camp.")) return
  if (m.t === "camp.note") return showNote(m)
  // Only the window holding the link passes a request on. Foundry names the sender when it can.
  if (m.t === "camp.start" && linkedHere()) passOn(str(m.campaignId), str(senderId) || str(m.user))
  if (m.t === "camp.relay" && linkedHere()) passMsg(str(m.type), m.data, str(senderId) || str(m.user))
}

// ── the windows ───────────────────────────────────────────────
const DialogV2 = () => foundry?.applications?.api?.DialogV2 || null

async function chooseCampaign(list) {
  const D = DialogV2()
  if (!D) return null
  const id = await D.wait({
    window: { title: "Campaigns", icon: "fa-solid fa-flag" },
    classes: ["pb-campaigns"],
    content: `<p>${game.user?.isGM ? "Every campaign in RealmScreen." : "The campaigns you're in."}</p>`,
    buttons: list.map((c, i) => ({ action: c.id, label: c.name, icon: "fa-solid fa-flag", default: i === 0 })),
    rejectClose: false,
  })
  return list.find(c => c.id === id) || null
}

async function startOrView(campaign) {
  const D = DialogV2()
  if (!D) return openPage(campaign)
  const pick = await D.wait({
    window: { title: campaign.name, icon: "fa-solid fa-flag" },
    content: `<p>Do you want to start a session of <strong>${esc(campaign.name)}</strong>?</p>`,
    buttons: [
      { action: "start", label: "Yes, start session", icon: "fa-solid fa-play", default: true },
      { action: "view", label: "Just view details", icon: "fa-solid fa-book-open" },
    ],
    rejectClose: false,
  })
  if (pick === "start") askStart(campaign)
  else if (pick === "view") openPage(campaign)
}

/** The Campaigns button. */
export async function openCampaigns() {
  const b = buttonFor(readRoster(), game.user?.id, !!game.user?.isGM)
  if (b.kind === "none") return                       // a session of another campaign is running
  if (b.kind === "page") return openPage(b.campaign)
  if (!b.campaigns.length) return ui.notifications?.info("You aren't in any RealmScreen campaign yet.")
  const c = await chooseCampaign(b.campaigns)
  if (c) await startOrView(c)
}

// A session starting opens its page for its players (not the GM: they started it).
let wasActive
function onRoster(v) {
  const r = cleanRoster(v)
  const now = r.active?.id || null
  if (wasActive !== undefined && now && now !== wasActive && !game.user?.isGM) {
    const b = buttonFor(r, game.user?.id, false)
    if (b.kind === "page") openPage(b.campaign)
  }
  wasActive = now
}

// ── hooks ─────────────────────────────────────────────────────
Hooks.once("init", () => {
  game.settings.register(MOD, KEY, { scope: "world", config: false, type: Object, default: null, onChange: onRoster })
})
Hooks.once("ready", () => {
  wasActive = cleanRoster(readRoster()).active?.id || null
  try { game.socket?.on(CHANNEL, onSocket) } catch { /* no socket */ }
})
