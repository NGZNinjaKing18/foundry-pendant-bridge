// ──────────────────────────────────────────────────────────────
// Table log — pure parts (tests/table-log.test.mjs).
//
// RealmScreen sends the live game's table log (lib/foundryTableLog.js →
// `tablelog.set`): the PLAYER lines of the running session, who is seated, and
// the campaign's switches. The linked GM window keeps the full copy; each
// player gets only their part in their private whisper (scripts/private.js):
//   · nothing at all unless they are seated in the running game;
//   · nobody else's "Just me" lines, nor anyone else's waiting ones;
//   · with "show the log" off, only their own lines.
// ──────────────────────────────────────────────────────────────

const str = (v) => (typeof v === "string" ? v.trim() : "")
const arr = (v) => (Array.isArray(v) ? v : [])

/** A log from RealmScreen, cleaned (unknown fields dropped, sizes capped). */
export function cleanLog(log) {
  if (!log || typeof log !== "object" || !log.live || !str(log.live.campaignId)) return null
  return {
    live: { campaignId: str(log.live.campaignId), name: str(log.live.name) || "Campaign", number: Number.isFinite(log.live.number) ? log.live.number : null },
    users: arr(log.users).map(str).filter(Boolean),
    showLog: log.showLog !== false,
    justMe: log.justMe !== false,
    wait: !!log.wait,
    lines: arr(log.lines).filter(l => l && str(l.id)).slice(-200).map(l => ({
      id: str(l.id), ts: Number(l.ts) || 0, when: str(l.when).slice(0, 80),
      text: String(l.text ?? "").slice(0, 600),
      kind: ["note", "quote", "question"].includes(l.kind) ? l.kind : "note",
      who: str(l.who).slice(0, 80) || "A player", uid: str(l.uid),
      just: str(l.just) || null,
      ...(l.waiting ? { waiting: true } : {}),
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
    lines: l.lines.filter(x => (x.just ? x.just === uid : true) && (!x.waiting || mine(x)) && (l.showLog || mine(x))),
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

/** Plain text of a chat message's HTML (for "Add to / Quote in table log"). */
export function chatText(html) {
  return String(html ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim()
}
