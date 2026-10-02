/**
 * File sorter — the pure half (no Foundry globals, unit-tested under Node).
 *
 * Foundry links every map, portrait, token and sound by a plain path string
 * stored somewhere inside a document ("worlds/x/maps/Cave.webp", an <img src>
 * inside journal HTML, a CSS url(), a macro's string literal…). To move a file
 * safely we must find EVERY such string and rewrite it. This module does the
 * string work: spotting path candidates in any text, normalising them to one
 * comparable key, rewriting them in the same form they were written, and
 * walking a document's plain data to collect `doc.update()` changes.
 *
 * A "key" is the decoded, origin-less, slash-normalised path of a file in
 * Foundry's user-data source: "worlds/x/My Map.webp".
 */

// ── path keys ─────────────────────────────────────────────────

/** Decoded, origin-less, query-less path key ('' when it can't be a data file). */
export function normalizePath(raw, bases = []) {
  let s = String(raw ?? "").trim()
  if (!s) return ""
  let stripped = false
  for (const b of bases) {
    if (b && s.toLowerCase().startsWith(b.toLowerCase())) { s = s.slice(b.length); stripped = true; break }
  }
  if (!stripped && /^[a-z][a-z0-9+.-]*:/i.test(s)) return ""   // another site, data:, blob:
  if (s.startsWith("//")) return ""
  s = s.replace(/[?#].*$/, "")
  s = s.replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "")
  try { s = decodeURIComponent(s) } catch { /* a stray % — keep it literal */ }
  return s.replace(/\/{2,}/g, "/")
}

/** URL-encode each segment of a key (spaces → %20; slashes kept). */
export function encodePath(key) {
  return String(key).split("/").map(encodeURIComponent).join("/")
}

export function splitPath(key) {
  const i = key.lastIndexOf("/")
  return i < 0 ? { dir: "", name: key } : { dir: key.slice(0, i), name: key.slice(i + 1) }
}

export function extOf(key) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(key))
  return m ? m[1].toLowerCase() : ""
}

/**
 * Exact lookup first, then case-insensitive (a Windows server serves
 * "Maps/Cave.webp" for a link written "maps/cave.webp"). A case-insensitive hit
 * shared by two files is ambiguous — callers treat it as touching both.
 */
export function makeLookup(keys) {
  const exact = new Set(keys)
  const lower = new Map()
  for (const k of keys) {
    const l = k.toLowerCase()
    const arr = lower.get(l)
    if (arr) arr.push(k); else lower.set(l, [k])
  }
  return {
    get(key) {
      if (!key) return null
      if (exact.has(key)) return [key]
      return lower.get(key.toLowerCase()) || null
    },
    keys: exact,
  }
}

// ── finding path candidates inside any string ─────────────────

const ATTR_RE = /\b(?:src|href|poster|data-src|data-image|data-path)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi
const TOKEN_RE = /[^\s"'<>()[\]{}|\\^`,;=]+\.[A-Za-z0-9]{2,5}(?:[?#][^\s"'<>()[\]{}|\\^`,;]*)?/g

/**
 * Every substring that might be a file path: the whole string (a field like
 * `img`), HTML attribute values, CSS url()s, and bare path-looking tokens.
 * → [{ start, end, raw, kind:'whole'|'attr'|'token' }], non-overlapping, in order.
 */
export function extractCandidates(str, { noWhole = false } = {}) {
  if (typeof str !== "string" || str.length < 3 || !str.includes(".")) return []
  const t = str.trim()
  if (!noWhole && t.length <= 1024 && !/[\n<>"]/.test(t)) {
    const start = str.indexOf(t)
    return [{ start, end: start + t.length, raw: t, kind: "whole" }]
  }
  const out = []
  const overlaps = (a, b) => out.some(c => a < c.end && b > c.start)
  const add = (start, raw, kind) => {
    if (!raw) return
    const end = start + raw.length
    if (!overlaps(start, end)) out.push({ start, end, raw, kind })
  }
  for (const m of str.matchAll(ATTR_RE)) {
    const v = m[1] ?? m[2] ?? ""
    add(m.index + m[0].length - v.length - 1, v, "attr")
  }
  for (const m of str.matchAll(URL_RE)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? "").trim()
    if (v) add(m.index + m[0].indexOf(v), v, "attr")
  }
  for (const m of str.matchAll(TOKEN_RE)) add(m.index, m[0], "token")
  return out.sort((a, b) => a.start - b.start)
}

/** Glob pattern ("tokens/goblin/*.webp") → RegExp over keys. */
export function globToRegex(pattern) {
  const esc = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
  return new RegExp("^" + esc + "$", "i")
}

/**
 * The file keys a string points at. → [{ key, cand, wildcard?, ambiguous? }]
 * `unknown` (optional) collects path-looking keys that match no file.
 */
export function findRefs(str, lookup, bases = [], unknown = null) {
  const hitsOf = (c) => {
    const key = normalizePath(c.raw, bases)
    if (!key) return []
    if (key.includes("*")) return [{ key, cand: c, wildcard: true }]
    const found = lookup.get(key)
    return found ? found.map(k => ({ key: k, cand: c, ambiguous: found.length > 1 })) : []
  }
  let cands = extractCandidates(str)
  if (cands.length === 1 && cands[0].kind === "whole") {
    const hits = hitsOf(cands[0])
    if (hits.length) return hits
    if (!/\s/.test(cands[0].raw)) {          // one path-like word that matches no file
      const key = normalizePath(cands[0].raw, bases)
      if (unknown && key && /\.[a-z0-9]{2,5}$/i.test(key)) unknown.push(key)
      return []
    }
    cands = extractCandidates(str, { noWhole: true })  // a sentence — look inside it
  }
  const hits = []
  for (const c of cands) hits.push(...hitsOf(c))
  return hits
}

/** Keys matched by a wildcard key, among `keys`. */
export function expandWildcard(wild, keys) {
  const re = globToRegex(wild)
  const out = []
  for (const k of keys) if (re.test(k)) out.push(k)
  return out
}

// ── rewriting ─────────────────────────────────────────────────

/**
 * Rewrite every candidate in `str` whose key `resolve(key)` maps to a new key,
 * keeping the way it was written: the same origin/leading slash, the same
 * ?query/#hash, and URL-encoded when the original was (or when it sits in bare
 * text, where a space would end the path).
 */
export function rewriteString(str, resolve, bases = []) {
  if (typeof str !== "string") return str
  let cands = extractCandidates(str)
  if (!cands.length) return str
  if (cands.length === 1 && cands[0].kind === "whole") {
    const key = normalizePath(cands[0].raw, bases)
    if (!(key && !key.includes("*") && resolve(key)) && /\s/.test(cands[0].raw)) cands = extractCandidates(str, { noWhole: true })
  }
  let out = "", at = 0, changed = false
  for (const c of cands) {
    const key = normalizePath(c.raw, bases)
    if (!key || key.includes("*")) continue
    const next = resolve(key)
    if (!next) continue
    let raw = c.raw, prefix = ""
    for (const b of bases) {
      if (b && raw.toLowerCase().startsWith(b.toLowerCase())) { prefix = raw.slice(0, b.length); raw = raw.slice(b.length); break }
    }
    const lead = /^(?:\.\/|\/)+/.exec(raw)?.[0] || ""
    raw = raw.slice(lead.length)
    const q = raw.search(/[?#]/)
    const suffix = q >= 0 ? raw.slice(q) : ""
    const body = q >= 0 ? raw.slice(0, q) : raw
    // Encoded when it was, in bare text (a space would end the path) and in a full URL.
    const encoded = body.includes("%") || c.kind === "token" || !!prefix
    out += str.slice(at, c.start) + prefix + lead + (encoded ? encodePath(next) : next) + suffix
    at = c.end
    changed = true
  }
  return changed ? out + str.slice(at) : str
}

/** Deep copy-on-write rewrite: returns the SAME reference when nothing changed. */
export function deepRewrite(v, rw) {
  if (typeof v === "string") return rw(v)
  if (Array.isArray(v)) {
    let changed = false
    const next = v.map(x => { const n = deepRewrite(x, rw); if (n !== x) changed = true; return n })
    return changed ? next : v
  }
  if (v && typeof v === "object") {
    let changed = false
    const next = {}
    for (const [k, x] of Object.entries(v)) { const n = deepRewrite(x, rw); if (n !== x) changed = true; next[k] = n }
    return changed ? next : v
  }
  return v
}

/**
 * Visit every string in a document's plain data. `cb(str, path, editable)`.
 * `editable` is false under an object key containing a dot — Foundry would
 * expand such a key on update and reshape the data, so those are never touched.
 * Arrays are visited too; an array is always replaced whole on update.
 */
export function forEachString(src, skip, cb) {
  const walk = (v, path, editable) => {
    if (typeof v === "string") { cb(v, path, editable); return }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + "." + i, editable)); return }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, path ? path + "." + k : k, editable && !k.includes("."))
    }
  }
  for (const [k, v] of Object.entries(src || {})) if (!skip.has(k)) walk(v, k, true)
}

/**
 * The `doc.update()` payload that applies `rw` to a document's own data
 * (embedded collections in `skip` are handled as their own documents).
 * Strings become dotted keys; anything inside an array replaces that whole
 * array; nothing under a dotted object key is ever rewritten.
 */
export function collectUpdates(src, skip, rw) {
  const updates = {}
  const walk = (v, path) => {
    if (typeof v === "string") { const n = rw(v); if (n !== v) updates[path] = n; return }
    if (Array.isArray(v)) {
      if (JSON.stringify(v).includes('.":')) return  // array of objects with dotted keys — leave it
      const n = deepRewrite(v, rw); if (n !== v) updates[path] = n; return
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) { if (!k.includes(".")) walk(x, path ? path + "." + k : k) }
    }
  }
  for (const [k, v] of Object.entries(src || {})) if (!skip.has(k)) walk(v, k)
  return updates
}

/**
 * Cheap pre-filter: could this serialised document mention any of these keys?
 * `needles` = lower-cased basenames, decoded and encoded.
 */
export function needlesFor(keys) {
  const set = new Set()
  for (const k of keys) {
    const name = splitPath(k).name.toLowerCase()
    if (!name) continue
    set.add(name)
    set.add(encodeURIComponent(name).toLowerCase())
  }
  return [...set]
}
export function mightMention(text, needles) {
  const t = text.toLowerCase()
  for (const n of needles) if (t.includes(n)) return true
  return false
}

// ── bytes ─────────────────────────────────────────────────────

/** Fast non-crypto 53-bit hash of bytes (fallback when crypto.subtle is unavailable on http). */
export function hashBytes53(u8) {
  let h1 = 0xdeadbeef ^ u8.length, h2 = 0x41c6ce57 ^ u8.length
  for (let i = 0; i < u8.length; i++) {
    const c = u8[i]
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return "c53:" + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16) + ":" + u8.length
}

export const STUB_HEAD = "RealmScreen moved this file."

/** The placeholder that replaces a moved file: says where it went. */
export function stubText(newKey) {
  return `${STUB_HEAD}\nNew location: ${newKey}\n`
}

/** Is this file one of our text placeholders? */
export function isStubBytes(u8) {
  if (!u8 || u8.length > 4096 || u8.length < STUB_HEAD.length) return false
  for (let i = 0; i < STUB_HEAD.length; i++) if (u8[i] !== STUB_HEAD.charCodeAt(i)) return false
  return true
}
