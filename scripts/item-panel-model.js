// ──────────────────────────────────────────────────────────────
// Item panel — pure parts (tests/item-panel.test.mjs).
//
// Rows come from compendium INDEXES (name, img, type — no full documents) and
// the world's own items. The search matches every word of the query against
// the name (any order), best first: whole-name match, then names that start
// with the query, then the rest, A→Z.
// ──────────────────────────────────────────────────────────────

const norm = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()

/** Rows → the same rows with a search key (built once per list). */
export function prepare(rows) {
  return (rows || []).filter(r => r && r.uuid && r.name).map(r => ({ ...r, key: norm(r.name) }))
}

/** The rows matching `query` (all of its words), filtered by source / type. */
export function search(rows, query = "", { source = "", type = "", limit = 200 } = {}) {
  const q = norm(query)
  const words = q ? q.split(" ") : []
  const hit = []
  for (const r of rows || []) {
    if (source && r.source !== source) continue
    if (type && r.type !== type) continue
    const k = r.key ?? norm(r.name)
    if (words.length && !words.every(w => k.includes(w))) continue
    const rank = !q ? 2 : k === q ? 0 : k.startsWith(q) ? 1 : 2
    hit.push([rank, k, r])
  }
  hit.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return { rows: hit.slice(0, limit).map(h => h[2]), total: hit.length }
}

/** The types present, for the type filter → [{ type, n }], most common first. */
export function typesOf(rows) {
  const n = new Map()
  for (const r of rows || []) if (r.type) n.set(r.type, (n.get(r.type) || 0) + 1)
  return [...n].map(([type, k]) => ({ type, n: k })).sort((a, b) => b.n - a.n || a.type.localeCompare(b.type))
}

/** Standard Foundry drag data for one row. */
export const dragData = (row) => ({ type: "Item", uuid: row.uuid })
