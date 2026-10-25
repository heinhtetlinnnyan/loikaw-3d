import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------- travel modes ----------
const MODES = {
  walk: { eye: 1.65, speed: 1.5, run: 4.5, label: 'Walking' },
  // ride: accel = speeding up, coast = slowing when you let go, brake = S key
  bike: { eye: 1.55, speed: 5.0, run: 8.0, label: 'Cycling', ride: { accel: 2.2, coast: 0.6, brake: 6, lean: 0.03 } },
  moto: { eye: 1.35, speed: 11.1, run: 19.4, label: 'Riding', ride: { accel: 4.5, coast: 1.5, brake: 10, lean: 0.022 } },
  fly:  { eye: 60,   speed: 25,  run: 90,  label: 'Flying' },
};
const ROAD_W = { trunk: 9, primary: 8, secondary: 7, tertiary: 6.5, unclassified: 5, residential: 4.5, service: 3, track: 2.6, footway: 1.6, path: 1.4 };
const ROAD_C = { trunk: 0x6b6560, primary: 0x6b6560, tertiary: 0x77706a, unclassified: 0x837b72, residential: 0x8a8278, service: 0x948b80, track: 0x9b7f5e, footway: 0xa89a86, path: 0xa0805c };

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const SKY = new THREE.Color(0xb9cbd8);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 400, 4200);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 9000);
camera.rotation.order = 'YXZ';

const hemi = new THREE.HemisphereLight(0xdfe9f2, 0x5b5040, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
sun.position.set(-1200, 1600, 600);
scene.add(sun);
const moon = new THREE.DirectionalLight(0x9fb4e0, 0);
scene.add(moon);

// ---------- data ----------
const data = await (await fetch('data/loikaw.json')).json();
const T = data.terrain;
const H = new Float32Array(T.d.length);
for (let i = 0; i < T.d.length; i++) H[i] = T.d[i] / 10; // metres above T.base
const BASE = T.base;

function ground(x, z) {
  let fx = (x - T.x0) / T.step, fz = (z - T.z0) / T.step;
  fx = Math.max(0, Math.min(T.w - 1.001, fx));
  fz = Math.max(0, Math.min(T.h - 1.001, fz));
  const i = fx | 0, j = fz | 0, dx = fx - i, dz = fz - j, w = T.w;
  return H[j * w + i] * (1 - dx) * (1 - dz) + H[j * w + i + 1] * dx * (1 - dz)
       + H[(j + 1) * w + i] * (1 - dx) * dz + H[(j + 1) * w + i + 1] * dx * dz;
}
// bridge decks you can walk and ride on, above whatever the terrain does underneath
const decks = [];
function deckAt(x, z) {
  for (const d of decks) {
    const t = ((x - d.ax) * d.ux + (z - d.az) * d.uz), off = Math.abs((x - d.ax) * -d.uz + (z - d.az) * d.ux);
    if (t >= 0 && t <= d.len && off <= d.w / 2) return d.y0 + (d.y1 - d.y0) * t / d.len;
  }
  return -Infinity;
}
const X1 = T.x0 + (T.w - 1) * T.step, Z1 = T.z0 + (T.h - 1) * T.step;

// ---------- terrain mesh ----------
{
  const g = new THREE.PlaneGeometry(X1 - T.x0, Z1 - T.z0, T.w - 1, T.h - 1);
  g.rotateX(-Math.PI / 2);
  g.translate((T.x0 + X1) / 2, 0, (T.z0 + Z1) / 2);
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3);
  const low = new THREE.Color(0x7d8f55), mid = new THREE.Color(0x5f7a45), high = new THREE.Color(0x8a7a5c), c = new THREE.Color();
  let hmax = 0; for (const v of H) hmax = Math.max(hmax, v);
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), z = pos.getZ(k), y = ground(x, z);
    pos.setY(k, y);
    const t = y / hmax;
    c.copy(low).lerp(mid, Math.min(1, t * 2.2)).lerp(high, Math.max(0, t - 0.55) * 1.8);
    const n = (Math.sin(x * 0.07) * Math.cos(z * 0.05) + Math.sin(x * 0.013 + z * 0.017)) * 0.03;
    col.set([c.r + n, c.g + n, c.b + n * 0.5], k * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true })));
}

// ---------- ribbons (roads, rivers) draped on terrain ----------
function ribbon(p, width, lift, out) {
  // densify every ~8 m so the ribbon follows the ground
  const pts = [];
  for (let i = 0; i < p.length - 2; i += 2) {
    const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 8));
    for (let s = 0; s < n; s++) pts.push([ax + (bx - ax) * s / n, az + (bz - az) * s / n]);
  }
  pts.push([p[p.length - 2], p[p.length - 1]]);
  if (pts.length < 2) return;
  const start = out.pos.length / 3;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const nx = -dz * width / 2, nz = dx * width / 2, [x, z] = pts[i];
    out.pos.push(x + nx, ground(x + nx, z + nz) + lift, z + nz, x - nx, ground(x - nx, z - nz) + lift, z - nz);
    out.col.push(...out.c, ...out.c);
    if (i > 0) { const k = start + (i - 1) * 2; out.idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
}
function ribbonMesh(items, widthOf, colorOf, lift, order) {
  const out = { pos: [], col: [], idx: [], c: [0, 0, 0] };
  for (const it of items) { const c = new THREE.Color(colorOf(it)); out.c = [c.r, c.g, c.b]; ribbon(it.p, widthOf(it), lift(it), out); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3));
  g.setIndex(out.idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -order, polygonOffsetUnits: -order }));
  scene.add(m);
}
const roadRank = (t) => ['path', 'footway', 'track', 'service', 'residential', 'unclassified', 'tertiary', 'secondary', 'primary', 'trunk'].indexOf(t);
const roadsSorted = [...data.roads].sort((a, b) => roadRank(a.t) - roadRank(b.t));
ribbonMesh(roadsSorted, (r) => ROAD_W[r.t] ?? 4, (r) => ROAD_C[r.t] ?? 0x8a8278, (r) => 0.25 + roadRank(r.t) * 0.01, 2);
ribbonMesh(data.waterLines, (w) => (w.t === 'river' ? 28 : w.t === 'canal' ? 5 : 3), () => 0x4f7f95, () => 0.15, 1);

// ---------- flat polygons (lakes, green areas) ----------
function flatPolys(list, color, lift) {
  const gs = [];
  for (const a of list) {
    const pts = []; let ymin = Infinity;
    for (let i = 0; i < a.p.length; i += 2) { pts.push(new THREE.Vector2(a.p[i], -a.p[i + 1])); ymin = Math.min(ymin, ground(a.p[i], a.p[i + 1])); }
    if (pts.length < 3) continue;
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts));
    g.rotateX(-Math.PI / 2);
    // drape each vertex unless it's water (water stays level)
    const pos = g.attributes.position;
    for (let k = 0; k < pos.count; k++) pos.setY(k, lift < 0.2 ? ymin + 0.4 : ground(pos.getX(k), pos.getZ(k)) + lift);
    gs.push(g);
  }
  if (!gs.length) return;
  const g = mergeGeometries(gs); g.computeVertexNormals();
  scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
}
flatPolys(data.waterAreas, 0x4f7f95, 0.1);
flatPolys(data.green, 0x6f9a4c, 0.2);

// ---------- buildings ----------
// cheap deterministic random so the town looks the same on every visit
const rand = (s) => { s = Math.sin(s * 12.9898) * 43758.5453; return s - Math.floor(s); };
const maxAniso = renderer.capabilities.getMaxAnisotropy();

// Facade textures, painted on canvases. One tile = 4 m wide x 7 m tall:
// a 0.6 m plinth, then two 3.2 m storeys. Taller buildings repeat it.
// Each style also gets an "emissive" twin where some window panes glow at night.
const TILE_W = 4, TILE_H = 7;
function facade(draw) {
  const W = 256, H = 448, px = W / TILE_W; // 64 px per metre
  const day = document.createElement('canvas'), nightC = document.createElement('canvas');
  day.width = nightC.width = W; day.height = nightC.height = H;
  const d = day.getContext('2d'), n = nightC.getContext('2d');
  n.fillStyle = '#000'; n.fillRect(0, 0, W, H);
  // y in metres from the bottom of the tile
  const R = (x, y, w, h) => [x * px, H - (y + h) * px, w * px, h * px];
  let lit = 0;
  const api = {
    fill(c, x, y, w, h) { d.fillStyle = c; d.fillRect(...R(x, y, w, h)); },
    window(x, y, w, h, frame, glass, bars) {
      api.fill(frame, x - 0.08, y - 0.08, w + 0.16, h + 0.16);
      api.fill(glass, x, y, w, h);
      api.fill('rgba(255,255,255,.18)', x, y + h * 0.55, w, h * 0.12);
      if (bars) for (let i = 1; i < 5; i++) api.fill('rgba(30,30,30,.55)', x + w * i / 5 - 0.02, y, 0.04, h);
      api.fill(frame, x + w / 2 - 0.03, y, 0.06, h);
      if (rand(++lit * 7.1) > 0.45) { n.fillStyle = '#ffcf8a'; n.fillRect(...R(x, y, w, h)); }
    },
    shutters(x, y, w, h, c) { api.fill(c, x - 0.42, y, 0.38, h); api.fill(c, x + w + 0.04, y, 0.38, h); for (let i = 0; i < 6; i++) { api.fill('rgba(0,0,0,.18)', x - 0.42, y + h * i / 6, 0.38, 0.03); api.fill('rgba(0,0,0,.18)', x + w + 0.04, y + h * i / 6, 0.38, 0.03); } },
    noise(alpha) { for (let i = 0; i < 2500; i++) { const v = (Math.random() * 60) | 0; d.fillStyle = `rgba(${v},${v},${v},${alpha})`; d.fillRect(Math.random() * W, Math.random() * H, 2, 2); } },
    ctx: d,
  };
  draw(api);
  const tex = (c) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso; t.colorSpace = THREE.SRGBColorSpace; return t; };
  return { map: tex(day), emissiveMap: tex(nightC) };
}
const FACADES = {
  // painted plaster house: door and barred window below, two windows above
  house: facade((f) => {
    f.fill('#f4f1ea', 0, 0, 4, 7); f.noise(0.05);
    f.fill('#9a958c', 0, 0, 4, 0.6);
    f.fill('#6b4a2e', 0.5, 0.6, 1.0, 2.2); f.fill('#5a3d25', 0.55, 0.65, 0.42, 2.1); f.fill('#5a3d25', 1.03, 0.65, 0.42, 2.1);
    f.window(2.3, 1.5, 1.1, 1.1, '#e8e4dc', '#3b4a55', true); f.shutters(2.3, 1.5, 1.1, 1.1, '#3f7f9a');
    f.fill('#d9d4ca', 0, 3.75, 4, 0.12);
    f.window(0.7, 4.6, 1.0, 1.2, '#e8e4dc', '#3b4a55', false); f.window(2.4, 4.6, 1.0, 1.2, '#e8e4dc', '#3b4a55', false);
  }),
  // shophouse: rolling steel shutter and signboard, balcony and windows above
  shop: facade((f) => {
    f.fill('#f2efe8', 0, 0, 4, 7); f.noise(0.05);
    f.fill('#8c8780', 0, 0, 4, 0.6);
    f.fill('#a7aaad', 0.25, 0.6, 3.5, 2.5);
    for (let y = 0.6; y < 3.1; y += 0.09) f.fill('rgba(60,60,60,.35)', 0.25, y, 3.5, 0.025);
    f.fill('#2d5fa0', 0.1, 3.1, 3.8, 0.55);
    for (let i = 0; i < 5; i++) f.fill('rgba(255,255,255,.85)', 0.4 + i * 0.68, 3.28, 0.45, 0.18);
    f.window(0.5, 4.5, 1.2, 1.4, '#e3dfd6', '#34434e', false); f.window(2.3, 4.5, 1.2, 1.4, '#e3dfd6', '#34434e', false);
    f.fill('#5f6366', 0.2, 4.2, 3.6, 0.08); for (let x = 0.25; x < 3.8; x += 0.18) f.fill('#5f6366', x, 4.2, 0.03, 0.8); f.fill('#5f6366', 0.2, 4.95, 3.6, 0.06);
  }),
  // teak plank house with shuttered windows
  wood: facade((f) => {
    f.fill('#a7744a', 0, 0, 4, 7);
    for (let y = 0; y < 7; y += 0.22) { f.fill(`rgba(${60 + (Math.random() * 30) | 0},35,15,.25)`, 0, y, 4, 0.2); f.fill('rgba(40,22,10,.55)', 0, y, 4, 0.025); }
    f.fill('#5d564c', 0, 0, 4, 0.6);
    f.window(1.4, 1.4, 1.1, 1.0, '#6e4528', '#2c2a26', true); f.shutters(1.4, 1.4, 1.1, 1.0, '#7d5232');
    f.window(1.4, 4.6, 1.1, 1.0, '#6e4528', '#2c2a26', false); f.shutters(1.4, 4.6, 1.1, 1.0, '#7d5232');
  }),
  // concrete institutional block: bands of windows on every floor
  block: facade((f) => {
    f.fill('#ece6d6', 0, 0, 4, 7); f.noise(0.04);
    f.fill('#9e978a', 0, 0, 4, 0.6);
    f.fill('#d8cfbb', 0, 3.6, 4, 0.25);
    for (const y of [1.3, 4.5]) { f.window(0.4, y, 1.3, 1.5, '#cfc8b8', '#3e5260', false); f.window(2.3, y, 1.3, 1.5, '#cfc8b8', '#3e5260', false); }
  }),
};
const STYLE_NAMES = Object.keys(FACADES);
const wallMats = STYLE_NAMES.map((k) => new THREE.MeshLambertMaterial({ map: FACADES[k].map, emissiveMap: FACADES[k].emissiveMap, emissive: 0xffffff, emissiveIntensity: 0, vertexColors: true }));
// corrugated metal sheet for pitched roofs, plain concrete for flat ones
const corrugated = (() => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d');
  for (let i = 0; i < 64; i++) { const v = 200 + 55 * Math.sin(i / 64 * Math.PI * 8); x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect(i, 0, 1, 64); }
  x.fillStyle = 'rgba(0,0,0,.12)'; x.fillRect(0, 62, 64, 2);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso; t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const roofMat = new THREE.MeshLambertMaterial({ map: corrugated, vertexColors: true, side: THREE.DoubleSide });
const flatRoofMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

// paint and roof colours seen in photos of Loikaw: lots of blue, green and rusty-red tin roofs
const PAINT = [0xffffff, 0xf3ead8, 0xe9efe9, 0xf2e2c4, 0xdde6ee, 0xf1d9cf, 0xe4ecd2];
const ROOFS = [0x3f6fa8, 0x3d8a6a, 0x9a4a35, 0x8a9097, 0x7d2e2a, 0x4f8f95, 0xa65a3c, 0x6d7a84];

// main roads, for placing shophouses along them
const MAIN = new Set();
for (const r of data.roads) {
  if (roadRank(r.t) < 5) continue;
  for (let i = 0; i < r.p.length - 2; i += 2) {
    const ax = r.p[i], az = r.p[i + 1], bx = r.p[i + 2], bz = r.p[i + 3], n = Math.ceil(Math.hypot(bx - ax, bz - az) / 5) + 1;
    for (let s = 0; s <= n; s++) MAIN.add(`${Math.round((ax + (bx - ax) * s / n) / 10)},${Math.round((az + (bz - az) * s / n) / 10)}`);
  }
}
const nearMain = (x, z) => { for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) if (MAIN.has(`${Math.round(x / 10) + dx},${Math.round(z / 10) + dz}`)) return true; return false; };

const buckets = { walls: STYLE_NAMES.map(() => ({ pos: [], uv: [], col: [] })), roof: { pos: [], uv: [], col: [] }, flat: { pos: [], uv: [], col: [] } };
const tri = (B, a, b, c, ua, ub, uc, col) => {
  B.pos.push(...a, ...b, ...c);
  B.uv.push(...ua, ...ub, ...uc);
  B.col.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
};
const toLocal = (lat, lon) => [(lon - data.origin[1]) * 111320 * Math.cos(data.origin[0] * Math.PI / 180), -(lat - data.origin[0]) * 110540];
// the clock tower stands on a roundabout: keep satellite-traced footprints off it
const [CLX, CLZ] = toLocal(19.67717, 97.21201);
// Myo Nan Pagoda's platform is in the satellite footprints; it's drawn as a pagoda instead of a house
const [MNX, MNZ] = toLocal(19.677785, 97.211291);
let myoNanPlatform = null;
const footprints = []; // for collision
let estimated = 0;
const INSTITUTION = new Set(['school', 'hospital', 'university', 'stadium', 'grandstand', 'train_station', 'church', 'college', 'government', 'office', 'commercial']);

data.buildings.forEach((b, n) => {
  const p = b.p, m = p.length / 2;
  if (m < 3) return;
  let ymin = Infinity, cx = 0, cz = 0, area = 0;
  for (let i = 0; i < m; i++) {
    const x = p[i * 2], z = p[i * 2 + 1], x2 = p[((i + 1) % m) * 2], z2 = p[((i + 1) % m) * 2 + 1];
    ymin = Math.min(ymin, ground(x, z)); cx += x; cz += z; area += x * z2 - x2 * z;
  }
  cx /= m; cz /= m; area /= 2;
  if (Math.hypot(cx - CLX, cz - CLZ) < 9) return;
  if (Math.hypot(cx - MNX, cz - MNZ) < 8 && m > 6) { myoNanPlatform = p; return; }
  // walls must wind so their faces point outwards
  const order = [...Array(m).keys()]; if (area > 0) order.reverse();
  area = Math.abs(area);

  let style = 'house', h = b.h;
  if ((b.s === 'osm' && INSTITUTION.has(b.k)) || area > 1500) style = 'block';
  else if (nearMain(cx, cz) && area < 450) style = 'shop';
  else if (rand(n + 31) < 0.3) style = 'wood';
  if (!h) {
    estimated++;
    const floors = style === 'shop' ? (rand(n + 1) < 0.6 ? 2 : 3) : style === 'block' ? 2 + (rand(n + 1) * 2 | 0) : rand(n + 1) < 0.22 ? 2 : 1;
    h = floors * 3.2 + 0.4 + rand(n + 3) * 0.4;
  }
  const top = ymin + h, bot = ymin - 0.6;
  const paint = new THREE.Color(style === 'wood' ? 0xffffff : PAINT[(rand(n + 11) * PAINT.length) | 0]);
  const roofC = new THREE.Color(ROOFS[(rand(n + 13) * ROOFS.length) | 0]).multiplyScalar(0.85 + rand(n + 14) * 0.3);

  // walls: one quad per edge; u fits a whole number of 4 m bays, v climbs the storeys
  const W = buckets.walls[STYLE_NAMES.indexOf(style)];
  for (let k = 0; k < m; k++) {
    const i = order[k], j = order[(k + 1) % m];
    const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az); if (len < 0.2) continue;
    const u1 = Math.max(1, Math.round(len / TILE_W)) * (len < 2.5 ? 0.5 : 1), v1 = (top - bot) / TILE_H;
    const A0 = [ax, bot, az], B0 = [bx, bot, bz], B1 = [bx, top, bz], A1 = [ax, top, az];
    tri(W, A0, B0, B1, [0, 0], [u1, 0], [u1, v1], paint);
    tri(W, A0, B1, A1, [0, 0], [u1, v1], [0, v1], paint);
  }

  // roof: a hipped tin roof on four-cornered buildings, flat concrete otherwise
  if (m === 4 && style !== 'block' && area < 900) {
    // fit a rectangle: long axis from the longest edge
    let best = 0, ux = 1, uz = 0;
    for (let i = 0; i < 4; i++) { const dx = p[((i + 1) % 4) * 2] - p[i * 2], dz = p[((i + 1) % 4) * 2 + 1] - p[i * 2 + 1], L = Math.hypot(dx, dz); if (L > best) { best = L; ux = dx / L; uz = dz / L; } }
    const vx = -uz, vz = ux;
    let L = 0, Wd = 0; for (let i = 0; i < 4; i++) { const dx = p[i * 2] - cx, dz = p[i * 2 + 1] - cz; L = Math.max(L, Math.abs(dx * ux + dz * uz)); Wd = Math.max(Wd, Math.abs(dx * vx + dz * vz)); }
    const o = 0.5, Lo = L + o, Wo = Wd + o, rise = Math.min(Wd * 0.55, 3.5), ridge = Math.max(L - Wd, 0) * (rand(n + 41) < 0.35 ? 1.25 : 1);
    const P = (a, b, y) => [cx + ux * a + vx * b, y, cz + uz * a + vz * b];
    const c1 = P(-Lo, -Wo, top), c2 = P(Lo, -Wo, top), c3 = P(Lo, Wo, top), c4 = P(-Lo, Wo, top);
    const r1 = P(-Math.min(ridge, Lo), 0, top + rise), r2 = P(Math.min(ridge, Lo), 0, top + rise);
    const s = 1.6, sl = Math.hypot(Wo, rise) / s, el = Math.hypot(Lo - Math.min(ridge, Lo), rise) / s;
    tri(buckets.roof, c1, c2, r2, [-Lo / s, 0], [Lo / s, 0], [ridge / s, sl], roofC); tri(buckets.roof, c1, r2, r1, [-Lo / s, 0], [ridge / s, sl], [-ridge / s, sl], roofC);
    tri(buckets.roof, c3, c4, r1, [-Lo / s, 0], [Lo / s, 0], [ridge / s, sl], roofC); tri(buckets.roof, c3, r1, r2, [-Lo / s, 0], [ridge / s, sl], [-ridge / s, sl], roofC);
    tri(buckets.roof, c2, c3, r2, [-Wo / s, 0], [Wo / s, 0], [0, el], roofC);
    tri(buckets.roof, c4, c1, r1, [-Wo / s, 0], [Wo / s, 0], [0, el], roofC);
  } else {
    const contour = []; for (let i = 0; i < m; i++) contour.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
    const flatC = new THREE.Color(0xb9b4aa).multiplyScalar(0.85 + rand(n + 15) * 0.2);
    for (const [a, b2, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      tri(buckets.flat, [p[a * 2], top, p[a * 2 + 1]], [p[b2 * 2], top, p[b2 * 2 + 1]], [p[c * 2], top, p[c * 2 + 1]], [0, 0], [0, 0], [0, 0], flatC);
    }
  }

  let r = 0; for (let i = 0; i < m; i++) r = Math.max(r, Math.hypot(p[i * 2] - cx, p[i * 2 + 1] - cz));
  footprints.push({ p, cx, cz, r, top, base: ymin, name: b.n, kind: b.k });
});
const bucketMesh = (B, mat) => {
  if (!B.pos.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
  g.computeVertexNormals();
  scene.add(new THREE.Mesh(g, mat));
};
buckets.walls.forEach((B, i) => bucketMesh(B, wallMats[i]));
bucketMesh(buckets.roof, roofMat);
bucketMesh(buckets.flat, flatRoofMat);

// ---------- Taung Kwe Pagoda ----------
// Modelled on photos: a wide, flat-topped grey limestone crag with the main gilded
// stupa on top, smaller stupas and blue-roofed halls around it, and a tall white
// lift tower crowned by a tiered gold pyatthat roof.
const [TKX, TKZ] = toLocal(19.6675, 97.2081);
// Burmese stupa profile: terraces, bell, bands, lotus, banana bud
const prof = [[0, 0], [3, 0], [3, .8], [2.6, .8], [2.6, 1.6], [2.2, 1.6], [2.2, 2.4], [2.05, 2.6], [2.15, 3.3], [2, 4], [1.7, 4.6], [1.2, 5], [1.05, 5.2], [.95, 5.6], [.7, 5.8], [.8, 6], [.5, 6.4], [.46, 6.8], [.32, 7.4], [.14, 7.9], [.05, 8.3], [0, 8.4]];
const stupaGeo = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 32);
const gold = new THREE.MeshStandardMaterial({ color: 0xd9a92e, metalness: 0.55, roughness: 0.32, emissive: 0x6a4708, emissiveIntensity: 0 });
{
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x8e8a83, flatShading: true });
  const white = new THREE.MeshLambertMaterial({ color: 0xf2eee6 });
  const blue = new THREE.MeshLambertMaterial({ color: 0x3f6fa8 });
  const green = new THREE.MeshLambertMaterial({ color: 0x3d8a6a });
  const g0 = ground(TKX, TKZ), ROCK_H = 30;
  const tk = new THREE.Group(); tk.position.set(TKX, g0 - 3, TKZ); scene.add(tk);
  // the crag: a tapered cylinder pushed in and out to make cliffs and gullies
  {
    const g = new THREE.CylinderGeometry(24, 33, ROCK_H + 3, 40, 10), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(z, x), t = (y + (ROCK_H + 3) / 2) / (ROCK_H + 3);
      const k = 1 + 0.16 * Math.sin(a * 7 + 1.3) + 0.1 * Math.sin(a * 13 + y * 0.25) + 0.07 * Math.cos(a * 23 - y * 0.6);
      const top = t > 0.98 ? 0.6 * Math.sin(a * 5) : 0;
      p.setXYZ(i, x * k, y + top, z * k * 0.68);
    }
    g.translate(0, (ROCK_H + 3) / 2, 0);
    g.computeVertexNormals();
    tk.add(new THREE.Mesh(g, rockMat));
  }
  const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); tk.add(mesh); return mesh; };
  const T0 = ROCK_H + 3;
  add(new THREE.Mesh(new THREE.BoxGeometry(34, 1.2, 18), white), 0, T0 + 0.6, 0); // the terrace
  const stupa = (x, y, z, s) => {
    add(new THREE.Mesh(new THREE.BoxGeometry(7 * s, 1.2 * s, 7 * s), white), x, y + 0.6 * s, z);
    add(new THREE.Mesh(stupaGeo, gold), x, y + 1.2 * s, z).scale.setScalar(s);
    add(new THREE.Mesh(new THREE.ConeGeometry(0.4 * s, 1.1 * s, 12), gold), x, y + 1.2 * s + 8.8 * s, z);
  };
  stupa(2, T0 + 1.2, -1, 1.9);                       // main stupa
  for (const [x, z] of [[-11, -5], [13, 5], [-6, 6], [9, -6]]) stupa(x, T0 + 1.2, z, 0.55);
  // hall with a blue tin roof, and a green-roofed one
  const hall = (x, z, w, d, mat) => {
    add(new THREE.Mesh(new THREE.BoxGeometry(w, 3, d), white), x, T0 + 2.7, z);
    const roof = add(new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(w, d) / 2 + 0.6, 2.2, 4), mat), x, T0 + 5.3, z);
    roof.rotation.y = Math.PI / 4; roof.scale.set(w / Math.hypot(w, d) * 1.45, 1, d / Math.hypot(w, d) * 1.45);
  };
  hall(-10, 2, 9, 6, blue);
  hall(13, -2, 6, 5, green);
  // lift tower on the west side, crowned by a seven-tier pyatthat
  const TX = -27, TZ = 4, towerH = T0 + 9;
  add(new THREE.Mesh(new THREE.BoxGeometry(7, towerH, 7), white), TX, towerH / 2, TZ);
  for (const sx of [-1, 1]) add(new THREE.Mesh(new THREE.BoxGeometry(0.15, towerH - 6, 1.4), new THREE.MeshLambertMaterial({ color: 0x4d5b66 })), TX + sx * 3.55, towerH / 2, TZ);
  add(new THREE.Mesh(new THREE.BoxGeometry(1.4, towerH - 6, 0.15), new THREE.MeshLambertMaterial({ color: 0x4d5b66 })), TX, towerH / 2, TZ + 3.55);
  add(new THREE.Mesh(new THREE.BoxGeometry(18, 1, 2.5), white), TX + 10, T0 + 1, TZ); // bridge to the terrace
  let y = towerH;
  for (let i = 0; i < 7; i++) {
    const w = 8.4 - i * 1.05, tier = add(new THREE.Mesh(new THREE.ConeGeometry(w * 0.72, 1.5, 4, 1, true), gold), TX, y + 0.75, TZ);
    tier.rotation.y = Math.PI / 4;
    if (i < 6) add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, 0.6, w * 0.6), gold), TX, y + 1.6, TZ);
    y += i < 6 ? 1.6 : 1.5;
  }
  add(new THREE.Mesh(new THREE.ConeGeometry(0.5, 5, 12), gold), TX, y + 2.5, TZ);
  // collision: the rock and the tower
  const ring = []; for (let a = 0; a < Math.PI * 2; a += Math.PI / 10) ring.push(TKX + Math.cos(a) * 30, TKZ + Math.sin(a) * 20);
  footprints.push({ p: ring, cx: TKX, cz: TKZ, r: 31, top: g0 + T0, base: g0, name: 'Taung Kwe Pagoda' });
  const tw = [TKX + TX - 3.5, TKZ + TZ - 3.5, TKX + TX + 3.5, TKZ + TZ - 3.5, TKX + TX + 3.5, TKZ + TZ + 3.5, TKX + TX - 3.5, TKZ + TZ + 3.5];
  footprints.push({ p: tw, cx: TKX + TX, cz: TKZ + TZ, r: 5, top: g0 + y + 5, base: g0, name: 'Taung Kwe lift tower' });
}

// ---------- Myo Nan Pagoda (မြို့နာမ်စေတီ) ----------
// A large gilded stupa on a white terrace, sized to the platform traced from satellite
// imagery. No photos were found, so the stupa itself is a typical Burmese design.
let MN_TOP = 0;
{
  const plat = myoNanPlatform ?? (() => { const r = []; for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) r.push(MNX + Math.cos(a) * 20, MNZ + Math.sin(a) * 20); return r; })();
  const m = plat.length / 2; let cx = 0, cz = 0, g0 = Infinity, rad = Infinity;
  for (let i = 0; i < m; i++) { cx += plat[i * 2] / m; cz += plat[i * 2 + 1] / m; }
  for (let i = 0; i < m; i++) { g0 = Math.min(g0, ground(plat[i * 2], plat[i * 2 + 1])); rad = Math.min(rad, Math.hypot(plat[i * 2] - cx, plat[i * 2 + 1] - cz)); }
  const white = new THREE.MeshLambertMaterial({ color: 0xf2eee6 });
  const terrace = new THREE.ExtrudeGeometry(new THREE.Shape(Array.from({ length: m }, (_, i) => new THREE.Vector2(plat[i * 2], -plat[i * 2 + 1]))), { depth: 2.1, bevelEnabled: false });
  terrace.rotateX(-Math.PI / 2); terrace.translate(0, g0 - 0.6, 0);
  scene.add(new THREE.Mesh(terrace, white));
  const top = g0 + 1.5, s = Math.min(4.2, rad * 0.75 / 3);
  const add = (geo, mat, x, y, z) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); scene.add(o); return o; };
  add(new THREE.BoxGeometry(7.4 * s, 1.0 * s, 7.4 * s), white, cx, top + 0.5 * s, cz);
  add(stupaGeo, gold, cx, top + 1.0 * s, cz).scale.setScalar(s);
  add(new THREE.ConeGeometry(0.42 * s, 1.2 * s, 12), gold, cx, top + 1.0 * s + 8.9 * s, cz);
  MN_TOP = top + 1.0 * s + 9.6 * s;
  // four small stupas on the corners of the terrace
  for (let k = 0; k < 4; k++) { const a = Math.PI / 4 + k * Math.PI / 2, r = rad * 0.82; add(stupaGeo, gold, cx + Math.cos(a) * r, top, cz + Math.sin(a) * r).scale.setScalar(0.45); }
  footprints.push({ p: plat, cx, cz, r: rad + 25, top, base: g0, name: 'Myo Nan Pagoda' });
  const core = []; for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) core.push(cx + Math.cos(a) * 3 * s, cz + Math.sin(a) * 3 * s);
  footprints.push({ p: core, cx, cz, r: 3 * s + 1, top: MN_TOP, base: top, name: 'Myo Nan Pagoda' });
  MN_TOP = { x: cx, z: cz, top: MN_TOP, base: top, rad };
}

// ---------- spatial hashes ----------
const CELL = 40;
const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
const bHash = new Map(), rHash = new Map();
const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); };
for (const f of footprints) {
  for (let x = f.cx - f.r; x <= f.cx + f.r + CELL; x += CELL)
    for (let z = f.cz - f.r; z <= f.cz + f.r + CELL; z += CELL) push(bHash, key(x, z), f);
}
for (const r of data.roads) {
  if (!r.n) continue;
  for (let i = 0; i < r.p.length - 2; i += 2) {
    const ax = r.p[i], az = r.p[i + 1], bx = r.p[i + 2], bz = r.p[i + 3];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / (CELL / 2)) + 1;
    const seen = new Set();
    for (let s = 0; s <= n; s++) { const k = key(ax + (bx - ax) * s / n, az + (bz - az) * s / n); if (!seen.has(k)) { seen.add(k); push(rHash, k, [r, i]); } }
  }
}
function inPoly(x, z, p) {
  let ins = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins;
  }
  return ins;
}
function insideBuilding(x, z, y) {
  const list = bHash.get(key(x, z));
  if (!list) return null;
  for (const f of list) if (y < f.top + 0.5 && Math.hypot(x - f.cx, z - f.cz) <= f.r + 0.5 && inPoly(x, z, f.p)) return f;
  return null;
}
function nearestStreet(x, z) {
  let best = null, bd = 30;
  for (const dx of [-CELL, 0, CELL]) for (const dz of [-CELL, 0, CELL]) {
    const list = rHash.get(key(x + dx, z + dz)); if (!list) continue;
    for (const [r, i] of list) {
      const ax = r.p[i], az = r.p[i + 1], bx = r.p[i + 2], bz = r.p[i + 3];
      const L2 = (bx - ax) ** 2 + (bz - az) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / L2));
      const d = Math.hypot(x - ax - t * (bx - ax), z - az - t * (bz - az));
      if (d < bd) { bd = d; best = r; }
    }
  }
  return best;
}

// ---------- place labels ----------
const labelGroup = new THREE.Group(); scene.add(labelGroup);
await document.fonts.ready.catch(() => {});
function label(text, sub, x, z, big) {
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  const f1 = `600 ${big ? 46 : 30}px "Work Sans", "Noto Sans Myanmar", sans-serif`, f2 = `400 24px "Noto Sans Myanmar", sans-serif`;
  ctx.font = f1; let w = ctx.measureText(text).width; ctx.font = f2; if (sub) w = Math.max(w, ctx.measureText(sub).width);
  c.width = Math.ceil(w) + 32; c.height = sub ? (big ? 108 : 92) : (big ? 70 : 52);
  ctx.fillStyle = 'rgba(24,28,33,.78)'; ctx.beginPath(); ctx.roundRect(0, 0, c.width, c.height, 10); ctx.fill();
  ctx.fillStyle = '#f4efe6'; ctx.font = f1; ctx.textBaseline = 'top'; ctx.fillText(text, 16, 10);
  if (sub) { ctx.fillStyle = '#e07a6a'; ctx.font = f2; ctx.fillText(sub, 16, big ? 64 : 48); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  s.userData.w = c.width / 2; s.userData.h = c.height / 2; // on-screen size in CSS px
  s.position.set(x, ground(x, z) + (big ? 120 : 14), z);
  s.userData.big = big;
  labelGroup.add(s);
  return s;
}
for (const p of data.places) {
  if (p.k === 'city') continue;
  const l = label(p.n, p.my && p.my !== p.n ? p.my : null, p.x, p.z, false);
  if (p.n === 'Myo Nan Pagoda') l.position.set(MN_TOP.x, MN_TOP.top + 6, MN_TOP.z);
}
const city = data.places.find((p) => p.k === 'city');
if (city) label('Loikaw', city.my, city.x, city.z, true);
label('Taung Kwe Pagoda', 'တောင်ကွဲစေတီ', TKX, TKZ, false).position.y += 42;

// ---------- landmarks ----------
// Positions from OpenStreetMap, except the two video shops, which came from someone
// who grew up nearby.
const LANDMARKS = [
  ['Clock Tower', 'နာရီစင်', 19.67717, 97.21201, 8],
  ['Naung Yar Lake', 'နောင်ယားကန်', 19.67971, 97.20735, 0],
  ['Loikaw University', 'လွိုင်ကော်တက္ကသိုလ်', 19.69339, 97.19723, 0],
  ['Technological University', 'နည်းပညာတက္ကသိုလ်', 19.6546, 97.2086, 0],
  ['Computer University', 'ကွန်ပြူတာတက္ကသိုလ်', 19.69641, 97.22059, 0],
  ['BEHS No. 7', 'အထက ၇', 19.6744, 97.22025, 0],
  ['BEHS No. 1', 'အထက ၁', 19.676334437488862, 97.2142472032823, 0],
  ['BEHS No. 2', 'အထက ၂', 19.68586827132356, 97.20741829923378, 0],
  ['Iron Bridge (Japanese Bridge)', 'သံတံတား (ဂျပန်တံတား)', 19.668754950575565, 97.21451005967769, 4],
  ['HiFi ခွေငှားဆိုင်', 'HiFi video rental', 19.669536878688188, 97.21483766712618, -6],
  ['နဝဒေး ခွေငှားဆိုင်', 'Nawaday video rental', 19.669648640922983, 97.21502139844692, -2],
];
for (const [en, my, lat, lon, dy] of LANDMARKS) { const [x, z] = toLocal(lat, lon); label(en, my, x, z, false).position.y += dy; }

// the iron bridge (ဂျပန်တံတား) carrying NH21 over the Balu Chaung: a steel Warren truss
// on the western of the two spans, which is where the bridge was pointed out
const BRIDGE = (() => {
  const [ax, az] = toLocal(19.66834, 97.214178), [bx, bz] = toLocal(19.669146, 97.214969);
  const len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len, vx = -uz, vz = ux;
  const y0 = ground(ax, az) + 0.4, y1 = ground(bx, bz) + 0.4, W = 7, H = 5;
  decks.push({ ax, az, ux, uz, len, w: W - 0.6, y0, y1 });
  const steel = new THREE.MeshLambertMaterial({ color: 0x55646a }), slab = new THREE.MeshLambertMaterial({ color: 0x8d8780 });
  const P = (t, side, up) => new THREE.Vector3(ax + ux * t + vx * side, y0 + (y1 - y0) * t / len + up, az + uz * t + vz * side);
  const beams = [];
  const beam = (a, b, th) => { const g = new THREE.BoxGeometry(th, th, a.distanceTo(b)); const m = new THREE.Object3D(); m.position.copy(a).add(b).multiplyScalar(0.5); m.lookAt(b); m.updateMatrix(); g.applyMatrix4(m.matrix); beams.push(g); };
  const panels = Math.max(4, Math.round(len / 6)), pl = len / panels;
  for (const side of [-W / 2, W / 2]) {
    beam(P(0, side, 0), P(len, side, 0), 0.45);              // bottom chord
    beam(P(pl / 2, side, H), P(len - pl / 2, side, H), 0.45); // top chord
    for (let i = 0; i < panels; i++) {
      const t0 = i * pl, tm = t0 + pl / 2, t1 = t0 + pl;
      beam(P(t0, side, 0), P(Math.max(tm, pl / 2), side, H), 0.3); // diagonals
      beam(P(Math.min(tm, len - pl / 2), side, H), P(t1, side, 0), 0.3);
      beam(P(tm, side, 0), P(tm, side, H), 0.2);              // verticals
    }
  }
  for (let i = 0; i < panels; i++) { const tm = i * pl + pl / 2; beam(P(tm, -W / 2, H), P(tm, W / 2, H), 0.25); } // overhead bracing
  const g = mergeGeometries(beams); scene.add(new THREE.Mesh(g, steel));
  // concrete deck, plus piers down into the river
  const deck = new THREE.Mesh(new THREE.BoxGeometry(W, 0.5, len), slab);
  deck.position.copy(P(len / 2, 0, -0.25)); deck.lookAt(P(len, 0, -0.25)); scene.add(deck);
  for (let i = 1; i < 3; i++) {
    const c = P(len * i / 3, 0, -0.5), gy = ground(c.x, c.z), h = Math.max(0.5, c.y - gy + 2);
    const pier = new THREE.Mesh(new THREE.BoxGeometry(W - 1, h, 1.6), slab); pier.position.set(c.x, c.y - h / 2, c.z); pier.rotation.y = Math.atan2(ux, uz); scene.add(pier);
  }
  return { P, len, W, H };
})();

// the clock tower: a tapering shaft painted in green, white, red and blue stripes,
// a white clock box with blue trim, and a little silver spire, on a planted roundabout
const clockFace = document.createElement('canvas'); clockFace.width = clockFace.height = 128;
const clockTex = new THREE.CanvasTexture(clockFace); clockTex.colorSpace = THREE.SRGBColorSpace;
let clockShown = -1;
function drawClock(h) {
  const mins = Math.floor(h * 60); if (mins === clockShown) return; clockShown = mins;
  const x = clockFace.getContext('2d');
  x.fillStyle = '#2f62a8'; x.fillRect(0, 0, 128, 128);
  x.fillStyle = '#fbfaf5'; x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#222';
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; x.fillRect(64 + Math.sin(a) * 44 - 2, 64 - Math.cos(a) * 44 - 2, 4, 4); }
  const hand = (a, len, w) => { x.lineWidth = w; x.lineCap = 'round'; x.strokeStyle = '#1b1b1b'; x.beginPath(); x.moveTo(64, 64); x.lineTo(64 + Math.sin(a) * len, 64 - Math.cos(a) * len); x.stroke(); };
  hand((h % 12) / 12 * Math.PI * 2, 26, 6); hand((h % 1) * Math.PI * 2, 40, 3.5);
  clockTex.needsUpdate = true;
}
{
  const g0 = ground(CLX, CLZ), ct = new THREE.Group(); ct.position.set(CLX, g0, CLZ); scene.add(ct);
  const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
  const stripes = document.createElement('canvas'); stripes.width = 128; stripes.height = 8;
  const sx = stripes.getContext('2d');
  [['#2e8b4a', 0, 26], ['#f4f2ec', 26, 14], ['#c8302c', 40, 48], ['#f4f2ec', 88, 14], ['#2f62a8', 102, 26]].forEach(([c, a, w]) => { sx.fillStyle = c; sx.fillRect(a, 0, w, 8); });
  const stripeTex = new THREE.CanvasTexture(stripes); stripeTex.wrapS = THREE.RepeatWrapping; stripeTex.repeat.x = 4; stripeTex.colorSpace = THREE.SRGBColorSpace;
  const add = (geo, mat, y, ry = 0) => { const m = new THREE.Mesh(geo, mat); m.position.y = y; m.rotation.y = ry; ct.add(m); return m; };
  add(new THREE.CylinderGeometry(5, 5, 0.45, 40), lam(0xd8d2c6), 0.22);
  add(new THREE.CylinderGeometry(4.6, 4.6, 0.5, 40), lam(0x4f7f3a), 0.3);
  // red-and-white curb
  for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; add(new THREE.BoxGeometry(1.25, 0.35, 0.3), lam(i % 2 ? 0xf4f2ec : 0xc8302c), 0.62, -a).position.set(Math.cos(a) * 4.85, 0.62, Math.sin(a) * 4.85); }
  const shaftMat = new THREE.MeshLambertMaterial({ map: stripeTex });
  add(new THREE.CylinderGeometry(1.15, 1.9, 2.2, 4, 1), shaftMat, 1.6, Math.PI / 4);
  add(new THREE.CylinderGeometry(0.72, 1.15, 8, 4, 1), shaftMat, 6.7, Math.PI / 4);
  for (let y = 3.5; y < 10.5; y += 0.9) add(new THREE.BoxGeometry(0.5, 0.08, 1.6), lam(0xf4f2ec), y).scale.z = 1.6 - (y - 2.7) * 0.05; // ladder rungs on the red stripe
  add(new THREE.BoxGeometry(2.4, 0.25, 2.4), lam(0x2f62a8), 10.8);
  add(new THREE.BoxGeometry(2.1, 2.1, 2.1), lam(0xf4f2ec), 12);
  const faceMat = new THREE.MeshBasicMaterial({ map: clockTex });
  for (let i = 0; i < 4; i++) { const f = add(new THREE.PlaneGeometry(1.7, 1.7), faceMat, 12, i * Math.PI / 2); f.position.x = Math.sin(i * Math.PI / 2) * 1.06; f.position.z = Math.cos(i * Math.PI / 2) * 1.06; }
  add(new THREE.BoxGeometry(2.6, 0.2, 2.6), lam(0x2f62a8), 13.15);
  const silver = new THREE.MeshStandardMaterial({ color: 0xd5d8dc, metalness: 0.8, roughness: 0.35 });
  add(new THREE.CylinderGeometry(0.1, 1.5, 1.2, 4), silver, 13.85, Math.PI / 4);
  add(new THREE.CylinderGeometry(0.06, 0.45, 2.6, 8), silver, 15.6);
  const ring = []; for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) ring.push(CLX + Math.cos(a) * 4.8, CLZ + Math.sin(a) * 4.8);
  const f = { p: ring, cx: CLX, cz: CLZ, r: 5, top: g0 + 16.5, base: g0, name: 'Clock Tower' };
  footprints.push(f); for (const dx of [-6, 6]) for (const dz of [-6, 6]) if (!bHash.get(key(CLX + dx, CLZ + dz))?.includes(f)) push(bHash, key(CLX + dx, CLZ + dz), f);
}

// ---------- time of day ----------
const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const glowPoints = (pos, color, size, atten = true) => {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color, size, map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: atten, opacity: 0, fog: atten });
  const p = new THREE.Points(g, m); scene.add(p); return p;
};
// streetlights every ~40 m along the bigger roads, on alternating sides
const lamps = [];
for (const r of data.roads) {
  if (roadRank(r.t) < 4) continue;
  let acc = 0, side = 1;
  for (let i = 0; i < r.p.length - 2; i += 2) {
    const ax = r.p[i], az = r.p[i + 1], bx = r.p[i + 2], bz = r.p[i + 3], L = Math.hypot(bx - ax, bz - az) || 1;
    for (let d = 40 - acc; d < L; d += 40) {
      const x = ax + (bx - ax) * d / L - (bz - az) / L * side * ((ROAD_W[r.t] ?? 4) / 2 + 0.5), z = az + (bz - az) * d / L + (bx - ax) / L * side * ((ROAD_W[r.t] ?? 4) / 2 + 0.5);
      lamps.push(x, ground(x, z) + 5.5, z); side = -side;
    }
    acc = (acc + L) % 40;
  }
}
const streetLights = glowPoints(lamps, 0xffb860, 3.5);
// stars on a dome around the camera
const starPos = [];
for (let i = 0; i < 1800; i++) {
  const a = rand(i + 500) * Math.PI * 2, e = Math.asin(rand(i + 900) * 0.98 + 0.02);
  starPos.push(Math.cos(a) * Math.cos(e) * 5000, Math.sin(e) * 5000, Math.sin(a) * Math.cos(e) * 5000);
}
const stars = glowPoints(starPos, 0xdfe6ff, 2.2, false);
// sun and moon discs
const disc = (color, size) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, fog: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending })); s.scale.setScalar(size); scene.add(s); return s; };
const sunDisc = disc(0xfff2c8, 520), moonDisc = disc(0xdfe6ff, 260);
// headlight for the bicycle and motorbike
const headlight = new THREE.SpotLight(0xfff0d0, 0, 140, 0.42, 0.55, 1);
camera.add(headlight); camera.add(headlight.target); headlight.position.set(0, -0.4, -1.3); headlight.target.position.set(0, -2.5, -20);

// ---------- Thadingyut: the festival of lights ----------
// Candles along the front of homes, paper lanterns along the main streets, and strings
// of lights running down from the pagoda spire and the clock tower. Each flame flickers
// on its own phase in the vertex shader.
const flameMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: glowTex }, time: { value: 0 }, opacity: { value: 0 }, scale: { value: innerHeight / 2 } },
  vertexShader: `
    attribute float size; attribute float phase; attribute vec3 color;
    uniform float time, opacity, scale;
    varying vec3 vColor; varying float vA;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float f = 0.72 + 0.28 * sin(time * 9.0 + phase * 31.0) * sin(time * 5.3 + phase * 13.0);
      vA = opacity * f * clamp(1.0 - (-mv.z) / 3000.0, 0.0, 1.0);
      vColor = color;
      gl_PointSize = max(1.5, size * scale / -mv.z * (0.85 + 0.3 * f));
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform sampler2D map; varying vec3 vColor; varying float vA;
    void main() { vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vColor * t.rgb, t.a * vA); }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
{
  const pos = [], col = [], size = [], phase = [];
  let seed = 1;
  const put = (x, y, z, c, sz) => { pos.push(x, y, z); col.push(c.r, c.g, c.b); size.push(sz); phase.push(rand(seed++)); };
  const CANDLE = new THREE.Color(0xffb54a), LANTERNS = [0xff5a3c, 0xffc23a, 0xff8a2a, 0x58d06a, 0xff6fb0, 0x6ab4ff].map((h) => new THREE.Color(h));
  // candles: a row along the longest wall of most homes, and on the windowsill
  footprints.forEach((f, n) => {
    if (!f.base || rand(n + 61) > 0.7 || f.p.length > 40) return;
    const m = f.p.length / 2; let bi = 0, bl = 0;
    for (let i = 0; i < m; i++) { const j = (i + 1) % m, L = Math.hypot(f.p[j * 2] - f.p[i * 2], f.p[j * 2 + 1] - f.p[i * 2 + 1]); if (L > bl) { bl = L; bi = i; } }
    const j = (bi + 1) % m, ax = f.p[bi * 2], az = f.p[bi * 2 + 1], bx = f.p[j * 2], bz = f.p[j * 2 + 1];
    let nx = -(bz - az) / bl, nz = (bx - ax) / bl;
    if (nx * ((ax + bx) / 2 - f.cx) + nz * ((az + bz) / 2 - f.cz) < 0) { nx = -nx; nz = -nz; }
    for (let d = 0.4; d < bl - 0.3; d += 0.8) {
      const x = ax + (bx - ax) * d / bl, z = az + (bz - az) * d / bl;
      put(x + nx * 0.35, ground(x, z) + 0.12, z + nz * 0.35, CANDLE, 0.32);
      if (rand(seed + 3) < 0.35) put(x + nx * 0.18, f.base + 1.45, z + nz * 0.18, CANDLE, 0.28);
    }
    if (rand(n + 62) < 0.45) { const x = (ax + bx) / 2 + nx * 0.9, z = (az + bz) / 2 + nz * 0.9; put(x, f.top - 0.6, z, LANTERNS[(rand(n + 63) * 6) | 0], 1.1); }
  });
  // paper lanterns strung along both sides of the main streets
  for (const r of data.roads) {
    if (roadRank(r.t) < 6) continue;
    const off = (ROAD_W[r.t] ?? 6) / 2 + 1; let k = 0;
    for (let i = 0; i < r.p.length - 2; i += 2) {
      const ax = r.p[i], az = r.p[i + 1], bx = r.p[i + 2], bz = r.p[i + 3], L = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / L, nz = (bx - ax) / L;
      for (let d = 0; d < L; d += 3.2, k++) {
        const x = ax + (bx - ax) * d / L, z = az + (bz - az) * d / L, sag = Math.sin((k % 6) / 6 * Math.PI) * 0.5;
        for (const sd of [-1, 1]) put(x + nx * off * sd, ground(x, z) + 4.6 - sag, z + nz * off * sd, LANTERNS[(k + (sd > 0 ? 3 : 0)) % 6], 0.9);
      }
    }
  }
  // strings of lights from a spire down to a ring around its base
  const strands = (tx, ty, tz, r, by, count, perStrand, colors) => {
    for (let s = 0; s < count; s++) {
      const a = s / count * Math.PI * 2, ex = tx + Math.cos(a) * r, ez = tz + Math.sin(a) * r;
      for (let i = 1; i <= perStrand; i++) { const t = i / perStrand; put(tx + (ex - tx) * t, ty + (by - ty) * t - Math.sin(t * Math.PI) * r * 0.08, tz + (ez - tz) * t, colors[(s + i) % colors.length], 0.55); }
    }
  };
  const tkBase = ground(TKX, TKZ) - 3 + 33 + 1.2;
  strands(TKX + 2, tkBase + 19, TKZ - 1, 15, tkBase + 0.4, 24, 26, [CANDLE, new THREE.Color(0xfff1c0)]);
  for (let x = -17; x <= 17; x += 0.9) for (const z of [-9, 9]) put(TKX + x, tkBase + 0.2, TKZ + z, CANDLE, 0.4);
  strands(MN_TOP.x, MN_TOP.top, MN_TOP.z, MN_TOP.rad * 0.9, MN_TOP.base + 0.3, 32, 34, [CANDLE, new THREE.Color(0xfff1c0), LANTERNS[1]]);
  for (let t = 0; t <= BRIDGE.len; t += 1.2) for (const sd of [-1, 1]) { const q = BRIDGE.P(t, sd * BRIDGE.W / 2, BRIDGE.H + 0.4); put(q.x, q.y, q.z, LANTERNS[(t / 1.2 | 0) % 6], 0.6); }
  const clBase = ground(CLX, CLZ);
  strands(CLX, clBase + 16.5, CLZ, 4.9, clBase + 0.9, 16, 22, LANTERNS);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.Float32BufferAttribute(size, 1));
  g.setAttribute('phase', new THREE.Float32BufferAttribute(phase, 1));
  const pts = new THREE.Points(g, flameMat); pts.frustumCulled = false; scene.add(pts);
  console.info(`Thadingyut: ${pos.length / 3} lights`);
}
// on by default during the three Thadingyut holidays (24-27 October 2026 here)
const mmNow = new Date(Date.now() + 6.5 * 3600e3);
let festival = mmNow.getUTCFullYear() === 2026 && mmNow.getUTCMonth() === 9 && mmNow.getUTCDate() >= 24 && mmNow.getUTCDate() <= 27;

const C = (h) => new THREE.Color(h);
const SKY_NIGHT = C(0x0a1226), SKY_DAY = C(0xb9cbd8), SKY_GLOW = C(0xf0a070), SUN_LOW = C(0xffa060), SUN_HIGH = C(0xfff1dc);
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const sunDir = new THREE.Vector3();
let night = 0;
function setTime(h) {
  // sun rises in the east (+x) at 06:00 and sets in the west at 18:00, a little to the south
  const a = (h - 6) / 12 * Math.PI;
  sunDir.set(Math.cos(a), Math.sin(a), 0.35).normalize();
  const e = sunDir.y, day = smooth(-0.12, 0.25, e), glow = Math.exp(-(((e - 0.03) / 0.13) ** 2));
  night = 1 - day;
  const sky = SKY_NIGHT.clone().lerp(SKY_DAY, day).lerp(SKY_GLOW, glow * 0.55);
  scene.background.copy(sky); scene.fog.color.copy(sky);
  scene.fog.far = 2600 + 1600 * day;
  hemi.intensity = 0.12 + 1.0 * day;
  hemi.color.copy(C(0x6f7fa8).lerp(C(0xdfe9f2), day));
  sun.position.copy(sunDir).multiplyScalar(2000);
  sun.intensity = 1.7 * smooth(-0.02, 0.2, e);
  sun.color.copy(SUN_LOW).lerp(SUN_HIGH, smooth(0, 0.35, e));
  moon.position.copy(sunDir).multiplyScalar(-2000).setY(1500);
  moon.intensity = 0.35 * night;
  streetLights.material.opacity = smooth(0.3, 0.7, night);
  for (const m of wallMats) m.emissiveIntensity = smooth(0.35, 0.8, night) * 0.9; // lit window panes
  stars.material.opacity = smooth(0.6, 1, night);
  gold.emissiveIntensity = night * 1.6;
  sunDisc.material.opacity = smooth(-0.05, 0.02, e);
  moonDisc.material.opacity = smooth(0.5, 0.9, night);
  moonDisc.scale.setScalar(festival ? 420 : 260); // the Thadingyut full moon
  flameMat.uniforms.opacity.value = festival ? smooth(0.25, 0.7, night) : 0;
}
// Loikaw is UTC+6:30; start at the time it is there right now
const nowMM = new Date(Date.now() + 6.5 * 3600e3);
let hour = nowMM.getUTCHours() + nowMM.getUTCMinutes() / 60, timeFlows = false;
const fmtHour = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
function showTime() {
  setTime(hour);
  drawClock(hour);
  $('time').value = hour;
  $('time-label').textContent = fmtHour(hour);
  $('time-play').textContent = timeFlows ? 'Pause' : 'Play';
  $('time-play').setAttribute('aria-pressed', timeFlows);
}
$('time').addEventListener('input', (e) => { hour = +e.target.value; showTime(); });
function showFestival() { const b = $('festival'); b.setAttribute('aria-pressed', festival); b.textContent = festival ? 'Festival lights on' : 'Festival lights off'; setTime(hour); }
$('festival').addEventListener('click', (e) => { e.stopPropagation(); festival = !festival; showFestival(); });
showFestival();
$('time-play').addEventListener('click', (e) => { e.stopPropagation(); timeFlows = !timeFlows; showTime(); });
showTime();

// ---------- player ----------
// start just south of the clock tower, looking up at it
const player = { x: CLX, z: CLZ + 16, y: 0, vy: 0, yaw: 0, pitch: 0, speed: 0, mode: 'walk', onGround: true, roll: 0, hover: false };
player.y = ground(player.x, player.z);
const keys = new Set();
let started = false, mapBig = false;

function setMode(m) {
  const prev = player.mode; player.mode = m;
  if (!MODES[m].ride) { player.speed = 0; player.hover = false; }
  $('hover').hidden = !MODES[m].ride; showHover();
  vehicle.bike.visible = m === 'bike'; vehicle.moto.visible = m === 'moto';
  if (m === 'moto') engineOn();
  if (m === 'fly' && prev !== 'fly') { player.y = Math.max(player.y, ground(player.x, player.z) + 60); player.pitch = -0.35; }
  if (m !== 'fly' && prev === 'fly') { player.y = Math.max(ground(player.x, player.z), deckAt(player.x, player.z)); player.pitch = 0; player.vy = 0; }
  // don't land inside a building
  for (let a = 0; insideBuilding(player.x, player.z, player.y + 0.1) && a < 60; a++) { player.x += Math.cos(a) * a; player.z += Math.sin(a) * a; player.y = Math.max(ground(player.x, player.z), deckAt(player.x, player.z)); }
  for (const id of ['walk', 'bike', 'moto', 'fly']) $('p-' + id).setAttribute('aria-pressed', id === m);
}
// hover: the bicycle or motorbike lifts off and flies
function showHover() {
  const b = $('hover');
  b.textContent = player.hover ? 'Land (F)' : 'Take off (F)';
  b.setAttribute('aria-pressed', player.hover);
}
function toggleHover() {
  if (!MODES[player.mode].ride) return;
  player.hover = !player.hover;
  if (player.hover) { player.vy = 0; player.y += 1.5; player.speed = Math.max(player.speed, 3); }
  showHover();
}
$('hover').addEventListener('click', (e) => { e.stopPropagation(); toggleHover(); });

function start(m) {
  started = true; $('intro').hidden = true; $('hud').hidden = false;
  if (matchMedia('(pointer: coarse)').matches) $('touch').hidden = false;
  else canvas.requestPointerLock?.()?.catch?.(() => {});
  setMode(m);
  sizeMap();
}
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); started ? setMode(b.dataset.mode) : start(b.dataset.mode); }));
$('loading').hidden = true;
// after a mouse click, give the keyboard back to the game so Space doesn't press the button again
document.querySelectorAll('button, input').forEach((el) => el.addEventListener('pointerup', () => setTimeout(() => el.blur(), 0)));

addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (!started) return;
  if (e.code === 'Digit1') setMode('walk'); if (e.code === 'Digit2') setMode('bike'); if (e.code === 'Digit3') setMode('moto'); if (e.code === 'Digit4') setMode('fly');
  if (e.code === 'KeyF') toggleHover();
  if (e.code === 'KeyL') { festival = !festival; showFestival(); }
  if (e.code === 'KeyT') { timeFlows = !timeFlows; showTime(); }
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') { hour = (hour + (e.code === 'BracketLeft' ? 23 : 1)) % 24; showTime(); }
  if (e.code === 'KeyM') { mapBig = !mapBig; $('minimap').classList.toggle('big', mapBig); sizeMap(); }
  if (e.code === 'Space' && player.mode === 'walk' && player.onGround) { player.vy = 4.2; player.onGround = false; }
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
canvas.addEventListener('click', () => { if (started && !matchMedia('(pointer: coarse)').matches) canvas.requestPointerLock?.()?.catch?.(() => {}); });
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  player.yaw -= e.movementX * 0.0022; player.pitch -= e.movementY * 0.0022;
  player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch));
});
// drag-to-look when pointer lock isn't available
let drag = null;
canvas.addEventListener('pointerdown', (e) => { if (document.pointerLockElement !== canvas) drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; });
addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  player.yaw -= (e.clientX - drag.x) * 0.005; player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch - (e.clientY - drag.y) * 0.005));
  drag.x = e.clientX; drag.y = e.clientY;
});
addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.id) drag = null; });

// touch joystick
const stick = { x: 0, y: 0, id: null };
const stickEl = $('stick'), knob = $('knob');
stickEl.addEventListener('pointerdown', (e) => { stick.id = e.pointerId; stickEl.setPointerCapture(e.pointerId); moveStick(e); });
stickEl.addEventListener('pointermove', (e) => { if (e.pointerId === stick.id) moveStick(e); });
stickEl.addEventListener('pointerup', () => { stick.id = null; stick.x = stick.y = 0; knob.style.transform = ''; });
function moveStick(e) {
  const r = stickEl.getBoundingClientRect();
  let x = (e.clientX - r.left - 60) / 50, y = (e.clientY - r.top - 60) / 50; const L = Math.hypot(x, y); if (L > 1) { x /= L; y /= L; }
  stick.x = x; stick.y = y; knob.style.transform = `translate(${x * 35}px, ${y * 35}px)`;
}
const hold = (id, code) => { const el = $(id); el.addEventListener('pointerdown', () => keys.add(code)); el.addEventListener('pointerup', () => keys.delete(code)); el.addEventListener('pointerleave', () => keys.delete(code)); };
hold('t-up', 'Space'); hold('t-down', 'KeyC');

// ---------- minimap ----------
const mm = $('minimap'), mctx = mm.getContext('2d');
let mmBase = null, mmScale = 1;
function sizeMap() {
  const r = mm.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2);
  mm.width = r.width * dpr; mm.height = r.height * dpr;
  mmScale = Math.min(mm.width / (X1 - T.x0), mm.height / (Z1 - T.z0));
  const off = document.createElement('canvas'); off.width = mm.width; off.height = mm.height;
  const o = off.getContext('2d');
  o.fillStyle = '#2a3329'; o.fillRect(0, 0, off.width, off.height);
  const P = (x, z) => [(x - T.x0) * mmScale, (z - T.z0) * mmScale];
  const poly = (p, fill) => { o.beginPath(); for (let i = 0; i < p.length; i += 2) o.lineTo(...P(p[i], p[i + 1])); o.closePath(); o.fillStyle = fill; o.fill(); };
  const line = (p, w, s) => { o.beginPath(); for (let i = 0; i < p.length; i += 2) o.lineTo(...P(p[i], p[i + 1])); o.lineWidth = w; o.strokeStyle = s; o.stroke(); };
  for (const g of data.green) poly(g.p, '#3f5a35');
  for (const w of data.waterAreas) poly(w.p, '#3f6f86');
  for (const w of data.waterLines) line(w.p, w.t === 'river' ? 3 * dpr : 1 * dpr, '#3f6f86');
  for (const b of data.buildings) poly(b.p, '#9b9488');
  for (const r of roadsSorted) line(r.p, (roadRank(r.t) > 5 ? 2 : 1) * dpr, roadRank(r.t) > 5 ? '#e6d6bc' : '#b7ab98');
  mmBase = off;
}
mm.addEventListener('click', (e) => {
  const r = mm.getBoundingClientRect(), dpr = mm.width / r.width;
  player.x = T.x0 + (e.clientX - r.left) * dpr / mmScale; player.z = T.z0 + (e.clientY - r.top) * dpr / mmScale;
  player.y = player.mode === 'fly' ? ground(player.x, player.z) + 80 : ground(player.x, player.z);
  player.speed = 0; setMode(player.mode);
});
function drawMap() {
  if (!mmBase) return;
  mctx.drawImage(mmBase, 0, 0);
  const x = (player.x - T.x0) * mmScale, z = (player.z - T.z0) * mmScale, dpr = mm.width / mm.getBoundingClientRect().width;
  mctx.save(); mctx.translate(x, z); mctx.rotate(-player.yaw);
  mctx.beginPath(); mctx.moveTo(0, -9 * dpr); mctx.lineTo(6 * dpr, 7 * dpr); mctx.lineTo(0, 3 * dpr); mctx.lineTo(-6 * dpr, 7 * dpr); mctx.closePath();
  mctx.fillStyle = '#c8402f'; mctx.strokeStyle = '#fff'; mctx.lineWidth = 1.5 * dpr; mctx.fill(); mctx.stroke(); mctx.restore();
}

// ---------- handlebars seen from the saddle ----------
scene.add(camera);
const vehicle = { bike: new THREE.Group(), moto: new THREE.Group() };
{
  const mat = (c, m = 0.3) => new THREE.MeshStandardMaterial({ color: c, metalness: m, roughness: 0.5 });
  const bar = (len, r, m) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), m);
  // bicycle: thin silver bar, black grips
  const b = vehicle.bike, steel = mat(0xc8ccd0, 0.8), grip = mat(0x1d1d1d, 0);
  const hb = bar(0.62, 0.012, steel); hb.rotation.z = Math.PI / 2; b.add(hb);
  for (const sx of [-1, 1]) { const g = bar(0.12, 0.018, grip); g.rotation.z = Math.PI / 2; g.position.x = sx * 0.3; b.add(g); }
  const stem = bar(0.25, 0.014, steel); stem.position.set(0, -0.12, -0.03); stem.rotation.x = 0.3; b.add(stem);
  b.position.set(0, -0.55, -0.75);
  // motorbike: wider chrome bar, mirrors, round speedo, red tank
  const m = vehicle.moto, chrome = mat(0xb9bec4, 0.9), black = mat(0x18191b, 0.2), red = mat(0xc8402f, 0.4);
  const mb = bar(0.72, 0.014, chrome); mb.rotation.z = Math.PI / 2; m.add(mb);
  for (const sx of [-1, 1]) {
    const g = bar(0.13, 0.022, black); g.rotation.z = Math.PI / 2; g.position.x = sx * 0.36; m.add(g);
    const arm = bar(0.22, 0.006, chrome); arm.position.set(sx * 0.27, 0.11, 0.01); arm.rotation.z = -sx * 0.25; m.add(arm);
    const mirror = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.01, 20), black); mirror.rotation.x = Math.PI / 2; mirror.position.set(sx * 0.3, 0.2, 0.01); m.add(mirror);
  }
  const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.07, 0.05, 24), black); pod.rotation.x = Math.PI / 2 - 0.5; pod.position.set(0, 0.04, -0.08); m.add(pod);
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.055, 24), new THREE.MeshBasicMaterial({ color: 0xf4efe6 })); face.rotation.x = -0.5; face.position.set(0, 0.06, -0.065); m.add(face);
  const tank = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 12), red); tank.scale.set(1, 0.5, 1.4); tank.position.set(0, -0.25, 0.25); m.add(tank);
  m.position.set(0, -0.62, -0.85);
  for (const v of Object.values(vehicle)) { v.visible = false; camera.add(v); }
}
// engine note: two detuned oscillators through a low-pass, pitch follows speed
const engine = { ctx: null };
function engineOn() {
  if (engine.ctx) return engine.ctx.resume();
  try {
    const ctx = new AudioContext(), gain = ctx.createGain(), filter = ctx.createBiquadFilter(), g2 = ctx.createGain();
    filter.type = 'lowpass'; filter.frequency.value = 600; gain.gain.value = 0; g2.gain.value = 0.4;
    const osc = ctx.createOscillator(), osc2 = ctx.createOscillator();
    osc.type = 'sawtooth'; osc2.type = 'square'; osc.frequency.value = 38; osc2.frequency.value = 19;
    osc.connect(filter); osc2.connect(g2).connect(filter); filter.connect(gain).connect(ctx.destination);
    osc.start(); osc2.start();
    Object.assign(engine, { ctx, osc, osc2, gain, filter });
  } catch { /* no audio: ride silently */ }
}
function engineUpdate(throttle) {
  if (!engine.ctx) return;
  const on = player.mode === 'moto' && !document.hidden;
  const rpm = (38 + player.speed * 4.2 + throttle * 14) * (player.hover ? 1.9 : 1), t = engine.ctx.currentTime;
  engine.osc.frequency.setTargetAtTime(rpm, t, 0.08);
  engine.osc2.frequency.setTargetAtTime(rpm / 2, t, 0.08);
  engine.filter.frequency.setTargetAtTime(500 + throttle * 700 + player.speed * 30, t, 0.1);
  engine.gain.gain.setTargetAtTime(on ? 0.05 + throttle * 0.04 : 0, t, 0.15);
}

// ---------- loop ----------
const clock = new THREE.Clock();
let bob = 0, hudT = 0;
function tick() {
  const dt = Math.min(0.05, clock.getDelta());
  if (!started) {
    // slow aerial orbit behind the intro card
    const t = clock.elapsedTime * 0.03, cx = city?.x ?? 0, cz = city?.z ?? 0;
    camera.position.set(cx + Math.sin(t) * 1600, ground(cx, cz) + 650, cz + Math.cos(t) * 1600);
    camera.lookAt(cx, ground(cx, cz), cz);
    renderer.render(scene, camera);
    return requestAnimationFrame(tick);
  }
  const M = MODES[player.mode];
  let fwd = 0, side = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
  if (keys.has('KeyA')) side -= 1;
  if (keys.has('KeyD')) side += 1;
  if (keys.has('ArrowLeft')) player.yaw += 1.8 * dt;
  if (keys.has('ArrowRight')) player.yaw -= 1.8 * dt;
  if (stick.id !== null) { fwd -= stick.y; side += stick.x; }
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');

  let vx = 0, vz = 0;
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  if (M.ride) {
    // momentum: W to speed up, let go to coast, S brakes; A/D steer and lean
    const boost = player.hover ? 1.8 : 1;
    const R = M.ride, target = fwd > 0 ? (fast ? M.run : M.speed) * boost : 0;
    if (fwd < 0) player.speed -= R.brake * dt;
    else if (player.speed < target) player.speed = Math.min(target, player.speed + R.accel * dt);
    else player.speed = Math.max(target, player.speed - R.coast * dt);
    player.speed = Math.max(0, player.speed);
    const steer = -side * Math.min(1.4, 0.5 + player.speed * 0.15);
    player.yaw += steer * dt;
    player.roll += ((side * Math.min(player.speed, 12) * R.lean) - player.roll) * Math.min(1, dt * 5);
    vx = -sy * player.speed; vz = -cy * player.speed;
    if (player.hover) {
      // nose up to climb, Space/C for straight up and down
      const lift = (keys.has('Space') ? 1 : 0) - (keys.has('KeyC') || keys.has('ControlLeft') ? 1 : 0);
      player.y += (Math.sin(player.pitch) * player.speed + lift * 7) * dt;
    }
  } else {
    player.roll *= 0.9;
    const sp = fast ? M.run : M.speed, L = Math.hypot(fwd, side) || 1;
    const f = fwd / L, s = side / L;
    vx = (-sy * f + cy * s) * sp; vz = (-cy * f - sy * s) * sp;
    if (player.mode === 'fly') {
      const pc = Math.cos(player.pitch), ps = Math.sin(player.pitch);
      vx = (-sy * pc * f + cy * s) * sp; vz = (-cy * pc * f - sy * s) * sp;
      player.y += (ps * f * sp + ((keys.has('Space') ? 1 : 0) - (keys.has('KeyC') || keys.has('ControlLeft') ? 1 : 0)) * sp * 0.7) * dt;
    }
  }

  // move with simple wall sliding
  const nx = player.x + vx * dt, nz = player.z + vz * dt;
  const airborne = player.mode === 'fly' || player.hover;
  const yCheck = airborne ? player.y : player.y + 0.3;
  if (!insideBuilding(nx, nz, yCheck)) { player.x = nx; player.z = nz; }
  else if (!insideBuilding(nx, player.z, yCheck)) player.x = nx;
  else if (!insideBuilding(player.x, nz, yCheck)) player.z = nz;
  else player.speed *= 0.3;
  player.x = Math.max(T.x0 + 5, Math.min(X1 - 5, player.x));
  player.z = Math.max(T.z0 + 5, Math.min(Z1 - 5, player.z));

  const g = Math.max(ground(player.x, player.z), deckAt(player.x, player.z));
  if (airborne) {
    player.y = Math.max(player.y, g + (player.hover ? 0.4 : 2));
    const roof = insideBuilding(player.x, player.z, -Infinity); if (roof) player.y = Math.max(player.y, roof.top + 2);
  } else {
    player.vy = Math.max(-15, player.vy - 12 * dt); player.y += player.vy * dt;
    if (player.y <= g) { player.y = g; player.vy = 0; player.onGround = true; }
  }

  const moving = M.ride ? player.speed / M.run : Math.min(1, Math.hypot(vx, vz) / M.speed);
  bob += dt * (player.mode === 'moto' ? 30 : player.mode === 'bike' ? 6 : fast ? 11 : 8) * (moving > 0.05 ? 1 : 0);
  const bobY = airborne ? Math.sin(clock.elapsedTime * 2) * 0.08 : Math.sin(bob) * (player.mode === 'moto' ? 0.006 : player.mode === 'bike' ? 0.02 : 0.05) * moving;
  camera.position.set(player.x, player.y + (player.mode === 'fly' ? 0 : M.eye) + bobY, player.z);
  camera.rotation.set(player.pitch, player.yaw, -player.roll);

  for (const s of labelGroup.children) {
    const d = s.position.distanceTo(camera.position);
    s.visible = s.userData.big ? d > 300 : d > 8 && d < 2500;
    // keep labels the same size on screen at any distance
    const k = 2 * d * Math.tan(camera.fov * Math.PI / 360) / innerHeight;
    s.scale.set(s.userData.w * k, s.userData.h * k, 1);
  }

  hudT += dt;
  if (hudT > 0.25) {
    hudT = 0;
    const r = nearestStreet(player.x, player.z);
    const street = $('street');
    street.textContent = r && player.y - ground(player.x, player.z) < 40 ? r.n : airborne ? 'Above Loikaw' : 'Off the named streets';
    street.lang = r && /[က-႟]/.test(r.n) ? 'my' : 'en';
    const kmh = (M.ride ? player.speed : Math.hypot(vx, vz)) * 3.6;
    const lat = data.origin[0] - player.z / 110540, lon = data.origin[1] + player.x / (111320 * Math.cos(data.origin[0] * Math.PI / 180));
    $('meta').textContent = `${M.label}${player.hover ? ' in the air' : ''} · ${kmh.toFixed(0)} km/h · ${Math.round(BASE + player.y)} m elevation · ${lat.toFixed(4)}° N ${lon.toFixed(4)}° E`;
  }
  engineUpdate(M.ride && fwd > 0 ? 1 : 0);
  if (timeFlows) { hour = (hour + dt / 30) % 24; showTime(); } // one hour every 30 s
  flameMat.uniforms.time.value = clock.elapsedTime;
  sunDisc.position.copy(camera.position).addScaledVector(sunDir, 4500);
  moonDisc.position.copy(camera.position).addScaledVector(sunDir, -4500).setY(camera.position.y + 2200);
  stars.position.copy(camera.position);
  headlight.intensity = M.ride ? 60 * smooth(0.3, 0.7, night) : 0;
  // handlebars turn with the steering and tip into the lean
  for (const v of Object.values(vehicle)) v.rotation.set(0, -side * 0.12, player.roll * 0.6);
  drawMap();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); flameMat.uniforms.scale.value = innerHeight / 2; camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); if (started) sizeMap(); });
new ResizeObserver(() => started && sizeMap()).observe(mm);
console.info(`Loikaw 3D: ${footprints.length} buildings (${estimated} with estimated height), ${data.roads.length} roads`);
requestAnimationFrame(tick);
