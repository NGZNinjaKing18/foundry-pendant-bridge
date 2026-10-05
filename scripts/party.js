// ──────────────────────────────────────────────────────────────
// RealmScreen's people on the linked overland scene.
//
// RealmScreen is in charge of where everyone is. It sends:
//
//   • `party.sync`   — the FULL list of tokens a scene should have: each character
//                      with a linked actor as that actor's own token, everyone else
//                      as a stand-in (one per spot for a party). This file
//                      reconciles the scene to the list: create / move / rename /
//                      show / hide / remove. Only tokens it placed are touched
//                      (`flags.pendant-bridge.party = { key, campaignId }`).
//   • `party.trails` — the road already walked by travelling parties / PCs, with a
//                      mark where each travel day ended, as Drawings
//                      (`flags.pendant-bridge.trail = key`), visible to everyone.
//
// Positions are 0..1 fractions of the map image, as `settlement.push` uses.
//
// The GM dragging one of these tokens does NOT move anyone in RealmScreen: the
// bridge sends `party.moved`, and RealmScreen offers the move for the GM to
// confirm. Moves this file makes itself are tagged so they never echo back.
//
// The GM can pause all of it from the Token controls ("RealmScreen moves people"):
// while paused nothing is placed, nothing snaps back and no drag is reported —
// tokens are just tokens. Turning it back on asks RealmScreen to re-sync.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
const SYNC = "pendantPartySync"          // update option on our own writes
const TOOL = "pendantCastSync"

let sender = null
/** main.js hands over its send (for the pause switch telling RealmScreen to re-sync). */
export function setPartySender(fn) { sender = typeof fn === "function" ? fn : null }

const partyFlag = (doc) => doc?.getFlag?.(MOD, "party") || null
const trailFlag = (doc) => doc?.getFlag?.(MOD, "trail") || null
export const castSyncOn = () => { try { return game.settings.get(MOD, "castSync") !== false } catch { return true } }

function dims(scene) {
  const d = scene.dimensions
  return { x: d.sceneX, y: d.sceneY, w: d.sceneWidth, h: d.sceneHeight, size: d.size || scene.grid?.size || 100 }
}
const toScene = (scene, nx, ny) => {
  const d = dims(scene)
  return [d.x + Math.max(0, Math.min(1, Number(nx) || 0)) * d.w, d.y + Math.max(0, Math.min(1, Number(ny) || 0)) * d.h]
}

// The token's top-left so its CENTRE sits on the map point.
function topLeft(scene, t, wCells, hCells) {
  const d = dims(scene)
  const [cx, cy] = toScene(scene, t.nx, t.ny)
  return { x: Math.round(cx - (wCells * d.size) / 2), y: Math.round(cy - (hCells * d.size) / 2) }
}

/** The token centre back as a 0..1 map fraction. */
export function mapFraction(scene, tokenDoc) {
  const d = dims(scene)
  const cx = tokenDoc.x + ((tokenDoc.width || 1) * d.size) / 2
  const cy = tokenDoc.y + ((tokenDoc.height || 1) * d.size) / 2
  return { nx: (cx - d.x) / d.w, ny: (cy - d.y) / d.h }
}

// A new token's data: the linked actor's own prototype token when there is one, else a stand-in.
async function newTokenData(scene, t, key) {
  const flags = { [MOD]: { party: { key, campaignId: String(t.campaignId || "") } } }
  const actor = t.actorId ? game.actors.get(t.actorId) : null
  if (actor) {
    let data
    try { data = (await actor.getTokenDocument({}, { parent: scene })).toObject() } catch { data = foundry.utils.deepClone(actor.prototypeToken.toObject()) }
    const pos = topLeft(scene, t, data.width || 1, data.height || 1)
    return foundry.utils.mergeObject(data, { ...pos, actorId: actor.id, hidden: !!t.hidden, flags }, { inplace: false })
  }
  return {
    name: String(t.name || "Party"), ...topLeft(scene, t, 1, 1), width: 1, height: 1, hidden: !!t.hidden,
    texture: { src: String(t.src || "icons/svg/mystery-man.svg") },
    disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
    displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
    lockRotation: true,
    flags,
  }
}

/** { sceneId, tokens: [{ key, campaignId, name, nx, ny, src, hidden, actorId? }] } → reconcile. */
export async function syncParty(msg) {
  if (!castSyncOn()) return { paused: true, created: 0, updated: 0, removed: 0 }
  const scene = game.scenes.get(msg.sceneId)
  if (!scene) throw new Error("Scene not found: " + msg.sceneId)
  const want = new Map()
  for (const t of (Array.isArray(msg.tokens) ? msg.tokens : [])) if (t && t.key) want.set(String(t.key), t)
  const have = new Map()
  const stale = [], release = []
  for (const doc of scene.tokens) {
    const f = partyFlag(doc)
    if (!f) continue
    const t = want.get(f.key)
    // Gone from the list, a duplicate, or now (un)linked to a different actor → replace. A token
    // the GM placed (adopted) is never deleted: it is only let go, left where it stands.
    if (!t || have.has(f.key) || (doc.actorId || null) !== (t.actorId && game.actors.get(t.actorId) ? t.actorId : null)) (f.adopted ? release : stale).push(doc.id)
    else have.set(f.key, doc)
  }
  const creates = [], updates = []
  // A character whose actor ALREADY has a token here (one the GM placed by hand) gets THAT token,
  // moved and flagged — never a second copy beside it.
  const adopted = new Set()
  const adoptable = (actorId) => scene.tokens.find(d => d.actorId === actorId && (!partyFlag(d) || release.includes(d.id)) && !adopted.has(d.id) && !stale.includes(d.id))
  for (const [key, t] of want) {
    const doc = have.get(key)
    if (!doc) {
      const own = t.actorId && game.actors.get(t.actorId) ? adoptable(t.actorId) : null
      if (own) {
        adopted.add(own.id)
        updates.push({ _id: own.id, ...topLeft(scene, t, own.width || 1, own.height || 1), hidden: !!t.hidden,
          [`flags.${MOD}.party`]: { key, campaignId: String(t.campaignId || ""), adopted: true } })
        continue
      }
      creates.push(await newTokenData(scene, t, key)); continue
    }
    const pos = topLeft(scene, t, doc.width || 1, doc.height || 1)
    const hidden = !!t.hidden
    const u = { _id: doc.id }
    if (doc.x !== pos.x || doc.y !== pos.y) { u.x = pos.x; u.y = pos.y }
    if (doc.hidden !== hidden) u.hidden = hidden
    if (!doc.actorId) {
      // Stand-ins carry RealmScreen's name and picture; an actor token keeps its own.
      const name = String(t.name || "Party"), src = String(t.src || "icons/svg/mystery-man.svg")
      if (doc.name !== name) u.name = name
      if (doc.texture?.src !== src) u.texture = { src }
    }
    if (Object.keys(u).length > 1) updates.push(u)
  }
  if (stale.length) await scene.deleteEmbeddedDocuments("Token", stale, { [SYNC]: true })
  if (release.length) await scene.updateEmbeddedDocuments("Token", release.map(id => ({ _id: id, [`flags.${MOD}.-=party`]: null })), { [SYNC]: true })
  if (creates.length) await scene.createEmbeddedDocuments("Token", creates, { [SYNC]: true })
  // Placed, not walked: an instant move (no slide). An animated move across the map was refused —
  // the token said "updated" but stayed put (found in the GM's world 2026-10-05, likely walls in the
  // way); the bridge's own token.update, which never animates, moved it fine.
  if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, { [SYNC]: true, animate: false, animation: { duration: 0 }, teleport: true })
  return { created: creates.length, updated: updates.length, removed: stale.length, released: release.length }
}

// ── trails ────────────────────────────────────────────────────
// One open polyline per trail (the road walked so far) + a small disc per finished day.
const TRAIL_COLOR = "#e8c170"
function polyDrawing(scene, pts, key, sig, hidden) {
  const sp = pts.map(([u, v]) => toScene(scene, u, v))
  const xs = sp.map(p => p[0]), ys = sp.map(p => p[1])
  const x0 = Math.min(...xs), y0 = Math.min(...ys)
  return {
    x: x0, y: y0, hidden,
    shape: { type: "p", width: Math.max(1, Math.max(...xs) - x0), height: Math.max(1, Math.max(...ys) - y0), points: sp.flatMap(([x, y]) => [x - x0, y - y0]) },
    strokeWidth: 6, strokeColor: TRAIL_COLOR, strokeAlpha: 0.85, fillType: 0, bezierFactor: 0, sort: -50, locked: true,
    flags: { [MOD]: { trail: { key, sig } } },
  }
}
function markDrawing(scene, [u, v], key, sig, hidden) {
  const [x, y] = toScene(scene, u, v), r = 9
  return {
    x: x - r, y: y - r, hidden,
    shape: { type: "e", width: r * 2, height: r * 2 },
    strokeWidth: 2, strokeColor: "#2b2118", strokeAlpha: 0.9, fillType: 1, fillColor: TRAIL_COLOR, fillAlpha: 0.95, sort: -49, locked: true,
    flags: { [MOD]: { trail: { key, sig, mark: true } } },
  }
}

/** { sceneId, trails: [{ key, points: [[nx, ny]…], marks: [[nx, ny]…], hidden }] } → reconcile Drawings. */
export async function syncTrails(msg) {
  if (!castSyncOn()) return { paused: true }
  const scene = game.scenes.get(msg.sceneId)
  if (!scene) throw new Error("Scene not found: " + msg.sceneId)
  const want = new Map()
  for (const t of (Array.isArray(msg.trails) ? msg.trails : [])) {
    if (t && t.key && Array.isArray(t.points) && t.points.length >= 2) want.set(String(t.key), { ...t, sig: JSON.stringify([t.points, t.marks || [], !!t.hidden]) })
  }
  const stale = [], kept = new Set()
  for (const d of scene.drawings) {
    const f = trailFlag(d)
    if (!f) continue
    const t = want.get(f.key)
    if (t && t.sig === f.sig) kept.add(f.key); else stale.push(d.id)
  }
  const creates = []
  for (const [key, t] of want) {
    if (kept.has(key)) continue
    creates.push(polyDrawing(scene, t.points, key, t.sig, !!t.hidden))
    for (const m of (t.marks || [])) creates.push(markDrawing(scene, m, key, t.sig, !!t.hidden))
  }
  if (stale.length) await scene.deleteEmbeddedDocuments("Drawing", stale)
  if (creates.length) await scene.createEmbeddedDocuments("Drawing", creates)
  return { created: creates.length, removed: stale.length }
}

/**
 * main.js registers this on `updateToken`: one of these tokens moved by hand (not by a
 * sync) → tell RealmScreen where it was dropped. `send` is the bridge's send.
 */
export function partyMovedHook(send) {
  return (doc, changes, options) => {
    if (options?.[SYNC] || !castSyncOn()) return
    if (!("x" in (changes || {})) && !("y" in (changes || {}))) return
    const f = partyFlag(doc)
    const scene = doc.parent
    if (!f || !scene) return
    const { nx, ny } = mapFraction(scene, { x: changes.x ?? doc.x, y: changes.y ?? doc.y, width: doc.width, height: doc.height })
    send({ type: "party.moved", sceneId: scene.id, key: f.key, campaignId: f.campaignId, nx, ny })
  }
}

// ── the GM's pause switch (Token controls) ─────────────────────
Hooks.once("init", () => {
  game.settings.register(MOD, "castSync", {
    scope: "world", config: false, type: Boolean, default: true,
    onChange: (on) => {
      try { ui.controls?.render?.() } catch { /* */ }
      // RealmScreen shows the switch's state (Settings › Connections); back on → it puts everyone
      // back where it has them.
      sender?.({ type: "party.switched", on: !!on, by: game.user?.name || null })
      if (on && game.user?.isGM) sender?.({ type: "party.resync" })
    },
  })
})

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return
  const title = "RealmScreen moves people (off: move tokens freely)"
  const icon = "fa-solid fa-route"
  const onToggle = (active) => { game.settings.set(MOD, "castSync", !!active) }
  // V13+: controls is an object keyed by control name, tools an object keyed by tool name.
  if (!Array.isArray(controls)) {
    const tokens = controls?.tokens
    if (!tokens?.tools) return
    tokens.tools[TOOL] = {
      name: TOOL, title, icon, order: Object.keys(tokens.tools).length + 1,
      toggle: true, active: castSyncOn(),
      onChange: (_event, active) => onToggle(active),
    }
    return
  }
  // V11–V12: an array of controls, each with a tools array.
  const tokens = controls.find(c => c.name === "token")
  if (!tokens) return
  tokens.tools.push({ name: TOOL, title, icon, toggle: true, active: castSyncOn(), onClick: (active) => onToggle(active) })
})

/** `party.switch { on? }` — read the GM's pause switch, or set it from RealmScreen. → { on } */
export async function partySwitch(msg) {
  if (typeof msg.on === "boolean" && game.user?.isGM) await game.settings.set(MOD, "castSync", msg.on)
  return { on: castSyncOn() }
}
