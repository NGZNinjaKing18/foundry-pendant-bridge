// End-to-end test of the file sorter against a fake Foundry (in-memory files,
// documents, compendiums, settings). Loads the REAL scripts/main.js with the
// Foundry globals mocked, plans with the REAL RealmScreen planner when it sits
// next to this repo, and — the point — crashes the run at every save and every
// upload, resumes it, and proves no link ever pointed at a missing or shrunk
// file and every moved file is byte-identical to its original.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const ORIGIN = "https://vtt.test"
const ROOT = "Chronicles of Albuna"
const enc = (s) => new TextEncoder().encode(s)
const decodeKey = (p) => { let s = String(p).replace(/[?#].*$/, "").replace(/^\/+/, ""); try { s = decodeURIComponent(s) } catch {} return s }
const encodeKey = (k) => k.split("/").map(encodeURIComponent).join("/")

// ── the fake Foundry ──────────────────────────────────────────
function makeFoundry() {
  const files = new Map()        // key → Uint8Array
  const dirs = new Set([""])
  const addDirs = (key) => { const parts = key.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")) }
  const crash = { atSave: 0, atUpload: 0, saves: 0, uploads: 0 }
  const boom = () => { const e = new Error("SIMULATED CRASH"); e.crash = true; return e }

  class Doc {
    static metadata = { embedded: {} }
    constructor(data, { parent = null, pack = null } = {}) {
      this.id = data._id; this.parent = parent; this.pack = pack
      const emb = this.constructor.metadata.embedded
      this._own = structuredClone(Object.fromEntries(Object.entries(data).filter(([k]) => !Object.values(emb).includes(k))))
      for (const [name, field] of Object.entries(emb)) this[field] = new Coll(name, (data[field] || []).map(d => new (CLASSES[name])(d, { parent: this, pack })))
      this.updates = 0
    }
    get documentName() { return this.constructor.documentName }
    get name() { return this._own.name }
    get folder() { return this._own._folder || null }
    get actorId() { return this._own.actorId }
    get uuid() { return this.pack ? `Compendium.${this.pack}.${this.documentName}.${this.id}` : `${this.documentName}.${this.id}` }
    get _source() {
      const out = { ...this._own }
      delete out._folder
      for (const [, field] of Object.entries(this.constructor.metadata.embedded)) out[field] = [...this[field]].map(c => c._source)
      return out
    }
    async update(changes) {
      if (this.failUpdate) throw new Error("update refused")
      if (this.pack && FOUNDRY.packs.get(this.pack)?.locked) throw new Error("pack is locked")
      for (const [k, v] of Object.entries(changes)) {
        const parts = k.split("."); let o = this._own
        for (const p of parts.slice(0, -1)) o = (o[p] ??= {})
        o[parts.at(-1)] = structuredClone(v)
      }
      this.updates++
    }
  }
  const mk = (name, embedded = {}) => { const C = class extends Doc { static metadata = { embedded }; static documentName = name }; return C }
  const CLASSES = {
    Item: mk("Item"), ActiveEffect: mk("ActiveEffect"), Tile: mk("Tile"), Note: mk("Note"), AmbientSound: mk("AmbientSound"),
    JournalEntryPage: mk("JournalEntryPage"), PlaylistSound: mk("PlaylistSound"),
  }
  CLASSES.ActorDelta = mk("ActorDelta", { Item: "items" })
  CLASSES.Token = mk("Token", {})
  CLASSES.Actor = mk("Actor", { Item: "items", ActiveEffect: "effects" })
  CLASSES.Scene = mk("Scene", { Token: "tokens", Tile: "tiles", Note: "notes", AmbientSound: "sounds" })
  CLASSES.JournalEntry = mk("JournalEntry", { JournalEntryPage: "pages" })
  CLASSES.Playlist = mk("Playlist", { PlaylistSound: "sounds" })
  CLASSES.Folder = mk("Folder")
  CLASSES.Macro = mk("Macro")
  CLASSES.ChatMessage = mk("ChatMessage")

  class Coll {
    constructor(name, docs) { this.documentName = name; this.docs = docs }
    [Symbol.iterator]() { return this.docs[Symbol.iterator]() }
    values() { return this.docs.values() }
    get(id) { return this.docs.find(d => d.id === id) }
    get size() { return this.docs.length }
  }

  const settingsStore = new Map()
  const worldSettings = new Coll("Setting", [])
  const FilePicker = {
    async browse(source, target) {
      const t = decodeKey(target === "." ? "" : target)
      if (!dirs.has(t)) throw new Error("no such dir " + t)
      const pre = t ? t + "/" : ""
      const kids = (set) => [...set].filter(k => k.startsWith(pre) && k !== t && !k.slice(pre.length).includes("/"))
      return { target: t, dirs: kids(dirs).map(encodeKey), files: kids(new Set(files.keys())).map(encodeKey) }
    },
    async createDirectory(source, target) {
      const t = decodeKey(target)
      if (dirs.has(t)) throw new Error("EEXIST")
      dirs.add(t)
    },
    async upload(source, dir, file) {
      crash.uploads++
      if (crash.atUpload && crash.uploads === crash.atUpload) throw boom()
      const d = decodeKey(dir)
      if (!dirs.has(d)) throw new Error("upload: no dir " + d)
      const key = d ? d + "/" + file.name : file.name
      files.set(key, new Uint8Array(await file.arrayBuffer()))
      return { status: "success", path: encodeKey(key) }
    },
  }

  const FOUNDRY = { files, dirs, crash, CLASSES, Coll, packs: new Map() }
  const game = {
    version: "13.0",
    world: { id: "w", title: "Chronicles Of Albuna", background: "" },
    user: { isGM: true },
    collections: new Map(),
    packs: { get: (id) => FOUNDRY.packs.get(id), [Symbol.iterator]: () => FOUNDRY.packs.values() },
    settings: {
      register(mod, key, cfg) { if (!settingsStore.has(key)) settingsStore.set(key, structuredClone(cfg.default)) },
      get(mod, key) { return settingsStore.get(key) },
      async set(mod, key, v) {
        crash.saves++
        if (crash.atSave && crash.saves === crash.atSave) throw boom()
        settingsStore.set(key, structuredClone(v))
        // like Foundry: a world setting is a Setting document holding the JSON
        const doc = worldSettings.docs.find(d => d.key === `${mod}.${key}`)
        if (doc) doc.value = JSON.stringify(v); else worldSettings.docs.push({ key: `${mod}.${key}`, value: JSON.stringify(v) })
      },
      storage: new Map([["world", worldSettings]]),
    },
  }
  game.settings.register("pendant-bridge", "fileSortLedger", { default: {} })
  FOUNDRY.game = game
  FOUNDRY.worldSettings = worldSettings

  const all = () => {
    const out = []
    for (const c of game.collections.values()) out.push(...c)
    for (const p of FOUNDRY.packs.values()) out.push(...p.docs)
    return out
  }
  const globals = {
    Hooks: { once() {}, on() {} },
    game,
    CONST: { UPLOADABLE_FILE_EXTENSIONS: { webp: "image/webp", png: "image/png", jpg: "image/jpeg", mp3: "audio/mpeg", pdf: "application/pdf", json: "application/json", txt: "text/plain" } },
    foundry: {
      utils: { deepClone: (o) => structuredClone(o), getRoute: (p) => "/" + String(p).replace(/^\/+/, "") },
      abstract: { Document: Doc },
      applications: { apps: { FilePicker } },
    },
    window: { location: { origin: ORIGIN }, addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, createElement: () => ({ getContext: () => null }), getElementById: () => null, body: { appendChild() {} } },
    fromUuid: async (u) => all().find(d => d.uuid === u) || null,
    ui: { notifications: { info() {}, warn() {}, error() {} } },
    fetch: async (url) => {
      const key = decodeKey(String(url).startsWith(ORIGIN) ? String(url).slice(ORIGIN.length) : url)
      const b = files.get(key) ?? [...files.entries()].find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1]
      return b
        ? { ok: true, status: 200, arrayBuffer: async () => b.slice().buffer }
        : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    },
  }
  return { FOUNDRY, globals, game }
}

// Load the real main.js with the mocks as globals, exposing the sorter functions.
async function loadBridge(globals) {
  Object.assign(globalThis, globals)
  const src = readFileSync(join(here, "../scripts/main.js"), "utf8")
    .replace(/from "\.\/file-sort\.js"/, `from ${JSON.stringify(pathToFileURL(join(here, "../scripts/file-sort.js")).href)}`)
  const dir = mkdtempSync(join(tmpdir(), "pb-harness-"))
  const file = join(dir, "main.mjs")
  writeFileSync(file, src + "\nexport { fsScan, fsProbe, fsMove, fsRunInflight, fsStatus, fsLedger }\n")
  return import(pathToFileURL(file).href + "?v=" + Math.random())
}

const planner = join(here, "../../pendant-home/src/renderer/src/foundry/fileSortModel.mjs")
const loadPlanner = async () => (existsSync(planner) ? import(pathToFileURL(planner).href) : null)

// ── a small world ─────────────────────────────────────────────
const BYTES = {
  "worlds/w/maps/Cave Map.webp": enc("CAVE".repeat(50)),
  "worlds/w/tokens/gob.webp": enc("GOBLIN".repeat(30)),
  "worlds/w/tokens/Hero.png": enc("HERO".repeat(40)),
  "uploads/song.mp3": enc("SONG".repeat(60)),
  "uploads/setting.webp": enc("SETTING"),
  "uploads/unused.png": enc("UNUSED".repeat(9)),
  "uploads/pack.webp": enc("PACK".repeat(9)),
  "uploads/stubborn.webp": enc("STUBBORN".repeat(5)),
  "worlds/w/assets/scenes/s1-thumb.webp": enc("THUMB"),
  "worlds/w/rand/r1.webp": enc("RANDOM1"),
  "modules/x/y.png": enc("MODULE"),
  "worlds/w/world.json": enc('{"id":"w"}'),
  "uploads/notes.json": enc("{}"),
  "worlds/other/z.png": enc("OTHER"),
}

function buildWorld() {
  const { FOUNDRY, globals, game } = makeFoundry()
  const { files, dirs, CLASSES, Coll } = FOUNDRY
  for (const [k, v] of Object.entries(BYTES)) { files.set(k, v); const p = k.split("/"); for (let i = 1; i < p.length; i++) dirs.add(p.slice(0, i).join("/")) }
  const monsters = { name: "Monsters", folder: { name: "Bestiary", folder: null } }
  const actors = new Coll("Actor", [
    new CLASSES.Actor({ _id: "a1", name: "Goblin Boss", img: "worlds/w/tokens/gob.webp", prototypeToken: { texture: { src: "worlds/w/tokens/gob.webp" } }, _folder: monsters,
      items: [{ _id: "i1", name: "Club", img: "icons/svg/sword.svg" }] }),
    new CLASSES.Actor({ _id: "a2", name: "Stubborn", img: "uploads/stubborn.webp" }),
  ])
  actors.docs[1].failUpdate = true                               // a document that refuses edits
  const scenes = new Coll("Scene", [
    new CLASSES.Scene({ _id: "s1", name: "The Cave", background: { src: "worlds/w/maps/Cave%20Map.webp" }, thumb: "worlds/w/assets/scenes/s1-thumb.webp",
      tokens: [{ _id: "t1", name: "Gob", actorId: "a1", texture: { src: "worlds/w/tokens/gob.webp" } }],
      sounds: [{ _id: "snd", path: "uploads/song.mp3" }] }),
  ])
  const journal = new Coll("JournalEntry", [
    new CLASSES.JournalEntry({ _id: "j1", name: "Letter", pages: [{ _id: "p1", name: "P", text: { content: `<p>Map: <img src="worlds/w/maps/Cave Map.webp"> and <img src='${ORIGIN}/worlds/w/tokens/Hero.png?x=1'></p>` } }] }),
  ])
  const macros = new Coll("Macro", [new CLASSES.Macro({ _id: "m1", name: "Play", command: 'AudioHelper.play({src: "uploads/SONG.mp3"})\nconsole.log(1)' })])
  const chat = new Coll("ChatMessage", [new CLASSES.ChatMessage({ _id: "c1", content: '<div><img src="worlds/w/tokens/gob.webp" width="50"></div>' })])
  actors.docs.push(new CLASSES.Actor({ _id: "a3", name: "Random", prototypeToken: { texture: { src: "worlds/w/rand/*.webp" } } }))
  const playlists = new Coll("Playlist", [new CLASSES.Playlist({ _id: "pl", name: "Battle", sounds: [{ _id: "ps", path: "uploads/song.mp3" }] })])
  game.collections.set("Actor", actors); game.actors = actors
  game.collections.set("Macro", macros); game.collections.set("ChatMessage", chat)
  game.collections.set("Scene", scenes); game.collections.set("JournalEntry", journal); game.collections.set("Playlist", playlists)
  // a world compendium (editable, locked) and a module compendium (read-only)
  FOUNDRY.packs.set("world.heroes", { collection: "world.heroes", locked: true, metadata: { label: "Heroes", packageType: "world" },
    docs: [new CLASSES.Actor({ _id: "c1", name: "Hero", img: "worlds/w/tokens/Hero.png" }, { pack: "world.heroes" })],
    async getDocuments() { return this.docs }, async configure({ locked }) { this.locked = locked } })
  FOUNDRY.packs.set("mymod.stuff", { collection: "mymod.stuff", locked: true, metadata: { label: "Stuff", packageType: "module" },
    docs: [new CLASSES.Actor({ _id: "c2", name: "Mod thing", img: "uploads/pack.webp" }, { pack: "mymod.stuff" })],
    async getDocuments() { return this.docs }, async configure({ locked }) { this.locked = locked } })
  FOUNDRY.worldSettings.docs.push({ key: "somemod.bg", value: JSON.stringify({ image: "uploads/setting.webp" }) })
  return { FOUNDRY, globals, game }
}

// Every field that held a link at the start → where it must still resolve to the original bytes.
const LINKS = [
  ["Scene.s1", d => d._own.background.src, "worlds/w/maps/Cave Map.webp"],
  ["Scene.s1", d => d.tokens.docs[0]._own.texture.src, "worlds/w/tokens/gob.webp"],
  ["Scene.s1", d => d.sounds.docs[0]._own.path, "uploads/song.mp3"],
  ["Actor.a1", d => d._own.img, "worlds/w/tokens/gob.webp"],
  ["Actor.a1", d => d._own.prototypeToken.texture.src, "worlds/w/tokens/gob.webp"],
  ["Actor.a2", d => d._own.img, "uploads/stubborn.webp"],
  ["Playlist.pl", d => d.sounds.docs[0]._own.path, "uploads/song.mp3"],
  ["JournalEntry.j1", d => /src="([^"]+)"/.exec(d.pages.docs[0]._own.text.content)[1], "worlds/w/maps/Cave Map.webp"],
  ["JournalEntry.j1", d => /src='([^']+)'/.exec(d.pages.docs[0]._own.text.content)[1], "worlds/w/tokens/Hero.png"],
  ["Macro.m1", d => /src: "([^"]+)"/.exec(d._own.command)[1], "uploads/song.mp3"],
  ["ChatMessage.c1", d => /src="([^"]+)"/.exec(d._own.content)[1], "worlds/w/tokens/gob.webp"],
  ["Compendium.world.heroes.Actor.c1", d => d._own.img, "worlds/w/tokens/Hero.png"],
  ["Compendium.mymod.stuff.Actor.c2", d => d._own.img, "uploads/pack.webp"],
]
async function assertNothingBroken(W, label) {
  const all = []
  for (const c of W.game.collections.values()) all.push(...c)
  for (const p of W.FOUNDRY.packs.values()) all.push(...p.docs)
  for (const [uuid, get, original] of LINKS) {
    const doc = all.find(d => d.uuid === uuid)
    const link = get(doc)
    const key = decodeKey(link.startsWith(ORIGIN) ? link.slice(ORIGIN.length) : link)
    const bytes = W.FOUNDRY.files.get(key) ?? [...W.FOUNDRY.files.entries()].find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1]
    assert.ok(bytes, `${label}: ${uuid} links to missing ${key}`)
    assert.deepEqual(bytes, BYTES[original], `${label}: ${uuid} → ${key} isn't the original file`)
  }
  // the random-image token's folder is untouched (wildcards are never moved)
  assert.deepEqual(W.FOUNDRY.files.get("worlds/w/rand/r1.webp"), BYTES["worlds/w/rand/r1.webp"], `${label}: wildcard file changed`)
  // the setting still points at its (pinned, untouched) file
  assert.deepEqual(W.FOUNDRY.files.get("uploads/setting.webp"), BYTES["uploads/setting.webp"], `${label}: setting file changed`)
}

async function planFor(bridge, P, W) {
  const scan = await bridge.fsScan({ root: ROOT })
  const plan = P.buildFilePlan(scan, { root: ROOT })
  return { scan, plan }
}

test("scan finds every link; plan pins what can't be relinked", async (t) => {
  const P = await loadPlanner()
  if (!P) return t.skip("pendant-home not next to this repo")
  const W = buildWorld()
  const bridge = await loadBridge(W.globals)
  const { scan, plan } = await planFor(bridge, P, W)
  assert.ok(!scan.files.some(f => f.startsWith("modules/") || f.startsWith("worlds/other")), "core/module/other-world files are never in scope")
  assert.deepEqual(scan.otherWorlds, ["other"])
  assert.ok(!scan.files.some(f => f.endsWith(".json")), "data files (world.json…) are never in scope")
  const to = Object.fromEntries(plan.items.map(i => [i.from, i.to]))
  assert.equal(to["worlds/w/maps/Cave Map.webp"], `${ROOT}/Maps/The Cave/Cave Map.webp`)
  assert.equal(to["worlds/w/tokens/gob.webp"], `${ROOT}/Tokens and Actors/Bestiary/Monsters/Goblin Boss/gob.webp`)
  assert.equal(to["uploads/song.mp3"], `${ROOT}/Audio/Battle/song.mp3`)
  assert.equal(to["uploads/unused.png"], `${ROOT}/Unused/uploads/unused.png`)
  const pinned = Object.fromEntries(plan.pinned.map(p => [p.from, p.why]))
  assert.match(pinned["uploads/setting.webp"], /module setting/)
  assert.match(pinned["uploads/pack.webp"], /module compendium/)
  assert.match(pinned["worlds/w/assets/scenes/s1-thumb.webp"], /thumbnail/)
  assert.match(pinned["worlds/w/rand/r1.webp"], /random-image/)
})

test("a full run moves, relinks, verifies and shrinks — and keeps what it can't relink", async (t) => {
  const P = await loadPlanner()
  if (!P) return t.skip("pendant-home not next to this repo")
  const W = buildWorld()
  const bridge = await loadBridge(W.globals)
  const { plan } = await planFor(bridge, P, W)
  const exts = [...new Set(plan.items.map(i => P.extOf(i.from)))]
  const probe = await bridge.fsProbe({ root: ROOT, exts })
  assert.equal(probe.overwrite, true)
  const r = await bridge.fsMove({ root: ROOT, batchId: "b1", items: plan.items })
  const byFrom = Object.fromEntries(r.batch.results.map(x => [x.from, x]))
  assert.equal(byFrom["worlds/w/maps/Cave Map.webp"].s, "done")
  assert.equal(byFrom["uploads/stubborn.webp"].s, "kept", "a doc that refused the edit keeps its original")
  await assertNothingBroken(W, "after run")
  // originals of moved files are now placeholders saying where they went
  const old = new TextDecoder().decode(W.FOUNDRY.files.get("worlds/w/maps/Cave Map.webp"))
  assert.match(old, /^RealmScreen moved this file\.\nNew location: Chronicles of Albuna\/Maps\/The Cave\/Cave Map\.webp/)
  // the journal kept its written forms: plain attribute stays plain, absolute URL stays absolute
  const html = W.game.collections.get("JournalEntry").docs[0].pages.docs[0]._own.text.content
  assert.match(html, /src="Chronicles of Albuna\/Maps\/The Cave\/Cave Map\.webp"/)
  assert.match(html, new RegExp(`src='${ORIGIN}/Chronicles%20of%20Albuna/Tokens%20and%20Actors/Heroes%20\\(compendium\\)/Hero/Hero\\.png\\?x=1'`))
  // the scene's encoded background stayed encoded
  assert.match(W.game.collections.get("Scene").docs[0]._own.background.src, /^Chronicles%20of%20Albuna\/Maps\//)
  // the world compendium was edited and re-locked
  assert.equal(W.FOUNDRY.packs.get("world.heroes").locked, true)
  // a second scan excludes what moved
  const again = await bridge.fsScan({ root: ROOT })
  assert.ok(!again.files.includes("worlds/w/maps/Cave Map.webp"))
  assert.ok(again.placeholders >= 1)
})

test("crash at EVERY save and EVERY upload, then resume: no link ever breaks, every copy is exact", async (t) => {
  const P = await loadPlanner()
  if (!P) return t.skip("pendant-home not next to this repo")
  // count saves/uploads of a clean run first
  let total
  {
    const W = buildWorld(); const bridge = await loadBridge(W.globals)
    const { plan } = await planFor(bridge, P, W)
    await bridge.fsProbe({ root: ROOT, exts: [...new Set(plan.items.map(i => P.extOf(i.from)))] })
    const s0 = W.FOUNDRY.crash.saves, u0 = W.FOUNDRY.crash.uploads
    await bridge.fsMove({ root: ROOT, batchId: "b1", items: plan.items })
    total = { saves: W.FOUNDRY.crash.saves - s0, uploads: W.FOUNDRY.crash.uploads - u0, s0, u0 }
  }
  assert.ok(total.saves >= 4 && total.uploads >= 10, JSON.stringify(total))
  const cases = [
    ...Array.from({ length: total.saves }, (_, i) => ({ kind: "save", n: i + 1 })),
    ...Array.from({ length: total.uploads }, (_, i) => ({ kind: "upload", n: i + 1 })),
  ]
  for (const c of cases) {
    const W = buildWorld(); const bridge = await loadBridge(W.globals)
    const { plan } = await planFor(bridge, P, W)
    await bridge.fsProbe({ root: ROOT, exts: [...new Set(plan.items.map(i => P.extOf(i.from)))] })
    const label = `crash at ${c.kind} #${c.n}`
    if (c.kind === "save") W.FOUNDRY.crash.atSave = W.FOUNDRY.crash.saves + c.n
    else W.FOUNDRY.crash.atUpload = W.FOUNDRY.crash.uploads + c.n
    let crashed = false
    try { await bridge.fsMove({ root: ROOT, batchId: "b1", items: plan.items }) } catch (e) { crashed = !!e.crash; if (!e.crash) throw e }
    await assertNothingBroken(W, label + " (right after)")
    // "reload": crash off, resume whatever the ledger says, then finish with a fresh scan + plan
    W.FOUNDRY.crash.atSave = 0; W.FOUNDRY.crash.atUpload = 0
    if (crashed && bridge.fsStatus().inflight) await bridge.fsRunInflight()
    await assertNothingBroken(W, label + " (after resume)")
    // what the user does next: Scan again → Move (retries failed items, skips finished ones)
    const { plan: rest } = await planFor(bridge, P, W)
    const todo = rest.items.filter(i => !bridge.fsLedger().kept[i.from])
    if (todo.length) await bridge.fsMove({ root: ROOT, batchId: "b2", items: todo })
    else await bridge.fsRunInflight()               // Move with nothing left still retries pending shrinks
    await assertNothingBroken(W, label + " (finished)")
    // every file that moved: exactly one full copy exists, original shrunk
    const L = bridge.fsLedger()
    for (const [from, to] of Object.entries(L.done)) {
      assert.deepEqual(W.FOUNDRY.files.get(to), BYTES[from], `${label}: copy of ${from} differs`)
      assert.ok(W.FOUNDRY.files.get(from).length < 200, `${label}: ${from} wasn't shrunk`)
    }
    assert.ok(Object.keys(L.done).length >= 5, `${label}: only ${Object.keys(L.done).length} moved`)
    assert.equal(L.inflight, null, `${label}: batch left open`)
  }
})

test("files kept earlier are recovered once nothing uses the original", async (t) => {
  const P = await loadPlanner()
  if (!P) return t.skip("pendant-home not next to this repo")
  const W = buildWorld()
  const bridge = await loadBridge(W.globals)
  const { plan } = await planFor(bridge, P, W)
  await bridge.fsProbe({ root: ROOT, exts: [...new Set(plan.items.map(i => P.extOf(i.from)))] })
  await bridge.fsMove({ root: ROOT, batchId: "b1", items: plan.items })
  assert.ok(bridge.fsLedger().kept["uploads/stubborn.webp"], "kept while its actor refuses edits")
  W.game.actors.get("a2").failUpdate = false                       // the blocker goes away
  const r = await bridge.fsRunInflight()
  assert.equal(r.recovered, 1)
  const L = bridge.fsLedger()
  assert.ok(!L.kept["uploads/stubborn.webp"])
  const to = L.done["uploads/stubborn.webp"]
  assert.equal(W.game.actors.get("a2")._own.img, to)
  assert.deepEqual(W.FOUNDRY.files.get(to), BYTES["uploads/stubborn.webp"])
  assert.ok(W.FOUNDRY.files.get("uploads/stubborn.webp").length < 200, "original shrunk")
  await assertNothingBroken(W, "after recovery")
})
