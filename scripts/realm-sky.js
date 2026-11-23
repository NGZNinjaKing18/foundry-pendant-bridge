// ──────────────────────────────────────────────────────────────
// The sky over RealmScreen's map scenes — the time of day and the weather (pendant-home lib/foundrySky.js).
//
// RealmScreen sends each linked scene three small pictures for the clock's hour (flags[MOD].sky):
//   light   the sky wash: day clear, dawn / dusk warm, night dark blue (moons lift it)
//   clouds  cloud cover by type: thin white, grey overcast, dark storm cores
//   wet     R = rain / snow amount, G = how much is snow, B = storm
// One quad over the map draws all of it in ONE shader: clouds that slowly churn and cast a soft shadow,
// rain-darkened decks with falling rain, snow flakes, lightning flicker in storm cells, then the light.
// Rain and snow are sized on SCREEN, so they stay fine at any zoom. A new hour cross-fades in.
//
// Who sees it: the GM's Map views switch (world setting realmSky): Off · DM only · Everyone.
// Cheap by design: nothing exists while it is Off or the scene has no sky; one draw call while it is on;
// the animation stops in Foundry's Low performance mode.
// ──────────────────────────────────────────────────────────────

const MOD = "pendant-bridge"
const SORT_LAYER = 690          // above the Realm layer (650), under tokens (700)
const FADE_MS = 4000            // a new hour cross-fades over this long

export const SKY_MODES = ["off", "gm", "all"]
export function skyMode() { try { const v = game.settings.get(MOD, "realmSky"); return SKY_MODES.includes(v) ? v : "off" } catch { return "off" } }
/** Does this viewer see the sky? Pure on its inputs — exported for tests. */
export function skyShownFor(mode, isGM) { return mode === "all" || (mode === "gm" && !!isGM) }

let sender = null               // the bridge's WebSocket send (only the window linked to RealmScreen has one)
export function setSkySender(fn) { sender = typeof fn === "function" ? fn : null }

// ── commands (main.js) ─────────────────────────────────────────
export function skyState() { return { mode: skyMode() } }
export async function skySet(msg) {
  const scene = game.scenes?.get?.(msg?.sceneId)
  if (!scene) return { ok: false, error: "No such scene." }
  const s = msg?.sky || {}
  const ok = (v) => typeof v === "string" && v.startsWith("data:image/png;base64,")
  if (!ok(s.light) || !ok(s.clouds) || !ok(s.wet)) return { ok: false, error: "Bad sky." }
  await scene.setFlag(MOD, "sky", { at: { day: Number(s.at?.day) || 0, hour: Number(s.at?.hour) || 0 }, light: s.light, clouds: s.clouds, wet: s.wet })
  return { ok: true }
}

// ── the shader ─────────────────────────────────────────────────
const VERT = `
precision mediump float;
attribute vec2 aVertexPosition;
attribute vec2 aUvs;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
varying vec2 vUv;
void main() {
  vUv = aUvs;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}`

const FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uLightA, uLightB, uCloudA, uCloudB, uWetA, uWetB;
uniform float uMix, uTime, uAspect, uPx;
uniform vec2 uTexel;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { return 0.55 * noise(p) + 0.3 * noise(p * 2.03 + 7.1) + 0.15 * noise(p * 4.1 + 3.7); }
vec4 cloudAt(vec2 uv) { return mix(texture2D(uCloudA, uv), texture2D(uCloudB, uv), uMix); }
// The cloud raster carries per-texel grain; stretched ~25x it reads as squares, so it is softened over
// ~1.5 texels here and the stir noise below gives back fine, smooth detail.
vec4 cloudSoft(vec2 uv) {
  vec2 o = uTexel * 0.9;
  return cloudAt(uv) * 0.28 + (cloudAt(uv + vec2(o.x, o.y)) + cloudAt(uv + vec2(-o.x, o.y)) + cloudAt(uv + vec2(o.x, -o.y)) + cloudAt(uv - o)) * 0.18;
}
vec4 over(vec4 c, vec3 rgb, float a) { return vec4(rgb * a + c.rgb * (1.0 - a), a + c.a * (1.0 - a)); }
void main() {
  vec4 cl = cloudSoft(vUv);
  vec4 wet = mix(texture2D(uWetA, vUv), texture2D(uWetB, vUv), uMix);
  vec4 li = mix(texture2D(uLightA, vUv), texture2D(uLightB, vUv), uMix);
  float rain = wet.r, snow = wet.g, storm = wet.b;
  vec2 mp = vUv * vec2(uAspect, 1.0);
  // Clouds churn in place: the weather's shape is RealmScreen's; this only stirs its texture.
  float stir = fbm(mp * 14.0 + vec2(uTime * 0.012, uTime * 0.004));
  float ca = clamp(cl.a * (0.62 + 0.76 * stir), 0.0, 1.0);
  vec3 crgb = cl.a > 0.001 ? cl.rgb / cl.a : vec3(1.0);
  crgb *= 1.0 - 0.38 * rain * (1.0 - 0.7 * snow) - 0.22 * storm;   // rain decks grey, snow decks stay pale, storm cores darker
  vec4 c = vec4(0.0);
  // A soft shadow under the clouds, a little to the side.
  float sh = cloudAt(vUv + vec2(0.006, 0.009)).a;
  c = over(c, vec3(0.04, 0.05, 0.08), sh * 0.22);
  c = over(c, crgb, ca);
  // Rain: slanted streaks on screen, as many as it is raining hard.
  vec2 sp = gl_FragCoord.xy / uPx;
  float wetRain = rain * (1.0 - snow);
  if (wetRain > 0.02) {
    vec2 rp = vec2(sp.x + sp.y * 0.22, sp.y);
    float col = floor(rp.x / 3.0);
    float h = hash(vec2(col, 1.7));
    float y = (rp.y + uTime * (620.0 + 380.0 * h) + h * 900.0) / 150.0;
    float on = step(1.0 - wetRain * 0.55, hash(vec2(col, floor(y))));
    float t = fract(y);
    float streak = smoothstep(0.0, 0.03, t) * (1.0 - smoothstep(0.03, 0.16, t)) * (1.0 - abs(fract(rp.x / 3.0) - 0.5) * 2.0);
    c = over(c, vec3(0.78, 0.84, 0.92), streak * on * (0.25 + 0.35 * wetRain));
  }
  // Snow: soft flakes drifting down.
  if (snow * rain > 0.02) {
    float sa = snow * rain;
    vec2 q = sp + vec2(sin(uTime * 0.6 + sp.y * 0.02) * 7.0, uTime * 34.0);
    vec2 cell = floor(q / 22.0);
    vec2 f = fract(q / 22.0) - 0.5 - (vec2(hash(cell), hash(cell + 4.3)) - 0.5) * 0.55;
    float r = 0.06 + 0.07 * hash(cell + 7.7);                 // flakes of a few sizes
    float flake = (1.0 - smoothstep(r * 0.45, r, length(f))) * step(1.0 - sa * 0.8, hash(cell + 9.1));
    c = over(c, vec3(1.0), flake * 0.85);
  }
  // The time of day over all of it (night darkens the clouds too).
  // Capped so the map stays readable at the table on a moonless night (RealmScreen's own wash goes darker).
  c = over(c, li.a > 0.001 ? li.rgb / li.a : vec3(0.0), min(li.a, 0.7));
  // Lightning: storm cells flash now and then — bright even at night, so it goes on last.
  if (storm > 0.4) {
    vec2 g = vUv * vec2(8.0 * uAspect, 8.0);
    vec2 cid = floor(g);
    float ph = uTime * 1.6 + hash(cid) * 11.0;
    float strike = step(0.9, hash(cid + floor(ph)));
    float k = fract(ph);
    // a sharp strike, a flicker, a fast decay — lighting up a patch of the cloud deck from inside
    float flash = strike * (1.0 - smoothstep(0.0, 0.22, k)) * (0.55 + 0.45 * step(0.45, fract(k * 14.0)));
    vec2 at = fract(g) - 0.5 - (vec2(hash(cid + 1.3), hash(cid + 2.9)) - 0.5) * 0.5;
    float glow = 1.0 - smoothstep(0.0, 0.55, length(at));
    float a = flash * glow * glow * smoothstep(0.4, 0.75, storm) * (0.35 + 0.65 * ca) * 0.8;
    c = vec4(c.rgb + vec3(0.82, 0.88, 1.0) * a, max(c.a, a));
  }
  gl_FragColor = c;
}`

// ── drawing ────────────────────────────────────────────────────
const S = { root: null, mesh: null, tex: { A: null, B: null }, sig: "", fade: null, tick: null, t0: 0, load: 0 }

function loadTex(src) {
  return new Promise((res) => {
    const img = new Image()
    img.onload = () => { try { res(PIXI.Texture.from(img)) } catch { res(null) } }
    img.onerror = () => res(null)
    img.src = src
  })
}
const destroySet = (t) => { if (t) for (const k of ["light", "clouds", "wet"]) try { t[k]?.destroy(true) } catch { /* gone */ } }

function teardown() {
  if (S.tick) { canvas?.app?.ticker?.remove?.(S.tick); S.tick = null }
  try { S.root?.destroy({ children: true }) } catch { /* gone */ }
  if (S.tex.B !== S.tex.A) destroySet(S.tex.B)
  destroySet(S.tex.A)
  S.root = null; S.mesh = null; S.tex = { A: null, B: null }; S.sig = ""; S.fade = null; S.load++
}

function buildMesh() {
  const d = canvas.dimensions
  const x0 = d.sceneX || 0, y0 = d.sceneY || 0, w = d.sceneWidth || d.width, h = d.sceneHeight || d.height
  const geom = new PIXI.Geometry()
    .addAttribute("aVertexPosition", [x0, y0, x0 + w, y0, x0 + w, y0 + h, x0, y0 + h], 2)
    .addAttribute("aUvs", [0, 0, 1, 0, 1, 1, 0, 1], 2)
    .addIndex([0, 1, 2, 0, 2, 3])
  const t = S.tex.A
  const shader = PIXI.Shader.from(VERT, FRAG, {
    uLightA: t.light, uLightB: t.light, uCloudA: t.clouds, uCloudB: t.clouds, uWetA: t.wet, uWetB: t.wet,
    uMix: 0, uTime: 0, uAspect: h > 0 ? w / h : 1, uPx: 1, uTexel: [1 / (t.clouds.width || 160), 1 / (t.clouds.height || 100)],
  })
  const mesh = new PIXI.Mesh(geom, shader)
  const root = new PIXI.Container()
  root.elevation = 0; root.sortLayer = SORT_LAYER; root.sort = 0
  root.eventMode = "none"; root.interactiveChildren = false
  root.addChild(mesh)
  canvas.primary.addChild(root)
  canvas.primary.sortDirty = true
  S.root = root; S.mesh = mesh; S.t0 = performance.now()
  S.tick = () => {
    const u = S.mesh?.shader?.uniforms
    if (!u) return
    const now = performance.now()
    const low = (canvas.performance?.mode ?? 2) <= 0           // Foundry's Low performance mode: a still sky
    if (!low) u.uTime = ((now - S.t0) / 1000) % 3600
    u.uPx = (canvas.app?.renderer?.resolution || 1)
    if (S.fade) {
      const k = Math.min(1, (now - S.fade) / FADE_MS)
      u.uMix = k
      if (k >= 1) {                                            // B is the picture now: drop the old one
        const old = S.tex.A
        S.tex.A = S.tex.B; S.fade = null
        u.uLightA = S.tex.A.light; u.uCloudA = S.tex.A.clouds; u.uWetA = S.tex.A.wet; u.uMix = 0
        if (old !== S.tex.A) destroySet(old)
      }
    }
  }
  canvas.app.ticker.add(S.tick)
}

/** (Re)draw the sky for the viewed scene: nothing, a first picture, or a cross-fade to a new hour. */
export async function drawSky() {
  const scene = canvas?.scene
  const sky = scene?.getFlag?.(MOD, "sky")
  if (!canvas?.primary || !sky?.light || !skyShownFor(skyMode(), game.user?.isGM)) { teardown(); return }
  const sig = `${scene.id}|${sky.at?.day}|${sky.at?.hour}|${sky.clouds.length}|${sky.light.length}`
  if (sig === S.sig && S.root && !S.root.destroyed) return
  const my = ++S.load
  const [light, clouds, wet] = await Promise.all([loadTex(sky.light), loadTex(sky.clouds), loadTex(sky.wet)])
  if (my !== S.load || !light || !clouds || !wet) { destroySet({ light, clouds, wet }); return }
  S.sig = sig
  const next = { light, clouds, wet }
  if (!S.root || S.root.destroyed || S.root.parent !== canvas.primary) {
    teardown(); S.load = my; S.sig = sig
    S.tex = { A: next, B: next }
    buildMesh()
    return
  }
  // Already showing: fade from what is on screen now to the new hour.
  const u = S.mesh.shader.uniforms
  if (S.fade && S.tex.B && S.tex.B !== S.tex.A) {                // mid-fade: settle on B first
    destroySet(S.tex.A); S.tex.A = S.tex.B
    u.uLightA = S.tex.A.light; u.uCloudA = S.tex.A.clouds; u.uWetA = S.tex.A.wet
  }
  S.tex.B = next
  u.uLightB = light; u.uCloudB = clouds; u.uWetB = wet; u.uMix = 0
  S.fade = performance.now()
}
const redraw = () => { drawSky().catch(e => console.warn("[pendant-bridge] sky", e)) }

// ── hooks ──────────────────────────────────────────────────────
Hooks.once("init", () => {
  game.settings.register(MOD, "realmSky", {
    scope: "world", config: false, type: String, default: "off",
    onChange: () => {
      redraw()
      // The window linked to RealmScreen asks it for the current hour straight away.
      if (sender && skyMode() !== "off") { try { sender({ type: "sky.ask" }) } catch { /* not linked */ } }
    },
  })
})
Hooks.on("canvasReady", () => { S.root = null; S.mesh = null; S.sig = ""; redraw() })
Hooks.on("canvasTearDown", () => teardown())
Hooks.on("updateScene", (scene, changes) => {
  if (scene?.id !== canvas?.scene?.id) return
  if (changes?.flags?.[MOD] && "sky" in changes.flags[MOD]) redraw()
})
