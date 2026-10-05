// ──────────────────────────────────────────────────────────────
// Box score — RealmScreen's end-of-session stat sheet.
//
// RealmScreen sends `stats.begin` when a campaign's session starts (this GM
// client stamps the moment, in Foundry's own clock) and `stats.collect` when it
// ends. Collecting reads the chat messages posted since that stamp — nothing is
// tracked live, so a reload or a disconnect mid-session loses nothing. RealmScreen
// builds the card (wording, season totals) and posts it with chat.send.
//
// Counted per player: rolls, natural 20s and 1s on kept d20s, damage and healing
// totals (dnd5e-style damage rolls), and the best single roll. Blind rolls are
// skipped so the card never leaks a secret.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"

Hooks.once("init", () => {
  game.settings.register(MOD, "boxScoreSince", { scope: "world", config: false, type: Object, default: null })
})

/** Mark the start of a campaign's session. */
export async function beginStats(campaignId) {
  const mark = { campaignId: campaignId || null, since: Date.now() }
  await game.settings.set(MOD, "boxScoreSince", mark)
  return mark
}

function rollKind(roll, message) {
  const o = roll.options || {}
  const types = [].concat(o.type || [], o.types || [], roll.data?.type || [])
  if (types.includes("healing") || types.includes("temphp")) return "healing"
  const name = roll.constructor?.name || ""
  const flag = message.flags?.dnd5e?.roll?.type || message.flags?.dnd5e?.messageType
  if (name === "DamageRoll" || flag === "damage") return "damage"
  return "check"
}

/** Tally the rolls since the mark (or `since`, ms). → { since, players: [...] } */
export function collectStats({ campaignId = null, since = 0 } = {}) {
  const mark = game.settings.get(MOD, "boxScoreSince") || {}
  const from = Number(since) || ((!campaignId || mark.campaignId === campaignId) ? Number(mark.since) || 0 : 0)
  const per = new Map()
  for (const m of game.messages) {
    if ((m.timestamp || 0) < from || !m.rolls?.length || m.blind) continue
    const u = m.author || m.user
    if (!u) continue
    let p = per.get(u.id)
    if (!p) per.set(u.id, p = { userId: u.id, name: u.name, isGM: !!u.isGM, characters: new Set(), rolls: 0, crits: 0, fumbles: 0, damage: 0, healing: 0, best: null })
    if (m.speaker?.alias && m.speaker.alias !== u.name) p.characters.add(m.speaker.alias)
    for (const r of m.rolls) {
      p.rolls++
      const kind = rollKind(r, m)
      const total = Number(r.total) || 0
      if (kind === "damage") p.damage += Math.max(0, total)
      else if (kind === "healing") p.healing += Math.max(0, total)
      for (const d of r.dice || []) {
        if (d.faces !== 20) continue
        for (const res of d.results || []) {
          if (res.active === false || res.discarded) continue
          if (res.result === 20) p.crits++
          if (res.result === 1) p.fumbles++
        }
      }
      if (kind === "check" && (p.best === null || total > p.best)) p.best = total
    }
  }
  return { since: from, players: [...per.values()].map(p => ({ ...p, characters: [...p.characters] })) }
}
