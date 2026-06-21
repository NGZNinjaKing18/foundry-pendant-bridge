/**
 * Pendant Bridge — Foundry VTT companion module.
 *
 * Opens a WebSocket connection to pendant-home's Foundry Bridge relay
 * (default ws://localhost:30001), authenticates with role:"foundry", and
 * then:
 *   • forwards Foundry hooks (chat, actor, item, combat) outbound
 *   • executes inbound commands (roll dice, update inventory, send chat,
 *     fetch actor snapshots).
 *
 * The protocol is plain JSON over the WS. Every message carries:
 *   { type, ...payload, reqId? }
 * If a request includes a reqId the response echoes it so the client
 * can match call ↔ reply.
 */

const MOD = "pendant-bridge"

// ──────────────────────────────────────────────────────────────
// Anti-Hammer Space — slot-based encumbrance layered over the actor's
// EXISTING Foundry items (no second inventory to maintain). The DM sets a
// default capacity (in "spaces") plus a cost rule that turns each item's
// system data (weight × quantity, or size, or a flat count) into spaces;
// any single item can be hand-overridden. Going over capacity is allowed —
// the excess becomes "overflow points" the DM can spend on consequences.
//
// This object is the SINGLE SOURCE OF TRUTH for the maths: the on-sheet panel
// (renders on every player's client, no relay needed) and the DM's app tool
// (over the GM-only relay) both read the same numbers from here.
// ──────────────────────────────────────────────────────────────
const AH_PHYSICAL_TYPES = new Set([
  "weapon", "equipment", "consumable", "tool", "loot", "container", "backpack", "equipmentpack"
])

const AH = {
  defaults: {
    defaultCapacity: 20,     // spaces every actor has unless individually overridden
    costMode: "weight",      // "weight" | "count" | "size"
    weightPerSpace: 5,       // weight (× qty) that equals one space   (weight mode)
    minPerItem: 1,           // a carried item never costs fewer spaces than this
    roundEachItem: true,     // ceil each item up to a whole slot
    ignoreTypes: ["feat", "spell", "class", "subclass", "background", "race", "feature", "facility", "trait"],
    sizeSpaces: { tiny: 0.5, sm: 1, med: 1, lg: 2, huge: 4, grg: 8 },  // by dnd5e item size code (size mode)
  },

  /** The active config = saved world setting merged over defaults (so a missing key is safe). */
  cfg() {
    let saved = {}
    try { saved = game.settings.get(MOD, "ahConfig") || {} } catch {}
    const d = this.defaults
    return {
      ...d, ...saved,
      sizeSpaces:  { ...d.sizeSpaces, ...(saved.sizeSpaces || {}) },
      ignoreTypes: Array.isArray(saved.ignoreTypes) ? saved.ignoreTypes : d.ignoreTypes,
    }
  },

  /** Per-unit weight, tolerating dnd5e 3.x { value, units } and plain numbers. */
  itemWeight(it) {
    const w = it?.system?.weight
    if (w == null) return 0
    if (typeof w === "number") return w
    if (typeof w === "object") return Number(w.value) || 0
    const n = Number(w); return Number.isNaN(n) ? 0 : n
  },
  itemQty(it) {
    const q = it?.system?.quantity
    if (q == null) return 1
    const n = Number(q); return Number.isNaN(n) ? 1 : n
  },
  /** Does this item occupy bag space? Physical types + anything with a quantity, minus the ignore list. */
  counted(it, cfg) {
    if (!it) return false
    if ((cfg.ignoreTypes || []).includes(it.type)) return false
    if (AH_PHYSICAL_TYPES.has(it.type)) return true
    return it?.system?.quantity != null
  },
  /** Per-item override flag (number) or null. */
  itemOverride(it) {
    try { const v = it.getFlag(MOD, "spaces"); return (v == null || v === "") ? null : Number(v) } catch { return null }
  },
  /** Spaces a single item costs. `override` (when not null) wins over the computed value. */
  itemSpaces(it, cfg, override) {
    if (override != null && override !== "" && !Number.isNaN(Number(override))) return Number(override)
    const qty = this.itemQty(it)
    if (qty <= 0) return 0
    let s
    if (cfg.costMode === "count") s = 1
    else if (cfg.costMode === "size") { const code = it?.system?.size || "med"; s = (cfg.sizeSpaces[code] ?? 1) * qty }
    else { const per = cfg.weightPerSpace > 0 ? cfg.weightPerSpace : 1; s = (this.itemWeight(it) * qty) / per }
    if (cfg.roundEachItem) s = Math.ceil(s)
    s = Math.max(Number(cfg.minPerItem) || 0, s)
    return Math.round(s * 100) / 100
  },
  /** Resolved capacity for an actor + the raw override (null when using the world default). */
  capacityOf(actor, cfg) {
    let ov = null
    try { ov = actor.getFlag(MOD, "capacity") } catch {}
    if (ov == null || ov === "") return { capacity: Number(cfg.defaultCapacity) || 0, override: null }
    return { capacity: Number(ov) || 0, override: Number(ov) || 0 }
  },
  /** The full bag snapshot for one actor — what both surfaces render. */
  actorSummary(actor, cfg) {
    cfg = cfg || this.cfg()
    const items = []
    let used = 0
    for (const it of actor.items) {
      if (!this.counted(it, cfg)) continue
      const override = this.itemOverride(it)
      const spaces = this.itemSpaces(it, cfg, override)
      used += spaces
      items.push({ id: it.id, name: it.name, type: it.type, img: resolveImg(it.img), weight: this.itemWeight(it), qty: this.itemQty(it), spaces, override })
    }
    used = Math.round(used * 100) / 100
    const { capacity, override } = this.capacityOf(actor, cfg)
    const overflow = Math.max(0, Math.round((used - capacity) * 100) / 100)
    items.sort((a, b) => b.spaces - a.spaces || (a.name || "").localeCompare(b.name || ""))
    return {
      id: actor.id, name: actor.name, img: resolveImg(actor.img), type: actor.type,
      capacity, capacityOverride: override, used, overflow,
      free: Math.max(0, Math.round((capacity - used) * 100) / 100),
      itemCount: items.length, items,
    }
  },
}

// ──────────────────────────────────────────────────────────────
// Settings
// ──────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MOD, "enabled", {
    name:    `PENDANT-BRIDGE.settings.enabled.name`,
    hint:    `PENDANT-BRIDGE.settings.enabled.hint`,
    scope:   "client",
    config:  true,
    type:    Boolean,
    default: false,
    onChange: () => bridge.reconcile()
  })
  game.settings.register(MOD, "url", {
    name:    `PENDANT-BRIDGE.settings.url.name`,
    hint:    `PENDANT-BRIDGE.settings.url.hint`,
    scope:   "client",
    config:  true,
    type:    String,
    default: "ws://localhost:30001",
    onChange: () => bridge.reconcile()
  })
  game.settings.register(MOD, "token", {
    name:    `PENDANT-BRIDGE.settings.token.name`,
    hint:    `PENDANT-BRIDGE.settings.token.hint`,
    scope:   "client",
    config:  true,
    type:    String,
    default: "",
    onChange: () => bridge.reconcile()
  })
  game.settings.register(MOD, "gmOnly", {
    name:    `PENDANT-BRIDGE.settings.gmOnly.name`,
    hint:    `PENDANT-BRIDGE.settings.gmOnly.hint`,
    scope:   "client",
    config:  true,
    type:    Boolean,
    default: true,
    onChange: () => bridge.reconcile()
  })
  // Anti-Hammer Space config — world-scoped so every player's client reads the
  // GM's default capacity + cost rule. Edited from the app's DM tool (config:false
  // → not shown in Foundry's module-settings form; the app is the editor).
  game.settings.register(MOD, "ahConfig", {
    scope:   "world",
    config:  false,
    type:    Object,
    default: AH.defaults,
    onChange: () => ahOnConfigChanged()
  })
})

// ──────────────────────────────────────────────────────────────
// Connection
// ──────────────────────────────────────────────────────────────

const bridge = {
  ws: null,
  open: false,
  reconnectMs: 1000,                 // constant — sticky link, no backoff
  reconnectTimer: null,
  heartbeatTimer: null,              // sends a `ping` every 25s to keep the WS alive
  HEARTBEAT_MS: 25000,
  pendingHooks: false,
  hookOffs: [],

  /** Decide whether the bridge should be connecting and act on it. */
  reconcile() {
    const enabled = game.settings.get(MOD, "enabled")
    const gmOnly  = game.settings.get(MOD, "gmOnly")
    const ok = enabled && (!gmOnly || game.user.isGM)
    if (ok) this.connect()
    else    this.disconnect()
  },

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    const url = game.settings.get(MOD, "url")
    console.log("[pendant-bridge] connecting to", url)
    let ws
    try { ws = new WebSocket(url) }
    catch (e) { console.warn("[pendant-bridge] WS construct failed:", e); this.scheduleReconnect(); return }
    this.ws = ws
    this.gotHelloOk = false

    ws.addEventListener("open", () => {
      const token = game.settings.get(MOD, "token") || ""
      console.log("[pendant-bridge] socket OPEN — sending hello (token " + (token ? "set, len " + token.length : "EMPTY") + ")")
      ws.send(JSON.stringify({
        type:  "hello",
        role:  "foundry",
        token,
        label: `${game.user.name}@${game.world?.id || "world"}`
      }))
    })

    ws.addEventListener("message", (ev) => this.handleMessage(ev.data))

    ws.addEventListener("close", (ev) => {
      // The close code + reason is the single most useful diagnostic:
      //   1006 / no code  → never reached the relay (relay down? wrong port?)
      //   4001 "auth"      → relay rejected our token (hello:error also fired)
      //   1000 "shutdown"  → relay stopped cleanly
      // gotHelloOk tells us whether we dropped BEFORE or AFTER the handshake.
      console.warn(
        "[pendant-bridge] socket CLOSED — code=" + ev.code +
        " reason=" + JSON.stringify(ev.reason || "") +
        " wasClean=" + ev.wasClean +
        " handshakeCompleted=" + this.gotHelloOk
      )
      this.open = false
      updateIndicator(false)
      this.teardownHooks()
      this.stopHeartbeat()
      this.scheduleReconnect()
    })

    ws.addEventListener("error", (e) => {
      console.warn("[pendant-bridge] socket ERROR", e)
      try { ws.close() } catch {}
    })
  },

  disconnect() {
    this.open = false
    updateIndicator(false)
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null
    this.stopHeartbeat()
    this.teardownHooks()
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
  },

  scheduleReconnect() {
    if (!game.settings.get(MOD, "enabled")) return
    clearTimeout(this.reconnectTimer)
    // Constant 1s retry — keep the link sticky for the whole session.
    // The relay will reject us cleanly until it's back up; until then
    // we just hammer the door.
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs)
  },

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ type: "ping" })) } catch {}
      }
    }, this.HEARTBEAT_MS)
  },
  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  },

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    try { this.ws.send(JSON.stringify(obj)); return true }
    catch { return false }
  },

  reply(reqId, payload) {
    if (!reqId) return
    this.send({ ...payload, reqId })
  },

  handleMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    try {
      if (msg.type === "hello:ok") {
        console.log("[pendant-bridge] handshake OK — relay accepted us (id " + msg.id + ")")
        this.gotHelloOk = true
        this.open = true
        updateIndicator(true)
        this.setupHooks()
        this.startHeartbeat()
        ui.notifications?.info(game.i18n.localize("PENDANT-BRIDGE.notif.connected"))
        // Send an initial snapshot AFTER returning from this handler so a
        // big serialize or send error can't kill the WS in the same tick.
        // We also try/catch the snapshot itself; if any single actor's
        // serialization throws, the whole hello flow used to die silently.
        setTimeout(() => {
          let state
          try { state = snapshotState() }
          catch (e) {
            console.error("[pendant-bridge] snapshotState failed:", e)
            ui.notifications?.error("Pendant Bridge: failed to snapshot state — " + (e?.message || e))
            return
          }
          if (!this.send({ type: "state", state })) {
            console.warn("[pendant-bridge] initial state send failed (ws not open?)")
          }
        }, 0)
        return
      }
      if (msg.type === "hello:error") {
        console.warn("[pendant-bridge] relay REJECTED handshake:", msg.reason)
        ui.notifications?.error(`Pendant Bridge: ${msg.reason || "auth failed"}`)
        return
      }
      handleCommand(msg).catch(err => {
        console.warn("[pendant-bridge] command failed:", msg.type, err)
        this.reply(msg.reqId, { type: "error", reason: err?.message || String(err) })
      })
    } catch (e) {
      // Last-ditch: never let a message-handling error close the WS.
      console.error("[pendant-bridge] handleMessage threw:", e)
    }
  },

  // ── Hook subscriptions ────────────────────────────────────
  setupHooks() {
    if (this.pendingHooks) return
    this.pendingHooks = true

    const reg = (event, fn) => {
      const id = Hooks.on(event, fn)
      this.hookOffs.push(() => Hooks.off(event, id))
    }

    reg("createChatMessage", (msg) => {
      this.send({ type: "chat.message", message: serializeChat(msg) })
    })
    reg("deleteChatMessage", (msg) => {
      this.send({ type: "chat.delete", id: msg.id })
    })
    reg("updateActor", (actor, changes) => {
      this.send({ type: "actor.update", id: actor.id, changes, actor: serializeActorLight(actor) })
    })
    reg("deleteActor", (actor) => {
      this.send({ type: "actor.delete", id: actor.id })
    })
    reg("createActor", (actor) => {
      this.send({ type: "actor.create", actor: serializeActorLight(actor) })
    })
    reg("createItem", (item) => {
      if (!item.parent) return // unembedded world items — ignore for now
      this.send({ type: "item.create", actorId: item.parent.id, item: serializeItem(item) })
    })
    reg("updateItem", (item, changes) => {
      if (!item.parent) return
      this.send({ type: "item.update", actorId: item.parent.id, itemId: item.id, changes, item: serializeItem(item) })
    })
    reg("deleteItem", (item) => {
      if (!item.parent) return
      this.send({ type: "item.delete", actorId: item.parent.id, itemId: item.id })
    })
    reg("updateCombat", (combat) => {
      this.send({ type: "combat.update", combat: serializeCombat(combat) })
    })
    // Adding/removing a token to/from initiative fires combatant (not combat)
    // hooks — re-broadcast the parent combat so the app's in-combat state (and the
    // Scene View ⚔ icon) stays correct even after the menu is closed and reopened.
    const pushCombat = (c) => { if (c) this.send({ type: "combat.update", combat: serializeCombat(c) }) }
    reg("createCombatant", (cb) => pushCombat(cb.parent))
    reg("deleteCombatant", (cb) => pushCombat(cb.parent))
    reg("updateCombatant", (cb) => pushCombat(cb.parent))
    reg("createCombat", (c) => pushCombat(c))
    reg("deleteCombat", (c) => this.send({ type: "combat.update", combat: game.combat ? serializeCombat(game.combat) : null }))

    // ── Live scene mirror (COA Scene View) ───────────────────
    // Stream token moves/creates/deletes on the ACTIVE scene, and push the
    // whole active scene when the canvas (re)loads or the scene doc changes.
    reg("updateToken", (doc) => {
      if (!doc.parent?.active) return
      this.send({ type: "scene.token", sceneId: doc.parent.id, token: serializeToken(doc) })
    })
    reg("createToken", (doc) => {
      if (!doc.parent?.active) return
      this.send({ type: "scene.token", sceneId: doc.parent.id, token: serializeToken(doc) })
    })
    reg("deleteToken", (doc) => {
      if (!doc.parent?.active) return
      this.send({ type: "scene.token.delete", sceneId: doc.parent.id, id: doc.id })
    })
    reg("canvasReady", (canvas) => {
      const scene = canvas?.scene || game.scenes?.active
      if (!scene) return
      this.send({ type: "scene.active", scene: serializeSceneMeta(scene), tokens: scene.tokens.map(serializeToken) })
    })
    reg("updateScene", (scene, changes) => {
      // Only the live scene matters (activation, background swap, grid/dim edits).
      if (!scene.active && !("active" in (changes || {}))) return
      const active = scene.active ? scene : game.scenes?.active
      if (!active) return
      this.send({ type: "scene.active", scene: serializeSceneMeta(active), tokens: active.tokens.map(serializeToken) })
    })

    // Status effects live on the ACTOR's ActiveEffects, so a condition change does
    // NOT fire updateToken — re-push every active-scene token of that actor so the
    // Scene View redraws its effect icons in step with Foundry.
    const actorOfEffect = (eff) => { let p = eff?.parent; while (p && p.documentName !== "Actor") p = p.parent; return p || null }
    const pushTokensForActor = (actor) => {
      const scene = game.scenes?.active
      if (!actor || !scene) return
      for (const tdoc of scene.tokens) {
        if (tdoc.actor === actor || tdoc.actorId === actor.id) {
          this.send({ type: "scene.token", sceneId: scene.id, token: serializeToken(tdoc) })
        }
      }
    }
    reg("createActiveEffect", (eff) => pushTokensForActor(actorOfEffect(eff)))
    reg("updateActiveEffect", (eff) => pushTokensForActor(actorOfEffect(eff)))
    reg("deleteActiveEffect", (eff) => pushTokensForActor(actorOfEffect(eff)))
  },

  teardownHooks() {
    while (this.hookOffs.length) { try { this.hookOffs.pop()() } catch {} }
    this.pendingHooks = false
  }
}

// ──────────────────────────────────────────────────────────────
// Snapshot / serialization helpers
// ──────────────────────────────────────────────────────────────

/**
 * Resolve a Foundry-relative asset path (e.g. "worlds/myworld/img.png")
 * to an absolute URL the COA-side browser can fetch. The COA module is
 * loaded over file://, so relative paths can't resolve. Foundry usually
 * serves world/system/user assets publicly under its own origin.
 */
function resolveImg(p) {
  if (!p) return p
  if (/^(https?:|data:|blob:|file:|\/\/)/i.test(p)) return p
  return window.location.origin + "/" + String(p).replace(/^\/+/, "")
}

/**
 * The scene's map-image src. v14 moved the background off the Scene document onto
 * its first Level (`scene.firstLevel.background.src`); fall back to the legacy
 * top-level `scene.background.src` for v11–v13. Returns "" if none.
 */
function sceneBg(scene) {
  try { return scene?.firstLevel?.background?.src || scene?.background?.src || "" }
  catch { return scene?.background?.src || "" }
}

/**
 * Geometry the editor needs to map its image-space coords → scene space.
 * A Foundry scene pads its background inside a larger canvas, so the
 * top-left of the background sits at (sceneX, sceneY), NOT (0,0). Tile
 * coordinates are in the padded canvas space, so the editor must offset
 * by (sceneX, sceneY) and scale by the background's on-canvas size.
 *
 * `scene.dimensions` is a computed getter (v11+) that returns exactly
 * this. We fall back to a manual padding calc if it's unavailable.
 */
function sceneDimensions(scene) {
  try {
    const d = scene.dimensions
    if (d && Number.isFinite(d.sceneWidth)) {
      return {
        // sceneX/sceneY = top-left of the background within the padded canvas
        sceneX: d.sceneX, sceneY: d.sceneY,
        // sceneWidth/sceneHeight = background size in canvas px
        sceneWidth: d.sceneWidth, sceneHeight: d.sceneHeight,
        // full padded canvas size
        width: d.width, height: d.height,
        gridSize: d.size ?? scene.grid?.size ?? 100,
        gridDistance: d.distance ?? scene.grid?.distance ?? 5,
        padding: scene.padding ?? 0
      }
    }
  } catch {}
  // Manual fallback: pad each axis by ceil(padding * dim) rounded to grid.
  const w = Number(scene.width) || 0, h = Number(scene.height) || 0
  const pad = Number(scene.padding) || 0
  const grid = Number(scene.grid?.size) || 100
  const padX = Math.ceil((w * pad) / grid) * grid
  const padY = Math.ceil((h * pad) / grid) * grid
  return {
    sceneX: padX, sceneY: padY,
    sceneWidth: w, sceneHeight: h,
    width: w + 2 * padX, height: h + 2 * padY,
    gridSize: grid, gridDistance: Number(scene.grid?.distance) || 5, padding: pad
  }
}

/**
 * Build a Drawing document payload that validates across Foundry v11–v13.
 * Key robustness fixes (this is why drawings were silently failing before):
 *   • `author` is REQUIRED on DrawingDocument in v12+ — without it the
 *     create rejects. We default it to the current user.
 *   • Text drawings need real text + a zero stroke so they don't render an
 *     empty box; shape drawings need a visible stroke.
 *   • fillType uses the numeric CONST (0 none / 1 solid) Foundry expects.
 */
/**
 * Build a Wall document payload from a high-level wallType, mapping to the
 * right block flags across Foundry versions. v12 renamed the sight field
 * from `sense` → `sight`; we set BOTH so it works on v11–v13.
 * Block values: 0 = none (passes through), 20 = normal (blocks).
 */
/**
 * Build an AmbientLight payload. Supports color, dim/bright radii (scene
 * distance units), alpha (intensity), and an animation { type, speed,
 * intensity }. Animation type strings match Foundry's CONFIG.Canvas
 * .lightAnimations keys: "torch", "pulse", "chroma", "flame", etc.
 */
function buildLightData(l) {
  const config = { dim: Number(l.dim) || 0, bright: Number(l.bright) || 0 }
  if (l.color) config.color = l.color
  if (l.alpha != null) config.alpha = Number(l.alpha)
  if (l.angle != null) config.angle = Number(l.angle)
  if (l.animationType) {
    config.animation = {
      type: String(l.animationType),
      speed: l.animationSpeed != null ? Number(l.animationSpeed) : 5,
      intensity: l.animationIntensity != null ? Number(l.animationIntensity) : 5
    }
  }
  const out = { x: Number(l.x) || 0, y: Number(l.y) || 0, config, hidden: !!l.hidden }
  if (l.rotation != null) out.rotation = Number(l.rotation)
  return out
}

function buildWallData(w) {
  const c = (w.c || [w.x0, w.y0, w.x1, w.y1]).map(Number)
  const d = { c }
  const type = String(w.wallType || "wall")
  // Defaults: a normal wall blocks everything.
  let move = 20, sight = 20, sound = 20, light = 20, door = 0
  if (type === "door")   { door = 1 }
  else if (type === "secret") { door = 2 }
  else if (type === "window") {
    // Window: you can see and light passes, but you can't walk through
    // and sound is muffled.
    sight = 0; light = 0; move = 20; sound = 20
  }
  // explicit overrides win
  if (w.door  != null) door  = Number(w.door)
  if (w.move  != null) move  = Number(w.move)
  if (w.sight != null) sight = Number(w.sight)
  if (w.sense != null) sight = Number(w.sense)
  if (w.sound != null) sound = Number(w.sound)
  if (w.light != null) light = Number(w.light)
  d.move = move; d.sight = sight; d.sense = sight; d.sound = sound; d.light = light; d.door = door
  if (door > 0) d.ds = 0   // door state: closed
  return d
}

function buildDrawingData(d) {
  const t = String(d.shape || "rectangle")
  const shapeType = t === "ellipse" ? "e" : t === "polygon" ? "p" : "r"
  const isText = t === "text"
  const out = {
    author: game.user?.id,
    x: Number(d.x) || 0,
    y: Number(d.y) || 0,
    shape: {
      type:   shapeType,
      width:  Number(d.width)  || 100,
      height: Number(d.height) || 100
    },
    rotation:    Number(d.rotation) || 0,
    strokeWidth: isText ? 0 : (d.strokeWidth != null ? Number(d.strokeWidth) : 2),
    strokeColor: d.strokeColor || "#ffffff",
    strokeAlpha: d.strokeAlpha != null ? Number(d.strokeAlpha) : 1,
    fillType:    (!isText && d.fillColor) ? 1 : 0,
    fillColor:   d.fillColor || "#000000",
    fillAlpha:   d.fillAlpha != null ? Number(d.fillAlpha) : 0.5,
    hidden:      !!d.hidden
  }
  if (Array.isArray(d.points) && d.points.length) out.shape.points = d.points
  if (isText || d.text) {
    out.text       = String(d.text || "")
    out.fontSize   = Number(d.fontSize) || 28
    out.fontFamily = d.fontFamily || "Signika"
    out.textColor  = d.textColor || "#ffffff"
    out.textAlpha  = d.textAlpha != null ? Number(d.textAlpha) : 1
    // A text drawing with no fill/stroke still needs SOMETHING to anchor
    // its bounds; Foundry renders the text fine with strokeWidth 0.
  }
  return out
}

function snapshotState() {
  // Per-item try/catch so a single actor's data quirks don't kill the
  // whole snapshot (e.g. modules attaching weird non-serializable junk).
  const actors = []
  for (const a of game.actors) {
    try { actors.push(serializeActorLight(a)) }
    catch (e) { console.warn("[pendant-bridge] skipping actor", a?.id, a?.name, e) }
  }
  const recentChat = []
  for (const m of game.messages.contents.slice(-50)) {
    try { recentChat.push(serializeChat(m)) }
    catch (e) { console.warn("[pendant-bridge] skipping chat msg", m?.id, e) }
  }
  return {
    user:  { id: game.user.id, name: game.user.name, isGM: game.user.isGM },
    world: { id: game.world?.id, title: game.world?.title, system: game.system?.id },
    system: { id: game.system?.id, version: game.system?.version },
    foundryOrigin: window.location.origin,
    actors,
    recentChat
  }
}

function serializeActorLight(actor) {
  // Prototype-token texture + grid footprint, so the editor can place a
  // token that looks like the real thing (token art, not the portrait).
  let tokenImg = null, tokenW = 1, tokenH = 1
  try {
    const pt = actor.prototypeToken
    tokenImg = resolveImg((pt && pt.texture && pt.texture.src) || actor.img)
    tokenW = (pt && pt.width) || 1
    tokenH = (pt && pt.height) || 1
  } catch { tokenImg = resolveImg(actor.img) }
  // Level (PCs) or Challenge Rating (NPCs) — for the Tokens palette readout.
  let level = null
  try {
    const d = actor.system?.details
    level = d?.level ?? d?.cr ?? null
  } catch {}
  return {
    id:      actor.id,
    name:    actor.name,
    type:    actor.type,
    img:     resolveImg(actor.img),
    tokenImg, tokenW, tokenH,
    hp:      readHP(actor),
    level,
    ownership: actor.ownership,
    folder:  actor.folder?.id || null
  }
}

/** Full actor data — includes items + system data + rollData. Use sparingly. */
function serializeActorFull(actor) {
  const data = actor.toObject(false)
  // rollData is Foundry's pre-computed "roll formula" namespace —
  // e.g. @attributes.ac.value, @abilities.str.mod, @prof. It has
  // active effects + class progression already applied, and matches
  // what Foundry uses in its own rolls. Far more reliable to read
  // than raw system JSON which varies by game system version.
  // We round-trip through JSON to drop any non-serializable junk.
  let rollData = null
  try { rollData = JSON.parse(JSON.stringify(actor.getRollData?.() ?? {})) }
  catch (e) { console.warn("[pendant-bridge] getRollData failed for", actor.name, e) }
  return {
    id:    actor.id,
    name:  actor.name,
    type:  actor.type,
    img:   resolveImg(actor.img),
    hp:    readHP(actor),
    system: data.system,
    rollData,
    flags: data.flags,        // includes ddb-importer URL, etc.
    items: actor.items.map(serializeItem),
    effects: actor.effects.map(e => ({
      id: e.id,
      name: e.name || e.label,
      icon: resolveImg(e.icon || e.img),
      disabled: e.disabled,
      statuses: Array.from(e.statuses || []),   // condition ids (blinded, prone, …)
      origin: e.origin || null
    })),
    ownership: actor.ownership,
    prototypeToken: data.prototypeToken
  }
}

function serializeItem(item) {
  const data = item.toObject(false)
  return {
    id:     item.id,
    name:   item.name,
    type:   item.type,
    img:    resolveImg(item.img),
    system: data.system,
    flags:  data.flags
  }
}

function serializeChat(msg) {
  // Prefer msg.author (v12+) but fall back to msg.user (v11). Either way
  // we want the live User document so we can grab the display name —
  // if `speaker.alias` is empty (e.g. an OOC message with no actor),
  // the client falls back to this name instead of "Unknown".
  const author = msg.author || msg.user || null
  return {
    id:       msg.id,
    user:     author?.id || null,
    userName: author?.name || null,
    speaker:  msg.speaker,
    content: msg.content,
    rolls:   (msg.rolls || []).map(r => ({
      formula: r.formula,
      total:   r.total,
      dice:    (r.dice || []).map(d => ({
        faces:   d.faces,
        results: (d.results || []).map(x => ({ result: x.result, active: x.active }))
      }))
    })),
    flavor:    msg.flavor,
    type:      msg.type,
    timestamp: msg.timestamp,
    whisper:   msg.whisper
  }
}

function serializeCombat(c) {
  return {
    id:      c.id,
    round:   c.round,
    turn:    c.turn,
    active:  c.active,
    started: c.started,
    // The Combatant whose turn it is, plus the ids in Foundry's OWN sorted
    // turn order — so the client can highlight the active row exactly instead
    // of re-deriving order from raw (unsorted) initiative values.
    current:   c.combatant?.id || null,
    turnOrder: (c.turns || []).map(t => t.id),
    combatants: c.combatants.map(cb => ({
      id: cb.id, actorId: cb.actorId, tokenId: cb.tokenId, name: cb.name, initiative: cb.initiative,
      hidden: cb.hidden, defeated: cb.defeated
    }))
  }
}

/**
 * The status-effect icons Foundry draws ON a token: the token's own legacy
 * `effects` icon paths plus the actor's temporary (condition) effect icons. A
 * separate `overlay` is the big centred mark (e.g. the "dead" skull). `statuses`
 * is the set of active status ids, so the quick-menu can show which are on.
 */
function tokenEffects(t) {
  const icons = [], statuses = new Set()
  let overlay = null
  for (const e of (t.effects || [])) if (e) icons.push(resolveImg(e))   // legacy direct token effects
  const actor = t.actor
  if (actor) {
    const temp = actor.temporaryEffects || []
    for (const eff of temp) {
      if (eff.disabled) continue
      const img = resolveImg(eff.img || eff.icon || "")
      const isOverlay = (eff.getFlag && eff.getFlag("core", "overlay")) || eff.flags?.core?.overlay
      if (isOverlay && img) { overlay = img; continue }
      if (img) icons.push(img)
      try { for (const s of (eff.statuses || [])) statuses.add(s) } catch {}
    }
    try { if (actor.statuses) for (const s of actor.statuses) statuses.add(s) } catch {}
  }
  return { icons, overlay, statuses: [...statuses] }
}

/**
 * A token on the live scene — enough for the COA Scene View to draw it 1:1:
 * resolved art, padded-canvas position (x/y), grid footprint (width/height in
 * grid units), rotation, hidden flag, actor binding, and its status effects.
 */
function serializeToken(t) {
  const fx = tokenEffects(t)
  return {
    id:       t.id,
    name:     t.name || "",
    src:      resolveImg((t.texture && t.texture.src) || t.img || ""),
    x:        t.x, y: t.y,
    width:    t.width, height: t.height,
    rotation: t.rotation || 0,
    hidden:   !!t.hidden,
    elevation: t.elevation || 0,
    actorId:  t.actorId || null,
    effects:  fx.icons,        // status-effect icon URLs (drawn on the token)
    overlay:  fx.overlay,      // big centred overlay icon (e.g. dead), or null
    statuses: fx.statuses      // active status ids (for the quick-menu highlight)
  }
}

/** Active-scene meta the Scene View needs: background art + geometry + grid. */
function serializeSceneMeta(scene) {
  if (!scene) return null
  // gridColor / gridAlpha: v11 stored these at the top level (scene.gridColor,
  // scene.gridAlpha); v12+ moved them inside scene.grid. Try both so the
  // Scene View renders the correct lines regardless of Foundry version.
  return {
    id:         scene.id,
    name:       scene.name,
    active:     !!scene.active,
    background: resolveImg(sceneBg(scene)),
    thumb:      resolveImg(scene.thumb || sceneBg(scene)),
    dimensions: sceneDimensions(scene),
    gridType:   scene.grid?.type ?? 1,
    gridColor:  scene.grid?.color  || scene.gridColor  || "#000000",
    gridAlpha:  scene.grid?.alpha  ?? scene.gridAlpha  ?? 0.2
  }
}

// ──────────────────────────────────────────────────────────────
// Chunked file uploads
// ──────────────────────────────────────────────────────────────
// The client sends a binary file as a stream of base64 chunks because
// the WS relay only forwards text frames. We assemble them here and
// hand the resulting Blob to FilePicker.upload() — Foundry handles
// the actual write into world/system storage from there.
const _uploads = new Map()  // uploadId → { filename, kind, mimeType, chunks: [] }

// FilePicker moved to the foundry.applications.apps namespace in v13 and the
// global `FilePicker` was REMOVED in v14. Resolve the active class from the
// namespace (preferring the configured `.implementation`), falling back to the
// old global for v11–v13. Its static upload/browse/createDirectory are unchanged.
function getFilePicker() {
  return foundry?.applications?.apps?.FilePicker?.implementation
      ?? foundry?.applications?.apps?.FilePicker
      ?? globalThis.FilePicker
}

function _uploadFolderFor(kind) {
  const worldId = game.world?.id || "world"
  switch (kind) {
    case "map":   return `worlds/${worldId}/maps`
    case "token": return `worlds/${worldId}/tokens`
    case "portrait": return `worlds/${worldId}/portraits`
    default:      return `worlds/${worldId}/assets`
  }
}

function uploadBegin(msg) {
  if (!msg.uploadId) throw new Error("upload.begin missing uploadId")
  _uploads.set(msg.uploadId, {
    filename: String(msg.filename || "upload.bin"),
    kind:     String(msg.kind     || "asset"),
    mimeType: String(msg.mimeType || "application/octet-stream"),
    dedup:    !!msg.dedup,                                  // skip the write if the same filename already exists
    subfolder: msg.subfolder ? String(msg.subfolder) : "", // optional extra folder under the kind dir
    chunks:   []
  })
}

function uploadChunk(msg) {
  const u = _uploads.get(msg.uploadId)
  if (!u) throw new Error("Unknown uploadId: " + msg.uploadId)
  // chunks may arrive out of order — store by seq.
  u.chunks[Number(msg.seq) || 0] = String(msg.dataBase64 || "")
}

async function uploadEnd(msg) {
  const u = _uploads.get(msg.uploadId)
  if (!u) throw new Error("Unknown uploadId: " + msg.uploadId)
  _uploads.delete(msg.uploadId)

  const FP = getFilePicker()
  if (!FP) throw new Error("FilePicker unavailable in this Foundry version")
  const folder = _uploadFolderFor(u.kind) + (u.subfolder ? "/" + u.subfolder : "")
  // Ensure the destination folder exists (no-op if it does).
  try { await FP.createDirectory("data", folder, {}) } catch {}

  // De-dup: the client bakes an 8-char content hash into the filename, so a name
  // collision IS a content match — skip the write and reuse the existing path.
  if (u.dedup) {
    try {
      const listing = await FP.browse("data", folder)
      const hit = (listing?.files || []).find(p => p === folder + "/" + u.filename || p.split("/").pop() === u.filename)
      if (hit) return { path: hit, deduped: true }
    } catch { /* browse failed → fall through and just write it */ }
  }

  // Concatenate all chunks (in order) into one base64 string, decode to a
  // Uint8Array, wrap in a File, hand off to FilePicker.upload().
  const fullB64 = u.chunks.join("")
  const bin = atob(fullB64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const file = new File([bytes], u.filename, { type: u.mimeType })

  const result = await FP.upload("data", folder, file, {}, { notify: false })
  if (!result || !result.path) throw new Error("FilePicker.upload returned no path")
  return { path: result.path, deduped: false }
}

/** Best-effort HP read across game systems. Falls back to null. */
function readHP(actor) {
  try {
    const hp = actor.system?.attributes?.hp ?? actor.system?.hp
    if (hp && typeof hp === "object") return { value: hp.value, max: hp.max, temp: hp.temp ?? null }
  } catch {}
  return null
}

// ──────────────────────────────────────────────────────────────
// Inbound command handler
// ──────────────────────────────────────────────────────────────

async function handleCommand(msg) {
  switch (msg.type) {

    case "ping":
      return bridge.reply(msg.reqId, { type: "pong" })

    case "state.request":
      return bridge.reply(msg.reqId, { type: "state", state: snapshotState() })

    case "actor.list":
      return bridge.reply(msg.reqId, {
        type: "actor.list",
        actors: game.actors.map(serializeActorLight)
      })

    case "actor.get": {
      const a = game.actors.get(msg.id)
      if (!a) throw new Error("Actor not found: " + msg.id)
      return bridge.reply(msg.reqId, { type: "actor", actor: serializeActorFull(a) })
    }

    case "actor.update": {
      const a = game.actors.get(msg.id)
      if (!a) throw new Error("Actor not found: " + msg.id)
      await a.update(msg.changes || {})
      return bridge.reply(msg.reqId, { type: "actor", actor: serializeActorFull(a) })
    }

    case "item.create": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      const created = await a.createEmbeddedDocuments("Item", Array.isArray(msg.items) ? msg.items : [msg.item])
      return bridge.reply(msg.reqId, { type: "item.created", items: created.map(serializeItem) })
    }

    case "item.update": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      const item = a.items.get(msg.itemId)
      if (!item) throw new Error("Item not found: " + msg.itemId)
      await item.update(msg.changes || {})
      return bridge.reply(msg.reqId, { type: "item.updated", item: serializeItem(item) })
    }

    case "item.delete": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      await a.deleteEmbeddedDocuments("Item", [msg.itemId])
      return bridge.reply(msg.reqId, { type: "item.deleted", actorId: msg.actorId, itemId: msg.itemId })
    }

    case "chat.send": {
      const data = {
        content:  String(msg.content ?? ""),
        speaker:  msg.speaker || ChatMessage.getSpeaker(),
        whisper:  msg.whisper || [],
        flavor:   msg.flavor || ""
      }
      if (msg.rollMode) data.rollMode = msg.rollMode
      const m = await ChatMessage.create(data)
      return bridge.reply(msg.reqId, { type: "chat.sent", id: m.id })
    }

    case "roll.formula": {
      const r = new Roll(String(msg.formula || "1d20"), msg.data || {})
      await r.evaluate()   // sync-eval (the `async` option) was removed; evaluate() is async
      if (msg.toChat !== false) {
        const speaker = msg.speaker || (msg.actorId ? ChatMessage.getSpeaker({ actor: game.actors.get(msg.actorId) }) : ChatMessage.getSpeaker())
        await r.toMessage({ flavor: msg.flavor || "", speaker, rollMode: msg.rollMode })
      }
      return bridge.reply(msg.reqId, {
        type: "roll.result",
        formula: r.formula,
        total: r.total,
        dice: r.dice.map(d => ({ faces: d.faces, results: d.results.map(x => ({ result: x.result, active: x.active })) })),
        result: r.result
      })
    }

    case "chat.history": {
      const n = Math.min(Number(msg.limit) || 50, 500)
      return bridge.reply(msg.reqId, {
        type: "chat.history",
        messages: game.messages.contents.slice(-n).map(serializeChat)
      })
    }

    // ── File uploads (chunked) ────────────────────────────────
    // upload.begin → server allocates a buffer keyed by uploadId
    // upload.chunk → appends base64 chunks
    // upload.end   → assembles, calls FilePicker.upload(), replies done
    case "upload.begin": {
      uploadBegin(msg)
      return bridge.reply(msg.reqId, { type: "upload.ready", uploadId: msg.uploadId })
    }
    case "upload.chunk": {
      uploadChunk(msg)
      return
    }
    case "upload.end": {
      const out = await uploadEnd(msg)
      return bridge.reply(msg.reqId, { type: "upload.done", uploadId: msg.uploadId, path: out.path, deduped: !!out.deduped })
    }

    // ── Create actor ──────────────────────────────────────────
    case "actor.create": {
      const data = {
        name: String(msg.name || "New Actor"),
        type: String(msg.type || "character")
      }
      if (msg.img) data.img = msg.img
      if (msg.tokenImg) {
        data.prototypeToken = { texture: { src: msg.tokenImg } }
      }
      if (msg.system) data.system = msg.system
      const actor = await Actor.create(data)
      return bridge.reply(msg.reqId, { type: "actor.created", actor: serializeActorFull(actor) })
    }

    // ── Compendium browsing ───────────────────────────────────
    // List every Item-bearing pack so the COA picker can scope searches.
    case "compendium.list": {
      const packs = []
      for (const p of game.packs) {
        if (p.documentName !== "Item") continue
        packs.push({
          id:     p.metadata.id || p.collection,
          label:  p.metadata.label || p.title,
          system: p.metadata.system || null,
          itemCount: p.index?.size ?? 0
        })
      }
      return bridge.reply(msg.reqId, { type: "compendium.list", packs })
    }

    // Search Item compendiums. `query` is matched case-insensitively
    // against name; optional `type` filters by item type (weapon, spell,
    // tool, etc); optional `packId` scopes to one pack.
    case "compendium.search": {
      const q     = String(msg.query || "").toLowerCase().trim()
      const limit = Math.min(Number(msg.limit) || 60, 250)
      const filterPack = msg.packId   ? String(msg.packId)   : null
      const filterType = msg.itemType ? String(msg.itemType) : null
      const results = []
      let packsTotal    = 0
      let packsSearched = 0
      let entriesScanned = 0
      for (const p of game.packs) {
        if (p.documentName !== "Item") continue
        packsTotal++
        if (filterPack && (p.metadata.id || p.collection) !== filterPack) continue
        // Some packs lazy-load their index — make sure it's populated
        // before iterating, otherwise we'd silently skip them.
        let index = p.index
        if (!index || index.size === 0) {
          try { index = await p.getIndex() }
          catch (e) {
            console.warn("[pendant-bridge] getIndex failed for", p.metadata.id, e)
            continue
          }
        }
        packsSearched++
        for (const entry of index) {
          entriesScanned++
          if (filterType && entry.type !== filterType) continue
          if (q && !(entry.name || "").toLowerCase().includes(q)) continue
          results.push({
            packId: p.metadata.id || p.collection,
            packLabel: p.metadata.label || p.title,
            itemId: entry._id,
            name:   entry.name,
            type:   entry.type,
            img:    resolveImg(entry.img)
          })
          if (results.length >= limit) break
        }
        if (results.length >= limit) break
      }
      return bridge.reply(msg.reqId, {
        type: "compendium.results",
        results,
        meta: { packsTotal, packsSearched, entriesScanned, query: q, filterType, filterPack }
      })
    }

    // Pull an item from a compendium and add a copy to the actor.
    case "compendium.add-to-actor": {
      const pack = game.packs.get(msg.packId)
      if (!pack) throw new Error("Pack not found: " + msg.packId)
      const item = await pack.getDocument(msg.itemId)
      if (!item) throw new Error("Item not found in pack: " + msg.itemId)
      const actor = game.actors.get(msg.actorId)
      if (!actor) throw new Error("Actor not found: " + msg.actorId)
      const data = item.toObject()
      delete data._id   // let Foundry generate a fresh id for the copy
      const created = await actor.createEmbeddedDocuments("Item", [data])
      return bridge.reply(msg.reqId, {
        type: "item.created", items: created.map(serializeItem)
      })
    }

    // ── Create scene from an uploaded image ───────────────────
    case "scene.create": {
      const cfg = msg.config || {}
      const b = cfg.basics || {}, g = cfg.grid || {}, l = cfg.lighting || {}, am = cfg.ambience || {}
      const num = (v, d) => (v != null && isFinite(+v) ? +v : d)
      const data = {
        name: String(msg.name || b.name || "New Scene"),
        background: { src: msg.imgPath },
        width:  Number(msg.width)  || 4000,
        height: Number(msg.height) || 3000,
        padding: num(g.padding, msg.padding != null ? Number(msg.padding) : 0.25),
      }
      if (g.offsetX != null) data.background.offsetX = num(g.offsetX, 0)
      if (g.offsetY != null) data.background.offsetY = num(g.offsetY, 0)
      if (b.navigation != null) data.navigation = !!b.navigation
      if (b.navName) data.navName = String(b.navName)
      if (b.backgroundColor) data.backgroundColor = String(b.backgroundColor)
      if (b.foreground) data.foreground = String(b.foreground)
      if (b.foregroundElevation != null) data.foregroundElevation = num(b.foregroundElevation, 20)
      if (b.ownership != null) data.ownership = { default: num(b.ownership, 0) }

      // Grid — v12 carries color/alpha/style/thickness IN the grid object; v11 reads
      // them top-level. We set BOTH; Foundry cleans whichever the running version
      // doesn't recognise, so one payload works across 11–13.
      const gridType = num(g.type, 1), gridColor = g.color || "#000000", gridAlpha = num(g.alpha, 0.2)
      data.grid = { type: gridType, size: num(g.size, 100), distance: num(g.distance, 5), units: g.units != null ? String(g.units) : "ft", style: g.style || "solidLines", thickness: num(g.thickness, 1), color: gridColor, alpha: gridAlpha }
      data.gridType = gridType; data.gridColor = gridColor; data.gridAlpha = gridAlpha

      // Vision / fog (v12 nested `fog` + v11 top-level fog* keys).
      if (l.tokenVision != null) data.tokenVision = !!l.tokenVision
      const fogExp = l.fogExploration != null ? !!l.fogExploration : true
      data.fog = { exploration: fogExp, overlay: l.fogOverlay || null, colors: { unexplored: l.fogUnexploredColor || null, explored: l.fogExploredColor || null } }
      data.fogExploration = fogExp
      if (l.fogOverlay) data.fogOverlay = String(l.fogOverlay)
      if (l.fogUnexploredColor) data.fogUnexploredColor = l.fogUnexploredColor
      if (l.fogExploredColor) data.fogExploredColor = l.fogExploredColor

      // Lighting / ambience (v12 `environment.*` + v11 top-level globalLight/darkness).
      const glob = !!l.globalLight, thr = num(l.globalLightThreshold, 1), dark = num(l.darknessLevel, 0)
      data.environment = {
        globalLight: { enabled: glob, darkness: { max: thr } },
        darknessLevel: dark, darknessLock: !!l.darknessLock, cycle: !!am.blend,
        base: { hue: am.base?.hue || "#000000", intensity: num(am.base?.intensity, 0), luminosity: num(am.base?.luminosity, 0), saturation: num(am.base?.saturation, 0), shadows: num(am.base?.shadows, 0) },
        dark: { hue: am.dark?.hue || "#000000", intensity: num(am.dark?.intensity, 0), luminosity: num(am.dark?.luminosity, -0.25), saturation: num(am.dark?.saturation, 0), shadows: num(am.dark?.shadows, 0) },
      }
      data.globalLight = glob; data.globalLightThreshold = thr; data.darkness = dark

      // Weather particle effect (v11–13 top-level `weather` = effect id; '' = none).
      if (am.weather) data.weather = String(am.weather)

      const scene = await Scene.create(data)
      // v14 moved the map image from Scene.background onto the new Level document.
      // Set it on the scene's first level (Foundry auto-creates one for simple
      // scenes); create a Ground level only if none exists. Best-effort: a schema
      // mismatch must never fail the publish (the scene already exists). v11–13 use
      // the top-level `background` set in `data` above and skip this block.
      if ((game.release?.generation || 0) >= 14 && msg.imgPath) {
        try {
          const lvl = { background: { src: msg.imgPath } }
          if (b.foreground) lvl.foreground = { src: String(b.foreground) }
          if (scene.firstLevel) await scene.firstLevel.update(lvl)
          else await scene.createEmbeddedDocuments("Level", [{ name: "Ground", ...lvl }])
        } catch (e) { console.warn("[pendant-bridge] v14 Level background set failed:", e) }
      }
      // Auto-generate the navigation/sidebar thumbnail from the background. Best-
      // effort: a thumbnail failure must never fail the publish.
      try { const tn = await scene.createThumbnail(); if (tn && tn.thumb) await scene.update({ thumb: tn.thumb }) }
      catch (e) { console.warn("[pendant-bridge] scene thumbnail failed:", e) }
      // Initial view position: the client sends the camera centre in IMAGE space
      // (0..width / 0..height); shift it into the padded-canvas space Foundry's
      // `initial` expects by adding the background's sceneX/sceneY offset.
      if (b.initial && b.initial.x != null) {
        try {
          const dim = sceneDimensions(scene)
          // Foundry's initial.scale is schema-bounded (~0.25–3 on v12+); clamp so
          // an extreme editor zoom can't throw and drop the whole position.
          const sc = b.initial.scale != null ? Math.max(0.25, Math.min(3, Number(b.initial.scale))) : null
          await scene.update({ initial: {
            x: Math.round(Number(b.initial.x) + (dim.sceneX || 0)),
            y: Math.round(Number(b.initial.y) + (dim.sceneY || 0)),
            scale: sc
          } })
        } catch (e) { console.warn("[pendant-bridge] initial view failed:", e) }
      }
      return bridge.reply(msg.reqId, {
        type: "scene.created",
        id: scene.id, name: scene.name, dimensions: sceneDimensions(scene)
      })
    }

    // ── List scenes (so the editor can target an existing map) ─
    // Returns each scene's dimensions including the sceneX/sceneY
    // offset of the background inside the padded canvas, which the
    // editor needs to map its image-space coords → scene-space.
    case "scene.list": {
      const scenes = game.scenes.map(s => ({
        id: s.id,
        name: s.name,
        active: !!s.active,
        thumb: resolveImg(s.thumb || sceneBg(s)),
        background: resolveImg(sceneBg(s)),
        dimensions: sceneDimensions(s)
      }))
      return bridge.reply(msg.reqId, { type: "scene.list", scenes })
    }

    // ── The live/active scene + its tokens (COA Scene View seed) ─
    // Live token moves arrive afterward via the updateToken hook; this is the
    // initial snapshot the mirror draws on connect.
    case "scene.active": {
      const scene = game.scenes.active
      return bridge.reply(msg.reqId, {
        type: "scene.active",
        scene: serializeSceneMeta(scene),
        tokens: scene ? scene.tokens.map(serializeToken) : []
      })
    }

    // ── Place image tiles on a scene ──────────────────────────
    // Accepts a batch: { sceneId, tiles: [{ src, x, y, width, height,
    // rotation?, alpha?, hidden? }] }. Coords are in SCENE space
    // (top-left of the padded canvas = 0,0). The editor converts
    // image-space → scene space using the offset from scene.list.
    // Falls back to the active scene if no sceneId is given.
    case "tile.create": {
      const scene = msg.sceneId ? game.scenes.get(msg.sceneId) : game.scenes.active
      if (!scene) throw new Error("Scene not found: " + (msg.sceneId || "(no active scene)"))
      const tilesIn = Array.isArray(msg.tiles) ? msg.tiles : [msg]
      const data = tilesIn.map(t => {
        const d = {
          // v11+ tiles use texture.src; older `img` is gone (min compat 11).
          texture: { src: String(t.src || "") },
          x:      Number(t.x) || 0,
          y:      Number(t.y) || 0,
          width:  Number(t.width)  || 100,
          height: Number(t.height) || 100,
          rotation: Number(t.rotation) || 0,
          hidden: !!t.hidden
        }
        // Flip via the texture mirror (negative scale); default 1.
        if (t.scaleX != null) d.texture.scaleX = Number(t.scaleX)
        if (t.scaleY != null) d.texture.scaleY = Number(t.scaleY)
        if (t.tint) d.texture.tint = String(t.tint)
        if (t.alpha != null) d.alpha = Number(t.alpha)
        return d
      })
      const created = await scene.createEmbeddedDocuments("Tile", data)
      return bridge.reply(msg.reqId, {
        type: "tile.created",
        sceneId: scene.id,
        ids: created.map(doc => doc.id)
      })
    }

    // ── Place native Drawings (shapes + text) on a scene ──────
    // Accepts a batch: { sceneId, drawings: [{ shape, x, y, width,
    // height, rotation?, strokeColor?, strokeWidth?, fillColor?,
    // fillAlpha?, text?, fontSize?, textColor? }] }. `shape` is one of
    // "rectangle" | "ellipse" | "polygon" | "text". Coords are SCENE
    // space (same offset convention as tiles). These become real,
    // re-editable Foundry Drawing documents.
    case "drawing.create": {
      const scene = msg.sceneId ? game.scenes.get(msg.sceneId) : game.scenes.active
      if (!scene) throw new Error("Scene not found: " + (msg.sceneId || "(no active scene)"))
      const inArr = Array.isArray(msg.drawings) ? msg.drawings : [msg]
      const data = inArr.map(d => buildDrawingData(d))
      const created = await scene.createEmbeddedDocuments("Drawing", data)
      return bridge.reply(msg.reqId, {
        type: "drawing.created",
        sceneId: scene.id,
        ids: created.map(doc => doc.id)
      })
    }

    // ── Read existing tiles + drawings on a scene ─────────────
    // Lets the editor LOAD a scene's current objects so they can be
    // moved / edited / deleted (not just created). Coords are scene
    // space; the editor subtracts (sceneX, sceneY) to get image space.
    case "scene.objects": {
      const scene = msg.sceneId ? game.scenes.get(msg.sceneId) : game.scenes.active
      if (!scene) throw new Error("Scene not found: " + (msg.sceneId || "(no active scene)"))
      const tiles = scene.tiles.map(t => ({
        id: t.id,
        src: resolveImg((t.texture && t.texture.src) || t.img || ""),
        x: t.x, y: t.y, width: t.width, height: t.height,
        rotation: t.rotation || 0, hidden: !!t.hidden,
        alpha: t.alpha != null ? t.alpha : 1
      }))
      const drawings = scene.drawings.map(d => ({
        id: d.id,
        shapeType: (d.shape && d.shape.type) || "r",   // r | e | p
        x: d.x, y: d.y,
        width:  (d.shape && d.shape.width)  || 0,
        height: (d.shape && d.shape.height) || 0,
        points: (d.shape && d.shape.points) || [],
        rotation: d.rotation || 0,
        strokeColor: d.strokeColor, strokeWidth: d.strokeWidth, strokeAlpha: d.strokeAlpha,
        fillType: d.fillType, fillColor: d.fillColor, fillAlpha: d.fillAlpha,
        text: d.text || "", fontSize: d.fontSize, fontFamily: d.fontFamily, textColor: d.textColor
      }))
      const tokens = scene.tokens.map(t => ({
        id: t.id,
        name: t.name || "",
        src: resolveImg((t.texture && t.texture.src) || t.img || ""),
        x: t.x, y: t.y, width: t.width, height: t.height,
        rotation: t.rotation || 0, hidden: !!t.hidden,
        actorId: t.actorId || null
      }))
      const walls = scene.walls.map(w => ({
        id: w.id,
        c: Array.isArray(w.c) ? w.c.slice() : [w.c?.[0], w.c?.[1], w.c?.[2], w.c?.[3]],
        door: w.door || 0,
        move: w.move,
        // v12 uses `sight`, v11 used `sense` — report whichever exists.
        sight: (w.sight != null ? w.sight : w.sense),
        sound: w.sound, light: w.light
      }))
      const lights = scene.lights.map(l => ({
        id: l.id,
        x: l.x, y: l.y, hidden: !!l.hidden,
        dim: (l.config && l.config.dim) || 0,
        bright: (l.config && l.config.bright) || 0,
        color: (l.config && l.config.color) || null,
        alpha: (l.config && l.config.alpha) != null ? l.config.alpha : null,
        animationType: (l.config && l.config.animation && l.config.animation.type) || null
      }))
      const notes = scene.notes.map(n => ({
        id: n.id,
        x: n.x, y: n.y,
        text: n.text || "",
        fontSize: n.fontSize || 32
      }))
      return bridge.reply(msg.reqId, { type: "scene.objects", sceneId: scene.id, tiles, drawings, tokens, walls, lights, notes })
    }

    // ── Update / delete existing tiles ────────────────────────
    case "tile.update": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const updates = (Array.isArray(msg.updates) ? msg.updates : [msg]).map(u => {
        const o = { _id: u.id }
        if (u.x != null) o.x = Number(u.x)
        if (u.y != null) o.y = Number(u.y)
        if (u.width  != null) o.width  = Number(u.width)
        if (u.height != null) o.height = Number(u.height)
        if (u.rotation != null) o.rotation = Number(u.rotation)
        if (u.src != null) o.texture = { src: u.src }
        if (u.hidden != null) o.hidden = !!u.hidden
        if (u.alpha != null) o.alpha = Number(u.alpha)
        return o
      })
      const upd = await scene.updateEmbeddedDocuments("Tile", updates)
      return bridge.reply(msg.reqId, { type: "tile.updated", sceneId: scene.id, ids: upd.map(d => d.id) })
    }
    case "tile.delete": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const ids = Array.isArray(msg.ids) ? msg.ids : [msg.id]
      await scene.deleteEmbeddedDocuments("Tile", ids)
      return bridge.reply(msg.reqId, { type: "tile.deleted", sceneId: scene.id, ids })
    }

    // ── Update / delete existing drawings ─────────────────────
    case "drawing.update": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const updates = (Array.isArray(msg.updates) ? msg.updates : [msg]).map(u => {
        const o = { _id: u.id }
        if (u.x != null) o.x = Number(u.x)
        if (u.y != null) o.y = Number(u.y)
        if (u.width != null || u.height != null || u.shapeType != null) {
          o.shape = {}
          if (u.width  != null) o.shape.width  = Number(u.width)
          if (u.height != null) o.shape.height = Number(u.height)
          if (u.shapeType != null) o.shape.type = u.shapeType === "ellipse" ? "e" : u.shapeType === "polygon" ? "p" : "r"
        }
        if (u.rotation != null) o.rotation = Number(u.rotation)
        if (u.strokeColor != null) o.strokeColor = u.strokeColor
        if (u.strokeWidth != null) o.strokeWidth = Number(u.strokeWidth)
        if (u.fillColor != null) { o.fillColor = u.fillColor; o.fillType = 1 }
        if (u.fillType  != null) o.fillType = Number(u.fillType)
        if (u.fillAlpha != null) o.fillAlpha = Number(u.fillAlpha)
        if (u.text != null) o.text = String(u.text)
        if (u.fontSize != null) o.fontSize = Number(u.fontSize)
        if (u.textColor != null) o.textColor = u.textColor
        return o
      })
      const upd = await scene.updateEmbeddedDocuments("Drawing", updates)
      return bridge.reply(msg.reqId, { type: "drawing.updated", sceneId: scene.id, ids: upd.map(d => d.id) })
    }
    case "drawing.delete": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const ids = Array.isArray(msg.ids) ? msg.ids : [msg.id]
      await scene.deleteEmbeddedDocuments("Drawing", ids)
      return bridge.reply(msg.reqId, { type: "drawing.deleted", sceneId: scene.id, ids })
    }

    // ── Place tokens ──────────────────────────────────────────
    // width/height are in GRID UNITS (1 = one square). x/y are pixels
    // (top-left). Optionally bound to an actor via actorId.
    case "token.create": {
      const scene = msg.sceneId ? game.scenes.get(msg.sceneId) : game.scenes.active
      if (!scene) throw new Error("Scene not found: " + (msg.sceneId || "(no active scene)"))
      const arr = Array.isArray(msg.tokens) ? msg.tokens : [msg]
      const data = arr.map(t => {
        const d = {
          name: String(t.name || "Token"),
          x: Number(t.x) || 0, y: Number(t.y) || 0,
          width: Number(t.width) || 1, height: Number(t.height) || 1,
          rotation: Number(t.rotation) || 0, hidden: !!t.hidden
        }
        // If bound to an actor, prefer the actor's real prototype-token data
        // (texture + name) unless the client explicitly supplied a src.
        if (t.actorId) {
          const a = game.actors.get(t.actorId)
          d.actorId = t.actorId
          d.actorLink = t.actorLink != null ? !!t.actorLink : (a ? a.type === "character" : false)
          const ptSrc = a && a.prototypeToken && a.prototypeToken.texture && a.prototypeToken.texture.src
          const src = t.src || ptSrc || (a && a.img) || ""
          if (src) d.texture = { src: String(src) }
          if (!t.name && a) d.name = a.name
        } else {
          d.texture = { src: String(t.src || "") }
        }
        return d
      })
      const created = await scene.createEmbeddedDocuments("Token", data)
      return bridge.reply(msg.reqId, { type: "token.created", sceneId: scene.id, ids: created.map(doc => doc.id) })
    }

    // ── Place walls ───────────────────────────────────────────
    // Each wall is a segment: c = [x0, y0, x1, y1] in scene pixels.
    // wallType: "wall" (default) | "door" | "secret" | "window".
    //   door   → swinging door (door=1, closed)
    //   secret → secret door  (door=2, closed)
    //   window → blocks movement + sound, but light + sight pass through
    case "wall.create": {
      const scene = msg.sceneId ? game.scenes.get(msg.sceneId) : game.scenes.active
      if (!scene) throw new Error("Scene not found: " + (msg.sceneId || "(no active scene)"))
      const arr = Array.isArray(msg.walls) ? msg.walls : [msg]
      const data = arr.map(w => buildWallData(w))
      const created = await scene.createEmbeddedDocuments("Wall", data)
      return bridge.reply(msg.reqId, { type: "wall.created", sceneId: scene.id, ids: created.map(doc => doc.id) })
    }

    // ── Place ambient lights ──────────────────────────────────
    // dim/bright are in scene DISTANCE units (e.g. feet). x/y pixels.
    case "light.create": {
      const scene = msg.sceneId ? game.scenes.get(msg.sceneId) : game.scenes.active
      if (!scene) throw new Error("Scene not found: " + (msg.sceneId || "(no active scene)"))
      const arr = Array.isArray(msg.lights) ? msg.lights : [msg]
      const data = arr.map(l => buildLightData(l))
      const created = await scene.createEmbeddedDocuments("AmbientLight", data)
      return bridge.reply(msg.reqId, { type: "light.created", sceneId: scene.id, ids: created.map(doc => doc.id) })
    }

    // ── Place map notes (text pins) ───────────────────────────
    case "note.create": {
      const scene = msg.sceneId ? game.scenes.get(msg.sceneId) : game.scenes.active
      if (!scene) throw new Error("Scene not found: " + (msg.sceneId || "(no active scene)"))
      const arr = Array.isArray(msg.notes) ? msg.notes : [msg]
      const data = arr.map(n => ({
        x: Number(n.x) || 0, y: Number(n.y) || 0,
        text: String(n.text || "Note"),
        fontSize: Number(n.fontSize) || 32,
        textAnchor: 1
      }))
      const created = await scene.createEmbeddedDocuments("Note", data)
      return bridge.reply(msg.reqId, { type: "note.created", sceneId: scene.id, ids: created.map(doc => doc.id) })
    }

    // ── Update / delete existing tokens ───────────────────────
    case "token.update": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const updates = (Array.isArray(msg.updates) ? msg.updates : [msg]).map(u => {
        const o = { _id: u.id }
        if (u.x != null) o.x = Number(u.x)
        if (u.y != null) o.y = Number(u.y)
        if (u.width  != null) o.width  = Number(u.width)
        if (u.height != null) o.height = Number(u.height)
        if (u.rotation != null) o.rotation = Number(u.rotation)
        if (u.src != null) o.texture = { src: u.src }
        if (u.name != null) o.name = String(u.name)
        if (u.hidden != null) o.hidden = !!u.hidden
        return o
      })
      // Apply INSTANTLY (no slide animation). The COA Scene View places the token
      // at its destination the moment you drop it; if Foundry then animated the
      // token sliding over ~1s, the two views would disagree on where the token is
      // for the whole slide. Teleporting keeps the app and Foundry in lock-step.
      // `animate:false` (v11) and `animation.duration:0` (v12) both disable it.
      const upd = await scene.updateEmbeddedDocuments("Token", updates, { animate: false, animation: { duration: 0 } })
      return bridge.reply(msg.reqId, { type: "token.updated", sceneId: scene.id, ids: upd.map(d => d.id) })
    }
    case "token.delete": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const ids = Array.isArray(msg.ids) ? msg.ids : [msg.id]
      await scene.deleteEmbeddedDocuments("Token", ids)
      return bridge.reply(msg.reqId, { type: "token.deleted", sceneId: scene.id, ids })
    }

    // ── Update / delete existing walls ────────────────────────
    case "wall.update": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const updates = (Array.isArray(msg.updates) ? msg.updates : [msg]).map(u => {
        // If a wallType is given, rebuild block flags from it.
        if (u.wallType) { const d = buildWallData(u); d._id = u.id; if (u.c == null) delete d.c; return d }
        const o = { _id: u.id }
        if (u.c != null) o.c = u.c.map(Number)
        if (u.door != null) o.door = Number(u.door)
        if (u.move != null) o.move = Number(u.move)
        if (u.sight != null) { o.sight = Number(u.sight); o.sense = Number(u.sight) }
        else if (u.sense != null) { o.sight = Number(u.sense); o.sense = Number(u.sense) }
        if (u.sound != null) o.sound = Number(u.sound)
        if (u.light != null) o.light = Number(u.light)
        return o
      })
      const upd = await scene.updateEmbeddedDocuments("Wall", updates)
      return bridge.reply(msg.reqId, { type: "wall.updated", sceneId: scene.id, ids: upd.map(d => d.id) })
    }
    case "wall.delete": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const ids = Array.isArray(msg.ids) ? msg.ids : [msg.id]
      await scene.deleteEmbeddedDocuments("Wall", ids)
      return bridge.reply(msg.reqId, { type: "wall.deleted", sceneId: scene.id, ids })
    }

    // ── Update / delete existing lights ───────────────────────
    case "light.update": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const updates = (Array.isArray(msg.updates) ? msg.updates : [msg]).map(u => {
        const o = { _id: u.id }
        if (u.x != null) o.x = Number(u.x)
        if (u.y != null) o.y = Number(u.y)
        if (u.hidden != null) o.hidden = !!u.hidden
        if (u.dim != null || u.bright != null || u.color != null || u.alpha != null || u.animationType != null) {
          o.config = {}
          if (u.dim != null) o.config.dim = Number(u.dim)
          if (u.bright != null) o.config.bright = Number(u.bright)
          if (u.color != null) o.config.color = u.color
          if (u.alpha != null) o.config.alpha = Number(u.alpha)
          if (u.animationType != null) {
            o.config.animation = {
              type: u.animationType || null,
              speed: u.animationSpeed != null ? Number(u.animationSpeed) : 5,
              intensity: u.animationIntensity != null ? Number(u.animationIntensity) : 5
            }
          }
        }
        return o
      })
      const upd = await scene.updateEmbeddedDocuments("AmbientLight", updates)
      return bridge.reply(msg.reqId, { type: "light.updated", sceneId: scene.id, ids: upd.map(d => d.id) })
    }
    case "light.delete": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const ids = Array.isArray(msg.ids) ? msg.ids : [msg.id]
      await scene.deleteEmbeddedDocuments("AmbientLight", ids)
      return bridge.reply(msg.reqId, { type: "light.deleted", sceneId: scene.id, ids })
    }

    // ── Update / delete existing notes ────────────────────────
    case "note.update": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const updates = (Array.isArray(msg.updates) ? msg.updates : [msg]).map(u => {
        const o = { _id: u.id }
        if (u.x != null) o.x = Number(u.x)
        if (u.y != null) o.y = Number(u.y)
        if (u.text != null) o.text = String(u.text)
        if (u.fontSize != null) o.fontSize = Number(u.fontSize)
        return o
      })
      const upd = await scene.updateEmbeddedDocuments("Note", updates)
      return bridge.reply(msg.reqId, { type: "note.updated", sceneId: scene.id, ids: upd.map(d => d.id) })
    }
    case "note.delete": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      const ids = Array.isArray(msg.ids) ? msg.ids : [msg.id]
      await scene.deleteEmbeddedDocuments("Note", ids)
      return bridge.reply(msg.reqId, { type: "note.deleted", sceneId: scene.id, ids })
    }

    // ── Activate a scene (make it the live/current scene) ─────
    case "scene.activate": {
      const scene = game.scenes.get(msg.sceneId)
      if (!scene) throw new Error("Scene not found: " + msg.sceneId)
      await scene.activate()
      return bridge.reply(msg.reqId, { type: "scene.activated", id: scene.id })
    }

    // ── Combat control ────────────────────────────────────────
    // Drive the encounter from the client. `combatId` is optional — defaults
    // to the active combat. `action`: next | previous | nextRound |
    // previousRound | rollAll | rollNPC | start | end.
    case "combat.control": {
      const c = msg.combatId ? game.combats.get(msg.combatId) : game.combat
      if (!c) throw new Error("No active combat")
      const action = String(msg.action || "")
      switch (action) {
        case "next":          await c.nextTurn(); break
        case "previous":      await c.previousTurn(); break
        case "nextRound":     await c.nextRound(); break
        case "previousRound": await c.previousRound(); break
        case "rollAll":       await c.rollAll(); break
        case "rollNPC":       await c.rollNPC(); break
        case "start":         await c.startCombat(); break
        case "end":           await c.delete(); break   // endCombat() prompts; delete() is clean
        default: throw new Error("Unknown combat action: " + action)
      }
      return bridge.reply(msg.reqId, {
        type: "combat.update",
        combat: action === "end" ? null : serializeCombat(c)
      })
    }

    // Set a combatant's initiative / hidden / defeated.
    case "combatant.update": {
      const c = msg.combatId ? game.combats.get(msg.combatId) : game.combat
      if (!c) throw new Error("No active combat")
      const updates = (Array.isArray(msg.updates) ? msg.updates : [msg]).map(u => {
        const o = { _id: u.id }
        if (u.initiative != null) o.initiative = Number(u.initiative)
        if (u.hidden != null)     o.hidden = !!u.hidden
        if (u.defeated != null)   o.defeated = !!u.defeated
        return o
      })
      await c.updateEmbeddedDocuments("Combatant", updates)
      return bridge.reply(msg.reqId, { type: "combat.update", combat: serializeCombat(c) })
    }

    // ── Apply damage / healing ────────────────────────────────
    // `amount` > 0 deals damage, < 0 heals — matching dnd5e's Actor#applyDamage
    // (which also honours resistances/vulnerabilities + temp HP). Falls back to
    // a manual HP adjustment (temp absorbs first) on systems without it.
    case "actor.applyDamage": {
      const a = game.actors.get(msg.id)
      if (!a) throw new Error("Actor not found: " + msg.id)
      const amount = Number(msg.amount) || 0
      if (typeof a.applyDamage === "function") {
        await a.applyDamage(amount)
      } else {
        const hp = a.system?.attributes?.hp ?? a.system?.hp
        if (hp && typeof hp === "object") {
          let value = Number(hp.value) || 0, temp = Number(hp.temp) || 0
          const max = Number(hp.max) || 0
          if (amount > 0) { const ft = Math.min(temp, amount); temp -= ft; value = Math.max(0, value - (amount - ft)) }
          else            { value = max ? Math.min(max, value - amount) : value - amount }
          const changes = { "system.attributes.hp.value": value }
          if ((Number(hp.temp) || 0) !== temp) changes["system.attributes.hp.temp"] = temp
          await a.update(changes)
        }
      }
      return bridge.reply(msg.reqId, { type: "actor", actor: serializeActorFull(a) })
    }

    // ── Active Effects / conditions ───────────────────────────
    // Add a condition by status id (blinded, prone, …) via toggleStatusEffect
    // (v12+), or a raw ActiveEffect payload. v11/v12 field-name shims included.
    case "effect.create": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      if (msg.statusId && typeof a.toggleStatusEffect === "function") {
        await a.toggleStatusEffect(String(msg.statusId), { active: true })
      } else {
        const data = msg.effect || {
          name:     String(msg.name || "Effect"),
          icon:     msg.icon || "icons/svg/aura.svg",
          changes:  Array.isArray(msg.changes) ? msg.changes : [],
          disabled: !!msg.disabled,
          statuses: msg.statusId ? [String(msg.statusId)] : (msg.statuses || [])
        }
        if (data.name && data.label == null) data.label = data.name   // v11 used label
        if (data.icon && data.img == null)   data.img = data.icon     // v12 renamed icon→img
        await a.createEmbeddedDocuments("ActiveEffect", [data])
      }
      return bridge.reply(msg.reqId, { type: "actor", actor: serializeActorFull(a) })
    }
    case "effect.update": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      const eff = a.effects.get(msg.effectId)
      if (!eff) throw new Error("Effect not found: " + msg.effectId)
      await eff.update(msg.changes || {})
      return bridge.reply(msg.reqId, { type: "actor", actor: serializeActorFull(a) })
    }
    case "effect.toggle": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      if (msg.statusId && typeof a.toggleStatusEffect === "function") {
        await a.toggleStatusEffect(String(msg.statusId))
      } else {
        const eff = a.effects.get(msg.effectId)
        if (!eff) throw new Error("Effect not found: " + msg.effectId)
        await eff.update({ disabled: !eff.disabled })
      }
      return bridge.reply(msg.reqId, { type: "actor", actor: serializeActorFull(a) })
    }
    case "effect.delete": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      const ids = Array.isArray(msg.ids) ? msg.ids : [msg.effectId]
      await a.deleteEmbeddedDocuments("ActiveEffect", ids)
      return bridge.reply(msg.reqId, { type: "actor", actor: serializeActorFull(a) })
    }

    // ── Status-effect catalogue (for the Scene View token quick-menu) ──────────
    // The world's configured conditions: { id, name, icon }. Apply one with
    // effect.toggle { actorId, statusId }.
    case "status.list": {
      const list = (CONFIG.statusEffects || []).map(s => ({
        id: s.id,
        name: (game.i18n && game.i18n.localize ? game.i18n.localize(s.name || s.label || s.id) : (s.name || s.label || s.id)),
        icon: resolveImg(s.icon || s.img || "")   // → absolute URL the app can load
      })).filter(s => s.id)
      return bridge.reply(msg.reqId, { type: "status.list", statuses: list })
    }

    // ── Add / remove a token from the active combat (initiative) ───────────────
    // Toggles membership: if the token is already a combatant it's removed, else
    // it's added (creating an encounter if none exists). Returns the new state.
    case "combat.toggleToken": {
      const scene = (msg.sceneId ? game.scenes.get(msg.sceneId) : null) || game.scenes.active
      if (!scene) throw new Error("No scene")
      const tokenDoc = scene.tokens.get(msg.tokenId)
      if (!tokenDoc) throw new Error("Token not found: " + msg.tokenId)
      const existing = game.combat?.combatants?.find(c => c.tokenId === msg.tokenId)
      if (existing) {
        await existing.delete()
      } else {
        if (typeof tokenDoc.toggleCombatant === "function") {
          await tokenDoc.toggleCombatant()        // v13+: TokenDocument method (Token#toggleCombat removed in v14)
        } else {
          const tokenObj = tokenDoc.object || tokenDoc._object
          if (tokenObj && typeof tokenObj.toggleCombat === "function") {
            await tokenObj.toggleCombat()         // v11–12: placeable method, creates combat if needed
          } else {
            let combat = game.combat
            if (!combat) combat = await CONFIG.Combat.documentClass.create({ scene: scene.id, active: true })
            await combat.createEmbeddedDocuments("Combatant", [{ tokenId: msg.tokenId, sceneId: scene.id, actorId: tokenDoc.actorId }])
          }
        }
      }
      const inCombat = !!game.combat?.combatants?.find(c => c.tokenId === msg.tokenId)
      return bridge.reply(msg.reqId, { type: "combat.toggleToken", tokenId: msg.tokenId, inCombat, combat: game.combat ? serializeCombat(game.combat) : null })
    }

    // ── Anti-Hammer Space (slot inventory) ─────────────────────
    // The app's DM tool reads + writes the encumbrance config and per-actor
    // overrides. The maths live in the `AH` object so this and the on-sheet
    // panel agree exactly.
    case "antihammer.config.get": {
      return bridge.reply(msg.reqId, { type: "antihammer.config", config: AH.cfg() })
    }
    case "antihammer.config.set": {
      const cur = AH.cfg()
      const inc = msg.config || {}
      const next = { ...cur, ...inc }
      if (inc.sizeSpaces) next.sizeSpaces = { ...cur.sizeSpaces, ...inc.sizeSpaces }
      if (inc.ignoreTypes != null) next.ignoreTypes = Array.isArray(inc.ignoreTypes)
        ? inc.ignoreTypes
        : String(inc.ignoreTypes).split(",").map(s => s.trim()).filter(Boolean)
      await game.settings.set(MOD, "ahConfig", next)
      // The setting's onChange (ahOnConfigChanged) re-persists every bag + re-renders.
      return bridge.reply(msg.reqId, { type: "antihammer.config", config: AH.cfg() })
    }
    case "antihammer.summary": {
      const cfg = AH.cfg()
      const ids = Array.isArray(msg.actorIds) && msg.actorIds.length ? new Set(msg.actorIds) : null
      const actors = []
      for (const a of game.actors) {
        if (ids && !ids.has(a.id)) continue
        try { actors.push(AH.actorSummary(a, cfg)) }
        catch (e) { console.warn("[pendant-bridge] AH summary skip", a?.id, a?.name, e) }
      }
      return bridge.reply(msg.reqId, { type: "antihammer.summary", config: cfg, actors })
    }
    case "antihammer.setCapacity": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      const v = msg.capacity
      if (v == null || v === "") await a.unsetFlag(MOD, "capacity")
      else await a.setFlag(MOD, "capacity", Number(v) || 0)
      await ahRecomputeActor(a)   // persist the new authoritative totals before replying
      return bridge.reply(msg.reqId, { type: "antihammer.actor", actor: AH.actorSummary(a, AH.cfg()) })
    }
    case "antihammer.setItemSpaces": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      const it = a.items.get(msg.itemId)
      if (!it) throw new Error("Item not found: " + msg.itemId)
      const v = msg.spaces
      if (v == null || v === "") await it.unsetFlag(MOD, "spaces")
      else await it.setFlag(MOD, "spaces", Number(v) || 0)
      await ahRecomputeActor(a)   // persist the new authoritative totals before replying
      return bridge.reply(msg.reqId, { type: "antihammer.actor", actor: AH.actorSummary(a, AH.cfg()) })
    }

    default:
      throw new Error("Unknown command: " + msg.type)
  }
}

// ──────────────────────────────────────────────────────────────
// Indicator pill (bottom-left of Foundry's UI)
// ──────────────────────────────────────────────────────────────

function ensureIndicator() {
  let el = document.getElementById("pendant-bridge-indicator")
  if (!el) {
    el = document.createElement("div")
    el.id = "pendant-bridge-indicator"
    document.body.appendChild(el)
  }
  return el
}

function updateIndicator(connected) {
  const enabled = game.settings.get(MOD, "enabled")
  const el = ensureIndicator()
  if (!enabled) { el.remove(); return }
  el.classList.toggle("is-on",  connected)
  el.classList.toggle("is-off", !connected)
  el.textContent = connected ? "Pendant linked" : "Pendant offline"
}

// ──────────────────────────────────────────────────────────────
// Anti-Hammer Space — world-authoritative state + on-sheet panel
// ──────────────────────────────────────────────────────────────
// The numbers are NOT recomputed independently on each viewer's machine. The GM
// client is the single authority: it recomputes a bag's totals whenever an input
// changes (items / capacity / rules) and writes them to the actor as world data
// (flag `ah`), which Foundry syncs to everyone. Every surface — each player's
// sheet panel and the DM app — then READS that one stored value, so it is
// consistent for the whole table and persists in the world.
//
// The sheet panel must still render in the browser (Foundry has no server-side
// sheet rendering), but it only DISPLAYS the stored authority; it falls back to a
// live compute only when no value has been written yet (e.g. before the GM is on).

/** Persist a bag's authoritative totals onto the actor. GM-only; no-op if unchanged. */
async function ahRecomputeActor(actor) {
  if (!game.user?.isGM || !actor) return
  if (actor.type === "group" || actor.type === "party") return
  let s
  try { s = AH.actorSummary(actor, AH.cfg()) } catch (e) { console.warn("[pendant-bridge] AH recompute failed", actor?.id, e); return }
  const next = { used: s.used, capacity: s.capacity, overflow: s.overflow, free: s.free, itemCount: s.itemCount, capacityOverride: s.capacityOverride }
  let cur = null
  try { cur = actor.getFlag(MOD, "ah") } catch {}
  if (cur && cur.used === next.used && cur.capacity === next.capacity && cur.overflow === next.overflow
      && cur.itemCount === next.itemCount && cur.capacityOverride === next.capacityOverride) return  // unchanged → skip the write
  next.computedAt = Date.now()
  try { await actor.setFlag(MOD, "ah", next) }
  catch (e) { console.warn("[pendant-bridge] AH persist failed", actor?.id, e) }
}

/** Recompute every actor's bag (GM-only). Used on boot + after a rule change. */
async function ahRecomputeAll() {
  if (!game.user?.isGM) return
  for (const a of game.actors) { try { await ahRecomputeActor(a) } catch {} }
}

/** True when an actor `changes` payload actually touched our capacity flag. */
function ahCapacityChanged(changes) {
  try {
    const f = changes?.flags?.[MOD]
    return !!f && ("capacity" in f || "-=capacity" in f)
  } catch { return false }
}

/** Rule change → GM re-persists every bag, and all clients re-render open sheets. */
function ahOnConfigChanged() {
  ahRecomputeAll().catch(() => {})
  ahRerenderSheets()
}

/** The numbers a surface shows: the stored authority, or a live compute as fallback. */
function ahStateOf(actor) {
  const live = AH.actorSummary(actor, AH.cfg())   // breakdown + fallback (deterministic from world data)
  let stored = null
  try { stored = actor.getFlag(MOD, "ah") } catch {}
  if (stored && typeof stored.used === "number") {
    return {
      ...live,
      used: stored.used,
      capacity: stored.capacity != null ? stored.capacity : live.capacity,
      overflow: stored.overflow != null ? stored.overflow : live.overflow,
      free: stored.free != null ? stored.free : live.free,
      itemCount: stored.itemCount != null ? stored.itemCount : live.itemCount,
    }
  }
  return live
}

function ahFmt(n) {
  const r = Math.round(Number(n) * 100) / 100
  return String(Number.isFinite(r) ? r : 0)
}

// ── honeycomb rendering + drag-to-arrange ───────────────────────
const AH_COLORS = ["#4d83c4", "#9a5cc6", "#5aa84a", "#cf9a3a", "#c45f7e", "#6f78cf", "#3aa9b3", "#c9a13f", "#a06bce", "#7fb04a", "#cf7a3a", "#5bb0a0"]
function ahColorFor(id) { const s = String(id || ""); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AH_COLORS[h % AH_COLORS.length] }
function ahShort(name) { const w = String(name || "").trim().split(/\s+/)[0] || ""; return w.length > 7 ? w.slice(0, 6) + "…" : w }
function ahCellSize(it) { return Math.max(1, Math.ceil(Number(it.spaces) || 0)) }   // whole hexes per item (grid only)

/** Items in the player's saved arrangement order; unordered ones keep summary order. */
function ahOrderItems(actor, items) {
  let order = []
  try { order = actor.getFlag(MOD, "ahOrder") || [] } catch {}
  if (!Array.isArray(order)) order = []
  const pos = {}; order.forEach((id, i) => { pos[id] = i })
  return items.slice().sort((a, b) => {
    const pa = pos[a.id] != null ? pos[a.id] : Infinity
    const pb = pos[b.id] != null ? pos[b.id] : Infinity
    return pa - pb
  })
}

let ahDragId = null

/** Move `fromId` to sit before `beforeId` (null = end) and persist the arrangement. */
function ahReorder(actor, items, fromId, beforeId) {
  let ids = items.map(it => it.id).filter(id => id !== fromId)
  if (beforeId == null || beforeId === fromId) ids.push(fromId)
  else { const i = ids.indexOf(beforeId); i < 0 ? ids.push(fromId) : ids.splice(i, 0, fromId) }
  try { actor.setFlag(MOD, "ahOrder", ids) } catch (e) { console.warn("[pendant-bridge] AH reorder failed", e) }
}

function ahMakeDrop(el, actor, items, beforeId, canArrange) {
  if (!canArrange) return
  el.addEventListener("dragover", (e) => { if (ahDragId) { e.preventDefault(); e.stopPropagation(); el.classList.add("ah-dropping") } })
  el.addEventListener("dragleave", () => el.classList.remove("ah-dropping"))
  el.addEventListener("drop", (e) => {
    if (!ahDragId) return
    e.preventDefault(); e.stopPropagation()
    el.classList.remove("ah-dropping")
    const from = ahDragId; ahDragId = null
    ahReorder(actor, items, from, beforeId)
  })
}

function ahHex(label, bg, over) {
  const d = document.createElement("div")
  d.className = "ah-hex" + (bg ? "" : " empty") + (over ? " over" : "")
  if (bg) d.style.background = bg
  if (label) { const s = document.createElement("span"); s.className = "ah-hex-lbl"; s.textContent = label; d.appendChild(s) }
  return d
}

/** The 4-wide hex honeycomb. Items fill cells in arrangement order; cells past
 *  capacity render red. The actor's owner (or GM) can drag an item's lead hex to
 *  reorder which items claim the limited slots — i.e. choose what spills over. */
function ahHoneycomb(actor, sum) {
  const items = ahOrderItems(actor, sum.items)
  const cap = Math.max(0, Math.round(sum.capacity))
  const canArrange = !!(actor.isOwner || game.user?.isGM)
  const flat = []
  for (const it of items) { const n = ahCellSize(it); for (let k = 0; k < n; k++) flat.push({ it, first: k === 0 }) }
  const show = Math.max(cap, flat.length)
  const rows = Math.ceil(show / 4)
  const comb = document.createElement("div")
  comb.className = "ah-comb"
  let idx = 0
  for (let r = 0; r < rows; r++) {
    const row = document.createElement("div")
    row.className = "ah-comb-row" + (r % 2 ? " odd" : "")
    for (let c = 0; c < 4 && idx < show; c++, idx++) {
      const i = idx
      let cell
      if (i < flat.length) {
        const f = flat[i]
        cell = ahHex(f.first ? ahShort(f.it.name) : "", ahColorFor(f.it.id), i >= cap)
        if (f.first) {
          cell.title = f.it.name + " — " + ahFmt(f.it.spaces) + " space" + (f.it.spaces === 1 ? "" : "s")
          if (canArrange) {
            cell.classList.add("drag"); cell.draggable = true
            cell.addEventListener("dragstart", (e) => { ahDragId = f.it.id; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", f.it.id) } catch {} e.stopPropagation() })
            cell.addEventListener("dragend", () => { ahDragId = null })
          }
        }
        ahMakeDrop(cell, actor, items, f.it.id, canArrange)
      } else {
        cell = ahHex("", null, false)
      }
      row.appendChild(cell)
    }
    comb.appendChild(row)
  }
  ahMakeDrop(comb, actor, items, null, canArrange)   // drop on empty space → send to the end
  return comb
}

function ahBuildPanel(actor) {
  const cfg = AH.cfg()
  const sum = ahStateOf(actor)            // stored authority (GM-computed), live fallback
  const isGM = !!game.user?.isGM
  const over = sum.overflow > 0
  const full = sum.capacity > 0 && sum.used >= sum.capacity

  const wrap = document.createElement("div")
  wrap.className = "ah-panel" + (over ? " is-over" : full ? " is-full" : "")

  // header: title · used/capacity · overflow · (GM) capacity input
  const head = document.createElement("div")
  head.className = "ah-head"
  const title = document.createElement("span")
  title.className = "ah-title"
  title.textContent = "🎒 Anti-Hammer Space"
  head.appendChild(title)
  const stat = document.createElement("span")
  stat.className = "ah-stat"
  stat.innerHTML = `<b>${ahFmt(sum.used)}</b> / ${ahFmt(sum.capacity)} <span class="ah-stat-lbl">spaces</span>`
    + (over ? ` <span class="ah-over">+${ahFmt(sum.overflow)} over</span>` : "")
  head.appendChild(stat)
  if (isGM) {
    const cap = document.createElement("label")
    cap.className = "ah-cap"
    cap.appendChild(document.createTextNode("Cap"))
    const inp = document.createElement("input")
    inp.type = "number"; inp.min = "0"; inp.className = "ah-cap-input"
    inp.value = sum.capacityOverride != null ? String(sum.capacityOverride) : ""
    inp.placeholder = ahFmt(cfg.defaultCapacity)
    inp.title = "This actor's capacity (blank = world default " + ahFmt(cfg.defaultCapacity) + ")"
    inp.addEventListener("change", async () => {
      const v = inp.value.trim()
      try { v === "" ? await actor.unsetFlag(MOD, "capacity") : await actor.setFlag(MOD, "capacity", Number(v) || 0) }
      catch (e) { console.warn("[pendant-bridge] AH setCapacity failed", e) }
    })
    cap.appendChild(inp)
    head.appendChild(cap)
  }
  wrap.appendChild(head)

  // the 4-wide hex honeycomb (items fill slots; spill is red; owner can drag-arrange)
  wrap.appendChild(ahHoneycomb(actor, sum))

  // overflow tray — the items that spilled past the slots, in arrangement order
  if (over) {
    const capN = Math.max(0, Math.round(sum.capacity))
    const spilled = []
    let run = 0
    for (const it of ahOrderItems(actor, sum.items)) { const start = run; run += ahCellSize(it); if (start >= capN) spilled.push(it) }
    if (spilled.length) {
      const tray = document.createElement("div"); tray.className = "ah-tray"
      const lbl = document.createElement("div"); lbl.className = "ah-tray-lbl"; lbl.textContent = "Overflow — won't fit the bag"
      tray.appendChild(lbl)
      const chips = document.createElement("div"); chips.className = "ah-tray-chips"
      for (const it of spilled) {
        const chip = document.createElement("span"); chip.className = "ah-chip"
        chip.textContent = it.name + " (" + ahFmt(it.spaces) + ")"
        chips.appendChild(chip)
      }
      tray.appendChild(chips)
      wrap.appendChild(tray)
    }
  }

  // GM tuning — set each item's space cost by hand (blank = auto from the rule)
  if (isGM && sum.items.length) {
    const det = document.createElement("details"); det.className = "ah-items"
    const summ = document.createElement("summary"); summ.textContent = "Tune item sizes (GM)"
    det.appendChild(summ)
    const list = document.createElement("div"); list.className = "ah-list"
    for (const it of sum.items) {
      const row = document.createElement("div"); row.className = "ah-row" + (it.override != null ? " ovr" : "")
      const sw = document.createElement("span"); sw.className = "ah-row-sw"; sw.style.background = ahColorFor(it.id); row.appendChild(sw)
      const name = document.createElement("span"); name.className = "ah-row-name"; name.textContent = it.name || "—"; row.appendChild(name)
      if (it.qty > 1) { const q = document.createElement("span"); q.className = "ah-row-qty"; q.textContent = "×" + it.qty; row.appendChild(q) }
      const item = actor.items.get(it.id)
      const sp = document.createElement("input")
      sp.type = "number"; sp.min = "0"; sp.step = "0.5"; sp.className = "ah-row-sp" + (it.override != null ? " ovr" : "")
      sp.value = it.override != null ? String(it.override) : ""
      sp.placeholder = ahFmt(it.spaces)
      sp.title = "Spaces this item takes (blank = auto: " + cfg.costMode + ")"
      sp.addEventListener("change", async () => {
        const v = sp.value.trim()
        try { (v === "" && item) ? await item.unsetFlag(MOD, "spaces") : await item.setFlag(MOD, "spaces", Number(v) || 0) }
        catch (e) { console.warn("[pendant-bridge] AH setItemSpaces failed", e) }
      })
      row.appendChild(sp)
      list.appendChild(row)
    }
    det.appendChild(list)
    wrap.appendChild(det)
  } else if (!sum.items.length) {
    const e = document.createElement("div"); e.className = "ah-empty"; e.textContent = "Bag is empty."
    wrap.appendChild(e)
  }

  return wrap
}

function ahInjectPanel(app, html) {
  const actor = app?.actor || (app?.document?.documentName === "Actor" ? app.document : null)
  if (!actor) return
  if (actor.type === "group" || actor.type === "party") return   // containers of actors, not carriers
  const root = (html instanceof HTMLElement) ? html : (html && html[0]) ? html[0] : null
  if (!root || typeof root.querySelector !== "function") return
  // A re-render replaces sheet content, but ApplicationV2 can patch in place —
  // clear any prior panel first so we never stack duplicates.
  root.querySelectorAll(".ah-panel").forEach(n => n.remove())
  // Prefer the actor's INVENTORY tab so the bag lives with the rest of their gear;
  // fall back to the sheet body for systems/sheets without a recognizable one.
  const host = root.querySelector('.tab[data-tab="inventory"]')
    || root.querySelector(".tab.inventory")
    || root.querySelector('section[data-tab="inventory"]')
    || root.querySelector(".sheet-body") || root.querySelector(".window-content") || root.querySelector("form") || root
  let panel
  try { panel = ahBuildPanel(actor) } catch (e) { console.warn("[pendant-bridge] AH panel build failed", e); return }
  host.insertBefore(panel, host.firstChild)
}

/** Re-render open Actor sheets so a rule/capacity change shows live. */
function ahRerenderSheets() {
  try { for (const w of Object.values(ui.windows || {})) { const d = w?.document || w?.actor; if (d?.documentName === "Actor" && typeof w.render === "function") w.render(false) } } catch {}
  try { const inst = foundry?.applications?.instances; if (inst?.values) for (const a of inst.values()) { const d = a?.document || a?.actor; if (d?.documentName === "Actor" && typeof a.render === "function") a.render(false) } } catch {}
}

// ──────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  bridge.reconcile()

  // Inject the Anti-Hammer bag onto every Actor sheet, across sheet generations.
  const onSheet = (app, html) => { try { ahInjectPanel(app, html) } catch (e) { console.warn("[pendant-bridge] AH inject failed", e) } }
  for (const h of ["renderActorSheet", "renderActorSheetV2", "renderApplicationV2"]) Hooks.on(h, onSheet)

  // GM client = the single authority. Re-persist a bag whenever an input changes,
  // so the stored value every surface reads stays correct. (ahRecomputeActor is
  // itself GM-gated, so these hooks are harmless no-ops on players' clients.)
  const itemActor = (it) => (it?.parent?.documentName === "Actor" ? it.parent : null)
  Hooks.on("createItem", (it) => { const a = itemActor(it); if (a) ahRecomputeActor(a) })
  Hooks.on("updateItem", (it) => { const a = itemActor(it); if (a) ahRecomputeActor(a) })
  Hooks.on("deleteItem", (it) => { const a = itemActor(it); if (a) ahRecomputeActor(a) })
  Hooks.on("createActor", (a) => ahRecomputeActor(a))
  Hooks.on("updateActor", (a, changes) => { if (ahCapacityChanged(changes)) ahRecomputeActor(a) })

  ahRecomputeAll()   // seed/refresh every bag's stored state on boot (GM only)
  ahRerenderSheets()
})

// Expose for debugging from the Foundry console.
globalThis.PendantBridge = bridge
