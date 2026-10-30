// ──────────────────────────────────────────────────────────────
// Views — each viewer's own eye button (the user's sketch, 2026-10-30).
//
// An eye in the RealmScreen control set, for players and the GM alike. Clicking it opens a column of three
// square buttons beside it (the user's second sketch: no window), each switching off / on for THIS account:
//   Grid             RealmScreen's world-map grid (the overlay the World Map sends; main.js ovl*)
//   Nation borders   the borders (and their colour wash) RealmScreen sent — only the ones this viewer may see
//   Road ways        the roads RealmScreen sent — same rule
// Only hides; it never shows anything the Map views / GM-only rules hide (realm-layer.js visibleFor).
// A user setting: each account keeps its own pick on every device. Everything is on until they turn it off.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
export const SEE = [
  { key: "grid", label: "Grid", icon: "fa-solid fa-table-cells-large" },
  { key: "borders", label: "Nation borders", icon: "fa-solid fa-flag" },
  { key: "roads", label: "Road ways", icon: "fa-solid fa-road" },
]
const setKey = (k) => `see${k[0].toUpperCase()}${k.slice(1)}`

/** Does this viewer want to see `key` (grid | borders | roads)? */
export function seeing(key) {
  try { return game.settings.get(MOD, setKey(key)) !== false } catch { return true }
}

// ── the flyout: one square button per thing, in a column beside the eye ──
// Built like Foundry's own control buttons (the eye's classes copied), lit = showing.
let fly = null, anchor = null

function closeFly() {
  fly?.remove(); fly = null; anchor = null
  document.removeEventListener("pointerdown", outside, true)
  document.removeEventListener("keydown", onKey, true)
}
function outside(e) { if (fly && !fly.contains(e.target) && !anchor?.contains(e.target)) closeFly() }
function onKey(e) { if (e.key === "Escape") closeFly() }

function paint() {
  if (!fly) return
  for (const b of fly.querySelectorAll("button[data-see]")) {
    const s = SEE.find(x => x.key === b.dataset.see), on = seeing(s.key)
    b.classList.toggle("active", on)
    b.setAttribute("aria-pressed", on ? "true" : "false")
    b.dataset.tooltip = `${s.label}: ${on ? "shown" : "hidden"}`
    b.ariaLabel = b.dataset.tooltip
  }
}

function place() {
  if (!fly || !anchor?.isConnected) return closeFly()
  const r = anchor.getBoundingClientRect()
  fly.style.left = `${Math.round(r.right + 6)}px`
  fly.style.top = `${Math.round(r.top)}px`
}

/** The eye: open (or close) the column of switches beside the button that was clicked. */
export function openMyView(event) {
  const btn = event?.target?.closest?.("button, [data-tool]") || document.querySelector('#scene-controls [data-tool="views"]')
  if (fly) { closeFly(); return }
  if (!btn) return
  anchor = btn
  fly = document.createElement("menu")
  fly.className = "pb-see"
  fly.setAttribute("aria-label", "Views")
  const cls = (btn.className || "control ui-control icon").split(/\s+/).filter(c => c && !/^fa-/.test(c) && c !== "active").join(" ")
  for (const s of SEE) {
    const li = document.createElement("li")
    const b = document.createElement("button")
    b.type = "button"
    b.className = `${cls} ${s.icon}`
    b.dataset.see = s.key
    b.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation()
      await game.settings.set(MOD, setKey(s.key), !seeing(s.key))
      paint()
    })
    li.append(b)
    fly.append(li)
  }
  document.body.append(fly)
  paint(); place()
  document.addEventListener("pointerdown", outside, true)
  document.addEventListener("keydown", onKey, true)
}

Hooks.once("init", () => {
  for (const s of SEE) {
    game.settings.register(MOD, setKey(s.key), {
      scope: "user", config: false, type: Boolean, default: true,
      onChange: () => { Hooks.callAll(s.key === "grid" ? "pendantGridSeen" : "pendantRealmRedraw"); paint() },
    })
  }
})
// Foundry redraws the controls (another set, a reset): the eye may be gone or moved.
Hooks.on("renderSceneControls", () => setTimeout(() => {
  if (!fly) return
  const eye = document.querySelector('#scene-controls [data-tool="views"]')
  if (!eye) return closeFly()
  anchor = eye; place()
}, 0))
Hooks.on("canvasTearDown", () => closeFly())
