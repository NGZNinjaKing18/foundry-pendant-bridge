// ──────────────────────────────────────────────────────────────
// Views — each viewer's own eye button (the user's sketch, 2026-10-30).
//
// An eye in the RealmScreen control set, for players and the GM alike. It opens a small "Views" window
// with three switches for what THIS viewer sees on the scene:
//   Grid             Foundry's own grid lines
//   Nation borders   the borders (and their colour wash) RealmScreen sent — only the ones this viewer may see
//   Road ways        the roads RealmScreen sent — same rule
// Only hides; it never shows anything the Map views / GM-only rules hide (realm-layer.js visibleFor).
// A client setting: every browser keeps its own pick. Everything is on until the viewer turns it off.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
export const SEE = [
  { key: "grid", label: "Grid", icon: "fa-solid fa-border-all" },
  { key: "borders", label: "Nation borders", icon: "fa-solid fa-flag" },
  { key: "roads", label: "Road ways", icon: "fa-solid fa-road" },
]
const setKey = (k) => `see${k[0].toUpperCase()}${k.slice(1)}`

/** Does this viewer want to see `key` (grid | borders | roads)? */
export function seeing(key) {
  try { return game.settings.get(MOD, setKey(key)) !== false } catch { return true }
}

// Foundry's grid mesh: hidden here, put back by Foundry itself whenever it redraws the grid layer.
function applyGrid() {
  const mesh = canvas?.interface?.grid?.mesh
  if (mesh) mesh.visible = seeing("grid")
}

let App = null
function appClass() {
  const AppV2 = foundry?.applications?.api?.ApplicationV2
  if (!AppV2) return null
  if (App) return App
  App = class MyViewApp extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: "pb-my-view",
      classes: ["pb-mv"],
      window: { title: "Views", icon: "fa-solid fa-eye" },
      position: { width: 220, height: "auto" },
      actions: { toggle: MyViewApp.toggle },
    }
    async _renderHTML() {
      const el = document.createElement("div")
      el.innerHTML = `<ul class="pb-mv-list">${SEE.map(s => `
        <li class="pb-mv-opt">
          <label><input type="checkbox" data-action="toggle" data-key="${s.key}" ${seeing(s.key) ? "checked" : ""}>
          <i class="${s.icon}"></i> ${s.label}</label>
        </li>`).join("")}</ul>`
      return el
    }
    _replaceHTML(result, content) { content.replaceChildren(result) }
    static async toggle(event, target) {
      await game.settings.set(MOD, setKey(target.dataset.key), !!target.checked)
    }
  }
  return App
}

export function openMyView() {
  const C = appClass()
  if (!C) return
  const open = foundry.applications.instances?.get("pb-my-view")
  if (open) { open.close(); return }
  new C().render({ force: true })
}

Hooks.once("init", () => {
  for (const s of SEE) {
    game.settings.register(MOD, setKey(s.key), {
      scope: "client", config: false, type: Boolean, default: true,
      onChange: () => { if (s.key === "grid") applyGrid(); else Hooks.callAll("pendantRealmRedraw") },
    })
  }
})
Hooks.on("canvasReady", () => applyGrid())
// Foundry re-initialises the mesh when the scene's grid changes; hide it again after that.
Hooks.on("updateScene", (scene, changes) => { if (scene?.id === canvas?.scene?.id && "grid" in (changes || {})) setTimeout(applyGrid, 0) })
