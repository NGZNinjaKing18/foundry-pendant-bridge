// ──────────────────────────────────────────────────────────────
// MOUNT / VEHICLE — what the sheet and the character-sheet bits LOOK like (pure: view-model in, HTML out).
// Used by the real sheet (scripts/mount.js) and by tests/harness/mount.html, so the harness shows real code.
// Look = the approved mockup (tests/harness/mount-mockup.html): sidebar (Cover, AC, HP, speed, owner, carrying),
// tabs on the right edge — Inventory (default) · Anti-Hammer (tack slots around the animal + its bags) · Details.
// Colours only from Foundry's theme variables (styles/mount.css), so light/dark both work.
// ──────────────────────────────────────────────────────────────

import { SLOTS, SLOT_KEYS, hexLayout } from "./mount-model.js"

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const fmt = (n) => (Math.round((Number(n) || 0) * 10) / 10).toLocaleString()
const KINDCLS = { weapon: "weapon", equipment: "armor", consumable: "cons", tool: "tool", container: "gear", loot: "other", backpack: "gear" }

/** A load bar: value / max lb (green → amber past ⅔ → red when over). */
export function loadBar(value, max, label) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 100
  const cls = !max || value > max ? "over" : value > (max * 2) / 3 ? "warn" : ""
  return '<div class="pbm-load ' + cls + '"' + (label ? ' title="' + esc(label) + '"' : "") + '><i style="width:' + pct.toFixed(1) + '%"></i><span>' + fmt(value) + " / " + (max ? fmt(max) : "—") + " lb</span></div>"
}

function rowHTML(it, canEdit) {
  return '<li class="pbm-row" data-item-id="' + esc(it.id) + '"' + (canEdit ? ' draggable="true"' : "") + ">" +
    '<span class="pbm-nm"><img src="' + esc(it.img) + '" alt=""><span><b>' + esc(it.name) + "</b>" +
    (it.sub || it.notPacked ? "<em>" + esc(it.sub || "") + (it.notPacked ? '<span class="pbm-tag bad">not packed</span>' : "") + "</em>" : "") + "</span></span>" +
    '<span class="pbm-w">' + fmt(it.weight * it.qty) + " lb</span>" +
    '<span class="pbm-q">' + (canEdit ? '<a data-qty="-1" title="One less"><i class="fa-solid fa-minus"></i></a>' : "") + it.qty + (canEdit ? '<a data-qty="1" title="One more"><i class="fa-solid fa-plus"></i></a>' : "") + "</span>" +
    '<a class="pbm-menu" data-menu title="More"><i class="fa-solid fa-ellipsis-vertical"></i></a></li>'
}

export function inventoryHTML(vm) {
  let h = '<div class="pbm-find"><input type="search" data-find placeholder="Search inventory" value="' + esc(vm.find || "") + '"></div>'
  const q = String(vm.find || "").toLowerCase()
  let any = false
  for (const sec of vm.sections) {
    const rows = sec.items.filter(i => !q || i.name.toLowerCase().includes(q))
    if (!rows.length && !sec.always) continue
    any = true
    h += '<section class="pbm-sec"><header><span>' + esc(sec.label) + "</span><span>Weight</span><span>Qty</span><span></span></header><ol>"
    h += rows.length ? rows.map(i => rowHTML(i, vm.canEdit)).join("") : '<li class="pbm-empty">Nothing here. Drag things from a character onto this sheet</li>'
    h += "</ol></section>"
  }
  if (!any) h += '<p class="pbm-empty">' + (q ? 'Nothing called "' + esc(vm.find) + '"' : "Nothing here yet. Drag things from a character onto this sheet") + "</p>"
  h += '<footer class="pbm-foot"><div class="pbm-carry"><span>Carrying</span>' + loadBar(vm.carry.value, vm.carry.max, vm.carry.rule) + "</div>" +
    '<div class="pbm-coins">' + ["pp", "gp", "ep", "sp", "cp"].map(c => '<label><input type="number" data-coin="' + c + '" value="' + (Number(vm.currency?.[c]) || 0) + '"' + (vm.canEdit ? "" : " disabled") + ">" + c + "</label>").join("") + "</div></footer>"
  return h
}

// ── Anti-Hammer tab ──
const HS = 15, HW = Math.sqrt(3) * HS
const hcen = (c, r) => ({ x: HW / 2 + 3 + HW * (c + 0.5 * (r & 1)), y: HS + 3 + 1.5 * HS * r })
const hpts = (x, y, s) => { let p = ""; for (let i = 0; i < 6; i++) { const t = (60 * i - 90) * Math.PI / 180; p += (x + s * Math.cos(t)).toFixed(1) + "," + (y + s * Math.sin(t)).toFixed(1) + " " } return p }
export function bagSVG(bag) {
  const lay = hexLayout(bag.cap, bag.items), byId = Object.fromEntries(bag.items.map(u => [u.id, u]))
  const w = HW * (lay.cols + 0.5) + 6, h = 1.5 * HS * (lay.rows - 1) + 2 * HS + 6
  let s = '<svg viewBox="0 0 ' + w.toFixed(0) + " " + h.toFixed(0) + '" width="' + w.toFixed(0) + '" height="' + h.toFixed(0) + '">'
  for (let i = 0; i < bag.cap; i++) { const p = hcen(Math.floor(i / lay.rows), i % lay.rows); s += '<polygon class="pbm-hx" points="' + hpts(p.x, p.y, HS - 1) + '"/>' }
  for (const [id, cells] of lay.cells) {
    const u = byId[id], cs = cells.map(([c, r]) => hcen(c, r)); let d = ""
    for (const c of cs) for (let i = 0; i < 6; i++) {
      const t = (60 * i - 60) * Math.PI / 180, nx = c.x + HW * Math.cos(t), ny = c.y + HW * Math.sin(t)
      if (cs.some(o => Math.abs(o.x - nx) < 2 && Math.abs(o.y - ny) < 2)) continue
      const v = (j) => { const q = (60 * j - 90) * Math.PI / 180; return [c.x + (HS + 0.4) * Math.cos(q), c.y + (HS + 0.4) * Math.sin(q)] }
      const p1 = v(i), p2 = v(i + 1); d += "M" + p1[0].toFixed(1) + " " + p1[1].toFixed(1) + "L" + p2[0].toFixed(1) + " " + p2[1].toFixed(1)
    }
    const mx = cs.reduce((t, c) => t + c.x, 0) / cs.length, my = cs.reduce((t, c) => t + c.y, 0) / cs.length
    const span = Math.max(...cs.map(c => c.x)) - Math.min(...cs.map(c => c.x)) + HW, nm = u.name + (u.qty > 1 ? " ×" + u.qty : "")
    const maxCh = Math.max(3, Math.floor(span / 5.4)), label = nm.length > maxCh ? nm.slice(0, maxCh - 1) + "…" : nm
    s += '<g class="pbm-hit k-' + (KINDCLS[u.type] || "other") + '" data-item-id="' + esc(id) + '"><title>' + esc(nm) + " · " + fmt(u.spaces) + " space" + (u.spaces === 1 ? "" : "s") + "</title>" +
      cs.map(c => '<polygon class="pbm-hf" points="' + hpts(c.x, c.y, HS + 0.4) + '"/>').join("") + '<path class="pbm-he" d="' + d + '"/><text x="' + mx.toFixed(1) + '" y="' + (my + 3).toFixed(1) + '" text-anchor="middle">' + esc(label) + "</text></g>"
  }
  return s + "</svg>"
}
function slotHTML(key, worn, canEdit) {
  const [label, side, row, hint] = SLOTS[key]
  if (!worn) return '<div class="pbm-slot ' + side + ' empty" style="grid-row:' + row + '" data-slot="' + key + '"><span class="k">' + label + '</span><span class="v">+ ' + hint + "</span></div>"
  return '<div class="pbm-slot ' + side + ' filled" style="grid-row:' + row + '" data-slot="' + key + '" data-item-id="' + esc(worn.id) + '"' + (canEdit ? ' draggable="true"' : "") + ">" +
    '<span class="k">' + label + (worn.sub ? "<i>" + esc(worn.sub) + "</i>" : "") + '</span><span class="v">' + esc(worn.name) + (worn.gives ? '<span class="mark">▸</span>' : "") + "</span></div>"
}
export function ahHTML(vm) {
  const a = vm.ah
  if (!a) return '<p class="pbm-off">Anti-Hammer isn\'t in use here. The Inventory tab and the pounds limit work on their own</p>'
  let h = ""
  if (a.tack) {
    h += '<div class="pbm-h"><b>Tack</b><span class="meta">click or drop to put on</span><span class="sp"></span>' + (vm.canEdit ? '<button type="button" data-tackup>Tack up</button><button type="button" data-strip>Strip</button>' : "") + "</div>"
    h += '<div class="pbm-doll"><div class="fig"><i class="fa-solid ' + esc(vm.icon) + '"></i></div>' + SLOT_KEYS.map(k => slotHTML(k, a.slots[k], vm.canEdit)).join("") + "</div>"
  }
  const used = a.bags.reduce((t, b) => t + b.used, 0), cap = a.bags.reduce((t, b) => t + b.cap, 0)
  h += '<div class="pbm-h"><b>' + (a.tack ? "Bags" : "Storage") + '</b><span class="meta">' + fmt(used) + " / " + fmt(cap) + " packed</span></div>"
  h += '<div class="pbm-meter"><i style="width:' + (cap ? Math.round((used / cap) * 100) : 0) + '%"></i></div>'
  if (!a.bags.length) h += '<p class="pbm-none">No bags on ' + esc(vm.name) + " yet. Put on saddlebags, panniers or a pack saddle</p>"
  h += '<div class="pbm-bags">' + a.bags.map(b => {
    const big = b.cap > 60
    return '<div class="pbm-bag' + (big ? " big" : "") + '" data-bag="' + esc(b.id) + '"><div class="pbm-bag-h"><b>' + esc(b.label) + '</b><span class="where">' + esc(b.where) + (b.longOnly ? " · long things" : "") + '</span><span class="n' + (b.used >= b.cap ? " full" : "") + '">' + fmt(b.used) + " / " + fmt(b.cap) + "</span></div>" +
      (big ? (b.items.length ? '<ol class="pbm-biglist">' + b.items.map(u => '<li data-item-id="' + esc(u.id) + '"' + (vm.canEdit ? ' draggable="true"' : "") + "><span>" + esc(u.name) + (u.qty > 1 ? " ×" + u.qty : "") + "</span><i>" + fmt(u.spaces) + "</i></li>").join("") + "</ol>" : '<p class="pbm-none">Empty. Drag things onto it</p>') : bagSVG(b)) + "</div>"
  }).join("") + "</div>"
  if (a.notPacked.length) h += '<div class="pbm-over"><b>' + a.notPacked.length + " not packed</b>: " + a.notPacked.map(u => esc(u.name)).join(", ") + ". Drag one onto a bag, or click it</div>"
  return h
}

export function detailsHTML(vm) {
  const d = vm.details, gm = vm.isGM
  let kinds = "", lastGroup = null
  for (const k of d.kinds) {
    if (k.group !== lastGroup) { if (lastGroup !== null) kinds += "</optgroup>"; kinds += '<optgroup label="' + esc(k.group) + '">'; lastGroup = k.group }
    kinds += '<option value="' + esc(k.key) + '"' + (k.key === vm.kindKey ? " selected" : "") + ">" + esc(k.label) + "</option>"
  }
  kinds += "</optgroup>"
  let h = '<div class="pbm-two"><div class="pbm-fld"><label>Kind</label><select data-field="kind"' + (gm ? "" : " disabled") + ">" + kinds + "</select></div>" +
    '<div class="pbm-fld"><label>Owner</label><select data-field="owner"' + (gm ? "" : " disabled") + '><option value="">Nobody (GM only)</option>' +
    d.owners.map(o => '<option value="' + esc(o.id) + '"' + (o.id === d.ownerId ? " selected" : "") + ">" + esc(o.name) + "</option>").join("") + "</select></div></div>"
  if (gm) h += '<p class="pbm-hint">New kind? <a data-restat>Use its 5e stats</a> (keeps the name, Cover and inventory)</p>'
  else h += '<p class="pbm-hint">Only the GM sets the kind and the owner. The owner\'s player can open, store and take</p>'
  if (d.abil.length) h += '<div class="pbm-abil">' + d.abil.map(a => "<label><small>" + a.key.toUpperCase() + '</small><input type="number" data-abil="' + a.key + '" value="' + a.value + '"' + (vm.canEdit ? "" : " disabled") + "><em>" + (a.mod >= 0 ? "+" : "") + a.mod + "</em></label>").join("") + "</div>"
  h += '<div class="pbm-two"><div class="pbm-fld"><label>AC</label><input type="number" data-field="ac" value="' + d.ac + '"' + (vm.canEdit ? "" : " disabled") + "></div>" +
    '<div class="pbm-fld"><label>Speed</label><input type="text" data-field="speed" value="' + esc(d.speed) + '"' + (vm.canEdit ? "" : " disabled") + "></div></div>"
  if (d.attacks.length || vm.canEdit) {
    h += '<div class="pbm-fld"><label>Attacks</label>' + d.attacks.map((a, i) => '<div class="pbm-atk" data-attack="' + i + '"><b>' + esc(a.name) + '</b><a data-roll="hit" title="Roll to hit">' + esc(a.toHit) + ' to hit</a><a data-roll="dmg" title="Roll damage">' + esc(a.damage) + " " + esc(a.type) + "</a></div>").join("") +
      (d.attacks.length ? "" : '<p class="pbm-hint">None</p>') + "</div>"
  }
  if (d.drawn) h += '<div class="pbm-fld"><label>Pulled by</label><select data-field="pulledBy"' + (gm ? "" : " disabled") + '><option value="">Nothing</option>' +
    d.pullers.map(p => '<option value="' + esc(p.id) + '"' + (d.pulledBy.includes(p.id) ? " selected" : "") + ">" + esc(p.name) + " (" + esc(p.label) + ")</option>").join("") + "</select></div>"
  h += '<div class="pbm-fld"><label>Carry limit</label><div class="pbm-two"><input type="number" data-field="carry" placeholder="' + fmt(d.carryAuto) + ' lb" value="' + (d.carryOverride ?? "") + '"' + (gm ? "" : " disabled") + '><span class="pbm-hint">' + esc(d.carryRule) + "</span></div></div>"
  h += '<div class="pbm-fld"><label>Description</label><textarea data-field="description"' + (vm.canEdit ? "" : " disabled") + ">" + esc(d.description) + "</textarea></div>"
  return h
}

const TABS = [["inventory", "fa-suitcase", "Inventory"], ["ah", "fa-cubes", "Anti-Hammer"], ["details", "fa-horse-head", "Details"]]

/** The whole sheet body (inside Foundry's window frame). */
export function mountSheetHTML(vm) {
  const tab = vm.tab === "ah" && !vm.ah ? "inventory" : vm.tab
  const side = '<aside class="pbm-side">' +
    '<div class="pbm-cover"' + (vm.canEdit ? ' data-edit-img title="Change the Cover"' : "") + '><img src="' + esc(vm.img) + '" alt=""></div>' +
    '<div class="pbm-vitals"><div class="pbm-ac" title="Armour Class">' + vm.ac + "<small>AC</small></div>" +
    '<div class="pbm-hp" title="Hit points"><i style="width:' + (vm.hp.max ? Math.min(100, (vm.hp.value / vm.hp.max) * 100) : 0).toFixed(0) + '%"></i>' +
    '<input type="number" data-field="hp" value="' + vm.hp.value + '"' + (vm.canEdit ? "" : " disabled") + "><span>/ " + vm.hp.max + "</span></div></div>" +
    '<div class="pbm-speed"><i class="fa-solid ' + (vm.isVehicle ? "fa-road" : "fa-horse") + '"></i> ' + esc(vm.speed || "—") + "</div>" +
    '<h4>Owner</h4><div class="pbm-owner">' + (vm.owner ? '<a data-open-actor="' + esc(vm.owner.id) + '"><i class="fa-solid fa-user"></i> ' + esc(vm.owner.name) + "</a>" : "<span>Nobody (GM only)</span>") + "</div>" +
    "<h4>Carrying</h4>" + loadBar(vm.carry.value, vm.carry.max, vm.carry.rule) + "</aside>"
  const lock = vm.canEdit ? "" : '<p class="pbm-lock"><i class="fa-solid fa-lock"></i> You can look, but ' + esc(vm.name) + " isn't yours. The GM can make you its owner</p>"
  const body = tab === "ah" ? ahHTML(vm) : tab === "details" ? detailsHTML(vm) : inventoryHTML(vm)
  const nav = '<nav class="pbm-tabs">' + TABS.filter(t => t[0] !== "ah" || vm.ah).map(([id, ic, lb]) => '<a class="' + (id === tab ? "active" : "") + '" data-pbm-tab="' + id + '" data-tooltip="' + lb + '" aria-label="' + lb + '"><i class="fa-solid ' + ic + '"></i></a>').join("") + "</nav>"
  return side + '<div class="pbm-main"><header class="pbm-head"><input class="pbm-name" data-field="name" value="' + esc(vm.name) + '"' + (vm.canEdit ? "" : " disabled") + '><div class="pbm-sub">' + esc(vm.kindLabel) + " · " + esc(vm.sizeLabel) + (vm.isVehicle ? " vehicle" : " beast") + "</div></header>" +
    '<div class="pbm-body" data-pbm-tab-body="' + tab + '">' + lock + body + "</div></div>" + nav
}

// ── the character sheet bits ──
/** Sidebar card(s): one per mount the character owns (Cover, name, kind, load). Drop an item on it to store it. */
export function mountCardsHTML(mounts) {
  if (!mounts.length) return ""
  return '<div class="pbm-cards"><h4>Mounts</h4>' + mounts.map(m =>
    '<div class="pbm-card" data-pbm-mount="' + esc(m.id) + '" data-tooltip="Open ' + esc(m.name) + ' · drop an item here to store it"><img src="' + esc(m.img) + '" alt="">' +
    "<b>" + esc(m.name) + "</b><span>" + esc(m.kindLabel) + "</span>" + loadBar(m.carry.value, m.carry.max) + "</div>").join("") + "</div>"
}
/** Top of the character's Inventory tab: a row per mount with an Open button. */
export function mountStripHTML(mounts) {
  if (!mounts.length) return ""
  return '<div class="pbm-strip">' + mounts.map(m =>
    '<div class="pbm-strip-row" data-pbm-mount="' + esc(m.id) + '"><img src="' + esc(m.img) + '" alt=""><span><b>' + esc(m.name) + "</b><em>" + esc(m.kindLabel) + "</em></span>" +
    loadBar(m.carry.value, m.carry.max) + '<button type="button" data-pbm-open="' + esc(m.id) + '">Open</button></div>').join("") +
    '<p class="pbm-hint">Drop an item on a mount to store it there</p></div>'
}
