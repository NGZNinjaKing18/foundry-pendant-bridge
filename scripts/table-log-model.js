// ──────────────────────────────────────────────────────────────
// Table log — pure parts (tests/table-log.test.mjs).
//
// RealmScreen sends the live game's table log (lib/foundryTableLog.js →
// `tablelog.set`): the PLAYER lines of the running session, who is seated, and
// the campaign's switches. The linked GM window keeps the full copy; each
// player gets only their part in their private whisper (scripts/private.js):
//   · nothing at all unless they are seated in the running game;
//   · nobody else's "Just me" lines, nor anyone else's waiting ones;
//   · with "show the log" off, only their own lines;
//   · never the GM's own lines (`gm`), nor any line the sort has GM-only or dropped (`vis`).
// ──────────────────────────────────────────────────────────────

const str = (v) => (typeof v === "string" ? v.trim() : "")
const arr = (v) => (Array.isArray(v) ? v : [])

// ── @ / # suggestions ─────────────────────────────────────────
// RealmScreen sends `names` = { gm: [...], [userId]: [...] } of { n: name, t: "p" person | "l" place }:
// each player's list holds only what the Directory lets them see (lib/foundryTableLog.js nameLists).
const cleanNames = (v) => arr(v).filter(x => x && str(x.n)).slice(0, 800).map(x => ({ n: str(x.n).slice(0, 80), t: x.t === "l" ? "l" : "p" }))
function cleanNameBook(v) {
  const out = {}
  if (!v || typeof v !== "object") return out
  for (const [k, list] of Object.entries(v).slice(0, 80)) if (str(k)) out[str(k)] = cleanNames(list)
  return out
}

/** The unfinished @ / # the caret is in (RealmScreen's captureCompose activeMark rule), or null. */
export function activeMark(text, caret = String(text ?? "").length) {
  const t = String(text ?? "").slice(0, caret)
  const m = /(^|[\s("'\u201C])(@|#)(\[?)([^\]\n@#]*)$/.exec(t)
  if (!m || m[4].startsWith("+")) return null
  const query = m[4]
  if (!m[3]) {   // unbracketed: the mark ends at the first word that isn't Capitalised
    const words = query.split(/\s+/)
    if (words.slice(0, -1).some(w => w && !/^[A-Z\u00C0-\u024F]/.test(w))) return null
    if (/\s$/.test(query) && query.trim() && !/[A-Z\u00C0-\u024F]/.test(query.trim()[0] || "")) return null
  }
  return { type: m[2] === "#" ? "place" : "person", query: query.replace(/^\s+/, ""), start: m.index + m[1].length, end: caret }
}

// Matching ignores case, accents, curly quotes and punctuation: "éowyn" finds "Eowyn", "st mary" finds "St. Mary".
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[‘’]/g, "'")
  .toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim()
const wordsOf = (s) => s.split(" ").filter(Boolean)

// Edit distance with swaps (Damerau, optimal string alignment) — "Arhtorn" is one slip from "Arthorn".
function slips(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let pp = null, p = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const c = [i]
    let low = i
    for (let j = 1; j <= b.length; j++) {
      c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (pp && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) c[j] = Math.min(c[j], pp[j - 2] + 1)
      low = Math.min(low, c[j])
    }
    if (low > cap) return cap + 1
    pp = p; p = c
  }
  return p[b.length]
}
// The fewest slips between `q` and the START of `w` ("arhto" vs "arthorn" → 1).
const prefixSlips = (q, w, cap) => Math.min(...[q.length - 1, q.length, q.length + 1].filter(n => n > 0).map(n => slips(q, w.slice(0, n), cap)))

/** How well `name` fits what was typed (0 = not at all). Exact starts beat word starts beat typos. */
export function nameScore(name, query) {
  const n = fold(name), q = fold(query)
  if (!n) return 0
  if (!q) return 1
  if (n.startsWith(q)) return 100
  const nw = wordsOf(n), qw = wordsOf(q)
  if (nw.includes(q)) return 95                // a whole word: "vale" → "Arthorn Vale" before "Nira Valen"
  if (nw.some(w => w.startsWith(q))) return 90
  // every typed word starts a word of the name, in order: "vala gr" → "Vala the Grey"
  if (qw.length > 1) {
    let at = 0
    const inOrder = qw.every(x => { const i = nw.findIndex((w, k) => k >= at && w.startsWith(x)); if (i < 0) return false; at = i + 1; return true })
    if (inOrder) return 85
  }
  if (q.length >= 3 && n.replace(/ /g, "").includes(q.replace(/ /g, ""))) return 70
  // a typo or two: 1 slip for short queries, 2 from six letters on
  if (q.length >= 3) {
    const cap = q.length >= 6 ? 2 : 1
    const qq = q.replace(/ /g, "")
    let best = cap + 1
    for (const w of [n.replace(/ /g, ""), ...nw]) best = Math.min(best, prefixSlips(qq, w, cap))
    if (best <= cap) return 60 - best * 10
  }
  // initials: "av" → "Arthorn Vale"
  if (q.length >= 2 && !q.includes(" ") && nw.length >= q.length && [...q].every((ch, i) => nw[i]?.[0] === ch)) return 45
  return 0
}

/** Names to offer for a mark, best first: the player's own character leads for @. → [{ n, t }] */
export function suggestNames(names, mark, { own = "", limit = 6 } = {}) {
  if (!mark) return []
  const kind = mark.type === "place" ? "l" : "p"
  const raw = String(mark.query ?? "")
  const q = fold(raw)
  const list = arr(names).filter(x => x && x.t === kind && str(x.n))
  // A finished name followed by a space ("@Varek |") is done — don't keep offering.
  if (q && /\s$/.test(raw) && list.some(x => fold(x.n) === q)) return []
  // `own` is the Foundry actor's name, which may not be the Codex page's ("Nira" vs "Nira Valen"): lift the
  // page that matches it instead of listing both. Only an actor with no page is offered under its own name.
  const o = kind === "p" ? fold(own) : ""
  const isOwn = (n) => { const f = fold(n); return !!o && (f === o || f.startsWith(o + " ") || o.startsWith(f + " ")) }
  const pool = [...list]
  if (o && !list.some(x => isOwn(x.n))) pool.unshift({ n: str(own), t: "p" })
  const seen = new Set(), scored = []
  pool.forEach((x, i) => {
    const k = fold(x.n)
    if (!k || seen.has(k)) return
    seen.add(k)
    if (q && k === q) return            // already typed in full
    const s = nameScore(x.n, raw)
    if (s) scored.push({ x, s: s + (isOwn(x.n) ? 15 : 0), i })
  })
  scored.sort((a, b) => b.s - a.s || (q ? a.x.n.length - b.x.n.length : 0) || a.i - b.i)
  return scored.slice(0, limit).map(r => r.x)
}

// The parser reads an unbracketed name as a run of Capitalised words of letters, digits, ' and -.
const CAP_RUN = /^[A-ZÀ-ɏ][\p{L}\p{N}'’-]*(?: [A-ZÀ-ɏ][\p{L}\p{N}'’-]*)*$/u
/** The form a chosen name goes in as: @Name, or @[St. Mary of the Vale] when it can't be read back bare. */
export function markFor(type, name) {
  const key = type === "place" ? "#" : "@"
  const n = String(name ?? "").replace(/\s+/g, " ").trim()
  return key + (CAP_RUN.test(n) ? n : `[${n}]`)
}

/** Replace the active mark with the chosen name. → { text, caret } */
export function completeMark(text, mark, name) {
  const before = String(text ?? "").slice(0, mark.start)
  const after = String(text ?? "").slice(mark.end).replace(/^[^\s,.;:]*/, "")
  const token = markFor(mark.type, name) + " "
  return { text: before + token + after.replace(/^\s+/, ""), caret: (before + token).length }
}

/** A log from RealmScreen, cleaned (unknown fields dropped, sizes capped). */
export function cleanLog(log) {
  if (!log || typeof log !== "object" || !log.live || !str(log.live.campaignId)) return null
  return {
    live: { campaignId: str(log.live.campaignId), name: str(log.live.name) || "Campaign", number: Number.isFinite(log.live.number) ? log.live.number : null },
    users: arr(log.users).map(str).filter(Boolean),
    showLog: log.showLog !== false,
    justMe: log.justMe !== false,
    wait: !!log.wait,
    names: cleanNameBook(log.names),
    lines: arr(log.lines).filter(l => l && str(l.id)).slice(-200).map(l => ({
      id: str(l.id), ts: Number(l.ts) || 0, when: str(l.when).slice(0, 80),
      text: String(l.text ?? "").slice(0, 600),
      kind: ["note", "quote", "question"].includes(l.kind) ? l.kind : "note",
      who: str(l.who).slice(0, 80) || "A player", uid: str(l.uid),
      just: str(l.just) || null,
      ...(l.waiting ? { waiting: true } : {}),
      ...(l.gm ? { gm: true } : {}),
      // the one list (2026-11-18): where the sort has it, auto (Stage / Clock / Foundry), its in-world day
      vis: ["public", "dm", "drop"].includes(l.vis) ? l.vis : "public",
      ...(l.auto ? { auto: true } : {}), ...(l.edited ? { edited: true } : {}), ...(l.locked ? { locked: true } : {}),
      dayKey: Number.isFinite(l.dayKey) ? l.dayKey : null, day: str(l.day).slice(0, 120),
      marks: arr(l.marks).filter(m => m && ["person", "place", "loot", "question"].includes(m.t) && str(m.v)).slice(0, 8).map(m => ({ t: m.t, v: str(m.v).slice(0, 80) })),
    })),
  }
}

/** One player's part, or null when they aren't seated in the running game. */
export function logFor(log, uid) {
  const l = cleanLog(log)
  if (!l || !l.users.includes(uid)) return null
  const mine = (x) => x.uid === uid
  return {
    ...l,
    users: [uid],
    names: { [uid]: l.names[uid] || [] },      // only the names this player may see — never the GM's list
    // their own lines (any), else what is Keep (Public) — the GM's too (the user: "my lines if not designated GM
    // should be shown to everyone"); never a GM / Drop line of someone else, never someone's "Only me + GM"
    // Dropped lines stay for everyone (greyed, crossed out — anyone can bring one back); GM lines only for the writer.
    lines: l.lines.filter(x => mine(x) || (!x.just && !x.waiting && (x.vis === "public" || x.vis === "drop") && l.showLog)),
  }
}

/** "/note …" typed in chat → the line, or null when it isn't one. Also "/n …". */
export function noteCommand(message) {
  const m = /^\s*\/(note|n|tl)(?:\s+([\s\S]*))?$/i.exec(String(message ?? ""))
  if (!m) return null
  return { text: String(m[2] ?? "").trim() }
}

/** May this user take the line back from here? (RealmScreen checks again.) */
export const canUndo = (line, uid, isGM, now = Date.now()) => !!line && (isGM || (line.uid === uid && now - (line.ts || 0) < 10 * 60 * 1000))

/** May this user change the words of the line? Your own (while the session runs); the GM any. (RealmScreen checks again.) */
/** May this user press Players / GM / Drop on the line? Anyone seated, on any line they can see (the user, 2026-11-18). */
export const canSetVis = (line, uid, isGM) => !!line && !line.waiting && (isGM || line.vis !== "dm" || (!!line.uid && line.uid === uid))
export const canEdit = (line, uid, isGM) => !!line && !line.waiting && (isGM || (!line.gm && !line.auto && !!line.uid && line.uid === uid))

/** Plain text of a chat message's HTML (for "Add to / Quote in table log"). */
export function chatText(html) {
  return String(html ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim()
}
