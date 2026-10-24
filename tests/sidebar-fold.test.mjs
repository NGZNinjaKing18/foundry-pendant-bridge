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
    ["dice-so-nice", "items", "tables", "cards", "macros", "playlists", "talk"])
})

test("the GM's saved pick wins, in strip order", () => {
  assert.deepEqual(pickFolded(strip, { tabs: ["macros", "actors"] }), ["actors", "macros"])
  assert.deepEqual(pickFolded(strip, { tabs: [] }), [])
})

test("chat and settings never fold", () => {
  assert.deepEqual(pickFolded(strip, { tabs: ["chat", "settings", "items"] }), ["items"])
})
