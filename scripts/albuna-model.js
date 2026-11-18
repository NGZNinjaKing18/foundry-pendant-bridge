// ──────────────────────────────────────────────────────────────
// Albuna coins — pure parts (tests/albuna.test.mjs).
//
// A character can count money the Albuna way: bronze, silver, gold, where
// 100 bronze = 1 silver and 25 silver = 1 gold (1 gold = 2,500 bronze).
// It is a per-actor switch (flags.pendant-bridge.currency = "albuna"); the
// coins stay in dnd5e's own fields so nothing is rewritten or lost:
//     gold → system.currency.gp · silver → .sp · bronze → .cp
// Platinum and electrum are not Albuna coins: they are hidden while empty and
// NEVER touched (a sheet that still holds some shows them, marked).
// ──────────────────────────────────────────────────────────────

export const FLAG = "currency"
export const ALBUNA = "albuna"
/** Bronze in one of each coin. */
export const RATES = { cp: 1, sp: 100, gp: 2500 }
export const COINS = [
  { key: "gp", label: "Gold", abbr: "gp" },
  { key: "sp", label: "Silver", abbr: "sp" },
  { key: "cp", label: "Bronze", abbr: "bp" },
]
export const NOT_ALBUNA = ["pp", "ep"]
export const RATE_TEXT = "100 bronze = 1 silver · 25 silver = 1 gold"

const whole = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0 }

/** Is this actor on Albuna coins? (reads the flag off a document or plain data) */
export function isAlbuna(actor, mod = "pendant-bridge") {
  try {
    const v = typeof actor?.getFlag === "function" ? actor.getFlag(mod, FLAG) : actor?.flags?.[mod]?.[FLAG]
    return v === ALBUNA
  } catch { return false }
}

/** All Albuna coins as bronze. */
export const toBronze = (cur) => whole(cur?.gp) * RATES.gp + whole(cur?.sp) * RATES.sp + whole(cur?.cp)

/** Bronze → the fewest coins: { gp, sp, cp }. */
export function fromBronze(bronze) {
  let left = whole(bronze)
  const gp = Math.floor(left / RATES.gp); left -= gp * RATES.gp
  const sp = Math.floor(left / RATES.sp); left -= sp * RATES.sp
  return { gp, sp, cp: left }
}

/**
 * "Convert" on an Albuna sheet: gold / silver / bronze changed up to the
 * fewest coins at Albuna rates. pp and ep are left exactly as they are.
 * → the update for actor.update (only the three Albuna fields), or null when nothing changes.
 */
export function convertUpdate(cur) {
  const next = fromBronze(toBronze(cur))
  const same = whole(cur?.gp) === next.gp && whole(cur?.sp) === next.sp && whole(cur?.cp) === next.cp
  if (same) return null
  return { "system.currency.gp": next.gp, "system.currency.sp": next.sp, "system.currency.cp": next.cp }
}

/** A coin's name and abbreviation on an Albuna sheet (null for pp / ep). */
export const coin = (key) => COINS.find(c => c.key === key) || null

/** "3 gold, 12 silver, 40 bronze" (empty coins left out; "no coins" when none). */
export function purseText(cur) {
  const parts = COINS.map(c => [whole(cur?.[c.key]), c.label.toLowerCase()]).filter(([n]) => n).map(([n, l]) => `${n} ${l}`)
  return parts.length ? parts.join(", ") : "no coins"
}
