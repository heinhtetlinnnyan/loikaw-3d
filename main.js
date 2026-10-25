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

scene.add(new THREE.HemisphereLight(0xdfe9f2, 0x5b5040, 1.1));
const sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
sun.position.set(-1200, 1600, 600);
scene.add(sun);

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
// cheap deterministic random so heights don't change between visits
const rand = (s) => { s = Math.sin(s * 12.9898) * 43758.5453; return s - Math.floor(s); };
const WALLS = [0xe8e0d0, 0xdcd3c2, 0xf0ebe0, 0xcfd6d4, 0xe6d6bc, 0xd9c7b0];
const ROOFS = [0x8b4a3a, 0x7a7f86, 0x9a5b45, 0x6f747a, 0xa86a4c, 0x5f6b72];
const bgeo = [];
const footprints = []; // for collision + picking
let estimated = 0;
data.buildings.forEach((b, n) => {
  const pts = []; let ymin = Infinity, cx = 0, cz = 0;
  for (let i = 0; i < b.p.length; i += 2) { pts.push(new THREE.Vector2(b.p[i], -b.p[i + 1])); ymin = Math.min(ymin, ground(b.p[i], b.p[i + 1])); cx += b.p[i]; cz += b.p[i + 1]; }
  if (pts.length < 3) return;
  cx /= pts.length; cz /= pts.length;
  let h = b.h;
  if (!h) { estimated++; h = 3.4 + Math.floor(rand(n + 1) * 2.2) * 3.2 * (rand(n + 7) > 0.75 ? 1 : 0.0) + rand(n + 3) * 1.2; }
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: h + 0.6, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, ymin - 0.6, 0);
  const wall = new THREE.Color(WALLS[(rand(n + 11) * WALLS.length) | 0]);
  const roof = new THREE.Color(ROOFS[(rand(n + 13) * ROOFS.length) | 0]);
  if (b.s === 'osm' && b.k && b.k !== 'yes') wall.lerp(new THREE.Color(0xf3e2b3), 0.5);
  const nor = g.attributes.normal, col = new Float32Array(nor.count * 3);
  for (let k = 0; k < nor.count; k++) { const c = nor.getY(k) > 0.5 ? roof : wall; col.set([c.r, c.g, c.b], k * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  bgeo.push(g);
  let r = 0; for (let i = 0; i < b.p.length; i += 2) r = Math.max(r, Math.hypot(b.p[i] - cx, b.p[i + 1] - cz));
  footprints.push({ p: b.p, cx, cz, r, top: ymin + h, name: b.n, kind: b.k });
});
for (let i = 0; i < bgeo.length; i += 2000) {
  const g = mergeGeometries(bgeo.slice(i, i + 2000));
  scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true })));
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
}
for (const p of data.places) {
  if (p.k === 'city') continue;
  label(p.n, p.my && p.my !== p.n ? p.my : null, p.x, p.z, false);
}
const city = data.places.find((p) => p.k === 'city');
if (city) label('Loikaw', city.my, city.x, city.z, true);

// ---------- player ----------
const market = data.places.find((p) => p.n === 'Market') ?? city ?? { x: 0, z: 0 };
const player = { x: market.x + 6, z: market.z + 6, y: 0, vy: 0, yaw: -Math.PI / 4, pitch: 0, speed: 0, mode: 'walk', onGround: true, roll: 0 };
player.y = ground(player.x, player.z);
const keys = new Set();
let started = false, mapBig = false;

function setMode(m) {
  const prev = player.mode; player.mode = m;
  if (!MODES[m].ride) player.speed = 0;
  vehicle.bike.visible = m === 'bike'; vehicle.moto.visible = m === 'moto';
  if (m === 'moto') engineOn();
  if (m === 'fly' && prev !== 'fly') { player.y = Math.max(player.y, ground(player.x, player.z) + 60); player.pitch = -0.35; }
  if (m !== 'fly' && prev === 'fly') { player.y = ground(player.x, player.z); player.pitch = 0; player.vy = 0; }
  // don't land inside a building
  for (let a = 0; insideBuilding(player.x, player.z, player.y + 0.1) && a < 60; a++) { player.x += Math.cos(a) * a; player.z += Math.sin(a) * a; player.y = ground(player.x, player.z); }
  for (const id of ['walk', 'bike', 'moto', 'fly']) $('p-' + id).setAttribute('aria-pressed', id === m);
}
function start(m) {
  started = true; $('intro').hidden = true; $('hud').hidden = false;
  if (matchMedia('(pointer: coarse)').matches) $('touch').hidden = false;
  else canvas.requestPointerLock?.()?.catch?.(() => {});
  setMode(m);
  sizeMap();
}
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); started ? setMode(b.dataset.mode) : start(b.dataset.mode); }));
$('loading').hidden = true;

addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (!started) return;
  if (e.code === 'Digit1') setMode('walk'); if (e.code === 'Digit2') setMode('bike'); if (e.code === 'Digit3') setMode('moto'); if (e.code === 'Digit4') setMode('fly');
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
  const rpm = 38 + player.speed * 4.2 + throttle * 14, t = engine.ctx.currentTime;
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
    const R = M.ride, target = fwd > 0 ? (fast ? M.run : M.speed) : 0;
    if (fwd < 0) player.speed -= R.brake * dt;
    else if (player.speed < target) player.speed = Math.min(target, player.speed + R.accel * dt);
    else player.speed = Math.max(target, player.speed - R.coast * dt);
    player.speed = Math.max(0, player.speed);
    const steer = -side * Math.min(1.4, 0.5 + player.speed * 0.15);
    player.yaw += steer * dt;
    player.roll += ((side * Math.min(player.speed, 12) * R.lean) - player.roll) * Math.min(1, dt * 5);
    vx = -sy * player.speed; vz = -cy * player.speed;
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
  const yCheck = player.mode === 'fly' ? player.y : player.y + 0.3;
  if (!insideBuilding(nx, nz, yCheck)) { player.x = nx; player.z = nz; }
  else if (!insideBuilding(nx, player.z, yCheck)) player.x = nx;
  else if (!insideBuilding(player.x, nz, yCheck)) player.z = nz;
  else player.speed *= 0.3;
  player.x = Math.max(T.x0 + 5, Math.min(X1 - 5, player.x));
  player.z = Math.max(T.z0 + 5, Math.min(Z1 - 5, player.z));

  const g = ground(player.x, player.z);
  if (player.mode === 'fly') {
    player.y = Math.max(player.y, g + 2);
    const roof = insideBuilding(player.x, player.z, -Infinity); if (roof) player.y = Math.max(player.y, roof.top + 2);
  } else {
    player.vy -= 12 * dt; player.y += player.vy * dt;
    if (player.y <= g) { player.y = g; player.vy = 0; player.onGround = true; }
  }

  const moving = M.ride ? player.speed / M.run : Math.min(1, Math.hypot(vx, vz) / M.speed);
  bob += dt * (player.mode === 'moto' ? 30 : player.mode === 'bike' ? 6 : fast ? 11 : 8) * (moving > 0.05 ? 1 : 0);
  const bobY = player.mode === 'fly' ? 0 : Math.sin(bob) * (player.mode === 'moto' ? 0.006 : player.mode === 'bike' ? 0.02 : 0.05) * moving;
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
    street.textContent = r ? r.n : player.mode === 'fly' ? 'Above Loikaw' : 'Off the named streets';
    street.lang = r && /[က-႟]/.test(r.n) ? 'my' : 'en';
    const kmh = (M.ride ? player.speed : Math.hypot(vx, vz)) * 3.6;
    const lat = data.origin[0] - player.z / 110540, lon = data.origin[1] + player.x / (111320 * Math.cos(data.origin[0] * Math.PI / 180));
    $('meta').textContent = `${M.label} · ${kmh.toFixed(0)} km/h · ${Math.round(BASE + player.y)} m elevation · ${lat.toFixed(4)}° N ${lon.toFixed(4)}° E`;
  }
  engineUpdate(M.ride && fwd > 0 ? 1 : 0);
  // handlebars turn with the steering and tip into the lean
  for (const v of Object.values(vehicle)) v.rotation.set(0, -side * 0.12, player.roll * 0.6);
  drawMap();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); if (started) sizeMap(); });
new ResizeObserver(() => started && sizeMap()).observe(mm);
console.info(`Loikaw 3D: ${footprints.length} buildings (${estimated} with estimated height), ${data.roads.length} roads`);
requestAnimationFrame(tick);
