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
})

// ──────────────────────────────────────────────────────────────
// Connection
// ──────────────────────────────────────────────────────────────

const bridge = {
  ws: null,
  open: false,
  reconnectMs: 1000,
  reconnectTimer: null,
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
    let ws
    try { ws = new WebSocket(url) }
    catch (e) { console.warn("[pendant-bridge] WS construct failed:", e); this.scheduleReconnect(); return }
    this.ws = ws

    ws.addEventListener("open", () => {
      const token = game.settings.get(MOD, "token") || ""
      ws.send(JSON.stringify({
        type:  "hello",
        role:  "foundry",
        token,
        label: `${game.user.name}@${game.world?.id || "world"}`
      }))
    })

    ws.addEventListener("message", (ev) => this.handleMessage(ev.data))

    ws.addEventListener("close", () => {
      this.open = false
      updateIndicator(false)
      this.teardownHooks()
      this.scheduleReconnect()
    })

    ws.addEventListener("error", () => {
      try { ws.close() } catch {}
    })
  },

  disconnect() {
    this.open = false
    updateIndicator(false)
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null
    this.teardownHooks()
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
  },

  scheduleReconnect() {
    if (!game.settings.get(MOD, "enabled")) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs)
    this.reconnectMs = Math.min(this.reconnectMs * 2, 15000)
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
    if (msg.type === "hello:ok") {
      this.open = true
      this.reconnectMs = 1000
      updateIndicator(true)
      this.setupHooks()
      ui.notifications?.info(game.i18n.localize("PENDANT-BRIDGE.notif.connected"))
      // Send an initial snapshot so the client can render immediately.
      this.send({ type: "state", state: snapshotState() })
      return
    }
    if (msg.type === "hello:error") {
      ui.notifications?.error(`Pendant Bridge: ${msg.reason || "auth failed"}`)
      return
    }
    handleCommand(msg).catch(err => {
      console.warn("[pendant-bridge] command failed:", msg.type, err)
      this.reply(msg.reqId, { type: "error", reason: err?.message || String(err) })
    })
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
  },

  teardownHooks() {
    while (this.hookOffs.length) { try { this.hookOffs.pop()() } catch {} }
    this.pendingHooks = false
  }
}

// ──────────────────────────────────────────────────────────────
// Snapshot / serialization helpers
// ──────────────────────────────────────────────────────────────

function snapshotState() {
  return {
    user:  { id: game.user.id, name: game.user.name, isGM: game.user.isGM },
    world: { id: game.world?.id, title: game.world?.title, system: game.system?.id },
    system: { id: game.system?.id, version: game.system?.version },
    actors:  game.actors.map(serializeActorLight),
    recentChat: game.messages.contents.slice(-50).map(serializeChat)
  }
}

function serializeActorLight(actor) {
  return {
    id:      actor.id,
    name:    actor.name,
    type:    actor.type,
    img:     actor.img,
    hp:      readHP(actor),
    ownership: actor.ownership,
    folder:  actor.folder?.id || null
  }
}

/** Full actor data — includes items + system data. Use sparingly. */
function serializeActorFull(actor) {
  const data = actor.toObject(false)
  return {
    id:    actor.id,
    name:  actor.name,
    type:  actor.type,
    img:   actor.img,
    hp:    readHP(actor),
    system: data.system,
    items: actor.items.map(serializeItem),
    effects: actor.effects.map(e => ({ id: e.id, name: e.name, icon: e.icon, disabled: e.disabled })),
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
    img:    item.img,
    system: data.system,
    flags:  data.flags
  }
}

function serializeChat(msg) {
  return {
    id:      msg.id,
    user:    msg.user?.id ?? msg.author?.id ?? null,
    speaker: msg.speaker,
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
    combatants: c.combatants.map(cb => ({
      id: cb.id, actorId: cb.actorId, name: cb.name, initiative: cb.initiative,
      hidden: cb.hidden, defeated: cb.defeated
    }))
  }
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
      await r.evaluate({ async: true })
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
// Boot
// ──────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  bridge.reconcile()
})

// Expose for debugging from the Foundry console.
globalThis.PendantBridge = bridge
