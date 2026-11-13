/*
 * BlockTurf 三维牌桌视图：把对局画成真实的桌面——棋盘和棋子是有厚度、材质和影子的实体，
 * 玩家从自己面前拿起棋子、在手里转动或翻面、放到棋盘上；镜头自然地环绕和缩放。
 *
 * 这里只负责画面和操作。规则、轮次、电脑、联机、存档全部由 js/app.js 处理；
 * app 通过 api 把对局状态和动作接口交给视图（见 createTableView 的说明）。
 * 环境（房间、灯光、桌子）由 environments.js 的配置描述、props.js 搭建，与对局互不相干，随时可换。
 *
 * 支持全部棋盘：方格（标准 / 双人）、三角块、宝石阵、立方体、三棱柱。
 */
import * as THREE from '../vendor/three.module.min.js';
import { ENVIRONMENTS, environmentById } from './environments.js';
import { buildEnvironment, TABLE_Y } from './props.js';

const Geom = window.BlokusTableGeom;
const Engine = window.BlokusEngine;

const COLORS = { blue: '#2a63d6', yellow: '#eeb200', red: '#e03a2e', green: '#1f9a47', violet: '#7b4fd8', orange: '#ef7612' };
const HOVER = 1.15;          // 拿在手里时离棋盘多高（棋盘单位）
const BOARD_SPAN = 22;       // 棋盘在桌面上大约多宽（世界单位）
const TRAY_SCALE_3D = 0.6;   // 立体棋子在托盘里缩小摆放
const AR_BOARD_M = 0.28;     // AR 里棋盘默认多宽（米），双指可缩放

// 画质档位：先降阴影，最后才降分辨率；高清屏上分辨率不低于 1.5 倍
const QUALITY = [
  { dpr: 2, shadows: true, shadowMap: 2048 },
  { dpr: 2, shadows: true, shadowMap: 1024 },
  { dpr: 1.5, shadows: false, shadowMap: 512 },
  { dpr: 1, shadows: false, shadowMap: 512 }
];

function ease(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
function nearestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return from + d;
}
function shrinkPoly(poly, f) {
  const c = Geom.centroid(poly);
  return poly.map((p) => [c[0] + (p[0] - c[0]) * f, c[1] + (p[1] - c[1]) * f]);
}

/* ================= 几何体 ================= */

// 一个格子的实体：多边形向内收一点，挤出厚度 h，带圆角斜边；底面在 y0
function cellGeometry(poly, y0, h, inset, bevel) {
  const sh = new THREE.Shape();
  const pts = shrinkPoly(poly, inset);
  // Shape 在 xy 平面；挤出沿 +z，之后转到 xz 平面（-z → 世界 y）
  sh.moveTo(pts[0][0], -pts[0][1]);
  for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], -pts[i][1]);
  sh.closePath();
  const b = Math.min(bevel, h * 0.3);
  const g = new THREE.ExtrudeGeometry(sh, { depth: Math.max(0.01, h - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b * 0.9, bevelSegments: 2, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0 + b, 0);
  return g.index ? g.toNonIndexed() : g;
}

function mergeGeometries(parts) {
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

// 棋子模型：以各格中心的平均点为原点
// 多边形的外轮廓：把各格的边收集起来，去掉两格共用的边，剩下的连成一圈；共用的边另外返回（画成格子之间的细线）
function unionOutline(polys) {
  const key = (p) => Math.round(p[0] * 1000) + ',' + Math.round(p[1] * 1000);
  const edges = new Map();
  polys.forEach((poly) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ka = key(a), kb = key(b);
      const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      const e = edges.get(k);
      if (e) e.n++;
      else edges.set(k, { a: a, b: b, ka: ka, kb: kb, n: 1 });
    }
  });
  const outer = [], inner = [];
  edges.forEach((e) => { (e.n === 1 ? outer : inner).push(e); });
  // 按方向连成一圈（各格多边形的绕向一致，外边的方向也一致）
  const from = new Map();
  outer.forEach((e) => { from.set(e.ka, e); });
  const loop = [];
  let e = outer[0];
  for (let guard = 0; e && guard <= outer.length; guard++) {
    loop.push(e.a);
    e = from.get(e.kb);
    if (e === outer[0]) break;
  }
  return { loop: loop.length === outer.length ? loop : null, inner: inner };
}

// 简单多边形向内收 d（斜接）
function offsetPoly(pts, d) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const sign = area > 0 ? 1 : -1;
  const n = pts.length;
  const normal = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [-dz / l * sign, dx / l * sign]; };
  return pts.map((p, i) => {
    const n1 = normal(pts[(i - 1 + n) % n], p), n2 = normal(p, pts[(i + 1) % n]);
    const mx = n1[0] + n2[0], mz = n1[1] + n2[1];
    const k = d / Math.max(0.35, (1 + n1[0] * n2[0] + n1[1] * n2[1]));
    return [p[0] + mx * k, p[1] + mz * k];
  });
}

/**
 * 棋子模型（以各格中心的平均点为原点）。返回 { geo, lines }：
 *   方格：一格一格的圆角小块（像实体积木那样带缝）
 *   三角、六边形：整块外轮廓挤出、外边倒圆角，块内的格子用顶面上的细线分开
 *   立方体、三棱柱：各格紧贴成一个实体，格子之间用细线分开
 */
function pieceGeometry(set, pieceIndex, orient, board) {
  const shape = Geom.orientShape(set, pieceIndex, orient);
  if (board.dims === 3) {
    const parts = shape.map((k) => cellGeometry(k.poly, k.y, board.layerH, 1, 0));
    const geo = mergeGeometries(parts);
    const lines = new THREE.EdgesGeometry(geo, 25);
    return { geo: geo, lines: lines };
  }
  if (board.kind === 'square') {
    const parts = shape.map((k) => cellGeometry(k.poly, -board.pieceH / 2, board.pieceH, 0.9, 0.06));
    return { geo: mergeGeometries(parts), lines: null };
  }
  const u = unionOutline(shape.map((k) => k.poly));
  if (!u.loop) {
    const parts = shape.map((k) => cellGeometry(k.poly, -board.pieceH / 2, board.pieceH, 0.92, 0.04));
    return { geo: mergeGeometries(parts), lines: null };
  }
  const bevel = 0.045;
  const geo = cellGeometry(offsetPoly(u.loop, 0.035 + bevel * 0.9), -board.pieceH / 2, board.pieceH, 1, bevel);
  const pos = [];
  const y = board.pieceH / 2 + 0.002;
  u.inner.forEach((e) => { pos.push(e.a[0], y, e.a[1], e.b[0], y, e.b[1]); });
  let lines = null;
  if (pos.length) {
    lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  }
  return { geo: geo, lines: lines };
}

function polyGeometry(poly, y, inset) {
  const pts = inset ? shrinkPoly(poly, inset) : poly;
  const pos = [];
  for (let i = 1; i < pts.length - 1; i++) {
    pos.push(pts[0][0], y, pts[0][1], pts[i + 1][0], y, pts[i + 1][1], pts[i][0], y, pts[i][1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * 创建三维牌桌视图。
 * host：放画布的元素。api（由 app 提供）：
 *   state()            当前局面
 *   canAct()           现在能不能由本机操作
 *   viewSeat()         镜头坐在哪位玩家的座位（下标）
 *   selection()        { piece, orient } 或 null：手里拿着的棋子
 *   move()             手里棋子对准的落点 { piece, orient, x, y, z }，没有时 null
 *   anchors()          要标出的角点（格子编号）或 null
 *   hint()             提示的一步或 null
 *   remote()           联机时别人正在尝试的一步或 null
 *   select(pi)         拿起 / 放下第 pi 块（与平面版的托盘相同）
 *   setOrient(o)       把手里棋子换成朝向 o
 *   setGhost(cell)     对准的格子：平面 { x, y }，立体 { x, z }
 *   place()            在对准的位置落子（返回是否成功）
 *   drop()             把手里的棋子放回去
 *   prefs()            { env, hints }
 *   onEnvChange(id)    换了环境（让 app 记住）
 */
export function createTableView(host, api) {
  const canvas = document.createElement('canvas');
  canvas.className = 'table-canvas';
  host.appendChild(canvas);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    host.removeChild(canvas);
    return null;
  }
  const qParam = new URLSearchParams(location.search).get('q');
  let quality = qParam === 'low' ? 3 : qParam === 'mid' ? 2 : 0;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[quality].dpr));
  renderer.shadowMap.enabled = QUALITY[quality].shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 900);
  const pmrem = new THREE.PMREMGenerator(renderer);

  // 对局空间：局部坐标就是牌桌局部坐标（棋盘中心在原点、一格约 1）；整体按棋盘大小缩放
  const play = new THREE.Group();
  scene.add(play);
  const boardGroup = new THREE.Group();
  const pieceGroup = new THREE.Group();
  const markGroup = new THREE.Group();
  play.add(boardGroup, pieceGroup, markGroup);

  const V = {
    board: null, key: '', angles: [], P: [], held: null, heldOrient: -1, heldPos: new THREE.Vector3(),
    turnAnim: null, last: null, anims: [], narrow: false, visible: false, actionsSeen: 0, remoteMesh: null,
    scale: 1
  };

  /* ================= 画质 ================= */

  function applyQuality() {
    const q = QUALITY[quality];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
    renderer.shadowMap.enabled = q.shadows;
    scene.traverse((o) => {
      if (o.isLight && o.shadow) {
        o.castShadow = q.shadows && !!o.userData.key;
        o.shadow.mapSize.set(q.shadowMap, q.shadowMap);
        if (o.shadow.map) { o.shadow.map.dispose(); o.shadow.map = null; }
      }
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
    });
    resize();
  }

  /* ================= 镜头 ================= */

  const rig = {
    az: 0, pol: 0.86, dist: 64, target: new THREE.Vector3(0, 0, 4),
    goal: { az: 0, pol: 0.86, dist: 64, target: new THREE.Vector3(0, 0, 4) },
    top: false, lock: null, holdLock: null, zoom: 1, spin: 0
  };
  const fitCam = new THREE.PerspectiveCamera();
  const fitV = new THREE.Vector3();

  // 世界方位角：play 不转动，座位方位角就是镜头方位角
  function seatAz(p) { return V.angles[p] || 0; }

  // 取景：让 pts（世界坐标）都落在画面里、不被顶栏和底部的按钮挡住
  function frame(az, pol, pts) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    pts.forEach((v) => { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z); });
    const target = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    const portrait = camera.aspect < 1;
    const top = portrait ? 0.66 : 0.76, bottom = portrait ? -0.7 : -0.76, side = portrait ? 0.96 : 0.88;
    fitCam.fov = camera.fov; fitCam.aspect = camera.aspect; fitCam.near = 1; fitCam.far = 900; fitCam.updateProjectionMatrix();
    let dist = 60;
    for (let i = 0; i < 10; i++) {
      const sp = Math.sin(pol);
      fitCam.position.set(target.x + dist * sp * Math.sin(az), target.y + dist * Math.cos(pol), target.z + dist * sp * Math.cos(az));
      fitCam.lookAt(target);
      fitCam.updateMatrixWorld();
      let m = 0;
      pts.forEach((v) => {
        fitV.copy(v).project(fitCam);
        m = Math.max(m, Math.abs(fitV.x) / side, fitV.y > 0 ? fitV.y / top : -fitV.y / -bottom);
      });
      dist *= Math.pow(m, 0.9);
    }
    return { az: az, pol: pol, dist: THREE.MathUtils.clamp(dist, 12, 140), target: target };
  }

  function boardPoints() {
    const pts = [];
    const H = V.board.dims === 3 ? V.board.layerH * Math.min(2, V.board.height) : 0;
    V.board.outline.forEach((q) => {
      pts.push(new THREE.Vector3(q[0], 0, q[1]).multiplyScalar(V.scale));
      if (H) pts.push(new THREE.Vector3(q[0], H, q[1]).multiplyScalar(V.scale));
    });
    return pts;
  }

  // 座位视角：棋盘和自己面前的棋子都在画面里；拿着棋子时：棋盘正上方
  function seatView(p, hold) {
    const az = seatAz(p);
    const portrait = camera.aspect < 1;
    const cube = V.board.dims === 3;
    if (hold) return frame(az, cube ? 0.42 : 0.06, boardPoints());
    const pol = rig.top ? 0.1 : cube ? (portrait ? 0.82 : 0.9) : portrait ? 0.62 : 0.72;
    const pts = boardPoints();
    (V.P[p] || []).forEach((pc) => {
      if (pc.where !== 'tray') return;
      const s = pc.slot;
      pts.push(new THREE.Vector3(s.x, 0, s.z).multiplyScalar(V.scale));
    });
    return frame(az, pol, pts);
  }

  // 立体棋盘和三角棋盘：镜头自由环顾，不锁定（只在开局、换座位或画面变化时取一次景）
  function freeCam() { return !!V.board && (V.board.dims === 3 || V.board.kind === 'tri'); }

  function lockCamera(force) {
    const st = api.state();
    if (!st || !V.board) return;
    const p = api.viewSeat();
    if (p == null || p < 0) { rig.lock = null; rig.holdLock = null; return; }
    if (freeCam()) {
      rig.lock = null; rig.holdLock = null;
      if (!force && V.framedSeat === p) return;
      V.framedSeat = p;
      const v = seatView(p, false);
      rig.goal.az = nearestAngle(rig.goal.az, v.az);
      rig.goal.pol = v.pol; rig.goal.dist = v.dist; rig.goal.target.copy(v.target);
      rig.spin = 0;
      return;
    }
    rig.lock = seatView(p, false);
    rig.holdLock = api.canAct() ? seatView(p, true) : null;
    rig.lock.az = nearestAngle(rig.goal.az, rig.lock.az);
    if (rig.holdLock) rig.holdLock.az = rig.lock.az;
    rig.spin = 0;
  }

  function zoomBy(f) {
    if (rig.lock) rig.zoom = THREE.MathUtils.clamp(rig.zoom * f, 0.5, 1.4);
    else rig.goal.dist *= f;
  }

  function updateCamera(dt) {
    const g = rig.goal;
    const orbiting = (press && !press.dragHeld) || pointers.size > 1;
    if (rig.lock && !orbiting) {
      const L = V.held && rig.holdLock ? rig.holdLock : rig.lock;
      L.az = nearestAngle(g.az, L.az);
      g.az = L.az; g.pol = L.pol; g.dist = L.dist * rig.zoom; g.target.copy(L.target);
    }
    if (rig.spin) g.az += rig.spin * dt;
    g.pol = THREE.MathUtils.clamp(g.pol, 0.03, 1.36);
    g.dist = THREE.MathUtils.clamp(g.dist, 10, 150);
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

  /* ================= 棋盘 ================= */

  const quadMats = {};
  function flatMat(color, opacity) {
    const k = color + ':' + opacity;
    return quadMats[k] || (quadMats[k] = new THREE.MeshBasicMaterial({ color: color, transparent: opacity < 1, opacity: opacity, depthWrite: false, side: THREE.DoubleSide }));
  }

  function disposeGroup(g) {
    while (g.children.length) {
      const o = g.children.pop();
      o.traverse((m) => {
        if (m.geometry && !m.userData.sharedGeo) m.geometry.dispose();
        if (m.material && !m.userData.sharedMat) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      });
    }
  }

  function buildBoard(style) {
    disposeGroup(boardGroup);
    const B = V.board;
    const frameMat = new THREE.MeshStandardMaterial({ color: style.frame, roughness: style.frameRoughness || 0.5 });
    const baseMat = new THREE.MeshStandardMaterial({ color: style.ridge, roughness: 0.6, side: THREE.DoubleSide });
    const cellMat = new THREE.MeshStandardMaterial({ color: style.base, roughness: 0.55, side: THREE.DoubleSide });
    // 外框：轮廓向外扩一圈的厚板，桌面以上 0.7
    const out = B.outline;
    const c0 = Geom.centroid(out);
    const grow = (poly, d) => poly.map((p) => {
      const dx = p[0] - c0[0], dz = p[1] - c0[1], l = Math.hypot(dx, dz) || 1;
      return [p[0] + dx / l * d, p[1] + dz / l * d];
    });
    const frameTop = 0.08;
    const frameH = frameTop - TABLE_Y / V.scale;
    const frameGeo = cellGeometry(grow(out, 1.1), TABLE_Y / V.scale, frameH, 1, 0.12);
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.castShadow = true; frame.receiveShadow = true;
    boardGroup.add(frame);
    // 底板（格子之间的缝的颜色）
    const base = new THREE.Mesh(polyGeometry(grow(out, 0.2), frameTop + 0.005), baseMat);
    base.receiveShadow = true;
    boardGroup.add(base);
    // 格子
    const cellPolys = B.dims === 3 ? B.columns.map((c) => c.poly) : B.cells.map((i) => B.cellPoly(i));
    const parts = cellPolys.map((poly) => polyGeometry(poly, frameTop + 0.03, B.kind === 'tri' || B.kind === 'prism' ? 0.86 : 0.9));
    let n = 0;
    parts.forEach((p) => { n += p.attributes.position.count; });
    const pos = new Float32Array(n * 3);
    let at = 0;
    parts.forEach((p) => { pos.set(p.attributes.position.array, at * 3); at += p.attributes.position.count; p.dispose(); });
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    cg.computeVertexNormals();
    const cells = new THREE.Mesh(cg, cellMat);
    cells.receiveShadow = true;
    boardGroup.add(cells);
    // 起点标记
    const st = api.state();
    st.players.forEach((pl) => {
      pl.startIdx.forEach((idx) => {
        const c = B.cellCenter(idx);
        const r = B.kind === 'tri' || B.kind === 'prism' ? 0.16 : 0.24;
        const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.62, r, 28), new THREE.MeshBasicMaterial({ color: COLORS[pl.color] }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(c[0], frameTop + 0.04, c[2]);
        boardGroup.add(ring);
      });
    });
    V.surface = frameTop + 0.04;
  }

  /* ================= 棋子 ================= */

  const geoCache = new Map();
  function geoFor(pieceIndex, orient) {
    const k = pieceIndex + ':' + orient;
    if (!geoCache.has(k)) geoCache.set(k, pieceGeometry(api.state().set, pieceIndex, orient, V.board));
    return geoCache.get(k);
  }

  // 棋子的格子分隔线：棋子颜色调暗
  function lineMat(color) {
    const c = new THREE.Color(color).multiplyScalar(0.45);
    return new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.75 });
  }

  function applyGeo(pc, orient) {
    const g = geoFor(pc.piece, orient);
    pc.mesh.geometry = g.geo;
    if (g.lines) {
      if (!pc.lines) {
        pc.lines = new THREE.LineSegments(g.lines, pc.lineMat);
        pc.lines.userData.sharedGeo = true;
        pc.lines.raycast = () => {};
        pc.mesh.add(pc.lines);
      } else pc.lines.geometry = g.lines;
      pc.lines.visible = true;
    } else if (pc.lines) pc.lines.visible = false;
  }

  function buildPieces() {
    disposeGroup(pieceGroup);
    geoCache.forEach((g) => { g.geo.dispose(); if (g.lines) g.lines.dispose(); });
    geoCache.clear();
    const st = api.state(), set = st.set;
    V.P = st.players.map((pl, p) => {
      const col = new THREE.Color(COLORS[pl.color] || '#888888');
      return set.pieces.map((piece, i) => {
        const mat = new THREE.MeshPhysicalMaterial({
          color: col, roughness: 0.45, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.45,
          specularIntensity: 0.55, envMapIntensity: 0.35, emissive: col, emissiveIntensity: 0.05
        });
        const mesh = new THREE.Mesh(geoFor(i, piece.display).geo, mat);
        mesh.userData.sharedGeo = true;
        mesh.castShadow = true; mesh.receiveShadow = true;
        const pc = { mesh: mesh, mat: mat, player: p, piece: i, orient: piece.display, where: 'tray', slot: null, glow: 0, lift: 0, action: null, lineMat: lineMat(COLORS[pl.color] || '#888888') };
        applyGeo(pc, piece.display);
        mesh.userData.pc = pc;
        pieceGroup.add(mesh);
        return pc;
      });
    });
    layoutTrays(false);
  }

  function layoutTrays(animated) {
    const st = api.state();
    st.players.forEach((pl, p) => {
      if (!V.P[p]) return;   // 棋子还没建好（新的一局正在搭建）
      const lay = Geom.trayLayout(st, V.board, V.angles, p, V.narrow && p === api.viewSeat(), traySc());
      V.P[p].forEach((pc, i) => {
        pc.slot = lay.slots[i];
        if (pc.where === 'tray' && animated) {
          setGeo(pc, st.set.pieces[i].display);
          moveTo(pc, trayPos(pc), trayQuat(pc), 0.45, 1);
        }
      });
    });
  }

  function traySc() { return V.board && V.board.dims === 3 ? TRAY_SCALE_3D : 1; }

  function trayPos(pc) {
    const B = V.board;
    const y = B.dims === 3 ? -Geom.orientShape(api.state().set, pc.piece, pc.orient).center[1] * 0 : 0;
    return new THREE.Vector3(pc.slot.x, TABLE_Y / V.scale + (B.dims === 3 ? -minY(pc) * traySc() : B.pieceH / 2) + 0.02 + y, pc.slot.z);
  }
  function trayQuat(pc) { return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pc.slot.rot); }
  function minY(pc) {
    const shape = Geom.orientShape(api.state().set, pc.piece, pc.orient);
    let m = Infinity;
    shape.forEach((k) => { m = Math.min(m, k.y); });
    return m;
  }

  function setGeo(pc, orient) {
    if (pc.orient === orient) return;
    pc.orient = orient;
    applyGeo(pc, orient);
  }

  // 落子后棋子在棋盘上的位置（各格中心的平均点）
  function boardPosOf(action) {
    const st = api.state();
    const cells = Engine.placementCells(st, action.piece, action.orient, action.x, action.y, action.z);
    const shape = Geom.orientShape(st.set, action.piece, action.orient);
    for (let k = 0; k < cells.length; k++) {
      if (!Engine.inBounds(st.topo, cells[k])) continue;
      const i = Engine.cellIndex(st.topo, cells[k]);
      const c = V.board.cellCenter(i);
      const y = V.board.dims === 3 ? c[1] : V.surface + V.board.pieceH / 2 - 0.02;
      return new THREE.Vector3(c[0] - shape[k].c[0], y - (V.board.dims === 3 ? shape[k].c[1] : 0) + (V.board.dims === 3 ? V.surface : 0), c[2] - shape[k].c[2]);
    }
    return null;
  }

  function moveTo(pc, pos, quat, dur, arc, done, swapAt, scale) {
    V.anims = V.anims.filter((a) => a.pc !== pc);
    const s1 = scale != null ? scale : (pc.where === 'tray' ? traySc() : 1);
    V.anims.push({ pc: pc, t: 0, dur: dur, p0: pc.mesh.position.clone(), p1: pos, q0: pc.mesh.quaternion.clone(), q1: quat, arc: arc, done: done, swap: swapAt, s0: pc.mesh.scale.x, s1: s1 });
  }

  // 让棋子回到当前局面该在的位置
  function syncPieces(animateNew) {
    const st = api.state();
    const placed = {};
    st.actions.forEach((a) => { if (a.type === 'place') placed[a.player + ':' + a.piece] = a; });
    const sel = api.canAct() ? api.selection() : null;
    const newest = animateNew && st.actions.length > V.actionsSeen ? st.actions.slice(V.actionsSeen) : [];
    V.P.forEach((list) => list.forEach((pc) => {
      const a = placed[pc.player + ':' + pc.piece];
      const isHeld = sel && pc.player === st.current && pc.piece === sel.piece && !a;
      if (a) {
        const same = pc.where === 'board' && pc.action && pc.action.x === a.x && pc.action.y === a.y && pc.action.z === a.z && pc.action.orient === a.orient;
        if (same) return;
        const fresh = newest.indexOf(a) >= 0;
        pc.where = 'board'; pc.action = a;
        const pos = boardPosOf(a);
        const q = new THREE.Quaternion();
        if (fresh) {
          const fromHand = pc === V.held;
          if (fromHand) { setGeo(pc, a.orient); pc.mesh.quaternion.identity(); }
          moveTo(pc, pos, q, fromHand ? 0.22 : 0.75, fromHand ? 0 : 3.2, () => { if (api.sound) api.sound(); },
            fromHand ? null : () => setGeo(pc, a.orient));
        } else {
          V.anims = V.anims.filter((x) => x.pc !== pc);
          setGeo(pc, a.orient);
          pc.mesh.position.copy(pos); pc.mesh.quaternion.copy(q); pc.mesh.scale.setScalar(1);
        }
      } else if (isHeld) {
        pc.where = 'held';
      } else if (pc.remote) {
        // 别人手里正拿着
      } else if (pc.where !== 'tray') {
        pc.where = 'tray'; pc.action = null;
        const back = () => setGeo(pc, api.state().set.pieces[pc.piece].display);
        moveTo(pc, trayPos(withOrient(pc)), trayQuat(pc), 0.45, 1.6, null, back);
      } else if (!V.anims.some((x) => x.pc === pc)) {
        pc.mesh.position.copy(trayPos(pc)); pc.mesh.quaternion.copy(trayQuat(pc)); pc.mesh.scale.setScalar(traySc());
      }
    }));
    // 手里的棋子
    const held = sel ? V.P[st.current][sel.piece] : null;
    if (held !== V.held) {
      if (V.held && V.held.where === 'held') V.held.where = 'tray';
      V.held = held;
      if (held) {
        V.anims = V.anims.filter((x) => x.pc !== held);
        held.where = 'held';
        V.heldOrient = -1;
      }
    }
    // 最后一步发光
    const lm = st.lastMove;
    const last = lm ? V.P[lm.player][lm.piece] : null;
    if (V.last !== last) { if (V.last) V.last.glow = 0; V.last = last; if (last) last.glow = 0.32; }
    V.actionsSeen = st.actions.length;
  }

  // 放回托盘时用托盘里的朝向计算高度
  function withOrient(pc) { return { slot: pc.slot, piece: pc.piece, orient: api.state().set.pieces[pc.piece].display }; }

  /* ================= 标记：落点、角点、提示、别人的预览 ================= */

  const ghostGroup = new THREE.Group();
  const hintGroup = new THREE.Group();
  const anchorGroup = new THREE.Group();
  markGroup.add(ghostGroup, hintGroup, anchorGroup);
  let ghostKey = '', hintKey = '', anchorKey = '';

  function footprint(m) {
    // 平面：落点的格子；立体：每一列最低的那格（落下后贴着的那一面）
    const st = api.state();
    const cells = Engine.placementCells(st, m.piece, m.orient, m.x, m.y, m.z).filter((c) => Engine.inBounds(st.topo, c));
    if (V.board.dims !== 3) return cells.map((c) => ({ poly: V.board.cellPoly(Engine.cellIndex(st.topo, c)), y: V.surface + 0.01 }));
    const low = {};
    cells.forEach((c) => { const k = c[0] + ',' + c[2]; if (!(k in low) || c[1] < low[k][1]) low[k] = c; });
    return Object.keys(low).map((k) => {
      const c = low[k];
      return { poly: V.board.column(c[0], c[2]).poly, y: V.surface + c[1] * V.board.layerH + 0.01 };
    });
  }

  function setQuads(group, items, mat) {
    disposeGroup(group);
    items.forEach((it) => {
      const m = new THREE.Mesh(polyGeometry(it.poly, it.y, it.inset || 0), mat);
      m.userData.sharedMat = true;
      m.renderOrder = 2;
      group.add(m);
    });
  }

  function updateMarks() {
    const st = api.state();
    // 落点
    const m = V.held ? api.move() : null;
    let ok = false;
    if (m) ok = Engine.checkPlacement(st, st.current, m.piece, m.orient, m.x, m.y, m.z) === null;
    const gk = m ? [m.piece, m.orient, m.x, m.y, m.z, ok].join(',') : '';
    if (gk !== ghostKey) {
      ghostKey = gk;
      setQuads(ghostGroup, m ? footprint(m) : [], flatMat(ok ? '#35d07f' : '#ff5648', 0.75));
    }
    V.heldMove = m; V.heldOk = ok;
    // 提示
    const h = api.canAct() ? api.hint() : null;
    const hk = h ? [h.piece, h.orient, h.x, h.y, h.z].join(',') : '';
    if (hk !== hintKey) {
      hintKey = hk;
      setQuads(hintGroup, h ? footprint(h).map((q) => Object.assign(q, { y: q.y + 0.004 })) : [], hintMat);
    }
    // 角点
    const list = api.canAct() && api.prefs().hints ? api.anchors() : null;
    const ak = list ? st.actions.length + ':' + list.length + ':' + st.current : '';
    if (ak !== anchorKey) {
      anchorKey = ak;
      disposeGroup(anchorGroup);
      if (list && list.length) {
        const r = V.board.kind === 'tri' || V.board.kind === 'prism' ? 0.12 : 0.17;
        const geo = new THREE.CircleGeometry(r, 18).rotateX(-Math.PI / 2);
        const inst = new THREE.InstancedMesh(geo, anchorMat, list.length);
        const m4 = new THREE.Matrix4();
        list.forEach((idx, i) => {
          const c = V.board.cellCenter(idx);
          const y = V.board.dims === 3 ? V.surface + (c[1] - V.board.layerH / 2) + 0.012 : V.surface + 0.012;
          m4.makeTranslation(c[0], y, c[2]);
          inst.setMatrixAt(i, m4);
        });
        inst.renderOrder = 1;
        inst.userData.sharedMat = true;
        anchorGroup.add(inst);
        anchorMat.color.set(COLORS[st.players[st.current].color]);
      }
    }
    // 联机：别人手里的棋子
    const rp = api.remote ? api.remote() : null;
    updateRemote(rp);
  }

  const hintMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });
  const anchorMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false });

  function updateRemote(rp) {
    const st = api.state();
    const key = rp ? [rp.piece, rp.orient, rp.x, rp.y, rp.z, st.current].join(',') : '';
    if (key === V.remoteKey) return;
    V.remoteKey = key;
    if (V.remoteMesh) { pieceGroup.remove(V.remoteMesh); V.remoteMesh.material.dispose(); V.remoteMesh = null; }
    // 那块棋子从它主人的面前浮起来，停在他正在尝试的位置上方
    V.P.forEach((list) => list.forEach((pc) => { if (pc.remote) { pc.remote = false; if (pc.where === 'remote') pc.where = 'tray'; } }));
    if (!rp) return;
    const pc = V.P[st.current] && V.P[st.current][rp.piece];
    const pos = boardPosOf(rp);
    if (!pc || !pos || pc.where !== 'tray') return;
    pc.remote = true;
    pc.where = 'remote';
    V.anims = V.anims.filter((a) => a.pc !== pc);
    setGeo(pc, rp.orient);
    pos.y += HOVER;
    moveTo(pc, pos, new THREE.Quaternion(), 0.25, 0.4, null, null, 1);
  }

  /* ================= 手里的棋子 ================= */

  function updateHeld(dt, clock) {
    const pc = V.held;
    if (!pc) return;
    const sel = api.selection();
    if (!sel) return;
    // 选中的棋子刚换了（例如点了提示）：等下一次同步再跟上
    if (sel.piece !== pc.piece || pc.player !== api.state().current) { view.update(); return; }
    if (V.heldOrient !== sel.orient) {
      setGeo(pc, sel.orient);
      V.heldOrient = sel.orient;
    }
    // 目标位置：落点上方；还没有落点时停在自己面前上方
    let goal;
    const m = V.heldMove;
    if (m) { goal = boardPosOf(m); if (goal) goal.y += HOVER + (V.board.dims === 3 ? 0.4 : 0); }
    if (!goal) { goal = trayPos(pc); goal.y += 1.6; }
    const k = 1 - Math.exp(-dt * 18);
    const sNow = pc.mesh.scale.x;
    if (Math.abs(sNow - 1) > 0.002) pc.mesh.scale.setScalar(sNow + (1 - sNow) * k);
    const wob = Math.sin(clock * 60) * (V.shake || 0) * 0.4;
    pc.mesh.position.x += (goal.x + wob - pc.mesh.position.x) * k;
    pc.mesh.position.y += (goal.y + Math.sin(clock * 2.2) * 0.04 + (V.boost || 0) - pc.mesh.position.y) * k;
    pc.mesh.position.z += (goal.z - pc.mesh.position.z) * k;
    // 转动 / 翻面的动画：从变换前的姿态转回到正位
    const ta = V.turnAnim;
    if (ta) {
      ta.t = Math.min(1, ta.t + dt / ta.dur);
      const q = new THREE.Quaternion().setFromAxisAngle(ta.axis, -ta.angle * (1 - ease(ta.t)));
      pc.mesh.quaternion.copy(q);
      if (ta.t >= 1) V.turnAnim = null;
    } else {
      pc.mesh.quaternion.slerp(new THREE.Quaternion(), 1 - Math.exp(-dt * 14));
    }
  }

  /**
   * 转动手里的棋子（以拿着它的人的视角）：
   *   'rotate' dir=1 顺时针 / -1 逆时针；'mirror' 左右镜像；'tip' 向前翻（立体）；'roll' 侧翻（立方体）
   */
  function turn(op, dir) {
    const sel = api.selection();
    if (!sel || !api.canAct()) return false;
    const st = api.state();
    const az = viewAz();
    const r = Geom.turn(st.set, sel.piece, sel.orient, op, dir, az);
    if (r.orient < 0) return false;
    // 镜像的动画：像真的把棋子左右翻过来一样，绕前后方向的轴转半圈
    let axis = r.axis, angle = r.angle;
    if (op === 'mirror') { axis = [-Math.sin(az), 0, -Math.cos(az)]; angle = Math.PI; }
    api.setOrient(r.orient);
    if (V.held && axis) {
      setGeo(V.held, r.orient);
      V.heldOrient = r.orient;
      V.turnAnim = { axis: new THREE.Vector3(axis[0], axis[1], axis[2]).normalize(), angle: angle, t: 0, dur: op === 'rotate' ? 0.16 : 0.3 };
      V.boost = op === 'rotate' ? 0.15 : 1.2;
    }
    return true;
  }

  /* ================= 指针操作 ================= */

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pointers = new Map();
  let press = null, pinch = 0;

  const invPlay = new THREE.Matrix4();
  const localRay = new THREE.Ray();

  function setRay(x, y) {
    if (AR.session) {
      // AR：画面铺满整个屏幕（DOM 浮层也是）
      ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    } else {
      const r = canvas.getBoundingClientRect();
      ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    }
    ray.setFromCamera(ndc, AR.on ? arCam() : camera);
  }

  function pieceAt(x, y) {
    if (!api.canAct() || (AR.on && !AR.placed)) return null;
    setRay(x, y);
    const st = api.state();
    const mine = V.P[st.current].filter((pc) => pc.where === 'tray' && !pc.remote).map((pc) => pc.mesh);
    if (V.held) mine.push(V.held.mesh);
    const hit = ray.intersectObjects(mine, false)[0];
    return hit ? hit.object.userData.pc : null;
  }

  // 指针下的格子（平面：{x, y}；立体：{x, z}）；不在棋盘上时 null
  function cellAt(x, y) {
    setRay(x, y);
    const B = V.board;
    // 在对局空间的本地坐标里求交（AR 里对局空间被摆到了真实桌面上，平常只是缩放）
    play.updateMatrixWorld();
    invPlay.copy(play.matrixWorld).invert();
    localRay.copy(ray.ray).applyMatrix4(invPlay);
    plane.constant = -V.surface;
    const v = new THREE.Vector3();
    if (!localRay.intersectPlane(plane, v)) return null;
    const st = api.state(), topo = st.topo;
    let best = null, bd = Infinity;
    if (B.dims === 3) {
      B.columns.forEach((c) => {
        const d = Math.hypot(c.center[0] - v.x, c.center[1] - v.z);
        if (d < bd) { bd = d; best = c; }
      });
      return best && bd < 1.2 ? { x: best.x, z: best.z } : null;
    }
    B.cells.forEach((i) => {
      const c = B.cellCenter(i);
      const d = Math.hypot(c[0] - v.x, c[2] - v.z);
      if (d < bd) { bd = d; best = i; }
    });
    const lim = B.kind === 'hex' ? 0.75 : B.kind === 'tri' ? 0.6 : 0.8;
    return best != null && bd < lim ? { x: best % topo.cols, y: Math.floor(best / topo.cols) } : null;
  }

  function aim(x, y, dy) {
    const c = cellAt(x, y - (dy || 0));
    if (c) api.setGhost(c);
    return c;
  }

  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    rig.spin = 0;
    if (pointers.size === 2) {
      const p = Array.from(pointers.values());
      pinch = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      press = null;
      return;
    }
    press = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, button: e.button, moved: false, touch: e.pointerType !== 'mouse', dragHeld: false };
    if (AR.on && !AR.placed) { press.placing = true; return; }   // AR：先把棋盘放到桌面上
    if (e.button !== 0 && !press.touch) return;
    const pc = pieceAt(e.clientX, e.clientY);
    if (press.touch) {
      // 触屏：按住自己的棋子直接拖
      if (pc && pc === V.held) press.dragHeld = true;
      else if (pc) { api.select(pc.piece); press.dragHeld = true; press.picked = true; }
    } else if (V.held && (!pc || pc === V.held)) {
      press.dragHeld = true;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const rec = pointers.get(e.pointerId);
    if (rec) { rec.x = e.clientX; rec.y = e.clientY; }
    if (pointers.size === 2) {
      const p = Array.from(pointers.values());
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (pinch > 0 && d > 0) {
        if (AR.on) AR.size = THREE.MathUtils.clamp(AR.size * d / pinch, 0.35, 3);   // AR：双指缩放整个棋盘
        else zoomBy(pinch / d);
      }
      pinch = d;
      return;
    }
    if (press) {
      const dx = e.clientX - press.lx, dy = e.clientY - press.ly;
      press.lx = e.clientX; press.ly = e.clientY;
      if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
      if (press.dragHeld) {
        if (press.moved) aim(e.clientX, e.clientY, press.touch ? 56 : 0);
      } else if (press.moved) {
        if (AR.on) {
          if (AR.placed) AR.yaw += dx * 0.009;      // AR：拖空白处转动棋盘
        } else if (press.button === 2 || e.shiftKey) {
          const s = rig.dist * 0.0012;
          const cx = Math.cos(rig.az), sx = Math.sin(rig.az);
          rig.goal.target.x = THREE.MathUtils.clamp(rig.goal.target.x - (dx * cx + dy * sx) * s, -30, 30);
          rig.goal.target.z = THREE.MathUtils.clamp(rig.goal.target.z - (-dx * sx + dy * cx) * s, -30, 30);
        } else {
          rig.goal.az -= dx * 0.0055;
          rig.goal.pol -= dy * 0.0045;
        }
      }
      return;
    }
    if (e.pointerType !== 'mouse') return;
    if (V.held) { aim(e.clientX, e.clientY, 0); canvas.style.cursor = 'grabbing'; }
    else {
      const pc = pieceAt(e.clientX, e.clientY);
      V.hover = pc;
      canvas.style.cursor = pc ? 'grab' : '';
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    const p = press;
    press = null;
    if (!p || e.type === 'pointercancel') return;
    if (p.placing) { if (!p.moved) placeAR(); return; }
    if (p.moved) {
      // 鼠标按住拖到棋盘上松开：能放就直接落子
      if (p.dragHeld && !p.touch && V.heldOk) api.place();
      return;
    }
    if (p.button === 2) { turn('rotate', 1); return; }
    if (p.button === 1) { turn(V.board.dims === 3 ? 'tip' : 'mirror', 1); return; }
    if (p.touch) {
      if (p.picked) return;
      if (p.dragHeld) { api.place(); return; }        // 再点一下手里的棋子 = 落子
      const pc = pieceAt(e.clientX, e.clientY);
      if (pc) { api.select(pc.piece); return; }
      if (V.held) aim(e.clientX, e.clientY, 0);
      return;
    }
    const pc = pieceAt(e.clientX, e.clientY);
    if (pc && pc !== V.held) { api.select(pc.piece); aim(e.clientX, e.clientY, 0); return; }
    if (!V.held) return;
    const c = aim(e.clientX, e.clientY, 0);
    if (c) api.place();
    else api.drop();
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (V.held && !e.ctrlKey) {
      const now = performance.now();
      if (now - (V.lastWheel || 0) > 110) { turn('rotate', e.deltaY > 0 ? 1 : -1); V.lastWheel = now; }
      return;
    }
    if (AR.on) { AR.size = THREE.MathUtils.clamp(AR.size * Math.exp(-e.deltaY * 0.0012), 0.35, 3); return; }
    zoomBy(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0012)));
  }, { passive: false });

  /* ================= 环境 ================= */

  let env = null, envRT = null, envId = null;
  function applyEnvironment(id) {
    const cfg = environmentById(id);
    if (env) { scene.remove(env.group); env.dispose(); }
    envId = cfg.id;
    env = buildEnvironment(cfg);
    scene.add(env.group);
    scene.background = new THREE.Color(cfg.background);
    scene.fog = new THREE.FogExp2(cfg.fog.color, cfg.fog.density);
    renderer.toneMappingExposure = cfg.exposure;
    if (V.board) { fitScale(); buildBoard(cfg.board); }
    play.visible = false;
    const rt = pmrem.fromScene(scene, 0.03, 1, 700);
    play.visible = true;
    if (envRT) envRT.dispose();
    envRT = rt;
    scene.environment = rt.texture;
    scene.environmentIntensity = cfg.envIntensity == null ? 0.6 : cfg.envIntensity;
    host.dataset.env = cfg.id;
    if (quality) applyQuality();
    perf.warm = 0;
  }

  // 棋盘和各座位的棋子都放得下桌面：按棋盘大小缩放
  function fitScale() {
    const st = api.state();
    let reach = 0;
    st.players.forEach((pl, p) => { reach = Math.max(reach, Geom.trayLayout(st, V.board, V.angles, p, false, traySc()).reach); });
    const table = env ? env.tableReach : 34;
    const s = Math.min(BOARD_SPAN / Math.max(V.board.width, V.board.depth), (table - 2.5) / reach);
    if (Math.abs(s - V.scale) > 1e-6) {
      V.scale = s;
      play.scale.setScalar(s);
    }
  }

  /* ================= AR（WebXR：安卓 Chrome + ARCore） ================= */
  // 把棋盘和棋子放到摄像头画面里的真实桌面上：虚拟房间和桌子都不画，只画对局空间。
  // ?arsim=1：没有 AR 设备时用普通画面模拟（灰色背景、一块"桌面"，屏幕中心对准的点当作检测到的平面），便于调试。
  const arSim = new URLSearchParams(location.search).has('arsim');
  const AR = {
    on: false, session: null, hitSource: null, placed: false, found: false, size: 1, yaw: 0, saved: null,
    root: new THREE.Group(), pivot: new THREE.Group(), extra: new THREE.Group(), simFloor: null
  };
  AR.root.add(AR.pivot);
  AR.pivot.position.y = -TABLE_Y;      // 虚拟桌面的高度对齐到真实平面
  const reticle = new THREE.Group();
  {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, depthTest: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.062, 48).rotateX(-Math.PI / 2), m);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.008, 16).rotateX(-Math.PI / 2), m);
    ring.renderOrder = dot.renderOrder = 10;
    reticle.add(ring, dot);
    reticle.visible = false;
  }
  const arHemi = new THREE.HemisphereLight(0xffffff, 0x8a8070, 1.1);
  const arSun = new THREE.DirectionalLight(0xffffff, 2.2);
  arSun.castShadow = true;
  arSun.shadow.mapSize.set(1024, 1024);
  arSun.shadow.bias = -0.0004;
  arSun.shadow.normalBias = 0.01;
  AR.extra.add(arHemi, arSun, arSun.target, reticle);
  // 只显示影子的透明地面：棋盘和棋子在真实桌面上投下影子
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(160, 160).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.3, depthWrite: false }));
  catcher.position.y = TABLE_Y + 0.01;
  catcher.receiveShadow = true;
  AR.pivot.add(catcher);
  const arRay = new THREE.Raycaster();
  const arPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const arV = new THREE.Vector3(), arC = new THREE.Vector3(), arM = new THREE.Matrix4();

  // 世界单位 → 米
  function arUnit() { return AR_BOARD_M * AR.size / (Math.max(V.board.width, V.board.depth) * V.scale); }
  function arCam() {
    if (!AR.session) return camera;
    const xc = renderer.xr.getCamera();
    return xc.cameras && xc.cameras.length ? xc.cameras[0] : xc;
  }
  function arNotify() { if (api.onAR) api.onAR(); }

  // 拿着棋子的人从哪个方向看棋盘（转动、镜像以此为准）。AR 里人会绕着桌子走：用手机的实际位置，取整到格子的对称方向
  function viewAz() {
    if (AR.on && AR.placed) {
      play.updateMatrixWorld();
      const v = play.worldToLocal(arC.setFromMatrixPosition(arCam().matrixWorld));
      const snap = V.board.kind === 'square' || V.board.kind === 'cube' ? Math.PI / 2 : Math.PI / 6;
      return Math.round(Math.atan2(v.x, v.z) / snap) * snap;
    }
    return seatAz(api.viewSeat());
  }

  function arSupported() {
    if (arSim) return Promise.resolve(true);
    if (!navigator.xr || !navigator.xr.isSessionSupported || !window.isSecureContext) return Promise.resolve(false);
    return navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  }

  // 必须在点击事件里同步调用（浏览器要求用户手势）；返回 Promise<是否进入>
  async function enterAR(overlay) {
    if (AR.on || !V.board) return false;
    if (arSim) { beginAR(null); return true; }
    if (!navigator.xr) return false;
    let session;
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: overlay ? { root: overlay } : undefined
      });
    } catch (e) { return false; }
    try {
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType('local');
      await renderer.xr.setSession(session);
      const viewer = await session.requestReferenceSpace('viewer');
      AR.hitSource = await session.requestHitTestSource({ space: viewer });
    } catch (e) {
      try { await session.end(); } catch (err) { /* 已经结束 */ }
      renderer.xr.enabled = false;
      return false;
    }
    session.addEventListener('end', endAR);
    beginAR(session);
    return true;
  }

  function beginAR(session) {
    AR.on = true; AR.session = session; AR.placed = false; AR.found = false; AR.size = 1; AR.yaw = 0;
    AR.saved = {
      bg: scene.background, fog: scene.fog, near: camera.near, far: camera.far, exposure: renderer.toneMappingExposure,
      envI: scene.environmentIntensity, clearAlpha: renderer.getClearAlpha(), shadows: renderer.shadowMap.enabled
    };
    if (env) env.group.visible = false;
    scene.fog = null;
    scene.background = session ? null : new THREE.Color(0x5b6066);
    renderer.setClearAlpha(0);
    renderer.toneMappingExposure = 1;
    scene.environmentIntensity = 0.55;
    renderer.shadowMap.enabled = true;
    camera.near = 0.01; camera.far = 40; camera.updateProjectionMatrix();
    AR.pivot.add(play);
    AR.root.visible = false;
    scene.add(AR.root, AR.extra);
    V.hover = null;
    pointers.clear(); press = null; pinch = 0;
    if (!session) {
      // 模拟：手机举在桌面斜上方
      if (!AR.simFloor) {
        AR.simFloor = new THREE.Mesh(new THREE.CircleGeometry(1.4, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9a8268, roughness: 0.85 }));
        AR.simFloor.receiveShadow = true;
        AR.simFloor.position.y = -0.002;
      }
      AR.extra.add(AR.simFloor);
      camera.position.set(0, 0.7, 0.66);
      camera.lookAt(0, 0, -0.08);
    } else {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      renderer.setAnimationLoop(frameLoop);
    }
    arNotify();
  }

  function endAR() {
    if (!AR.on) return;
    const s = AR.saved;
    AR.on = false;
    if (AR.hitSource) { try { AR.hitSource.cancel(); } catch (e) { /* 忽略 */ } AR.hitSource = null; }
    if (AR.session) { renderer.setAnimationLoop(null); renderer.xr.enabled = false; }
    AR.session = null;
    scene.remove(AR.root, AR.extra);
    scene.add(play);
    if (env) env.group.visible = true;
    scene.background = s.bg; scene.fog = s.fog;
    renderer.setClearAlpha(s.clearAlpha);
    renderer.toneMappingExposure = s.exposure;
    scene.environmentIntensity = s.envI;
    renderer.shadowMap.enabled = s.shadows;
    camera.near = s.near; camera.far = s.far; camera.updateProjectionMatrix();
    pointers.clear(); press = null; pinch = 0;
    V.lastAspect = 0;
    if (V.visible) { resize(); lockCamera(true); start(); }
    arNotify();
  }

  function placeAR() {
    if (!AR.on || !AR.root.visible) return;
    AR.placed = true;
    reticle.visible = false;
    arNotify();
  }

  // 每帧：找桌面、让棋盘跟着准星（还没放下时）、灯光和影子跟着棋盘
  function updateAR(xrFrame, dt) {
    let hit = false;
    if (AR.session) {
      if (xrFrame && AR.hitSource) {
        const res = xrFrame.getHitTestResults(AR.hitSource);
        const pose = res.length ? res[0].getPose(renderer.xr.getReferenceSpace()) : null;
        if (pose) {
          arM.fromArray(pose.transform.matrix);
          hit = arM.elements[5] > 0.8;           // 只要水平的面（法线朝上）
          if (hit) arV.setFromMatrixPosition(arM);
        }
      }
    } else {
      arRay.setFromCamera(new THREE.Vector2(0, 0), camera);
      hit = !!arRay.ray.intersectPlane(arPlane, arV) && Math.hypot(arV.x, arV.z) < 1.3;
    }
    if (!AR.placed) {
      reticle.visible = hit;
      if (hit) {
        reticle.position.copy(arV);
        const first = !AR.root.visible;
        if (first) AR.root.position.copy(arV);
        else AR.root.position.lerp(arV, 1 - Math.exp(-dt * 12));
        // 自己的座位朝向手机
        const cp = arC.setFromMatrixPosition(arCam().matrixWorld);
        const want = Math.atan2(cp.x - AR.root.position.x, cp.z - AR.root.position.z) - seatAz(api.viewSeat());
        const w = nearestAngle(AR.yaw, want);
        AR.yaw = first ? w : AR.yaw + (w - AR.yaw) * (1 - Math.exp(-dt * 6));
        AR.root.visible = true;
      }
      if (hit !== AR.found) { AR.found = hit; arNotify(); }
    }
    AR.root.rotation.y = AR.yaw;
    const u = arUnit();
    AR.root.scale.setScalar(u);
    const r = (env ? env.tableReach : 34) * u;        // 对局空间的半径（米）
    const o = AR.root.position;
    arSun.position.set(o.x + r * 0.7, o.y + r * 2.4, o.z + r * 0.5);
    arSun.target.position.copy(o);
    const sc = arSun.shadow.camera;
    if (Math.abs(sc.right - r * 1.2) > 1e-4) {
      sc.left = -r * 1.2; sc.right = r * 1.2; sc.top = r * 1.2; sc.bottom = -r * 1.2;
      sc.near = r * 0.2; sc.far = r * 6;
      sc.updateProjectionMatrix();
    }
  }

  /* ================= 主循环 ================= */

  function resize() {
    if (AR.session) return;     // AR 时画面大小由设备决定
    const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 50 : 40;
    camera.updateProjectionMatrix();
    const narrow = w / h < 0.8;
    if (V.board && narrow !== V.narrow) { V.narrow = narrow; layoutTrays(true); }
    V.narrow = narrow;
    // 自由镜头时，只有画面比例明显变了（如横竖屏切换）才重新取景
    const big = !V.lastAspect || Math.abs(camera.aspect / V.lastAspect - 1) > 0.12;
    if (big) V.lastAspect = camera.aspect;
    if (V.board) lockCamera(big);
  }

  const perf = { n: 0, sum: 0, slow: 0, warm: 0 };
  let lastT = performance.now(), clock = 0, raf = 0;

  function frameLoop(now, xrFrame) {
    raf = 0;
    if (!V.visible && !AR.session) return;
    const raw = (now - lastT) / 1000;
    const dt = Math.min(0.25, raw);
    lastT = now; clock += dt;
    perf.warm += dt;
    if (!AR.on && !document.hidden && raw < 1.5 && perf.warm > 3) {
      perf.n++; perf.sum += raw;
      if (perf.n >= 90) {
        perf.slow = perf.sum / perf.n > 1 / 24 ? perf.slow + 1 : 0;
        if (perf.slow >= 2 && quality < QUALITY.length - 1 && !qParam) { quality++; perf.slow = 0; perf.warm = 0; applyQuality(); }
        perf.n = 0; perf.sum = 0;
      }
    }
    if (V.board) {
      if (AR.on) updateAR(xrFrame, dt);
      else updateCamera(dt);
      for (let i = V.anims.length - 1; i >= 0; i--) {
        const a = V.anims[i];
        a.t = Math.min(1, a.t + dt / a.dur);
        const e = ease(a.t);
        if (a.swap && a.t >= 0.5) { a.swap(); a.swap = null; }
        a.pc.mesh.position.lerpVectors(a.p0, a.p1, e);
        a.pc.mesh.position.y += Math.sin(Math.PI * e) * a.arc;
        a.pc.mesh.quaternion.slerpQuaternions(a.q0, a.q1, e);
        if (a.s0 !== a.s1) a.pc.mesh.scale.setScalar(a.s0 + (a.s1 - a.s0) * e);
        if (a.t >= 1) { V.anims.splice(i, 1); if (a.swap) a.swap(); if (a.done) a.done(); }
      }
      V.boost = (V.boost || 0) * Math.exp(-dt * 5);
      V.shake = Math.max(0, (V.shake || 0) - dt);
      updateHeld(dt, clock);
      V.P.forEach((list) => list.forEach((pc) => {
        const hover = pc === V.hover && pc.where === 'tray';
        const want = hover ? 0.25 : 0;
        if (pc.where === 'tray' && Math.abs(pc.lift - want) > 0.001) {
          pc.lift += (want - pc.lift) * (1 - Math.exp(-dt * 14));
          if (!V.anims.some((a) => a.pc === pc)) pc.mesh.position.y = trayPos(pc).y + pc.lift;
        }
        const glow = 0.05 + (hover ? 0.2 : 0) + pc.glow + (pc === V.held ? 0.1 : 0);
        pc.mat.emissiveIntensity += (glow - pc.mat.emissiveIntensity) * (1 - Math.exp(-dt * 8));
      }));
      if (V.last && V.last.glow > 0.14) V.last.glow = Math.max(0.14, V.last.glow - dt * 0.12);
      anchorMat.opacity = 0.6 + 0.3 * Math.sin(clock * 3.2);
      hintMat.opacity = 0.4 + 0.3 * Math.sin(clock * 5);
    }
    if (env && !AR.on) env.update(dt, clock, camera);
    renderer.render(scene, camera);
    if (!AR.session) raf = requestAnimationFrame(frameLoop);
  }

  function start() {
    if (raf || !V.visible || AR.session) return;
    lastT = performance.now();
    raf = requestAnimationFrame(frameLoop);
  }

  window.addEventListener('resize', () => { if (V.visible) resize(); });

  /* ================= 对外接口 ================= */

  const view = {
    // 新的一局（或换了模式 / 人数）：重建棋盘和棋子
    setGame() {
      const st = api.state();
      if (!st) return;
      V.board = Geom.boardOf(st);
      V.angles = Geom.seatAngles(st, V.board);
      V.held = null; V.last = null; V.anims = []; V.turnAnim = null; V.remoteKey = ''; V.remoteMesh = null;
      ghostKey = hintKey = anchorKey = '';
      V.actionsSeen = 0;
      if (!env) applyEnvironment(api.prefs().env || ENVIRONMENTS[0].id);
      fitScale();
      buildBoard(environmentById(envId).board);
      buildPieces();
      syncPieces(false);
      V.actionsSeen = st.actions.length;
      V.framedSeat = null;
      resize();
      lockCamera(true);
      // 一开始从高处慢慢落到座位
      const L = rig.lock || rig.goal;
      rig.az = rig.goal.az = L.az;
      rig.pol = L.pol + 0.25;
      rig.dist = L.dist + 24;
      rig.target.copy(L.target);
    },
    // 局面或选中的棋子变了（每次 app 重画时调用）
    update() {
      const st = api.state();
      if (!st || !V.board) return;
      syncPieces(true);
      updateMarks();
      const seat = api.viewSeat();
      const holdNow = !!V.held;
      const key = st.actions.length + ':' + st.current + ':' + seat + ':' + api.canAct() + ':' + st.over;
      if (key !== V.camKey) {
        V.camKey = key;
        if (st.over) { rig.lock = null; rig.holdLock = null; rig.spin = 0.12; rig.goal.pol = 0.95; rig.goal.target.set(0, 0, 0); }
        else lockCamera();
      } else if (holdNow && !rig.holdLock && api.canAct()) lockCamera();
    },
    show() {
      if (V.visible) return;
      V.visible = true;
      host.hidden = false;
      resize();
      start();
    },
    hide() {
      if (AR.on) view.exitAR();
      V.visible = false;
      host.hidden = true;
    },
    turn: turn,
    shake() { V.shake = 0.35; },
    setTopView(on) { rig.top = !!on; lockCamera(true); return rig.top; },
    get topView() { return rig.top; },
    setEnvironment(id) {
      const fade = host.querySelector('.table-fade');
      if (fade) fade.classList.add('on');
      setTimeout(() => {
        applyEnvironment(id);
        if (api.onEnvChange) api.onEnvChange(envId);
        requestAnimationFrame(() => { if (fade) fade.classList.remove('on'); });
      }, fade ? 380 : 0);
    },
    nextEnvironment() {
      const i = ENVIRONMENTS.findIndex((e) => e.id === envId);
      const next = ENVIRONMENTS[(i + 1) % ENVIRONMENTS.length];
      view.setEnvironment(next.id);
      return next;
    },
    environments: ENVIRONMENTS,
    get environment() { return envId; },
    seatAngle(p) { return seatAz(p); },
    holding() { return !!V.held; },
    heldOk() { return !!V.heldOk; },
    // AR
    arSupported: arSupported,
    enterAR: enterAR,
    exitAR() {
      if (!AR.on) return;
      if (AR.session) AR.session.end().catch(() => endAR());
      else endAR();
    },
    replaceAR() { if (AR.on) { AR.placed = false; AR.found = false; arNotify(); } },
    arState() { return { on: AR.on, live: !!AR.session, placed: AR.placed, found: AR.found }; },
    // 调试和自动测试用
    _debug: { V: V, rig: rig, camera: camera, play: play, api: api, AR: AR }
  };
  const fade = document.createElement('div');
  fade.className = 'table-fade';
  host.appendChild(fade);
  return view;
}

window.BlockTurfTable = { create: createTableView };
window.dispatchEvent(new Event('blockturf-table-ready'));
