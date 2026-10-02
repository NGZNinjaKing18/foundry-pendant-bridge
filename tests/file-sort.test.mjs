import { test } from "node:test"
import assert from "node:assert/strict"
import {
  normalizePath, encodePath, makeLookup, extractCandidates, findRefs, rewriteString,
  collectUpdates, forEachString, expandWildcard, needlesFor, mightMention, hashBytes53,
  stubText, isStubBytes, splitPath, extOf,
} from "../scripts/file-sort.js"

const BASES = ["https://vtt.example.net/"]

test("normalizePath: decodes, strips origin/slash/query, refuses other sites", () => {
  assert.equal(normalizePath("worlds/w/My%20Map.webp"), "worlds/w/My Map.webp")
  assert.equal(normalizePath("/worlds/w/a.png?x=1#y"), "worlds/w/a.png")
  assert.equal(normalizePath("https://vtt.example.net/worlds/w/a.png", BASES), "worlds/w/a.png")
  assert.equal(normalizePath("https://other.site/a.png", BASES), "")
  assert.equal(normalizePath("data:image/png;base64,AAA"), "")
  assert.equal(normalizePath("worlds\\w//a.png"), "worlds/w/a.png")
  assert.equal(normalizePath("bad%zz.png"), "bad%zz.png")
})

test("encodePath keeps slashes", () => {
  assert.equal(encodePath("Chronicles of Albuna/Maps/Cave (1).webp"), "Chronicles%20of%20Albuna/Maps/Cave%20(1).webp")
  assert.deepEqual(splitPath("a/b/c.webp"), { dir: "a/b", name: "c.webp" })
  assert.equal(extOf("x/y.WEBP"), "webp")
})

test("lookup: exact, then case-insensitive, ambiguity reported", () => {
  const l = makeLookup(["maps/Cave.webp", "a/X.png", "a/x.png"])
  assert.deepEqual(l.get("maps/Cave.webp"), ["maps/Cave.webp"])
  assert.deepEqual(l.get("MAPS/cave.webp"), ["maps/Cave.webp"])
  assert.deepEqual(l.get("A/X.PNG").sort(), ["a/X.png", "a/x.png"])
  assert.equal(l.get("nope.png"), null)
})

test("extractCandidates: whole field, html attributes, css url, bare tokens", () => {
  assert.equal(extractCandidates("worlds/w/a.webp")[0].kind, "whole")
  const html = `<p>See <img src="worlds/w/My Map.webp" /> and <a href='b.pdf'>x</a></p><div style="background:url('c.png')">`
  const raws = extractCandidates(html).map(c => c.raw)
  assert.deepEqual(raws, ["worlds/w/My Map.webp", "b.pdf", "c.png"])
  const code = `AudioHelper.play({src: "sounds/x.mp3"})\nlet y = 2`
  assert.ok(extractCandidates(code).some(c => c.raw === "sounds/x.mp3"))
})

test("findRefs: plain field, sentence fallback, wildcard, unknown", () => {
  const l = makeLookup(["worlds/w/My Map.webp", "tok/g1.webp", "tok/g2.webp", "a.png"])
  assert.equal(findRefs("worlds/w/My%20Map.webp", l)[0].key, "worlds/w/My Map.webp")
  assert.equal(findRefs("https://vtt.example.net/worlds/w/My%20Map.webp", l, BASES)[0].key, "worlds/w/My Map.webp")
  assert.equal(findRefs("look at a.png please", l)[0].key, "a.png")
  const w = findRefs("tok/*.webp", l)
  assert.equal(w[0].wildcard, true)
  assert.deepEqual(expandWildcard(w[0].key, l.keys).sort(), ["tok/g1.webp", "tok/g2.webp"])
  const unknown = []
  assert.deepEqual(findRefs("icons/svg/skull.svg", l, [], unknown), [])
  assert.deepEqual(unknown, ["icons/svg/skull.svg"])
  assert.deepEqual(findRefs("Goblin", l), [])
})

test("rewriteString keeps the written form", () => {
  const map = new Map([["worlds/w/My Map.webp", "Chronicles of Albuna/Maps/My Map.webp"], ["a.png", "Chronicles of Albuna/Items/a.png"]])
  const res = k => map.get(k) || null
  assert.equal(rewriteString("worlds/w/My Map.webp", res), "Chronicles of Albuna/Maps/My Map.webp")
  assert.equal(rewriteString("worlds/w/My%20Map.webp", res), "Chronicles%20of%20Albuna/Maps/My%20Map.webp")
  assert.equal(rewriteString("/worlds/w/My%20Map.webp?v=2", res), "/Chronicles%20of%20Albuna/Maps/My%20Map.webp?v=2")
  assert.equal(rewriteString("https://vtt.example.net/worlds/w/My%20Map.webp", res, BASES), "https://vtt.example.net/Chronicles%20of%20Albuna/Maps/My%20Map.webp")
  assert.equal(
    rewriteString(`<img src="worlds/w/My Map.webp"> and <img src='a.png'>`, res),
    `<img src="Chronicles of Albuna/Maps/My Map.webp"> and <img src='Chronicles of Albuna/Items/a.png'>`)
  // bare text: encoded so the space doesn't end the path
  assert.equal(rewriteString("see a.png now", res), "see Chronicles%20of%20Albuna/Items/a.png now")
  assert.equal(rewriteString("nothing here.txt", res), "nothing here.txt")
  const same = "untouched"
  assert.equal(rewriteString(same, res), same)
})

test("collectUpdates: dotted keys for strings, whole arrays, never inside dotted object keys", () => {
  const map = new Map([["a.png", "N/a.png"]])
  const rw = s => rewriteString(s, k => map.get(k) || null)
  const src = {
    _id: "x", name: "a.png", img: "a.png",
    prototypeToken: { texture: { src: "a.png" } },
    system: { list: [{ img: "a.png" }, { img: "b.png" }], other: 1 },
    flags: { mod: { "weird.key": "a.png", ok: "a.png" } },
    items: [{ img: "a.png" }],
  }
  const u = collectUpdates(src, new Set(["_id", "items"]), rw)
  assert.deepEqual(u, {
    name: "N/a.png", img: "N/a.png",
    "prototypeToken.texture.src": "N/a.png",
    "system.list": [{ img: "N/a.png" }, { img: "b.png" }],
    "flags.mod.ok": "N/a.png",
  })
  const seen = []
  forEachString(src, new Set(["_id", "items"]), (s, p, ed) => { if (s === "a.png") seen.push([p, ed]) })
  assert.ok(seen.some(([p, ed]) => p === "flags.mod.weird.key" && ed === false))
  assert.ok(seen.some(([p, ed]) => p === "system.list.0.img" && ed === true))
})

test("needles pre-filter", () => {
  const n = needlesFor(["worlds/w/My Map.webp"])
  assert.ok(mightMention('{"img":"worlds/w/My%20Map.webp"}', n))
  assert.ok(mightMention('{"img":"WORLDS/W/my map.webp"}', n))
  assert.ok(!mightMention('{"img":"other.webp"}', n))
})

test("hash + stub", () => {
  const a = new Uint8Array([1, 2, 3]), b = new Uint8Array([1, 2, 4])
  assert.notEqual(hashBytes53(a), hashBytes53(b))
  assert.equal(hashBytes53(a), hashBytes53(new Uint8Array([1, 2, 3])))
  const stub = new TextEncoder().encode(stubText("X/y.webp"))
  assert.ok(isStubBytes(stub))
  assert.ok(!isStubBytes(a))
})
