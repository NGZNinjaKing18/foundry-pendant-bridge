// ──────────────────────────────────────────────────────────────
// Campaigns — the "Campaigns" button in the RealmScreen scene control.
//
// RealmScreen sends `campaigns.set` with its roster whenever campaigns, the
// players or the running session change:
//
//   { active: { id, name } | null,
//     campaigns: [{ id, name, users: [Foundry user id] }] }   // users = who is in it
//
// The linked GM window keeps it in memory and gives each player ONLY their own
// campaigns, in their private slice (scripts/private.js `rosterFor`) — another
// campaign's names, members or running session never reach them.
//
// Pressing the button:
//   • a session is running → a user in that campaign (or a GM) gets its page;
//     anyone else gets nothing at all
//   • no session → the campaigns this user is in (a GM: every campaign); pick
//     one → "Start a session?" → Yes asks RealmScreen to start it, or "Just
//     view details" opens its page
//
// A player's window can't reach RealmScreen, so "Yes" is a hidden whisper to the
// GMs (private.js `sendOp`, author stamped by Foundry); the linked GM window
// passes `campaign.start` on. RealmScreen decides (it checks again) and answers
// with `campaigns.note`, which comes back to that one user as a notification.
//
// The page itself is scripts/campaign-page.js. It only ever opens because THIS user pressed
// the button (or a secret's chat card) — never by itself, never for anyone else.
// ──────────────────────────────────────────────────────────────

import { mySlice, setFull, sendOp, setOpPasser, noteTo } from "./private.js"
import { openPage } from "./campaign-page.js"

const MOD = "pendant-bridge"
const KEY = "campaigns"

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

// Each user's own part, from their private slice (scripts/private.js) — never a shared setting.
const readRoster = () => mySlice().roster

/** The `campaigns.set` command (GM window): kept in memory, written out per player. */
export async function setCampaigns(roster) {
  if (!game.user?.isGM) throw new Error("Only the GM can set the campaigns")
  setFull("roster", cleanRoster(roster))
  return { ok: true }
}

/** The `campaigns.note` command: tell one user (`userId`) or a few (`to`) — never everyone. */
export function noteCampaigns({ userId, to, text, level } = {}) {
  const ids = Array.isArray(to) ? to.map(str).filter(Boolean) : str(userId) ? [str(userId)] : []
  noteTo(ids, str(text), level === "warn" ? "warn" : "info")
  return { ok: !!ids.length && !!str(text) }
}

// ── acting: a player's request → RealmScreen ──────────────────
// Sent as a whisper to the GMs (scripts/private.js), so `userId` and `isGM` come from the
// message's REAL author — Foundry's server stamps it; nobody can claim to be someone else.
const RELAYED = new Set(["campaign.page", "campaign.start"])
export function passMsg(type, data, userId) {
  const u = game.users?.get(userId)
  if (!u || !sender || !RELAYED.has(type)) return false
  const { userId: _u, userName: _n, isGM: _g, ...clean } = data && typeof data === "object" ? data : {}
  return sender({ ...clean, type, userId: u.id, userName: u.character?.name || u.name, isGM: !!u.isGM })
}
setOpPasser(passMsg)
export function relay(type, data) { sendOp(type, data); return true }

function askStart(campaign) {
  sendOp("campaign.start", { campaignId: campaign.id })
  ui.notifications?.info(`Asking to start ${campaign.name}…`)
}

// ── the windows ───────────────────────────────────────────────
const DialogV2 = () => foundry?.applications?.api?.DialogV2 || null

async function chooseCampaign(list) {
  const D = DialogV2()
  if (!D) return null
  const id = await D.wait({
    window: { title: "Campaigns", icon: "fa-solid fa-flag" },
    classes: ["pb-campaigns"],
    content: `<p>${game.user?.isGM ? "Every campaign in RealmScreen." : "The campaigns you’re in."}</p>`,
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
  if (!b.campaigns.length) return ui.notifications?.info(game.user?.isGM ? "RealmScreen hasn’t sent any campaigns yet." : "You aren’t in a campaign yet.")
  const c = await chooseCampaign(b.campaigns)
  if (c) await startOrView(c)
}

// ── hooks ─────────────────────────────────────────────────────
Hooks.once("init", () => {
  // No longer written (it reached every client): kept registered so the GM can empty it (private.js).
  game.settings.register(MOD, KEY, { scope: "world", config: false, type: Object, default: null })
})
