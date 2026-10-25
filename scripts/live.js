// ──────────────────────────────────────────────────────────────
// Is RealmScreen connected? — one answer on every client.
//
// Only the GM window that actually holds the RealmScreen link knows. It says
// so over Foundry's module socket: "live" on connect and every 20 s, "off"
// when the link drops (after a short grace, the link retries every second).
// Every other client — players anywhere in the world, other GM windows —
// keeps a list of linked windows and counts one as live while it has been
// heard from in the last 50 s and its user is still logged in. A window that
// opens asks "who's live?" and linked windows answer at once.
//
// Fallback: the world setting `clockLive` (the old switch). It is only used
// while nothing has come over the socket yet (the socket needs the world to
// have been launched with this module version), and only the window that
// holds the link ever writes it — another GM window opening never turns it off.
//
// Changes fire the hook `pendantBridgeLive(live)`.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
const CHANNEL = `module.${MOD}`
const BEAT_MS = 20000
const STALE_MS = 50000
const GRACE_MS = 5000

const me = Math.random().toString(36).slice(2, 10)   // this window
const peers = new Map()        // window id → { user, at }
let linked = false             // this window holds the RealmScreen link
let wroteSetting = false       // this window has written clockLive = true
let socketHeard = false        // anything came over the socket since load
let beatT = 0, offT = 0, last = null

const now = () => Date.now()
const userActive = (id) => { try { return !!game.users.get(id)?.active } catch { return false } }
const anyActiveGM = () => { try { return game.users.some(u => u.active && u.isGM) } catch { return false } }
const readSetting = () => { try { return !!game.settings.get(MOD, "clockLive") } catch { return false } }

/** Pure rule, exported for tests. */
export function liveFrom({ linkedHere, peers, at, socketHeard, setting, isActive, anyGM }) {
  if (linkedHere) return true
  for (const p of peers.values()) if (at - p.at < STALE_MS && isActive(p.user)) return true
  if (socketHeard) return false
  return !!setting && anyGM
}

export function realmLive() {
  return liveFrom({
    linkedHere: linked, peers, at: now(), socketHeard,
    setting: readSetting(), isActive: userActive, anyGM: anyActiveGM(),
  })
}

function check() {
  const v = realmLive()
  if (v === last) return
  last = v
  console.log(`[pendant-bridge] RealmScreen ${v ? "connected" : "not connected"} (as seen by this window)`)
  Hooks.callAll("pendantBridgeLive", v)
}

function emit(msg) {
  try { game.socket?.emit(CHANNEL, { ...msg, from: me, user: game.user?.id }) } catch { /* socket not ready */ }
}

function onMessage(m) {
  if (!m || m.from === me || typeof m.t !== "string" || !m.t.startsWith("live")) return
  socketHeard = true
  if (m.t === "live") peers.set(m.from, { user: m.user, at: now() })
  else if (m.t === "live.off") peers.delete(m.from)
  else if (m.t === "live.ask") {
    if (linked) emit({ t: "live" })
    else if (game.user?.isGM) emit({ t: "live.none" })   // proves the socket works
  }
  check()
}

function writeSetting(on) {
  if (!game.user?.isGM) return
  try { if (readSetting() !== on) Promise.resolve(game.settings.set(MOD, "clockLive", on)).catch(() => {}) } catch { /* not ready */ }
}

/** main.js (through clock.js) calls this as THIS window's RealmScreen link comes and goes. */
export function setLinked(on) {
  if (on) {
    clearTimeout(offT); offT = 0
    if (!linked) {
      linked = true
      emit({ t: "live" })
      clearInterval(beatT); beatT = setInterval(() => emit({ t: "live" }), BEAT_MS)
    }
    if (game.user?.isGM) { wroteSetting = true; writeSetting(true) }
    check()
    return
  }
  if (!linked || offT) return
  offT = setTimeout(() => {
    offT = 0
    linked = false
    clearInterval(beatT); beatT = 0
    emit({ t: "live.off" })
    // Only the window that turned the old switch on turns it off, and only
    // when no other linked window is still heard from.
    if (wroteSetting && ![...peers.values()].some(p => now() - p.at < STALE_MS)) { writeSetting(false); wroteSetting = false }
    check()
  }, GRACE_MS)
}

Hooks.once("init", () => {
  game.settings.register(MOD, "clockLive", { scope: "world", config: false, type: Boolean, default: false, onChange: () => check() })
})
Hooks.once("ready", () => {
  try { game.socket?.on(CHANNEL, onMessage) } catch { /* no socket */ }
  emit({ t: "live.ask" })
  setInterval(check, 10000)        // stale windows drop out
  check()
})
Hooks.on("userConnected", (user, connected) => {
  if (!connected) {
    for (const [k, p] of peers) if (p.user === user?.id) peers.delete(k)
  } else if (linked) emit({ t: "live" })   // someone joined — tell them straight away
  check()
})
globalThis.window?.addEventListener("beforeunload", () => { if (linked) emit({ t: "live.off" }) })
