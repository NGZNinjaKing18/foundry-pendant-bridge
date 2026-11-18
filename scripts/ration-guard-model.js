// ──────────────────────────────────────────────────────────────
// D&D Beyond rations guard — pure parts (tests/ration-guard.test.mjs).
//
// A character's rations are the GM's bookkeeping (scripts/rations.js); a
// re-import from D&D Beyond must leave them exactly as they were. Before:
// a snapshot of every ration stack (full item data). After the import has
// settled: the plan that puts the sheet back — take away ration stacks the
// import added, bring back the ones it removed, set every quantity back.
// Which items are rations is rations.js `isRation` (passed in).
// ──────────────────────────────────────────────────────────────

const qtyOf = (it) => Math.max(0, Math.floor(Number(it?.system?.quantity ?? 1) || 0))
const idOf = (it) => it?.id ?? it?._id ?? null
const plain = (it) => {
  try { return typeof it?.toObject === "function" ? it.toObject() : JSON.parse(JSON.stringify(it)) } catch { return null }
}

/** The ration stacks of an actor's items → [{ id, name, qty, data }] (data = full item data to bring it back). */
export function snapshotRations(items, isRation) {
  const out = []
  for (const it of (items || [])) {
    if (!isRation(it)) continue
    const id = idOf(it)
    if (!id) continue
    out.push({ id, name: String(it.name || ""), qty: qtyOf(it), data: plain(it) })
  }
  return out
}

/** Same rations (ids + quantities)? */
export function sameRations(a, b) {
  if (!a || !b || a.length !== b.length) return false
  const m = new Map(a.map(s => [s.id, s.qty]))
  return b.every(s => m.has(s.id) && m.get(s.id) === s.qty)
}

/**
 * What puts the rations back to `before`, given the actor's items now.
 * → { deletes: [id], creates: [data], updates: [{ _id, "system.quantity" }], changed }
 * Nothing that isn't a ration (now or before) is ever touched.
 */
export function planRestore(before, items, isRation) {
  const was = new Map((before || []).map(s => [s.id, s]))
  const now = new Map()
  for (const it of (items || [])) { const id = idOf(it); if (id && isRation(it)) now.set(id, it) }
  const byId = new Map((items || []).map(it => [idOf(it), it]))
  const deletes = [], creates = [], updates = []
  for (const [id] of now) if (!was.has(id)) deletes.push(id)
  for (const [id, s] of was) {
    const cur = now.get(id)
    if (cur) {
      if (qtyOf(cur) !== s.qty) updates.push({ _id: id, "system.quantity": s.qty })
      continue
    }
    // The id is taken by something that's no longer a ration (renamed by the import) → set it back too.
    const other = byId.get(id)
    if (other) { updates.push({ _id: id, name: s.name, "system.quantity": s.qty }); continue }
    if (s.data) {
      const data = { ...s.data, _id: id }
      // Its container may be gone after the import → loose in the inventory rather than lost.
      const parent = data.system?.container
      if (parent && !byId.has(parent)) data.system = { ...data.system, container: null }
      creates.push(data)
    }
  }
  return { deletes, creates, updates, changed: !!(deletes.length || creates.length || updates.length) }
}
