import { test } from "node:test"
import assert from "node:assert/strict"

globalThis.Hooks = { on() {}, once() {}, callAll() {} }
const { stackLayout, stackSig, moveItem, fanSpots } = await import("../scripts/group-stack.js")

test("one member fills the picture", () => {
  const [p] = stackLayout(1, 512)
  assert.deepEqual([p.x, p.y], [256, 256])
  assert.ok(p.d > 490 && p.d <= 512)
})

test("the first member is in front: lowest row, drawn on top; every face stays inside", () => {
  for (let n = 2; n <= 10; n++) {
    const pts = stackLayout(n, 512)
    assert.equal(pts.length, Math.min(n, 8))
    for (const p of pts.slice(1)) assert.ok(pts[0].y >= p.y && pts[0].d >= p.d)
    for (const p of pts) {
      assert.ok(p.x - p.d / 2 >= -1 && p.x + p.d / 2 <= 513, `x in bounds n=${n}`)
      assert.ok(p.y - p.d / 2 >= -1 && p.y + p.d / 2 <= 513, `y in bounds n=${n}`)
    }
  }
  assert.deepEqual(stackLayout(0), [])
})

test("no two tokens sit right on top of each other", () => {
  for (let n = 2; n <= 8; n++) {
    const pts = stackLayout(n, 512)
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const dist = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
      assert.ok(dist >= 0.3 * Math.min(pts[i].d, pts[j].d), `n=${n} ${i}/${j} too close`)
    }
  }
})

test("tokens stay big: two members get more than half the picture each", () => {
  assert.ok(stackLayout(2, 512)[0].d > 300)
  assert.ok(stackLayout(4, 512)[0].d > 240)
})

test("the signature follows order and art", () => {
  assert.equal(stackSig(["a", "b"]), stackSig(["a", "b"]))
  assert.notEqual(stackSig(["a", "b"]), stackSig(["b", "a"]))
})

test("moveItem moves one item and leaves the rest in order", () => {
  assert.deepEqual(moveItem([1, 2, 3, 4], 0, 2), [2, 3, 1, 4])
  assert.deepEqual(moveItem([1, 2, 3, 4], 3, 0), [4, 1, 2, 3])
  assert.deepEqual(moveItem([1, 2], 5, 0), [1, 2])
})

test("the fan is centred above the token, 120° at most per ring, extra faces go further out", () => {
  assert.deepEqual(fanSpots(1), [{ angle: -90, ring: 0 }])
  const a = fanSpots(5).map(s => s.angle)
  assert.equal((a[0] + a[4]) / 2, -90)
  const many = fanSpots(14)
  assert.deepEqual(many.map(s => s.ring), [0,0,0,0,0,0,1,1,1,1,1,1,2,2])
  for (const r of [0, 1]) {
    const ring = many.filter(s => s.ring === r).map(s => s.angle)
    assert.ok(Math.max(...ring) - Math.min(...ring) <= 120)
  }
  assert.equal((many[12].angle + many[13].angle) / 2, -90)
})
