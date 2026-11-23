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
// The switch, and (asked for) each scene's width / height — RealmScreen reads ground height for the forecast
// against the map picture's shape, which only the scene knows.
export function skyState(msg = {}) {
  const aspects = {}
  for (const id of Array.isArray(msg?.sceneIds) ? msg.sceneIds.slice(0, 50) : []) {
    const d = game.scenes?.get?.(id)?.dimensions
    if (d?.sceneWidth > 0 && d?.sceneHeight > 0) aspects[id] = d.sceneWidth / d.sceneHeight
  }
  return { mode: skyMode(), aspects }
}
export async function skySet(msg) {
  const scene = game.scenes?.get?.(msg?.sceneId)
  if (!scene) return { ok: false, error: "No such scene." }
  const s = msg?.sky || {}
  const ok = (v) => typeof v === "string" && v.startsWith("data:image/png;base64,")
  if (!ok(s.light) || !ok(s.clouds) || !ok(s.wet)) return { ok: false, error: "Bad sky." }
  // The wind down the map: up to 16 [east, north] pairs (RealmScreen sends 8); anything else is dropped.
  const wind = Array.isArray(s.wind) ? s.wind.slice(0, 16).filter(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)).map(p => [Number(p[0]), Number(p[1])]) : null
  // The forecast per 0.25° tile (RealmScreen lib/mapSkyFrame.mjs): `band` (the cloud each tile's forecast allows)
  // and `wet` at tile resolution, stretched over `box` (the tile grid's edges in the map's 0..1 coordinates).
  const box = Array.isArray(s.box) && s.box.length === 4 && s.box.every(Number.isFinite) ? s.box.map(Number) : null
  const band = ok(s.band) && box ? s.band : null
  await scene.setFlag(MOD, "sky", { at: { day: Number(s.at?.day) || 0, hour: Number(s.at?.hour) || 0 }, light: s.light, clouds: s.clouds, wet: s.wet, wind: wind?.length ? wind : null, band, box: band ? box : null })
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
precision highp float;
varying vec2 vUv;
uniform sampler2D uLightA, uLightB, uCloudA, uCloudB, uWetA, uWetB, uBandA, uBandB, uWetRA, uWetRB, uBandRA, uBandRB;
uniform vec4 uBox;
uniform vec2 uTiles;
uniform vec2 uTilePx;   // one forecast tile's width / height on screen (CSS px)
// The two frames are both read only during the 4 s cross-fade; otherwise just the current one (uMix is the
// same for every pixel, so the branch is free).
#define PAIR(A, B, uv) (uMix > 0.0 ? mix(texture2D(A, uv), texture2D(B, uv), uMix) : texture2D(A, uv))
uniform float uMix, uTime, uAspect, uPx, uZoom;
uniform vec2 uWind[8];
uniform vec2 uTexel;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}
float fbm3(vec2 p) { return 0.57 * noise(p) + 0.29 * noise(p * 2.03 + vec2(17.1, 9.2)) + 0.14 * noise(p * 4.1 + vec2(3.3, 7.7)); }
vec4 cl2(vec2 uv) { return PAIR(uCloudA, uCloudB, uv); }
// RealmScreen's cloud picture is only HOW MUCH cloud sits where (and its colour): blurred over ~2 texels so
// none of its pixel grain survives. The shapes come from the noise below.
vec4 coverAt(vec2 uv) {
  vec2 o = uTexel * 1.6;
  vec4 c = cl2(uv) * 0.2;
  c += (cl2(uv + vec2(o.x, 0.0)) + cl2(uv - vec2(o.x, 0.0)) + cl2(uv + vec2(0.0, o.y)) + cl2(uv - vec2(0.0, o.y))) * 0.12;
  c += (cl2(uv + o) + cl2(uv - o) + cl2(uv + vec2(o.x, -o.y)) + cl2(uv + vec2(-o.x, o.y))) * 0.08;
  return c;
}
// The prevailing wind here (east, north), from RealmScreen's wind belts, one value per eighth of the map down.
vec2 windAt(float v) {
  float fi = clamp(v * 8.0 - 0.5, 0.0, 7.0);
  vec2 w = vec2(0.0);
  for (int i = 0; i < 8; i++) w += uWind[i] * max(0.0, 1.0 - abs(fi - float(i)));
  return w;
}
// Clouds DRIFT with the wind (a flow map): two copies of the noise slide along it, each restarting every FLOW_T
// seconds while the other is at full strength, so they flow forever without the shear tearing them apart.
// The weather (how much cloud is where) stays put: clouds stream through a storm, they don't carry it away.
const float FLOW_T = 24.0, SPEED = 0.008;   // map widths per second: a cloud crosses its own width in ~18 s
// Domain-warped cloud noise; the warp is shared, only the detail drifts (q is computed once by the caller).
float shapeAt(vec2 mp, vec2 q) { return fbm(mp * 7.0 + q * 1.6); }
// Coverage 0..1 → how much of the noise becomes cloud (soft-edged, lumpy, never a blob).
float cloudOf(float cover, float n) { return smoothstep(1.02 - cover * 1.1, 1.24 - cover * 1.1, n); }
vec4 li2(vec2 uv) { return PAIR(uLightA, uLightB, uv); }
// The light grid is coarse (48×32) and its twilight runs through several hues: widened over ~3 cells so the
// terminator is a soft gradient, never a hard line or a rainbow stripe.
vec4 lightAt(vec2 uv) {
  vec2 o = vec2(3.0 / 48.0, 2.0 / 32.0);
  return li2(uv) * 0.24 + (li2(uv + vec2(o.x, 0.0)) + li2(uv - vec2(o.x, 0.0))) * 0.19 + (li2(uv + vec2(o.x * 2.0, 0.0)) + li2(uv - vec2(o.x * 2.0, 0.0))) * 0.1
       + (li2(uv + vec2(0.0, o.y)) + li2(uv - vec2(0.0, o.y))) * 0.09;
}
vec4 over(vec4 c, vec3 rgb, float a) { return vec4(rgb * a + c.rgb * (1.0 - a), a + c.a * (1.0 - a)); }
void main() {
  vec4 cv = coverAt(vUv);
  // The forecast for this spot's tile: rain / snow / storm, and how much cloud it allows (the cloud is held to it).
  // Zoomed in, each forecast tile (~17 miles) is read smoothly between tile centres — exactly its own forecast
  // at each centre, with the cloud's shapes (not square tile edges) drawing where one forecast gives way to the next. Zoomed out, where a tile is a few pixels, the regional copy (square cells, each an average of its tiles) shows
  // regional weather instead of a speckle of dice rolls.
  vec2 tl = (vUv - uBox.xy) / (uBox.zw - uBox.xy);
  float tmin = min(uTilePx.x, uTilePx.y);
  float pk = smoothstep(10.0, 22.0, tmin);
  // Smooth between tile centres, the lookup nudged by noise (under half a tile) so where one forecast gives way
  // to the next follows an organic line, never the tile grid. Each tile's centre still reads its own forecast.
  vec2 mpj = vUv * vec2(uAspect, 1.0);
  vec2 jit = vec2(noise(mpj * 220.0 + 2.7), noise(mpj * 220.0 + 9.1)) - 0.5;
  vec2 tuv = tl + jit * 1.1 / uTiles;
  // Zoomed out: the REGIONAL copy (square cells, each the true average of its tiles; made when the frame arrives).
  vec4 wetR = PAIR(uWetRA, uWetRB, tl);
  vec4 bndR = PAIR(uBandRA, uBandRB, tl);
  vec4 wet = wetR, bnd = bndR;
  if (pk > 0.0) {
    wet = mix(wetR, PAIR(uWetA, uWetB, tuv), pk);
    bnd = mix(bndR, PAIR(uBandA, uBandB, tuv), pk);
  }
  vec4 li = lightAt(vUv);
  float rain = wet.r, snow = wet.g, storm = wet.b;
  float cover = clamp(clamp(cv.a, bnd.r, bnd.g) * 1.05, 0.0, 1.0);
  vec2 mp = vUv * vec2(uAspect, 1.0);
  // Clear sky (and no shadow falling here): skip the noise — most of a fair-weather map costs next to nothing.
  float shCover = cl2(vUv + vec2(0.006, 0.009)).a;
  bool anyCloud = cover > 0.04;
  vec2 wnd = windAt(vUv.y) * vec2(1.0, -1.0) * SPEED;        // north is up the map
  float ph1 = fract(uTime / FLOW_T), ph2 = fract(uTime / FLOW_T + 0.5);
  vec2 o1 = -wnd * FLOW_T * (ph1 - 0.5), o2 = -wnd * FLOW_T * (ph2 - 0.5);
  float w1 = 1.0 - abs(2.0 * ph1 - 1.0), w2 = 1.0 - w1;
  float n = 0.0;
  if (anyCloud) {
    vec2 q = vec2(fbm3(mp * 3.0 + vec2(uTime * 0.003, 0.0)), fbm3(mp * 3.0 + vec2(5.2, 1.3) - vec2(0.0, uTime * 0.002)));
    n = shapeAt(mp + o1, q) * w1 + shapeAt(mp + o2, q) * w2;
    n = 0.5 + (n - 0.5) / sqrt(w1 * w1 + w2 * w2);              // blending two noises flattens them: put the contrast back
    // Close in, finer billows so a single tile's cloud has edges of its own (fades in with the forecast detail).
    if (pk > 0.0) n += (fbm3((mp + o1) * 200.0) - 0.5) * 0.4 * pk;
  }
  float cloud = anyCloud ? cloudOf(cover, n) : 0.0;
  vec3 base = cv.a > 0.001 ? cv.rgb / cv.a : vec3(1.0);
  base = mix(vec3(0.97, 0.98, 1.0), base, 0.65);                   // keep the type's tint, lose its flatness
  base = mix(vec3(0.93, 0.95, 0.98), base, 0.35 + 0.65 * storm);    // dark storm tint only where the forecast storms
  base *= 1.0 - 0.32 * rain * (1.0 - 0.75 * snow) - 0.25 * storm;   // rain decks grey, storm cores dark, snow stays pale
  base = mix(base, vec3(0.93, 0.95, 0.99), 0.35 * snow);
  // Texture inside the deck too: billows brighten, troughs dim and thin, so a full overcast is never one flat sheet.
  float billow = anyCloud ? fbm3((mp + o1) * 16.0) * w1 + fbm3((mp + o2) * 16.0 + 3.1) * w2 : 0.5;
  // Lit tops: the deck's own shape is brighter where it is thickest (cheap stand-in for a second lit sample).
  vec3 crgb = base * (0.8 + 0.14 * smoothstep(0.45, 0.8, n) + 0.22 * billow);
  // The clouds are under the same sky as the land: dim and tinted at night, not white sheets glowing in the dark.
  vec3 lrgb = li.a > 0.001 ? li.rgb / li.a : vec3(0.0);
  lrgb = mix(vec3(dot(lrgb, vec3(0.3, 0.59, 0.11))), lrgb, 0.85);   // twilight tints a touch calmer: a warm glow, not paint
  float dk = smoothstep(0.15, 0.75, li.a);
  crgb = mix(crgb, lrgb * 1.8, 0.25 * dk) * (1.0 - 0.72 * dk);
  vec3 dropRgb = vec3(0.8, 0.85, 0.92) * (1.0 - 0.6 * dk);
  float ca = cloud * mix(0.42, 0.84, smoothstep(0.35, 0.95, cover)) * mix(0.72, 1.0, smoothstep(0.3, 0.68, billow));
  vec4 c = vec4(0.0);
  // The shadow: the cloud's cover a little down-right, shaped by cheap noise (it is soft and dim; nobody reads its edge).
  vec2 so = vec2(0.006 * uAspect, 0.009);
  float sh = shCover > 0.04 ? cloudOf(shCover, fbm3((mp + so + o1) * 7.0) * w1 + fbm3((mp + so + o2) * 7.0) * w2) : 0.0;
  c = over(c, vec3(0.03, 0.04, 0.07), sh * 0.2 * (1.0 - cloud));
  c = over(c, crgb, ca);
  // Zoomed out, rain and snow show as the deck's colour (grey / pale); falling rain and flakes come in as you
  // zoom in (a world map full of screen-sized flakes reads as stars).
  float near = smoothstep(2.0, 5.0, uZoom);
  float wetRain = rain * (1.0 - snow);
  if (wetRain > 0.03) {
    if (near > 0.01) {
      vec2 sp = gl_FragCoord.xy / uPx;
      vec2 rp = vec2(sp.x + sp.y * 0.22, sp.y);
      float col = floor(rp.x / 3.0);
      float h = hash(vec2(col, 1.7));
      float y = (rp.y + uTime * (620.0 + 380.0 * h) + h * 900.0) / 150.0;
      float on = step(1.0 - wetRain * 0.45, hash(vec2(col, floor(y))));
      float t = fract(y);
      float streak = smoothstep(0.0, 0.03, t) * (1.0 - smoothstep(0.03, 0.16, t)) * (1.0 - abs(fract(rp.x / 3.0) - 0.5) * 2.0);
      c = over(c, dropRgb, streak * on * (0.2 + 0.3 * wetRain) * near);
    }
  }
  float sa = snow * rain;
  if (sa > 0.03 && near > 0.01) {
    vec2 sp = gl_FragCoord.xy / uPx;
    vec2 q = sp + vec2(sin(uTime * 0.6 + sp.y * 0.02) * 7.0, uTime * 34.0);
    vec2 cell = floor(q / 22.0);
    vec2 f = fract(q / 22.0) - 0.5 - (vec2(hash(cell), hash(cell + 4.3)) - 0.5) * 0.55;
    float r = 0.06 + 0.07 * hash(cell + 7.7);
    float flake = (1.0 - smoothstep(r * 0.45, r, length(f))) * step(1.0 - sa * 0.6, hash(cell + 9.1));
    c = over(c, vec3(1.0) * (1.0 - 0.55 * dk), flake * 0.75 * near);
  }
  // The time of day over all of it (capped so a moonless night stays readable at the table).
  c = over(c, lrgb, min(li.a, 0.7));
  // Lightning lights a patch of the storm deck from inside, now and then.
  if (storm > 0.4) {
    vec2 g = vUv * vec2(8.0 * uAspect, 8.0);
    vec2 cid = floor(g);
    float ph = uTime * 1.6 + hash(cid) * 11.0;
    float strike = step(0.9, hash(cid + floor(ph)));
    float k = fract(ph);
    float flash = strike * (1.0 - smoothstep(0.0, 0.22, k)) * (0.55 + 0.45 * step(0.45, fract(k * 14.0)));
    vec2 at = fract(g) - 0.5 - (vec2(hash(cid + 1.3), hash(cid + 2.9)) - 0.5) * 0.5;
    float glow = 1.0 - smoothstep(0.0, 0.55, length(at));
    float a = flash * glow * glow * smoothstep(0.4, 0.75, storm) * cloud * 0.8;
    c = vec4(c.rgb + vec3(0.82, 0.88, 1.0) * a, max(c.a, a));
  }
  gl_FragColor = c;
}`

// ── drawing ────────────────────────────────────────────────────
const S = { wind: null, box: [0, 0, 1, 1], root: null, mesh: null, tex: { A: null, B: null }, sig: "", fade: null, tick: null, t0: 0, load: 0 }

function loadTex(src) {
  return new Promise((res) => {
    const img = new Image()
    img.onload = () => { try { res(PIXI.Texture.from(img)) } catch { res(null) } }
    img.onerror = () => res(null)
    img.src = src
  })
}
// 8 rows of [east, north] for the shader; an older frame with no wind gets a gentle westerly.
function windUniform(rows) {
  const out = new Float32Array(16)
  for (let i = 0; i < 8; i++) {
    const r = Array.isArray(rows) && rows.length ? rows[Math.min(rows.length - 1, Math.floor(i * rows.length / 8))] : [0.9, 0.1]
    out[i * 2] = Number(r?.[0]) || 0; out[i * 2 + 1] = Number(r?.[1]) || 0
  }
  return out
}
const destroySet = (t) => {
  if (!t) return
  const seen = new Set()
  for (const k of ["light", "clouds", "wet", "band", "wetR", "bandR"]) {
    const x = t[k]
    if (!x || x === _noBand || seen.has(x)) continue
    seen.add(x)
    try { x.destroy(true) } catch { /* gone */ }
  }
}
// A forecast texture's REGIONAL copy: square cells on the map (~1/96 of its width), each the true average of the
// tiles under it (the browser's high-quality downscale). Zoomed out, the forecast reads as regional weather — how
// much of an area is cloudy, wet, snowy — instead of a speckle of 17-mile dice rolls.
function regional(tex, box) {
  try {
    const img = tex?.baseTexture?.resource?.source
    if (!img?.width) return tex
    const d = canvas.dimensions
    const bw = (box[2] - box[0]) * (d?.sceneWidth || 1), bh = (box[3] - box[1]) * (d?.sceneHeight || 1)
    const cw = Math.min(img.width, 96), ch = Math.max(2, Math.min(img.height, Math.round(cw * bh / bw)))
    if (cw >= img.width && ch >= img.height) return tex
    const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch
    const g = cv.getContext("2d"); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"
    g.drawImage(img, 0, 0, cw, ch)
    return PIXI.Texture.from(cv)
  } catch { return tex }
}
// The forecast textures' size in tiles (wet is the same grid as band; an old frame's wet is the cloud grid).
const tilesOf = (t) => [Math.max(1, t?.wet?.width || 1), Math.max(1, t?.wet?.height || 1)]
// A frame with no forecast (no planet world) holds nothing back: lowest 0, highest 1.
let _noBand = null
const noBand = () => (_noBand ||= PIXI.Texture.fromBuffer(new Uint8Array([0, 255, 0, 255]), 1, 1))

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
    uLightA: t.light, uLightB: t.light, uCloudA: t.clouds, uCloudB: t.clouds, uWetA: t.wet, uWetB: t.wet, uBandA: t.band, uBandB: t.band, uWetRA: t.wetR, uWetRB: t.wetR, uBandRA: t.bandR, uBandRB: t.bandR, uBox: S.box, uTiles: tilesOf(t), uTilePx: [100, 100],
    uMix: 0, uTime: 0, uAspect: h > 0 ? w / h : 1, uPx: 1, uZoom: 1, uWind: windUniform(S.wind), uTexel: [1 / (t.clouds.width || 160), 1 / (t.clouds.height || 100)],
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
    // One forecast tile's size on screen (CSS px), for the zoomed-in / zoomed-out look of the tiles.
    const sw = canvas.dimensions?.sceneWidth, shh = canvas.dimensions?.sceneHeight, k = canvas.stage?.scale?.x || 1
    if (u.uTiles?.[0] > 0 && sw && shh) u.uTilePx = [sw * ((u.uBox?.[2] ?? 1) - (u.uBox?.[0] ?? 0)) / u.uTiles[0] * k, shh * ((u.uBox?.[3] ?? 1) - (u.uBox?.[1] ?? 0)) / u.uTiles[1] * k]
    // Map zoom (1 = the whole scene fits the screen): rain and flakes fall only once you're in close.
    const scr = canvas.app?.renderer?.screen, dd = canvas.dimensions
    if (scr && dd?.sceneWidth) u.uZoom = (canvas.stage?.scale?.x || 1) / Math.min(scr.width / dd.sceneWidth, scr.height / dd.sceneHeight)
    if (S.fade) {
      const k = Math.min(1, (now - S.fade) / FADE_MS)
      u.uMix = k
      if (k >= 1) {                                            // B is the picture now: drop the old one
        const old = S.tex.A
        S.tex.A = S.tex.B; S.fade = null
        u.uLightA = S.tex.A.light; u.uCloudA = S.tex.A.clouds; u.uWetA = S.tex.A.wet; u.uBandA = S.tex.A.band; u.uWetRA = S.tex.A.wetR; u.uBandRA = S.tex.A.bandR; u.uMix = 0
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
  const sig = `${scene.id}|${sky.at?.day}|${sky.at?.hour}|${sky.clouds.length}|${sky.light.length}|${sky.band?.length || 0}|${sky.wet.length}`
  if (sig === S.sig && S.root && !S.root.destroyed) return
  const my = ++S.load
  const [light, clouds, wet, bandTex] = await Promise.all([loadTex(sky.light), loadTex(sky.clouds), loadTex(sky.wet), sky.band ? loadTex(sky.band) : null])
  const band = bandTex || noBand()
  const box = Array.isArray(sky.box) && sky.band ? sky.box : [0, 0, 1, 1]
  const bandR = bandTex ? regional(bandTex, box) : band, wetR = sky.band ? regional(wet, box) : wet
  if (my !== S.load || !light || !clouds || !wet) { destroySet({ light, clouds, wet, band, bandR, wetR }); return }
  S.sig = sig
  S.wind = sky.wind || null
  S.box = box
  const next = { light, clouds, wet, band, wetR, bandR }
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
    u.uLightA = S.tex.A.light; u.uCloudA = S.tex.A.clouds; u.uWetA = S.tex.A.wet; u.uBandA = S.tex.A.band; u.uWetRA = S.tex.A.wetR; u.uBandRA = S.tex.A.bandR
  }
  S.tex.B = next
  u.uLightB = light; u.uCloudB = clouds; u.uWetB = wet; u.uBandB = band; u.uWetRB = wetR; u.uBandRB = bandR; u.uBox = S.box; u.uTiles = tilesOf(next); u.uMix = 0
  u.uWind = windUniform(S.wind)
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
