// ──────────────────────────────────────────────────────────────
// RealmScreen's CARAVANS on the overland scene (pendant-home lib/caravans.mjs; the user 2026-11-17: a crew +
// cargo on a route of towns that repeats forever, "real tokens").
//
// RealmScreen sends `caravan.sync { sceneId, caravans: [...] }` — the FULL list for that scene:
//   { id, name, src (the cart picture, already turned to face DOWN — Foundry's auto-rotate assumes that),
//     aspect (picture length ÷ width), roadW (map units: AS WIDE AS ITS ROAD — the user, 2026-11-17), nx, ny (0..1),
//     rotation (deg, art-down),
//     hidden, crew, cargo, doing, track: [[nx,ny]…] | null (the road it drove since the last sync) }
// Here, GM only:
//   • one ACTOR per caravan (dnd5e: a vehicle; else an npc), in an Actors folder "RealmScreen caravans",
//     its crew + cargo in the biography (and the vehicle's crew list where the system has one)
//   • one TOKEN per caravan on that scene, linked to the actor — long and narrow like the picture
//   • with a track (V13+ TokenDocument#move): the real token DRIVES that road, walls ignored, turning to face
//     the way it goes; without one (a big jump, an older Foundry) it is just put there, facing `rotation`
//   • caravans no longer sent are removed from the scene (their actors stay; deleting a caravan in
//     RealmScreen sends `remove` to delete the actor too)
// Hover a caravan token: a small card — name, crew, cargo, what it is doing.
// ──────────────────────────────────────────────────────────────

import { unitPx, placeOptions } from "./party.js"

const MOD = "pendant-bridge"
const SYNC = "pendantCaravanSync"
const FOLDER = "RealmScreen caravans"
const flagOf = (doc) => doc?.getFlag?.(MOD, "caravan") || null
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

function dims(scene) {
  const d = scene.dimensions
  return { x: d.sceneX, y: d.sceneY, w: d.sceneWidth, h: d.sceneHeight, size: d.size || scene.grid?.size || 100 }
}
const toScene = (scene, nx, ny) => {
  const d = dims(scene)
  return [d.x + Math.max(0, Math.min(1, Number(nx) || 0)) * d.w, d.y + Math.max(0, Math.min(1, Number(ny) || 0)) * d.h]
}

/**
 * The token's size: as wide as its road (`acrossPx`, scene px — sized like the Realm layer's roads), as long as
 * the picture makes it. Foundry keeps a token at least half a cell each way, so a small one is a bigger token
 * whose picture is scaled down (texture scale). The picture faces down: width = across, height = along.
 * → { width, height, scale }
 */
export function caravanSize(acrossPx, aspect, cell) {
  const a = Math.max(1, Number(aspect) || 3)
  const across = Math.max(0.01, acrossPx) / cell, along = across * a
  const k = across >= 0.5 ? 1 : 0.5 / across            // grow both until the narrow side is half a cell
  const width = Math.round(across * k * 100) / 100, height = Math.round(along * k * 100) / 100
  return { width, height, scale: Math.round((1 / k) * 1000) / 1000 }
}
// The token's top-left so its CENTRE sits on the map point.
const topLeft = (scene, nx, ny, w, h) => {
  const d = dims(scene), [cx, cy] = toScene(scene, nx, ny)
  return { x: Math.round(cx - (w * d.size) / 2), y: Math.round(cy - (h * d.size) / 2) }
}

function actorType() {
  const types = new Set([...Object.keys(CONFIG.Actor?.dataModels || {}), ...Object.keys(game.system?.documentTypes?.Actor || {})])
  return types.has("vehicle") ? "vehicle" : types.has("npc") ? "npc" : [...types].find(t => t !== "base") || "base"
}
async function folderId() {
  const f = game.folders?.find(x => x.type === "Actor" && x.name === FOLDER)
  if (f) return f.id
  try { return (await Folder.create({ name: FOLDER, type: "Actor" }))?.id || null } catch { return null }
}
const bioOf = (c) => {
  const cargo = String(c.cargo || "").split("\n").map(s => s.trim()).filter(Boolean)
  return `<p><strong>Crew:</strong> ${Number(c.crew) || 0}</p>${cargo.length ? `<p><strong>Cargo:</strong></p><ul>${cargo.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}<p><em>A RealmScreen caravan — its route and stops are set in RealmScreen.</em></p>`
}

async function actorFor(c, size) {
  let a = game.actors?.find(x => flagOf(x)?.id === c.id) || null
  const proto = { actorLink: true, "texture.src": c.src, width: size.width, height: size.height, lockRotation: false,
    displayName: CONST.TOKEN_DISPLAY_MODES.HOVER, disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL }
  if (!a) {
    const type = actorType()
    a = await Actor.create({
      name: c.name || "Caravan", type, img: c.src, folder: await folderId(),
      flags: { [MOD]: { caravan: { id: c.id } } },
      prototypeToken: { actorLink: true, texture: { src: c.src }, width: size.width, height: size.height, lockRotation: false,
        displayName: CONST.TOKEN_DISPLAY_MODES.HOVER, disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL },
    })
    if (!a) return null
  }
  const u = {}
  if (a.name !== (c.name || "Caravan")) u.name = c.name || "Caravan"
  if (a.img !== c.src) u.img = c.src
  const bio = bioOf(c)
  if (foundry.utils.getProperty(a, "system.details.biography.value") !== bio && foundry.utils.hasProperty(a, "system.details.biography")) u["system.details.biography.value"] = bio
  if (a.prototypeToken?.texture?.src !== c.src || a.prototypeToken?.width !== size.width) for (const [k, v] of Object.entries(proto)) u[`prototypeToken.${k}`] = v
  if (Object.keys(u).length) { try { await a.update(u) } catch (e) { console.warn("[pendant-bridge] caravan actor", e) } }
  // dnd5e vehicles keep a crew list: one line, "Crew × n".
  if (a.type === "vehicle" && foundry.utils.hasProperty(a, "system.cargo.crew")) {
    const want = [{ name: "Crew", quantity: Math.max(0, Number(c.crew) || 0) }]
    const have = foundry.utils.getProperty(a, "system.cargo.crew") || []
    if (have.length !== 1 || have[0]?.quantity !== want[0].quantity) { try { await a.update({ "system.cargo.crew": want }) } catch { /* another system shape */ } }
  }
  return a
}

/** { sceneId, caravans, remove? } → reconcile that scene's caravan tokens (GM only). */
export async function syncCaravans(msg) {
  if (!game.user?.isGM) return { skipped: "not GM" }
  const scene = game.scenes?.get(msg?.sceneId)
  if (!scene) return { skipped: "no scene" }
  const want = new Map((Array.isArray(msg.caravans) ? msg.caravans : []).filter(c => c && c.id && c.src).map(c => [String(c.id), c]))
  const cell = dims(scene).size, u = unitPx(scene)
  const tokens = scene.tokens.filter(t => flagOf(t))
  const stale = tokens.filter(t => !want.has(String(flagOf(t).id))).map(t => t.id)
  if (stale.length) await scene.deleteEmbeddedDocuments("Token", stale, { [SYNC]: true })
  let created = 0, moved = 0, placed = 0
  for (const [id, c] of want) {
    const size = caravanSize((Number(c.roadW) || 2.5) * u, c.aspect, cell)
    const actor = await actorFor(c, size)
    if (!actor) continue
    const pos = topLeft(scene, c.nx, c.ny, size.width, size.height)
    const cflag = { id, crew: Number(c.crew) || 0, cargo: String(c.cargo || ""), doing: String(c.doing || "") }
    const doc = tokens.find(t => String(flagOf(t).id) === id)
    if (!doc) {
      await scene.createEmbeddedDocuments("Token", [{
        name: c.name || "Caravan", actorId: actor.id, actorLink: true, ...pos, width: size.width, height: size.height,
        texture: { src: c.src, scaleX: size.scale, scaleY: size.scale }, rotation: Number(c.rotation) || 0, lockRotation: false,
        hidden: !!c.hidden, displayName: CONST.TOKEN_DISPLAY_MODES.HOVER, disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
        flags: { [MOD]: { caravan: cflag } },
      }], { [SYNC]: true })
      created++
      continue
    }
    // Look, size, hidden, the card's words — never animated.
    const look = {}
    if (doc.texture?.src !== c.src) look["texture.src"] = c.src
    if (doc.width !== size.width || doc.height !== size.height) { look.width = size.width; look.height = size.height }
    if (doc.texture?.scaleX !== size.scale) { look["texture.scaleX"] = size.scale; look["texture.scaleY"] = size.scale }
    if (!!doc.hidden !== !!c.hidden) look.hidden = !!c.hidden
    if (doc.name !== (c.name || "Caravan")) look.name = c.name || "Caravan"
    const f = flagOf(doc)
    if (f.crew !== cflag.crew || f.cargo !== cflag.cargo || f.doing !== cflag.doing) look[`flags.${MOD}.caravan`] = cflag
    if (Object.keys(look).length) await doc.update(look, { [SYNC]: true, animate: false })
    if (doc.x === pos.x && doc.y === pos.y) continue
    // Drive the road it went (V13+), or just be there.
    const track = Array.isArray(c.track) && c.track.length >= 2 ? c.track : null
    if (track && typeof doc.move === "function") {
      const pts = track.slice(1).map(([nx, ny]) => topLeft(scene, nx, ny, size.width, size.height))
      const ms = Math.max(900, Math.min(4000, 400 * pts.length + 900))
      doc.move(pts, { autoRotate: true, showRuler: false, method: "api", constrainOptions: { ignoreWalls: true, ignoreCost: true },
        animation: { duration: ms }, [SYNC]: true }).catch((e) => console.warn("[pendant-bridge] caravan move", e))
      moved++
    } else {
      await doc.update({ ...pos, rotation: Number(c.rotation) || 0 }, { [SYNC]: true, animate: false, animation: { duration: 0 }, ...placeOptions(scene, [{ _id: doc.id, ...pos }]) })
      placed++
    }
  }
  // A caravan deleted in RealmScreen: its actor goes too.
  const gone = (Array.isArray(msg.remove) ? msg.remove : []).map(String)
  const actors = game.actors?.filter(a => gone.includes(String(flagOf(a)?.id))) || []
  if (actors.length) await Actor.deleteDocuments(actors.map(a => a.id))
  return { created, moved, placed, removed: stale.length, actorsRemoved: actors.length }
}

// ── hover card ────────────────────────────────────────────────
let tip = null
function tipEl() {
  if (tip?.isConnected) return tip
  tip = document.createElement("div")
  tip.className = "pb-realm-tip pb-caravan-tip"; tip.hidden = true
  document.body.appendChild(tip)
  return tip
}
Hooks.on("hoverToken", (token, hovered) => {
  const f = flagOf(token?.document)
  const el = tipEl()
  if (!hovered || !f) { el.hidden = true; return }
  const cargo = String(f.cargo || "").split("\n").map(s => s.trim()).filter(Boolean).join(", ")
  el.replaceChildren()
  const b = document.createElement("strong"); b.textContent = token.document.name || "Caravan"; el.append(b)
  for (const line of [`Crew ${f.crew || 0}${cargo ? ` · ${cargo}` : ""}`, f.doing]) {
    if (!line) continue
    const s = document.createElement("span"); s.textContent = line; el.append(s)
  }
  const r = token.bounds, p = canvas.stage.worldTransform.apply({ x: r.right, y: r.top })
  const box = canvas.app.view.getBoundingClientRect()
  el.style.left = `${box.left + p.x + 10}px`; el.style.top = `${box.top + p.y}px`
  el.hidden = false
})
Hooks.on("canvasTearDown", () => { if (tip) tip.hidden = true })
