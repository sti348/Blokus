/*
 * BlockTurf 三维牌桌：坐在桌前，用手拿起棋子、旋转翻转、放到棋盘上。
 *
 * 规则、电脑和计分全部沿用 js/engine.js、js/ai.js；这里只负责三维场景、镜头、操作和对局流程。
 * 环境（房间、灯光、桌子）由 environments.js 的配置描述、props.js 搭建，与对局互不相干，随时可换。
 */
import * as THREE from '../vendor/three.module.min.js';
import { ENVIRONMENTS, environmentById } from './environments.js';
import { buildEnvironment, TABLE_Y } from './props.js';

const Engine = window.BlokusEngine;
const AI = window.BlokusAI;
const Logic = window.BlokusTableLogic;

const STORE = 'blockturf.table.v1';
const COLORS = { blue: '#2a63d6', yellow: '#eeb200', red: '#e03a2e', green: '#1f9a47', violet: '#7b4fe0', orange: '#ef7612' };
const LEVELS = ['easy', 'normal', 'hard', 'expert'];
const THICK = 0.42;
const BOARD_Y = THICK / 2;
const TRAY_Y = TABLE_Y + THICK / 2 + 0.03;
const HOVER_Y = 0.95;

const $ = (id) => document.getElementById(id);

/* ================= 文字 ================= */

const TEXT = {
  en: {
    you: 'You', ai: '{c} AI', yourTurn: 'Your turn', turnOf: '{n}’s turn', thinking: '{n} is thinking…', over: 'Game over',
    'c.blue': 'Blue', 'c.yellow': 'Yellow', 'c.red': 'Red', 'c.green': 'Green', 'c.violet': 'Purple', 'c.orange': 'Orange',
    'l.easy': 'Easy', 'l.normal': 'Normal', 'l.hard': 'Hard', 'l.expert': 'Master', human: 'Player',
    left: '{n} left', done: 'done', blocked: '{n} has no moves left',
    tipPick: 'Click one of your pieces to pick it up · drag to look around · scroll to zoom',
    tipPickTouch: 'Tap or drag one of your pieces · drag the table to look around · pinch to zoom',
    tipHold: 'Click the board to place · R or right-click rotate · F flip · Esc put back',
    tipHoldTouch: 'Drag the piece onto the board, then press Place',
    rotate: 'Rotate', flip: 'Flip', place: 'Place', putBack: 'Put back',
    env: 'Room', top: 'Top view', seat: 'Seat view', hints: 'Corner hints', sound: 'Sound', undo: 'Undo', suggest: 'Hint', newGame: 'New game', menu: 'Flat board',
    'bad.occupied': 'That spot is taken', 'bad.edge': 'Your own pieces may only touch at corners', 'bad.start': 'Your first piece must cover your start corner',
    'bad.corner': 'It must touch a corner of one of your pieces', 'bad.bounds': 'That is off the board', 'bad.other': 'It can’t go there',
    setupTitle: 'New game', board: 'Board', classic: 'Classic 20×20 · 4 players', duo: 'Duo 14×14 · 2 players', seats: 'Seats', start: 'Sit down and play', cancel: 'Cancel',
    youWin: 'You win!', youRank: 'You came {n}', wins: '{n} wins', tie: 'Tied: {n}', pieces: '{n} pieces', cells: '{n} cells', again: 'Play again', view: 'View the board',
    resumed: 'Picked up where you left off', noUndo: 'Nothing to undo', noGl: 'This mode needs WebGL, which is not available in this browser.',
    stop: 'Stop — no more moves'
  },
  'zh-CN': {
    you: '你', ai: '{c}方电脑', yourTurn: '轮到你了', turnOf: '轮到{n}', thinking: '{n}正在思考…', over: '对局结束',
    'c.blue': '蓝', 'c.yellow': '黄', 'c.red': '红', 'c.green': '绿', 'c.violet': '紫', 'c.orange': '橙',
    'l.easy': '简单', 'l.normal': '普通', 'l.hard': '困难', 'l.expert': '大师', human: '玩家',
    left: '剩 {n} 块', done: '已停手', blocked: '{n}无处可放了',
    tipPick: '点自己的棋子把它拿起来 · 拖动环顾四周 · 滚轮缩放',
    tipPickTouch: '点或拖自己的棋子 · 拖动桌面环顾四周 · 双指缩放',
    tipHold: '点棋盘落子 · R 或右键旋转 · F 翻面 · Esc 放回去',
    tipHoldTouch: '把棋子拖到棋盘上，再按「落子」',
    rotate: '旋转', flip: '翻面', place: '落子', putBack: '放回',
    env: '环境', top: '俯视', seat: '坐姿', hints: '角点提示', sound: '声音', undo: '悔棋', suggest: '提示', newGame: '新对局', menu: '平面棋盘',
    'bad.occupied': '这里已经有棋子了', 'bad.edge': '自己的棋子只能角对角，不能边挨边', 'bad.start': '第一块必须盖住自己的起点角',
    'bad.corner': '必须和自己的棋子角对角相连', 'bad.bounds': '放到棋盘外面了', 'bad.other': '这里放不下',
    setupTitle: '新对局', board: '棋盘', classic: '标准 20×20 · 四方', duo: '双人 14×14 · 两方', seats: '座位', start: '坐下开局', cancel: '取消',
    youWin: '你赢了！', youRank: '你是第 {n} 名', wins: '{n}获胜', tie: '并列第一：{n}', pieces: '{n} 块', cells: '{n} 格', again: '再来一局', view: '看看棋盘',
    resumed: '接着上次的对局', noUndo: '没有可以悔的棋', noGl: '这个模式需要 WebGL，当前浏览器不支持。',
    stop: '停手（不再落子）'
  }
};

function pickLang() {
  let lang = null;
  try { lang = (JSON.parse(localStorage.getItem('blokus.prefs.v1')) || {}).lang; } catch (e) { /* 用浏览器语言 */ }
  lang = lang || navigator.language || 'en';
  return /^zh/i.test(lang) ? 'zh-CN' : 'en';
}
const LANG = pickLang();
function t(key, params) {
  let s = (TEXT[LANG] && TEXT[LANG][key]) || TEXT.en[key] || key;
  if (params) Object.keys(params).forEach((k) => { s = s.replace('{' + k + '}', params[k]); });
  return s;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ================= 存档 ================= */

function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    return s && s.v === 1 ? s : null;
  } catch (e) { return null; }
}
const saved = loadSave() || {};
const settings = {
  env: saved.env || ENVIRONMENTS[0].id,
  hints: saved.hints !== false,
  sound: saved.sound !== false
};

/* ================= 渲染器与场景 ================= */

const canvas = $('view');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  $('nogl').hidden = false;
  $('nogl').textContent = t('noGl');
  throw e;
}
// 画质档位：0 高（默认）、1 中、2 低。帧率太低时自动降档；网址加 ?q=low / ?q=mid 可以直接指定
const QUALITY = [
  { dpr: 2, shadows: true, shadowMap: 2048 },
  { dpr: 1, shadows: true, shadowMap: 1024 },
  { dpr: 0.75, shadows: false, shadowMap: 512 }
];
const qParam = new URLSearchParams(location.search).get('q');
let quality = qParam === 'low' ? 2 : qParam === 'mid' ? 1 : 0;
function applyQuality() {
  const q = QUALITY[quality];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
  renderer.shadowMap.enabled = q.shadows;
  scene.traverse((o) => {
    if (o.isLight && o.shadow) { o.castShadow = q.shadows && !!o.userData.key; o.shadow.mapSize.set(q.shadowMap, q.shadowMap); if (o.shadow.map) { o.shadow.map.dispose(); o.shadow.map = null; } }
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
  });
  resize();
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[quality].dpr));
renderer.shadowMap.enabled = QUALITY[quality].shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 1, 900);
const pmrem = new THREE.PMREMGenerator(renderer);

// 对局用的空间：局部坐标就是棋盘格坐标 (x, y) → (x, z)；整体转 90° 让 0 号座位正对默认镜头
const play = new THREE.Group();
play.rotation.y = Math.PI / 2;
const off = new THREE.Group();
play.add(off);
scene.add(play);
const boardGroup = new THREE.Group();
const pieceGroup = new THREE.Group();
const markGroup = new THREE.Group();
off.add(boardGroup, pieceGroup, markGroup);

/* ================= 镜头 ================= */

const rig = {
  az: 0, pol: 0.86, dist: 64, target: new THREE.Vector3(0, 0, 5),
  goal: { az: 0, pol: 0.86, dist: 64, target: new THREE.Vector3(0, 0, 5) },
  top: false, saved: null, spin: 0
};

function seatAzimuth(playerIndex) {
  const o = Logic.seatOut(playerIndex, G.st.players.length);
  // 引擎方向 (ex, ey) → 世界方向 (ey, -ex)
  return Math.atan2(o[1], -o[0]);
}

function nearestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return from + d;
}

function updateCamera(dt) {
  const g = rig.goal;
  if (rig.spin) g.az += rig.spin * dt;
  g.pol = THREE.MathUtils.clamp(g.pol, 0.03, 1.36);
  g.dist = THREE.MathUtils.clamp(g.dist, 16, 100);
  const a = 1 - Math.exp(-dt * 7);
  rig.az += (g.az - rig.az) * a;
  rig.pol += (g.pol - rig.pol) * a;
  rig.dist += (g.dist - rig.dist) * a;
  rig.target.lerp(g.target, a);
  const sp = Math.sin(rig.pol);
  camera.position.set(
    rig.target.x + rig.dist * sp * Math.sin(rig.az),
    rig.target.y + rig.dist * Math.cos(rig.pol),
    rig.target.z + rig.dist * sp * Math.cos(rig.az)
  );
  camera.lookAt(rig.target);
}

function seatTarget(az) {
  // 视线落在棋盘中心稍偏向自己一侧，能同时看到面前的棋子
  return new THREE.Vector3(Math.sin(az) * 7.5, 0, Math.cos(az) * 7.5);
}

function setTopView(on) {
  if (on === rig.top) return;
  rig.top = on;
  if (on) {
    rig.saved = { pol: rig.goal.pol, dist: rig.goal.dist };
    rig.goal.pol = 0.03;
    rig.goal.dist = Math.max(rig.goal.dist, 74);
    rig.goal.target.copy(seatTarget(rig.goal.az));
  } else if (rig.saved) {
    rig.goal.pol = rig.saved.pol;
    rig.goal.dist = rig.saved.dist;
  }
  $('view-btn').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('view-btn').title = t(on ? 'seat' : 'top');
}

/* ================= 棋子与棋盘的模型 ================= */

const cellGeo = (function () {
  const s = 0.4, r = 0.09, b = 0.055;
  const sh = new THREE.Shape();
  sh.moveTo(-s + r, -s); sh.lineTo(s - r, -s); sh.quadraticCurveTo(s, -s, s, -s + r);
  sh.lineTo(s, s - r); sh.quadraticCurveTo(s, s, s - r, s);
  sh.lineTo(-s + r, s); sh.quadraticCurveTo(-s, s, -s, s - r);
  sh.lineTo(-s, -s + r); sh.quadraticCurveTo(-s, -s, -s + r, -s);
  const depth = THICK - 2 * b;
  const g = new THREE.ExtrudeGeometry(sh, { depth: depth, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 3, curveSegments: 5 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -depth / 2, 0);
  return g;
})();

function pieceGeometry(def) {
  const offs = Logic.pose(def, 0, false).offsets;
  const parts = [];
  offs.forEach((o) => { parts.push(cellGeo.clone().translate(o[0], 0, o[1])); });
  // 相邻格之间的连接块，让整块棋子是一个实体
  offs.forEach((a, i) => {
    offs.forEach((c, j) => {
      if (j <= i) return;
      const dx = c[0] - a[0], dz = c[1] - a[1];
      if (Math.abs(dx) + Math.abs(dz) !== 1) return;
      const link = new THREE.BoxGeometry(dx ? 0.3 : 0.56, THICK * 0.62, dx ? 0.56 : 0.3).toNonIndexed();
      link.translate((a[0] + c[0]) / 2, 0, (a[1] + c[1]) / 2);
      parts.push(link);
    });
  });
  let n = 0;
  parts.forEach((p) => { n += p.attributes.position.count; });
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let at = 0;
  parts.forEach((p) => {
    pos.set(p.attributes.position.array, at * 3);
    nor.set(p.attributes.normal.array, at * 3);
    at += p.attributes.position.count;
    p.dispose();
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.computeBoundingSphere();
  return g;
}

function quatFor(k, flip) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), k * Math.PI / 2);
  if (flip) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
  return q;
}

function clearGroup(g) {
  while (g.children.length) {
    const o = g.children.pop();
    o.traverse((m) => {
      if (m.geometry && m.geometry !== cellGeo) m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
  }
}

function buildBoard(style) {
  clearGroup(boardGroup);
  const N = G.st.topo.cols, c = (N - 1) / 2;
  const base = new THREE.Mesh(new THREE.BoxGeometry(N, 0.5, N), new THREE.MeshStandardMaterial({ color: style.base, roughness: 0.55 }));
  base.position.set(c, -0.25, c); base.receiveShadow = true;
  boardGroup.add(base);
  const ridge = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: style.ridge, roughness: 0.5 }), (N + 1) * 2);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  for (let i = 0; i <= N; i++) {
    m4.compose(new THREE.Vector3(i - 0.5, 0.03, c), q, new THREE.Vector3(0.07, 0.06, N));
    ridge.setMatrixAt(i * 2, m4);
    m4.compose(new THREE.Vector3(c, 0.03, i - 0.5), q, new THREE.Vector3(N, 0.06, 0.07));
    ridge.setMatrixAt(i * 2 + 1, m4);
  }
  ridge.receiveShadow = true;
  boardGroup.add(ridge);
  const frameMat = new THREE.MeshStandardMaterial({ color: style.frame, roughness: style.frameRoughness || 0.5 });
  const fw = 0.95, fh = 0.74, half = N / 2 + fw / 2;
  [[0, -half, N + fw * 2, fw], [0, half, N + fw * 2, fw], [-half, 0, fw, N], [half, 0, fw, N]].forEach((f) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(f[2], fh, f[3]), frameMat);
    m.position.set(c + f[0], TABLE_Y + fh / 2, c + f[1]);
    m.castShadow = true; m.receiveShadow = true;
    boardGroup.add(m);
  });
  // 起点标记
  G.st.players.forEach((pl) => {
    pl.startIdx.forEach((idx) => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.33, 28), new THREE.MeshBasicMaterial({ color: COLORS[pl.color], transparent: true, opacity: 0.9 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(idx % N, 0.012, Math.floor(idx / N));
      boardGroup.add(ring);
    });
  });
}

/* ---------- 棋盘上的标记：落点投影、角点、提示 ---------- */

const quadGeo = new THREE.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2);
const ghostMat = new THREE.MeshBasicMaterial({ color: '#3ddc84', transparent: true, opacity: 0.6, depthWrite: false });
const suggestMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7, depthWrite: false });
const ghost = [], suggest = [];
for (let i = 0; i < 5; i++) {
  const a = new THREE.Mesh(quadGeo, ghostMat); a.visible = false; a.position.y = 0.11; a.renderOrder = 2; ghost.push(a); markGroup.add(a);
  const b = new THREE.Mesh(quadGeo, suggestMat); b.visible = false; b.position.y = 0.105; b.renderOrder = 1; suggest.push(b); markGroup.add(b);
}
const anchorMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false });
const anchors = new THREE.InstancedMesh(new THREE.CircleGeometry(0.17, 20).rotateX(-Math.PI / 2), anchorMat, 420);
anchors.count = 0; anchors.frustumCulled = false; anchors.renderOrder = 1;
markGroup.add(anchors);

function showAnchors() {
  anchors.count = 0;
  const st = G.st;
  if (!settings.hints || st.over || !isHuman(st.current)) return;
  const pl = st.players[st.current];
  const forb = Engine.forbiddenMask(st.board, st.topo, st.current);
  const list = Engine.anchorMask(st.board, st.topo, st.current, pl, forb).list;
  const N = st.topo.cols, m4 = new THREE.Matrix4();
  list.slice(0, 420).forEach((idx, i) => {
    m4.makeTranslation(idx % N, 0.1, Math.floor(idx / N));
    anchors.setMatrixAt(i, m4);
  });
  anchors.count = Math.min(420, list.length);
  anchors.instanceMatrix.needsUpdate = true;
  anchorMat.color.set(COLORS[pl.color]);
}

function clearSuggest() {
  suggest.forEach((m) => { m.visible = false; });
  if (G.suggestPc) { G.suggestPc.glow = 0; G.suggestPc = null; }
}

/* ================= 对局状态 ================= */

const G = {
  config: null, st: null, evCursor: 0, gen: 0,
  P: [],                // P[player][piece] = 棋子记录
  held: null, heldGoal: null, heldBoost: 0, heldCell: null,
  hover: null, last: null, suggestPc: null,
  busy: false, anims: [], ended: false
};

function isHuman(p) { return G.config.players[p].type === 'human'; }
function humanCount() { return G.config.players.filter((p) => p.type === 'human').length; }
function colorName(pl) { return t('c.' + pl.color); }
function nameOf(p) {
  const pl = G.st.players[p];
  if (isHuman(p)) return humanCount() === 1 ? t('you') : colorName(pl);
  return t('ai', { c: colorName(pl) });
}

function defaultConfig(mode, seats) {
  const m = Engine.MODES[mode];
  const entries = m.seats.map((s, i) => {
    const sel = seats && seats[i] ? seats[i] : (i === 0 ? 'human' : 'normal');
    return { seat: i, name: s.label, type: sel === 'human' ? 'human' : 'ai', level: sel === 'human' ? 'normal' : sel };
  });
  return Engine.buildConfig(mode, entries);
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      v: 1, env: settings.env, hints: settings.hints, sound: settings.sound,
      config: G.config, actions: G.st ? G.st.actions : []
    }));
  } catch (e) { /* 存不了就算了 */ }
}

/* ---------- 棋子 ---------- */

function buildPieces() {
  clearGroup(pieceGroup);
  G.P = [];
  const st = G.st, N = st.topo.cols, defs = st.set.pieces;
  const geos = defs.map(pieceGeometry);
  st.players.forEach((pl, p) => {
    const lay = Logic.trayLayout(defs, N, Logic.seatOut(p, st.players.length));
    const col = new THREE.Color(COLORS[pl.color]);
    G.P.push(defs.map((def, i) => {
      const mat = new THREE.MeshPhysicalMaterial({
        color: col, roughness: 0.2, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.18,
        emissive: col, emissiveIntensity: 0.05
      });
      const mesh = new THREE.Mesh(geos[i], mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      const pc = { mesh: mesh, mat: mat, player: p, piece: i, def: def, k: 0, flip: false, home: lay.slots[i], where: 'tray', glow: 0, lift: 0 };
      mesh.userData.pc = pc;
      pieceGroup.add(mesh);
      return pc;
    }));
  });
}

function homePos(pc) { return new THREE.Vector3(pc.home.x, TRAY_Y, pc.home.z); }

function boardPos(pc, action) {
  const pose = Logic.pose(pc.def, pc.k, pc.flip);
  return new THREE.Vector3(action.x - pose.minX, BOARD_Y, action.y - pose.minZ);
}

function animate(pc, toPos, toQuat, dur, arc, done) {
  G.anims = G.anims.filter((a) => a.pc !== pc);
  G.anims.push({ pc: pc, t: 0, dur: dur, p0: pc.mesh.position.clone(), p1: toPos, q0: pc.mesh.quaternion.clone(), q1: toQuat, arc: arc, done: done });
}

// 让所有棋子回到当前局面该在的位置（读档、悔棋、新开局）
function syncPieces(animated) {
  const placed = {};
  G.st.actions.forEach((a) => { if (a.type === 'place') placed[a.player + ':' + a.piece] = a; });
  G.P.forEach((list) => list.forEach((pc) => {
    const a = placed[pc.player + ':' + pc.piece];
    let pos, quat;
    if (a) {
      const kf = Logic.poseForOrient(pc.def, a.orient, pc.k, pc.flip);
      pc.k = kf.k; pc.flip = kf.flip; pc.where = 'board';
      pos = boardPos(pc, a);
    } else {
      pc.k = pc.home.k; pc.flip = false; pc.where = 'tray';
      pos = homePos(pc);
    }
    quat = quatFor(pc.k, pc.flip);
    pc.glow = 0; pc.lift = 0;
    if (animated && pc.mesh.position.distanceTo(pos) > 0.05) animate(pc, pos, quat, 0.5, 2.5);
    else {
      G.anims = G.anims.filter((x) => x.pc !== pc);
      pc.mesh.position.copy(pos); pc.mesh.quaternion.copy(quat);
    }
  }));
  const lm = G.st.lastMove;
  setLast(lm ? G.P[lm.player][lm.piece] : null);
}

function setLast(pc) {
  if (G.last) G.last.glow = 0;
  G.last = pc;
  if (pc) pc.glow = 0.3;
}

/* ================= 声音 ================= */

let audio = null;
function sfx(kind) {
  if (!settings.sound) return;
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const now = audio.currentTime;
    if (kind === 'bad') {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(170, now); o.frequency.exponentialRampToValueAtTime(110, now + 0.14);
      g.gain.setValueAtTime(0.12, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      o.connect(g); g.connect(audio.destination); o.start(now); o.stop(now + 0.18);
      return;
    }
    const len = kind === 'place' ? 0.09 : 0.04;
    const buf = audio.createBuffer(1, Math.ceil(audio.sampleRate * len), audio.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    const src = audio.createBufferSource(); src.buffer = buf;
    const bp = audio.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'place' ? 1500 : 3200; bp.Q.value = 0.9;
    const g = audio.createGain(); g.gain.value = kind === 'place' ? 0.75 : 0.22;
    src.connect(bp); bp.connect(g); g.connect(audio.destination); src.start(now);
    if (kind === 'place') {
      const o = audio.createOscillator(), og = audio.createGain();
      o.frequency.setValueAtTime(190, now); o.frequency.exponentialRampToValueAtTime(80, now + 0.09);
      og.gain.setValueAtTime(0.3, now); og.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      o.connect(og); og.connect(audio.destination); o.start(now); o.stop(now + 0.13);
    }
  } catch (e) { /* 没有声音也能玩 */ }
}

/* ================= 电脑 ================= */

let worker = null, aiSeq = 0;
try { worker = new Worker('js/table/ai-worker.js'); worker.onerror = () => { worker = null; }; } catch (e) { worker = null; }

function askAI(level) {
  const id = ++aiSeq;
  const st = G.st;
  return new Promise((resolve) => {
    const local = () => setTimeout(() => {
      const m = st.over ? null : AI.chooseMove(st, level);
      resolve(m ? { piece: m.piece, orient: m.orient, x: m.x, y: m.y } : null);
    }, 30);
    if (!worker) { local(); return; }
    const w = worker;
    const onMsg = (e) => { if (e.data.id === id) { w.removeEventListener('message', onMsg); resolve(e.data.move); } };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', () => { w.removeEventListener('message', onMsg); worker = null; local(); }, { once: true });
    w.postMessage({ id: id, config: G.config, actions: st.actions, level: level });
  });
}

/* ================= 对局流程 ================= */

function startGame(config, actions) {
  G.gen++;
  G.config = config;
  G.st = Engine.replay(config, actions || []);
  G.evCursor = G.st.events.length;
  G.held = null; G.hover = null; G.last = null; G.suggestPc = null; G.busy = false; G.anims = []; G.ended = false;
  hideGhost(); clearSuggest();
  rig.spin = 0;
  buildBoard(environmentById(settings.env).board);
  buildPieces();
  off.position.set(-(G.st.topo.cols - 1) / 2, 0, -(G.st.topo.cols - 1) / 2);
  syncPieces(false);
  const first = G.config.players.findIndex((p) => p.type === 'human');
  const az = first >= 0 ? seatAzimuth(first) : 0;
  rig.goal.az = nearestAngle(rig.goal.az, az);
  rig.goal.pol = (environmentById(settings.env).camera || {}).polar || 0.86;
  rig.goal.dist = G.st.topo.cols > 16 ? 66 : 56;
  rig.goal.target.copy(seatTarget(az));
  rig.top = false; $('view-btn').setAttribute('aria-pressed', 'false');
  closeDialog('end-dialog');
  nextTurn();
}

function flushEvents() {
  const ev = G.st.events;
  for (; G.evCursor < ev.length; G.evCursor++) {
    if (ev[G.evCursor].type === 'blocked') toast(t('blocked', { n: nameOf(ev[G.evCursor].player) }));
  }
}

function nextTurn() {
  save();
  renderHud();
  const st = G.st;
  if (st.over) { endGame(); return; }
  const p = st.current;
  if (isHuman(p)) {
    if (humanCount() > 1 || rig.spin) {
      const az = nearestAngle(rig.goal.az, seatAzimuth(p));
      rig.goal.az = az; rig.goal.target.copy(seatTarget(az));
    }
    showAnchors();
    return;
  }
  anchors.count = 0;
  const gen = G.gen, t0 = performance.now();
  askAI(st.players[p].level).then((move) => {
    if (gen !== G.gen) return;
    setTimeout(() => {
      if (gen !== G.gen) return;
      if (move) playAction({ type: 'place', piece: move.piece, orient: move.orient, x: move.x, y: move.y }, false);
      else { Engine.applyAction(G.st, { type: 'resign' }); flushEvents(); nextTurn(); }
    }, Math.max(0, 600 - (performance.now() - t0)));
  });
}

function playAction(action, fromHand) {
  const st = G.st, p = st.current, pc = G.P[p][action.piece];
  const err = Engine.applyAction(st, action);
  if (err) return err;
  G.busy = true;
  anchors.count = 0;
  clearSuggest();
  const kf = Logic.poseForOrient(pc.def, action.orient, pc.k, pc.flip);
  pc.k = kf.k; pc.flip = kf.flip; pc.where = 'board'; pc.lift = 0;
  const gen = G.gen;
  animate(pc, boardPos(pc, action), quatFor(pc.k, pc.flip), fromHand ? 0.2 : 0.8, fromHand ? 0 : 4.5, () => {
    if (gen !== G.gen) return;
    sfx('place');
    setLast(pc);
    G.busy = false;
    flushEvents();
    nextTurn();
  });
  renderHud();
  return null;
}

function endGame() {
  if (G.ended) return;
  G.ended = true;
  anchors.count = 0;
  save();
  const rows = Engine.standings(G.st);
  const winners = rows.filter((r) => r.rank === 1);
  const mine = rows.filter((r) => isHuman(r.index));
  let title;
  if (mine.length === 1) title = mine[0].rank === 1 ? t('youWin') : t('youRank', { n: mine[0].rank });
  else title = winners.length > 1 ? t('tie', { n: winners.map((r) => nameOf(r.index)).join(' · ') }) : t('wins', { n: nameOf(winners[0].index) });
  $('end-title').textContent = title;
  $('end-rows').innerHTML = rows.map((r) =>
    '<li><b>' + r.rank + '</b><i style="background:' + COLORS[r.player.color] + '"></i><span>' + esc(nameOf(r.index)) + '</span>' +
    '<em>' + esc(t('pieces', { n: r.piecesLeft })) + ' · ' + esc(t('cells', { n: r.remainingSquares })) + '</em></li>').join('');
  rig.spin = 0.12;
  if (rig.top) setTopView(false);
  rig.goal.pol = 0.95; rig.goal.target.set(0, 0, 0);
  setTimeout(() => { if (G.ended) openDialog('end-dialog'); }, 900);
}

function undo() {
  if (G.busy) return;
  const target = Logic.undoTarget(G.st.actions, isHuman);
  if (target < 0) { toast(t('noUndo')); return; }
  G.gen++;
  if (G.held) dropHeld(false);
  G.st = Engine.replay(G.config, G.st.actions.slice(0, target));
  G.evCursor = G.st.events.length;
  G.ended = false; rig.spin = 0;
  closeDialog('end-dialog');
  clearSuggest(); hideGhost();
  syncPieces(true);
  G.busy = true;
  const gen = G.gen;
  setTimeout(() => { if (gen === G.gen) { G.busy = false; nextTurn(); } }, 560);
  renderHud();
}

/* ================= 拿起、旋转、翻面、落子 ================= */

function canAct() { return !G.busy && !G.st.over && isHuman(G.st.current); }

function pickUp(pc) {
  if (!canAct() || pc.player !== G.st.current || pc.where !== 'tray') return;
  if (G.held) dropHeld(false);
  G.anims = G.anims.filter((a) => a.pc !== pc);
  G.held = pc; pc.where = 'held'; pc.lift = 0;
  G.heldGoal = new THREE.Vector3(pc.home.x, HOVER_Y + 0.6, pc.home.z);
  G.heldCell = null; G.heldBoost = 0;
  if (G.hover === pc) G.hover = null;
  sfx('pick');
  // 提示正好是这一块时，保留棋盘上的提示位置
  if (G.suggestPc && G.suggestPc !== pc) clearSuggest();
  renderHold();
}

// 放回面前；silent 时不出声
function dropHeld(silent) {
  const pc = G.held;
  if (!pc) return;
  G.held = null; G.heldCell = null;
  pc.where = 'tray'; pc.k = pc.home.k; pc.flip = false;
  animate(pc, homePos(pc), quatFor(pc.k, false), 0.3, 1.2);
  hideGhost();
  if (!silent) sfx('pick');
  renderHold();
}

function rotateHeld(dir) {
  const pc = G.held;
  if (!pc) return;
  pc.k += dir;
  G.heldBoost = Math.max(G.heldBoost, 0.5);
  refreshHeld();
}

function flipHeld() {
  const pc = G.held;
  if (!pc) return;
  pc.flip = !pc.flip;
  G.heldBoost = 2.4;
  refreshHeld();
}

function hideGhost() { ghost.forEach((m) => { m.visible = false; }); }

// 按棋盘坐标里的一点（指针在棋盘平面上的位置）更新手里棋子的目标位置和落点投影
function aimHeld(lx, lz) {
  const pc = G.held;
  if (!pc) return;
  G.heldAim = { x: lx, z: lz };
  const N = G.st.topo.cols;
  const pose = Logic.pose(pc.def, pc.k, pc.flip);
  if (lx > -2 && lz > -2 && lx < N + 1 && lz < N + 1) {
    const w = Math.round(pose.maxX - pose.minX), h = Math.round(pose.maxZ - pose.minZ);
    const X = THREE.MathUtils.clamp(Math.round(lx + pose.minX), 0, N - 1 - w);
    const Y = THREE.MathUtils.clamp(Math.round(lz + pose.minZ), 0, N - 1 - h);
    G.heldGoal.set(X - pose.minX, HOVER_Y, Y - pose.minZ);
    G.heldCell = { x: X, y: Y, orient: pose.orient };
    const ok = Engine.checkPlacement(G.st, G.st.current, pc.piece, pose.orient, X, Y) === null;
    G.heldCell.ok = ok;
    ghostMat.color.set(ok ? '#35d07f' : '#ff5648');
    const cells = pc.def.orients[pose.orient].cells;
    ghost.forEach((m, i) => {
      m.visible = i < cells.length;
      if (m.visible) { m.position.x = X + cells[i][0]; m.position.z = Y + cells[i][1]; }
    });
  } else {
    G.heldGoal.set(lx, HOVER_Y + 0.6, lz);
    G.heldCell = null;
    hideGhost();
  }
  renderHold();
}

function refreshHeld() {
  if (G.held && G.heldAim) aimHeld(G.heldAim.x, G.heldAim.z);
  renderHold();
}

function tryPlace() {
  const pc = G.held, cell = G.heldCell;
  if (!pc || !cell || !canAct()) return;
  const action = { type: 'place', piece: pc.piece, orient: cell.orient, x: cell.x, y: cell.y };
  const reason = Engine.checkPlacement(G.st, G.st.current, action.piece, action.orient, action.x, action.y);
  if (reason) {
    sfx('bad');
    toast(t(TEXT.en['bad.' + reason] ? 'bad.' + reason : 'bad.other'), true);
    G.shake = 0.35;
    return;
  }
  G.held = null; G.heldCell = null;
  hideGhost();
  playAction(action, true);
  renderHold();
}

function showSuggestion() {
  if (!canAct()) return;
  const gen = G.gen;
  askAI('hard').then((m) => {
    if (gen !== G.gen || !m || !canAct()) return;
    clearSuggest();
    const pc = G.P[G.st.current][m.piece];
    const cells = pc.def.orients[m.orient].cells;
    suggest.forEach((q, i) => {
      q.visible = i < cells.length;
      if (q.visible) { q.position.x = m.x + cells[i][0]; q.position.z = m.y + cells[i][1]; }
    });
    suggestMat.color.set(COLORS[G.st.players[G.st.current].color]);
    if (pc.where === 'tray') { G.suggestPc = pc; pc.glow = 0.55; }
  });
}

/* ================= 指针操作 ================= */

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const pointers = new Map();
let press = null, pinch = 0, dragHeld = false;

function setRay(e, dy) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - (dy || 0)) - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}

function pieceAt(e) {
  if (!canAct()) return null;
  setRay(e);
  const mine = G.P[G.st.current].filter((pc) => pc.where === 'tray').map((pc) => pc.mesh);
  const hit = ray.intersectObjects(mine, false)[0];
  return hit ? hit.object.userData.pc : null;
}

function boardPoint(e, dy) {
  setRay(e, dy);
  const v = new THREE.Vector3();
  if (!ray.ray.intersectPlane(boardPlane, v)) return null;
  return off.worldToLocal(v);
}

function heldAt(e) {
  if (!G.held) return false;
  setRay(e);
  return ray.intersectObject(G.held.mesh, false).length > 0;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const p = Array.from(pointers.values());
    pinch = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    press = null; dragHeld = false;
    return;
  }
  press = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, button: e.button, moved: false, touch: e.pointerType !== 'mouse' };
  dragHeld = false;
  if (press.touch) {
    // 触屏：按住自己的棋子直接拖
    if (heldAt(e)) dragHeld = true;
    else {
      const pc = pieceAt(e);
      if (pc) { pickUp(pc); dragHeld = true; press.picked = true; }
    }
  }
  if (rig.spin) rig.spin = 0;
});

canvas.addEventListener('pointermove', (e) => {
  const rec = pointers.get(e.pointerId);
  if (rec) { rec.x = e.clientX; rec.y = e.clientY; }
  if (pointers.size === 2) {
    const p = Array.from(pointers.values());
    const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    if (pinch > 0 && d > 0) rig.goal.dist *= pinch / d;
    pinch = d;
    return;
  }
  if (press) {
    const dx = e.clientX - press.lx, dy = e.clientY - press.ly;
    press.lx = e.clientX; press.ly = e.clientY;
    if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
    if (dragHeld) {
      const pt = boardPoint(e, 56);
      if (pt) aimHeld(pt.x, pt.z);
    } else if (press.moved) {
      if (press.button === 2 || e.shiftKey) {
        // 平移视线落点
        const s = rig.dist * 0.0012;
        const cx = Math.cos(rig.az), sx = Math.sin(rig.az);
        rig.goal.target.x -= (dx * cx + dy * sx) * s;
        rig.goal.target.z -= (-dx * sx + dy * cx) * s;
        rig.goal.target.x = THREE.MathUtils.clamp(rig.goal.target.x, -24, 24);
        rig.goal.target.z = THREE.MathUtils.clamp(rig.goal.target.z, -24, 24);
      } else {
        rig.goal.az -= dx * 0.0055;
        rig.goal.pol -= dy * 0.0045;
        if (rig.top && rig.goal.pol > 0.2) { rig.top = false; $('view-btn').setAttribute('aria-pressed', 'false'); }
      }
    }
    return;
  }
  if (e.pointerType !== 'mouse') return;
  if (G.held) {
    const pt = boardPoint(e);
    if (pt) aimHeld(pt.x, pt.z);
    canvas.style.cursor = 'grabbing';
  } else {
    const pc = pieceAt(e);
    G.hover = pc;
    canvas.style.cursor = pc ? 'grab' : '';
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = 0;
  const p = press;
  press = null;
  const wasDrag = dragHeld;
  dragHeld = false;
  if (!p || e.type === 'pointercancel') return;
  if (p.moved) return;
  // 没有移动：一次点击
  if (p.button === 2) { rotateHeld(-1); return; }
  if (p.touch) {
    if (p.picked || !G.held) return;
    if (wasDrag) { tryPlace(); return; }           // 再点一下手里的棋子 = 落子
    const pc = pieceAt(e);
    if (pc) { pickUp(pc); return; }
    const pt = boardPoint(e);
    if (pt) aimHeld(pt.x, pt.z);
    return;
  }
  const pc = pieceAt(e);
  if (pc) { pickUp(pc); const pt = boardPoint(e); if (pt) aimHeld(pt.x, pt.z); return; }
  if (!G.held) return;
  const pt = boardPoint(e);
  if (pt) aimHeld(pt.x, pt.z);
  if (G.heldCell) tryPlace();
  else dropHeld(false);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (G.held && !e.ctrlKey) {
    // 拿着棋子时滚轮用来转棋子
    const now = performance.now();
    if (now - (G.lastWheel || 0) > 110) { rotateHeld(e.deltaY > 0 ? -1 : 1); G.lastWheel = now; }
    return;
  }
  rig.goal.dist *= Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0012));
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'r') rotateHeld(e.shiftKey ? 1 : -1);
  else if (k === 'e') rotateHeld(1);
  else if (k === 'f') flipHeld();
  else if (k === 'escape') dropHeld(false);
  else if (k === 'enter' || k === ' ') { if (G.held) { e.preventDefault(); tryPlace(); } }
  else if (k === 'v') setTopView(!rig.top);
  else if (k === 'h') showSuggestion();
  else if (k === '=' || k === '+') rig.goal.dist *= 0.88;
  else if (k === '-') rig.goal.dist *= 1.14;
});

/* ================= 界面 ================= */

const ICON = {
  rotate: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg>',
  flip: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M8 7 3 12l5 5z"/><path d="m16 7 5 5-5 5z" fill="currentColor"/></svg>',
  place: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>'
};

function renderHud() {
  const st = G.st, p = st.current;
  const turn = $('turn');
  turn.style.setProperty('--c', st.over ? '#888' : COLORS[st.players[p].color]);
  $('turn-text').textContent = st.over ? t('over')
    : isHuman(p) ? (humanCount() === 1 ? t('yourTurn') : t('turnOf', { n: nameOf(p) }))
      : t('thinking', { n: nameOf(p) });
  turn.classList.toggle('mine', !st.over && isHuman(p));
  $('players').innerHTML = st.players.map((pl, i) => {
    const left = pl.remaining.filter(Boolean).length;
    const sub = pl.done && left ? t('done') : t('left', { n: left });
    return '<li class="' + (i === p && !st.over ? 'on' : '') + (pl.done ? ' out' : '') + '" style="--c:' + COLORS[pl.color] + '"><i></i><span>' + esc(nameOf(i)) +
      (isHuman(i) ? '' : '<small>' + esc(t('l.' + pl.level)) + '</small>') + '</span><em>' + esc(sub) + '</em></li>';
  }).join('');
  $('undo-btn').disabled = Logic.undoTarget(st.actions, isHuman) < 0;
  $('suggest-btn').disabled = st.over || !isHuman(p);
  $('stop-btn').hidden = st.over || !isHuman(p) || st.players[p].placed === 0;
  renderHold();
}

function renderHold() {
  const holding = !!G.held;
  $('hold-bar').hidden = !holding;
  $('place-btn').disabled = !(G.heldCell && G.heldCell.ok);
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const tip = $('tip');
  if (G.st.over || !isHuman(G.st.current)) tip.textContent = '';
  else tip.textContent = t(holding ? (touch ? 'tipHoldTouch' : 'tipHold') : (touch ? 'tipPickTouch' : 'tipPick'));
}

let toastTimer = 0;
function toast(msg, warn) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (warn ? ' warn' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

function openDialog(id) { const d = $(id); if (!d.open) d.showModal(); }
function closeDialog(id) { const d = $(id); if (d.open) d.close(); }

function openSetup() {
  const mode = $('setup-mode');
  mode.value = G.config ? G.config.mode : 'classic';
  renderSetupSeats(true);
  openDialog('setup-dialog');
}

function renderSetupSeats(fromConfig) {
  const mode = $('setup-mode').value;
  const seats = Engine.MODES[mode].seats;
  $('setup-seats').innerHTML = seats.map((s, i) => {
    let cur = i === 0 ? 'human' : 'normal';
    if (fromConfig && G.config && G.config.mode === mode && G.config.players[i]) {
      cur = G.config.players[i].type === 'human' ? 'human' : G.config.players[i].level;
    }
    const opts = [['human', t('human')]].concat(LEVELS.map((l) => [l, 'AI · ' + t('l.' + l)]));
    return '<label><i style="background:' + COLORS[s.color] + '"></i><span>' + esc(t('c.' + s.color)) + '</span><select data-seat="' + i + '">' +
      opts.map((o) => '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select></label>';
  }).join('');
}

function applyStaticText() {
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll('[data-title]').forEach((el) => { el.title = t(el.dataset.title); el.setAttribute('aria-label', t(el.dataset.title)); });
  $('rot-btn').innerHTML = ICON.rotate + '<span>' + esc(t('rotate')) + '</span>';
  $('flip-btn').innerHTML = ICON.flip + '<span>' + esc(t('flip')) + '</span>';
  $('place-btn').innerHTML = ICON.place + '<span>' + esc(t('place')) + '</span>';
  $('back-btn').innerHTML = ICON.back + '<span>' + esc(t('putBack')) + '</span>';
  document.documentElement.lang = LANG;
}

function bindUi() {
  $('rot-btn').addEventListener('click', () => rotateHeld(-1));
  $('flip-btn').addEventListener('click', flipHeld);
  $('place-btn').addEventListener('click', tryPlace);
  $('back-btn').addEventListener('click', () => dropHeld(false));
  $('env-btn').addEventListener('click', () => {
    const i = ENVIRONMENTS.findIndex((e) => e.id === settings.env);
    setEnvironment(ENVIRONMENTS[(i + 1) % ENVIRONMENTS.length].id, false);
  });
  $('view-btn').addEventListener('click', () => setTopView(!rig.top));
  $('hints-btn').addEventListener('click', () => { settings.hints = !settings.hints; syncToggles(); showAnchors(); save(); });
  $('sound-btn').addEventListener('click', () => { settings.sound = !settings.sound; syncToggles(); save(); if (settings.sound) sfx('pick'); });
  $('undo-btn').addEventListener('click', undo);
  $('suggest-btn').addEventListener('click', showSuggestion);
  $('new-btn').addEventListener('click', openSetup);
  $('stop-btn').addEventListener('click', () => {
    if (!canAct()) return;
    if (G.held) dropHeld(true);
    Engine.applyAction(G.st, { type: 'resign' });
    anchors.count = 0; clearSuggest();
    flushEvents(); nextTurn();
  });
  $('setup-mode').addEventListener('change', () => renderSetupSeats(false));
  $('setup-cancel').addEventListener('click', () => closeDialog('setup-dialog'));
  $('setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const seats = Array.from(document.querySelectorAll('#setup-seats select')).map((s) => s.value);
    closeDialog('setup-dialog');
    startGame(defaultConfig($('setup-mode').value, seats), []);
  });
  $('end-again').addEventListener('click', () => {
    const seats = G.config.players.map((p) => (p.type === 'human' ? 'human' : p.level));
    startGame(defaultConfig(G.config.mode, seats), []);
  });
  $('end-view').addEventListener('click', () => closeDialog('end-dialog'));
  window.addEventListener('resize', resize);
}

function syncToggles() {
  $('hints-btn').setAttribute('aria-pressed', settings.hints ? 'true' : 'false');
  $('sound-btn').setAttribute('aria-pressed', settings.sound ? 'true' : 'false');
}

/* ================= 环境切换 ================= */

let env = null, envRT = null;

function applyEnvironment(id) {
  const cfg = environmentById(id);
  if (env) { scene.remove(env.group); env.dispose(); }
  settings.env = cfg.id;
  env = buildEnvironment(cfg);
  scene.add(env.group);
  scene.background = new THREE.Color(cfg.background);
  scene.fog = new THREE.FogExp2(cfg.fog.color, cfg.fog.density);
  renderer.toneMappingExposure = cfg.exposure;
  if (G.st) buildBoard(cfg.board);
  // 用房间本身生成反射贴图，棋子的高光就来自这个房间
  play.visible = false;
  const rt = pmrem.fromScene(scene, 0.03, 1, 700);
  play.visible = true;
  if (envRT) envRT.dispose();
  envRT = rt;
  scene.environment = rt.texture;
  scene.environmentIntensity = cfg.envIntensity == null ? 0.6 : cfg.envIntensity;
  $('env-name').textContent = cfg.name[LANG] || cfg.name.en;
  document.documentElement.dataset.env = cfg.id;
  if (quality) applyQuality();
}

// 对局中切换环境：只换房间、桌子和灯光，棋局原样保留
function setEnvironment(id, instant) {
  if (instant) { applyEnvironment(id); return; }
  const fade = $('fade');
  fade.classList.add('on');
  setTimeout(() => {
    applyEnvironment(id);
    save();
    requestAnimationFrame(() => fade.classList.remove('on'));
  }, 420);
}

/* ================= 主循环 ================= */

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // 竖屏时把视野放宽，保证棋盘和面前的棋子都在画面里
  camera.fov = w / h < 1 ? THREE.MathUtils.clamp(38 / (w / h) * 0.82, 38, 70) : 38;
  camera.updateProjectionMatrix();
}

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
let lastT = performance.now(), clock = 0;
const perf = { n: 0, sum: 0 };

function frame(now) {
  const raw = (now - lastT) / 1000;
  const dt = Math.min(0.25, raw);
  lastT = now; clock += dt;
  // 连续一段时间帧率太低就降一档画质
  if (!document.hidden && raw < 1.5) {
    perf.n++; perf.sum += raw;
    if (perf.n >= 45) {
      if (perf.sum / perf.n > 1 / 28 && quality < 2 && !qParam) { quality++; applyQuality(); }
      perf.n = 0; perf.sum = 0;
    }
  }
  updateCamera(dt);

  // 棋子的移动动画
  for (let i = G.anims.length - 1; i >= 0; i--) {
    const a = G.anims[i];
    a.t = Math.min(1, a.t + dt / a.dur);
    const e = ease(a.t);
    a.pc.mesh.position.lerpVectors(a.p0, a.p1, e);
    a.pc.mesh.position.y += Math.sin(Math.PI * e) * a.arc;
    a.pc.mesh.quaternion.slerpQuaternions(a.q0, a.q1, e);
    if (a.t >= 1) { G.anims.splice(i, 1); if (a.done) a.done(); }
  }

  // 手里的棋子跟着目标走
  if (G.held) {
    const pc = G.held, m = pc.mesh;
    G.heldBoost *= Math.exp(-dt * 5);
    G.shake = Math.max(0, (G.shake || 0) - dt);
    const goal = G.heldGoal;
    const k = 1 - Math.exp(-dt * 20);
    m.position.x += (goal.x + Math.sin(clock * 60) * G.shake * 0.5 - m.position.x) * k;
    m.position.z += (goal.z - m.position.z) * k;
    m.position.y += (goal.y + G.heldBoost + Math.sin(clock * 2.2) * 0.05 - m.position.y) * k;
    m.quaternion.slerp(quatFor(pc.k, pc.flip), 1 - Math.exp(-dt * 16));
  }

  // 面前的棋子：悬停时微微抬起；发光渐变
  if (G.P.length) {
    G.P.forEach((list) => list.forEach((pc) => {
      const hover = pc === G.hover && pc.where === 'tray';
      const want = (hover ? 0.3 : 0) + (pc === G.suggestPc ? 0.22 + Math.sin(clock * 5) * 0.08 : 0);
      if (pc.where === 'tray' && Math.abs(pc.lift - want) > 0.001) {
        pc.lift += (want - pc.lift) * (1 - Math.exp(-dt * 14));
        if (!G.anims.some((a) => a.pc === pc)) pc.mesh.position.y = TRAY_Y + pc.lift;
      }
      const glow = 0.05 + (hover ? 0.2 : 0) + pc.glow + (pc === G.held ? 0.12 : 0);
      pc.mat.emissiveIntensity += (glow - pc.mat.emissiveIntensity) * (1 - Math.exp(-dt * 8));
    }));
  }
  if (G.last && G.last.glow > 0.14) G.last.glow = Math.max(0.14, G.last.glow - dt * 0.12);

  anchorMat.opacity = 0.6 + 0.3 * Math.sin(clock * 3.2);
  suggestMat.opacity = 0.45 + 0.3 * Math.sin(clock * 5);
  ghostMat.opacity = 0.5 + 0.12 * Math.sin(clock * 6);

  if (env) env.update(dt, clock, camera);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/* ================= 启动 ================= */

applyStaticText();
bindUi();
syncToggles();
resize();
applyEnvironment(settings.env);

let resumed = false;
if (saved.config && Array.isArray(saved.actions)) {
  try {
    const st = Engine.replay(saved.config, saved.actions);
    if (!st.over && st.actions.length === saved.actions.length) {
      startGame(saved.config, saved.actions);
      resumed = st.actions.length > 0;
    }
  } catch (e) { /* 存档坏了就开新局 */ }
}
if (!G.st) startGame(defaultConfig('classic'), []);
if (resumed) toast(t('resumed'));
rig.az = rig.goal.az; rig.pol = rig.goal.pol + 0.25; rig.dist = rig.goal.dist + 26; rig.target.copy(rig.goal.target);
requestAnimationFrame((now) => { lastT = now; frame(now); });
$('fade').classList.remove('on');

// 调试和自动测试用
window.__table = { G: G, rig: rig, settings: settings, setEnvironment: setEnvironment, pickUp: pickUp, aimHeld: aimHeld, tryPlace: tryPlace, rotateHeld: rotateHeld, flipHeld: flipHeld, undo: undo, camera: camera, off: off };
