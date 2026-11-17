// ──────────────────────────────────────────────────────────────
// Scene doors — the pure rules (tested in tests/scene-doors.test.mjs; scripts/scene-doors.js draws them).
//
// A door is { id, scene, x, y, town? } in the scene's flags[pendant-bridge].doors:
//   scene  the id of the scene it leads to
//   x, y   the spot on this scene (scene px) — the pin's tip
//   town   optional: the id of a Realm-layer town it belongs to (shown as a little roof on its corner)
// ──────────────────────────────────────────────────────────────

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

/** The doors stored on a scene document (bad entries dropped). */
export function doorsOf(scene) {
  const raw = scene?.flags?.["pendant-bridge"]?.doors ?? scene?.getFlag?.("pendant-bridge", "doors")
  return cleanDoors(raw)
}
export function cleanDoors(raw) {
  if (!Array.isArray(raw)) return []
  const out = [], seen = new Set()
  for (const d of raw) {
    if (!d || typeof d !== "object") continue
    const id = String(d.id || ""), x = num(d.x), y = num(d.y)
    if (!id || seen.has(id) || !d.scene || x == null || y == null) continue
    seen.add(id)
    out.push({ id, scene: String(d.scene), x, y, ...(d.town ? { town: String(d.town) } : {}) })
  }
  return out
}

export function addDoor(doors, door) { return [...cleanDoors(doors), ...cleanDoors([door])] }
export function patchDoor(doors, id, patch) {
  return cleanDoors(doors).map(d => {
    if (d.id !== id) return d
    const n = { ...d, ...patch }
    if (!n.town) delete n.town
    return n
  })
}
export function removeDoor(doors, id) { return cleanDoors(doors).filter(d => d.id !== id) }

/** Every scene that has a door leading to `sceneId` (for the "back" chips): [{ from, door }]. */
export function doorsInto(scenes, sceneId) {
  const out = []
  for (const s of scenes || []) {
    if (!s || s.id === sceneId) continue
    for (const d of doorsOf(s)) if (d.scene === sceneId) { out.push({ from: s, door: d }); break }
  }
  return out
}

/**
 * How much a door is scaled (scene px per screen px × size).
 *   mapZoom >= lock: the same size on screen (size / stage scale)
 *   mapZoom <  lock: locked to the map — it stops growing against the map and shrinks with it
 * mapZoom = stageScale / fit (1 = the scene fits the screen). Size 1 = 100 %.
 */
export function doorScale({ stageScale, fit, size = 1, lock = 1 }) {
  const s = stageScale > 0 ? stageScale : 1
  const f = fit > 0 ? fit : s
  const L = lock > 0 ? lock : 1
  const z = s / f
  return (size > 0 ? size : 1) / (z >= L ? s : f * L)
}

/** "5 ft · 40 × 28" for a scene (grid distance + size in squares), or "" when it can't tell. */
export function gridLine(scene) {
  const g = scene?.grid || {}
  const size = num(g.size) || num(scene?.grid?.size) || null
  const dist = num(g.distance), units = g.units || ""
  const w = num(scene?.width), h = num(scene?.height)
  const parts = []
  if (dist) parts.push(`${dist} ${units}`.trim())
  if (size && w && h) parts.push(`${Math.round(w / size)} × ${Math.round(h / size)}`)
  return parts.join(" · ")
}

/** Door id: short, unique enough within one scene. */
export const newDoorId = () => "d" + Math.random().toString(36).slice(2, 10)
