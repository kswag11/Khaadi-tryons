// Nool Khadi Try-On: a 3D fitting room built with Three.js.
// Bodies and garments are sculpted procedurally in tailor.js and meshed in background workers.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

const PALETTE = [
  { id: 'offwhite', name: 'Kerala off-white', hex: '#efe6d2' },
  { id: 'kasavu',   name: 'Kasavu gold',      hex: '#c9a44c' },
  { id: 'indigo',   name: 'Indigo',           hex: '#2e3f6e' },
  { id: 'turmeric', name: 'Turmeric',         hex: '#d9a21b' },
  { id: 'madder',   name: 'Madder red',       hex: '#a23b2c' },
  { id: 'jackfruit',name: 'Jackfruit wood',   hex: '#b9772b' },
  { id: 'charcoal', name: 'Charcoal',         hex: '#3a3a3a' },
  { id: 'leaf',     name: 'Banana leaf',      hex: '#5c7a3a' },
  { id: 'rust',     name: 'Laterite rust',    hex: '#b25a2e' },
  { id: 'sky',      name: 'Monsoon sky',      hex: '#8fb3cf' },
];

const SKINS = ['#e8bc98', '#c98f66', '#a06a45', '#6e4630'];

const OUTFITS = {
  male: [
    { id: 'kurta',   name: 'Kurta & pyjama',       sub: 'Classic, knee length',        price: 1799, accentLabel: 'Pyjama',   main: 'offwhite', accent: 'indigo' },
    { id: 'nehru',   name: 'Nehru jacket set',     sub: 'Kurta + bandhgala vest',     price: 3499, accentLabel: 'Jacket',   main: 'offwhite', accent: 'madder' },
    { id: 'shirt',   name: 'Short kurta-shirt',    sub: 'Campus everyday',            price: 1299, accentLabel: 'Trousers', main: 'sky',      accent: 'charcoal' },
    { id: 'tee',     name: 'Oversized tee co-ord', sub: 'Jersey-weave khadi',         price: 1599, accentLabel: 'Joggers',  main: 'leaf',     accent: 'leaf' },
    { id: 'mundu',   name: 'Mundu & shirt',        sub: 'Kasavu border',              price: 1999, accentLabel: 'Mundu',    main: 'turmeric', accent: 'offwhite' },
    { id: 'kasavuK', name: 'Kasavu kurta',         sub: 'Onam & college day',         price: 2499, accentLabel: 'Pyjama',   main: 'offwhite', accent: 'offwhite' },
  ],
  female: [
    { id: 'palazzo',   name: 'Kurta & palazzo',    sub: 'With dupatta',                price: 2299, accentLabel: 'Palazzo & dupatta', main: 'madder', accent: 'offwhite' },
    { id: 'kasavuSet', name: 'Kasavu pavada set',  sub: 'Crop top + long skirt',       price: 2999, accentLabel: 'Skirt',    main: 'offwhite', accent: 'offwhite' },
    { id: 'saree',     name: 'Kasavu saree',       sub: 'Pleated, with pallu',         price: 4499, accentLabel: 'Blouse',   main: 'offwhite', accent: 'madder' },
    { id: 'coord',     name: 'Co-ord set',         sub: 'Boxy shirt + trousers',       price: 1899, accentLabel: 'Trousers', main: 'indigo',   accent: 'indigo' },
    { id: 'dress',     name: 'A-line dress',       sub: 'Knee length, flutter sleeve', price: 1699, accentLabel: 'Belt',     main: 'turmeric', accent: 'jackfruit' },
    { id: 'layer',     name: 'Jacket over kurti',  sub: 'Open-front long jacket',      price: 3299, accentLabel: 'Jacket',   main: 'sky',      accent: 'rust' },
  ],
};

const WEAVERS = [
  'Sindhu & Latha, Balaramapuram',
  'Ramani, Payyannur khadi unit',
  'Shobha & Geetha, Kunnukara',
  'Mini, Nemom handloom society',
  'Ambika & Usha, Kottayam unit',
  'Valsala, Kanjirampara',
];

/* ------------------------------------------------------------------ */
/* Mesh builds in a worker pool                                        */
/* ------------------------------------------------------------------ */

const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
const workers = [];
const queue = [];
const inflight = new Map();
let jid = 0;
let fallback = false;

function startWorkers() {
  try {
    for (let i = 0; i < POOL; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const { id, res, error } = e.data;
        const job = inflight.get(id);
        inflight.delete(id);
        w.busy = false;
        if (job) error ? job.reject(new Error(error)) : job.resolve(res);
        pump();
      };
      w.onerror = () => goLocal();
      workers.push(w);
    }
  } catch (e) { goLocal(); }
}
function goLocal() {
  if (fallback) return;
  fallback = true;
  const jobs = [...inflight.values(), ...queue.splice(0)];
  inflight.clear();
  workers.forEach((w) => w.terminate());
  jobs.forEach(runLocal);
}
let localChain = Promise.resolve();
function runLocal(job) {
  localChain = localChain.then(async () => {
    const T = await import('./tailor.js');
    await new Promise((r) => setTimeout(r, 20));
    try { job.resolve(job.msg.kind === 'avatar' ? T.makeAvatar(job.msg.gender) : T.makeOutfit(job.msg.gender, job.msg.outfit)); }
    catch (e) { job.reject(e); }
  });
}
function pump() {
  for (const w of workers) {
    if (w.busy || !queue.length) continue;
    const job = queue.shift();
    w.busy = true;
    inflight.set(job.id, job);
    w.postMessage({ id: job.id, ...job.msg });
  }
}
const jobsByKey = new Map();
const results = new Map();
function compute(kind, gender, outfit = '', urgent = false) {
  const key = `${kind}:${gender}:${outfit}`;
  if (results.has(key)) {
    const job = jobsByKey.get(key);
    if (urgent && job) { const i = queue.indexOf(job); if (i > 0) { queue.splice(i, 1); queue.unshift(job); } }
    return results.get(key);
  }
  const p = new Promise((resolve, reject) => {
    const job = { id: ++jid, msg: { kind, gender, outfit }, resolve, reject };
    jobsByKey.set(key, job);
    if (fallback) runLocal(job);
    else { urgent ? queue.unshift(job) : queue.push(job); pump(); }
  });
  results.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

const container = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
const HOME = { pos: new THREE.Vector3(0.55, 1.3, 4.0), target: new THREE.Vector3(0, 0.9, 0) };
camera.position.copy(HOME.pos);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.6;
controls.maxDistance = 6;
controls.minPolarAngle = 0.3;
controls.maxPolarAngle = 1.75;
controls.enablePan = false;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.0;

scene.add(new THREE.HemisphereLight(0xfff4e2, 0x7a6448, 0.55));
const key = new THREE.DirectionalLight(0xfff0dc, 2.4);
key.position.set(2.0, 3.6, 2.8);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -1.0; key.shadow.camera.right = 1.0;
key.shadow.camera.top = 2.0; key.shadow.camera.bottom = -0.2;
key.shadow.camera.near = 1; key.shadow.camera.far = 9;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.012;
key.shadow.radius = 3;
scene.add(key);
const rim = new THREE.DirectionalLight(0xffe2b8, 1.1);
rim.position.set(-2.6, 2.4, -2.6);
scene.add(rim);
const fill = new THREE.DirectionalLight(0xe8eeff, 0.35);
fill.position.set(-2.5, 1.2, 2.5);
scene.add(fill);

const plinth = new THREE.Mesh(new THREE.CircleGeometry(0.85, 96), new THREE.MeshStandardMaterial({ color: 0xe6d8bc, roughness: 0.95 }));
plinth.rotation.x = -Math.PI / 2;
plinth.receiveShadow = true;
scene.add(plinth);
const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 0.88, 96), new THREE.MeshStandardMaterial({ color: 0xb88a2e, roughness: 0.45, metalness: 0.5 }));
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.001;
scene.add(ring);

/* ------------------------------------------------------------------ */
/* Textures and materials                                              */
/* ------------------------------------------------------------------ */

function makeKhadiTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#e6e6e6';
  g.fillRect(0, 0, size, size);
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < size; i += 2) {
      const shade = 195 + Math.floor(rand() * 60);
      g.strokeStyle = `rgba(${shade},${shade},${shade},${0.35 + rand() * 0.4})`;
      g.lineWidth = 0.6 + rand() * 1.3;
      g.beginPath();
      if (pass === 0) { g.moveTo(i + rand(), 0); g.lineTo(i + rand(), size); }
      else { g.moveTo(0, i + rand()); g.lineTo(size, i + rand()); }
      g.stroke();
    }
  }
  for (let i = 0; i < 300; i++) {
    const x = rand() * size, y = rand() * size, len = 6 + rand() * 22;
    const shade = 225 + Math.floor(rand() * 30);
    g.strokeStyle = `rgba(${shade},${shade},${shade},0.8)`;
    g.lineWidth = 1.5 + rand() * 2;
    g.beginPath();
    if (rand() > 0.5) { g.moveTo(x, y); g.lineTo(x + len, y + rand()); } else { g.moveTo(x, y); g.lineTo(x + rand(), y + len); }
    g.stroke();
  }
  for (let i = 0; i < 140; i++) {
    g.fillStyle = `rgba(140,130,120,${0.15 + rand() * 0.25})`;
    g.fillRect(rand() * size, rand() * size, 1.5, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeEyeTexture() {
  const w = 256, h = 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#f4efe8'); grad.addColorStop(1, '#e9d6cf');
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  const irisEnd = h * 0.165, pupil = h * 0.06;
  for (let y = 0; y < irisEnd; y++) {
    const t = y / irisEnd;
    for (let x = 0; x < w; x += 2) {
      const n = Math.sin(x * 0.9) * 0.5 + Math.sin(x * 2.3 + y) * 0.5;
      const base = y < pupil ? 8 : 58 + 30 * t + 14 * n;
      const r = y < pupil ? 8 : base * 0.95, gg = y < pupil ? 6 : base * 0.62, b = y < pupil ? 5 : base * 0.38;
      g.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
      g.fillRect(x, y, 2, 1);
    }
  }
  g.fillStyle = 'rgba(30,18,10,0.85)';
  g.fillRect(0, irisEnd - 3, w, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStrandTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#9a9a9a';
  g.fillRect(0, 0, size, size);
  let seed = 11;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 1400; i++) {
    const x = rand() * size, v = 120 + rand() * 135;
    g.strokeStyle = `rgba(${v},${v},${v},${0.25 + rand() * 0.5})`;
    g.lineWidth = 0.5 + rand() * 1.1;
    g.beginPath();
    g.moveTo(x, -10);
    g.bezierCurveTo(x + (rand() - 0.5) * 14, size * 0.33, x + (rand() - 0.5) * 14, size * 0.66, x + (rand() - 0.5) * 10, size + 10);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const khadiTex = makeKhadiTexture();
const strandTex = makeStrandTexture();

// Sample the weave texture by world position so seams and stretching never show on generated meshes.
function triplanar(mat, scale) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.triScale = { value: scale };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriP;\nvarying vec3 vTriN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTriP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTriN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriP;\nvarying vec3 vTriN;\nuniform float triScale;')
      .replace('#include <map_fragment>', `
        vec3 tw = pow(abs(normalize(vTriN)), vec3(4.0));
        tw /= (tw.x + tw.y + tw.z);
        vec4 tcol = texture2D(map, vTriP.zy * triScale) * tw.x + texture2D(map, vTriP.xz * triScale) * tw.y + texture2D(map, vTriP.xy * triScale) * tw.z;
        diffuseColor *= tcol;`);
  };
  mat.customProgramCacheKey = () => 'tri' + scale;
  return mat;
}

const WHITE = new THREE.Color(1, 1, 1);
function fabricMat(hex) {
  const m = new THREE.MeshPhysicalMaterial({
    color: hex, map: khadiTex, roughness: 0.92, metalness: 0, sheen: 0.8, sheenRoughness: 0.75,
    sheenColor: new THREE.Color(hex).lerp(WHITE, 0.3), vertexColors: true, envMapIntensity: 0.45,
  });
  return triplanar(m, 3.2);
}
function setFabric(m, hex) { m.color.set(hex); m.sheenColor.set(hex).lerp(WHITE, 0.3); }
const goldMat = () => triplanar(new THREE.MeshPhysicalMaterial({
  color: 0xc99a3c, map: khadiTex, metalness: 0.85, roughness: 0.36, vertexColors: true, envMapIntensity: 1.1,
}), 5.0);

const garmentMats = [fabricMat('#efe6d2'), fabricMat('#2e3f6e'), goldMat()];

const skinMat = new THREE.MeshPhysicalMaterial({
  vertexColors: true, roughness: 0.5, sheen: 0.4, sheenRoughness: 0.55, sheenColor: new THREE.Color(0xff9878),
  clearcoat: 0.08, clearcoatRoughness: 0.45, envMapIntensity: 0.4,
});
const skinMatCoarse = skinMat.clone();
skinMatCoarse.polygonOffset = true;
skinMatCoarse.polygonOffsetFactor = 2;
skinMatCoarse.polygonOffsetUnits = 2;

const hairMats = [
  triplanar(new THREE.MeshPhysicalMaterial({ color: 0x2a201a, map: strandTex, roughness: 0.6, sheen: 0.7, sheenColor: new THREE.Color(0x6a4c38), sheenRoughness: 0.45, vertexColors: true, envMapIntensity: 0.35 }), 14),
  new THREE.MeshStandardMaterial({ color: 0xfbf8ef, roughness: 0.55, vertexColors: true }),
];
const shoeMats = [
  new THREE.MeshPhysicalMaterial({ color: 0x4b2a18, roughness: 0.48, clearcoat: 0.3, clearcoatRoughness: 0.4, vertexColors: true }),
  new THREE.MeshStandardMaterial({ color: 0x21160f, roughness: 0.8, vertexColors: true }),
  new THREE.MeshPhysicalMaterial({ color: 0xc99a3c, metalness: 0.85, roughness: 0.35, vertexColors: true }),
];
const eyeMat = new THREE.MeshPhysicalMaterial({ map: makeEyeTexture(), roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 0.9 });
const eyeGeo = new THREE.SphereGeometry(1, 40, 28);
eyeGeo.rotateX(Math.PI / 2);
const buttonMats = {
  wood: new THREE.MeshStandardMaterial({ color: 0x5f3b20, roughness: 0.45 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xc9a04a, metalness: 0.9, roughness: 0.3 }),
  shell: new THREE.MeshPhysicalMaterial({ color: 0xf2ede2, roughness: 0.3, clearcoat: 0.8 }),
};

/* ------------------------------------------------------------------ */
/* Turning worker output into meshes                                   */
/* ------------------------------------------------------------------ */

function toGeometry(m) {
  const g = new THREE.BufferGeometry();
  const n = m.pos.length / 3;
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = m.ao[i];
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  if (m.groups.length) for (const gr of m.groups) g.addGroup(gr.start, gr.count, gr.zone);
  else g.addGroup(0, m.idx.length, 0);
  g.userData.ao = m.ao;
  g.userData.tint = m.tint;
  g.computeBoundingSphere();
  return g;
}
function meshOf(m, mats) {
  const mesh = new THREE.Mesh(toGeometry(m), mats);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

const avatarObjs = {};
const outfitObjs = {};
const skinGeos = {};

function avatarObject(gender) {
  if (!avatarObjs[gender]) {
    avatarObjs[gender] = compute('avatar', gender, '', true).then((a) => {
      const g = new THREE.Group();
      const geos = [];
      const coarse = meshOf(a.skinCoarse, [skinMatCoarse]);
      g.add(coarse); geos.push(coarse.geometry);
      for (const f of a.skinFine) { const m = meshOf(f, [skinMat]); g.add(m); geos.push(m.geometry); }
      g.add(meshOf(a.hair, hairMats));
      g.add(meshOf(a.shoes, shoeMats));
      for (const e of a.eyes) {
        const m = new THREE.Mesh(eyeGeo, eyeMat);
        m.position.fromArray(e.c);
        m.scale.setScalar(e.r);
        g.add(m);
      }
      skinGeos[gender] = geos;
      return g;
    });
  }
  return avatarObjs[gender];
}

function outfitObject(gender, id, urgent) {
  const key = gender + ':' + id;
  if (!outfitObjs[key]) {
    outfitObjs[key] = compute('outfit', gender, id, urgent).then((o) => {
      const g = new THREE.Group();
      for (const m of [...o.meshes, ...o.fine]) g.add(meshOf(m, garmentMats));
      if (o.buttons.length) {
        const bg = new THREE.CylinderGeometry(o.buttonR, o.buttonR * 0.92, 0.0028, 24);
        bg.rotateX(Math.PI / 2);
        const inst = new THREE.InstancedMesh(bg, buttonMats[o.buttonStyle] || buttonMats.wood, o.buttons.length);
        const q = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1), mtx = new THREE.Matrix4();
        o.buttons.forEach((b, i) => {
          q.setFromUnitVectors(zAxis, new THREE.Vector3().fromArray(b.n));
          mtx.compose(new THREE.Vector3().fromArray(b.p), q, new THREE.Vector3(1, 1, 1));
          inst.setMatrixAt(i, mtx);
        });
        inst.castShadow = true;
        g.add(inst);
      }
      g.userData.jasmine = o.jasmine;
      return g;
    });
  } else if (urgent) compute('outfit', gender, id, true);
  return outfitObjs[key];
}

function paintSkin() {
  const tone = new THREE.Color(state.skin);
  for (const geo of skinGeos[state.gender] || []) {
    const ao = geo.userData.ao, tint = geo.userData.tint, col = geo.attributes.color.array;
    for (let i = 0; i < ao.length; i++) {
      const a = ao[i];
      col[i * 3] = tone.r * a * (tint ? tint[i * 3] : 1);
      col[i * 3 + 1] = tone.g * a * (tint ? tint[i * 3 + 1] : 1);
      col[i * 3 + 2] = tone.b * a * (tint ? tint[i * 3 + 2] : 1);
    }
    geo.attributes.color.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
/* State + UI                                                          */
/* ------------------------------------------------------------------ */

const state = {
  gender: 'male',
  outfit: OUTFITS.male[0].id,
  main: OUTFITS.male[0].main,
  accent: OUTFITS.male[0].accent,
  skin: SKINS[1],
};

const $ = (id) => document.getElementById(id);
const colorHex = (id) => PALETTE.find((p) => p.id === id).hex;
const outfitMeta = () => OUTFITS[state.gender].find((o) => o.id === state.outfit);

function applyColors() {
  setFabric(garmentMats[0], colorHex(state.main));
  setFabric(garmentMats[1], colorHex(state.accent));
}

let figure = null;
let buildToken = 0;
let firstDone = false;
function setBusy(on) {
  if (!firstDone) return;
  $('busy').classList.toggle('on', on);
}

async function rebuild() {
  const token = ++buildToken;
  syncUI();
  applyColors();
  setBusy(true);
  const g = state.gender, id = state.outfit;
  try {
    const [av, of] = await Promise.all([avatarObject(g), outfitObject(g, id, true)]);
    if (token !== buildToken) return;
    if (figure) scene.remove(figure);
    figure = new THREE.Group();
    figure.add(av, of);
    scene.add(figure);
    hairMats[1].visible = !!of.userData.jasmine;
    paintSkin();
    if (!firstDone) { firstDone = true; $('loading').classList.add('done'); }
  } catch (e) {
    console.error(e);
    $('loading').textContent = 'Could not build the model. Please reload.';
  } finally {
    if (token === buildToken) setBusy(false);
  }
  prefetch();
}

let prefetched = false;
function prefetch() {
  if (prefetched) return;
  prefetched = true;
  const g = state.gender, other = g === 'male' ? 'female' : 'male';
  for (const o of OUTFITS[g]) outfitObject(g, o.id, false);
  avatarObject(other);
  outfitObject(other, OUTFITS[other][0].id, false);
  for (const o of OUTFITS[other]) outfitObject(other, o.id, false);
}

function renderControls() {
  document.querySelectorAll('#genderSeg button').forEach((btn) => {
    btn.onclick = () => {
      if (state.gender === btn.dataset.gender) return;
      state.gender = btn.dataset.gender;
      const o = OUTFITS[state.gender][0];
      Object.assign(state, { outfit: o.id, main: o.main, accent: o.accent });
      renderOutfits();
      rebuild();
    };
  });
  $('skinRow').innerHTML = '';
  SKINS.forEach((hex, i) => {
    const s = document.createElement('button');
    s.className = 'skin';
    s.style.background = hex;
    s.setAttribute('aria-label', `Skin tone ${i + 1}`);
    s.onclick = () => { state.skin = hex; paintSkin(); syncUI(); };
    $('skinRow').appendChild(s);
  });
  for (const which of ['main', 'accent']) {
    const box = $(which + 'Swatches');
    box.innerHTML = '';
    PALETTE.forEach((p) => {
      const s = document.createElement('button');
      s.className = 'sw';
      s.style.backgroundColor = p.hex;
      s.title = p.name;
      s.setAttribute('aria-label', p.name);
      s.dataset.id = p.id;
      s.onclick = () => { state[which] = p.id; applyColors(); syncUI(); };
      box.appendChild(s);
    });
  }
  renderOutfits();
}

function renderOutfits() {
  const grid = $('outfitGrid');
  grid.innerHTML = '';
  OUTFITS[state.gender].forEach((o) => {
    const b = document.createElement('button');
    b.className = 'outfit';
    b.innerHTML = `<b>${o.name}</b><span>${o.sub}</span>`;
    b.dataset.id = o.id;
    b.onclick = () => {
      if (state.outfit === o.id) return;
      Object.assign(state, { outfit: o.id, main: o.main, accent: o.accent });
      rebuild();
    };
    grid.appendChild(b);
  });
}

const inr = (n) => '₹' + n.toLocaleString('en-IN');

function syncUI() {
  document.querySelectorAll('#genderSeg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.gender === state.gender)));
  document.querySelectorAll('.skin').forEach((s, i) => s.setAttribute('aria-pressed', String(SKINS[i] === state.skin)));
  document.querySelectorAll('.outfit').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === state.outfit)));
  for (const which of ['main', 'accent']) {
    document.querySelectorAll(`#${which}Swatches .sw`).forEach((s) => s.setAttribute('aria-pressed', String(s.dataset.id === state[which])));
    $(which + 'Name').textContent = PALETTE.find((p) => p.id === state[which]).name;
  }
  const o = outfitMeta();
  $('accentLabel').textContent = o.accentLabel;
  $('mainLabel').textContent = 'Main colour';

  const idx = OUTFITS[state.gender].indexOf(o);
  const weaver = Math.round((o.price * 0.3) / 10) * 10;
  const spin = Math.round((o.price * 0.12) / 10) * 10;
  const rest = o.price - weaver - spin;
  $('wTitle').textContent = o.name;
  $('wDesc').textContent = `${o.sub} · ${PALETTE.find((p) => p.id === state.main).name}`;
  $('wPrice').textContent = inr(o.price);
  $('wWeaver').textContent = inr(weaver);
  $('wSpin').textContent = inr(spin);
  $('wRest').textContent = inr(rest);
  $('wBarWeaver').style.width = (weaver / o.price) * 100 + '%';
  $('wBarSpin').style.width = (spin / o.price) * 100 + '%';
  $('wBarRest').style.width = (rest / o.price) * 100 + '%';
  $('wMade').textContent = `Handspun and handwoven by ${WEAVERS[(idx + (state.gender === 'female' ? 3 : 0)) % WEAVERS.length]}.`;
}

const rotateBtn = $('rotateBtn');
rotateBtn.onclick = () => {
  controls.autoRotate = !controls.autoRotate;
  rotateBtn.setAttribute('aria-pressed', String(controls.autoRotate));
  rotateBtn.textContent = controls.autoRotate ? 'Auto-rotate on' : 'Auto-rotate off';
};
$('resetBtn').onclick = () => {
  camera.position.copy(HOME.pos);
  controls.target.copy(HOME.target);
  controls.update();
};
$('closeBtn').onclick = () => {
  const head = state.gender === 'male' ? 1.6 : 1.49;
  controls.target.set(0, head, 0);
  camera.position.set(0.42, head + 0.04, 1.3);
  controls.update();
};
$('snapBtn').onclick = () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png');
  a.download = `nool-${state.gender}-${state.outfit}-${state.main}.png`;
  a.click();
};

/* ------------------------------------------------------------------ */
/* Loop                                                                */
/* ------------------------------------------------------------------ */

function resize() {
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.zoom = Math.min(1, camera.aspect / 1.1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(container);
resize();

startWorkers();
renderControls();
rebuild();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

window.nool = { state, rebuild, controls, camera, renderer, scene, applyColors, paintSkin, ready: () => firstDone, compute };
