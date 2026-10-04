// ──────────────────────────────────────────────────────────────
// Campaign party — RealmScreen's party on the linked overland scene.
//
// RealmScreen is in charge of where the party is. It sends `party.sync` with
// the FULL list of party tokens a scene should have; this file reconciles the
// scene to that list:
//
//   • a listed token that isn't there yet  → created
//   • a listed token that is there          → moved / renamed / shown / hidden
//   • a party token that isn't listed       → removed
//
// Party tokens carry `flags.pendant-bridge.party = { key, campaignId }`, so
// nothing else on the scene is ever touched. They have no actor (one group
// token per spot, not one per character). Positions come as 0..1 fractions of
// the map image, the same convention as `settlement.push`.
//
// The GM dragging a party token does NOT move anyone in RealmScreen: the bridge
// sends `party.moved`, and RealmScreen opens a suggested journey for the GM to
// review. Moves this file makes itself are tagged so they never echo back.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
const SYNC = "pendantPartySync"          // update option on our own writes

const partyFlag = (doc) => doc?.getFlag?.(MOD, "party") || null

function dims(scene) {
  const d = scene.dimensions
  return { x: d.sceneX, y: d.sceneY, w: d.sceneWidth, h: d.sceneHeight, size: d.size || scene.grid?.size || 100 }
}

// The token's top-left so its CENTRE sits on the map point.
function topLeft(scene, t, wCells, hCells) {
  const d = dims(scene)
  const cx = d.x + Math.max(0, Math.min(1, Number(t.nx) || 0)) * d.w
  const cy = d.y + Math.max(0, Math.min(1, Number(t.ny) || 0)) * d.h
  return { x: Math.round(cx - (wCells * d.size) / 2), y: Math.round(cy - (hCells * d.size) / 2) }
}

/** The token centre back as a 0..1 map fraction. */
export function mapFraction(scene, tokenDoc) {
  const d = dims(scene)
  const cx = tokenDoc.x + ((tokenDoc.width || 1) * d.size) / 2
  const cy = tokenDoc.y + ((tokenDoc.height || 1) * d.size) / 2
  return { nx: (cx - d.x) / d.w, ny: (cy - d.y) / d.h }
}

/** { sceneId, tokens: [{ key, campaignId, name, nx, ny, src, hidden }] } → reconcile. */
export async function syncParty(msg) {
  const scene = game.scenes.get(msg.sceneId)
  if (!scene) throw new Error("Scene not found: " + msg.sceneId)
  const want = new Map()
  for (const t of (Array.isArray(msg.tokens) ? msg.tokens : [])) if (t && t.key) want.set(String(t.key), t)
  const have = new Map()
  const stale = []
  for (const doc of scene.tokens) {
    const f = partyFlag(doc)
    if (!f) continue
    if (want.has(f.key) && !have.has(f.key)) have.set(f.key, doc)
    else stale.push(doc.id)            // no longer listed, or a duplicate
  }
  const creates = [], updates = []
  for (const [key, t] of want) {
    const doc = have.get(key)
    const w = doc ? (doc.width || 1) : 1, h = doc ? (doc.height || 1) : 1
    const pos = topLeft(scene, t, w, h)
    const name = String(t.name || "Party")
    const src = String(t.src || "icons/svg/mystery-man.svg")
    const hidden = !!t.hidden
    if (!doc) {
      creates.push({
        name, ...pos, width: 1, height: 1, hidden,
        texture: { src },
        disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
        displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
        lockRotation: true,
        flags: { [MOD]: { party: { key, campaignId: String(t.campaignId || "") } } },
      })
      continue
    }
    const u = { _id: doc.id }
    if (doc.x !== pos.x || doc.y !== pos.y) { u.x = pos.x; u.y = pos.y }
    if (doc.name !== name) u.name = name
    if (doc.hidden !== hidden) u.hidden = hidden
    if (doc.texture?.src !== src) u.texture = { src }
    if (Object.keys(u).length > 1) updates.push(u)
  }
  if (stale.length) await scene.deleteEmbeddedDocuments("Token", stale, { [SYNC]: true })
  if (creates.length) await scene.createEmbeddedDocuments("Token", creates, { [SYNC]: true })
  if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, { [SYNC]: true })
  return { created: creates.length, updated: updates.length, removed: stale.length }
}

/**
 * main.js registers this on `updateToken`: a party token moved by hand (not by a
 * sync) → tell RealmScreen where it was dropped. `send` is the bridge's send.
 */
export function partyMovedHook(send) {
  return (doc, changes, options) => {
    if (options?.[SYNC]) return
    if (!("x" in (changes || {})) && !("y" in (changes || {}))) return
    const f = partyFlag(doc)
    const scene = doc.parent
    if (!f || !scene) return
    const { nx, ny } = mapFraction(scene, { x: changes.x ?? doc.x, y: changes.y ?? doc.y, width: doc.width, height: doc.height })
    send({ type: "party.moved", sceneId: scene.id, key: f.key, campaignId: f.campaignId, nx, ny })
  }
}
