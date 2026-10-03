// ──────────────────────────────────────────────────────────────
// Campaign look — RealmScreen's per-campaign Foundry look.
//
// While a RealmScreen campaign's session runs, the app sends that campaign's
// look (`look.set`). The GM client stores it in the world setting
// `pendant-bridge.look`; every client applies it from that setting's onChange
// (and on ready, so late joiners match). Session end sends `look.set {look:null}`
// and Foundry goes back to stock.
//
// Native-first rules (the user's): everything is layered ONTO Foundry —
//   • colours/fonts = Foundry's own CSS variables, in one <style id="pb-look">,
//     scoped under body.pb-look (removed = stock again);
//   • the pause screen is decorated in the renderGamePause hook, never replaced;
//   • the Players list gets one row in renderPlayers;
//   • CONFIG values (cursors, sounds, nameplates, token bars) are snapshotted at
//     init and restored on clear;
//   • the only persisted Foundry change — core.combatTrackerConfig's turn marker —
//     is snapshotted by the GM before it's changed and put back on clear.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
const STYLE_ID = "pb-look"

// Foundry V14 palettes (css/foundry2.css: base, .mixin-theme-fantasy-variables, .mixin-theme-scifi-variables)
const PALETTES = {
  default: null,
  fantasy: { "warm-1": "#ee9b3a", "warm-2": "#603032", "warm-3": "#372021", "cool-3": "#251a1c", "cool-4": "#0c0609", "cool-5": "11, 9, 10" },
  scifi:   { "warm-1": "#3a9bee", "warm-2": "#303260", "warm-3": "#202137", "cool-3": "#202137", "cool-4": "#15151e", "cool-5": "11, 9, 10" },
}

let current = null          // the look being shown (null = stock)
let previewTimer = null
const ORIG = {}             // CONFIG values captured at init

const cssColor = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || "")) ? v : null)
const cssFont = (v) => (/^[A-Za-z0-9 ]{2,40}$/.test(String(v || "")) ? `"${v}"` : null)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const route = (p) => { try { return foundry.utils.getRoute(p) } catch { return "/" + p } }

function clientOptedOut(look) {
  try { return !!(look?.players?.optOut && game.settings.get(MOD, "lookOptOut")) } catch { return false }
}

// ── CSS ───────────────────────────────────────────────────────
function buildCss(look) {
  const L = []
  const acc = cssColor(look.accent)
  const pal = PALETTES[look.palette] || null
  const vars = []
  if (pal) {
    vars.push(`--color-warm-1:${pal["warm-1"]}`, `--color-warm-2:${pal["warm-2"]}`, `--color-warm-3:${pal["warm-3"]}`,
      `--color-cool-3:${pal["cool-3"]}`, `--color-cool-4:${pal["cool-4"]}`, `--color-cool-5:rgb(${pal["cool-5"]})`,
      `--color-cool-5-25:rgba(${pal["cool-5"]},.25)`, `--color-cool-5-50:rgba(${pal["cool-5"]},.5)`,
      `--color-cool-5-75:rgba(${pal["cool-5"]},.75)`, `--color-cool-5-90:rgba(${pal["cool-5"]},.9)`)
  }
  if (acc) vars.push(`--pb-accent:${acc}`)
  if (acc && look.reach === "full") {
    // Same lever Foundry's own fantasy/sci-fi themes use: re-point the warm accents.
    vars.push(`--color-warm-1:${acc}`, `--color-warm-2:color-mix(in srgb, ${acc} 55%, #000)`,
      `--color-text-accent:${acc}`, `--color-shadow-primary:${acc}`, `--color-shadow-highlight:${acc}`, `--color-border-highlight:${acc}`)
  }
  const tint = Math.max(0, Math.min(30, Number(look.tint) || 0))
  if (acc && tint) {
    const base5 = pal ? pal["cool-5"] : "11, 10, 19"
    vars.push(`--color-cool-5-75:color-mix(in srgb, ${acc} ${tint}%, rgba(${base5},.75))`,
      `--color-cool-5-90:color-mix(in srgb, ${acc} ${Math.round(tint * 0.7)}%, rgba(${base5},.9))`)
  }
  const fb = cssFont(look.fonts?.body), fh = cssFont(look.fonts?.head), fp = cssFont(look.fonts?.pause)
  if (fb) vars.push(`--font-body:${fb}, var(--font-sans)`, `--font-sans:${fb}, "Signika", ui-sans-serif, sans-serif`)
  if (fh) for (const n of [1, 2, 3, 4]) vars.push(`--font-h${n}:${fh}, var(--font-serif)`)
  if (vars.length) L.push(`body.pb-look{${vars.join(";")}}`)

  // Light touch: the active control, the viewed scene, the campaign name.
  if (acc) {
    L.push(`body.pb-look #ui-left, body.pb-look #ui-right, body.pb-look #ui-middle{--control-active-border-color:${acc}}`)
    L.push(`body.pb-look #players .pb-campaign{color:${acc}}`)
  }

  // Chat
  const c = look.chat || {}
  if (c.paper === "dark") {
    L.push(`body.pb-look .chat-message:not(.whisper,.blind,.emote){--chat-message-background:var(--color-cool-5);--chat-message-border-color:var(--color-cool-4);color:var(--color-light-2)}`,
      `body.pb-look .chat-message:not(.whisper,.blind,.emote) .message-header{color:var(--color-light-5)}`)
  } else if (c.paper === "tinted" && acc) {
    L.push(`body.pb-look .chat-message{--chat-message-background:linear-gradient(color-mix(in srgb, ${acc} 16%, transparent), color-mix(in srgb, ${acc} 16%, transparent)), url("${route("ui/parchment.jpg")}") repeat}`)
  }
  if (c.edge && acc) L.push(`body.pb-look .chat-message{border-left:5px solid ${acc}}`)
  if (cssColor(c.whisper) && c.whisper !== "#e8e8ef") L.push(`body.pb-look .chat-message{--color-whisper-background:${c.whisper}}`)
  if (cssColor(c.succ)) L.push(`body.pb-look .dice-roll .dice-total.success{color:${c.succ}}`)
  if (cssColor(c.fail)) L.push(`body.pb-look .dice-roll .dice-total.failure{color:${c.fail}}`)
  if (c.stamp === "world") L.push(`body.pb-look .chat-message .message-timestamp{display:none}`)

  // Pause (decorated by the renderGamePause hook below)
  const p = look.pause || {}
  const band = Math.max(0, Math.min(12, Number(p.band) || 0))
  if (band && acc) {
    L.push(`body.pb-look #pause.pb-look{background:linear-gradient(to right, transparent 0%, color-mix(in srgb, ${acc} ${band}%, var(--color-cool-5-50)) 40%, color-mix(in srgb, ${acc} ${band}%, var(--color-cool-5-50)) 60%, transparent 100%)}`,
      `body.pb-look #pause.pb-look::before, body.pb-look #pause.pb-look::after{content:"";position:absolute;left:22%;right:22%;height:1px;background:color-mix(in srgb, ${acc} 45%, transparent)}`,
      `body.pb-look #pause.pb-look::before{top:0} body.pb-look #pause.pb-look::after{bottom:0}`)
  }
  const pc = p.color === "accent" && acc ? acc : p.color === "light" ? "var(--color-light-1)" : null
  if (pc) L.push(`body.pb-look #pause.pb-look figcaption, body.pb-look #pause.pb-look .pb-pause-sub{color:${pc}}`)
  if (fp) L.push(`body.pb-look #pause.pb-look figcaption, body.pb-look #pause.pb-look .pb-pause-sub{font-family:${fp}, var(--font-serif)}`)
  if (p.motion === "gentle") L.push(`body.pb-look #pause.pb-look{animation-duration:6s} body.pb-look #pause.pb-look img.fa-spin{--fa-animation-duration:40s}`)
  if (p.motion === "still") L.push(`body.pb-look #pause.pb-look{animation:none} body.pb-look #pause.pb-look img{animation:none}`)
  L.push(`@media (prefers-reduced-motion: reduce){body.pb-look #pause.pb-look, body.pb-look #pause.pb-look img{animation:none}}`)

  // Players: hide the scene list from non-GMs
  if (look.players?.hideScenes && !game.user?.isGM) L.push(`body.pb-look #scene-navigation{display:none}`)
  return L.join("\n")
}

// ── fonts ─────────────────────────────────────────────────────
async function loadFonts(look) {
  const defs = look.fonts?.defs || {}
  const FC = foundry.applications?.settings?.menus?.FontConfig
  for (const [family, files] of Object.entries(defs)) {
    if (!Array.isArray(files) || !files.length) continue
    try {
      if (document.fonts.check(`1rem "${family}"`)) continue
      const def = { editor: false, fonts: files.map(f => ({ urls: (f.urls || []).map(u => route(u)), weight: f.weight || 400, style: f.style || "normal" })) }
      if (FC?.loadFont) await FC.loadFont(family, def)
    } catch (e) { console.warn(`${MOD} | look font ${family} failed`, e) }
  }
}

// ── CONFIG (cursors, sounds, nameplates, token bars) ──────────
function captureConfig() {
  try {
    ORIG.cursors = foundry.utils.deepClone(CONFIG.cursors || {})
    ORIG.sounds = { dice: CONFIG.sounds?.dice, notification: CONFIG.sounds?.notification }
    ORIG.text = { fontFamily: CONFIG.canvasTextStyle?.fontFamily, fill: CONFIG.canvasTextStyle?.fill }
    ORIG.bar1 = CONFIG.Token?.barConfig?.bar1?.colors ? { ...CONFIG.Token.barConfig.bar1.colors } : null
  } catch (e) { console.warn(`${MOD} | look capture failed`, e) }
}
const CURSOR_FILES = { quill: "modules/pendant-bridge/assets/cursors/quill.svg", gauntlet: "modules/pendant-bridge/assets/cursors/gauntlet.svg" }
function applyConfig(look) {
  let redraw = false
  try {
    // cursors
    const cur = look?.cursor ? (CURSOR_FILES[look.cursor] || look.cursor) : null
    CONFIG.cursors = foundry.utils.deepClone(ORIG.cursors || {})
    if (cur) {
      const hot = look.cursor === "quill" ? { x: 2, y: 26 } : { x: 3, y: 3 }
      for (const k of ["default", "default-down", "pointer", "pointer-down"]) CONFIG.cursors[k] = { url: route(cur), ...hot }
    }
    game.configureCursors?.()
    // sounds
    if (CONFIG.sounds) {
      CONFIG.sounds.dice = look?.sounds?.dice || ORIG.sounds?.dice
      CONFIG.sounds.notification = look?.sounds?.notification || ORIG.sounds?.notification
    }
    // nameplates
    const ts = CONFIG.canvasTextStyle
    if (ts) {
      const fam = look?.names?.font ? `${look.names.font}, Signika` : ORIG.text?.fontFamily
      const fill = look?.names?.color || ORIG.text?.fill
      if (ts.fontFamily !== fam || ts.fill !== fill) { ts.fontFamily = fam; ts.fill = fill; redraw = true }
    }
    // token bar 1
    const bc = CONFIG.Token?.barConfig?.bar1
    if (bc && ORIG.bar1) {
      const C = foundry.utils.Color
      const next = look?.bars ? { full: C.from(look.bars.full), empty: C.from(look.bars.empty) } : { ...ORIG.bar1 }
      if (String(bc.colors.full) !== String(next.full) || String(bc.colors.empty) !== String(next.empty)) { bc.colors = next; redraw = true }
    }
  } catch (e) { console.warn(`${MOD} | look config failed`, e) }
  if (redraw && canvas?.ready) { try { canvas.draw() } catch { /* next scene load picks it up */ } }
}

// ── apply / clear (every client) ──────────────────────────────
export async function applyLook(look) {
  const show = look && !clientOptedOut(look) ? look : null
  current = show
  document.getElementById(STYLE_ID)?.remove()
  document.body.classList.toggle("pb-look", !!show)
  if (show) {
    await loadFonts(show)
    const el = document.createElement("style")
    el.id = STYLE_ID
    el.textContent = buildCss(show)
    document.head.appendChild(el)
  }
  applyConfig(show)
  try { ui.pause?.render() } catch { /* not rendered yet */ }
  try { ui.players?.render() } catch { /* not rendered yet */ }
}
export const currentLook = () => current

// GM-only "try it": show a look on THIS client for a while, then revert.
export async function previewLook(look, seconds = 120) {
  clearTimeout(previewTimer)
  await applyLook(look)
  previewTimer = setTimeout(() => { applyLook(readSetting()) }, Math.max(5, Math.min(600, seconds)) * 1000)
}
function readSetting() { try { return game.settings.get(MOD, "look") || null } catch { return null } }

// ── GM-side persistence (called from the bridge command) ──────
export async function setLook(look, { announce = false } = {}) {
  if (!game.user?.isGM) throw new Error("Only the GM can set the campaign look")
  clearTimeout(previewTimer)
  await setTurnMarker(look?.turnMarker || null)
  await game.settings.set(MOD, "look", look || null)
  if (announce && look?.sessionCard) {
    try {
      await ChatMessage.create({
        speaker: { alias: game.user.name },
        content: `<div class="pb-session-card"><h3>${esc(look.sessionCard.title)}</h3>${look.sessionCard.sub ? `<p>${esc(look.sessionCard.sub)}</p>` : ""}</div>`,
        flags: { [MOD]: { sessionCard: true } },
      })
    } catch (e) { console.warn(`${MOD} | session card failed`, e) }
  }
  return { ok: true, campaignId: look?.campaignId || null }
}

// core.combatTrackerConfig is a persisted world setting: snapshot it before the
// first change, restore it exactly when the look clears.
async function setTurnMarker(tm) {
  const KEY = foundry.documents.Combat?.CONFIG_SETTING || "combatTrackerConfig"
  let snap = null
  try { snap = game.settings.get(MOD, "lookSnapshot") || null } catch { /* */ }
  const cur = game.settings.get("core", KEY)
  const plain = typeof cur?.toObject === "function" ? cur.toObject() : foundry.utils.deepClone(cur)
  if (tm) {
    if (!snap?.turnMarker) await game.settings.set(MOD, "lookSnapshot", { ...(snap || {}), turnMarker: plain.turnMarker })
    const next = { ...plain, turnMarker: { ...plain.turnMarker, enabled: true, animation: tm.animation || "spin", disposition: !!tm.disposition, ...(tm.src ? { src: tm.src } : {}) } }
    await game.settings.set("core", KEY, next)
  } else if (snap?.turnMarker) {
    await game.settings.set("core", KEY, { ...plain, turnMarker: snap.turnMarker })
    await game.settings.set(MOD, "lookSnapshot", { ...snap, turnMarker: null })
  }
}

// ── hooks ─────────────────────────────────────────────────────
Hooks.once("init", () => {
  game.settings.register(MOD, "look", { scope: "world", config: false, type: Object, default: null, onChange: (v) => applyLook(v) })
  game.settings.register(MOD, "lookSnapshot", { scope: "world", config: false, type: Object, default: null })
  game.settings.register(MOD, "lookOptOut", {
    name: "PENDANT-BRIDGE.settings.lookOptOut.name", hint: "PENDANT-BRIDGE.settings.lookOptOut.hint",
    scope: "client", config: true, type: Boolean, default: false, onChange: () => applyLook(readSetting()),
  })
})
Hooks.once("setup", captureConfig)
Hooks.once("ready", () => { applyLook(readSetting()) })

// Pause screen: decorate Foundry's own <figure id="pause"> on every render.
Hooks.on("renderGamePause", (app, el) => {
  const root = el instanceof HTMLElement ? el : el?.[0]
  if (!root) return
  root.classList.toggle("pb-look", !!current)
  if (!current) return
  const p = current.pause || {}
  const img = root.querySelector("img")
  if (img && p.icon) img.src = p.icon.startsWith("data:") ? p.icon : route(p.icon)
  if (img) img.classList.toggle("fa-spin", p.spin !== false)
  const cap = root.querySelector("figcaption")
  if (cap && p.line1) cap.innerText = p.line1
  if (p.line2) {
    const sub = document.createElement("div")
    sub.className = "pb-pause-sub"
    sub.textContent = p.line2
    root.appendChild(sub)
  }
})

// Players list: the campaign's name above the players.
Hooks.on("renderPlayers", (app, el) => {
  const root = el instanceof HTMLElement ? el : el?.[0]
  if (!root || !current?.players?.showName) return
  const box = root.querySelector("#players-active") || root
  if (box.querySelector(".pb-campaign")) return
  const div = document.createElement("div")
  div.className = "pb-campaign"
  div.textContent = current.campaignName || ""
  box.prepend(div)
})

// In-world time on chat messages (experimental): stamp each new message with the
// campaign's in-world time, show it beside Foundry's own time.
Hooks.on("preCreateChatMessage", (msg) => {
  const t = current?.chat?.worldTime
  if (!t || current?.chat?.stamp === "real") return
  try { msg.updateSource({ [`flags.${MOD}.worldTime`]: t }) } catch { /* */ }
})
Hooks.on("renderChatMessageHTML", (msg, html) => {
  const t = msg.getFlag?.(MOD, "worldTime")
  if (!t || !current || current.chat?.stamp === "real") return
  const meta = html.querySelector?.(".message-metadata")
  if (!meta || meta.querySelector(".pb-worldtime")) return
  const s = document.createElement("span")
  s.className = "pb-worldtime"
  s.textContent = t
  meta.prepend(s)
})
