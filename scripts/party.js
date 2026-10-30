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
//                      A token with `group` (a campaign's linked PCs standing together) is a
//                      real dnd5e Group actor (`flags.pendant-bridge.partyGroup`), one per
//                      spot, members kept to RealmScreen's list in the GM's own order.
//                      Members added / removed on its sheet by hand are reported as
//                      `party.groupEdited` (RealmScreen offers the change) and put back.
//   • `party.trails` — the road already walked by travelling parties / PCs, with a
//                      mark where each travel day ended, as Drawings
//                      (`flags.pendant-bridge.trail = key`), visible to everyone.
//
// Positions are 0..1 fractions of the map image, as `settlement.push` uses.
//
// Every date / hour change RealmScreen sends puts everyone where it has them. What a drag does is the GM's
// "Plan a trip" switch (scripts/trips.js): off = tokens move freely until Resync or the next change; on = a
// trip card, priced and written by RealmScreen. Moves this file makes itself are tagged (SYNC) so they never
// read as a drag. (The 2026-10-04 pause switch and `party.moved` notes were replaced 2026-10-30.)
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
const SYNC = "pendantPartySync"          // update option on our own writes

let sender = null
/** main.js hands over its send (for the pause switch telling RealmScreen to re-sync). */
export function setPartySender(fn) { sender = typeof fn === "function" ? fn : null }

const partyFlag = (doc) => doc?.getFlag?.(MOD, "party") || null
const trailFlag = (doc) => doc?.getFlag?.(MOD, "trail") || null

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

// ── party Group actors ────────────────────────────────────────
const groupFlag = (a) => a?.getFlag?.(MOD, "partyGroup") || null
const groupsSupported = () => !!(CONFIG.Actor?.dataModels?.group || game.system?.documentTypes?.Actor?.group)
const memberIds = (g) => (g.system?.toObject?.().members ?? []).map(m => m.actor).filter(Boolean)
const FOLDER = "RealmScreen parties"

async function partyFolder() {
  const have = game.folders.find(f => f.type === "Actor" && f.getFlag?.(MOD, "partyFolder"))
  if (have) return have.id
  try { return (await Folder.create({ name: FOLDER, type: "Actor", flags: { [MOD]: { partyFolder: true } } }))?.id ?? null } catch { return null }
}

// Players who own a member can open the group (see its sheet, pull tokens out).
function ownershipFor(ids) {
  const own = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE }
  for (const id of ids) {
    const a = game.actors.get(id)
    for (const u of game.users) if (!u.isGM && a?.testUserPermission?.(u, "OWNER")) own[u.id] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER
  }
  return own
}

/**
 * The Group actor a `group` token stands for: the one already holding this key, else another
 * of this campaign's that this sync doesn't need, else a new one. Members are set to `want`,
 * keeping the order the GM gave them (the pile order of the token art). → actor id, or null.
 */
async function ensureGroup(t, used) {
  if (!groupsSupported()) return null
  const cid = String(t.campaignId || "")
  const want = (t.group.members || []).map(String).filter(id => game.actors.get(id))
  if (!want.length) return null
  const mine = game.actors.filter(a => a.type === "group" && groupFlag(a)?.campaignId === cid && !used.has(a.id))
  let g = mine.find(a => groupFlag(a).key === t.key) || mine[0] || null
  const name = String(t.name || "Party")
  if (!g) {
    g = await Actor.create({
      name, type: "group", folder: await partyFolder(),
      ...(t.group.img ? { img: String(t.group.img) } : {}),
      ownership: ownershipFor(want),
      prototypeToken: { actorLink: true, disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY, displayName: CONST.TOKEN_DISPLAY_MODES.HOVER, lockRotation: true },
      system: { members: want.map(actor => ({ actor })) },
      flags: { [MOD]: { partyGroup: { key: t.key, campaignId: cid, want } } },
    }, { [SYNC]: true })
    used.add(g.id)
    return g.id
  }
  used.add(g.id)
  const cur = memberIds(g)
  const next = [...cur.filter(id => want.includes(id)), ...want.filter(id => !cur.includes(id))]
  const f = groupFlag(g)
  const u = {}
  if (next.join() !== cur.join()) u["system.members"] = next.map(actor => ({ actor }))
  if (g.name !== name) u.name = name
  if (f.key !== t.key || (f.want || []).join() !== want.join()) u[`flags.${MOD}.partyGroup`] = { key: t.key, campaignId: cid, want }
  const own = ownershipFor(want)
  for (const [k, v] of Object.entries(own)) if (k !== "default" && (g.ownership?.[k] ?? 0) < v) u[`ownership.${k}`] = v
  if (Object.keys(u).length) await g.update(u, { [SYNC]: true })
  return g.id
}

// A party group's members changed on its sheet by hand (not by a sync): RealmScreen decides who
// is in a campaign, so tell it what the GM did (it offers the change) and put the list back.
// Reordering is the GM's own business and stays.
Hooks.on("updateActor", (actor, change, options) => {
  if (options?.[SYNC] || !foundry.utils.hasProperty(change, "system.members")) return
  const f = groupFlag(actor)
  if (!f || !game.user?.isGM || (game.users?.activeGM && !game.users.activeGM.isSelf)) return
  const now = memberIds(actor), want = f.want || []
  const added = now.filter(id => !want.includes(id)), removed = want.filter(id => !now.includes(id))
  if (!added.length && !removed.length) return
  sender?.({ type: "party.groupEdited", key: f.key, campaignId: f.campaignId, added, removed, by: game.user?.name || null })
  const back = [...now.filter(id => want.includes(id)), ...removed]
  actor.update({ "system.members": back.map(a => ({ actor: a })) }, { [SYNC]: true })
  ui.notifications?.info(`${actor.name}: RealmScreen keeps who is in the party — the change is waiting there for you to accept.`)
})

/** { sceneId, tokens: [{ key, campaignId, name, nx, ny, src, hidden, actorId? }] } → reconcile. */
export async function syncParty(msg) {
  const scene = game.scenes.get(msg.sceneId)
  if (!scene) throw new Error("Scene not found: " + msg.sceneId)
  const want = new Map()
  for (const t of (Array.isArray(msg.tokens) ? msg.tokens : [])) if (t && t.key) want.set(String(t.key), t)
  // Party groups first: each becomes (or reuses) a Group actor, and its token is that actor's.
  const used = new Set()
  for (const [key, t] of want) {
    if (!t.group) continue
    const id = await ensureGroup({ ...t, key }, used).catch(e => { console.warn(`[${MOD}] party group`, e); return null })
    want.set(key, id ? { ...t, actorId: id } : { ...t, src: t.src || t.group.img })
  }
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

/** `party.switch` — RealmScreen asks how a drag behaves here. → { on, planTrips } (the old pause switch is gone) */
export function partySwitch() {
  let planTrips = false
  try { planTrips = game.settings.get(MOD, "planTrips") === true } catch { /* not registered yet */ }
  return { on: true, planTrips }
}

/** `party.groups` — can this world hold party Group actors? (dnd5e Group type present) → { groups } */
export function partyGroups() { return { groups: groupsSupported() } }
