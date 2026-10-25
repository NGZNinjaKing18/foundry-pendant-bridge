// ──────────────────────────────────────────────────────────────
// RealmScreen scene control — a DM-screen button in the left-hand controls.
//
// While RealmScreen is connected (live.js), every user gets one more control
// set under Foundry's own (Tokens, Drawings, …), drawn as a DM screen. Its
// tools are RealmScreen's player tools; for now one button, "Plan a trip",
// which does nothing yet. Not connected = the control isn't there at all.
//
// Native-first: added through `getSceneControlButtons`, re-prepared with
// `ui.controls.render({ reset: true })` when the link comes or goes.
// ──────────────────────────────────────────────────────────────

import { realmLive } from "./live.js"

const NAME = "realmscreen"

export function realmControl() {
  return {
    name: NAME,
    order: 100,                       // after Foundry's own sets
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
