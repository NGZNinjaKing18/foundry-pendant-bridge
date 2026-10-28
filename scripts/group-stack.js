// ──────────────────────────────────────────────────────────────
// dnd5e Group (and Encounter) actors as one stacked token.
//
//   • Stack art — the group's token picture is drawn from its members' own
//     token art, piled on top of each other. The member list order is the pile
//     order: the first member sits on top, in front. Redrawn whenever the
//     members, their order or their token art change. The active GM draws it,
//     uploads it to worlds/<world>/group-tokens/, and points the prototype
//     token (and every placed token still showing the old picture) at it.
//     Giving the group a picture of your own turns stack art off for it; the
//     sheet's "Stack art" box turns it back on.
//   • Sheet — the Members tab gets a "Token stack" strip: drag a face to change
//     the order (left = on top). The order is `system.members` itself, so it
//     is also the order dnd5e's own lists and "Place members" use.
//   • Right-click — the Token HUD of a group token fans its members out around
//     it. Drag a face onto the map to pull that person out as their own token
//     (Foundry's normal actor drop). They stay in the group; faces of members
//     already on this scene are dimmed.
//
// Native-first: render hooks on dnd5e's sheet and Foundry's TokenHUD, no
// replaced classes.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
const FLAG = "groupStack"                 // actor flag { sig, file, off }
const OURS = "pendantGroupStack"          // update option on our own writes
const LAYOUT_V = 1                        // bump to redraw every stack
const SIZE = 512
const MAX_SHOWN = 6

const isGroup = (a) => a?.type === "group" || a?.type === "encounter"

// ── pure helpers (tested) ─────────────────────────────────────

/**
 * Where each member sits in the picture. Index 0 is the top of the pile (front,
 * centre); the rest step back left and right, a little higher and smaller.
 * Returns centres and diameters in pixels of a `size` square.
 */
export function stackLayout(n, size = SIZE) {
  const k = Math.min(Math.max(0, n | 0), MAX_SHOWN)
  if (!k) return []
  const pts = []
  for (let i = 0; i < k; i++) {
    const r = Math.ceil(i / 2)
    const side = i === 0 ? 0 : (i % 2 ? -1 : 1)
    pts.push({ x: side * r * 0.2, y: -r * 0.09, s: 1 - r * 0.1 })
  }
  const minX = Math.min(...pts.map(p => p.x - p.s / 2)), maxX = Math.max(...pts.map(p => p.x + p.s / 2))
  const minY = Math.min(...pts.map(p => p.y - p.s / 2)), maxY = Math.max(...pts.map(p => p.y + p.s / 2))
  const scale = 0.98 / Math.max(maxX - minX, maxY - minY)
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  return pts.map(p => ({
    x: Math.round((p.x - cx) * scale * size + size / 2),
    y: Math.round((p.y - cy) * scale * size + size / 2),
    d: Math.round(p.s * scale * size),
  }))
}

/** A short stable hash of what the picture is drawn from. */
export function stackSig(parts) {
  const s = LAYOUT_V + "|" + parts.join("|")
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}

/** `arr` with the item at `from` moved to `to`. */
export function moveItem(arr, from, to) {
  const out = arr.slice()
  if (from < 0 || from >= out.length) return out
  const [it] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(out.length, to)), 0, it)
  return out
}

/**
 * Where each face sits in the right-click fan: rings of up to `perRing` over
 * the top of the token (120° wide at most, clear of the HUD's side columns),
 * each extra ring further out. Angle in degrees, 0 = right, −90 = up.
 */
export function fanSpots(n, perRing = 6, step = 24) {
  const out = []
  for (let i = 0; i < n; i++) {
    const ring = Math.floor(i / perRing)
    const inRing = Math.min(perRing, n - ring * perRing)
    const j = i - ring * perRing
    const span = step * (inRing - 1)
    out.push({ angle: inRing === 1 ? -90 : -90 - span / 2 + (span * j) / (inRing - 1), ring })
  }
  return out
}

// ── member art ────────────────────────────────────────────────

/** The picture a member's token shows (ring subject when it has a ring). */
function tokenArt(actor) {
  const pt = actor?.prototypeToken
  const ring = !!pt?.ring?.enabled
  let src = (ring && pt?.ring?.subject?.texture) || pt?.texture?.src || ""
  if (!src || src.includes("*")) src = actor?.img || ""
  return { src, ring }
}

async function membersOf(group) {
  try { return ((await group.system.getMembers?.()) || []).filter(m => m.actor) } catch { return [] }
}

function filePicker() {
  return foundry?.applications?.apps?.FilePicker?.implementation ?? foundry?.applications?.apps?.FilePicker ?? globalThis.FilePicker
}

async function loadBitmap(src) {
  const res = await fetch(src)
  if (!res.ok) throw new Error(res.status + " " + src)
  return createImageBitmap(await res.blob())
}

async function drawStack(arts, total) {
  const cv = document.createElement("canvas")
  cv.width = cv.height = SIZE
  const g = cv.getContext("2d")
  const spots = stackLayout(arts.length)
  // Back of the pile first, so member 0 lands on top.
  for (let i = spots.length - 1; i >= 0; i--) {
    const { x, y, d } = spots[i]
    const art = arts[i]
    let bmp
    try { bmp = await loadBitmap(art.src) } catch { continue }
    const k = Math.min(d / bmp.width, d / bmp.height)
    const w = bmp.width * k, h = bmp.height * k
    g.save()
    if (art.ring) { g.beginPath(); g.arc(x, y, d / 2, 0, Math.PI * 2); g.clip() }
    g.shadowColor = "rgba(0,0,0,0.45)"; g.shadowBlur = SIZE * 0.025; g.shadowOffsetY = SIZE * 0.008
    g.drawImage(bmp, x - w / 2, y - h / 2, w, h)
    g.restore()
    bmp.close?.()
  }
  const extra = total - arts.length
  if (extra > 0) {
    const r = SIZE * 0.1, x = SIZE - r - 6, y = SIZE - r - 6
    g.fillStyle = "rgba(20,20,26,0.85)"; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill()
    g.lineWidth = 4; g.strokeStyle = "rgba(255,255,255,0.8)"; g.stroke()
    g.fillStyle = "#fff"; g.font = `600 ${Math.round(r * 0.9)}px sans-serif`
    g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("+" + extra, x, y + 1)
  }
  return new Promise((ok, no) => cv.toBlob(b => (b ? ok(b) : no(new Error("toBlob failed"))), "image/webp", 0.9))
}

// ── stack art upkeep (active GM only) ─────────────────────────

const amWriter = () => !!game.user?.isGM && (game.users?.activeGM ? game.users.activeGM.isSelf : true)
const timers = new Map()
const busy = new Set()

function queue(group, force = false) {
  if (!amWriter() || !isGroup(group)) return
  clearTimeout(timers.get(group.id))
  timers.set(group.id, setTimeout(() => { timers.delete(group.id); rebuild(group, force) }, 400))
}

export async function rebuild(group, force = false) {
  if (busy.has(group.id)) { queue(group, force); return }
  const flag = group.getFlag(MOD, FLAG) || {}
  if (flag.off) return
  const members = await membersOf(group)
  if (!members.length) return
  const arts = members.slice(0, MAX_SHOWN).map(m => tokenArt(m.actor))
  const sig = stackSig([String(members.length), ...arts.map(a => a.src + (a.ring ? "@r" : ""))])
  const current = group.prototypeToken?.texture?.src || ""
  if (!force && flag.sig === sig && flag.file && current === flag.file) return
  busy.add(group.id)
  try {
    const blob = await drawStack(arts, members.length)
    const FP = filePicker()
    const folder = `worlds/${game.world.id}/group-tokens`
    for (const p of [`worlds/${game.world.id}`, folder]) { try { await FP.createDirectory("data", p, {}) } catch { /* exists */ } }
    const name = `${group.id}-${sig}.webp`
    const res = await FP.upload("data", folder, new File([blob], name, { type: "image/webp" }), {}, { notify: false })
    const path = res?.path
    if (!path) throw new Error("upload refused")
    // Placed tokens still showing the old picture follow along; ones given art of their own keep it.
    const old = new Set([current, flag.file].filter(Boolean))
    await group.update({ "prototypeToken.texture.src": path, [`flags.${MOD}.${FLAG}`]: { sig, file: path, off: false } }, { [OURS]: true })
    for (const scene of game.scenes) {
      const ups = scene.tokens.filter(t => t.actorId === group.id && old.has(t.texture?.src)).map(t => ({ _id: t.id, "texture.src": path }))
      if (ups.length) await scene.updateEmbeddedDocuments("Token", ups, { [OURS]: true })
    }
  } catch (e) {
    console.warn(`[${MOD}] group stack art for ${group.name} failed`, e)
  } finally { busy.delete(group.id) }
}

Hooks.on("updateActor", (actor, change, options) => {
  if (options?.[OURS]) return
  if (isGroup(actor)) {
    // A picture of the GM's own choosing switches stack art off for this group.
    const src = foundry.utils.getProperty(change, "prototypeToken.texture.src")
    const flag = actor.getFlag(MOD, FLAG) || {}
    if (src !== undefined && src !== flag.file && amWriter() && !flag.off) {
      actor.update({ [`flags.${MOD}.${FLAG}.off`]: true }, { [OURS]: true })
      return
    }
    if (foundry.utils.hasProperty(change, "system.members") || foundry.utils.hasProperty(change, `flags.${MOD}.${FLAG}.off`)) queue(actor)
    return
  }
  if (!("img" in change) && !("prototypeToken" in change)) return
  for (const g of game.actors) {
    if (isGroup(g) && JSON.stringify(g.system.toObject().members ?? []).includes(actor.id)) queue(g)
  }
})
Hooks.on("createActor", (actor) => { if (isGroup(actor)) queue(actor) })
Hooks.once("ready", () => { for (const g of game.actors) if (isGroup(g)) queue(g) })

// ── sheet: the "Token stack" strip ────────────────────────────

function el(tag, cls, attrs = {}) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}

Hooks.on("renderActorSheetV2", async (app, html) => {
  const group = app.document
  if (!isGroup(group)) return
  const root = html instanceof HTMLElement ? html : html?.[0]
  const part = root?.querySelector?.("[data-application-part=members]")
  if (!part) return
  const members = await membersOf(group)
  const order = new Map(members.map((m, i) => [m.actor.uuid, i]))

  // dnd5e lists members by name; show them in pile order instead.
  for (const list of part.querySelectorAll("menu.members, ol.members, ul.members")) {
    const rows = [...list.querySelectorAll(":scope > .member[data-uuid]")]
    rows.sort((a, b) => (order.get(a.dataset.uuid) ?? 1e9) - (order.get(b.dataset.uuid) ?? 1e9)).forEach(r => list.append(r))
  }

  part.querySelector(".pb-gstack")?.remove()
  if (!app.isEditable || !members.length) return
  const host = part.querySelector(":scope > section") || part
  const strip = el("div", "pb-gstack")
  const head = el("div", "pb-gstack-head")
  const title = el("span", "pb-gstack-title"); title.textContent = "Token stack"
  const hint = el("span", "pb-gstack-hint"); hint.textContent = "Drag to reorder — first is on top"
  const off = !!group.getFlag(MOD, FLAG)?.off
  const toggle = el("label", "pb-gstack-toggle", { "data-tooltip": "Draw this group's token from its members' tokens" })
  const box = el("input", "", { type: "checkbox" }); box.checked = !off
  toggle.append(box, document.createTextNode(" Stack art"))
  box.addEventListener("change", (ev) => {
    ev.stopPropagation()
    group.update({ [`flags.${MOD}.${FLAG}.off`]: !box.checked })   // the updateActor hook redraws when it goes back on
  })
  head.append(title, hint, toggle)

  const row = el("ol", "pb-gstack-row")
  members.forEach((m, i) => {
    const li = el("li", "pb-gstack-face", { draggable: "true", "data-index": String(i), "data-tooltip": m.actor.name })
    const img = el("img", "", { src: tokenArt(m.actor).src, alt: m.actor.name })
    img.draggable = false
    li.append(img)
    row.append(li)
  })
  let from = -1
  row.addEventListener("dragstart", (ev) => {
    const li = ev.target.closest?.(".pb-gstack-face"); if (!li) return
    ev.stopPropagation()
    from = Number(li.dataset.index)
    ev.dataTransfer.effectAllowed = "move"
    ev.dataTransfer.setData("application/x-pendant-gstack", String(from))
    li.classList.add("dragging")
  })
  row.addEventListener("dragover", (ev) => {
    if (from < 0) return
    ev.preventDefault(); ev.stopPropagation()
    const li = ev.target.closest?.(".pb-gstack-face")
    row.querySelectorAll(".drop-before,.drop-after").forEach(x => x.classList.remove("drop-before", "drop-after"))
    if (!li) return
    const r = li.getBoundingClientRect()
    li.classList.add(ev.clientX < r.left + r.width / 2 ? "drop-before" : "drop-after")
  })
  row.addEventListener("dragend", () => { from = -1; row.querySelectorAll(".dragging,.drop-before,.drop-after").forEach(x => x.classList.remove("dragging", "drop-before", "drop-after")) })
  row.addEventListener("drop", (ev) => {
    if (from < 0) return
    ev.preventDefault(); ev.stopPropagation()
    const li = ev.target.closest?.(".pb-gstack-face")
    if (!li) return
    const r = li.getBoundingClientRect()
    let to = Number(li.dataset.index) + (ev.clientX < r.left + r.width / 2 ? 0 : 1)
    if (to > from) to -= 1
    const src = from; from = -1
    if (to === src) return
    // Resolved members line up with the stored list (dnd5e drops dangling refs); reorder the stored one.
    const raw = group.system.toObject().members ?? []
    const live = new Set(members.map(m => m.actor.id))
    const keyOf = (m) => m.actor ?? (m.uuid ? m.uuid.split(".").pop() : null)
    const kept = raw.filter(m => live.has(keyOf(m)))
    const gone = raw.filter(m => !live.has(keyOf(m)))
    group.update({ "system.members": [...moveItem(kept, src, to), ...gone] })
  })
  strip.append(head, row)
  host.querySelector(":scope > h3") ? host.querySelector(":scope > h3").after(strip) : host.prepend(strip)
})

// ── Token HUD: fan the members out, drag one onto the map ─────
// Other modules add their buttons in their own renderTokenHUD hooks, possibly
// after ours, so the fold runs again on the next frame.

// A group token keeps only visibility, elevation, sort, lock and settings in
// view; every other HUD button (status effects, movement mode, target, combat,
// other modules' buttons) folds behind one ⋯ button. Group tokens only.
const KEEP = new Set(["visibility", "sort", "locked", "config"])
const foldable = (root) => [...root.querySelectorAll(".col.left .control-icon, .col.right .control-icon")]
  .filter(b => b.tagName !== "INPUT" && !b.closest(".elevation, .palette") && !b.classList.contains("pb-gfold-more") && !KEEP.has(b.dataset.action))
let foldOpen = false

function foldButtons(root) {
  const hidden = foldable(root)
  if (!hidden.length) return
  hidden.forEach(b => b.classList.add("pb-gfold"))
  const more = el("button", "control-icon pb-gfold-more", { type: "button", "data-tooltip": "More", "aria-label": "More buttons" })
  more.innerHTML = '<i class="fa-solid fa-ellipsis" inert></i>'
  const set = (open) => { foldOpen = open; root.classList.toggle("pb-gfold-open", open); more.setAttribute("aria-expanded", String(open)) }
  more.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); set(!foldOpen) })
  ;(root.querySelector(".col.right") || hidden[0].parentElement).append(more)
  set(foldOpen || hidden.some(b => b.classList.contains("active") && b.dataset.palette))
}

Hooks.on("renderTokenHUD", async (hud, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0]
  const actor = hud.document?.actor ?? hud.object?.actor
  root?.querySelector?.(".pb-gfan")?.remove()
  root?.querySelector?.(".pb-gfold-more")?.remove()
  root?.classList?.remove("pb-gfold-open")
  if (!root || !isGroup(actor)) return
  foldButtons(root)
  requestAnimationFrame(() => { const late = foldable(root).filter(b => !b.classList.contains("pb-gfold")); late.forEach(b => b.classList.add("pb-gfold")); if (late.length && !root.querySelector(".pb-gfold-more")) foldButtons(root) })
  const members = await membersOf(actor)
  if (!members.length) return

  const onScene = new Set((canvas.scene?.tokens ?? []).map(t => t.actorId))
  // Faces sit on a ring just outside the token (left/top % follow the HUD box, which Foundry scales with the zoom).
  const fan = el("div", "pb-gfan")
  const spots = fanSpots(members.length)
  members.forEach((m, i) => {
    const a = (spots[i].angle * Math.PI) / 180
    const face = el("div", "pb-gfan-face control-icon", {
      draggable: "true",
      "data-uuid": m.actor.uuid,
      "data-tooltip": `${m.actor.name} — drag onto the map`,
      role: "button",
      "aria-label": `Pull ${m.actor.name} out of the group`,
    })
    face.style.setProperty("--pb-cos", Math.cos(a).toFixed(4))
    face.style.setProperty("--pb-sin", Math.sin(a).toFixed(4))
    face.style.setProperty("--pb-ring", String(spots[i].ring))
    if (onScene.has(m.actor.id)) face.classList.add("placed")
    face.style.setProperty("--pb-delay", `${i * 18}ms`)
    const img = el("img", "", { src: tokenArt(m.actor).src, alt: "" })
    img.draggable = false
    face.append(img)
    face.addEventListener("dragstart", (ev) => {
      ev.stopPropagation()
      ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Actor", uuid: m.actor.uuid }))
      ev.dataTransfer.setDragImage(img, img.width / 2, img.height / 2)
    })
    face.addEventListener("dragend", () => { if (canvas.hud?.token?.rendered) canvas.hud.token.close?.() })
    face.addEventListener("dblclick", () => m.actor.sheet?.render(true))
    fan.append(face)
  })
  root.append(fan)
  requestAnimationFrame(() => requestAnimationFrame(() => fan.classList.add("open")))
})
