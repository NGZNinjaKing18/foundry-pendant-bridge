// ──────────────────────────────────────────────────────────────
// "scene cover" scenes — one look for every scene tagged scene cover (the user, 2026-11-17).
//
// A scene whose tags (flags[pendant-bridge].tags, set from RealmScreen's sorter) include "scene cover"
// (any case) always has:
//   • Lock View (module "LockView", Scene config ▸ Lock View): Pan Lock off, Zoom Lock ON, Bounding Box off,
//     Autoscale = Horizontal Fit
//   • Token Vision off — players see the whole map (and no fog exploration)
//   • a gridless grid
//
// Applied by one GM window (the active GM) when the tag is added, when such a scene is made, and once on
// load for every tagged scene already in the world. Only what differs is written, so it settles at once.
// The Lock View part is written only while that module is on (Foundry keeps flags of an off module, but
// there's nothing to read them).
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
export const COVER_TAG = "scene cover"
const LV = "LockView"

const tagsOf = (s) => {
  const raw = s?.flags?.[MOD]?.tags ?? s?.getFlag?.(MOD, "tags")
  return Array.isArray(raw) ? raw.map(String) : []
}
export const isCover = (s) => tagsOf(s).some(t => t.trim().toLowerCase() === COVER_TAG)

/** The update a cover scene needs (only what differs), or null when it's already right. Pure (tested). */
export function coverUpdate(s, { lockView = true, gridless = 0 } = {}) {
  if (!s || !isCover(s)) return null
  const u = {}
  if (s.tokenVision !== false) u.tokenVision = false
  if (s.fog?.exploration !== false) u["fog.exploration"] = false
  if (s.grid?.type !== gridless) u["grid.type"] = gridless
  if (lockView) {
    const f = s.flags?.[LV] || {}
    const l = f.locks || {}
    if (l.pan !== false) u[`flags.${LV}.locks.pan`] = false
    if (l.zoom !== true) u[`flags.${LV}.locks.zoom`] = true
    if (l.boundingBox !== false) u[`flags.${LV}.locks.boundingBox`] = false
    if (f.autoscale !== "horizontal") u[`flags.${LV}.autoscale`] = "horizontal"
  }
  return Object.keys(u).length ? u : null
}

// ── Foundry side ──────────────────────────────────────────────
const writer = () => {
  const gm = game.users?.activeGM
  return gm ? gm.isSelf : !!game.user?.isGM
}
const lvOn = () => !!game.modules?.get?.(LV)?.active
const GRIDLESS = () => globalThis.CONST?.GRID_TYPES?.GRIDLESS ?? 0

async function fix(scenes) {
  if (!writer()) return 0
  const updates = []
  for (const s of scenes) {
    const u = coverUpdate(s, { lockView: lvOn(), gridless: GRIDLESS() })
    if (u) updates.push({ _id: s.id, ...u })
  }
  if (!updates.length) return 0
  try { await Scene.updateDocuments(updates) } catch (e) { console.warn("[pendant-bridge] scene cover settings", e); return 0 }
  console.log(`[pendant-bridge] scene cover: set ${updates.length} scene(s)`)
  return updates.length
}
/** Every tagged scene in the world, now (also callable from the console: game.modules.get(...)). */
export const fixAllCovers = () => fix((game.scenes?.contents || []).filter(isCover))

Hooks.once("ready", () => { setTimeout(() => fixAllCovers(), 1500) })   // after the world settles
Hooks.on("createScene", (s) => { if (isCover(s)) fix([s]) })
// The tag added (a hand change to one setting is left alone until the next load).
Hooks.on("updateScene", (s, changes) => { if (changes?.flags?.[MOD]?.tags && isCover(s)) fix([s]) })
