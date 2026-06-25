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

// Natural / unarmed attacks (Bite, Claw, Unarmed Strike, …) are not carriable gear —
// they must never count toward bag space nor show in the loose tray.
const AH_NATURAL_NAMES = /^(unarmed strike|bite|claw|claws|slam|tail|gore|hoof|hooves|talon|talons|tentacle|sting|stinger|fist|fists|pseudopod|tusk|tusks|horn|horns|beak)$/i
function ahIsNaturalWeapon(it) {
  try {
    if (!it || it.type !== "weapon") return false
    const sys = it.system || {}
    const t = String((sys.type && sys.type.value) ?? sys.weaponType ?? "").toLowerCase()
    if (t === "natural") return true
    return AH_NATURAL_NAMES.test(String(it.name || "").trim())
  } catch { return false }
}

const AH = {
  defaults: {
    defaultCapacity: 20,     // spaces every actor has unless individually overridden
    costMode: "weight",      // "weight" | "count" | "size"
    weightPerSpace: 5,       // weight (× qty) that equals one space   (weight mode)
    minPerItem: 1,           // a carried item never costs fewer spaces than this
    roundEachItem: true,     // ceil each item up to a whole slot
    ignoreTypes: ["feat", "spell", "class", "subclass", "background", "race", "feature", "facility", "trait"],
    sizeSpaces: { tiny: 0.5, sm: 1, med: 1, lg: 2, huge: 4, grg: 8 },  // by dnd5e item size code (size mode)
    bundleSize: 20,          // stackable items bundle every N (0 = off); per-item override available
    // Strength scales the bag: extra spaces = strPer × (str basis), added to bagCapacity.
    strCapacity: false,      // off until the DM turns it on in the app
    strPer: 1,               // extra bag spaces per unit of the chosen basis
    strBasis: "mod",         // "mod" (STR modifier) | "over10" (STR − 10) | "score" (full STR score)
    ammoAutoSpend: false,    // OPT-IN: spend ammo only for weapons that DON'T have ammo set up in dnd5e
    bagMode: "separate",     // VESTIGIAL: the bag is always per-container now (Merged was removed at the user's request). Kept so old saved configs don't error; the live mode is driven by ctx.separate, not this.
    wearLoad: { Belt: 4, Back: 2, Chest: 2, Hip: 2 },   // how many wearable containers each body location holds (DM-tunable)
  },

  /** The active config = saved world setting merged over defaults (so a missing key is safe). */
  cfg() {
    let saved = {}
    try { saved = game.settings.get(MOD, "ahConfig") || {} } catch {}
    const d = this.defaults
    return {
      ...d, ...saved,
      sizeSpaces:  { ...d.sizeSpaces, ...(saved.sizeSpaces || {}) },
      wearLoad:    { ...d.wearLoad, ...(saved.wearLoad || {}) },
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
    if (ahIsNaturalWeapon(it)) return false
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
    // bundled stackable → count × per-bundle cells (replaces the weight/size×qty cost)
    const bi = ahBundleInfo(it, cfg)
    if (bi.active) return bi.count * bi.per
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
      const flagOv = this.itemOverride(it)
      let rule = null; try { rule = ahRuleFor(it) } catch {}
      const effOv = (flagOv != null) ? flagOv : (rule && rule.spaces != null ? Number(rule.spaces) : null)
      const spaces = this.itemSpaces(it, cfg, effOv)
      used += spaces
      let m = null; try { m = ahMeta(it) } catch {}
      const meta = m ? { size: m.size, carryType: m.carryType, equipSlots: m.equipSlots, needsBackPoint: m.needsBackPoint, twoHanded: m.twoHanded, longItem: m.longItem, baggable: m.baggable, ignoreSlot: m.ignoreSlot, override: m.override } : null
      let bi = { active: false, count: 1, size: 0 }; try { bi = ahBundleInfo(it, cfg) } catch {}
      let shape = null; try { shape = bi.active ? ahBundleShape(it) : ahEffectiveShape(it, Math.max(1, Math.ceil(spaces))) } catch {}
      items.push({ id: it.id, name: it.name, type: it.type, img: resolveImg(it.img), color: ahColorFor(it.id), weight: this.itemWeight(it), qty: this.itemQty(it), uses: ahReadUses(it), spaces, override: flagOv, ruleKey: ahItemRuleKey(it), hasRule: !!rule, shape, bundleSize: bi.size || 0, bundleCount: bi.count || 1, meta })
    }
    used = Math.round(used * 100) / 100
    const { capacity, override } = this.capacityOf(actor, cfg)
    const overflow = Math.max(0, Math.round((used - capacity) * 100) / 100)
    items.sort((a, b) => b.spaces - a.spaces || (a.name || "").localeCompare(b.name || ""))
    // render-ready paperdoll state (so the app can show + edit the body too)
    let doll
    try { const c = ahHeadlessCtx(actor); doll = { gender: ahDollGender(actor), worn: c.worn, back: c.back, occ: ahOccupancy(c), caps: ahCaps(c) } }
    catch { doll = { gender: ahDollGender(actor), worn: {}, back: [], occ: {}, caps: Object.assign({}, AH_BASE_CAP) } }
    return {
      id: actor.id, name: actor.name, img: resolveImg(actor.img), type: actor.type,
      capacity, capacityOverride: override, used, overflow,
      free: Math.max(0, Math.round((capacity - used) * 100) / 100),
      itemCount: items.length, items, doll,
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
  // World-wide per-item-name overrides (size/carryType/equipSlots/spaces/shape),
  // applied to every copy of that item. Edited from the app's Item Rules panel.
  game.settings.register(MOD, "ahItemRules", {
    scope:   "world",
    config:  false,
    type:    Object,
    default: {},
    onChange: () => ahOnConfigChanged()
  })
  // DM-authored custom storage gear (belts/packs the players can add), keyed by id
  // → { name, storage, grants:{ slot: n } }. Merged on top of the built-in catalog.
  game.settings.register(MOD, "ahGearDefs", {
    scope:   "world",
    config:  false,
    type:    Object,
    default: {},
    onChange: () => { ahRecomputeAll().catch(() => {}); ahRerenderSheets() }
  })
  game.settings.register(MOD, "ahBindContainers", {
    name:    "Anti-Hammer: bind bag to dnd5e containers (experimental)",
    hint:    "EXPERIMENTAL — off by default while it's tested. When on, the bag's per-container grids mirror dnd5e's real containers: dropping an item into a grid actually puts it in that container on the sheet, and moves you make on the normal sheet show up in the bag. Only containers worn on the doll become grids; items inside containers you're NOT wearing are managed on the normal sheet, not shown here. Try it on one character; turn off any time to go back to Anti-Hammer's own bins (your data reverts cleanly).",
    scope:   "world",
    config:  true,
    type:    Boolean,
    default: false,
    onChange: () => ahRerenderSheets()
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

    // ── World-map grid overlay: store a flattened grid as a scene flag and
    // draw it on the canvas (toggled by the GM, optionally shared to players).
    // overlay = { levels[], scale, mapId, versionId, imagePath } | null (clear).
    case "overlay.set": {
      if (!game.user?.isGM) throw new Error("Only the GM can set the grid overlay")
      const scene = msg.sceneId ? game.scenes.get(msg.sceneId) : game.scenes.active
      if (!scene) throw new Error("Scene not found: " + (msg.sceneId || "(no active scene)"))
      const overlay = msg.overlay || null
      if (overlay && Array.isArray(overlay.levels)) {
        await scene.setFlag(MOD, "overlay", overlay)
      } else {
        await scene.unsetFlag(MOD, "overlay")
        await scene.unsetFlag(MOD, "overlayShared")
      }
      if (scene.active) { ovlScheduleDraw(); ovlUpdateToggle() }
      return bridge.reply(msg.reqId, { type: "overlay.stored", sceneId: scene.id, cleared: !overlay })
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
      if (inc.wearLoad && typeof inc.wearLoad === "object") next.wearLoad = { ...cur.wearLoad, ...inc.wearLoad }
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
      return bridge.reply(msg.reqId, { type: "antihammer.summary", config: cfg, actors, rules: ahItemRules(), bodySlots: AH_BODY_SLOTS })
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
    case "antihammer.setMeta": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      const it = a.items.get(msg.itemId)
      if (!it) throw new Error("Item not found: " + msg.itemId)
      const patch = msg.meta
      if (patch == null) await it.unsetFlag(MOD, "meta")          // full reset to the rules
      else {
        const cur = (it.flags && it.flags[MOD] && it.flags[MOD].meta) || {}
        const next = { ...cur, ...patch }
        for (const k of Object.keys(next)) if (next[k] == null) delete next[k]   // null clears one field
        if (Object.keys(next).length) await it.setFlag(MOD, "meta", next)
        else await it.unsetFlag(MOD, "meta")
      }
      await ahRecomputeActor(a)
      return bridge.reply(msg.reqId, { type: "antihammer.actor", actor: AH.actorSummary(a, AH.cfg()) })
    }
    case "antihammer.rules.get": {
      return bridge.reply(msg.reqId, { type: "antihammer.rules", rules: ahItemRules() })
    }
    case "antihammer.rules.set": {
      const key = String(msg.key || "").trim().toLowerCase()
      if (!key) throw new Error("antihammer.rules.set missing key")
      const all = { ...ahItemRules() }
      if (msg.rule == null) delete all[key]
      else {
        const cur = all[key] || {}
        const next = { ...cur, ...msg.rule }
        for (const k of Object.keys(next)) if (next[k] == null) delete next[k]   // per-field null clears
        if (Object.keys(next).length) all[key] = next; else delete all[key]
      }
      await game.settings.set(MOD, "ahItemRules", all)
      ahOnConfigChanged()   // re-persist every bag + re-render
      return bridge.reply(msg.reqId, { type: "antihammer.rules", rules: ahItemRules() })
    }
    case "antihammer.equip": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      const it = a.items.get(msg.itemId)
      if (!it) throw new Error("Item not found: " + msg.itemId)
      const slot = String(msg.slot || "")
      const ctx = ahHeadlessCtx(a)
      const m = ctx.metaById[msg.itemId] || { equipSlots: [] }
      if (!ahFreeBody(ctx, m).has(slot)) throw new Error("That slot isn't available for this item")
      if (slot === "Back") { if (ctx.back.indexOf(msg.itemId) < 0) ctx.back.push(msg.itemId) } else ctx.worn[msg.itemId] = slot
      await a.setFlag(MOD, "ahEquip", { worn: ctx.worn, back: ctx.back })
      try { const pl = a.getFlag(MOD, "ahPlace") || {}; let ch = false; for (const k of Object.keys(pl)) { if (k === msg.itemId || k.startsWith(msg.itemId + "#")) { delete pl[k]; ch = true } } if (ch) await a.setFlag(MOD, "ahPlace", pl) } catch {}   // clear the item's placement + every bundle uid
      try { if (it.system && ("equipped" in it.system)) await it.update({ "system.equipped": true }) } catch {}
      await ahRecomputeActor(a)
      return bridge.reply(msg.reqId, { type: "antihammer.actor", actor: AH.actorSummary(a, AH.cfg()) })
    }
    case "antihammer.unequip": {
      const a = game.actors.get(msg.actorId)
      if (!a) throw new Error("Actor not found: " + msg.actorId)
      const ctx = ahHeadlessCtx(a)
      delete ctx.worn[msg.itemId]; ctx.back = ctx.back.filter(x => x !== msg.itemId)
      await a.setFlag(MOD, "ahEquip", { worn: ctx.worn, back: ctx.back })
      try { const it = a.items.get(msg.itemId); if (it && it.system && ("equipped" in it.system)) await it.update({ "system.equipped": false }) } catch {}
      await ahRecomputeActor(a)
      return bridge.reply(msg.reqId, { type: "antihammer.actor", actor: AH.actorSummary(a, AH.cfg()) })
    }
    case "antihammer.gear.add": {
      const a = game.actors.get(msg.actorId); if (!a) throw new Error("Actor not found: " + msg.actorId)
      const kind = String(msg.kind || ""); if (!ahGearCatalog()[kind]) throw new Error("Unknown gear: " + kind)
      const list = ahGearList(a).slice(); list.push({ id: "g" + Math.random().toString(36).slice(2, 8), kind })
      await a.setFlag(MOD, "ahGear", list); await ahRecomputeActor(a)
      return bridge.reply(msg.reqId, { type: "antihammer.actor", actor: AH.actorSummary(a, AH.cfg()) })
    }
    case "antihammer.gear.remove": {
      const a = game.actors.get(msg.actorId); if (!a) throw new Error("Actor not found: " + msg.actorId)
      await a.setFlag(MOD, "ahGear", ahGearList(a).filter(g => g.id !== msg.gearId)); await ahRecomputeActor(a)
      return bridge.reply(msg.reqId, { type: "antihammer.actor", actor: AH.actorSummary(a, AH.cfg()) })
    }
    // DM-authored storage-gear catalog (custom belts/packs), shared world-wide.
    case "antihammer.gear.defs.get": {
      return bridge.reply(msg.reqId, { type: "antihammer.gear.defs", builtin: AH_GEAR, order: AH_GEAR_ORDER, custom: ahGearDefs() })
    }
    case "antihammer.gear.defs.set": {
      if (!game.user?.isGM) throw new Error("Only the GM can edit storage gear")
      const id = String(msg.id || "").trim(); if (!id) throw new Error("Missing gear id")
      if (AH_GEAR[id]) throw new Error("Can't overwrite a built-in: " + id)
      const defs = { ...ahGearDefs() }
      if (msg.def == null) { delete defs[id] }
      else {
        const grants = {}
        for (const k of Object.keys((msg.def.grants) || {})) { const n = Number(msg.def.grants[k]) || 0; if (n > 0) grants[k] = n }
        defs[id] = { name: String(msg.def.name || "Storage item").slice(0, 40), storage: Math.max(0, Number(msg.def.storage) || 0), grants }
      }
      await game.settings.set(MOD, "ahGearDefs", defs)
      await ahRecomputeAll()           // storage/grants may change for actors carrying it
      ahRerenderSheets()
      return bridge.reply(msg.reqId, { type: "antihammer.gear.defs", builtin: AH_GEAR, order: AH_GEAR_ORDER, custom: ahGearDefs() })
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

function ahAnyActiveGM() { try { return game.users.some(u => u.active && u.isGM) } catch { return false } }
/** GM-authoritative reconcile (SHEET-INDEPENDENT, runs from the recompute hooks): clear dnd5e
 *  system.equipped on any item the validator EVICTED, prune the ahEquip flag, and drop orphaned
 *  ahPlace unit keys. Idempotent — guards make repeat runs no-ops so there's no hook loop. */
async function ahReconcileEquip(actor) {
  if (!game.user?.isGM || !actor) return
  if (actor.type === "group" || actor.type === "party") return
  const metaById = {}, byId = {}
  for (const it of actor.items) { byId[it.id] = true; try { metaById[it.id] = ahMeta(it) } catch { metaById[it.id] = { equipSlots: [] } } }
  let eq; try { eq = ahBuildEquip(actor, metaById, byId) } catch { return }
  // equipped sync + ahEquip prune: any saved-equipped id not in the validated set was evicted
  let savedEq = {}; try { savedEq = actor.getFlag(MOD, "ahEquip") || {} } catch {}
  const savedIds = new Set([...Object.keys(savedEq.worn || {}), ...(Array.isArray(savedEq.back) ? savedEq.back : [])])
  const nowIds = new Set(Object.keys(eq.worn).concat(eq.back))
  let eqChanged = savedIds.size !== nowIds.size
  for (const id of savedIds) if (!nowIds.has(id)) { eqChanged = true; const it = actor.items.get(id); if (it && it.system && ("equipped" in it.system) && it.system.equipped) { try { await it.update({ "system.equipped": false }) } catch {} } }
  if (eqChanged) { try { await actor.setFlag(MOD, "ahEquip", { worn: eq.worn, back: eq.back }) } catch {} }
  // prune orphaned ahPlace unit keys (deleted items / shrunk bundles / now-worn)
  try {
    const cfg = AH.cfg(), valid = new Set()
    for (const it of actor.items) {
      if (!AH.counted(it, cfg) || nowIds.has(it.id)) continue
      const bi = ahBundleInfo(it, cfg)
      if (bi.active && bi.count > 1) { for (let k = 0; k < bi.count; k++) valid.add(it.id + "#" + k) } else valid.add(it.id)
    }
    const place = actor.getFlag(MOD, "ahPlace") || {}, keys = Object.keys(place)
    const keep = keys.filter(k => valid.has(k))
    if (keep.length !== keys.length) { const np = {}; for (const k of keep) np[k] = place[k]; await actor.setFlag(MOD, "ahPlace", np) }
  } catch {}
}

/** Persist a bag's authoritative totals onto the actor. GM-only; no-op if unchanged. */
async function ahRecomputeActor(actor) {
  if (!game.user?.isGM || !actor) return
  if (actor.type === "group" || actor.type === "party") return
  try { await ahReconcileEquip(actor) } catch {}   // clear stale equipped + prune flags (no open sheet needed)
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

// ── hex inventory puzzle (model A: shaped items dragged into a 4-tall comb) ──
// The bag is a 4-row honeycomb that grows rightward (one column = 4 hexes) and
// scrolls horizontally. It starts EMPTY: the actor's owner drags each item in;
// an item occupies a SHAPE of connected hexes sized to its space cost; it only
// drops where the shape fits empty cells (R rotates). Placements persist in the
// owner-writable actor flag `ahPlace` ({itemId:{col,row,rot}}); the authoritative
// totals (used/capacity/overflow) still come from the GM-written `ah` flag.
const AH_COLORS = ["#4d83c4", "#9a5cc6", "#5aa84a", "#cf9a3a", "#c45f7e", "#6f78cf", "#3aa9b3", "#c9a13f", "#a06bce", "#7fb04a", "#cf7a3a", "#5bb0a0"]
function ahColorFor(id) { const s = String(id || ""); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AH_COLORS[h % AH_COLORS.length] }
function ahHashOf(s) { s = String(s || ""); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h }
function ahShort(name) { const w = String(name || "").trim().split(/\s+/)[0] || ""; return w.length > 7 ? w.slice(0, 6) + "…" : w }
/** Short at-a-glance mark for a packed shape (full name lives in the legend). */
function ahMark(name) { const ws = String(name || "").trim().split(/\s+/).filter(Boolean); if (!ws.length) return "?"; if (ws.length === 1) return ws[0].slice(0, 2).toUpperCase(); return (ws[0][0] + ws[1][0]).toUpperCase() }
function ahCellSize(it) { return Math.max(1, Math.ceil(Number(it.spaces) || 0)) }

// Tray grouping by carry type (interim — the full rules engine refines this later).
const AH_GROUP_ORDER = ["Weapons", "Equipment", "Containers", "Consumables", "Tools", "Loot", "Other"]
function ahCarryGroup(type) {
  switch (type) {
    case "weapon": return "Weapons"
    case "equipment": return "Equipment"
    case "container": case "backpack": case "equipmentpack": return "Containers"
    case "consumable": return "Consumables"
    case "tool": return "Tools"
    case "loot": return "Loot"
    default: return "Other"
  }
}

// Shape library by cell-count (cube-coord offsets); fallback = straight line.
const AH_SHAPES = {
  1: [[[0, 0, 0]]],
  2: [[[0, 0, 0], [1, -1, 0]]],
  3: [[[0, 0, 0], [1, -1, 0], [2, -2, 0]], [[0, 0, 0], [1, -1, 0], [1, 0, -1]]],
  4: [[[0, 0, 0], [1, -1, 0], [1, 0, -1], [2, -1, -1]], [[0, 0, 0], [1, -1, 0], [2, -2, 0], [1, 0, -1]]],
  5: [[[0, 0, 0], [1, -1, 0], [2, -2, 0], [1, 0, -1], [2, -1, -1]]],
  6: [[[0, 0, 0], [1, -1, 0], [2, -2, 0], [0, 1, -1], [1, 0, -1], [2, -1, -1]]],
}
function ahShapeFor(size, h) {
  size = Math.max(1, size | 0)
  const lib = AH_SHAPES[size]; if (lib) return lib[(((h | 0) % lib.length) + lib.length) % lib.length]
  // Any larger size → a COMPACT blob (≤4 tall, laid out column-major exactly like the
  // bag's own cells) so it always fits the grid instead of a long unplaceable line.
  const H = Math.min(4, size), cells = []
  for (let i = 0; i < size; i++) cells.push(ahOToC(Math.floor(i / H), i % H))
  const o = cells[0]
  return cells.map(c => [c[0] - o[0], c[1] - o[1], c[2] - o[2]])
}

// cube ↔ odd-r offset, rotation, placement cells
function ahOToC(col, row) { const x = col - (row - (row & 1)) / 2, z = row; return [x, -x - z, z] }
function ahCToO(c) { return { col: c[0] + (c[2] - (c[2] & 1)) / 2, row: c[2] } }
function ahRotCW(c) { return [-c[2], -c[0], -c[1]] }
function ahRotN(c, n) { let r = c; n = ((n % 6) + 6) % 6; for (let i = 0; i < n; i++) r = ahRotCW(r); return r }
function ahCellsFor(item, anchor, rot) {
  const ac = ahOToC(anchor.col, anchor.row)
  return item.shape.map(o => { const r = ahRotN(o, rot); return ahCToO([ac[0] + r[0], ac[1] + r[1], ac[2] + r[2]]) })
}

// board geometry — 4 rows tall, ceil(capacity/4) columns; the valid cells are the
// first `capacity` cells filled column-by-column (so the last column may be short).
function ahGeom(capacity) {
  const S = 22, HW = Math.sqrt(3) * S, ROWS = 4
  const COLS = Math.max(1, Math.ceil((capacity || 0) / 4))
  const originX = HW / 2 + 3, originY = S + 3
  const width = originX + HW * (COLS - 1 + 0.5) + HW / 2 + 4
  const height = originY + 1.5 * S * (ROWS - 1) + S + 4
  return { S, HW, ROWS, COLS, originX, originY, width, height }
}
function ahValidCells(capacity) {
  const list = [], set = new Set()
  for (let i = 0; i < capacity; i++) { const col = Math.floor(i / 4), row = i % 4; list.push({ col, row }); set.add(col + "," + row) }
  return { list, set }
}
function ahCenter(g, col, row) { return { x: g.originX + g.HW * (col + 0.5 * (row & 1)), y: g.originY + 1.5 * g.S * row } }
function ahPts(cx, cy, s) { let p = ""; for (let i = 0; i < 6; i++) { const a = (60 * i - 90) * Math.PI / 180; p += (cx + s * Math.cos(a)).toFixed(1) + "," + (cy + s * Math.sin(a)).toFixed(1) + " " } return p.trim() }
function ahEscX(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") }

/** Read the saved placements, keeping only ones that still fit (in-board, no overlap). */
function ahBuildPlaced(actor, unitById, validSet) {
  let place = {}; try { place = actor.getFlag(MOD, "ahPlace") || {} } catch {}
  if (!place || typeof place !== "object") place = {}
  const placed = new Map(), occ = new Set()
  for (const id of Object.keys(place)) {
    const it = unitById[id]; if (!it) continue   // id is a unit id (bundle "itemId#k" or plain itemId)
    const p = place[id]; if (!p || p.col == null) continue
    const cs = ahCellsFor(it, { col: p.col, row: p.row }, p.rot | 0)
    let ok = true
    for (const c of cs) { const k = c.col + "," + c.row; if (!validSet.has(k) || occ.has(k)) { ok = false; break } }
    if (!ok) continue
    for (const c of cs) occ.add(c.col + "," + c.row)
    placed.set(id, { col: p.col, row: p.row, rot: p.rot | 0 })
  }
  return placed
}
function ahOcc(ctx, excludeId) {
  const m = new Set()
  ctx.placed.forEach((p, id) => { if (id === excludeId) return; const u = ctx.unitById[id]; if (!u) return; for (const c of ahCellsFor(u, p, p.rot)) m.add(c.col + "," + c.row) })
  return m
}
function ahValid(ctx, cs, excludeId) {
  const occ = ahOcc(ctx, excludeId)
  for (const c of cs) { const k = c.col + "," + c.row; if (!ctx.validSet.has(k) || occ.has(k)) return false }
  return true
}
// Can this item be packed in the bag at all? Worn-only gear (armor/clothing/containers,
// or a DM `baggable:false` override) can't — it must be worn, never bagged.
function ahCanBag(ctx, id) { const u = ctx.unitById && ctx.unitById[id]; const m = ctx.metaById && ctx.metaById[u ? u.itemId : id]; return !m || m.baggable !== false }
// ── bagMode: container type-restriction enforcement (merged vs separate) ─────
/** Coarse type tag a dnd5e item maps to (referenced by a container's accepted `types`). */
function ahItemTypeTag(item) {
  try {
    const t = String((item && item.type) || "").toLowerCase()
    if (t === "tool") return "tool"
    if (t === "consumable") {
      const st = String((((item.system || {}).type) || {}).value || "").toLowerCase()
      if (st === "potion") return "potion"
      if (st === "scroll") return "scroll"
      if (st === "ammo" || st === "ammunition") return "ammo"
    }
  } catch {}
  return "general"
}
/** Equipped storage as { cap, types } — add-on gear (catalog) + container ITEMS (accept anything). */
function ahBagContainers(ctx) {
  const out = [], cat = ahGearCatalog()
  for (const g of ahGearList(ctx.actor)) { const c = cat[g.kind]; const cap = Number(c && c.storage) || 0; if (cap > 0) out.push({ cap, types: (c && c.types) || null }) }
  const capEach = Number(ctx.capEach) || 0
  if (capEach > 0) for (const id of ahEquippedIds(ctx)) { const m = ctx.metaById[id]; if (m && m.carryType === "Container") out.push({ cap: capEach, types: null }) }
  // Strength bonus = extra general capacity (matches the grid's baseBag + ahStrBonus), so the
  // separate-mode greedy total never disagrees with the number of hexes drawn.
  if (out.length) { const sb = ahStrBonus(ctx.actor, ctx.cfg || AH.cfg()); if (sb > 0) out.push({ cap: sb, types: null }) }
  return out
}
function ahTagFor(ctx, realId) { try { return ahItemTypeTag(ctx.actor.items.get(realId)) } catch { return "general" } }
/** SEPARATE mode: can every packed unit PLUS `candId` be greedily assigned to a container
 *  (by spaces + accepted type)? Specific containers fill before catch-all ones. */
function ahSeparateFits(ctx, candId) {
  const conts = ahBagContainers(ctx).map(c => ({ cap: c.cap, types: c.types, used: 0 }))
  if (!conts.length) return true
  const ids = new Set(ctx.placed ? Array.from(ctx.placed.keys()) : []); ids.add(candId)
  const units = Array.from(ids).map(id => ctx.unitById[id]).filter(Boolean).sort((a, b) => (b.spaces || 1) - (a.spaces || 1))
  for (const u of units) {
    const tag = ahTagFor(ctx, u.itemId || u.id), sp = u.spaces || 1
    const fit = conts.filter(c => (!c.types || c.types.indexOf(tag) >= 0) && c.used + sp <= c.cap)
      .sort((a, b) => (a.types ? a.types.length : 99) - (b.types ? b.types.length : 99))
    if (!fit.length) return false
    fit[0].used += sp
  }
  return true
}
/** bagMode gate for ADDING a unit to the bag (extends ahCanBag). */
function ahBagAccepts(ctx, id) {
  if (!ahCanBag(ctx, id)) return false
  const conts = ahBagContainers(ctx); if (!conts.length) return true
  if (ctx.separate) return ahSeparateFits(ctx, id)
  const u = ctx.unitById && ctx.unitById[id], realId = u ? u.itemId : id, tag = ahTagFor(ctx, realId)
  return conts.some(c => !c.types || c.types.indexOf(tag) >= 0)   // merged: any container accepts the type
}

/** SVG for one packed item's footprint in the "constellation" look (the user's hex-bag inspiration):
 *  small glowing hexes joined by connector bonds. The whole shape is the drag handle (data-item on
 *  every hex + bond). `centers` = pre-filtered valid cell centres. Returns the centroid for the mark. */
function ahItemHexSVG(g, centers, color, uid, canArrange) {
  const di = ' data-item="' + ahEscX(uid) + '" style="cursor:' + (canArrange ? "grab" : "default") + ";filter:drop-shadow(0 0 4px " + color + ')"'
  let svg = "", sx = 0, sy = 0
  // bonds first (under the hexes) — link hex-adjacent cells of THIS item (pointy-top: every
  // neighbour centre is HW = √3·S away), so a multi-cell item reads as one bonded cluster
  for (let i = 0; i < centers.length; i++) for (let j = i + 1; j < centers.length; j++) {
    const dx = centers[j].x - centers[i].x, dy = centers[j].y - centers[i].y, d = Math.hypot(dx, dy)
    if (d < g.HW * 1.18) {
      const mx = (centers[i].x + centers[j].x) / 2, my = (centers[i].y + centers[j].y) / 2, ang = (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1)
      const bl = g.S * 0.66, bw = g.S * 0.4
      svg += '<rect x="' + (mx - bl / 2).toFixed(1) + '" y="' + (my - bw / 2).toFixed(1) + '" width="' + bl.toFixed(1) + '" height="' + bw.toFixed(1) + '" rx="' + (bw / 2).toFixed(1) + '" transform="rotate(' + ang + " " + mx.toFixed(1) + " " + my.toFixed(1) + ')" fill="' + color + '"' + di + "/>"
    }
  }
  // the hexes, shrunk so the bonds + gaps read like the inspiration, each softly glowing
  for (const ct of centers) {
    svg += '<polygon points="' + ahPts(ct.x, ct.y, g.S * 0.8) + '" fill="' + color + '" stroke="rgba(0,0,0,.45)" stroke-width="1.5"' + di + "/>"
    sx += ct.x; sy += ct.y
  }
  return { svg, cx: sx / centers.length, cy: sy / centers.length, n: centers.length }
}

function ahBoardSVG(ctx) {
  const g = ctx.geom
  const names = []; ctx.placed.forEach((p, id) => { const u = ctx.unitById[id]; if (u) names.push(u.name) })
  const aria = "Item bag, " + (names.length ? names.length + " packed: " + names.join(", ") : "empty")
  let s = '<svg class="ah-svg" role="img" aria-label="' + ahEscX(aria) + '" width="' + g.width.toFixed(0) + '" height="' + g.height.toFixed(0) + '">'
  for (const c of ctx.validList) { const ct = ahCenter(g, c.col, c.row); s += '<polygon points="' + ahPts(ct.x, ct.y, g.S) + '" fill="rgba(0,0,0,0.26)" stroke="rgba(236,233,223,0.13)" stroke-width="2"/>' }
  ctx.placed.forEach((p, id) => {
    const it = ctx.unitById[id]; if (!it) return
    const centers = []
    for (const c of ahCellsFor(it, p, p.rot)) if (ctx.validSet.has(c.col + "," + c.row)) centers.push(ahCenter(g, c.col, c.row))
    if (!centers.length) return
    const r = ahItemHexSVG(g, centers, it.color, id, ctx.canArrange); s += r.svg
    // white mark with a dark halo so the 1–2 letter label stays legible on ANY item colour
    s += '<text x="' + r.cx.toFixed(1) + '" y="' + (r.cy + 3).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" stroke="rgba(0,0,0,.62)" stroke-width="2.6" stroke-linejoin="round" paint-order="stroke" style="pointer-events:none">' + ahEscX(ahMark(it.name)) + "</text>"
  })
  if (ctx.held && ctx.hover) {
    const canBag = ahBagAccepts(ctx, ctx.held.item.id)
    const fit = canBag ? ahSnapPlace(ctx, ctx.held.item, ctx.hover, ctx.held.rot) : null
    const cs = fit ? ahCellsFor(ctx.held.item, fit, ctx.held.rot) : ahCellsFor(ctx.held.item, ctx.hover, ctx.held.rot)
    const ok = !!fit
    let hx = 0, hy = 0, hn = 0
    for (const c of cs) {
      if (!ctx.validSet.has(c.col + "," + c.row)) continue
      const ct = ahCenter(g, c.col, c.row)
      s += '<polygon points="' + ahPts(ct.x, ct.y, g.S) + '" fill="' + (ok ? "rgba(121,189,102,.45)" : "rgba(216,97,95,.45)") + '" stroke="' + (ok ? "#79bd66" : "#d8615f") + '" stroke-width="2.5" style="pointer-events:none"/>'
      hx += ct.x; hy += ct.y; hn++
    }
    // non-colour drop cue: ✓ fits / ✕ no room at the preview centroid
    if (hn) s += '<text x="' + (hx / hn).toFixed(1) + '" y="' + (hy / hn + 5).toFixed(1) + '" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" stroke="rgba(0,0,0,.6)" stroke-width="3" stroke-linejoin="round" paint-order="stroke" style="pointer-events:none">' + (ok ? "✓" : "✕") + "</text>"
  }
  return s + "</svg>"
}

/** Colour legend under the bag: each packed item = swatch + full name + space cost. */
function ahLegendHTML(ctx) {
  const rows = []
  ctx.placed.forEach((p, id) => { const it = ctx.unitById[id]; if (it && !(p && p.of)) rows.push({ it, bin: p && p.bin }) })
  if (!rows.length) return ""
  rows.sort((a, b) => (ctx.separate ? String(a.bin || "").localeCompare(String(b.bin || "")) : 0) || (a.it.name || "").localeCompare(b.it.name || ""))
  return rows.map(({ it, bin }) => {
    const bi = ctx.byId[it.itemId]
    const canUse = ctx.canArrange && (((bi && bi.type === "consumable") && (bi.qty || 0) >= 1) || (it.uses && it.uses.value > 0))
    const use = canUse ? '<button type="button" class="ah-use" data-use="' + ahEscX(it.itemId) + '" aria-label="' + ahEscX((it.uses ? "Spend a charge of " : "Use one ") + it.name) + '" title="' + (it.uses ? "Spend a charge" : "Use one (−1)") + '">use</button>' : ""
    const ch = it.uses ? ' <span class="ah-leg-ch" title="charges">' + it.uses.value + (it.uses.max ? "/" + it.uses.max : "") + "</span>" : ""
    const unpack = ctx.canArrange ? '<button type="button" class="ah-leg-x" data-unpack="' + ahEscX(it.uid) + '" aria-label="' + ahEscX("Take " + it.name + " out of the bag") + '" title="Unpack to loose">' + ahIcon("undo") + "</button>" : ""
    // compact chip: swatch · name (which bin + size are already obvious from the per-container grids)
    return '<span class="ah-leg" title="' + ahEscX(it.name + (bin && ctx.binById && ctx.binById[bin] ? " — " + ctx.binById[bin].label : "")) + '"><i class="ah-leg-sw" style="background:' + it.color + '"></i><span class="ah-leg-nm">' + ahEscX(it.name) + (it.bundleQty != null ? ' <span class="ah-leg-bq">·' + it.bundleQty + "</span>" : "") + ch + "</span>" + use + unpack + "</span>"
  }).join("")
}
function ahRenderBoard(ctx) {
  if (ctx.separate) {
    for (const bin of (ctx.bins || [])) {
      const h = ctx.binHolders && ctx.binHolders[bin.binId]; if (h) h.innerHTML = ahBinBoardSVG(ctx, bin)
      const ce = ctx.binCapEls && ctx.binCapEls[bin.binId]
      if (ce) { let used = 0; ctx.placed.forEach((p, uid) => { if (p.bin === bin.binId && !p.of) { const u = ctx.unitById[uid]; if (u) used += (Number(u.spaces) || 0) } }); ce.textContent = ahFmt(used) + " / " + ahFmt(bin.cap) }
      const card = ctx.binCards && ctx.binCards[bin.binId]
      if (card) { const active = !!(ctx.held && ctx.hoverBin === bin.binId), ok = active && !!ahSepDropTarget(ctx, bin, ctx.held.id, ctx.held.rot, ctx.hoverCell); card.classList.toggle("drop-ok", active && ok); card.classList.toggle("drop-no", active && !ok) }
    }
    if (ctx.legendEl) ctx.legendEl.innerHTML = ahLegendHTML(ctx)
    return
  }
  if (ctx.holder) ctx.holder.innerHTML = ahBoardSVG(ctx)
  if (ctx.legendEl) ctx.legendEl.innerHTML = ahLegendHTML(ctx)
}
const AH_CARRY_ORDER = ["Weapon", "Armor", "Clothing", "Container", "Tool", "Consumable", "Treasure", "Cargo", "Miscellaneous"]
const AH_SIZE_OPTS = ["Tiny", "Small", "Medium", "Large", "Huge"]
const AH_CARRY_OPTS = ["Weapon", "Armor", "Clothing", "Tool", "Consumable", "Container", "Cargo", "Treasure", "Miscellaneous"]
const AH_SLOT_OPTS = ["Head", "Face", "Neck", "Chest", "Back", "Belt", "Left Hip", "Right Hip", "Left Hand", "Right Hand", "Feet", "Left Ring", "Right Ring"]
/** GM helper: patch one field of an item's `meta` override flag (null clears the field). */
async function ahSetMetaField(item, field, value) {
  try {
    const cur = (item.flags && item.flags[MOD] && item.flags[MOD].meta) || {}
    const next = Object.assign({}, cur)
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) delete next[field]
    else next[field] = value
    if (Object.keys(next).length) await item.setFlag(MOD, "meta", next)
    else await item.unsetFlag(MOD, "meta")
  } catch (e) { console.warn("[pendant-bridge] AH setMeta failed", e) }
}
const _ahTrayOpen = {}   // per-actor Set of expanded loose-tray categories (persists across re-renders)
function ahRenderTray(ctx) {
  if (!ctx.trayEl) return
  // loose = bag units not packed (and not the one being dragged). Bundled stacks show
  // one chip per bundle.
  const units = (ctx.units || []).filter(u => (!ctx.placed.has(u.uid) || (ctx.placed.get(u.uid) || {}).of) && !(ctx.held && ctx.held.id === u.uid))
  if (!units.length) { ctx.trayEl.innerHTML = '<span class="ah-tray-empty">Nothing loose — all worn or packed.</span>'; return }
  const groups = {}
  for (const u of units) { const ct = (ctx.metaById[u.itemId] && ctx.metaById[u.itemId].carryType) || "Miscellaneous"; (groups[ct] = groups[ct] || []).push(u) }
  // open/closed state persists per actor; first paint opens the small groups (big stacks stay a pill)
  const aid = (ctx.actor && ctx.actor.id) || "_"
  let openSet = _ahTrayOpen[aid]
  if (!openSet) { openSet = _ahTrayOpen[aid] = new Set(); for (const g of AH_CARRY_ORDER) { const a = groups[g]; if (a && a.length && a.length <= 8) openSet.add(g) } }
  let h = ""
  for (const g of AH_CARRY_ORDER) {
    const arr = groups[g]; if (!arr || !arr.length) continue
    arr.sort((a, b) => (a.name || "").localeCompare(b.name || "") || (a.bundleIdx || 0) - (b.bundleIdx || 0))
    const open = openSet.has(g), label = g === "Miscellaneous" ? "Other" : g
    // a compact category PILL in a flowing row; click → its items drop in inline right after it
    h += '<button type="button" class="ah-tcat' + (open ? " open" : "") + '" data-cat="' + ahEscX(g) + '" aria-expanded="' + (open ? "true" : "false") + '" title="' + ahEscX((open ? "Hide " : "Show ") + arr.length + " " + label.toLowerCase()) + '"><span class="ah-tcat-nm">' + ahEscX(label) + '</span><span class="ah-tcat-n">' + arr.length + "</span>" + ahIcon("caret", "ah-tcat-car") + "</button>"
    for (const u of arr) {
      const m = ctx.metaById[u.itemId] || {}
      const tag = (m.baggable === false ? '<span class="ah-tray-tag wear" title="Worn-only — can only be equipped on the body, never put in the bag">worn only</span>' : "")
        + (m.ignoreSlot ? '<span class="ah-tray-tag free" title="Doesn\'t need a slot — won\'t count as overflow">no slot</span>' : "")
        + (u.bundleCount > 1 ? '<span class="ah-tray-tag bundle" title="One bundle of ' + u.bundleQty + ' (' + (u.bundleIdx + 1) + ' of ' + u.bundleCount + ')">×' + u.bundleQty + "</span>" : "")
      const tip = (m.size || "") + (u.bundleCount > 1 ? " · bundle " + (u.bundleIdx + 1) + "/" + u.bundleCount + " (" + u.bundleQty + ")" : "") + (m.baggable === false ? " · wear only" : "") + (m.ignoreSlot ? " · no slot needed" : "") + (m.needsBackPoint ? " · needs a Back point" : "")
      const bi = ctx.byId[u.itemId]
      const canUse = ctx.canArrange && ((bi && bi.type === "consumable" && (bi.qty || 0) >= 1) || (u.uses && u.uses.value > 0))
      const useBtn = canUse ? '<button type="button" class="ah-use" data-use="' + ahEscX(u.itemId) + '" aria-label="' + ahEscX((u.uses ? "Spend a charge of " : "Use one ") + u.name) + '" title="' + (u.uses ? "Spend a charge" : "Use one (−1)") + '">use</button>' : ""
      const ch = u.uses ? ' <span class="ah-tray-ch" title="charges">' + u.uses.value + (u.uses.max ? "/" + u.uses.max : "") + "</span>" : ""
      const kb = ctx.canArrange ? ' tabindex="0" aria-label="' + ahEscX("Stow " + u.name + " — press Enter to pack it into the bag") + '"' : ""
      h += '<div class="ah-tray-it' + (open ? "" : " collapsed") + '" data-cat="' + ahEscX(g) + '" data-tray="' + ahEscX(u.uid) + '"' + (ctx.canArrange ? ' style="cursor:grab"' : "") + kb + ' title="' + ahEscX(tip) + '">' + ahArtThumb(u.img, u.color, "stack") + '<span class="ah-tray-nm">' + ahEscX(u.name) + "</span>" + ch + tag + '<span class="ah-tray-sz">' + ahFmt(u.spaces) + "</span>" + useBtn + "</div>"
    }
  }
  ctx.trayEl.innerHTML = h
}

/** Map a cursor event to the nearest hex (col,row) of a SPECIFIC grid SVG + its geometry. Used for
 *  the merged board AND each separate-mode mini-grid (one geom per bin), so manual placement tracks
 *  the cursor in whichever grid it's over. Returns null if off the grid (beyond the edge slack). */
function ahPixelCellGeom(svg, g, e) {
  if (!svg || !svg.isConnected || !g) return null
  // Map the cursor into the SVG's OWN coordinate space via its screen matrix. This is exact
  // under horizontal scroll, CSS zoom, and the app panel's scale() — unlike a hand-rolled
  // width-ratio, which drifts the preview away from the cursor the more the sheet is scaled.
  let lx, ly
  try {
    const ctm = svg.getScreenCTM(); if (!ctm) return null
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY
    const loc = pt.matrixTransform(ctm.inverse()); lx = loc.x; ly = loc.y
  } catch {
    const r = svg.getBoundingClientRect(); if (!r.width || !r.height) return null
    lx = (e.clientX - r.left) * (g.width / r.width); ly = (e.clientY - r.top) * (g.height / r.height)
  }
  if (lx < -g.HW || lx > g.width + g.HW || ly < -g.S || ly > g.height + g.S) return null   // slack for edge drops
  const px = lx - g.originX, py = ly - g.originY
  // pointy-top pixel → axial → cube → cube-round = the true nearest hex (accurate at edges,
  // unlike the old rectangular-bin guess that could land a cell off and drop the item off-grid).
  const qf = (Math.sqrt(3) / 3 * px - 1 / 3 * py) / g.S
  const rf = (2 / 3 * py) / g.S
  let cx = qf, cz = rf, cy = -cx - cz
  let rx = Math.round(cx), ry = Math.round(cy), rz = Math.round(cz)
  const dx = Math.abs(rx - cx), dy = Math.abs(ry - cy), dz = Math.abs(rz - cz)
  if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry
  const cell = ahCToO([rx, ry, rz])
  let row = cell.row; if (row < 0) row = 0; if (row > g.ROWS - 1) row = g.ROWS - 1
  let col = cell.col; if (col < 0) col = 0
  return { col, row }
}
function ahPixelCell(ctx, e) { const svg = ctx.holder && ctx.holder.querySelector(".ah-svg"); return ahPixelCellGeom(svg, ctx.geom, e) }
function ahCellEq(a, b) { if (!a && !b) return true; if (!a || !b) return false; return a.col === b.col && a.row === b.row }
/** The anchor where `item` (at `rot`) actually fits: the hovered cell, else the nearest
 *  open spot within 2 cells. Lets an edge/overhanging drop snap in instead of vanishing. */
function ahSnapPlace(ctx, item, anchor, rot) {
  if (!anchor) return null
  const fits = (col, row) => ahValid(ctx, ahCellsFor(item, { col, row }, rot), null)
  if (fits(anchor.col, anchor.row)) return { col: anchor.col, row: anchor.row }
  for (let d = 1; d <= 2; d++) {
    for (let dr = -d; dr <= d; dr++) for (let dc = -d; dc <= d; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== d) continue
      if (fits(anchor.col + dc, anchor.row + dr)) return { col: anchor.col + dc, row: anchor.row + dr }
    }
  }
  return null
}
/** REPLACE a flag object so REMOVED keys actually go away. setFlag does a recursive MERGE, which
 *  never deletes sub-keys — so unpacking / un-binning silently failed. Here we set each desired key
 *  and emit a `-=key` deletion for every key that's gone, in one update. */
function ahSaveFlagObj(actor, key, obj) {
  try {
    let cur = {}; try { cur = actor.getFlag(MOD, key) || {} } catch {}
    if (!cur || typeof cur !== "object") cur = {}
    obj = obj || {}
    const upd = {}
    for (const k in obj) upd["flags." + MOD + "." + key + "." + k] = obj[k]
    for (const k in cur) if (!(k in obj)) upd["flags." + MOD + "." + key + ".-=" + k] = null   // delete keys no longer present
    if (Object.keys(upd).length) Promise.resolve(actor.update(upd)).catch(e => console.warn("[pendant-bridge] AH flag save failed", e))
  } catch (e) { console.warn("[pendant-bridge] AH flag save failed", e) }
}
function ahSavePlace(actor, place) { ahSaveFlagObj(actor, "ahPlace", place) }

/** Auto-pack every baggable bag unit into the grid (first-fit-decreasing). Returns a placement Map. */
function ahAutoPack(ctx) {
  const units = ctx.units.filter(u => ahCanBag(ctx, u.uid))
  units.sort((a, b) => ((b.shape ? b.shape.length : 1) - (a.shape ? a.shape.length : 1)) || String(a.uid).localeCompare(String(b.uid)))   // biggest first packs tighter
  const occ = new Set(), place = new Map()
  const fits = (cells) => { for (const c of cells) { const k = c.col + "," + c.row; if (!ctx.validSet.has(k) || occ.has(k)) return false } return true }
  // honour the container gate so Tidy can't pack what a drag/keyboard add would reject
  const separate = !!ctx.separate
  const conts = ahBagContainers(ctx).map(c => ({ cap: c.cap, types: c.types, used: 0 }))
  const pick = (u) => {   // true = accept (merged / no containers) · a container = accept+consume (separate) · null = reject
    if (!conts.length) return true
    const tag = ahTagFor(ctx, u.itemId || u.uid), sp = u.spaces || 1
    if (!separate) return conts.some(c => !c.types || c.types.indexOf(tag) >= 0) ? true : null
    return conts.filter(c => (!c.types || c.types.indexOf(tag) >= 0) && c.used + sp <= c.cap)
      .sort((a, b) => (a.types ? a.types.length : 99) - (b.types ? b.types.length : 99))[0] || null
  }
  for (const u of units) {
    const slot = pick(u); if (!slot) continue   // no container accepts/has room → leave it loose
    let done = false
    for (const cell of ctx.validList) {
      for (let rot = 0; rot < 6; rot++) {
        const cells = ahCellsFor(u, cell, rot)
        if (fits(cells)) { for (const c of cells) occ.add(c.col + "," + c.row); place.set(u.uid, { col: cell.col, row: cell.row, rot }); done = true; break }
      }
      if (done) break
    }
    if (done && separate && slot !== true) slot.used += (u.spaces || 1)   // consume container capacity only when actually placed
  }
  return place
}
/** First valid anchor+rotation where one unit fits the bag (for the keyboard "stow" action). */
function ahFitOne(ctx, unit) {
  if (!ahBagAccepts(ctx, unit.uid)) return null
  for (const cell of ctx.validList) for (let rot = 0; rot < 6; rot++) {
    if (ahValid(ctx, ahCellsFor(unit, cell, rot), null)) return { col: cell.col, row: cell.row, rot }
  }
  return null
}
/** Keyboard "stow" (no drag): pack the unit into the bag if it fits, else equip it to a free slot. */
function ahStowItem(ctx, uid) {
  const u = ctx.unitById[uid]; if (!u) return
  if (ctx.separate) { if (ahStowSep(ctx, uid)) return }
  else { const fit = ahFitOne(ctx, u); if (fit) { ctx.placed.set(uid, fit); ahSavePlace(ctx.actor, ahPlaceObj(ctx)); return } }
  const realId = u.itemId || uid, m = ctx.metaById[realId]
  if (m && (ctx.bundleN[realId] || 1) <= 1) {
    const free = ahFreeBody(ctx, m)
    if (free.size) { let slot = null; for (const s of (m.equipSlots || [])) { const k = AH_SLOT_KEY[s] || s; if (free.has(k)) { slot = k; break } } if (!slot) slot = [...free][0]; ahEquipItem(ctx, realId, slot); return }
  }
  try {
    if (typeof ui !== "undefined" && ui.notifications) {
      let why = "no room in the bag and no free body slot"
      const conts = ahBagContainers(ctx)   // distinguish a type restriction from plain "no space"
      if (conts.length && !conts.some(c => !c.types || c.types.indexOf(ahTagFor(ctx, realId)) >= 0)) why = "no equipped container can hold this kind of item"
      ui.notifications.warn(u.name + ": " + why + ".")
    }
  } catch {}
}
/** Keyboard "unpack" (no drag): pull a packed item back out to the loose tray. */
function ahUnplaceItem(ctx, uid) { if (!ctx.placed.has(uid)) return; if (ctx.separate) { ahAssignUnit(ctx, uid, null) } else { ctx.placed.delete(uid); ahPersistPlace(ctx) } }

// ════════════════════════════════════════════════════════════════════════════
// SEPARATE bag mode — one mini hex-grid per container (gated to cfg.bagMode === "separate").
// A "bin" is one piece of storage the actor has (a worn container item, an add-on gear
// container, or the Strength bonus). Units are ASSIGNED to a bin — flag `ahPlaceSep` =
// {uid: binId} (owner-writable, kept SEPARATE from merged's `ahPlace` so switching modes never
// clobbers the other) — and AUTO-PACKED within their bin (no manual per-cell arranging, which
// is what keeps the multi-grid drag robust: a drop only has to decide WHICH bin, never WHERE).
// Σ bin.cap === bagCapacity, so the panel's meter/overflow totals are identical to merged.
// Merged mode (the default) never enters any of this code — ctx.separate stays false.
// ════════════════════════════════════════════════════════════════════════════

/** The actor's storage as identified bins (stable id + label + colour + own geometry). Same set
 *  and caps as ahBagContainers, so Σ bin.cap === bagCapacity. */
function ahSepBins(ctx) {
  const bins = [], cat = ahGearCatalog()
  const capEach = Number(ctx.capEach) || 0
  if (capEach > 0) for (const id of ahEquippedIds(ctx)) {
    const m = ctx.metaById[id]
    if (m && m.carryType === "Container") { const it = ctx.byId[id]; bins.push({ binId: "it:" + id, label: it ? it.name : "Container", kind: "container", cap: capEach, types: null, color: it ? it.color : "#7f8395" }) }
  }
  for (const g of ahGearList(ctx.actor)) {
    const c = cat[g.kind]; const cap = Number(c && c.storage) || 0
    if (cap > 0) bins.push({ binId: "gr:" + g.id, label: c.name, kind: "gear", cap, types: (c && c.types) || null, color: ahColorFor("gear:" + g.id) })
  }
  if (bins.length) { const sb = ahStrBonus(ctx.actor, ctx.cfg || AH.cfg()); if (sb > 0) bins.push({ binId: "str", label: "Raw strength", kind: "str", cap: sb, types: null, color: "#8a6db0" }) }
  for (const b of bins) { b.geom = ahGeom(b.cap); const vc = ahValidCells(b.cap); b.validList = vc.list; b.validSet = vc.set }
  return bins
}
/** First-fit-decreasing pack `units` into one bin's grid. Returns Map(uid → {col,row,rot}) of the
 *  units that fit (biggest shapes first → tighter packing). Used for both drawing AND fit-testing. */
function ahPackInto(bin, units) {
  const us = units.slice().sort((a, b) => ((b.shape ? b.shape.length : 1) - (a.shape ? a.shape.length : 1)) || String(a.uid).localeCompare(String(b.uid)))
  const occ = new Set(), out = new Map()
  const fits = (cells) => { for (const c of cells) { const k = c.col + "," + c.row; if (!bin.validSet.has(k) || occ.has(k)) return false } return true }
  for (const u of us) {
    let done = false
    for (const cell of bin.validList) { for (let rot = 0; rot < 6; rot++) { const cells = ahCellsFor(u, cell, rot); if (fits(cells)) { for (const c of cells) occ.add(c.col + "," + c.row); out.set(u.uid, { col: cell.col, row: cell.row, rot }); done = true; break } } if (done) break }
  }
  return out
}
// ── per-cell MANUAL placement within a bin (the merged-style "choose the exact hex + R to rotate",
//    now per container). `ahPlaceSep[uid]` is EITHER a bin-id STRING (auto-pack — legacy / Tidy /
//    keyboard-stow) OR an object `{bin,col,row,rot}` (the user dropped it on a specific hex). These
//    two readers normalise both forms; ahSepEntryEq compares them (idempotent saves / self-heal). ──
function ahSepBinOf(a) { return (typeof a === "string") ? a : (a && a.bin) || null }
function ahSepCellOf(a) { return (a && typeof a === "object" && a.col != null) ? { col: a.col, row: a.row, rot: a.rot | 0 } : null }
function ahSepEntryEq(a, b) {
  if (a === b) return true
  const sa = typeof a === "string", sb = typeof b === "string"
  if (sa || sb) return a === b
  if (!a || !b) return false
  return a.bin === b.bin && a.col === b.col && a.row === b.row && (a.rot | 0) === (b.rot | 0)
}
/** Occupied cells in `binId` from CURRENT placements (excludes `excludeUid` and overflow markers) —
 *  the free space a manual drop must fit into, WITHOUT rearranging the items already in the bin. */
function ahBinOcc(ctx, binId, excludeUid) {
  const m = new Set()
  ctx.placed.forEach((p, uid) => { if (uid === excludeUid || !p || p.bin !== binId || p.of || p.col == null) return; const u = ctx.unitById[uid]; if (!u) return; for (const c of ahCellsFor(u, p, p.rot)) m.add(c.col + "," + c.row) })
  return m
}
function ahBinFitsAt(bin, occ, item, anchor, rot) {
  for (const c of ahCellsFor(item, anchor, rot)) { const k = c.col + "," + c.row; if (!bin.validSet.has(k) || occ.has(k)) return false }
  return true
}
/** The anchor where `item` (at `rot`) fits in `bin`: the hovered cell, else the nearest open spot
 *  within 2 cells (so an edge/overhanging drop snaps in instead of vanishing — mirrors merged). */
function ahBinSnap(bin, occ, item, anchor, rot) {
  if (!anchor) return null
  if (ahBinFitsAt(bin, occ, item, anchor, rot)) return { col: anchor.col, row: anchor.row }
  for (let d = 1; d <= 2; d++) for (let dr = -d; dr <= d; dr++) for (let dc = -d; dc <= d; dc++) {
    if (Math.max(Math.abs(dr), Math.abs(dc)) !== d) continue
    if (ahBinFitsAt(bin, occ, item, { col: anchor.col + dc, row: anchor.row + dr }, rot)) return { col: anchor.col + dc, row: anchor.row + dr }
  }
  return null
}
/** Pack a bin honouring EXPLICIT per-cell placements first, then FFD the rest into the cells they
 *  leave free. `explicit` = Map(uid → {col,row,rot}) of requested cells (validated here — an out-of-
 *  grid / colliding request silently falls through to the auto pass). Returns Map(uid → {col,row,rot})
 *  of everything that fit; callers mark the leftovers as overflow. */
function ahPackBinPlaced(bin, units, explicit) {
  const occ = new Set(), out = new Map()
  const cellsOk = (cells) => { for (const c of cells) { const k = c.col + "," + c.row; if (!bin.validSet.has(k) || occ.has(k)) return false } return true }
  const claim = (cells) => { for (const c of cells) occ.add(c.col + "," + c.row) }
  // 1) explicit requested cells, stable order so collision resolution is deterministic
  const exUnits = units.filter(u => explicit && explicit.has(u.uid)).sort((a, b) => String(a.uid).localeCompare(String(b.uid)))
  const placedExplicit = new Set()
  for (const u of exUnits) {
    const req = explicit.get(u.uid), rot = req.rot | 0, cells = ahCellsFor(u, { col: req.col, row: req.row }, rot)
    if (cellsOk(cells)) { claim(cells); out.set(u.uid, { col: req.col, row: req.row, rot }); placedExplicit.add(u.uid) }
  }
  // 2) the rest — auto-pack FFD (biggest first) into the cells the explicit ones left free
  const auto = units.filter(u => !placedExplicit.has(u.uid)).sort((a, b) => ((b.shape ? b.shape.length : 1) - (a.shape ? a.shape.length : 1)) || String(a.uid).localeCompare(String(b.uid)))
  for (const u of auto) {
    let done = false
    for (const cell of bin.validList) { for (let rot = 0; rot < 6; rot++) { const cells = ahCellsFor(u, cell, rot); if (cellsOk(cells)) { claim(cells); out.set(u.uid, { col: cell.col, row: cell.row, rot }); done = true; break } } if (done) break }
  }
  return out
}
/** Where a held unit would land if dropped over `bin` with the cursor at `cell` (in the bin's grid).
 *  Returns {col,row,rot} (ALWAYS a concrete, fitting cell) or null if it can't go in at all (wrong
 *  type / bin full). Prefers the cursor cell (snap within 2 — what the player sees) and only falls
 *  back to the first free spot when the cursor is on a packed area, so preview === where it lands. */
function ahSepDropTarget(ctx, bin, uid, rot, cell) {
  const u = ctx.unitById[uid]; if (!u) return null
  if (!ahCanBag(ctx, uid)) return null
  if (bin.types && bin.types.indexOf(ahTagFor(ctx, u.itemId)) < 0) return null
  const occ = ahBinOcc(ctx, bin.binId, uid)
  // HONOUR the chosen rotation: snap within 2 of the cursor at THIS rotation (so R visibly rotates
  // the preview, and a shape that won't fit at the cursor shows RED instead of silently re-rotating
  // to some other cell — that silent re-rotate was why "R wasn't working").
  if (cell) { const snap = ahBinSnap(bin, occ, u, cell, rot); return snap ? { col: snap.col, row: snap.row, rot } : null }
  // dropped on the card but off the grid (no cursor hex) → first free spot at the SAME rotation
  for (const c of bin.validList) if (ahBinFitsAt(bin, occ, u, c, rot)) return { col: c.col, row: c.row, rot }
  return null
}
/** Unit objects actually PACKED in `binId` (excluding `exceptUid` and non-drawn overflow markers). */
function ahSepUnitsIn(ctx, binId, exceptUid) {
  const out = []; ctx.placed.forEach((p, uid) => { if (uid !== exceptUid && p.bin === binId && !p.of) { const u = ctx.unitById[uid]; if (u) out.push(u) } }); return out
}
/** Can `uid` be assigned to `bin`? Type must be accepted AND the bin's current contents plus this
 *  unit must all still pack within the bin (geometry + capacity checked together via ahPackInto). */
function ahSepBinAccepts(ctx, bin, uid) {
  const u = ctx.unitById[uid]; if (!u) return false
  if (!ahCanBag(ctx, uid)) return false
  if (bin.types && bin.types.indexOf(ahTagFor(ctx, u.itemId)) < 0) return false
  const trial = ahSepUnitsIn(ctx, bin.binId, uid); trial.push(u)
  return ahPackInto(bin, trial).size === trial.length
}
/** Mirror toggle (kill-switch). When true, `it:` (real container) bins read+write dnd5e's native
 *  system.container; when false the bag falls back to AH's own flag-only bins. */
function ahBinding(ctx) { try { return game.settings.get(MOD, "ahBindContainers") !== false } catch { return false } }
/** The real dnd5e container id an owned item points at (system.container), or null. Sync for owned. */
function ahItemContainer(ctx, itemId) { try { const it = ctx.actor && ctx.actor.items && ctx.actor.items.get(itemId); const c = it && it.system && it.system.container; return c || null } catch { return null } }
/** True when an item lives (per dnd5e system.container) inside a real container that AH has NO bin
 *  for — i.e. a container that isn't worn on the doll. Such items are hidden from AH (worn-only). */
function ahInUnmanagedContainer(ctx, itemId) {
  const cid = ahItemContainer(ctx, itemId); if (!cid) return false
  if (ctx.binById && ctx.binById["it:" + cid]) return false   // worn container → AH manages it (it: bin)
  try { const c = ctx.actor.items.get(cid); return !!(c && c.type === "container") } catch { return false }   // points at a real (un-worn) container
}
/** Short label for a container item's REAL dnd5e capacity (display-only, sync read), or "". */
function ahNativeCapLabel(ctx, containerId) {
  try {
    const it = ctx.actor && ctx.actor.items && ctx.actor.items.get(containerId), cap = it && it.system && it.system.capacity; if (!cap) return ""
    if (cap.count) return cap.count + " item" + (cap.count === 1 ? "" : "s")
    const w = cap.weight && Number(cap.weight.value); if (w > 0) return ahFmt(w) + " " + (cap.weight.units || "lb")
    return ""
  } catch { return "" }
}
/** Build ctx.placed for separate mode. Membership: when binding is ON, each `it:` (real container)
 *  bin is driven by the item's dnd5e system.container; AH-only bins (gr:/str) come from the
 *  ahPlaceSep flag. Binding OFF → the flag drives everything (legacy). Then auto-pack each bin; a
 *  valid-but-unfitting assignment is kept as a non-drawn overflow marker (its bin is remembered). */
function ahBuildSepPlaced(ctx) {
  let assign = {}; try { assign = ctx.actor.getFlag(MOD, "ahPlaceSep") || {} } catch {}
  if (!assign || typeof assign !== "object") assign = {}
  const bind = ahBinding(ctx), byBin = new Map(), cellByBin = new Map(), reqCell = new Map(), valid = []
  for (const u of ctx.units) {
    const uid = u.uid
    if (!ahCanBag(ctx, uid)) continue                                        // worn-only can't be bagged
    const a = assign[uid], aBin = ahSepBinOf(a), aCell = ahSepCellOf(a)       // entry is a bin-id string OR {bin,col,row,rot}
    let binId = null
    if (bind) {
      const cid = ahItemContainer(ctx, u.itemId)                             // real container = authoritative for it: bins
      if (cid && ctx.binById["it:" + cid]) binId = "it:" + cid
      else if (aBin && ctx.binById[aBin]) binId = aBin                       // flag fallback: AH-only bins (gr:/str) AND legacy it: bins not yet migrated to system.container (so old bags don't fall out when binding turns on; they migrate the next time the item is moved)
    } else if (aBin && ctx.binById[aBin]) binId = aBin                        // legacy: the flag drives everything
    if (!binId) continue
    const bin = ctx.binById[binId]
    if (bin.types && bin.types.indexOf(ahTagFor(ctx, u.itemId)) < 0) continue  // type not allowed by this bin
    valid.push({ uid, binId }); if (!byBin.has(binId)) { byBin.set(binId, []); cellByBin.set(binId, new Map()) }
    byBin.get(binId).push(u)
    // an explicit cell applies only if it was stored FOR this resolved bin (a moved item drops it)
    if (aCell && aBin === binId) { cellByBin.get(binId).set(uid, aCell); reqCell.set(uid, { bin: binId, col: aCell.col, row: aCell.row, rot: aCell.rot | 0 }) }
  }
  const placed = new Map()
  // explicit (player-chosen) cells claim their spot first; the rest auto-pack into what's left
  for (const bin of ctx.bins) ahPackBinPlaced(bin, byBin.get(bin.binId) || [], cellByBin.get(bin.binId) || new Map()).forEach((pos, uid) => placed.set(uid, { col: pos.col, row: pos.row, rot: pos.rot, bin: bin.binId }))
  // uids that carry an explicit requested cell → persisted as the object form (so manual placement
  // survives re-renders); everything else stays a bin-id string (auto-pack flows on the next build).
  ctx._sepEx = new Set(reqCell.keys())
  // valid-but-unpacked (bin capacity shrank) → non-drawn `of:true` marker: shows as loose but its
  // chosen bin (and explicit cell, if any) is remembered → re-packs there if room returns.
  for (const { uid, binId } of valid) if (!placed.has(uid)) { const rc = reqCell.get(uid); placed.set(uid, rc ? { bin: binId, of: true, col: rc.col, row: rc.row, rot: rc.rot } : { bin: binId, of: true }) }
  return placed
}
/** Assign one unit to a bin (binId) or make it loose (null) from an EXPLICIT user action. `cell`
 *  ({col,row,rot}) = the exact hex the player dropped it on → stored as the object form so manual
 *  placement persists; omit it for auto-pack (keyboard stow / un-assign). Mirror: a real `it:` bin
 *  writes the item's dnd5e system.container; AH-only bins (gr:/str) live in the ahPlaceSep flag —
 *  and each clears the other so there's a single source of truth. NEVER call during render. */
function ahAssignUnit(ctx, uid, binId, cell) {
  const u = ctx.unitById[uid], realId = (u && u.itemId) || uid, bind = ahBinding(ctx)
  if (bind) {
    const it = ctx.actor && ctx.actor.items && ctx.actor.items.get(realId)
    const target = (binId && binId.slice(0, 3) === "it:") ? binId.slice(3) : null   // real container id, else loose / AH-only bin
    if (it && it.system) { const cur = it.system.container || null; if (cur !== target) { try { Promise.resolve(it.update({ "system.container": target })).catch(e => console.warn("[pendant-bridge] AH container write failed", e)) } catch (e) { console.warn("[pendant-bridge] AH container write failed", e) } } }
  }
  // clone the stored flag (getFlag may return a frozen/source ref) so delete/assign actually take.
  let assign = {}; try { assign = { ...(ctx.actor.getFlag(MOD, "ahPlaceSep") || {}) } } catch {}
  if (!assign || typeof assign !== "object") assign = {}
  // What to store in the flag:
  //  - binding OFF: full membership (+ cell when supplied) for every bin.
  //  - binding ON: AH-only bins (gr:/str) store membership (+ cell); a real it: bin lives in
  //    system.container, so its flag entry is ONLY the cosmetic cell (and only when we have one).
  const isItBin = binId && binId.slice(0, 3) === "it:"
  const cellEntry = cell ? { bin: binId, col: cell.col, row: cell.row, rot: cell.rot | 0 } : null
  let entry = null
  if (binId) {
    if (!bind || !isItBin) entry = cellEntry || binId
    else entry = cellEntry   // binding it: → cell-only (null when no cell: membership is system.container)
  }
  if (entry != null) { if (!ahSepEntryEq(assign[uid], entry)) { assign[uid] = entry; ahSavePlaceSep(ctx.actor, assign) } }
  else if (uid in assign) { delete assign[uid]; ahSavePlaceSep(ctx.actor, assign) }
}
/** The {uid: entry} object to persist — derived from ctx.placed, INCLUDING overflow markers so a
 *  remembered-but-unfitting assignment is preserved across unrelated saves. A uid that holds an
 *  explicit (player-chosen) cell is written as the object form `{bin,col,row,rot}`; auto-packed
 *  units stay a bin-id string so Tidy/adds re-flow them. Must MATCH what ahAssignUnit writes so the
 *  self-heal comparison (ahSepEntryEq) never loops. */
function ahSepAssignObj(ctx) {
  const bind = ahBinding(ctx), ex = ctx._sepEx, o = {}
  ctx.placed.forEach((p, uid) => {
    if (!p || !p.bin) return
    const explicit = !!(ex && ex.has(uid)) && p.col != null   // landed at / remembers a chosen cell
    const isItBin = p.bin.slice(0, 3) === "it:"
    const cellEntry = explicit ? { bin: p.bin, col: p.col, row: p.row, rot: p.rot | 0 } : null
    if (bind && isItBin) {
      // membership = system.container. Keep a cosmetic cell once migrated; keep the legacy membership
      // string only while NOT yet migrated (no system.container), so legacy bags survive the switch.
      if (cellEntry) o[uid] = cellEntry
      else { const u = ctx.unitById[uid]; if (u && !ahItemContainer(ctx, u.itemId)) o[uid] = p.bin }
    } else {
      o[uid] = cellEntry || p.bin
    }
  })
  return o
}
function ahSavePlaceSep(actor, obj) { ahSaveFlagObj(actor, "ahPlaceSep", obj) }
/** Persist placements to the flag for the ACTIVE mode (keeps equip/outfit/stow paths mode-safe). */
function ahPersistPlace(ctx) { if (ctx.separate) ahSavePlaceSep(ctx.actor, ahSepAssignObj(ctx)); else ahSavePlace(ctx.actor, ahPlaceObj(ctx)) }
/** Tidy (separate): greedily assign every baggable unit to a fitting bin — specific-type bins
 *  first, emptier bins first. Returns a fresh {uid: binId} map (replaces the whole assignment). */
function ahAutoPackSep(ctx) {
  const bins = ctx.bins.map(b => ({ binId: b.binId, types: b.types, cap: b.cap, validList: b.validList, validSet: b.validSet, packed: [] }))
  const units = ctx.units.filter(u => ahCanBag(ctx, u.uid)).sort((a, b) => ((b.shape ? b.shape.length : 1) - (a.shape ? a.shape.length : 1)) || String(a.uid).localeCompare(String(b.uid)))
  const used = (b) => b.packed.reduce((s, x) => s + (Number(x.spaces) || 1), 0)
  const assign = {}
  for (const u of units) {
    const tag = ahTagFor(ctx, u.itemId)
    const cands = bins.filter(b => !b.types || b.types.indexOf(tag) >= 0)
      .sort((a, b) => ((a.types ? a.types.length : 99) - (b.types ? b.types.length : 99)) || ((b.cap - used(b)) - (a.cap - used(a))))
    for (const b of cands) { const trial = b.packed.concat([u]); if (ahPackInto(b, trial).size === trial.length) { b.packed.push(u); assign[u.uid] = b.binId; break } }
  }
  return assign
}
/** Apply a Tidy auto-pack: persist AH-only bins to the flag AND (when binding) mirror every item's
 *  dnd5e system.container in ONE batched update. Items not assigned to a real container are cleared. */
function ahApplyAutoPackSep(ctx) {
  const assign = ahAutoPackSep(ctx), bind = ahBinding(ctx)
  const flag = {}
  for (const uid in assign) { const b = assign[uid]; if (!bind || b.slice(0, 3) !== "it:") flag[uid] = b }
  if (!bind) { ahSavePlaceSep(ctx.actor, flag); return }
  // per ITEM resolve ONE target container (a dnd5e item can't be split across containers): ANY it:
  // assignment among its units wins; otherwise loose (null). Deterministic regardless of unit order.
  const want = new Map()
  for (const u of ctx.units) {
    if (!ahCanBag(ctx, u.uid)) continue
    const b = assign[u.uid], target = (b && b.slice(0, 3) === "it:") ? b.slice(3) : null
    if (target) want.set(u.itemId, target)
    else if (!want.has(u.itemId)) want.set(u.itemId, null)
  }
  // an item bound to a real container must NOT also linger in the flag (one source of truth) —
  // prune both items this Tidy is sending to a container (want) and any already in one (system.container)
  for (const uid in flag) { const u = ctx.unitById[uid]; if (u && (want.get(u.itemId) || ahItemContainer(ctx, u.itemId))) delete flag[uid] }
  ahSavePlaceSep(ctx.actor, flag)
  const changes = []
  want.forEach((target, itemId) => { const it = ctx.actor.items.get(itemId); if (it && it.system) { const cur = it.system.container || null; if (cur !== target && (target == null || (ctx.binById && ctx.binById["it:" + target]))) changes.push({ _id: itemId, "system.container": target }) } })
  if (changes.length) Promise.resolve(ctx.actor.updateEmbeddedDocuments("Item", changes)).catch(e => console.warn("[pendant-bridge] AH tidy container batch failed", e))
}
/** Keyboard stow (separate): assign the unit to the first fitting bin. Returns true on success. */
function ahStowSep(ctx, uid) {
  const u = ctx.unitById[uid]; if (!u) return false
  const tag = ahTagFor(ctx, u.itemId)
  const cands = ctx.bins.filter(b => !b.types || b.types.indexOf(tag) >= 0).sort((a, b) => (a.types ? a.types.length : 99) - (b.types ? b.types.length : 99))
  for (const bin of cands) { if (ahSepBinAccepts(ctx, bin, uid)) { ahAssignUnit(ctx, uid, bin.binId); return true } }
  return false
}
/** One bin's board SVG: its grid + auto-packed contents, plus a drop preview when it's hovered. */
function ahBinBoardSVG(ctx, bin) {
  const g = bin.geom
  const entries = []; ctx.placed.forEach((p, uid) => { if (p.bin === bin.binId && !p.of) { const u = ctx.unitById[uid]; if (u) entries.push({ uid, p, u }) } })
  const aria = bin.label + " — " + (entries.length ? entries.length + " packed" : "empty")
  let s = '<svg class="ah-svg" role="img" aria-label="' + ahEscX(aria) + '" width="' + g.width.toFixed(0) + '" height="' + g.height.toFixed(0) + '">'
  for (const c of bin.validList) { const ct = ahCenter(g, c.col, c.row); s += '<polygon points="' + ahPts(ct.x, ct.y, g.S) + '" fill="rgba(0,0,0,0.26)" stroke="rgba(236,233,223,0.13)" stroke-width="2"/>' }
  for (const e of entries) {
    const centers = []
    for (const c of ahCellsFor(e.u, e.p, e.p.rot)) if (bin.validSet.has(c.col + "," + c.row)) centers.push(ahCenter(g, c.col, c.row))
    if (!centers.length) continue
    const r = ahItemHexSVG(g, centers, e.u.color, e.uid, ctx.canArrange); s += r.svg
    s += '<text x="' + r.cx.toFixed(1) + '" y="' + (r.cy + 3).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" stroke="rgba(0,0,0,.62)" stroke-width="2.6" stroke-linejoin="round" paint-order="stroke" style="pointer-events:none">' + ahEscX(ahMark(e.u.name)) + "</text>"
  }
  if (ctx.held && ctx.hoverBin === bin.binId) {
    // GREEN preview at the cursor's hex (snap within 2 — what you see is where it lands), at the
    // held rotation; falls back to the first free spot only when the cursor is on a packed area.
    const t = ahSepDropTarget(ctx, bin, ctx.held.id, ctx.held.rot, ctx.hoverCell)
    if (t) {
      const cs = ahCellsFor(ctx.held.item, { col: t.col, row: t.row }, t.rot)
      let hx = 0, hy = 0, hn = 0
      for (const c of cs) { if (!bin.validSet.has(c.col + "," + c.row)) continue; const ct = ahCenter(g, c.col, c.row); s += '<polygon points="' + ahPts(ct.x, ct.y, g.S) + '" fill="rgba(121,189,102,.45)" stroke="#79bd66" stroke-width="2.5" style="pointer-events:none"/>'; hx += ct.x; hy += ct.y; hn++ }
      if (hn) s += '<text x="' + (hx / hn).toFixed(1) + '" y="' + (hy / hn + 5).toFixed(1) + '" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" stroke="rgba(0,0,0,.6)" stroke-width="3" stroke-linejoin="round" paint-order="stroke" style="pointer-events:none">✓</text>'
    } else {
      // red wash: won't fit (full, or wrong type for this container)
      for (const c of bin.validList) { const ct = ahCenter(g, c.col, c.row); s += '<polygon points="' + ahPts(ct.x, ct.y, g.S) + '" fill="rgba(216,97,95,.28)" stroke="#d8615f" stroke-width="2" style="pointer-events:none"/>' }
      const mid = bin.validList[Math.floor(bin.validList.length / 2)] || { col: 0, row: 0 }, ct0 = ahCenter(g, mid.col, mid.row)
      s += '<text x="' + ct0.x.toFixed(1) + '" y="' + (ct0.y + 5).toFixed(1) + '" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" stroke="rgba(0,0,0,.6)" stroke-width="3" stroke-linejoin="round" paint-order="stroke" style="pointer-events:none">✕</text>'
    }
  }
  return s + "</svg>"
}

// A drag holds the panel still: if the sheet tries to re-render mid-drag (e.g. an over-capacity
// self-heal setFlag), we skip the rebuild so the drag isn't orphaned onto a detached grid, then
// catch up once the drag ends.
const _ahDrag = { active: false, missed: false, actorId: null, cancel: null }
// Safety net so a drag can NEVER permanently freeze the panel. If our document mouseup doesn't fire
// (e.g. the button was released OUTSIDE the Foundry window), the per-drag finish() never runs, so
// _ahDrag.active would stay true and ahInjectPanel would block every future rebuild → frozen panel.
// An "orphan" = the flag is set but no mouse button is held. A button-less mousemove detects exactly
// that (and NEVER a real in-progress drag, where a button is down), force-clearing the flag and
// catching up the render. A mouseup is a deferred belt-and-braces backstop that runs AFTER the
// per-drag finish() (so it no-ops on a normal drag). finish() still owns the real placement cleanup.
function ahReleaseStuckDrag() {
  if (!_ahDrag.active) return
  // prefer the active drag's own cancel → removes its move/up/keydown listeners + cleanly reverts
  // (no zombie listeners). Falls back to flag-clear + sheet re-render if no cancel is registered.
  if (typeof _ahDrag.cancel === "function") { try { _ahDrag.cancel(); return } catch {} }
  const aid = _ahDrag.actorId
  _ahDrag.active = false; _ahDrag.missed = false
  try { const a = aid && game.actors && game.actors.get(aid); const sh = a && a.sheet; if (sh && sh.rendered) sh.render(false) } catch {}
}
if (typeof window !== "undefined") {
  window.addEventListener("mousemove", (e) => { if (_ahDrag.active && e.buttons === 0) ahReleaseStuckDrag() })
  window.addEventListener("mouseup", () => setTimeout(ahReleaseStuckDrag, 0))
}
/** Spend one of a consumable (owner action): quantity − 1 (deletes the last one) + a chat line. */
const _ahUsing = new Set()
/** Item-level limited uses as {value,max,spent} or null. v5 stores system.uses = {max, spent,
 *  value (derived = max − spent, READ-ONLY), autoDestroy}. We gate on the official hasLimitedUses
 *  getter when present, and read the derived `value` (handles formula maxes after prepareData). */
function ahReadUses(it) {
  try {
    const u = it && it.system && it.system.uses; if (!u) return null
    const has = (typeof it.hasLimitedUses === "boolean") ? it.hasLimitedUses : (Number(u.max) > 0)
    if (!has) return null
    const max = Number(u.max), spent = Number(u.spent) || 0
    const value = (u.value != null && isFinite(Number(u.value))) ? Number(u.value) : (isFinite(max) ? Math.max(0, max - spent) : 0)
    if (!isFinite(max) && value <= 0) return null
    return { value, max: isFinite(max) && max > 0 ? max : null, spent }
  } catch { return null }
}
async function ahUseItem(actor, itemId) {
  const key = (actor && actor.id || "") + ":" + itemId
  if (_ahUsing.has(key)) return                     // re-entry guard: ignore rapid double-clicks
  const it = actor && actor.items.get(itemId); if (!it) return
  _ahUsing.add(key)
  try {
    const uses = ahReadUses(it)
    if (uses && uses.value > 0) {
      // CHARGED item (wand / N-use scroll): spend one charge — write `spent`, NEVER the derived value
      const u = it.system.uses, spent = Number(u.spent) || 0, max = Number(u.max) || uses.max || 0
      const nextSpent = spent + 1, drained = max > 0 && nextSpent >= max
      if (drained && u.autoDestroy) {               // last charge + auto-destroy → consume one copy, reset charges
        const qty = AH.itemQty(it)
        if (qty > 1) await it.update({ "system.quantity": qty - 1, "system.uses.spent": 0 })
        else await it.delete()
      } else {
        await it.update({ "system.uses.spent": nextSpent })
      }
      try { const left = Math.max(0, uses.value - 1); ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: "uses <b>" + ahEscX(it.name) + "</b> <span style=\"opacity:.65\">(" + left + " charge" + (left === 1 ? "" : "s") + " left)</span>" }) } catch {}
      return
    }
    // QUANTITY item (potion stack etc.): decrement, delete the last one (no ghost chip)
    const qty = AH.itemQty(it); if (qty <= 0) return
    const next = qty - 1, last = next <= 0
    if (last) await it.delete(); else await it.update({ "system.quantity": next })
    try { const tail = last ? ' <span style="opacity:.65">(last one)</span>' : ' <span style="opacity:.65">(' + next + " left)</span>"; ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: "uses <b>" + ahEscX(it.name) + "</b>" + tail }) } catch {}
  } catch (e) { console.warn("[pendant-bridge] AH use failed", e) }
  finally { _ahUsing.delete(key) }
}

// ── ammo auto-spend ─────────────────────────────────────────────────────────
// Firing a ranged weapon spends one matching ammo. dnd5e already does this when a
// weapon has ammunition configured (and the bag reflects it live) — so we ONLY step
// in when it doesn't, and only when the ammo is unambiguous. Best-effort + fully
// guarded; toggle off in the app if a sheet/version misbehaves.
function ahHasProp(props, p) { try { return props && (props.has ? props.has(p) : (Array.isArray(props) ? props.includes(p) : !!props[p])) } catch { return false } }
function ahIsRangedWeapon(item) {
  if (!item || item.type !== "weapon") return false
  const sys = item.system || {}
  const t = String((sys.type && sys.type.value) || sys.weaponType || "").toLowerCase()
  if (t === "simpler" || t === "martialr" || t === "ranged" || t === "siege") return true
  return ahHasProp(sys.properties, "amm") || ahHasProp(sys.properties, "ammunition")
}
/** Does this weapon ALREADY have ammo/consumption set up that dnd5e (or the player) handles?
 *  Broad + conservative across dnd5e v3 (system.consume) and v4/v5 (activities) — when in ANY
 *  doubt we treat it as configured and DON'T auto-spend (better to skip than to double-spend). */
function ahWeaponHasAmmoConfig(item) {
  try {
    const sys = item.system || {}
    if (sys.consume && sys.consume.target) return true                       // v3 linked consumption
    if (sys.ammunition && (sys.ammunition.target || sys.ammunition.type)) return true
    const acts = sys.activities
    if (acts) {
      const list = typeof acts.values === "function" ? Array.from(acts.values()) : Object.values(acts)
      for (const a of list) {
        const c = a && a.consumption; if (!c) continue
        if (Array.isArray(c.targets) ? c.targets.length : (c.targets || c.amount)) return true   // v4/v5: any consumption
      }
    }
  } catch { return true }   // any uncertainty → assume configured, don't auto-spend (fail to under-spend, never double)
  return false
}
/** The ammo to spend for a BARE ranged weapon: only the ONE ammo type a character carries (else null). */
function ahAmmoForWeapon(actor) {
  try {
    const ammo = actor.items.filter(i => i.type === "consumable" && (() => { const st = String((((i.system || {}).type) || {}).value || "").toLowerCase(); return st === "ammo" || st === "ammunition" })())
    return ammo.length === 1 ? ammo[0] : null
  } catch { return null }
}
const _ahAmmoFired = new Map()   // actor:weapon → last-fire ms, to de-dupe overlapping attack hooks
async function ahOnWeaponAttack(item) {
  try {
    if (!item || item.type !== "weapon" || !item.parent || item.parent.documentName !== "Actor") return
    const actor = item.parent
    if (!actor.isOwner) return                       // the rolling owner acts; the hook is client-local → fires once per client
    const cfg = AH.cfg(); if (!cfg.ammoAutoSpend) return
    if (!ahIsRangedWeapon(item)) return
    if (ahWeaponHasAmmoConfig(item)) return          // dnd5e / the player already spend it; the bag reflects live
    const key = actor.id + ":" + item.id, now = Date.now()
    if (now - (_ahAmmoFired.get(key) || 0) < 1200) return   // v4/v5 raises >1 attack hook per shot → spend once
    const ammo = ahAmmoForWeapon(actor); if (!ammo || AH.itemQty(ammo) <= 0) return
    _ahAmmoFired.set(key, now)
    await ahUseItem(actor, ammo.id)                  // guarded −1 (+ delete on last) + chat line
  } catch (e) { console.warn("[pendant-bridge] AH ammo auto-spend failed", e) }
}
/** Pull the fired Item out of whatever shape the dnd5e attack hook hands us (v3 item, v4/v5 activity). */
function ahAttackItem() {
  for (const a of arguments) {
    if (!a || typeof a !== "object") continue
    if (a.documentName === "Item") return a
    if (a.item && a.item.documentName === "Item") return a.item
    if (a.subject && a.subject.item && a.subject.item.documentName === "Item") return a.subject.item
    if (a.activity && a.activity.item) return a.activity.item
  }
  return null
}

// ── world-wide per-item-name DM overrides ───────────────────────────────────
// A rule keyed by lowercased item name overrides the derived metadata for EVERY
// copy of that item in the world (size/carryType/equipSlots/spaces/shape).
function ahItemRuleKey(item) { return String((item && item.name) || "").trim().toLowerCase() }
function ahItemRules() { try { return game.settings.get(MOD, "ahItemRules") || {} } catch { return {} } }
function ahRuleFor(item) { const k = ahItemRuleKey(item); if (!k) return null; const r = ahItemRules(); return (r && r[k]) || null }
/** The hex shape an item's bag footprint uses: the DM's custom shape, else auto from cell count. */
function ahEffectiveShape(item, cells) {
  const rule = ahRuleFor(item)
  if (rule && Array.isArray(rule.shape) && rule.shape.length) return rule.shape
  return ahShapeFor(Math.max(1, cells | 0), ahHashOf((item && item.id) || ""))
}
// ── stackable bundling ──────────────────────────────────────────────────────
// A big stack splits into BUNDLES of N: a quiver of 50 arrows at bundle 20 = three
// bundles (20·20·10), each its own slot-filler you pack separately. Effective size:
// per-item override (rule/flag, 0 = force off) wins; else the world default — but the
// global only auto-bundles naturally-stackable items (consumables / loot).
function ahBundleSize(item, cfg) {
  try {
    const whole = (v) => { const n = Math.floor(Number(v) || 0); return n > 0 ? n : 0 }   // bundle sizes are whole item counts
    const ov = (item && item.flags && item.flags[MOD] && item.flags[MOD].meta) || {}
    if (typeof ov.bundle === "number") return whole(ov.bundle)
    const rule = ahRuleFor(item) || {}
    if (typeof rule.bundle === "number") return whole(rule.bundle)
    const t = String((item && item.type) || "").toLowerCase()
    if (t === "consumable" || t === "loot") return whole(cfg && cfg.bundleSize)
    return 0
  } catch { return 0 }
}
/** The per-bundle footprint shape (the DM's designed shape, else a single hex). */
function ahBundleShape(item) { return ahEffectiveShape(item, 1) }
/** Bundling state for an item: { active, size, count, per (cells/bundle), perShape }. */
function ahBundleInfo(item, cfg) {
  // an explicit total-spaces override (per-item flag or world rule) wins → don't bundle,
  // so the unit split and the stored total never disagree.
  let hasSpacesOv = false
  try { if (AH.itemOverride(item) != null) hasSpacesOv = true; else { const r = ahRuleFor(item); if (r && r.spaces != null) hasSpacesOv = true } } catch {}
  const size = ahBundleSize(item, cfg)
  const qty = AH.itemQty(item)
  if (hasSpacesOv || !size || qty <= 1) return { active: false, size: 0, count: 1, per: 1, perShape: null }
  // count>=1: a single full bundle stays "active" so it still costs ONE bundle (per cells),
  // not the weight/size cost — otherwise a heavy sub-bundle stack could cost MORE than a split
  // one. The panel keeps count==1 on the plain itemId via its else-branch, so it stays equippable.
  const count = Math.max(1, Math.ceil(qty / size))
  let per = 1, perShape = null
  try { perShape = ahBundleShape(item); per = Array.isArray(perShape) && perShape.length ? perShape.length : 1 } catch {}
  return { active: true, size, count, per, perShape }
}

// ── rules engine: derive inventory metadata from a Foundry item ─────────────
// "Rules, not exceptions" — size/carryType/equipSlots/storage/grants from the
// item's existing dnd5e data. Pure, never throws, tolerant of v3 + v4 schemas.
function ahMeta(item) {
  const SLOT = { HEAD: "Head", FACE: "Face", NECK: "Neck", CHEST: "Chest", CLOTHES: "Clothes", BACK: "Back", BELT: "Belt", LHIP: "Left Hip", RHIP: "Right Hip", LHAND: "Left Hand", RHAND: "Right Hand", FEET: "Feet", LRING: "Left Ring", RRING: "Right Ring" }
  const NON_PHYSICAL = new Set(["feat", "spell", "class", "subclass", "background", "race", "feature", "facility", "summons"])
  const safe = (fn, d) => { try { const r = fn(); return r == null ? d : r } catch { return d } }
  const lc = (v) => (typeof v === "string" ? v : (v == null ? "" : String(v))).toLowerCase()
  const num = (v) => { const n = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(n) ? n : null }
  const readWeightLb = (sys) => safe(() => { const w = sys && sys.weight; if (w == null) return null; if (typeof w === "object") return num(w.value); return num(w) }, null)
  const readSubtype = (sys) => safe(() => { const t = sys && sys.type; if (t && typeof t === "object" && t.value != null) return lc(t.value); if (typeof t === "string") return lc(t); if (sys && sys.armor && sys.armor.type != null) return lc(sys.armor.type); return "" }, "")
  const readProps = (sys) => safe(() => { const p = sys && sys.properties; const set = new Set(); if (!p) return set; if (p instanceof Set) { p.forEach((k) => set.add(lc(k))); return set } if (Array.isArray(p)) { for (const k of p) set.add(lc(k)); return set } if (typeof p.has === "function" && typeof p.forEach === "function") { p.forEach((k) => set.add(lc(k))); return set } if (typeof p === "object") { for (const k of Object.keys(p)) if (p[k] === true || p[k] === 1) set.add(lc(k)); return set } return set }, new Set())
  const sizeFromWeight = (lb) => { if (lb == null || lb <= 0) return null; if (lb < 1) return "Tiny"; if (lb < 5) return "Small"; if (lb < 15) return "Medium"; if (lb < 50) return "Large"; return "Huge" }
  const POLEARM_RE = /\b(pike|halberd|glaive|lance|quarterstaff|longspear|long spear|partisan|guisarme|naginata|poleaxe|polearm|pole arm|ranseur|bardiche)\b/
  const TREASURE_RE = /\b(gem|gemstone|jewel|jewelry|jewellery|diamond|ruby|emerald|sapphire|pearl|gold|silver|platinum|coin|coins|ingot|necklace|crown|tiara)\b/
  const LONG_NAME_RE = /\b(pike|halberd|lance|glaive|naginata|spear|trident|polearm|pole arm|quarterstaff|staff|staves|ladder|long\s?spear|partisan|ranseur|guisarme|bardiche|bill)\b/
  const COILABLE_RE = /\b(rope|hempen|silk\s?rope|chain|cable|tent|bedroll|blanket|net|tarp|canvas|sack|cord|twine)\b/
  const categorySizeDefault = (type, sub, props, name) => {
    switch (type) {
      case "weapon": { const twoH = props.has("two"), heavy = props.has("hvy"), reach = props.has("rch"); const isRanged = sub === "simpler" || sub === "martialr" || sub === "siege"; if (POLEARM_RE.test(name) || (twoH && reach)) return "Huge"; if (isRanged) { if (/\bsling\b/.test(name)) return "Tiny"; if (/\b(dart|dagger)\b/.test(name)) return "Small"; if (/\b(longbow|heavy crossbow|greatbow)\b/.test(name)) return "Large"; return "Medium" } if (twoH || heavy) return "Large"; return "Medium" }
      case "equipment": { if (sub === "heavy") return "Large"; if (sub === "light" || sub === "medium" || sub === "shield" || sub === "armor") return "Medium"; if (sub === "clothing" || sub === "rod") return "Small"; if (sub === "trinket" || sub === "ring" || sub === "wand") return "Tiny"; return "Small" }
      case "consumable": return "Tiny"
      case "tool": return "Small"
      case "loot": return "Small"
      case "container": case "backpack": { if (/\b(chest|crate|barrel|coffer|large)\b/.test(name)) return "Large"; if (/\b(pouch|satchel|sack|bag|case)\b/.test(name)) return "Small"; return "Medium" }
      default: return "Medium"
    }
  }
  const deriveCarryType = (sys, type, sub, size, name, wLb) => {
    switch (type) {
      case "weapon": return "Weapon"
      case "equipment": { if (["light", "medium", "heavy", "shield", "armor", "natural"].includes(sub)) return "Armor"; if (sub === "clothing") return "Clothing"; if (["trinket", "ring", "rod", "wand"].includes(sub)) return "Miscellaneous"; const ac = safe(() => num(sys && sys.armor && sys.armor.value), null); return ac != null && ac > 0 ? "Armor" : "Clothing" }
      case "consumable": return "Consumable"
      case "tool": return "Tool"
      case "container": case "backpack": return "Container"
      case "loot": { const rarity = safe(() => lc(sys && sys.rarity), ""); if (rarity || TREASURE_RE.test(name)) return "Treasure"; const bulky = size === "Large" || size === "Huge" || (wLb != null && wLb >= 15); return bulky ? "Cargo" : "Miscellaneous" }
      default: return "Miscellaneous"
    }
  }
  const wornByName = (name) => {
    const r = (...kw) => kw.some((k) => name.includes(k))
    if (r("cloak", "cape", "mantle")) return { slots: [SLOT.BACK], back: true }
    if (r("backpack", "rucksack", "knapsack", "satchel", "pack")) return { slots: [SLOT.BACK], back: true }
    if (r("baldric", "bandolier", "belt", "girdle", "sash")) return { slots: [SLOT.BELT], back: false }
    if (r("boots", "shoes", "sandals", "footwear", "greaves")) return { slots: [SLOT.FEET], back: false }
    if (r("helmet", "helm", "hat", "hood", "cap", "coif", "circlet", "crown", "diadem")) return { slots: [SLOT.HEAD], back: false }
    if (r("mask", "visor", "veil", "spectacles", "goggles", "eyepatch")) return { slots: [SLOT.FACE], back: false }
    if (r("gloves", "gauntlet", "bracer", "mitten")) return { slots: [SLOT.LHAND, SLOT.RHAND], back: false }
    if (r("ring")) return { slots: [SLOT.LRING, SLOT.RRING], back: false }
    if (r("amulet", "necklace", "pendant", "talisman", "holy symbol", "periapt", "brooch", "torc")) return { slots: [SLOT.NECK, SLOT.BELT], back: false }
    if (r("potion", "scroll", "waterskin", "flask", "vial", "oil", "horn", "wand", "rod")) return { slots: [SLOT.BELT], back: false }
    if (r("ration", "bedroll", "tent", "rope")) return { slots: [], back: false }
    return null
  }
  const deriveEquipSlots = (type, sub, name, props, cls) => {
    if (type === "weapon") {
      const two = props.has("two"), fin = props.has("fin"), thr = props.has("thr"), lgt = props.has("lgt"), amm = props.has("amm"), rch = props.has("rch")
      if (cls === "natural") return { equipSlots: [], twoHanded: false, needsBackPoint: false }
      if ((rch && two) || POLEARM_RE.test(name)) return { equipSlots: [SLOT.LHAND, SLOT.RHAND, SLOT.BACK], twoHanded: true, needsBackPoint: true }
      if (cls === "ranged" && (two || amm)) return { equipSlots: [SLOT.LHAND, SLOT.RHAND, SLOT.BACK], twoHanded: true, needsBackPoint: true }
      if ((lgt || fin || thr) && !two) return { equipSlots: [SLOT.BELT, SLOT.LHIP, SLOT.RHIP, SLOT.LHAND, SLOT.RHAND], twoHanded: false, needsBackPoint: false }
      if (two) return { equipSlots: [SLOT.LHAND, SLOT.RHAND, SLOT.BACK], twoHanded: true, needsBackPoint: true }
      if (cls === "ranged") return { equipSlots: [SLOT.BELT, SLOT.LHIP, SLOT.RHIP, SLOT.LHAND, SLOT.RHAND], twoHanded: false, needsBackPoint: false }
      return { equipSlots: [SLOT.LHIP, SLOT.RHIP, SLOT.LHAND, SLOT.RHAND], twoHanded: false, needsBackPoint: false }
    }
    if (type === "container" || type === "backpack") return { equipSlots: [SLOT.BACK], twoHanded: false, needsBackPoint: true }
    if (type === "equipment" || type === "armor") {
      if (sub === "shield") return { equipSlots: [SLOT.LHAND, SLOT.RHAND, SLOT.BACK], twoHanded: false, needsBackPoint: true }
      if (sub === "light" || sub === "medium" || sub === "heavy" || sub === "natural") return { equipSlots: [SLOT.CHEST], twoHanded: false, needsBackPoint: false }
      if (sub === "ring") return { equipSlots: [SLOT.LRING, SLOT.RRING], twoHanded: false, needsBackPoint: false }
      if (sub === "rod" || sub === "wand") return { equipSlots: [SLOT.BELT], twoHanded: false, needsBackPoint: false }
      const worn = wornByName(name); if (worn) return { equipSlots: worn.slots, twoHanded: false, needsBackPoint: worn.back }
      if (sub === "clothing") return { equipSlots: [SLOT.CLOTHES], twoHanded: false, needsBackPoint: false }
      return { equipSlots: [], twoHanded: false, needsBackPoint: false }
    }
    if (type === "consumable" || type === "loot" || type === "tool") { const worn = wornByName(name); if (worn) return { equipSlots: worn.slots, twoHanded: false, needsBackPoint: worn.back }; return { equipSlots: [], twoHanded: false, needsBackPoint: false } }
    return { equipSlots: [], twoHanded: false, needsBackPoint: false }
  }
  const containersForSize = (size) => { switch (size) { case "Tiny": case "Small": return ["Any"]; case "Medium": return ["Backpack", "Chest", "Wagon"]; case "Large": return ["Large Pack", "Chest", "Wagon", "Cart", "Ship Cargo"]; case "Huge": return ["Cargo"]; default: return ["Backpack", "Chest", "Wagon"] } }
  const isLongItem = (type, name, props, twoHanded) => { if (COILABLE_RE.test(name)) return false; if (LONG_NAME_RE.test(name)) return true; if (type === "weapon" && props.has("rch") && (props.has("two") || twoHanded)) return true; return false }
  const deriveGrants = (type, sub, name) => safe(() => {
    const merge = (...objs) => { const out = {}; for (const o of objs) for (const k of Object.keys(o || {})) out[k] = (out[k] || 0) + o[k]; return Object.keys(out).length ? out : null }
    if (type === "container" || type === "backpack") {
      // A backpack has two BUILT-IN back straps (a weapon + a bedroll) on top of its bag.
      if (type === "backpack" || /back\s?pack|rucksack|knapsack/.test(name)) return { Back: 2 }
      if (/harness|baldric|bandolier/.test(name)) return { Back: 2 }
      return null   // satchel / pouch / chest just hold things
    }
    if (type === "equipment" || type === "armor") {
      // Back: 2 so any armoured character can carry a back weapon AND wear a backpack.
      const lightSet = { Chest: 1, Belt: 1, "Left Hip": 1, "Right Hip": 1, Back: 2, Feet: 1, Head: 1, Face: 1, Neck: 1 }
      switch (sub) {
        case "light": return lightSet
        case "medium": return merge(lightSet, { Back: 1 })
        case "heavy": return merge(lightSet, { Back: 1 })
        case "clothing": {
          // ANY clothing grants at least a Back point, so a pack can be slung over plain clothes.
          if (/traveler|traveller|explorer|adventur/.test(name)) return { Chest: 1, Belt: 1, "Left Hip": 1, "Right Hip": 1, Feet: 1, Back: 1, Head: 1, Face: 1, Neck: 1 }
          if (/harness|bandolier|baldric/.test(name)) return { Belt: 1, "Left Hip": 1, "Right Hip": 1, Back: 2 }
          if (/clothes|outfit|tunic|robe|garb|dress|shirt|trousers|vestment/.test(name)) return { Chest: 1, Belt: 1, Feet: 1, Back: 1, Head: 1, Face: 1, Neck: 1 }
          return { Back: 1 }
        }
        default: {
          if (/harness|bandolier|baldric/.test(name)) return { Belt: 1, "Left Hip": 1, "Right Hip": 1, Back: 2 }
          return null
        }
      }
    }
    return null
  }, null)
  try {
    const type = lc(item && item.type), name = lc(item && item.name), sys = (item && item.system) || {}
    if (!type || NON_PHYSICAL.has(type)) return { size: null, carryType: "Miscellaneous", equipSlots: [], allowedContainers: [], longItem: false, twoHanded: false, needsBackPoint: false, grantsSlots: null, covers: null, baggable: false, ignoreSlot: true, nonPhysical: true }
    const sub = readSubtype(sys), props = readProps(sys), wLb = readWeightLb(sys)
    const cls = safe(() => { const t = lc((sys && sys.type && sys.type.value) ?? (sys && sys.weaponType) ?? ""); if (t === "simplem" || t === "martialm") return "melee"; if (t === "simpler" || t === "martialr") return "ranged"; if (t === "natural") return "natural"; return "" }, "")
    let size = sizeFromWeight(wLb); if (size == null) size = categorySizeDefault(type, sub, props, name)
    let carryType = deriveCarryType(sys, type, sub, size, name, wLb)
    const eq = deriveEquipSlots(type, sub, name, props, cls)
    let longItem = isLongItem(type, name, props, eq.twoHanded)
    const covers = (type === "equipment" && sub === "heavy") ? ["Head", "Feet"] : null   // plate: integrated helm + sabatons
    let equipSlots = eq.equipSlots, needsBackPoint = eq.needsBackPoint
    // world-wide DM rule for this item's name → overrides the derived rules
    const rule = safe(() => ahRuleFor(item), null)
    if (rule) {
      if (rule.size) size = rule.size
      if (rule.carryType) carryType = rule.carryType
      if (Array.isArray(rule.equipSlots)) { equipSlots = rule.equipSlots.slice(); needsBackPoint = equipSlots.indexOf("Back") >= 0 && equipSlots.length === 1 }
      if (typeof rule.longItem === "boolean") longItem = rule.longItem
    }
    // per-item DM override flag → most specific, wins over the world rule + derived
    const ov = safe(() => { const f = item && item.flags && item.flags[MOD]; return (f && f.meta) || null }, null)
    if (ov) {
      if (ov.size) size = ov.size
      if (ov.carryType) carryType = ov.carryType
      if (Array.isArray(ov.equipSlots)) { equipSlots = ov.equipSlots.slice(); needsBackPoint = equipSlots.indexOf("Back") >= 0 && equipSlots.length === 1 }
      if (typeof ov.longItem === "boolean") longItem = ov.longItem
    }
    // baggable = can this go in the hex bag at all? Worn-only gear (armor / clothing /
    // a container itself) can't — it must be worn. ignoreSlot = the DM/player says
    // "fine that this isn't slotted" → it won't count as overflow. Both DM-overridable.
    let baggable = !(carryType === "Container" || carryType === "Armor" || carryType === "Clothing")
    let ignoreSlot = false
    if (rule) { if (typeof rule.baggable === "boolean") baggable = rule.baggable; if (typeof rule.ignoreSlot === "boolean") ignoreSlot = rule.ignoreSlot }
    if (ov) { if (typeof ov.baggable === "boolean") baggable = ov.baggable; if (typeof ov.ignoreSlot === "boolean") ignoreSlot = ov.ignoreSlot }
    return { size, carryType, equipSlots, allowedContainers: containersForSize(size), longItem, twoHanded: eq.twoHanded, needsBackPoint, grantsSlots: deriveGrants(type, sub, name), covers, baggable, ignoreSlot, override: !!ov, nonPhysical: false }
  } catch {
    return { size: "Medium", carryType: "Miscellaneous", equipSlots: [], allowedContainers: ["Backpack", "Chest", "Wagon"], longItem: false, twoHanded: false, needsBackPoint: false, grantsSlots: null, covers: null, baggable: true, ignoreSlot: false, nonPhysical: false }
  }
}

// ── body paperdoll (equip layer) ────────────────────────────────────────────
// Strict model: naked = Hands/Feet/Rings (+ Chest as the garment mount). Clothing
// & armor GRANT Head/Face/Neck/Belt/Hips/Back. Plate COVERS Head + Feet. Back
// points are granted by clothing/armor and consumed by packs/shields/bows/2-handers.
const AH_BODY_SLOTS = [  // key, label, x%, y%  (over the figure art; tuned via screenshots)
  ["Head", "Head", 50, 6], ["Face", "Face", 50, 13], ["Neck", "Neck", 50, 20],
  ["Clothes", "Clothes", 19, 35], ["Chest", "Armor", 50, 32], ["Back", "Back", 81, 27],
  ["Belt", "Belt", 50, 53], ["LHip", "L.Hip", 19, 51], ["RHip", "R.Hip", 81, 51],
  ["LHand", "Main hand", 11, 61], ["RHand", "Off hand", 89, 61],
  ["LRing", "Ring", 11, 72], ["RRing", "Ring", 89, 72], ["Feet", "Feet", 50, 95],
]
// Chest = armor mount, Clothes = clothing mount (so both can be worn at once). Both are
// always-available base mounts; the granted slots only appear once gear provides them.
const AH_BASE_CAP = { LHand: 1, RHand: 1, Feet: 1, LRing: 1, RRing: 1, Chest: 1, Clothes: 1, Head: 0, Face: 0, Neck: 0, Belt: 0, LHip: 0, RHip: 0, Back: 0 }
const AH_GRANTABLE = ["Head", "Face", "Neck", "Belt", "LHip", "RHip", "Back"]
const AH_BASE_MOUNTS = new Set(["LHand", "RHand", "Feet", "LRing", "RRing", "Chest", "Clothes"])
const AH_SLOT_KEY = { "Head": "Head", "Face": "Face", "Neck": "Neck", "Chest": "Chest", "Clothes": "Clothes", "Back": "Back", "Belt": "Belt", "Left Hip": "LHip", "Right Hip": "RHip", "Left Hand": "LHand", "Right Hand": "RHand", "Feet": "Feet", "Left Ring": "LRing", "Right Ring": "RRing" }
// Paperdoll layout: two tidy columns of labelled slot cards flanking the figure
// (replaces fragile absolute %-positions — no overlap, no per-art tuning).
const AH_DOLL_LEFT = ["Head", "Neck", "Clothes", "LHand", "Belt", "LHip", "LRing"]
const AH_DOLL_RIGHT = ["Face", "Back", "Chest", "RHand", "Feet", "RHip", "RRing"]
// square-tile doll renders one ordered grid (head → toe); locked/covered slots are filtered out
const AH_DOLL_ORDER = ["Head", "Face", "Neck", "Clothes", "Chest", "Back", "LHand", "RHand", "Belt", "LHip", "RHip", "Feet", "LRing", "RRing"]
const AH_SLOT_LABEL = { Head: "Head", Face: "Face", Neck: "Neck", Clothes: "Clothes", Chest: "Armor", Back: "Back", Belt: "Belt", LHip: "Left hip", RHip: "Right hip", LHand: "Main hand", RHand: "Off hand", Feet: "Feet", LRing: "Left ring", RRing: "Right ring" }
// Inline-SVG icon set (one monochrome family, inherits currentColor + the token palette) —
// replaces emoji so the panel renders identically on every OS and matches the forged dark theme.
const AH_ICON_PATHS = {
  head: '<path d="M5 13a7 7 0 0 1 14 0"/><path d="M3.5 13h17"/>',
  face: '<circle cx="8" cy="12" r="2.6"/><circle cx="16" cy="12" r="2.6"/><path d="M10.6 12h2.8"/>',
  neck: '<path d="M7 5l5 7 5-7"/><circle cx="12" cy="16.5" r="2.3"/>',
  clothes: '<path d="M9 4 4 7l2 3 2-1v8h8v-8l2 1 2-3-5-3-2 2.2z"/>',
  chest: '<path d="M7 5l5 2 5-2v8a5 5 0 0 1-10 0z"/><path d="M12 7v10"/>',
  back: '<rect x="6" y="7.5" width="12" height="12.5" rx="3"/><path d="M9 7.5V6a3 3 0 0 1 6 0v1.5"/><path d="M9.5 13h5"/>',
  belt: '<rect x="3" y="9.5" width="18" height="5" rx="1.4"/><rect x="10" y="9.5" width="4" height="5"/>',
  hip: '<path d="M7.5 9.5h9l-.8 8.5a2 2 0 0 1-2 1.8h-3.4a2 2 0 0 1-2-1.8z"/><path d="M9.5 9.5V8a2.5 2.5 0 0 1 5 0v1.5"/>',
  hand: '<path d="M12 3.5v9"/><path d="M8.5 8h7"/><circle cx="12" cy="16.5" r="3.6"/>',
  feet: '<path d="M9 4v8.5l-3 1.2V18a2 2 0 0 0 2 2h8.5a2.5 2.5 0 0 0 2.5-2.5c0-1.8-1.6-2.7-3.4-3.2L13 13.3V4z"/>',
  ring: '<circle cx="12" cy="14.5" r="4.6"/><path d="M9.6 10l2.4-3.6 2.4 3.6"/>',
  lock: '<rect x="5" y="11" width="14" height="8.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  spark: '<path d="M12 3l1.7 5L19 9.7 13.7 11.4 12 16.5l-1.7-5.1L5 9.7 10.3 8z"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  undo: '<path d="M5 9.5h7.5a5 5 0 1 1 0 10H8"/><path d="M5 9.5 8 6.5M5 9.5 8 12.5"/>',
  check: '<path d="M5 12.5l4 4 10-10"/>',
  cross: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  caret: '<path d="M7 10l5 5 5-5"/>',
  stack: '<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M3.5 12.5 12 17l8.5-4.5"/>',
}
function ahIcon(name, cls) { const p = AH_ICON_PATHS[name]; if (!p) return ""; return '<svg class="' + (cls || "ah-ico") + '" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + "</svg>" }
const AH_SLOT_ICON = { Head: "head", Face: "face", Neck: "neck", Clothes: "clothes", Chest: "chest", Back: "back", Belt: "belt", LHip: "hip", RHip: "hip", LHand: "hand", RHand: "hand", Feet: "feet", LRing: "ring", RRing: "ring" }
/** A small framed item-art thumbnail: the real Foundry image (item.img) over an item-colour tint,
 *  with the slot/type icon as a graceful fallback. A capturing "error" listener on the panel root
 *  removes a broken <img> so the fallback shows — no inline handlers, CSP-safe. */
function ahArtThumb(img, color, fallbackIcon) {
  return '<span class="ah-art" style="--ac:' + (color || "transparent") + '">'
    + '<span class="ah-art-ic">' + ahIcon(fallbackIcon) + "</span>"
    + (img ? '<img class="ah-art-img" src="' + ahEscX(img) + '" alt="" draggable="false">' : "")
    + "</span>"
}

// ── add-on storage gear (player-added belts/packs that grant slots + bag space) ──
// Stored on the actor flag `ahGear` = [{ id, kind }]. Each grants attachment points
// and/or hex storage on top of whatever real armor/clothing provides.
// Wearable container catalog: each declares the body SLOT it's worn on, its STORAGE
// (bag spaces it adds), and what it HOLDS (a type restriction, shown so players instantly
// know what each does). `holds` = a single equipped item (sheath/sling). Slot capacity,
// type enforcement, and mount/world containers come in later phases.
const AH_GEAR = {
  // — Belt —
  coinPurse:   { name: "Coin Purse",         slot: "Belt",       storage: 1,  restrict: "Tiny items only", types: ["general"] },
  pouch:       { name: "Belt Pouch",         slot: "Belt",       storage: 2 },
  bigPouch:    { name: "Large Belt Pouch",   slot: "Belt",       storage: 4 },
  scrollCase:  { name: "Scroll Case",        slot: "Belt / Back", storage: 6, restrict: "Scrolls only", types: ["scroll"] },
  waterskin:   { name: "Waterskin",          slot: "Belt",       storage: 1,  restrict: "Water only", types: ["water"] },
  toolHolster: { name: "Tool Holster",       slot: "Belt",       storage: 2,  restrict: "Small tools only", types: ["tool"] },
  // — Chest —
  bandolier:   { name: "Bandolier",          slot: "Chest",      storage: 4,  restrict: "Potions, scrolls, ammo, small tools", types: ["potion", "scroll", "ammo", "tool"] },
  potionBand:  { name: "Potion Bandolier",   slot: "Chest",      storage: 6,  restrict: "Potions only", types: ["potion"] },
  // — Back —
  satchel:     { name: "Satchel",            slot: "Back",       storage: 8 },
  backpack:    { name: "Backpack",           slot: "Back",       storage: 12, grants: { Back: 1 } },
  bigBackpack: { name: "Large Backpack",     slot: "Back",       storage: 18, grants: { Back: 1 } },
  huntingPack: { name: "Hunting / Frame Pack", slot: "Back",     storage: 24, grants: { Back: 1 } },
  quiver:      { name: "Quiver",             slot: "Back",       storage: 4,  restrict: "Bow + arrows/bolts", types: ["ammo"] },
  boltCase:    { name: "Bolt Case",          slot: "Back",       storage: 4,  restrict: "Bolts only", types: ["ammo"] },
  // — single-item holders (worn; hold one equipped item, no bag space) —
  sheath:      { name: "Sheath",             slot: "Hip / Belt", holds: "a one-handed weapon", grants: { "Right Hip": 1 } },
  gwSling:     { name: "Great Weapon Sling", slot: "Back",       holds: "a two-handed weapon", grants: { Back: 1 } },
  shieldSling: { name: "Shield Sling",       slot: "Back",       holds: "a shield", grants: { Back: 1 } },
  // — legacy keys (kept so existing equipped gear doesn't vanish) —
  belt:        { name: "Belt",               slot: "Belt",       storage: 0,  grants: { Belt: 1 } },
  harness:     { name: "Harness",            slot: "Back",       storage: 0,  grants: { Back: 2, "Left Hip": 1, "Right Hip": 1 } },
  // — mount-worn (on a beast/vehicle, not the body — no slot, uncapped) —
  saddlebags:    { name: "Saddlebags",        cat: "mount", storage: 16 },
  bigSaddlebags: { name: "Large Saddlebags",  cat: "mount", storage: 24 },
  packFrame:     { name: "Pack Frame",        cat: "mount", storage: 32 },
  cargoHarness:  { name: "Cargo Harness",     cat: "mount", storage: 48 },
  // — non-wearable / world (carried or placed — no slot, uncapped) —
  sack:        { name: "Sack",                cat: "world", storage: 8 },
  bigSack:     { name: "Large Sack",          cat: "world", storage: 16 },
  basket:      { name: "Basket",              cat: "world", storage: 12 },
  bucket:      { name: "Bucket",              cat: "world", storage: 4 },
  crate:       { name: "Crate",               cat: "world", storage: 24 },
  bigCrate:    { name: "Large Crate",         cat: "world", storage: 48 },
  barrel:      { name: "Barrel",              cat: "world", storage: 32 },
  chest:       { name: "Chest",               cat: "world", storage: 24 },
  bigChest:    { name: "Large Chest",         cat: "world", storage: 48 },
  trunk:       { name: "Trunk",               cat: "world", storage: 64 },
  cart:        { name: "Cart",                cat: "world", storage: 100 },
  wagon:       { name: "Wagon",               cat: "world", storage: 200 },
  coveredWagon:{ name: "Covered Wagon",       cat: "world", storage: 250 },
  canoe:       { name: "Canoe",               cat: "world", storage: 80 },
  shipHold:    { name: "Ship Cargo Hold",     cat: "world", storage: 500 },   // "unlimited" → a practical cap
}
const AH_GEAR_ORDER = ["coinPurse", "pouch", "bigPouch", "scrollCase", "waterskin", "toolHolster", "bandolier", "potionBand", "satchel", "backpack", "bigBackpack", "huntingPack", "quiver", "boltCase", "sheath", "gwSling", "shieldSling", "belt", "harness",
  "saddlebags", "bigSaddlebags", "packFrame", "cargoHarness",
  "sack", "bigSack", "basket", "bucket", "crate", "bigCrate", "barrel", "chest", "bigChest", "trunk", "cart", "wagon", "coveredWagon", "canoe", "shipHold"]
const AH_GEAR_CAT_LABEL = { worn: "Worn", mount: "Mount-worn", world: "Carried / placed" }
/** Display chips for a container: body slot · +storage · what it holds · granted slots. */
function ahGearBits(cat) {
  const bits = []
  if (cat.slot) bits.push(cat.slot)
  if (cat.storage) bits.push("+" + cat.storage + " bag")
  if (cat.holds) bits.push("holds " + cat.holds)
  for (const k of Object.keys(cat.grants || {})) bits.push("+" + cat.grants[k] + " " + k)
  if (cat.restrict) bits.push(cat.restrict)
  return bits
}
// How many wearable containers each body location holds (keeps the worn set small).
const AH_WEARLOAD = { Belt: 4, Back: 2, Chest: 2, Hip: 2 }
/** The body location a container occupies (from its slot label; first listed wins). null = unworn (sack). */
function ahGearSlotKey(cat) {
  const s = String((cat && cat.slot) || "").toLowerCase().split("/")[0].trim()
  if (s.indexOf("belt") === 0) return "Belt"
  if (s.indexOf("back") === 0) return "Back"
  if (s.indexOf("chest") === 0) return "Chest"
  if (s.indexOf("hip") === 0) return "Hip"
  return null
}
function ahWearCap(slotKey, wl) { const m = wl || AH_WEARLOAD; return slotKey && m[slotKey] != null ? m[slotKey] : Infinity }
/** Count of equipped containers per body location, e.g. { Belt: 2, Back: 1 }. */
function ahWornLoad(actor) {
  const cat = ahGearCatalog(), load = {}
  for (const g of ahGearList(actor)) { const sk = ahGearSlotKey(cat[g.kind]); if (sk) load[sk] = (load[sk] || 0) + 1 }
  return load
}
// DM custom gear (world setting) merged ON TOP of the built-ins, so the DM can add
// their own belts/packs (name + storage spaces + granted slots) from the app editor.
function ahGearDefs() { try { const d = game.settings.get(MOD, "ahGearDefs"); return (d && typeof d === "object") ? d : {} } catch { return {} } }
function ahGearCatalog() { return Object.assign({}, AH_GEAR, ahGearDefs()) }
function ahGearOrder() { const custom = Object.keys(ahGearDefs()).filter(k => !AH_GEAR[k]); return AH_GEAR_ORDER.concat(custom) }
function ahGearList(actor) { try { const cat = ahGearCatalog(), g = actor.getFlag(MOD, "ahGear"); return Array.isArray(g) ? g.filter(x => x && cat[x.kind]) : [] } catch { return [] } }
function ahGearGrants(actor) {
  const out = {}, cat = ahGearCatalog()
  for (const g of ahGearList(actor)) { const c = cat[g.kind]; if (c && c.grants) for (const k of Object.keys(c.grants)) { const key = AH_SLOT_KEY[k] || k; out[key] = (out[key] || 0) + (Number(c.grants[k]) || 0) } }
  return out
}
function ahGearStorage(actor) { const cat = ahGearCatalog(); let n = 0; for (const g of ahGearList(actor)) n += (Number(cat[g.kind] && cat[g.kind].storage) || 0); return n }
/** Extra bag spaces granted by Strength (DM-configurable in the app; 0 when off / no STR). */
function ahStrBonus(actor, cfg) {
  if (!cfg || !cfg.strCapacity) return 0
  const ab = actor?.system?.abilities?.str
  if (!ab) return 0
  const score = Number(ab.value) || 0
  let basis
  if (cfg.strBasis === "score") basis = score
  else if (cfg.strBasis === "over10") basis = score - 10
  else basis = (ab.mod != null ? Number(ab.mod) : Math.floor((score - 10) / 2))   // "mod"
  return Math.max(0, Math.round((Number(cfg.strPer) || 0) * basis))
}

function ahDollGender(actor) {
  let g = ""; try { g = String(actor.system?.details?.gender || "").toLowerCase() } catch {}
  return (/female|woman|girl|she\/her/.test(g) || g === "f") ? "female" : "male"
}
function ahDollImg(actor) { return "modules/" + MOD + "/assets/paperdoll-" + ahDollGender(actor) + ".svg" }
/** Headless equip context for the equip/unequip commands (validated worn/back from the flag). */
function ahHeadlessCtx(actor) {
  const metaById = {}, byId = {}
  for (const it of actor.items) { byId[it.id] = true; try { metaById[it.id] = ahMeta(it) } catch { metaById[it.id] = { equipSlots: [] } } }
  const e = ahBuildEquip(actor, metaById, byId)
  return { actor, byId, metaById, worn: e.worn, back: e.back, placed: new Map() }
}
function ahEquippedIds(ctx) { return Object.keys(ctx.worn || {}).concat(ctx.back || []) }
function ahCaps(ctx) {
  const c = Object.assign({}, AH_BASE_CAP)
  for (const id of ahEquippedIds(ctx)) { const m = ctx.metaById[id]; const g = m && m.grantsSlots; if (g) for (const gk of Object.keys(g)) { const key = AH_SLOT_KEY[gk] || gk; if (AH_GRANTABLE.indexOf(key) >= 0) c[key] = (c[key] || 0) + g[gk] } }
  if (ctx.actor) { const gg = ahGearGrants(ctx.actor); for (const k of Object.keys(gg)) if (AH_GRANTABLE.indexOf(k) >= 0) c[k] = (c[k] || 0) + gg[k] }   // add-on storage gear
  // grants UNLOCK a single attachment point — only Back is genuinely multi-capacity, so
  // a second grantor on Head/Face/Neck/Belt/Hip doesn't advertise a 2nd (unusable) slot.
  for (const k of AH_GRANTABLE) if (k !== "Back" && c[k] > 1) c[k] = 1
  return c
}
/** Which worn item(s) grant each body slot — for the "granted by …" hints. */
function ahGrantSources(ctx) {
  const src = {}
  const add = (gk, name) => { const key = AH_SLOT_KEY[gk] || gk; if (AH_GRANTABLE.indexOf(key) >= 0) { (src[key] = src[key] || []); if (src[key].indexOf(name) < 0) src[key].push(name) } }
  for (const id of ahEquippedIds(ctx)) { const m = ctx.metaById[id]; const g = m && m.grantsSlots; if (g) { const nm = (ctx.byId[id] && ctx.byId[id].name) || ""; for (const gk of Object.keys(g)) add(gk, nm) } }
  if (ctx.actor) { const cat = ahGearCatalog(); for (const g of ahGearList(ctx.actor)) { const c = cat[g.kind]; if (c && c.grants) for (const gk of Object.keys(c.grants)) add(gk, c.name) } }
  return src
}
function ahOccupancy(ctx) {
  const occ = {}
  for (const id in (ctx.worn || {})) { const key = ctx.worn[id]; const m = ctx.metaById[id]
    if (m && m.twoHanded && (key === "LHand" || key === "RHand")) { occ.LHand = id; occ.RHand = id }
    else { occ[key] = id; if (m && m.covers) for (const cv of m.covers) { const ck = AH_SLOT_KEY[cv] || cv; occ[ck] = id } }
  }
  return occ
}
function ahFreeBody(ctx, m) {
  const caps = ahCaps(ctx), occ = ahOccupancy(ctx), out = new Set()
  for (const sName of (m.equipSlots || [])) {
    const key = AH_SLOT_KEY[sName] || sName
    if (key === "Back") { if (ctx.back.length < caps.Back) out.add("Back") }
    else if (key === "LHand" || key === "RHand") { if (m.twoHanded) { if (!occ.LHand && !occ.RHand) { out.add("LHand"); out.add("RHand") } } else if (!occ[key]) out.add(key) }
    else { if ((caps[key] || 0) > 0 && !occ[key]) out.add(key) }
  }
  return out
}
/** Place a candidate worn/back set: FIXPOINT worn placement (resolves chained grants by
 *  recomputing caps/occ each round) + grantors-first back pass (a pack's straps raise Back for
 *  its siblings). `excluded` ids are skipped entirely (used for the covers pass). */
function ahPlaceWorn(sw, sb, byId, metaById, actor, excluded) {
  const worn = {}, back = []
  let remaining = Object.keys(sw).filter(id => byId[id] && metaById[id] && !excluded.has(id))
  let progress = true
  while (progress && remaining.length) {
    progress = false
    const occ = ahOccupancy({ worn, metaById }), caps = ahCaps({ worn, back, metaById, actor })
    const next = []
    for (const id of remaining) {
      const slot = sw[id], m = metaById[id]
      if (!(m.equipSlots || []).some(s => (AH_SLOT_KEY[s] || s) === slot)) continue   // invalid slot → drop
      let ok = true
      if (m.twoHanded && (slot === "LHand" || slot === "RHand")) { if (occ.LHand || occ.RHand) ok = false }
      else if (occ[slot]) ok = false
      else if (AH_GRANTABLE.indexOf(slot) >= 0 && (caps[slot] || 0) <= 0) ok = false
      if (ok) { worn[id] = slot; progress = true } else next.push(id)
    }
    remaining = next
  }
  const sbIds = sb.filter(id => byId[id] && metaById[id] && !excluded.has(id))
  sbIds.sort((a, b) => ((metaById[a].grantsSlots ? 0 : 1) - (metaById[b].grantsSlots ? 0 : 1)))
  for (const id of sbIds) { const caps2 = ahCaps({ worn, back, metaById, actor }); if (back.indexOf(id) < 0 && back.length < caps2.Back) back.push(id) }
  return { worn, back }
}
/** Validated equip state from the owner-written `ahEquip` flag ({worn:{id:slot}, back:[ids]}).
 *  TWO-PASS for robust covers: pass 1 discovers which worn items are COVERED by a co-equipped
 *  coverer (plate's helm/sabatons over a separate hat/boots); pass 2 re-places WITHOUT them, so a
 *  dropped coverer-victim's grants never leak into caps no matter what a coverer covers. */
function ahBuildEquip(actor, metaById, byId) {
  let saved = {}; try { saved = actor.getFlag(MOD, "ahEquip") || {} } catch {}
  const sw = (saved.worn && typeof saved.worn === "object") ? saved.worn : {}
  const sb = Array.isArray(saved.back) ? saved.back : []
  const r1 = ahPlaceWorn(sw, sb, byId, metaById, actor, new Set())
  const covered = new Set()
  for (const id of Object.keys(r1.worn)) {
    const slot = r1.worn[id]
    for (const oid of Object.keys(r1.worn)) {
      if (oid === id) continue
      const om = metaById[oid]
      if (om && Array.isArray(om.covers) && om.covers.some(c => (AH_SLOT_KEY[c] || c) === slot)) { covered.add(id); break }
    }
  }
  return covered.size ? ahPlaceWorn(sw, sb, byId, metaById, actor, covered) : r1   // coverers can't be covered → set is stable, no 3rd pass
}
/** The ONE client that should persist AUTOMATIC self-heal writes, so concurrent viewers don't
 *  duplicate them: an active GM if any (lowest user id wins), else the lowest-id active OWNER. */
function ahIsWriteAuthority(actor) {
  try {
    const me = game.user; if (!me) return false
    const low = (arr) => arr.reduce((a, b) => (String(a.id) <= String(b.id) ? a : b))
    const gms = game.users.filter(u => u.active && u.isGM)
    if (gms.length) return !!me.isGM && low(gms).id === me.id
    const owners = game.users.filter(u => u.active && actor && actor.testUserPermission && actor.testUserPermission(u, "OWNER"))
    if (!owners.length) return !!(actor && actor.isOwner)
    return low(owners).id === me.id
  } catch { return !!(game.user && game.user.isGM) }
}
function ahSaveEquip(ctx) { try { ctx.actor.setFlag(MOD, "ahEquip", { worn: ctx.worn, back: ctx.back }) } catch (e) { console.warn("[pendant-bridge] AH equip save failed", e) } }
function ahPlaceObj(ctx) { const o = {}; ctx.placed.forEach((p, id) => { o[id] = { col: p.col, row: p.row, rot: p.rot } }); return o }
// Mirror the slot state onto dnd5e's own `equipped` flag — an item is "equipped"
// on the sheet only when it's slotted on the body (per the locked rule).
function ahSetEquipped(ctx, id, on) {
  try {
    const it = ctx.actor.items.get(id); if (!it || !it.system) return
    const upd = {}
    if ("equipped" in it.system) upd["system.equipped"] = !!on
    if (on && ahBinding(ctx) && it.system.container) upd["system.container"] = null   // equipping pulls it out of any container (it's worn now, not bagged)
    if (Object.keys(upd).length) Promise.resolve(it.update(upd)).catch(e => console.warn("[pendant-bridge] AH equip write failed", e))
  } catch {}
}
function ahEquipItem(ctx, id, slotKey) {
  ctx.placed.delete(id)
  if (slotKey === "Back") { if (ctx.back.indexOf(id) < 0) ctx.back.push(id) } else ctx.worn[id] = slotKey
  ahSaveEquip(ctx); ahPersistPlace(ctx); ahSetEquipped(ctx, id, true)
}
function ahUnequip(ctx, id) { delete ctx.worn[id]; ctx.back = ctx.back.filter(x => x !== id); ahSaveEquip(ctx); ahSetEquipped(ctx, id, false) }
/** One-click DRAW (stow → free hand) / SHEATHE (hand → free belt/hip/back) for a one-handed weapon.
 *  Stays "equipped" either way — it just relocates on the body, so dnd5e's equipped flag is untouched. */
function ahDrawSheathe(ctx, id) {
  const m = ctx.metaById[id]; if (!m || m.twoHanded) return
  const cur = ctx.worn[id] || (ctx.back.indexOf(id) >= 0 ? "Back" : null); if (!cur) return
  const slots = (m.equipSlots || []).map(s => AH_SLOT_KEY[s] || s)
  const inHand = cur === "LHand" || cur === "RHand"
  const free = ahFreeBody(ctx, m)
  const want = inHand ? ["RHip", "LHip", "Belt", "Back"] : ["RHand", "LHand"]
  let target = null
  for (const s of want) { if (slots.indexOf(s) >= 0 && free.has(s) && s !== cur) { target = s; break } }
  if (!target) { try { if (typeof ui !== "undefined" && ui.notifications) ui.notifications.warn(inHand ? "No open belt, hip, or back slot to sheathe into." : "No free hand to draw to.") } catch {} return }
  delete ctx.worn[id]; ctx.back = ctx.back.filter(x => x !== id)
  if (target === "Back") ctx.back.push(id); else ctx.worn[id] = target
  ahSaveEquip(ctx)   // one write; still equipped, just relocated
}

/** Auto-equip the obvious WORN kit — clothes, armor, and non-weapon back items (packs, cloaks,
 *  bedrolls). Never weapons (the player places those). Grantors first so packs get a Back point. */
function ahSuitUp(ctx) {
  const isCand = (it) => {
    if (it.type === "weapon" || (ctx.bundleN[it.id] || 1) > 1) return false
    const m = ctx.metaById[it.id]; if (!m || !(m.equipSlots || []).length) return false
    if (m.carryType === "Clothing" || m.carryType === "Armor" || m.carryType === "Container") return true
    const slots = (m.equipSlots || []).map(s => AH_SLOT_KEY[s] || s)
    return slots.length > 0 && slots.every(s => s === "Back")   // cloak / bedroll
  }
  // clothing/armor first, then grantor packs, then plain back items (bedroll/cloak)
  const pri = (it) => { const m = ctx.metaById[it.id]; return (m.carryType === "Clothing" || m.carryType === "Armor") ? 0 : (m.grantsSlots ? 1 : 2) }
  let pending = ctx.items.filter(isCand).sort((a, b) => pri(a) - pri(b) || (a.name || "").localeCompare(b.name || ""))
  // FIXPOINT: keep equipping while any succeeds — a pack equips (raising Back) before its sibling.
  let any = false, progress = true
  while (progress && pending.length) {
    progress = false
    const next = []
    for (const it of pending) {
      if (ahEquippedIds(ctx).indexOf(it.id) >= 0) continue
      const m = ctx.metaById[it.id], free = ahFreeBody(ctx, m)
      if (!free.size) { next.push(it); continue }
      let slot = null; for (const s of (m.equipSlots || [])) { const k = AH_SLOT_KEY[s] || s; if (free.has(k)) { slot = k; break } }
      if (!slot) slot = [...free][0]
      if (slot === "Back") { if (ctx.back.indexOf(it.id) < 0) ctx.back.push(it.id) } else ctx.worn[it.id] = slot
      ctx.placed.delete(it.id); ahSetEquipped(ctx, it.id, true); any = true; progress = true
    }
    pending = next
  }
  if (any) { ahSaveEquip(ctx); ahPersistPlace(ctx) }
}
/** Unequip everything to loose. */
function ahStripAll(ctx) {
  const ids = ahEquippedIds(ctx); if (!ids.length) return
  ctx.worn = {}; ctx.back = []
  for (const id of ids) ahSetEquipped(ctx, id, false)
  ahSaveEquip(ctx)
}
// ── loadout presets ("outfits") ──────────────────────────────────────────────
function ahOutfits(actor) { try { const o = actor.getFlag(MOD, "ahOutfits"); return Array.isArray(o) ? o : [] } catch { return [] } }
async function ahPromptName(def) {
  try { const D = foundry && foundry.applications && foundry.applications.api && foundry.applications.api.DialogV2
    if (D) { const v = await D.prompt({ window: { title: "Name this outfit" }, content: '<input type="text" name="n" value="' + ahEscX(def) + '" style="width:100%" autofocus>', ok: { label: "Save", callback: (e, btn) => (btn.form.elements.n.value || "").trim() }, rejectClose: false }); return v == null ? null : v }
  } catch {}
  try { return await new Promise(res => { new Dialog({ title: "Name this outfit", content: '<input type="text" id="ah-otf-name" value="' + ahEscX(def) + '" style="width:100%">', buttons: { ok: { label: "Save", callback: (html) => { try { const v = html.find ? html.find("#ah-otf-name").val() : (html[0] || html).querySelector("#ah-otf-name").value; res((v || "").trim()) } catch { res(def) } } }, cancel: { label: "Cancel", callback: () => res(null) } }, default: "ok", close: () => res(null) }).render(true) }) } catch { return null }
}
async function ahSaveOutfit(ctx) {
  const name = await ahPromptName("Outfit " + (ahOutfits(ctx.actor).length + 1)); if (name == null) return
  const list = ahOutfits(ctx.actor).slice()
  list.push({ id: "o" + Math.random().toString(36).slice(2, 8), name: String(name || "Outfit").slice(0, 30), worn: Object.assign({}, ctx.worn), back: ctx.back.slice() })
  try { await ctx.actor.setFlag(MOD, "ahOutfits", list) } catch (e) { console.warn("[pendant-bridge] AH outfit save failed", e) }
}
function ahApplyOutfit(ctx, outfit) {
  const prev = ahEquippedIds(ctx)
  ctx.worn = Object.assign({}, outfit.worn || {}); ctx.back = Array.isArray(outfit.back) ? outfit.back.slice() : []
  const now = ahEquippedIds(ctx)
  for (const id of prev) if (now.indexOf(id) < 0) ahSetEquipped(ctx, id, false)
  for (const id of now) { ahSetEquipped(ctx, id, true); ctx.placed.delete(id) }
  ahSaveEquip(ctx); ahPersistPlace(ctx)   // ahBuildEquip re-validates on rebuild
}
async function ahDeleteOutfit(ctx, oid) { try { await ctx.actor.setFlag(MOD, "ahOutfits", ahOutfits(ctx.actor).filter(o => o.id !== oid)) } catch {} }

/** GAME-PANEL paperdoll: the figure is centred, framed by two columns of NAMED gear boxes
 *  (item name + slot + actions read at a glance — no icon-only tiles). Hovering/focusing a box
 *  lights the matching body region on the figure (markers wired in ahBuildPanel). */
function ahRenderDoll(ctx) {
  if (!ctx.dollEl) return
  const occ = ahOccupancy(ctx), caps = ahCaps(ctx), gsrc = ahGrantSources(ctx)
  const covered = []; let anyLocked = false
  const colHTML = (keys) => {
    const out = []
    for (const key of keys) {
      if (key === "Back") {
        const n = ctx.back.length, cap = caps.Back || 0
        if (cap <= 0 && n === 0) { anyLocked = true; continue }   // ungranted + empty → hidden (footnote)
        out.push(ahSlotCard(ctx, key, occ, caps, gsrc)); continue
      }
      const cap = AH_GRANTABLE.indexOf(key) >= 0 ? (caps[key] || 0) : 1
      const id = occ[key]
      // covered (plate over Feet/Head): not its own box, acknowledged in a faint footnote
      if (id && ctx.worn[id] && ctx.worn[id] !== key && !(ctx.metaById[id] && ctx.metaById[id].twoHanded && (key === "LHand" || key === "RHand"))) {
        covered.push({ key, by: ctx.byId[id] ? ctx.byId[id].name : "" }); continue
      }
      if (!id && cap <= 0 && !AH_BASE_MOUNTS.has(key)) { anyLocked = true; continue }   // ungranted empty → hidden
      out.push(ahSlotCard(ctx, key, occ, caps, gsrc))
    }
    return out.join("")
  }
  const left = colHTML(AH_DOLL_LEFT), right = colHTML(AH_DOLL_RIGHT)
  let foot = ""
  if (covered.length) {
    const by = {}; for (const c of covered) (by[c.by] = by[c.by] || []).push(AH_SLOT_LABEL[c.key] || c.key)
    const parts = Object.keys(by).map(nm => by[nm].join(" & ") + (nm ? " covered by " + ahShort(nm) : " covered"))
    foot += '<span class="ah-doll-note">' + ahIcon("clothes") + " " + ahEscX(parts.join(" · ")) + "</span>"
  }
  if (anyLocked && ctx.canArrange) foot += '<span class="ah-doll-note">' + ahIcon("lock") + " Equip clothing or armor to unlock more slots</span>"
  ctx.dollEl.innerHTML =
    '<div class="ah-game">' +
      '<div class="ah-gcol l">' + left + "</div>" +
      '<div class="ah-gfig"><img class="ah-doll-img" src="' + ahDollImg(ctx.actor) + '" alt="" draggable="false"/></div>' +
      '<div class="ah-gcol r">' + right + "</div>" +
    "</div>" +
    (foot ? '<div class="ah-doll-foot">' + foot + "</div>" : "")
}
/** How many of the actor's not-worn items can actually go in this slot (matches the picker). */
function ahCountFits(ctx, key) {
  const used = new Set(ahEquippedIds(ctx)); let n = 0
  for (const it of ctx.items) {
    if (used.has(it.id) || (ctx.bundleN[it.id] || 1) > 1) continue
    { const pp = ctx.placed && ctx.placed.get(it.id); if (pp && !pp.of) continue }            // already packed in the bag → not "loose & fits here" (overflow markers are loose)
    const m = ctx.metaById[it.id]; if (m && ahFreeBody(ctx, m).has(key)) n++
  }
  return n
}
/** One NAMED gear box for the game-panel doll — icon · item name · slot label · inline actions.
 *  Renders filled / empty(+pick) / Back-multi. Ungranted-locked and covered slots are filtered out
 *  by ahRenderDoll (shown as a faint footnote), so they never reach here. Every drop/pick/remove/draw
 *  contract (data-slot · data-pick[role=button] · data-rm · data-draw · .valid/.swap) is preserved. */
function ahSlotCard(ctx, key, occ, caps, gsrc) {
  const label = AH_SLOT_LABEL[key] || key
  const ico = ahArtThumb(null, "", AH_SLOT_ICON[key])   // empty slot → muted slot-icon thumbnail (no item art)
  const gby = (gsrc && gsrc[key] && gsrc[key].length) ? " · granted by " + gsrc[key].join(", ") : ""
  const txt = (nm, sl, muted) => '<span class="ah-gb-tx"><span class="ah-gb-nm' + (muted ? " muted" : "") + '">' + ahEscX(nm) + '</span><span class="ah-gb-sl">' + ahEscX(sl) + "</span></span>"
  if (key === "Back") {
    const n = ctx.back.length, cap = caps.Back || 0
    const valid = ctx.validBody && ctx.validBody.has("Back"), canAdd = ctx.canArrange && n < cap
    const cls = "ah-slot ah-gb back" + (n ? " filled" : " empty") + (valid ? " valid" : "")
    if (n) {
      const lb = ctx.byId[ctx.back[0]] || {}
      const names = ctx.back.map(bid => (ctx.byId[bid] && ctx.byId[bid].name) || "").filter(Boolean).join(", ")
      const lead = lb.color || "var(--ah-dim)"
      const dots = ctx.back.map(bid => '<button type="button" class="ah-bdot" data-rm="' + ahEscX(bid) + '" aria-label="' + ahEscX("Remove " + ctx.byId[bid].name + " from Back") + '" title="' + ahEscX(ctx.byId[bid].name + " — remove") + '" style="background:' + ctx.byId[bid].color + '"></button>').join("")
      // room for more → the box itself is the add picker (click anywhere but a dot); dots still remove
      const pick = canAdd ? ' role="button" tabindex="0" data-pick="Back"' : ""
      return '<div class="' + cls + '" data-slot="Back"' + pick + ' style="border-top-color:' + lead + '" title="' + ahEscX("Back — " + n + "/" + cap + (canAdd ? " · click to add another" : "") + gby) + '" aria-label="' + ahEscX("Back, " + n + " of " + cap + " used" + (canAdd ? ", click to add another" : "")) + '">' + ahArtThumb(lb.img, lead, "back") + txt(names, "back " + n + "/" + cap + (canAdd ? " · add" : "")) + '<span class="ah-gb-dots">' + dots + "</span></div>"
    }
    const pick = canAdd ? ' role="button" tabindex="0" data-pick="Back"' : ""   // empty+addable Back is the picker target; a filled Back is a drop target with its own dot buttons
    return '<div class="' + cls + '" data-slot="Back"' + pick + ' title="' + ahEscX("Back — 0/" + cap + gby) + '" aria-label="' + ahEscX("Back, empty, 0 of " + cap) + '">' + ico + txt("Back", "0/" + cap + (canAdd ? " · add" : ""), true) + (canAdd ? '<span class="ah-gb-plus" aria-hidden="true">+</span>' : "") + "</div>"
  }
  const id = occ[key]
  if (id) {
    const it = ctx.byId[id]
    const swap = (ctx.validSwap && ctx.validSwap.has(key)) ? " swap" : ""
    // one-handed weapon → a draw/sheathe quick-action (sheathe always offered; draw only if a hand is free)
    const dm = ctx.metaById[id]; let dsBtn = ""
    if (ctx.canArrange && dm && dm.carryType === "Weapon" && !dm.twoHanded) {
      const inHand = key === "LHand" || key === "RHand"
      // `occ` (the expanded occupancy passed in) sets BOTH hands for a 2-handed weapon, so this
      // hides "draw" when no hand is truly free instead of dead-clicking.
      if (inHand || !(occ.RHand && occ.LHand)) {
        dsBtn = '<button type="button" class="ah-gb-draw" data-draw="' + ahEscX(id) + '" aria-label="' + ahEscX((inHand ? "Sheathe " : "Draw ") + it.name) + '" title="' + (inHand ? "Sheathe — stow on belt/hip/back" : "Draw to a free hand") + '">' + (inHand ? "sheathe" : "draw") + "</button>"
      }
    }
    const rm = ctx.canArrange ? '<button type="button" class="ah-gb-x" data-rm="' + ahEscX(id) + '" aria-label="' + ahEscX("Remove " + it.name) + '" title="Remove">×</button>' : ""
    const cls = "ah-slot ah-gb filled" + swap
    // real Foundry item art fills the slot; item colour tints the top border; the NAME reads at a glance
    return '<div class="' + cls + '" data-slot="' + ahEscX(key) + '" style="border-top-color:' + it.color + '" title="' + ahEscX(it.name + " — " + label + (swap ? " · drop to swap" : gby)) + '" aria-label="' + ahEscX(it.name + ", " + label) + '">' + ahArtThumb(it.img, it.color, AH_SLOT_ICON[key]) + txt(it.name, label) + dsBtn + rm + (swap ? '<span class="ah-gb-swap" aria-hidden="true">↔</span>' : "") + "</div>"
  }
  // empty + available → picker target (click/Enter) AND drop target (data-slot)
  const valid = ctx.validBody && ctx.validBody.has(key)
  const fitN = ctx.canArrange ? ahCountFits(ctx, key) : 0
  const cls = "ah-slot ah-gb empty" + (valid ? " valid" : "")
  const pick = ctx.canArrange ? ' data-pick="' + ahEscX(key) + '" role="button" tabindex="0"' : ""
  return '<div class="' + cls + '" data-slot="' + ahEscX(key) + '"' + pick + ' title="' + ahEscX("Add to " + label + (fitN ? " (" + fitN + " fit)" : "") + gby) + '" aria-label="' + ahEscX("Add to " + label + (fitN ? ", " + fitN + " items fit" : "")) + '">' + ico + txt(label, ctx.canArrange ? (fitN ? fitN + " fit" : "empty") : "empty", true) + (ctx.canArrange ? '<span class="ah-gb-plus" aria-hidden="true">+</span>' : "") + "</div>"
}

/** Click an empty slot → a menu of fitting items (loose AND in the bag); click one to equip. */
function ahOpenSlotMenu(ctx, slotKey, anchorEl) {
  ahCloseMenu(ctx)
  const equipped = new Set(ahEquippedIds(ctx))   // bag items ARE candidates now (equip pulls them out)
  const cands = ctx.items.filter(it => (ctx.bundleN[it.id] || 1) <= 1 && !equipped.has(it.id) && ctx.metaById[it.id] && ahFreeBody(ctx, ctx.metaById[it.id]).has(slotKey))
  cands.sort((a, b) => (ctx.placed.has(a.id) ? 1 : 0) - (ctx.placed.has(b.id) ? 1 : 0) || (a.name || "").localeCompare(b.name || ""))   // loose first, then bag
  const menu = document.createElement("div"); menu.className = "ah-pickmenu"
  if (!cands.length) menu.innerHTML = '<div class="ah-pick-empty">Nothing you have fits here</div>'
  else for (const it of cands) {
    const b = document.createElement("button"); b.className = "ah-pick-it"
    b.innerHTML = ahArtThumb(it.img, it.color, AH_SLOT_ICON[slotKey]) + "<span>" + ahEscX(it.name) + "</span>" + (ctx.placed.has(it.id) ? '<em class="ah-pick-bag">in bag</em>' : "")
    b.addEventListener("click", (e) => { e.stopPropagation(); ahCloseMenu(ctx); ahEquipItem(ctx, it.id, slotKey) })
    menu.appendChild(b)
  }
  menu.setAttribute("aria-label", "Items that fit " + (AH_SLOT_LABEL[slotKey] || slotKey))
  // host on the .ah-slot CARD (a positioned div), never inside a native button (Back "+ add"),
  // so we don't nest button>menu>button — and the menu still anchors to the slot via position:absolute.
  const host = (anchorEl && anchorEl.closest && anchorEl.closest(".ah-slot")) || ctx.dollEl
  host.appendChild(menu); ctx._menu = menu
  ahWireMenu(menu, anchorEl, () => ahCloseMenu(ctx))
  setTimeout(() => {
    const onDoc = (e) => { if (ctx._menu && !ctx._menu.contains(e.target)) ahCloseMenu(ctx) }
    document.addEventListener("mousedown", onDoc); ctx._menuOff = () => document.removeEventListener("mousedown", onDoc)
  }, 0)
}
function ahCloseMenu(ctx) { if (ctx._menuOff) { ctx._menuOff(); ctx._menuOff = null } if (ctx._menu) { ctx._menu.remove(); ctx._menu = null } }
/** Give a popup the ARIA menu pattern: role=menu/menuitem, focus first item, arrow-key nav,
 *  Escape closes + returns focus to the trigger. */
function ahWireMenu(menu, trigger, close) {
  menu.setAttribute("role", "menu"); menu.setAttribute("tabindex", "-1")
  const items = Array.prototype.slice.call(menu.querySelectorAll("button:not([disabled])"))
  items.forEach(b => b.setAttribute("role", "menuitem"))
  setTimeout(() => { (items[0] || menu).focus() }, 0)
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); if (close) close(); if (trigger && trigger.focus) trigger.focus(); return }
    if (!items.length) return
    const i = items.indexOf(document.activeElement)
    if (e.key === "ArrowDown") { e.preventDefault(); (items[i + 1] || items[0]).focus() }
    else if (e.key === "ArrowUp") { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus() }
    else if (e.key === "Home") { e.preventDefault(); items[0].focus() }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus() }
  })
}

/** "+ Add" storage gear → a menu of belts/packs/pouches; click adds one to the actor. */
function ahOpenGearMenu(actor, anchorEl, triggerEl) {
  anchorEl.querySelectorAll(".ah-gear-menu").forEach(n => n.remove())
  const menu = document.createElement("div"); menu.className = "ah-gear-menu"
  const catalog = ahGearCatalog()
  const load = ahWornLoad(actor)   // containers already worn, per body location
  const wl = (AH.cfg().wearLoad) || AH_WEARLOAD   // DM-tunable per-location caps
  // header: how full each capped location is, so the player sees the limits at a glance
  const hbits = Object.keys(wl).map(k => k + " " + (load[k] || 0) + "/" + wl[k])
  const head = document.createElement("div"); head.className = "ah-gear-mhead"; head.textContent = hbits.join(" · "); menu.appendChild(head)
  let curCat = null
  for (const kind of ahGearOrder()) {
    const cat = catalog[kind]; if (!cat) continue
    const ccat = cat.cat || "worn"
    if (ccat !== curCat) { curCat = ccat; const ch = document.createElement("div"); ch.className = "ah-gear-mcat"; ch.textContent = AH_GEAR_CAT_LABEL[ccat] || ccat; menu.appendChild(ch) }
    const sk = ahGearSlotKey(cat), cap = ahWearCap(sk, wl), full = sk != null && (load[sk] || 0) >= cap
    const bits = ahGearBits(cat)
    const b = document.createElement("button"); b.className = "ah-gear-mi" + (full ? " full" : "")
    if (full) { b.disabled = true; b.setAttribute("aria-disabled", "true") }
    const tail = full ? ' <span class="ah-gear-mi-full">' + ahEscX(sk + " full") + "</span>" : ""
    b.innerHTML = '<span class="ah-gear-mi-n">' + ahEscX(cat.name) + tail + '</span>' + (bits.length ? '<span class="ah-gear-mi-m">' + ahEscX(bits.join(" · ")) + '</span>' : "")
    if (!full) b.addEventListener("click", async (e) => {
      e.stopPropagation()
      if (sk != null && (ahWornLoad(actor)[sk] || 0) >= ahWearCap(sk, wl)) return   // re-check: location filled meanwhile
      close()   // close on first add so a rapid second click can't over-cap the same location (TOCTOU)
      const list = ahGearList(actor).slice(); list.push({ id: "g" + Math.random().toString(36).slice(2, 8), kind })
      try { await actor.setFlag(MOD, "ahGear", list) } catch (er) { console.warn("[pendant-bridge] AH gear add failed", er) }
    })
    menu.appendChild(b)
  }
  menu.setAttribute("aria-label", "Add storage gear")
  const trigger = triggerEl || ((typeof document !== "undefined") ? document.activeElement : null)
  anchorEl.appendChild(menu)
  const close = () => { menu.remove(); document.removeEventListener("mousedown", onDoc) }
  const onDoc = (e) => { if (!menu.contains(e.target)) close() }
  ahWireMenu(menu, trigger, close)
  setTimeout(() => { document.addEventListener("mousedown", onDoc) }, 0)
}
/** Saved-outfits dropdown (folds the old always-on outfit chip row): apply · delete · save current. */
function ahOpenOutfitMenu(ctx, anchorEl, triggerEl) {
  anchorEl.querySelectorAll(".ah-outfit-menu").forEach(n => n.remove())
  const menu = document.createElement("div"); menu.className = "ah-outfit-menu"; menu.setAttribute("aria-label", "Outfits")
  const outfits = ahOutfits(ctx.actor)
  if (!outfits.length) { const e = document.createElement("div"); e.className = "ah-om-empty"; e.textContent = "No saved outfits yet."; menu.appendChild(e) }
  for (const o of outfits) {
    const row = document.createElement("div"); row.className = "ah-om-row"   // wrapper (no nested button)
    const apply = document.createElement("button"); apply.type = "button"; apply.className = "ah-om-apply"; apply.textContent = o.name || "Outfit"; apply.setAttribute("aria-label", "Wear outfit " + (o.name || "Outfit"))
    apply.addEventListener("click", (e) => { e.stopPropagation(); ahApplyOutfit(ctx, o); close() }); row.appendChild(apply)
    const del = document.createElement("button"); del.type = "button"; del.className = "ah-om-x"; del.textContent = "×"; del.title = "Delete outfit"; del.setAttribute("aria-label", "Delete outfit " + (o.name || "Outfit"))
    del.addEventListener("click", (e) => { e.stopPropagation(); ahDeleteOutfit(ctx, o.id); row.remove() }); row.appendChild(del)
    menu.appendChild(row)
  }
  const save = document.createElement("button"); save.type = "button"; save.className = "ah-om-save"; save.innerHTML = ahIcon("plus") + " Save current as outfit"
  save.addEventListener("click", (e) => { e.stopPropagation(); ahSaveOutfit(ctx); close() }); menu.appendChild(save)
  const trigger = triggerEl || ((typeof document !== "undefined") ? document.activeElement : null)
  anchorEl.appendChild(menu)
  const close = () => { menu.remove(); document.removeEventListener("mousedown", onDoc) }
  const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== triggerEl) close() }
  ahWireMenu(menu, trigger, close)
  setTimeout(() => { document.addEventListener("mousedown", onDoc) }, 0)
}

function ahMoveGhost(ctx, e) { const el = ctx.ghostEl; if (!el) return; el.style.left = (e.clientX + 12) + "px"; el.style.top = (e.clientY + 8) + "px" }
/** Unified drag of an item from the tray (from:'tray') or the bag (from:'bag') →
 *  drop on a body slot to equip, or into the bag to pack (R rotates). */
function ahDragItem(ctx, id, from, ev) {
  if (!ctx.canArrange || ctx.held || !ctx.unitById[id]) return
  ev.preventDefault()
  const it = ctx.unitById[id]
  const realId = it.itemId || id          // bundle uids ("itemId#k") resolve to the real item for equip
  const m = ctx.metaById[realId] || { equipSlots: [] }
  let origPlace = null
  if (from === "bag") { origPlace = ctx.placed.get(id); ctx.placed.delete(id) }
  ctx.held = { id, realId, item: it, rot: origPlace ? origPlace.rot : 0, from, origPlace }
  _ahDrag.active = true; _ahDrag.actorId = ctx.actor && ctx.actor.id   // hold THIS actor's panel still while dragging
  _ahDrag.cancel = () => finish(true)   // orphan backstop calls this → cleanly removes listeners + reverts (finish is hoisted)
  ctx.hover = null; ctx.hoverBin = null; ctx.hoverCell = null; ctx.hoverRot = null   // hoverCell/Rot = the cursor's hex + held rotation within the hovered bin (separate mode)
  ctx.validBody = ahFreeBody(ctx, m)
  // slots the item COULD take that are currently occupied → drop there to SWAP
  const occ0 = ahOccupancy(ctx); ctx.validSwap = new Set()
  for (const s of (m.equipSlots || [])) { const k = AH_SLOT_KEY[s] || s; if (k !== "Back" && occ0[k] && !ctx.validBody.has(k)) ctx.validSwap.add(k) }
  if (ctx.ghostEl) { ctx.ghostEl.textContent = it.name; ctx.ghostEl.style.display = "block"; ahMoveGhost(ctx, ev) }
  ahRenderDoll(ctx); ahRenderBoard(ctx); ahRenderTray(ctx)
  // coalesce hover-recompute + board redraw to one paint per frame (mousemove can fire >100/s)
  const sx = ev.clientX, sy = ev.clientY   // drag origin → a small movement threshold (below)
  let raf = 0, lastE = ev, moved = false   // seed lastE so R-rotate repaints even before the first move
  const draw = () => {
    raf = 0; if (!ctx.held || !lastE) return
    const host = ctx.separate ? ctx.binsEl : ctx.holder
    if (host && !host.isConnected) { finish(true); return }
    ahMoveGhost(ctx, lastE)
    if (ctx.separate) {   // multi-grid: detect WHICH bin the cursor is over (the ghost is pointer-events:none)
      const el = document.elementFromPoint(lastE.clientX, lastE.clientY)
      const be = el && el.closest && el.closest("[data-bin]")
      const hb = (be && ctx.binsEl && ctx.binsEl.contains(be)) ? be.getAttribute("data-bin") : null   // only THIS actor's bins
      // the cursor's exact hex IN that bin's own grid (per-bin geom + screen matrix → tracks the cursor)
      let hc = null
      if (hb) { const holder = ctx.binHolders && ctx.binHolders[hb]; const svg = holder && holder.querySelector(".ah-svg"); const bin = ctx.binById[hb]; hc = ahPixelCellGeom(svg, bin && bin.geom, lastE) }
      if (hb !== ctx.hoverBin || !ahCellEq(hc, ctx.hoverCell) || ctx.held.rot !== ctx.hoverRot) {   // repaint only when the target hex (or rotation) changes
        ctx.hoverBin = hb; ctx.hoverCell = hc; ctx.hoverRot = ctx.held.rot; ahRenderBoard(ctx)
      }
      return
    }
    ctx.hover = ahPixelCell(ctx, lastE); ahRenderBoard(ctx)
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(draw) }
  const move = (e) => { if (!ctx.held) return; const host = ctx.separate ? ctx.binsEl : ctx.holder; if (host && !host.isConnected) { finish(true); return } if (!moved && (Math.abs(e.clientX - sx) > 5 || Math.abs(e.clientY - sy) > 5)) moved = true; lastE = e; schedule() }
  // R rotates, Esc cancels. CAPTURE on window + preventDefault/stopPropagation so the key reaches us
  // BEFORE any Foundry/system/module keybind can swallow "R" (which was making rotate look dead).
  const key = (e) => { if (!ctx.held) return; if (e.key === "r" || e.key === "R") { e.preventDefault(); e.stopPropagation(); ctx.held.rot = (ctx.held.rot + 1) % 6; schedule() } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(true) } }
  // released WITHOUT a real drag (a click / let-go-too-soon) → pass no event so finish drops nothing
  // and cleanly reverts (bag item back to its bin, loose item stays loose). Only a genuine drag drops.
  const up = (e) => finish(false, moved ? e : null)
  function finish(cancel, e) {
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    _ahDrag.active = false; _ahDrag.cancel = null   // release the panel; setFlag re-renders below proceed normally
    document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); window.removeEventListener("keydown", key, true)
    if (ctx.ghostEl) ctx.ghostEl.style.display = "none"
    const held = ctx.held; ctx.held = null; const vb = ctx.validBody || new Set(); const vs = ctx.validSwap || new Set(); ctx.validBody = null; ctx.validSwap = null; const hc = ctx.separate ? null : (e ? ahPixelCell(ctx, e) : ctx.hover); ctx.hover = null; ctx.hoverBin = null; ctx.hoverCell = null; ctx.hoverRot = null
    if (!held) return
    let done = false
    if (!cancel && e) {
      const tgt = document.elementFromPoint(e.clientX, e.clientY)
      const slotEl = tgt && tgt.closest && tgt.closest("[data-slot]")
      const slot = slotEl && slotEl.getAttribute("data-slot")
      if (slot && vb.has(slot)) { ahEquipItem(ctx, held.realId, slot); done = true }
      else if (slot && vs.has(slot)) {   // swap: clear the occupant (+ other hand if 2-handed), then equip
        const occ = ahOccupancy(ctx), occId = occ[slot]; if (occId) ahUnequip(ctx, occId)
        const hm = ctx.metaById[held.realId]
        if (hm && hm.twoHanded && (slot === "LHand" || slot === "RHand")) { const oth = slot === "LHand" ? "RHand" : "LHand"; const o2 = ahOccupancy(ctx)[oth]; if (o2) ahUnequip(ctx, o2) }
        ahEquipItem(ctx, held.realId, slot); done = true
      }
      else if (ctx.separate) {   // multi-grid: assign to whichever bin the cursor was released over, at the exact hex
        const binEl = tgt && tgt.closest && tgt.closest("[data-bin]")
        const bin = binEl && ctx.binsEl && ctx.binsEl.contains(binEl) && ctx.binById[binEl.getAttribute("data-bin")]   // only THIS actor's bins
        if (bin) {
          const holder = ctx.binHolders && ctx.binHolders[bin.binId]; const svg = holder && holder.querySelector(".ah-svg")
          const cell = ahPixelCellGeom(svg, bin.geom, e)                       // recompute from the mouseup event (rAF could have staled the hover)
          const t = ahSepDropTarget(ctx, bin, held.id, held.rot, cell)         // the exact landing hex (same as the green preview)
          if (t) {
            ahAssignUnit(ctx, held.id, bin.binId, { col: t.col, row: t.row, rot: t.rot })   // store the chosen cell; mirror: it: bins also write system.container
            ctx.placed.set(held.id, { col: t.col, row: t.row, rot: t.rot, bin: bin.binId })  // reflect NOW — if the flag write is a no-op (dropped on the same spot) nothing would re-render and the item would vanish until the next render
            ahRenderBoard(ctx); ahRenderTray(ctx)
            done = true
          }
        }
      }
      else if (hc && ahBagAccepts(ctx, held.id)) { const fit = ahSnapPlace(ctx, held.item, hc, held.rot); if (fit) { ctx.placed.set(held.id, { col: fit.col, row: fit.row, rot: held.rot }); ahSavePlace(ctx.actor, ahPlaceObj(ctx)); done = true } }
    }
    if (!done) { if (held.from === "bag" && held.origPlace) ctx.placed.set(held.id, held.origPlace); ahRenderDoll(ctx); ahRenderBoard(ctx); ahRenderTray(ctx) }
    if (_ahDrag.missed) { _ahDrag.missed = false; try { const sh = ctx.actor && ctx.actor.sheet; if (sh && sh.rendered) sh.render(false) } catch {} }   // catch up a render we skipped mid-drag
  }
  document.addEventListener("mousemove", move); document.addEventListener("mouseup", up); window.addEventListener("keydown", key, true)   // keydown on window/CAPTURE → R/Esc reach us before Foundry keybinds
}

function ahBuildPanel(actor) {
  const cfg = AH.cfg()
  const sum = ahStateOf(actor)            // stored authority (GM-computed), live fallback
  const isGM = !!game.user?.isGM
  const capacity = Math.max(0, Math.round(sum.capacity))

  // items + metadata (rules engine runs on the live Foundry item)
  const items = sum.items.map(it => ({ id: it.id, name: it.name, type: it.type, img: it.img, uses: it.uses || null, spaces: it.spaces, qty: it.qty, override: it.override, color: ahColorFor(it.id), shape: (Array.isArray(it.shape) && it.shape.length) ? it.shape : ahShapeFor(ahCellSize(it), ahHashOf(it.id)) }))
  const byId = {}; for (const it of items) byId[it.id] = it
  const metaById = {}; for (const it of items) { let m; try { m = ahMeta(actor.items.get(it.id)) } catch { m = null } metaById[it.id] = m || { equipSlots: [], carryType: "Miscellaneous", grantsSlots: null } }
  const ctx = {
    actor, items, byId, metaById, validList: [], validSet: new Set(), geom: ahGeom(0),
    canArrange: !!(actor.isOwner || game.user?.isGM), placed: new Map(), worn: {}, back: [],
    held: null, hover: null, validBody: null, holder: null, trayEl: null, dollEl: null, ghostEl: null, bagCapacity: 0,
    units: [], unitById: {}, bundleN: {}, cfg, capEach: capacity,   // capEach + cfg drive the bagMode container gate
  }
  const eq = ahBuildEquip(actor, metaById, byId); ctx.worn = eq.worn; ctx.back = eq.back
  // self-heal evicted gear (clear dnd5e equipped + prune the flag). When a GM is online the
  // GM's sheet-independent ahReconcileEquip handles this; this sheet-side path only fires when
  // NO GM is on, and then only on the single authority owner — so viewers never duplicate writes.
  if (ctx.canArrange && !ahAnyActiveGM() && ahIsWriteAuthority(actor)) {
    let savedEq = {}; try { savedEq = actor.getFlag(MOD, "ahEquip") || {} } catch {}
    const savedIds = new Set([...Object.keys(savedEq.worn || {}), ...(Array.isArray(savedEq.back) ? savedEq.back : [])])
    const nowIds = new Set(ahEquippedIds(ctx))
    let changed = savedIds.size !== nowIds.size
    for (const id of savedIds) if (!nowIds.has(id)) { changed = true; const it = actor.items.get(id); if (it && it.system && ("equipped" in it.system) && it.system.equipped) { try { it.update({ "system.equipped": false }) } catch {} } }
    if (changed) ahSaveEquip(ctx)
  }
  const wornSet = new Set(ahEquippedIds(ctx))
  // expand each NON-worn item into bag UNITS: a bundled stackable becomes N separate
  // slot-fillers (uid "itemId#k"); everything else is one unit (uid === itemId).
  for (const it of items) {
    if (wornSet.has(it.id)) continue
    const real = actor.items.get(it.id)
    const bi = real ? ahBundleInfo(real, cfg) : { active: false, count: 1 }
    if (bi.active && bi.count > 1) {
      ctx.bundleN[it.id] = bi.count
      const qty = it.qty || 1
      for (let k = 0; k < bi.count; k++) {
        const uid = it.id + "#" + k
        const u = { uid, id: uid, itemId: it.id, name: it.name, img: it.img, uses: it.uses, color: it.color, shape: bi.perShape, spaces: bi.per, bundleIdx: k, bundleCount: bi.count, bundleQty: Math.min(bi.size, qty - k * bi.size) }
        ctx.units.push(u); ctx.unitById[uid] = u
      }
    } else {
      ctx.bundleN[it.id] = 1
      const u = { uid: it.id, id: it.id, itemId: it.id, name: it.name, img: it.img, uses: it.uses, color: it.color, shape: it.shape, spaces: it.spaces }
      ctx.units.push(u); ctx.unitById[u.uid] = u
    }
  }
  // the bag exists ONLY when a container is equipped; size = per-container slots × #containers
  const containerN = ahEquippedIds(ctx).filter(id => metaById[id] && metaById[id].carryType === "Container").length
  const baseBag = (containerN > 0 ? capacity * containerN : 0) + ahGearStorage(actor)   // containers + add-on storage gear
  const bagCapacity = baseBag > 0 ? baseBag + ahStrBonus(actor, cfg) : 0                // Strength upgrades a bag you actually have
  ctx.bagCapacity = bagCapacity
  const vc = ahValidCells(bagCapacity); ctx.validList = vc.list; ctx.validSet = vc.set; ctx.geom = ahGeom(bagCapacity)
  // SEPARATE bag mode: one mini-grid per container. Only when the toggle is on AND the actor has a
  // bag — otherwise ctx.separate stays false and every separate-mode branch below is skipped.
  ctx.separate = false
  // SEPARATE is the only mode now (one mini hex-grid per container) — the Merged single-pool bag
  // was removed at the user's request. Merged code below stays reachable only as a safety fallback
  // if an actor has a bag but somehow yields no bins (shouldn't happen: a bag needs a container).
  if (bagCapacity > 0) {
    ctx.bins = ahSepBins(ctx); ctx.binById = {}; for (const b of ctx.bins) ctx.binById[b.binId] = b
    if (ctx.bins.length) { ctx.separate = true; ctx.binHolders = {}; ctx.binCards = {}; ctx.binCapEls = {} }
  }
  // WORN-ONLY (binding): hide items dnd5e has inside a container we're NOT wearing (no it: bin).
  // They stay safe in that container and are managed on the normal sheet; AH never shows or touches
  // them, so it can't accidentally pull them out. Runs after bins exist (binById needed).
  if (ctx.separate && ahBinding(ctx)) ctx.units = ctx.units.filter(u => { if (!ahInUnmanagedContainer(ctx, u.itemId)) return true; delete ctx.unitById[u.uid]; return false })
  let savedPlace = {}; try { savedPlace = actor.getFlag(MOD, ctx.separate ? "ahPlaceSep" : "ahPlace") || {} } catch {}
  ctx.placed = ctx.separate ? ahBuildSepPlaced(ctx) : ahBuildPlaced(actor, ctx.unitById, vc.set)   // worn items have no unit → never packed
  { const drop = []; ctx.placed.forEach((p, id) => { if (!ahCanBag(ctx, id)) drop.push(id) }); for (const id of drop) ctx.placed.delete(id) }   // worn-only gear can't stay packed
  // self-heal: if the live placements differ from the stored flag (worn-only gear removed, a bin
  // disappeared, or orphaned bundle uids after a quantity drop / item delete), persist the pruned
  // set so stale keys can't accumulate or silently revive when a uid reappears. Owner only.
  // SEPARATE: compare the DESIRED flag (gr:/str only when binding — it: membership lives in
  // system.container, not the flag) to the saved flag, so binding never triggers a render loop.
  let needHeal
  if (ctx.separate) { const want = ahSepAssignObj(ctx), wk = Object.keys(want), sk = Object.keys(savedPlace); needHeal = wk.length !== sk.length || wk.some(k => !ahSepEntryEq(want[k], savedPlace[k])) }   // ahSepEntryEq, not !==: entries can be {bin,col,row,rot} objects (a new ref each build → would loop)
  else needHeal = ctx.placed.size !== Object.keys(savedPlace).length
  if (ctx.canArrange && !ahAnyActiveGM() && ahIsWriteAuthority(actor) && needHeal) ahPersistPlace(ctx)

  // counts + space totals (overflow = baggable load that exceeds the bag)
  const wornN = Object.keys(ctx.worn).length + ctx.back.length
  let packedN = 0; ctx.placed.forEach(p => { if (!(p && p.of)) packedN++ })   // overflow markers aren't "packed"
  const looseN = ctx.units.filter(u => { const p = ctx.placed.get(u.uid); return !p || p.of }).length
  // bag load = bag units that actually belong in the bag (baggable + not exempt).
  let nonWornSpaces = 0
  for (const u of ctx.units) { const m = metaById[u.itemId] || {}; if (m.ignoreSlot || m.baggable === false) continue; nonWornSpaces += (Number(u.spaces) || 0) }
  nonWornSpaces = Math.round(nonWornSpaces * 100) / 100
  const overflowPts = bagCapacity > 0 ? Math.max(0, Math.round((nonWornSpaces - bagCapacity) * 100) / 100) : 0
  const over = overflowPts > 0
  const meterPct = bagCapacity > 0 ? Math.min(100, Math.round((nonWornSpaces / bagCapacity) * 100)) : 0

  const wrap = document.createElement("div")
  wrap.className = "ah-panel" + (over ? " is-over" : "")
  // a broken/missing item image (rare — Foundry assigns a default) → drop it so the fallback slot
  // icon shows. Capturing listener (error doesn't bubble) on the panel root covers every art img.
  wrap.addEventListener("error", (e) => { const t = e.target; if (t && t.tagName === "IMG" && t.classList && t.classList.contains("ah-art-img")) t.remove() }, true)
  wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", "Anti-Hammer Space")
  // no on-sheet title/stat header or GM capacity input — the maroon Body/Bag bands label the panel,
  // and bag capacity + item rules are edited in the app's TTRPG Rules tool

  // ── stacked zones: Body · Bag · Loose — each a clear header (replaces the gray eyebrows) ──
  const mkSec = (iconName, zoneCls, label, metaTxt) => {
    const s = document.createElement("div"); s.className = "ah-sec" + (zoneCls ? " " + zoneCls : "")   // zone class drives the icon hue (no inline style)
    s.innerHTML = '<span class="ah-sec-h"><span class="ah-sec-i">' + ahIcon(iconName) + "</span>" + ahEscX(label) + (metaTxt ? ' <span class="ah-sec-meta">' + ahEscX(metaTxt) + "</span>" : "") + '</span><span class="ah-sec-rule"></span><span class="ah-sec-ctl"></span>'
    return { sec: s, ctl: s.querySelector(".ah-sec-ctl") }
  }

  // BODY — game-panel doll (figure framed by named gear boxes) + Suit up / Strip / Outfits
  const bodySec = mkSec("clothes", "ah-sec-body", "Body", "")   // no "· N worn" — keeps Suit up/Strip/Outfits on the header line
  if (ctx.canArrange) {
    const suit = document.createElement("button"); suit.type = "button"; suit.className = "ah-act"; suit.innerHTML = ahIcon("spark") + " Suit up"; suit.title = "Auto-equip clothes, armor & packs (not weapons)"
    suit.addEventListener("click", (e) => { e.stopPropagation(); ahSuitUp(ctx) })
    const strip = document.createElement("button"); strip.type = "button"; strip.className = "ah-ghostbtn"; strip.textContent = "Strip"; strip.title = "Unequip everything to loose"
    strip.addEventListener("click", (e) => { e.stopPropagation(); ahStripAll(ctx) })
    const outf = document.createElement("button"); outf.type = "button"; outf.className = "ah-ghostbtn"; outf.innerHTML = "Outfits " + ahIcon("caret"); outf.title = "Saved outfits — apply, save, delete"
    outf.addEventListener("click", (e) => { e.stopPropagation(); ahOpenOutfitMenu(ctx, bodySec.ctl, outf) })
    bodySec.ctl.appendChild(suit); bodySec.ctl.appendChild(strip); bodySec.ctl.appendChild(outf)
  }
  // a "fit" wrapper holds Body+Bag+Loose at natural size; if the sheet gets too narrow to show them
  // all, ahFitScaleEl scales the whole block down uniformly (so the 3 sections stay synced) to fit.
  const fit = document.createElement("div"); fit.className = "ah-fit"
  const fitInner = document.createElement("div"); fitInner.className = "ah-fit-inner"
  fit.appendChild(fitInner); wrap.appendChild(fit)
  // Body + Bag sit SIDE BY SIDE; each zone is a shrink-to-content wrapper so its header band spans only
  // that section's content width, with a vertical rule on the right edge that hugs the last item.
  const zonesRow = document.createElement("div"); zonesRow.className = "ah-zones-row"; fitInner.appendChild(zonesRow)
  const bodyZone = document.createElement("div"); bodyZone.className = "ah-zone ah-zone-body"; zonesRow.appendChild(bodyZone)
  bodyZone.appendChild(bodySec.sec)
  const dollEl = document.createElement("div"); dollEl.className = "ah-doll"; ctx.dollEl = dollEl; bodyZone.appendChild(dollEl)

  // BAG — header carries the spaces readout + Tidy + (separate) Add; content below
  const bagMetaTxt = bagCapacity > 0 ? (ahFmt(nonWornSpaces) + " / " + ahFmt(bagCapacity)) : "no storage"   // keep it short so the band stays as narrow as the grids
  const bagSec = mkSec("back", "ah-sec-bag", "Bag", "· " + bagMetaTxt)
  if (isGM) {   // GM-only quick toggle for the experimental dnd5e-container binding (also in Module Settings)
    const cur = ahBinding(ctx)
    const bind = document.createElement("button"); bind.type = "button"; bind.className = "ah-ghostbtn" + (cur ? " on" : ""); bind.setAttribute("aria-pressed", cur ? "true" : "false")
    bind.innerHTML = ahIcon(cur ? "check" : "stack") + (cur ? " Linked" : " Link to sheet")
    bind.title = cur ? "Bag grids ARE linked to dnd5e's real containers (experimental). Click to unlink (reverts to Anti-Hammer's own bins)." : "Link bag grids to dnd5e's real containers (experimental). Click to enable; try it on one character."
    bind.addEventListener("click", (e) => { e.stopPropagation(); try { game.settings.set(MOD, "ahBindContainers", !cur) } catch (err) { console.warn("[pendant-bridge] AH bind toggle failed", err) } })
    bagSec.ctl.appendChild(bind)
  }
  if (ctx.canArrange) {
    if (bagCapacity > 0) {
      const tidy = document.createElement("button"); tidy.type = "button"; tidy.className = "ah-act"; tidy.innerHTML = ahIcon("spark") + " Tidy"; tidy.title = "Auto-pack your loose items into the bag"
      tidy.addEventListener("click", (e) => { e.stopPropagation(); if (ctx.separate) { ahApplyAutoPackSep(ctx) } else { ctx.placed = ahAutoPack(ctx); ahSavePlace(ctx.actor, ahPlaceObj(ctx)) } })   // setFlag/updateItem re-renders the whole panel with consistent counts
      bagSec.ctl.appendChild(tidy)
    }
    const add = document.createElement("button"); add.type = "button"; add.className = "ah-ghostbtn"; add.innerHTML = ahIcon("plus") + " Add"; add.title = "Add a belt, backpack, pouch…"
    add.addEventListener("click", (e) => { e.stopPropagation(); ahOpenGearMenu(actor, bagSec.ctl, add) })
    bagSec.ctl.appendChild(add)
  }
  const bagZone = document.createElement("div"); bagZone.className = "ah-zone ah-zone-bag"; zonesRow.appendChild(bagZone)
  bagZone.appendChild(bagSec.sec)

  const bagCol = document.createElement("div"); bagCol.className = "ah-bagcol"
  if (bagCapacity > 0) {
    if (over) { const ob = document.createElement("div"); ob.className = "ah-overflow"; ob.innerHTML = "<b>Over capacity</b> — " + ahFmt(overflowPts) + " overflow point" + (overflowPts === 1 ? "" : "s"); bagCol.appendChild(ob) }
    const meter = document.createElement("div"); meter.className = "ah-meter" + (over ? " over" : (meterPct >= 100 ? " full" : ""))
    const fill = document.createElement("div"); fill.className = "ah-meter-fill"; fill.style.width = meterPct + "%"; meter.appendChild(fill); bagCol.appendChild(meter)
    if (ctx.separate) {
      // one labelled mini hex-grid per bin; drop an item onto a card to assign it there
      const bins = document.createElement("div"); bins.className = "ah-bins"; ctx.binsEl = bins
      for (const bin of ctx.bins) {
        const card = document.createElement("div"); card.className = "ah-bin" + (bin.kind === "str" ? " str" : ""); card.setAttribute("data-bin", bin.binId); ctx.binCards[bin.binId] = card
        const bh = document.createElement("div"); bh.className = "ah-bin-head"
        const tlabel = bin.types ? (bin.types.length > 1 ? bin.types[0] + " +" + (bin.types.length - 1) : bin.types[0]) : ""
        const nativeCap = (ahBinding(ctx) && bin.kind === "container") ? ahNativeCapLabel(ctx, bin.binId.slice(3)) : ""   // real dnd5e capacity (display-only)
        const capSpan = document.createElement("span"); capSpan.className = "ah-bin-cap"; ctx.binCapEls[bin.binId] = capSpan
        bh.innerHTML = '<i class="ah-bin-sw" style="background:' + bin.color + '"></i><span class="ah-bin-nm">' + ahEscX(bin.label) + "</span>" + (nativeCap ? '<span class="ah-bin-native" title="dnd5e container capacity">' + ahEscX(nativeCap) + "</span>" : "") + (bin.types ? '<span class="ah-bin-types" title="' + ahEscX("Holds only: " + bin.types.join(", ")) + '">' + ahEscX(tlabel) + "</span>" : "")
        bh.appendChild(capSpan)
        if (ctx.canArrange && bin.kind !== "str") {   // remove this container/gear (str bin has nothing to remove)
          const bx = document.createElement("button"); bx.type = "button"; bx.className = "ah-bin-x"; bx.textContent = "×"
          bx.title = bin.kind === "container" ? "Unequip" : "Remove"; bx.setAttribute("aria-label", (bin.kind === "container" ? "Unequip " : "Remove ") + bin.label)
          bx.addEventListener("click", (e) => {
            e.stopPropagation()
            if (bin.kind === "container") ahUnequip(ctx, bin.binId.slice(3))
            else { const gid = bin.binId.slice(3); Promise.resolve(actor.setFlag(MOD, "ahGear", ahGearList(actor).filter(z => z.id !== gid))).catch(() => {}) }
          })
          bh.appendChild(bx)
        }
        card.appendChild(bh)
        const grid = document.createElement("div"); grid.className = "ah-bin-grid"; ctx.binHolders[bin.binId] = grid; card.appendChild(grid)
        bins.appendChild(card)
      }
      bagCol.appendChild(bins)
      if (ctx.canArrange) bins.addEventListener("mousedown", (e) => { const t = e.target.closest("[data-item]"); if (t) ahDragItem(ctx, t.getAttribute("data-item"), "bag", e) })
    } else {
      const scroll = document.createElement("div"); scroll.className = "ah-scroll"
      const holder = document.createElement("div"); holder.className = "ah-svgholder"; ctx.holder = holder; scroll.appendChild(holder); bagCol.appendChild(scroll)
    }
    const legend = document.createElement("div"); legend.className = "ah-legend"; ctx.legendEl = legend; bagCol.appendChild(legend)
    if (ctx.canArrange) legend.addEventListener("click", (e) => { const u = e.target.closest("[data-use]"); if (u) { e.stopPropagation(); ahUseItem(actor, u.getAttribute("data-use")); return } const p = e.target.closest("[data-unpack]"); if (p) { e.stopPropagation(); ahUnplaceItem(ctx, p.getAttribute("data-unpack")) } })
  } else {
    const hint = document.createElement("div"); hint.className = "ah-bag-empty"; hint.textContent = ctx.canArrange ? "No storage yet — use + Add (or equip a backpack) to start a bag." : "No storage."; bagCol.appendChild(hint)
  }
  // containers / gear chips. MERGED: the full list (the only place they're shown). SEPARATE: each
  // bin already IS its storage container, so here we only list gear that has no bin (sheaths /
  // slings / a plain belt) so it stays removable — no double-listing of packs/pouches.
  const catalog = ahGearCatalog()
  const gearList = ahGearList(actor)
  const contItems = ahEquippedIds(ctx).filter(id => metaById[id] && metaById[id].carryType === "Container")
  const gearChip = (g) => {
    const cat = catalog[g.kind]; if (!cat) return null
    const bits = ahGearBits(cat)
    const chip = document.createElement("span"); chip.className = "ah-cont-chip gear"
    chip.innerHTML = ahEscX(cat.name) + (bits.length ? ' <span class="ah-gear-n">' + ahEscX(bits.join(" · ")) + "</span>" : "")
    if (ctx.canArrange) { const x = document.createElement("button"); x.type = "button"; x.className = "ah-gear-x"; x.textContent = "×"; x.title = "Remove"; x.setAttribute("aria-label", "Remove " + cat.name); x.addEventListener("click", async () => { try { await actor.setFlag(MOD, "ahGear", ahGearList(actor).filter(z => z.id !== g.id)) } catch (e) { console.warn("[pendant-bridge] AH gear remove failed", e) } }); chip.appendChild(x) }
    return chip
  }
  if (ctx.separate) {
    const nonBin = gearList.filter(g => catalog[g.kind] && !(Number(catalog[g.kind].storage) > 0))
    if (nonBin.length) {
      const cw = document.createElement("div"); cw.className = "ah-cont"
      const lbl = document.createElement("span"); lbl.className = "ah-gear-lbl"; lbl.textContent = "Also worn"; cw.appendChild(lbl)
      const row = document.createElement("div"); row.className = "ah-cont-row"
      for (const g of nonBin) { const c = gearChip(g); if (c) row.appendChild(c) }
      cw.appendChild(row); bagCol.appendChild(cw)
    }
  } else {
    const cw = document.createElement("div"); cw.className = "ah-cont"
    const lbl = document.createElement("span"); lbl.className = "ah-gear-lbl"; lbl.textContent = "Containers & storage"; cw.appendChild(lbl)
    const row = document.createElement("div"); row.className = "ah-cont-row"
    for (const id of contItems) {
      const it = byId[id]; if (!it) continue
      const chip = document.createElement("span"); chip.className = "ah-cont-chip worn"
      chip.innerHTML = '<i class="ah-cont-sw" style="background:' + it.color + '"></i>' + ahEscX(it.name) + ' <span class="ah-gear-n">+' + ahFmt(capacity) + " bag</span>"
      if (ctx.canArrange) { const x = document.createElement("button"); x.type = "button"; x.className = "ah-gear-x"; x.textContent = "×"; x.title = "Unequip"; x.setAttribute("aria-label", "Unequip " + it.name); x.addEventListener("click", (e) => { e.stopPropagation(); ahUnequip(ctx, id) }); chip.appendChild(x) }
      row.appendChild(chip)
    }
    for (const g of gearList) { const c = gearChip(g); if (c) row.appendChild(c) }
    if (!contItems.length && !gearList.length) { const e = document.createElement("span"); e.className = "ah-gear-empty"; e.textContent = ctx.canArrange ? "None — use + Add above." : "None."; row.appendChild(e) }
    cw.appendChild(row); bagCol.appendChild(cw)
  }
  bagZone.appendChild(bagCol)

  // LOOSE — the not-worn-or-packed tray
  const looseMeta = looseN ? ("· " + looseN + (ctx.canArrange ? " · drag to the body or a container" : "")) : (ctx.canArrange ? "· all worn or packed" : "")
  const looseSec = mkSec("stack", "ah-sec-loose", "Loose", looseMeta)
  fitInner.appendChild(looseSec.sec)
  const trayEl = document.createElement("div"); trayEl.className = "ah-tray-chips"; ctx.trayEl = trayEl; fitInner.appendChild(trayEl)

  // floating drag label
  const ghost = document.createElement("div"); ghost.className = "ah-ghost"; ghost.style.display = "none"; ctx.ghostEl = ghost; wrap.appendChild(ghost)

  if (ctx.canArrange) {
    trayEl.addEventListener("mousedown", (e) => { if (e.target.closest("[data-use]")) return; const t = e.target.closest("[data-tray]"); if (t) ahDragItem(ctx, t.getAttribute("data-tray"), "tray", e) })
    trayEl.addEventListener("click", (e) => {
      const cat = e.target.closest(".ah-tcat")
      if (cat) {   // toggle a category pill → show/hide its items inline (state persists across re-renders)
        const g = cat.getAttribute("data-cat"); const set = _ahTrayOpen[actor.id] || (_ahTrayOpen[actor.id] = new Set())
        const nowOpen = !set.has(g); if (nowOpen) set.add(g); else set.delete(g)
        cat.classList.toggle("open", nowOpen); cat.setAttribute("aria-expanded", nowOpen ? "true" : "false")
        trayEl.querySelectorAll(".ah-tray-it").forEach(it => { if (it.getAttribute("data-cat") === g) it.classList.toggle("collapsed", !nowOpen) })
        return
      }
      const u = e.target.closest("[data-use]"); if (u) { e.stopPropagation(); ahUseItem(actor, u.getAttribute("data-use")) }
    })
    trayEl.addEventListener("keydown", (e) => { if (e.key !== "Enter" && e.key !== " ") return; if (e.target.closest("[data-use]")) return; const t = e.target.closest("[data-tray]"); if (t) { e.preventDefault(); ahStowItem(ctx, t.getAttribute("data-tray")) } })   // keyboard stow
    if (ctx.holder) ctx.holder.addEventListener("mousedown", (e) => { const t = e.target.closest("[data-item]"); if (t) ahDragItem(ctx, t.getAttribute("data-item"), "bag", e) })
    dollEl.addEventListener("click", (e) => {
      if (e.target.closest(".ah-pickmenu")) return   // events inside an open picker are the menu's own
      const dr = e.target.closest("[data-draw]"); if (dr) { e.preventDefault(); e.stopPropagation(); ahDrawSheathe(ctx, dr.getAttribute("data-draw")); return }
      const rm = e.target.closest("[data-rm]"); if (rm) { e.preventDefault(); e.stopPropagation(); ahUnequip(ctx, rm.getAttribute("data-rm")); return }
      const pk = e.target.closest("[data-pick]"); if (pk) { e.preventDefault(); e.stopPropagation(); ahOpenSlotMenu(ctx, pk.getAttribute("data-pick"), pk) }
    })
    dollEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return
      if (e.target.closest(".ah-pickmenu")) return   // don't let a menuitem keydown bubble up and re-open the picker
      if (e.target.closest("[data-rm]")) return   // a dot/remove button activates itself — don't ALSO open the add picker for the Back box it sits in
      const pk = e.target.closest("[data-pick]"); if (pk && pk.getAttribute("role") === "button") { e.preventDefault(); ahOpenSlotMenu(ctx, pk.getAttribute("data-pick"), pk) }   // role=button slot DIVs only (native buttons self-fire)
    })
  }
  ahRenderDoll(ctx); ahRenderBoard(ctx); ahRenderTray(ctx)

  // (the on-sheet GM "Tune items" panel was removed — item size/type/spaces/slots are edited in the
  // app's TTRPG Rules → Anti-Hammer tool)

  ahFitObserve(fit)   // scale the Body/Bag/Loose block down to fit when the sheet is too narrow
  return wrap
}

// ── fit-to-width: when the sheet is too narrow to show Body+Bag (+Loose) at full size, scale the
//    whole block down UNIFORMLY (all three sections synced) to the largest scale that still fits,
//    instead of clipping or scrolling. CSS can't do this, so a ResizeObserver drives a transform. ──
let _ahFitObs = null
const _ahFitEls = new Set()
function ahFitScaleEl(fit) {
  try {
    if (!fit || !fit.isConnected) return
    const inner = fit.querySelector(".ah-fit-inner"); if (!inner) return
    const avail = fit.clientWidth
    // React to WIDTH changes only. Skip the same width (the height we set below would re-fire the
    // observer) AND a 2-cycle: setting the height can toggle the sheet's vertical scrollbar, which
    // bounces the available width between two values — settle instead of oscillating forever.
    if (avail <= 0 || avail === fit._ahW1 || avail === fit._ahW2) return
    fit._ahW2 = fit._ahW1; fit._ahW1 = avail
    // measure the natural (unscaled) width of the side-by-side zones at full size
    inner.style.width = ""; inner.style.transform = "none"; fit.style.height = ""
    const zones = inner.querySelector(".ah-zones-row")
    const natural = Math.max(inner.scrollWidth, zones ? zones.scrollWidth : 0)
    let scale = (natural > avail) ? avail / natural : 1
    if (scale < 0.3) scale = 0.3
    if (scale < 1) {
      inner.style.width = Math.ceil(natural) + "px"   // give the content its full width (Loose wraps at this width), then shrink it visually to fit
      inner.style.transform = "scale(" + scale + ")"
      fit.style.height = Math.ceil(inner.scrollHeight * scale) + "px"   // collapse the box to the scaled height (no gap below)
    }
  } catch (e) { console.warn("[pendant-bridge] AH fit-scale failed", e) }
}
function ahFitObserve(fit) {
  try {
    if (typeof ResizeObserver === "undefined") return
    if (!_ahFitObs) _ahFitObs = new ResizeObserver(es => { for (const e of es) ahFitScaleEl(e.target) })
    for (const el of _ahFitEls) if (!el.isConnected) { try { _ahFitObs.unobserve(el) } catch {} _ahFitEls.delete(el) }   // drop panels that were rebuilt/removed
    fit._ahW1 = -1; fit._ahW2 = -1; _ahFitEls.add(fit); _ahFitObs.observe(fit)
    requestAnimationFrame(() => ahFitScaleEl(fit))   // initial pass once laid out
  } catch (e) { console.warn("[pendant-bridge] AH fit-observe failed", e) }
}

function ahInjectPanel(app, html) {
  const actor = app?.actor || (app?.document?.documentName === "Actor" ? app.document : null)
  if (!actor) return
  if (actor.type === "group" || actor.type === "party") return   // containers of actors, not carriers
  // Don't rebuild this actor's panel out from under an in-progress drag — defer until it ends.
  if (_ahDrag.active && _ahDrag.actorId === actor.id) { _ahDrag.missed = true; return }
  const root = (html instanceof HTMLElement) ? html : (html && html[0]) ? html[0] : null
  if (!root || typeof root.querySelector !== "function") return
  // A re-render replaces sheet content, but ApplicationV2 can patch in place —
  // clear any prior panel first so we never stack duplicates.
  root.querySelectorAll(".ah-panel").forEach(n => n.remove())
  // ONLY the INVENTORY tab — its CONTENT panel, never the nav link and never the
  // always-visible sheet body (which would show the bag on every tab). If a sheet
  // has no recognizable inventory tab we inject nothing rather than bleed elsewhere.
  const host = ahInventoryHost(root)
  if (!host) return
  let panel
  try { panel = ahBuildPanel(actor) } catch (e) { console.warn("[pendant-bridge] AH panel build failed", e); return }
  host.insertBefore(panel, host.firstChild)
}
/** Find the actor sheet's INVENTORY tab content container (not the clickable nav tab). */
function ahInventoryHost(root) {
  for (const sel of ['.tab[data-tab="inventory"]', 'section[data-tab="inventory"]',
    'div[data-tab="inventory"]', '.tab-body[data-tab="inventory"]', '.tab.inventory',
    '[data-tab-contents-for="inventory"]', '.tidy-tab.inventory']) {   // last two = Tidy5e (classic + quadrone)
    const el = root.querySelector(sel); if (el) return el
  }
  // last resort: any [data-tab="inventory"] that is a real content container —
  // skip <a>/nav items (the clickable tab) and anything without children.
  for (const el of root.querySelectorAll('[data-tab="inventory"]')) {
    if (el.tagName === "A") continue
    if (/\b(item|control|nav|sheet-tabs)\b/i.test(el.getAttribute("class") || "")) continue
    if (el.children && el.children.length) return el
  }
  return null
}

/** Re-render open Actor sheets so a rule/capacity change shows live. */
function ahRerenderSheets() {
  try { for (const w of Object.values(ui.windows || {})) { const d = w?.document || w?.actor; if (d?.documentName === "Actor" && typeof w.render === "function") w.render(false) } } catch {}
  try { const inst = foundry?.applications?.instances; if (inst?.values) for (const a of inst.values()) { const d = a?.document || a?.actor; if (d?.documentName === "Actor" && typeof a.render === "function") a.render(false) } } catch {}
}

// ──────────────────────────────────────────────────────────────
// World-map grid overlay (driven by the COA World Map tool)
// ──────────────────────────────────────────────────────────────
// The app pushes a FLATTENED grid (overlay.set) which we store as a scene flag
// and draw on the canvas, aligned to the scene background. Pure geometry below
// is a verbatim port of the app's grid math (gridGeom/cellCenter, 'center'
// origin for every flattened level) so the overlay reproduces the app exactly.
// Visibility: the GM can show it for themselves only (a client-local flag) or
// for EVERYONE (a scene flag that auto-syncs to every client). No socket needed.

const OVL_MAX_EFFDIV = 8000, OVL_SQRT3 = Math.sqrt(3)
const OVL_HEX_FLAT = [], OVL_HEX_POINT = []
for (let k = 0; k < 6; k++) {
  OVL_HEX_FLAT.push([Math.cos(k * Math.PI / 3), Math.sin(k * Math.PI / 3)])
  OVL_HEX_POINT.push([Math.cos((k * 60 - 90) * Math.PI / 180), Math.sin((k * 60 - 90) * Math.PI / 180)])
}
const ovlState = { layer: null, localShow: false }
let ovlRaf = 0

function ovlColor(hex, fallback) {
  if (typeof hex === "string") {
    let h = hex.replace("#", "")
    if (h.length === 3) h = h.split("").map(c => c + c).join("")
    const n = parseInt(h, 16)
    if (Number.isFinite(n)) return n
  }
  return fallback
}
// One flattened level's layout in scene coords. rect = the background rect
// {x0,y0,cw,ch}. Always centred origin (matches the app's draw loop).
function ovlGeom(shape, effDiv, offX, offY, rect) {
  const div = Math.max(1, Math.min(OVL_MAX_EFFDIV, Math.round(effDiv || 8)))
  const { x0, y0, cw, ch } = rect
  const ox = x0 + cw / 2 + (offX || 0) * cw, oy = y0 + ch / 2 + (offY || 0) * ch
  if (shape === "hex-h") { const r = cw / (1.5 * div + 0.5); return { shape, r, colStep: 1.5 * r, rowStep: OVL_SQRT3 * r, m: r, div, ox, oy } }
  if (shape === "hex-v") { const r = cw / (OVL_SQRT3 * (div + 0.5)); return { shape, r, colStep: OVL_SQRT3 * r, rowStep: 1.5 * r, m: r, div, ox, oy } }
  const cell = cw / div; return { shape: "square", cell, half: cell / 2, m: cell / 2, div, ox, oy }
}
function ovlCellCenter(g, i, j) {
  if (g.shape === "square") return { cx: g.ox + (i + 0.5) * g.cell, cy: g.oy + (j + 0.5) * g.cell }
  if (g.shape === "hex-h") return { cx: g.ox + i * g.colStep, cy: g.oy + j * g.rowStep + (i % 2 ? g.rowStep / 2 : 0) }
  return { cx: g.ox + i * g.colStep + (j % 2 ? g.colStep / 2 : 0), cy: g.oy + j * g.rowStep }
}
function ovlCellPoly(g, cx, cy) {
  if (g.shape === "square") { const h = g.half; return [cx - h, cy - h, cx + h, cy - h, cx + h, cy + h, cx - h, cy + h] }
  const offs = g.shape === "hex-h" ? OVL_HEX_FLAT : OVL_HEX_POINT, r = g.r, p = []
  for (let k = 0; k < 6; k++) p.push(cx + offs[k][0] * r, cy + offs[k][1] * r)
  return p
}

function ovlGetPayload(scene) { try { return scene?.getFlag(MOD, "overlay") || null } catch { return null } }
function ovlShared(scene) { try { return scene?.getFlag(MOD, "overlayShared") === true } catch { return false } }
function ovlVisible(scene) { return ovlShared(scene) || (game.user?.isGM && ovlState.localShow) }
function ovlParent() { return canvas?.interface || canvas?.stage || null }

function ovlEnsureLayer() {
  const parent = ovlParent(); if (!parent) return
  if (ovlState.layer && !ovlState.layer.destroyed && ovlState.layer.parent === parent) return
  if (ovlState.layer && !ovlState.layer.destroyed) { try { ovlState.layer.destroy({ children: true }) } catch {} }
  const layer = new PIXI.Container()
  try { layer.eventMode = "none" } catch {}        // never intercept clicks (PIXI v7 / Foundry v11+)
  try { layer.interactive = false } catch {}
  layer.interactiveChildren = false
  layer.zIndex = 9000                              // above tokens for guaranteed visibility; lower this to sit under tokens
  parent.sortableChildren = true
  parent.addChild(layer)
  ovlState.layer = layer
}

function ovlScheduleDraw() {
  if (ovlRaf) return
  ovlRaf = requestAnimationFrame(() => { ovlRaf = 0; try { ovlDraw() } catch (e) { console.warn("[pendant-bridge] overlay draw failed", e) } })
}

function ovlDraw() {
  ovlEnsureLayer()
  const layer = ovlState.layer; if (!layer) return
  for (const c of layer.removeChildren()) { try { c.destroy({ children: true }) } catch {} }
  const scene = canvas?.scene
  if (!scene || !canvas?.ready) return
  const payload = ovlGetPayload(scene)
  if (!payload || !Array.isArray(payload.levels) || !ovlVisible(scene)) return

  const dims = sceneDimensions(scene)
  const rect = { x0: dims.sceneX, y0: dims.sceneY, cw: dims.sceneWidth, ch: dims.sceneHeight }
  if (!(rect.cw > 0) || !(rect.ch > 0)) return
  const scale = canvas.stage?.scale?.x || 1
  const rx0 = rect.x0, ry0 = rect.y0, rx1 = rect.x0 + rect.cw, ry1 = rect.y0 + rect.ch
  // Visible window in scene coords (cull), clamped to the background rect.
  let vx0 = rx0, vy0 = ry0, vx1 = rx1, vy1 = ry1
  try {
    const scr = canvas.app.screen
    const a = canvas.stage.toLocal(new PIXI.Point(0, 0))
    const b = canvas.stage.toLocal(new PIXI.Point(scr.width, scr.height))
    vx0 = Math.max(rx0, Math.min(a.x, b.x)); vy0 = Math.max(ry0, Math.min(a.y, b.y))
    vx1 = Math.min(rx1, Math.max(a.x, b.x)); vy1 = Math.min(ry1, Math.max(a.y, b.y))
  } catch {}
  if (vx1 <= vx0 || vy1 <= vy0) return

  const g = new PIXI.Graphics()
  for (const lvl of payload.levels) {
    if (lvl.visible === false) continue
    const effDiv = Math.max(1, Math.min(OVL_MAX_EFFDIV, Math.round(lvl.effDiv || 8)))
    const screenCell = (rect.cw / effDiv) * scale
    if (screenCell < (lvl.revealPx || 4)) continue                       // LOD: too small → hide (zoom in to reveal)
    if (lvl.hidePx && lvl.hidePx > 0 && screenCell > lvl.hidePx) continue // upper zoom bound
    const geom = ovlGeom(lvl.shape, effDiv, lvl.offX, lvl.offY, rect)
    const m = geom.m
    // Terrain fills (under the gridlines), pre-resolved to hex colours by the app.
    const fop = Math.max(0, Math.min(1, lvl.fillOpacity == null ? 0.5 : lvl.fillOpacity))
    const fills = lvl.fills || {}
    if (fop > 0) {
      for (const key in fills) {
        const ci = key.indexOf(","); if (ci < 0) continue
        const i = +key.slice(0, ci), j = +key.slice(ci + 1)
        if (!Number.isFinite(i) || !Number.isFinite(j)) continue
        const c = ovlCellCenter(geom, i, j)
        if (c.cx < vx0 - m || c.cx > vx1 + m || c.cy < vy0 - m || c.cy > vy1 + m) continue
        const col = ovlColor(fills[key], null); if (col == null) continue
        g.beginFill(col, fop); g.drawPolygon(ovlCellPoly(geom, c.cx, c.cy)); g.endFill()
      }
    }
    // Gridlines: constant SCREEN thickness (÷scale) — matches the app.
    const lw = Math.max(0.25, Math.min(6, lvl.lineWidth || 1)) / scale
    g.lineStyle(lw, ovlColor(lvl.color, 0xffd166), Math.max(0, Math.min(1, lvl.opacity == null ? 0.6 : lvl.opacity)))
    if (geom.shape === "square") {
      const cell = geom.cell
      const iA = Math.ceil((vx0 - geom.ox) / cell), iB = Math.floor((vx1 - geom.ox) / cell)
      for (let i = iA; i <= iB; i++) { const x = geom.ox + i * cell; if (x < rx0 - 0.01 || x > rx1 + 0.01) continue; g.moveTo(x, vy0); g.lineTo(x, vy1) }
      const jA = Math.ceil((vy0 - geom.oy) / cell), jB = Math.floor((vy1 - geom.oy) / cell)
      for (let j = jA; j <= jB; j++) { const y = geom.oy + j * cell; if (y < ry0 - 0.01 || y > ry1 + 0.01) continue; g.moveTo(vx0, y); g.lineTo(vx1, y) }
    } else {
      const cs = geom.colStep, rs = geom.rowStep
      const iA = Math.floor((vx0 - geom.ox) / cs) - 2, iB = Math.ceil((vx1 - geom.ox) / cs) + 2
      const jA = Math.floor((vy0 - geom.oy) / rs) - 2, jB = Math.ceil((vy1 - geom.oy) / rs) + 2
      for (let i = iA; i <= iB; i++) for (let j = jA; j <= jB; j++) {
        const c = ovlCellCenter(geom, i, j)
        if (c.cx < vx0 - m || c.cx > vx1 + m || c.cy < vy0 - m || c.cy > vy1 + m) continue
        g.drawPolygon(ovlCellPoly(geom, c.cx, c.cy))
      }
    }
  }
  // Clip everything to the background rect (trims hex cells / off-image lines).
  const mask = new PIXI.Graphics(); mask.beginFill(0xffffff); mask.drawRect(rx0, ry0, rect.cw, rect.ch); mask.endFill()
  layer.addChild(g); layer.addChild(mask); g.mask = mask
}

// GM-only floating toggle (bottom-left, above the connection pill). Cycles
// Off → Just me → Everyone. Only shown when the active scene carries an overlay.
function ovlUpdateToggle() {
  const scene = canvas?.scene
  const has = !!(scene && ovlGetPayload(scene))
  let el = document.getElementById("pendant-bridge-overlay-toggle")
  if (!game.user?.isGM || !has) { if (el) el.remove(); return }
  if (!el) {
    el = document.createElement("div")
    el.id = "pendant-bridge-overlay-toggle"
    el.style.cssText = "position:fixed;left:8px;bottom:40px;z-index:60;padding:4px 9px;border-radius:6px;font:600 11px/1.2 sans-serif;cursor:pointer;user-select:none;border:1px solid;"
    el.addEventListener("click", ovlCycle)
    document.body.appendChild(el)
  }
  const state = ovlShared(scene) ? "all" : (ovlState.localShow ? "me" : "off")
  const skin = state === "all" ? ["rgba(20,46,28,0.9)", "rgba(110,200,140,0.6)", "#9fe6b6"]
    : state === "me" ? ["rgba(28,18,46,0.9)", "rgba(150,100,220,0.6)", "#d6bcff"]
    : ["rgba(24,24,30,0.85)", "rgba(140,140,160,0.4)", "#b9b9c6"]
  el.style.background = skin[0]; el.style.borderColor = skin[1]; el.style.color = skin[2]
  el.textContent = state === "all" ? "▦ Grid: everyone" : state === "me" ? "▦ Grid: just me" : "▦ Grid: off"
  el.title = "World-map grid overlay — click to cycle Off → Just me → Everyone"
}
async function ovlCycle() {
  const scene = canvas?.scene; if (!scene) return
  const state = ovlShared(scene) ? "all" : (ovlState.localShow ? "me" : "off")
  try {
    if (state === "off") ovlState.localShow = true
    else if (state === "me") { ovlState.localShow = true; if (game.user?.isGM) await scene.setFlag(MOD, "overlayShared", true) }
    else { ovlState.localShow = false; if (game.user?.isGM) await scene.unsetFlag(MOD, "overlayShared") }
  } catch (e) { console.warn("[pendant-bridge] overlay toggle failed", e) }
  ovlScheduleDraw(); ovlUpdateToggle()
}

function ovlInit() {
  Hooks.on("canvasReady", () => { ovlState.layer = null; ovlScheduleDraw(); ovlUpdateToggle() })
  Hooks.on("canvasPan", () => ovlScheduleDraw())
  Hooks.on("canvasTearDown", () => { ovlState.layer = null })
  Hooks.on("updateScene", (scene, changes) => {
    if (!scene?.active) return
    const flagged = changes && changes.flags && (MOD in changes.flags)
    const geomChg = changes && ("grid" in changes || "background" in changes || "width" in changes || "height" in changes || "padding" in changes)
    if (flagged || geomChg) { ovlScheduleDraw(); ovlUpdateToggle() }
  })
  if (canvas?.ready) { ovlScheduleDraw(); ovlUpdateToggle() }
}

// ──────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  bridge.reconcile()
  ovlInit()

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

  // Ammo auto-spend: when a ranged weapon is fired, spend a matching ammo if dnd5e didn't.
  // The attack hook is client-local (fires once, on the roller), so no cross-client de-dupe needed.
  for (const h of ["dnd5e.rollAttack", "dnd5e.rollAttackV2", "dnd5e.postRollAttackV2"]) {
    try { Hooks.on(h, function () { const it = ahAttackItem.apply(null, arguments); if (it) ahOnWeaponAttack(it) }) } catch (e) { console.warn("[pendant-bridge] AH attack hook " + h + " failed", e) }
  }

  ahRecomputeAll()   // seed/refresh every bag's stored state on boot (GM only)
  ahRerenderSheets()
})

// Expose for debugging from the Foundry console.
globalThis.PendantBridge = bridge
