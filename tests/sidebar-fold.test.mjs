import { test } from "node:test"
import assert from "node:assert/strict"

// sidebar-fold.js registers Foundry hooks at import; give it a stub.
globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { pickFolded } = await import("../scripts/sidebar-fold.js")

const strip = [
  { id: "chat", tooltip: "Chat Messages" }, { id: "dice-so-nice", tooltip: "Dice So Nice" },
  { id: "combat", tooltip: "Combat Encounters" }, { id: "actors", tooltip: "Actors" },
  { id: "items", tooltip: "Items" }, { id: "journal", tooltip: "Journal" },
  { id: "tables", tooltip: "Roll Tables" }, { id: "cards", tooltip: "Card Stacks" },
  { id: "macros", tooltip: "Macros" }, { id: "playlists", tooltip: "Playlists" },
  { id: "talk", tooltip: "Conversations" }, { id: "compendium", tooltip: "Compendium Packs" },
  { id: "settings", tooltip: "Game Settings" },
]

test("built-in pick folds the asked-for tabs, module tabs by name", () => {
  assert.deepEqual(pickFolded(strip, null),
    ["dice-so-nice", "items", "tables", "cards", "macros", "talk"])
})

test("the GM's saved pick wins, in strip order", () => {
  assert.deepEqual(pickFolded(strip, { tabs: ["macros", "actors"] }), ["actors", "macros"])
  assert.deepEqual(pickFolded(strip, { tabs: [] }), [])
})

test("chat and settings never fold", () => {
  assert.deepEqual(pickFolded(strip, { tabs: ["chat", "settings", "items"] }), ["items"])
})

// RealmScreen's own tabs: on the strip only while RealmScreen is connected (anyone's link counts).
const { realmTabs, REALM_TABS } = await import("../scripts/sidebar-fold.js")
function fakeStrip(ids) {
  const lis = new Map(ids.map(id => {
    const cls = new Set()
    const li = { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) } }
    return [id, li]
  }))
  const find = (sel) => { const id = /data-tab="([^"]+)"/.exec(sel)?.[1]; const li = lis.get(id); return li ? { closest: () => li } : null }
  return { menu: { querySelector: find }, off: (id) => lis.get(id).classList.has("pb-realm-off") }
}

test("not connected: Calendar and Table log leave the strip, the open one hands over to Chat", () => {
  const { menu, off } = fakeStrip(["chat", "journal", ...REALM_TABS])
  const changed = [], closed = []
  globalThis.ui = { sidebar: { tabGroups: { primary: "realmtable" }, changeTab: (t) => changed.push(t) }, realmcal: { popout: { close: () => closed.push("realmcal") } } }
  realmTabs(menu, false)
  assert.equal(off("realmcal"), true); assert.equal(off("realmtable"), true); assert.equal(off("journal"), false)
  assert.deepEqual(changed, ["chat"]); assert.deepEqual(closed, ["realmcal"])
  realmTabs(menu, true)                               // connected again: back, exactly as before
  assert.equal(off("realmcal"), false); assert.equal(off("realmtable"), false)
  delete globalThis.ui
})
