// ──────────────────────────────────────────────────────────────
// RealmScreen scene control — a DM-screen button in the left-hand controls.
//
// While RealmScreen is connected (live.js), every user gets one more control
// set under Foundry's own (Tokens, Drawings, …), drawn as a DM screen. Its
// tools are RealmScreen's player tools: "Plan a trip" (does nothing yet) and
// "Campaigns" (scripts/campaigns.js). Not connected = the control isn't there at all.
//
// Native-first: added through `getSceneControlButtons`, re-prepared with
// `ui.controls.render({ reset: true })` when the link comes or goes.
// ──────────────────────────────────────────────────────────────

import { realmLive } from "./live.js"
import { openCampaigns } from "./campaigns.js"
import { openMapViews, openSentList } from "./mapviews-ui.js"

const NAME = "realmscreen"

export function realmControl() {
  return {
    name: NAME,
    order: -1,                        // FIRST: with many modules + the clock the column runs off
                                      // the screen, and this one must always be reachable
    title: "RealmScreen",
    icon: "pb-dm-screen",             // styles/pendant-bridge.css draws assets/dm-screen.svg
    visible: true,
    tools: {
      planTrip: {
        name: "planTrip",
        order: 0,
        title: "Plan a trip",
        icon: "fa-solid fa-route",
        button: true,
        onChange: () => {},           // coming later
      },
      campaigns: {
        name: "campaigns",
        order: 1,
        title: "Campaigns",
        icon: "fa-solid fa-flag",
        button: true,
        onChange: () => { openCampaigns() },   // scripts/campaigns.js
      },
      // The GM's: which of the World Map views players see, and what RealmScreen sent (scripts/mapviews-ui.js).
      mapViews: {
        name: "mapViews",
        order: 2,
        title: "Map views",
        icon: "fa-solid fa-layer-group",
        button: true,
        visible: !!game.user?.isGM,
        onChange: () => { openMapViews() },
      },
      mapSent: {
        name: "mapSent",
        order: 3,
        title: "Sent from RealmScreen",
        icon: "fa-solid fa-list",
        button: true,
        visible: !!game.user?.isGM,
        onChange: () => { openSentList() },
      },
    },
  }
}

Hooks.on("getSceneControlButtons", (controls) => {
  if (!realmLive()) return
  if (Array.isArray(controls)) {      // V11/V12: an array of sets, tools as an array
    const c = realmControl()
    controls.push({ ...c, layer: "tokens", tools: Object.values(c.tools).map(t => ({ ...t, onClick: t.onChange })) })
  } else controls[NAME] = realmControl()
})

// Is our set in the controls Foundry has prepared right now?
function hasOurs() {
  const c = ui.controls?.controls
  return Array.isArray(c) ? c.some(x => x.name === NAME) : !!c?.[NAME]
}

async function refresh() {
  if (!ui.controls?.rendered || realmLive() === hasOurs()) return
  try {
    // Leave our set first if it is the open one, or Foundry would keep a set that no longer exists.
    const open = ui.controls.control?.name ?? ui.controls.activeControl
    if (!realmLive() && open === NAME) await ui.controls.activate?.({ control: "tokens" })
    if (Array.isArray(ui.controls.controls)) { ui.controls.initialize?.(); ui.controls.render() }   // V11/V12
    else await ui.controls.render({ reset: true })
  } catch (e) { console.warn("[pendant-bridge] scene control refresh failed", e) }
}

Hooks.on("pendantBridgeLive", () => refresh())
Hooks.once("ready", () => refresh())

// ── never off the screen ──────────────────────────────────────
// Foundry stacks the control sets in one column above the Players box (where our clock lives).
// With many modules the column runs past it and the last buttons can't be reached. Cap each
// menu at the room it really has and let it scroll — only when it doesn't fit.
export function roomFor(top, playersTop, viewH, min = 120) {
  const bottom = Number.isFinite(playersTop) && playersTop > top ? playersTop : viewH
  return Math.max(min, Math.floor(bottom - top - 8))
}
function fitControls() {
  const root = document.getElementById("scene-controls")
  if (!root) return
  const players = document.getElementById("players")
  const pTop = players?.offsetParent ? players.getBoundingClientRect().top : NaN
  for (const m of root.querySelectorAll("#scene-controls-layers, #scene-controls-tools")) {
    // Measure as Foundry lays it out, then cap only if it runs past the room (so nothing is
    // clipped — not even the active button's glow — when it all fits).
    m.classList.remove("pb-fit"); m.style.maxHeight = ""
    const room = roomFor(m.getBoundingClientRect().top, pTop, window.innerHeight)
    if (m.scrollHeight > room) { m.classList.add("pb-fit"); m.style.maxHeight = `${room}px` }
  }
}
let fitT = 0
const scheduleFit = () => { cancelAnimationFrame(fitT); fitT = requestAnimationFrame(fitControls); setTimeout(fitControls, 250) }
Hooks.on("renderSceneControls", scheduleFit)
Hooks.on("renderPlayers", scheduleFit)
Hooks.on("renderPlayerList", scheduleFit)
Hooks.once("ready", () => {
  window.addEventListener("resize", scheduleFit)
  const players = document.getElementById("players")
  if (players && typeof ResizeObserver === "function") new ResizeObserver(scheduleFit).observe(players)   // the clock grows/shrinks
  scheduleFit()
})
