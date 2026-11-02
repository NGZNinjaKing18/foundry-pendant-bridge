// scripts/music-panel.js — the RealmScreen music panel in the Playlists tab.
import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const settings = new Map()
const emitted = []
const users = { gm1: { name: "Dee", isGM: true, active: true }, p1: { name: "Ana", isGM: false, active: true } }
globalThis.game = {
  user: { id: "gm1", isGM: true },
  users: { some: () => true, get: (id) => users[id], filter: (f) => Object.entries(users).map(([id, u]) => ({ id, ...u })).filter(f) },
  settings: { register(m, k, c) { if (!settings.has(k)) settings.set(k, c.default) }, get(m, k) { return settings.get(k) }, async set(m, k, v) { settings.set(k, v) } },
  socket: { emit(ch, m) { emitted.push(m) }, on() {} },
}
globalThis.document = { querySelectorAll: () => [], activeElement: null }
globalThis.ui = { notifications: { warn() {}, info() {} } }
globalThis.window = { addEventListener() {} }
const live = await import("../scripts/live.js")
const music = await import("../scripts/music-panel.js")
const sent = []
music.setMusicSender((m) => { sent.push(m); return true })

const state = { tracks: [{ id: "a", name: "Tavern <b>", vol: 0.42, web: false, canPause: true }, { id: "w", name: "Radio", vol: 0.5, web: true, canPause: false, paused: false }], requests: [{ id: "r1", url: "https://youtu.be/x", user: "p1", userName: "Ana" }], auto: false }

test("players see the playing tracks but not the requests or the switch", () => {
  const p = music.panelHtml(state, { gm: false })
  assert.match(p, /Tavern &lt;b&gt;/)
  assert.match(p, /value="42"/)
  assert.doesNotMatch(p, /youtu\.be/)
  assert.doesNotMatch(p, /data-pbm="auto"/)
  const g = music.panelHtml(state, { gm: true })
  assert.match(g, /data-req="r1"/)
  assert.match(g, /data-pbm="auto"/)
  assert.match(music.panelHtml(null), /Nothing is playing/)
})

test("pause shows only where it works; the link button says what it does", () => {
  const p = music.panelHtml(state, { gm: false, me: "p1" })
  assert.equal((p.match(/data-pbm="pause"/g) || []).length, 1, "the web page that can't pause has no button")
  assert.match(p, /Ask GM/)
  assert.match(p, /Waiting for your GM/)
  assert.doesNotMatch(music.panelHtml(state, { gm: false, me: "p2" }), /Waiting for your GM/, "only your own requests")
  assert.match(music.panelHtml({ ...state, auto: true }, { gm: false }), /Play now/)
  assert.match(music.panelHtml(state, { gm: true }), /Play now/)
  const paused = music.panelHtml({ tracks: [{ id: "a", name: "T", vol: 0.5, paused: true }] })
  assert.match(paused, /data-pbm="play"/)
})

test("only the linked window forwards a player's action, naming who sent it", () => {
  const msg = { act: "stop", id: "a", aid: "x1" }
  assert.equal(music.onMusicSocket({ t: "music.do", msg, user: "p1" }, null), false, "not linked here")
  live.setLinked(true)
  assert.equal(music.onMusicSocket({ t: "music.do", msg, user: "p1" }, null), true)
  assert.deepEqual(sent.at(-1), { type: "music.do", act: "stop", id: "a", aid: "x1", user: "p1", userName: "Ana", isGM: false })
  // Foundry's own sender id wins over what the message says
  music.onMusicSocket({ t: "music.do", msg, user: "gm1" }, "p1")
  assert.equal(sent.at(-1).isGM, false)
})

test("RealmScreen's state reaches every client over the socket", () => {
  music.setMusicState(state)
  assert.deepEqual(emitted.at(-1), { t: "music.state", state })
})
