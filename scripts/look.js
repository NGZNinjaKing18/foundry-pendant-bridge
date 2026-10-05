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


let current = null          // the look being shown (null = stock)
let previewTimer = null
const ORIG = {}             // CONFIG values captured at init

// #rrggbb, or #rrggbbaa when the DM gave the colour some see-through.
const cssColor = (v) => (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(String(v || "")) ? v : null)
// A blend = { stops: [2–3 hex], dir: 'across'|'down'|'diagonal', amt }. → CSS gradient or null.
function blendCss(b, dirOverride) {
  const stops = (b && Array.isArray(b.stops) ? b.stops : []).filter(x => cssColor(x)).slice(0, 3)
  if (stops.length < 2) return null
  const dir = dirOverride || (b.dir === "down" ? "to bottom" : b.dir === "diagonal" ? "135deg" : "to right")
  return `linear-gradient(${dir}, ${stops.join(", ")})`
}
const gradientText = (g) => `background:${g};-webkit-background-clip:text;background-clip:text;color:transparent`
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
  // Foundry's interface colours, set one by one (each optional; missing = Foundry's own).
  const ui = look.colours || {}
  const vars = []
  const bg = cssColor(ui.panelBg)
  if (bg) vars.push(`--color-cool-5:${bg}`, `--color-cool-5-25:color-mix(in srgb, ${bg} 25%, transparent)`, `--color-cool-5-50:color-mix(in srgb, ${bg} 50%, transparent)`,
    `--color-cool-5-75:color-mix(in srgb, ${bg} 75%, transparent)`, `--color-cool-5-90:color-mix(in srgb, ${bg} 90%, transparent)`)
  if (cssColor(ui.panelBorder)) vars.push(`--color-cool-4:${ui.panelBorder}`)
  if (cssColor(ui.panelHover)) vars.push(`--color-cool-3:${ui.panelHover}`)
  if (cssColor(ui.highlight)) vars.push(`--color-warm-2:${ui.highlight}`, `--color-shadow-primary:${ui.highlight}`)
  if (acc) vars.push(`--pb-accent:${acc}`)
  if (acc && look.reach === "full") {
    // Same lever Foundry's own fantasy/sci-fi themes use: re-point the warm accents.
    vars.push(`--color-warm-1:${acc}`, `--color-warm-2:color-mix(in srgb, ${acc} 55%, #000)`,
      `--color-text-accent:${acc}`, `--color-shadow-primary:${acc}`, `--color-shadow-highlight:${acc}`, `--color-border-highlight:${acc}`)
  }
  const tint = Math.max(0, Math.min(30, Number(look.tint) || 0))
  if (acc && tint) {
    const b75 = bg ? `color-mix(in srgb, ${bg} 75%, transparent)` : "rgba(11, 10, 19, .75)"
    const b90 = bg ? `color-mix(in srgb, ${bg} 90%, transparent)` : "rgba(11, 10, 19, .9)"
    vars.push(`--color-cool-5-75:color-mix(in srgb, ${acc} ${tint}%, ${b75})`,
      `--color-cool-5-90:color-mix(in srgb, ${acc} ${Math.round(tint * 0.7)}%, ${b90})`)
  }
  // Panel opacity dial: every see-through panel layer (and the sidebar) times the dial.
  const op = look.opacity || {}
  const oPanels = Number.isFinite(op.panels) ? Math.max(0.1, Math.min(1, op.panels)) : 1
  if (oPanels < 1) {
    const base = bg || "#0b0a13"
    const pct = (n) => Math.round(n * oPanels)
    const v75 = acc && tint ? `color-mix(in srgb, ${acc} ${tint}%, color-mix(in srgb, ${base} ${pct(75)}%, transparent))` : `color-mix(in srgb, ${base} ${pct(75)}%, transparent)`
    const v90 = acc && tint ? `color-mix(in srgb, ${acc} ${Math.round(tint * 0.7)}%, color-mix(in srgb, ${base} ${pct(90)}%, transparent))` : `color-mix(in srgb, ${base} ${pct(90)}%, transparent)`
    vars.push(`--color-cool-5-25:color-mix(in srgb, ${base} ${pct(25)}%, transparent)`, `--color-cool-5-50:color-mix(in srgb, ${base} ${pct(50)}%, transparent)`,
      `--color-cool-5-75:${v75}`, `--color-cool-5-90:${v90}`, `--sidebar-background:color-mix(in srgb, ${base} ${pct(100)}%, transparent)`)
  }
  const fb = cssFont(look.fonts?.body), fh = cssFont(look.fonts?.head), fp = cssFont(look.fonts?.pause)
  if (fb) vars.push(`--font-body:${fb}, var(--font-sans)`, `--font-sans:${fb}, "Signika", ui-sans-serif, sans-serif`)
  if (fh) for (const n of [1, 2, 3, 4]) vars.push(`--font-h${n}:${fh}, var(--font-serif)`)
  if (vars.length) L.push(`body.pb-look{${vars.join(";")}}`)

  // Text colours — Foundry re-declares its text variables on every dark-themed
  // element (.themed.theme-dark), so they're set there too. Light-themed
  // windows keep Foundry's dark-on-light text.
  const T = look.text || {}
  const tv = []
  if (cssColor(T.textMain)) tv.push(`--color-text-primary:${T.textMain}`)
  if (cssColor(T.textSub)) tv.push(`--color-text-secondary:${T.textSub}`)
  if (cssColor(T.textFaint)) tv.push(`--color-text-subtle:${T.textFaint}`)
  if (cssColor(T.textHead)) tv.push(`--color-text-emphatic:${T.textHead}`)
  if (cssColor(T.textLink)) tv.push(`--content-link-text-color:${T.textLink}`, `--color-text-hyperlink:${T.textLink}`)
  const DARK = "body.pb-look.theme-dark, body.pb-look .themed.theme-dark"
  if (tv.length) L.push(`${DARK}{${tv.join(";")}}`)
  if (cssColor(T.textSub)) L.push(`body.pb-look.theme-dark{color:${T.textSub}}`)  // Foundry's body text is the secondary tier
  if (cssColor(T.textHead)) L.push(`body.pb-look :is(h1,h2,h3,h4):not(.theme-light *, .chat-message *){color:${T.textHead}}`)
  if (cssColor(T.textLink)) L.push(`body.pb-look a[href]:not(.theme-light *, .chat-message *){color:${T.textLink}}`)
  if (cssColor(T.chatText)) L.push(`body.pb-look .chat-message .message-content{color:${T.chatText}}`)

  // Light touch: the active control, the viewed scene, the campaign name.
  if (acc) {
    L.push(`body.pb-look #ui-left, body.pb-look #ui-right, body.pb-look #ui-middle{--control-active-border-color:${acc}}`)
    L.push(`body.pb-look #players .pb-campaign{color:${acc}}`)
  }
  {
    const g = blendCss(look.players?.nameBlend)
    if (g) L.push(`body.pb-look #players .pb-campaign{${gradientText(g)}}`)
  }

  // Chat
  const c = look.chat || {}
  if (c.paper === "dark") {
    L.push(`body.pb-look .chat-message:not(.whisper,.blind,.emote){--chat-message-background:var(--color-cool-5);--chat-message-border-color:var(--color-cool-4);color:var(--color-text-primary)}`,
      `body.pb-look .chat-message:not(.whisper,.blind,.emote) .message-header{color:var(--color-text-subtle)}`)
  } else if (c.paper === "tinted" && acc) {
    L.push(`body.pb-look .chat-message{--chat-message-background:linear-gradient(color-mix(in srgb, ${acc} 16%, transparent), color-mix(in srgb, ${acc} 16%, transparent)), url("${route("ui/parchment.jpg")}") repeat}`)
  }
  const edgeG = c.edge ? blendCss(c.edgeBlend, "to bottom") : null
  if (edgeG) L.push(`body.pb-look .chat-message:not(.whisper,.blind,.emote){border-left:5px solid transparent;border-image:${edgeG} 1;border-image-width:0 0 0 5px}`)
  else if (c.edge && acc) L.push(`body.pb-look .chat-message{border-left:5px solid ${acc}}`)
  if (cssColor(c.whisper) && c.whisper !== "#e8e8ef") L.push(`body.pb-look .chat-message{--color-whisper-background:${c.whisper}}`)
  if (cssColor(c.succ)) L.push(`body.pb-look .dice-roll .dice-total.success{color:${c.succ}}`)
  if (cssColor(c.fail)) L.push(`body.pb-look .dice-roll .dice-total.failure{color:${c.fail}}`)
  if (c.stamp === "world") L.push(`body.pb-look .chat-message .message-timestamp{display:none}`)

  // Pause (decorated by the renderGamePause hook below)
  const p = look.pause || {}
  const band = Math.max(0, Math.min(12, Number(p.band) || 0))
  if (band && acc) {
    L.push(`body.pb-look #pause.pb-look{background:linear-gradient(to right, transparent 0%, color-mix(in srgb, ${acc} ${band}%, var(--color-cool-5-50)) 40%, color-mix(in srgb, ${acc} ${band}%, var(--color-cool-5-50)) 60%, transparent 100%)}`)
  }
  // Frame lines above / below the band — the DM's colour, thickness, length, style.
  const fl = p.lines
  if (fl && typeof fl === "object") {
    const lc = cssColor(fl.color) || (acc ? `color-mix(in srgb, ${acc} 45%, transparent)` : "var(--color-cool-3)")
    const w = Math.max(1, Math.min(12, Number(fl.width) || 1))
    const side = (100 - Math.max(10, Math.min(100, Number(fl.len) || 56))) / 2
    const inset = Math.max(0, Math.min(60, Number(fl.inset) || 0))
    const st = ["dashed", "dotted", "double"].includes(fl.style) ? fl.style : null
    const paint = fl.style === "fade" ? `height:${w}px;background:linear-gradient(to right, transparent, ${lc} 20%, ${lc} 80%, transparent)`
      : st ? `height:0;border-top:${st === "double" ? Math.max(3, w) : w}px ${st} ${lc}` : `height:${w}px;background:${lc}`
    L.push(`body.pb-look #pause.pb-look::before, body.pb-look #pause.pb-look::after{content:"";position:absolute;left:${side}%;right:${side}%;${paint}}`,
      `body.pb-look #pause.pb-look::before{top:${inset}px} body.pb-look #pause.pb-look::after{bottom:${inset}px}`)
    if (fl.where === "top") L.push(`body.pb-look #pause.pb-look::after{display:none}`)
    if (fl.where === "bottom") L.push(`body.pb-look #pause.pb-look::before{display:none}`)
  }
  // Dim the map behind the pause band (an element under #pause, shown while paused).
  const dm = p.dim
  if (dm && typeof dm === "object") {
    const a = Math.max(0, Math.min(0.9, Number(dm.amount) || 0))
    L.push(`#pb-pause-dim{background:${cssColor(dm.color) || "#000000"};--pb-dim:${a}}`)
  }
  // The DM's own picture behind the band; the tint (or Foundry's dark) sits on top so text stays readable.
  if (p.bandImage) {
    const shade = band && acc ? `color-mix(in srgb, ${acc} ${band}%, var(--color-cool-5-50))` : "var(--color-cool-5-50)"
    L.push(`body.pb-look #pause.pb-look{background:linear-gradient(${shade}, ${shade}), url("${route(p.bandImage)}") center / cover no-repeat}`)
    if (p.bandFade !== false) L.push(`body.pb-look #pause.pb-look{-webkit-mask-image:linear-gradient(to right, transparent 0%, #000 22%, #000 78%, transparent 100%);mask-image:linear-gradient(to right, transparent 0%, #000 22%, #000 78%, transparent 100%)}`)
  }
  // Band blend: its own layer (added in renderGamePause), faded at the ends like Foundry's band.
  const bandG = blendCss(p.bandBlend)
  if (bandG) {
    const amt = Math.max(0.1, Math.min(0.9, (Number(p.bandBlend.amt) || 35) / 100))
    L.push(`body.pb-look #pause.pb-look .pb-pause-blend{position:absolute;inset:0;pointer-events:none;background:${bandG};opacity:${amt};-webkit-mask-image:linear-gradient(to right, transparent 0%, #000 30%, #000 70%, transparent 100%);mask-image:linear-gradient(to right, transparent 0%, #000 30%, #000 70%, transparent 100%)}`,
      `body.pb-look #pause.pb-look > :not(.pb-pause-blend){position:relative;z-index:1}`)
  }
  const textG = blendCss(p.textBlend)
  if (textG) L.push(`body.pb-look #pause.pb-look figcaption, body.pb-look #pause.pb-look .pb-pause-sub{${gradientText(textG)}}`)
  const pc = textG ? null : p.color === "accent" && acc ? acc : p.color === "light" ? "var(--color-light-1)" : null
  if (pc) L.push(`body.pb-look #pause.pb-look figcaption, body.pb-look #pause.pb-look .pb-pause-sub{color:${pc}}`)
  if (fp) L.push(`body.pb-look #pause.pb-look figcaption, body.pb-look #pause.pb-look .pb-pause-sub{font-family:${fp}, var(--font-serif)}`)
  // Pause type: the DM's sizes and spacing (only sent when changed from Foundry's).
  const ty = p.type
  if (ty && typeof ty === "object") {
    const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d }
    const k = n(ty.scale, 0.5, 3, 1)   // the "scale everything" dial
    const h = Math.round(n(ty.height, 100, 480, 180) * k), icon = Math.round(n(ty.icon, 32, 240, 100) * k)
    const caps = ty.caps === false ? "none" : "uppercase"
    L.push(`body.pb-look #pause.pb-look{height:${h}px;top:calc(50vh - ${Math.round(h / 2 + 10)}px);gap:${Math.round(n(ty.gap, 0, 80, 24) * k)}px}`,
      `body.pb-look #pause.pb-look img{width:${icon}px;height:${icon}px}`,
      `body.pb-look #pause.pb-look figcaption{font-size:${Math.round(n(ty.size1, 12, 96, 24) * k)}px;line-height:1.1;letter-spacing:${n(ty.track1, 0, 0.8, 0.3)}em;font-weight:${ty.bold1 === false ? "normal" : "bold"};text-transform:${caps};transform:translate(${Math.round(n(ty.x1, -600, 600, 0) * k)}px, ${Math.round(n(ty.y1, -300, 300, 0) * k)}px)}`,
      `body.pb-look #pause.pb-look .pb-pause-sub{font-size:${Math.round(n(ty.size2, 10, 64, 16) * k)}px;line-height:1.1;margin-top:0;letter-spacing:${n(ty.track2, 0, 0.8, 0.24)}em;font-weight:${ty.bold2 ? "bold" : "normal"};text-transform:${caps};transform:translate(${Math.round(n(ty.x2, -600, 600, 0) * k)}px, ${Math.round(n(ty.y2, -300, 300, 0) * k)}px)}`)
  }
  // Glow / shadow behind the words (filter, so it also works on blended text).
  const gl = p.glow
  if (gl && (gl.kind === "glow" || gl.kind === "shadow") && cssColor(gl.color)) {
    const s = Math.max(1, Math.min(48, Number(gl.size) || 12)) * Math.max(0.5, Math.min(3, Number(gl.scale) || 1))
    const r = (n) => Math.round(n * 10) / 10
    const f = gl.kind === "shadow" ? `drop-shadow(${r(s / 6)}px ${r(s / 4)}px ${r(s / 3)}px ${gl.color})`
      : `drop-shadow(0 0 ${r(s / 2)}px ${gl.color}) drop-shadow(0 0 ${r(s)}px ${gl.color})`
    L.push(`body.pb-look #pause.pb-look figcaption, body.pb-look #pause.pb-look .pb-pause-sub{filter:${f}}`)
  }
  // Pause opacity dials: band (its dark layer + blend), icon, each line.
  const o01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null)
  const oBand = o01(op.band), oIcon = o01(op.icon), oL1 = o01(op.line1), oL2 = o01(op.line2)
  if (oBand !== null) L.push(`body.pb-look #pause.pb-look{--color-cool-5-50:color-mix(in srgb, ${bg || "#0b0a13"} ${Math.round(50 * oBand)}%, transparent)} body.pb-look #pause.pb-look .pb-pause-blend{filter:opacity(${oBand})}`)
  if (oIcon !== null) L.push(`body.pb-look #pause.pb-look img{opacity:${oIcon}}`)
  if (oL1 !== null) L.push(`body.pb-look #pause.pb-look figcaption{opacity:${oL1}}`)
  if (oL2 !== null) L.push(`body.pb-look #pause.pb-look .pb-pause-sub{opacity:${Math.round(oL2 * 80) / 100}}`)
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
    ORIG.text = { fontFamily: CONFIG.canvasTextStyle?.fontFamily, fill: CONFIG.canvasTextStyle?.fill, fillGradientType: CONFIG.canvasTextStyle?.fillGradientType }
    ORIG.bar1 = CONFIG.Token?.barConfig?.bar1?.colors ? { ...CONFIG.Token.barConfig.bar1.colors } : null
  } catch (e) { console.warn(`${MOD} | look capture failed`, e) }
}
const CURSOR_FILES = { quill: "modules/pendant-bridge/assets/cursors/quill.svg", gauntlet: "modules/pendant-bridge/assets/cursors/gauntlet.svg" }
// The two other cursors Foundry shows (window corner, table column). They are not
// CONFIG.cursors states, so they get their own --cursor-* variable, read by
// scoped rules in styles/pendant-bridge.css (unset = the browser's own).
const EXTRA_CURSORS = ["nwse-resize", "ew-resize"]
let extraCursors = {}
function setExtraCursors() {
  const root = document.documentElement.style
  for (const k of EXTRA_CURSORS) {
    const c = extraCursors[k]
    if (c?.url) root.setProperty(`--cursor-${k}`, `url("${route(c.url)}") ${Number(c.x) || 0} ${Number(c.y) || 0}, ${k}`)
    else root.removeProperty(`--cursor-${k}`)
  }
}
function applyConfig(look) {
  let redraw = false
  try {
    // cursors: a built-in name, or the campaign's own set { states: { [state]: { url, x, y } } }
    CONFIG.cursors = foundry.utils.deepClone(ORIG.cursors || {})
    extraCursors = {}
    const own = look?.cursor && typeof look.cursor === "object" ? look.cursor.states : null
    if (own) {
      for (const [k, c] of Object.entries(own)) {
        if (!c?.url) continue
        if (EXTRA_CURSORS.includes(k)) extraCursors[k] = c
        else if (k in (CONST.CURSOR_STYLES || {})) CONFIG.cursors[k] = { url: route(c.url), x: Number(c.x) || 0, y: Number(c.y) || 0 }
      }
    } else {
      const cur = typeof look?.cursor === "string" ? (CURSOR_FILES[look.cursor] || look.cursor) : null
      if (cur) {
        const hot = look.cursor === "quill" ? { x: 2, y: 26 } : { x: 3, y: 3 }
        for (const k of ["default", "default-down", "pointer", "pointer-down"]) CONFIG.cursors[k] = { url: route(cur), ...hot }
      }
    }
    game.configureCursors?.()   // rewrites every --cursor-* variable, so the extras go on after
    setExtraCursors()
    // sounds
    if (CONFIG.sounds) {
      CONFIG.sounds.dice = look?.sounds?.dice || ORIG.sounds?.dice
      CONFIG.sounds.notification = look?.sounds?.notification || ORIG.sounds?.notification
    }
    // nameplates
    const ts = CONFIG.canvasTextStyle
    if (ts) {
      const fam = look?.names?.font ? `${look.names.font}, Signika` : ORIG.text?.fontFamily
      // A blend becomes a PIXI gradient fill (array of colours; 0 = top→bottom, 1 = left→right).
      const nb = look?.names?.blend
      const stops = nb && Array.isArray(nb.stops) ? nb.stops.filter(x => cssColor(x)).map(x => x.slice(0, 7)).slice(0, 3) : []  // PIXI fills ignore see-through
      const fill = stops.length >= 2 ? stops : (look?.names?.color || ORIG.text?.fill)
      const gType = stops.length >= 2 ? (nb.dir === "across" ? 1 : 0) : ORIG.text?.fillGradientType
      if (ts.fontFamily !== fam || JSON.stringify(ts.fill) !== JSON.stringify(fill) || ts.fillGradientType !== gType) {
        ts.fontFamily = fam; ts.fill = fill
        if (gType !== undefined) ts.fillGradientType = gType
        redraw = true
      }
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
  updateDim()
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
  // Which of the DM's rotating pause lines is showing — world-wide so every player sees the same one.
  game.settings.register(MOD, "lookPauseIdx", { scope: "world", config: false, type: Number, default: 0, onChange: () => { try { ui.pause?.render() } catch { /* */ } } })
  game.settings.register(MOD, "lookOptOut", {
    name: "PENDANT-BRIDGE.settings.lookOptOut.name", hint: "PENDANT-BRIDGE.settings.lookOptOut.hint",
    scope: "client", config: true, type: Boolean, default: false, onChange: () => applyLook(readSetting()),
  })
})
Hooks.once("setup", captureConfig)
Hooks.once("ready", () => { applyLook(readSetting()) })

// Pause screen: decorate Foundry's own <figure id="pause"> on every render.
// ── dimming the map while paused ─────────────────────────────
function updateDim() {
  let el = document.getElementById("pb-pause-dim")
  const want = !!(current?.pause?.dim && game.paused && !clientOptedOut(current))
  if (!el && !want) return
  if (!el) { el = document.createElement("div"); el.id = "pb-pause-dim"; document.body.appendChild(el) }
  el.classList.toggle("is-on", want)
}
Hooks.on("pauseGame", () => updateDim())
Hooks.on("renderGamePause", () => updateDim())

Hooks.on("renderGamePause", (app, el) => {
  const root = el instanceof HTMLElement ? el : el?.[0]
  if (!root) return
  root.classList.toggle("pb-look", !!current)
  if (!current) return
  const p = current.pause || {}
  if (p.bandBlend) {
    const layer = document.createElement("div")
    layer.className = "pb-pause-blend"
    root.prepend(layer)
  }
  const img = root.querySelector("img")
  if (img && p.icon) img.src = p.icon.startsWith("data:") ? p.icon : route(p.icon)
  if (img) img.classList.toggle("fa-spin", p.spin !== false)
  // Rotating lines fill their slot; the GM's client moves to the next one on each pause.
  let l1 = p.line1, l2 = p.line2
  const rot = p.rotate && Array.isArray(p.rotate.lines) && p.rotate.lines.length ? p.rotate : null
  if (rot) {
    let i = 0
    try { i = Number(game.settings.get(MOD, "lookPauseIdx")) || 0 } catch { /* */ }
    const line = rot.lines[((i % rot.lines.length) + rot.lines.length) % rot.lines.length]
    if (rot.slot === 1) l1 = line; else l2 = line
  }
  const cap = root.querySelector("figcaption")
  if (cap && l1) cap.innerText = l1
  if (l2) {
    const sub = document.createElement("div")
    sub.className = "pb-pause-sub"
    sub.textContent = l2
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

// Each pause moves the DM's rotating lines on by one (one GM does it, for everyone).
Hooks.on("pauseGame", (paused) => {
  if (!paused || !current?.pause?.rotate?.lines?.length) return
  const gm = game.users?.activeGM
  if (gm ? !gm.isSelf : !game.user?.isGM) return
  let i = 0
  try { i = Number(game.settings.get(MOD, "lookPauseIdx")) || 0 } catch { /* */ }
  game.settings.set(MOD, "lookPauseIdx", (i + 1) % 100000).catch?.(() => {})
})
