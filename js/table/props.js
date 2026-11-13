/*
 * 三维牌桌的环境搭建：按 environments.js 里的配置生成房间、桌子、灯光和空气里的粒子。
 * 全部用程序生成的几何体和画布贴图，不依赖外部素材。
 *
 * 坐标：棋盘格面在 y = 0，桌面在 y = TABLE_Y，地板在 TABLE_Y - table.height；一个单位约 2 厘米。
 * 要加新的摆设：在 PROPS 里加一个函数 (ctx, item)，配置里用 { prop: '名字', ... } 引用。
 */
import * as THREE from '../vendor/three.module.min.js';

export const TABLE_Y = -0.5;

/* ================= 小工具 ================= */

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(w, h, draw, opts) {
  opts = opts || {};
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (opts.repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(opts.repeat[0], opts.repeat[1]);
  }
  return t;
}

function woodTexture(c1, c2, opts) {
  opts = opts || {};
  const rnd = mulberry(opts.seed || 7);
  return canvasTexture(1024, 1024, function (g, w, h) {
    g.fillStyle = c1; g.fillRect(0, 0, w, h);
    const planks = opts.planks || 0;
    if (planks) {
      const ph = h / planks;
      for (let i = 0; i < planks; i++) {
        g.fillStyle = 'rgba(' + (rnd() < 0.5 ? '0,0,0,' : '255,220,170,') + (rnd() * 0.12).toFixed(3) + ')';
        g.fillRect(0, i * ph, w, ph);
      }
    }
    g.strokeStyle = c2;
    for (let i = 0; i < 260; i++) {
      const y0 = rnd() * h, amp = 2 + rnd() * 7, freq = 0.004 + rnd() * 0.01, ph0 = rnd() * 6.28;
      g.globalAlpha = 0.06 + rnd() * 0.22;
      g.lineWidth = 0.6 + rnd() * 2.4;
      g.beginPath();
      for (let x = 0; x <= w; x += 16) {
        const y = y0 + Math.sin(x * freq + ph0) * amp;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    if (planks) {
      const ph = h / planks;
      g.fillStyle = 'rgba(0,0,0,0.5)';
      for (let i = 0; i < planks; i++) {
        g.fillRect(0, i * ph - 1, w, 2.5);
        const n = 2 + Math.floor(rnd() * 2);
        for (let k = 0; k < n; k++) g.fillRect(rnd() * w, i * ph, 2.5, ph);
      }
    }
  }, { repeat: opts.repeat });
}

function noiseTexture(color, strength, opts) {
  opts = opts || {};
  const rnd = mulberry(opts.seed || 3);
  return canvasTexture(512, 512, function (g, w, h) {
    g.fillStyle = color; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 14000; i++) {
      g.fillStyle = 'rgba(' + (rnd() < 0.5 ? '0,0,0,' : '255,255,255,') + (rnd() * strength).toFixed(3) + ')';
      g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    if (opts.stripes) {
      for (let x = 0; x < w; x += w / opts.stripes) {
        g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(x, 0, w / opts.stripes / 2, h);
        g.fillStyle = 'rgba(255,220,150,0.10)'; g.fillRect(x + w / opts.stripes / 2 - 1.5, 0, 1.5, h);
      }
    }
  }, { repeat: opts.repeat });
}

function tatamiTexture(repeat) {
  const rnd = mulberry(11);
  return canvasTexture(1024, 1024, function (g, w, h) {
    const mat = function (x, y, mw, mh) {
      g.fillStyle = 'rgb(' + (168 + rnd() * 16 | 0) + ',' + (160 + rnd() * 14 | 0) + ',' + (98 + rnd() * 14 | 0) + ')';
      g.fillRect(x, y, mw, mh);
      g.strokeStyle = 'rgba(90,84,40,0.35)';
      g.lineWidth = 1;
      for (let yy = y + 2; yy < y + mh; yy += 4) { g.beginPath(); g.moveTo(x, yy); g.lineTo(x + mw, yy); g.stroke(); }
      g.fillStyle = '#2d3b2c';
      g.fillRect(x, y, mw, 22); g.fillRect(x, y + mh - 22, mw, 22);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x, y, 2, mh); g.fillRect(x + mw - 2, y, 2, mh);
    };
    mat(0, 0, w, h / 2);
    mat(-w / 2, h / 2, w, h / 2);
    mat(w / 2, h / 2, w, h / 2);
  }, { repeat: repeat });
}

function glowSprite() {
  return canvasTexture(64, 64, function (g) {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.4, 'rgba(255,255,255,0.5)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
}

function std(color, roughness, extra) {
  return new THREE.MeshStandardMaterial(Object.assign({ color: color, roughness: roughness == null ? 0.7 : roughness, metalness: 0 }, extra || {}));
}

function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x || 0, y || 0, z || 0);
  return m;
}

function cyl(rt, rb, h, mat, x, y, z, seg) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 32), mat);
  m.position.set(x || 0, y || 0, z || 0);
  return m;
}

function shadow(obj, cast, receive) {
  obj.traverse(function (o) { if (o.isMesh) { o.castShadow = !!cast; o.receiveShadow = receive !== false; } });
  return obj;
}

// 贴着某面墙的局部坐标系：x 沿墙、y 向上（0 是地板）、z 朝房间里
function wallGroup(ctx, wall) {
  const g = new THREE.Group();
  const h = ctx.half;
  if (wall === 'far') g.position.set(0, ctx.floorY, -h);
  else if (wall === 'near') { g.position.set(0, ctx.floorY, h); g.rotation.y = Math.PI; }
  else if (wall === 'left') { g.position.set(-h, ctx.floorY, 0); g.rotation.y = Math.PI / 2; }
  else { g.position.set(h, ctx.floorY, 0); g.rotation.y = -Math.PI / 2; }
  ctx.group.add(g);
  return g;
}

/* ================= 窗外的景色（贴图） ================= */

function nightView() {
  const rnd = mulberry(5);
  return canvasTexture(512, 640, function (g, w, h) {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#0b1634'); gr.addColorStop(0.7, '#27407a'); gr.addColorStop(1, '#4a5f96');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      g.fillStyle = 'rgba(255,255,255,' + (0.3 + rnd() * 0.7).toFixed(2) + ')';
      g.fillRect(rnd() * w, rnd() * h * 0.7, 1.6, 1.6);
    }
    const mg = g.createRadialGradient(360, 150, 0, 360, 150, 120);
    mg.addColorStop(0, 'rgba(255,250,225,1)'); mg.addColorStop(0.28, 'rgba(255,250,225,0.95)');
    mg.addColorStop(0.32, 'rgba(210,225,255,0.3)'); mg.addColorStop(1, 'rgba(210,225,255,0)');
    g.fillStyle = mg; g.fillRect(0, 0, w, h);
    g.fillStyle = '#081020';
    for (let i = 0; i < 9; i++) {
      const x = rnd() * w, th = 120 + rnd() * 200;
      g.beginPath(); g.moveTo(x - 40 - rnd() * 30, h); g.lineTo(x, h - th); g.lineTo(x + 40 + rnd() * 30, h); g.fill();
    }
  });
}

function gardenView() {
  const rnd = mulberry(9);
  return canvasTexture(1024, 1024, function (g, w, h) {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#bfe0ff'); gr.addColorStop(0.55, '#f4f6ea'); gr.addColorStop(1, '#dfeacb');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    const sun = g.createRadialGradient(300, 260, 0, 300, 260, 420);
    sun.addColorStop(0, 'rgba(255,250,220,0.95)'); sun.addColorStop(1, 'rgba(255,250,220,0)');
    g.fillStyle = sun; g.fillRect(0, 0, w, h);
    ['#b9d2c4', '#93b89a', '#6f9c73'].forEach(function (col, i) {
      g.fillStyle = col; g.beginPath(); g.moveTo(0, h);
      for (let x = 0; x <= w; x += 32) g.lineTo(x, h * (0.62 + i * 0.1) + Math.sin(x * 0.006 + i * 2) * 40 + Math.sin(x * 0.02 + i) * 12);
      g.lineTo(w, h); g.fill();
    });
    // 竹子
    for (let i = 0; i < 9; i++) {
      const x = 560 + rnd() * 440, lean = (rnd() - 0.5) * 60;
      g.strokeStyle = 'rgba(60,110,60,' + (0.55 + rnd() * 0.4).toFixed(2) + ')';
      g.lineWidth = 7 + rnd() * 7;
      g.beginPath(); g.moveTo(x, h); g.lineTo(x + lean, 60 + rnd() * 160); g.stroke();
      g.fillStyle = 'rgba(70,130,70,0.75)';
      for (let k = 0; k < 16; k++) {
        const t = rnd(), lx = x + lean * t, ly = h - (h - 150) * t;
        g.save(); g.translate(lx, ly); g.rotate((rnd() - 0.5) * 2.4);
        g.beginPath(); g.ellipse(26, 0, 30, 6, 0, 0, 6.28); g.fill(); g.restore();
      }
    }
    // 枫枝
    g.strokeStyle = '#3a2a22'; g.lineWidth = 9;
    g.beginPath(); g.moveTo(0, 300); g.bezierCurveTo(160, 250, 300, 330, 470, 250); g.stroke();
    g.lineWidth = 4;
    g.beginPath(); g.moveTo(210, 290); g.bezierCurveTo(260, 220, 330, 200, 380, 150); g.stroke();
    for (let i = 0; i < 150; i++) {
      const t = rnd(), x = t * 480 + (rnd() - 0.5) * 120, y = 280 - Math.sin(t * 3) * 40 + (rnd() - 0.5) * 170;
      g.fillStyle = 'rgba(' + (200 + rnd() * 40 | 0) + ',' + (60 + rnd() * 60 | 0) + ',' + (40 + rnd() * 30 | 0) + ',0.85)';
      g.beginPath(); g.arc(x, y, 5 + rnd() * 8, 0, 6.28); g.fill();
    }
  });
}

// 墙上的画：用棋子形状拼的抽象画
function artTexture(seed, bg) {
  const rnd = mulberry(seed);
  const cols = ['#2f6ae0', '#f2b705', '#e43d30', '#22a24d'];
  return canvasTexture(256, 320, function (g, w, h) {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    const s = 32;
    for (let i = 0; i < 26; i++) {
      g.fillStyle = cols[i % 4];
      g.globalAlpha = 0.9;
      let x = Math.floor(rnd() * 8), y = Math.floor(rnd() * 10);
      for (let k = 0; k < 4; k++) {
        g.fillRect(x * s + 2, y * s + 2, s - 4, s - 4);
        if (rnd() < 0.5) x += rnd() < 0.5 ? 1 : -1; else y += rnd() < 0.5 ? 1 : -1;
      }
    }
    g.globalAlpha = 1;
  });
}

function scrollTexture() {
  const rnd = mulberry(21);
  return canvasTexture(256, 768, function (g, w, h) {
    g.fillStyle = '#efe6d0'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#7a8c9a'; g.fillRect(0, 0, w, 70); g.fillRect(0, h - 90, w, 90);
    for (let i = 0; i < 4; i++) {
      g.fillStyle = 'rgba(40,40,45,' + (0.18 + i * 0.16) + ')';
      g.beginPath(); g.moveTo(20, 520 - i * 20);
      for (let x = 20; x <= 236; x += 12) g.lineTo(x, 430 - i * 10 - Math.abs(Math.sin(x * 0.03 + i * 1.7)) * (150 - i * 30) + rnd() * 8);
      g.lineTo(236, 560); g.lineTo(20, 560); g.fill();
    }
    g.strokeStyle = 'rgba(30,30,35,0.8)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(60, 620); g.quadraticCurveTo(120, 590, 200, 630); g.stroke();
    g.fillStyle = '#b3261e'; g.fillRect(190, 150, 26, 26);
  });
}

/* ================= 桌子 ================= */

function buildTable(ctx, cfg) {
  const g = new THREE.Group();
  const wood = std('#ffffff', cfg.roughness, { map: woodTexture(cfg.wood[0], cfg.wood[1], { seed: 31, repeat: [2, 2] }) });
  const leg = std(cfg.wood[1], 0.6);
  const thick = 2.6;
  if (cfg.shape === 'round') {
    const top = cyl(cfg.radius, cfg.radius - 0.7, thick, wood, 0, TABLE_Y - thick / 2, 0, 96);
    g.add(top);
    if (cfg.felt) {
      const felt = new THREE.Mesh(new THREE.CircleGeometry(cfg.felt.radius, 96),
        std('#ffffff', 0.96, { map: noiseTexture(cfg.felt.color, 0.07, { repeat: [5, 5] }) }));
      felt.rotation.x = -Math.PI / 2; felt.position.y = TABLE_Y + 0.02;
      g.add(felt);
      const trim = new THREE.Mesh(new THREE.TorusGeometry(cfg.felt.radius, 0.16, 8, 96), std('#b08a45', 0.35, { metalness: 0.8 }));
      trim.rotation.x = Math.PI / 2; trim.position.y = TABLE_Y + 0.02;
      g.add(trim);
    }
    g.add(cyl(4.5, 6, cfg.height - thick - 3, leg, 0, TABLE_Y - thick - (cfg.height - thick - 3) / 2, 0));
    g.add(cyl(7, 19, 3, leg, 0, ctx.floorY + 1.5, 0, 48));
  } else {
    const s = cfg.size;
    g.add(box(s, thick, s, wood, 0, TABLE_Y - thick / 2, 0));
    const lh = cfg.height - thick, off = s / 2 - 4.5;
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (p) {
      g.add(box(5, lh, 5, leg, p[0] * off, TABLE_Y - thick - lh / 2, p[1] * off));
    });
    g.add(box(s - 9, 3.5, 1.6, leg, 0, TABLE_Y - thick - 1.75, off));
    g.add(box(s - 9, 3.5, 1.6, leg, 0, TABLE_Y - thick - 1.75, -off));
    g.add(box(1.6, 3.5, s - 9, leg, off, TABLE_Y - thick - 1.75, 0));
    g.add(box(1.6, 3.5, s - 9, leg, -off, TABLE_Y - thick - 1.75, 0));
  }
  shadow(g, true, true);
  ctx.group.add(g);
  ctx.tableReach = cfg.shape === 'round' ? cfg.radius : cfg.size / 2;
}

/* ================= 摆设 ================= */

const SIDES = [
  { x: -1, z: 0, rot: Math.PI / 2 },   // 左
  { x: 0, z: -1, rot: 0 },             // 对面
  { x: 1, z: 0, rot: -Math.PI / 2 }    // 右
];

const PROPS = {
  floor(ctx, it) {
    const size = it.size;
    const map = it.texture === 'tatami' ? tatamiTexture([size / 90, size / 90])
      : woodTexture(it.colors[0], it.colors[1], { planks: 9, repeat: [size / 110, size / 110], seed: 17 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), std('#ffffff', it.texture === 'tatami' ? 0.9 : 0.5, { map: map }));
    m.rotation.x = -Math.PI / 2; m.position.y = ctx.floorY; m.receiveShadow = true;
    ctx.group.add(m);
  },

  rug(ctx, it) {
    const tex = canvasTexture(1024, 1024, function (g, w) {
      const c = w / 2;
      const ring = function (r, col) { g.fillStyle = col; g.beginPath(); g.arc(c, c, r, 0, 6.2832); g.fill(); };
      ring(c, it.colors[0]); ring(c * 0.93, it.colors[1]); ring(c * 0.9, it.colors[2]); ring(c * 0.78, it.colors[1]); ring(c * 0.76, it.colors[0]);
      g.strokeStyle = it.colors[1]; g.lineWidth = 5; g.globalAlpha = 0.7;
      for (let i = 0; i < 24; i++) {
        const a = i / 24 * 6.2832;
        g.save(); g.translate(c + Math.cos(a) * c * 0.84, c + Math.sin(a) * c * 0.84); g.rotate(a + 0.785);
        g.strokeRect(-14, -14, 28, 28); g.restore();
      }
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * 6.2832;
        g.beginPath(); g.ellipse(c + Math.cos(a) * c * 0.5, c + Math.sin(a) * c * 0.5, 60, 22, a, 0, 6.2832); g.stroke();
      }
    });
    const m = new THREE.Mesh(new THREE.CircleGeometry(it.radius, 72), std('#ffffff', 0.95, { map: tex }));
    m.rotation.x = -Math.PI / 2; m.position.y = ctx.floorY + 0.15; m.receiveShadow = true;
    ctx.group.add(m);
  },

  walls(ctx, it) {
    const s = it.size, h = it.height;
    ctx.half = s / 2; ctx.height = h;
    const map = it.pattern === 'stripes' ? noiseTexture(it.color, 0.05, { stripes: 8, repeat: [s / 60, 1] })
      : noiseTexture(it.color, 0.035, { repeat: [s / 70, h / 70] });
    // 盒子上下各多出一点，底面和顶面藏在地板、天花板后面
    const walls = new THREE.Mesh(new THREE.BoxGeometry(s, h + 2, s), std('#ffffff', 0.92, { map: map, side: THREE.BackSide }));
    walls.position.y = ctx.floorY + h / 2; walls.receiveShadow = true;
    ctx.group.add(walls);
    if (it.wainscot) {
      const mat = std('#ffffff', 0.5, { map: woodTexture(it.wainscot, '#120a05', { seed: 4, repeat: [6, 1] }) });
      const wh = it.wainscotHeight, half = s / 2;
      [[0, -half + 0.8, s, 1.6], [0, half - 0.8, s, 1.6], [-half + 0.8, 0, 1.6, s], [half - 0.8, 0, 1.6, s]].forEach(function (p) {
        ctx.group.add(box(p[2], wh, p[3], mat, p[0], ctx.floorY + wh / 2, p[1]));
        ctx.group.add(box(p[2] === 1.6 ? 3.2 : s, 2.4, p[3] === 1.6 ? 3.2 : s, mat, p[0], ctx.floorY + wh + 1.2, p[1]));
      });
    }
    if (it.beams) {
      const mat = std(it.beams, 0.7), half = s / 2;
      for (let i = -2; i <= 2; i++) {
        const p = i * (s / 4);
        [[p, -half + 2], [p, half - 2], [-half + 2, p], [half - 2, p]].forEach(function (q) {
          ctx.group.add(box(5, h, 5, mat, q[0], ctx.floorY + h / 2, q[1]));
        });
      }
      [[0, -half + 2.5, s, 4], [0, half - 2.5, s, 4], [-half + 2.5, 0, 4, s], [half - 2.5, 0, 4, s]].forEach(function (p) {
        ctx.group.add(box(p[2], 6, p[3], mat, p[0], ctx.floorY + 116, p[1]));
      });
    }
  },

  bookshelf(ctx, it) {
    const g = wallGroup(ctx, it.wall);
    const W = it.width, H = it.height, D = 15;
    const wood = std('#ffffff', 0.55, { map: woodTexture('#3a2010', '#1a0d05', { seed: 8, repeat: [3, 2] }) });
    g.add(box(W, H, 1.5, wood, 0, H / 2, 0.8));
    g.add(box(2.5, H, D, wood, -W / 2, H / 2, D / 2));
    g.add(box(2.5, H, D, wood, W / 2, H / 2, D / 2));
    g.add(box(2.5, H, D, wood, 0, H / 2, D / 2));
    g.add(box(W + 6, 4, D + 3, wood, 0, H + 2, D / 2));
    const rows = 6, gap = (H - 6) / rows;
    const rnd = mulberry(44);
    const palette = ['#6b1f1c', '#1f3d5c', '#2f4a2a', '#8a6a2a', '#3a2646', '#5a4632', '#7a2f3a', '#243b3a', '#a8946a', '#412018'];
    const books = [];
    for (let r = 0; r <= rows; r++) g.add(box(W, 1.6, D, wood, 0, 3 + r * gap, D / 2));
    for (let r = 0; r < rows; r++) {
      for (let half = 0; half < 2; half++) {
        let x = (half ? 2 : -W / 2 + 2);
        const end = x + W / 2 - 4;
        while (x < end - 4) {
          if (rnd() < 0.06) { x += 5 + rnd() * 10; continue; }
          const bw = 1.8 + rnd() * 2.8, bh = gap * (0.55 + rnd() * 0.33), bd = 8 + rnd() * 4;
          books.push({ x: x + bw / 2, y: 3.8 + r * gap + bh / 2, w: bw, h: bh, d: bd, c: palette[Math.floor(rnd() * palette.length)], tilt: rnd() < 0.04 ? 0.18 : 0 });
          x += bw + 0.15;
        }
      }
    }
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), std('#ffffff', 0.75), books.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    books.forEach(function (b, i) {
      q.setFromEuler(new THREE.Euler(0, 0, b.tilt));
      m4.compose(new THREE.Vector3(b.x, b.y, 2 + b.d / 2), q, new THREE.Vector3(b.w, b.h, b.d));
      inst.setMatrixAt(i, m4);
      inst.setColorAt(i, col.set(b.c));
    });
    g.add(inst);
  },

  window(ctx, it) {
    const g = wallGroup(ctx, it.wall);
    const W = it.width, H = it.height, y = it.y + H / 2;
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: nightView() }));
    pane.position.set(0, y, 0.6); g.add(pane);
    const wood = std('#2a170b', 0.5);
    g.add(box(W + 8, 4, 5, wood, 0, y + H / 2 + 2, 2));
    g.add(box(W + 12, 4, 8, wood, 0, y - H / 2 - 2, 3));
    g.add(box(4, H, 5, wood, -W / 2 - 2, y, 2));
    g.add(box(4, H, 5, wood, W / 2 + 2, y, 2));
    g.add(box(2, H, 2, wood, 0, y, 1.5));
    g.add(box(W, 2, 2, wood, 0, y + H * 0.18, 1.5));
    if (it.curtains) {
      const cm = std('#ffffff', 0.95, { map: noiseTexture(it.curtains, 0.06, { stripes: 10 }) });
      g.add(box(22, H + 26, 4, cm, -W / 2 - 12, y - 4, 5));
      g.add(box(22, H + 26, 4, cm, W / 2 + 12, y - 4, 5));
      g.add(cyl(1.2, 1.2, W + 60, std('#b08a45', 0.4, { metalness: 0.8 }), 0, y + H / 2 + 11, 5).rotateZ(Math.PI / 2));
    }
  },

  fireplace(ctx, it) {
    const g = wallGroup(ctx, it.wall);
    const stone = std('#ffffff', 0.85, { map: noiseTexture('#54483e', 0.1, { repeat: [2, 2] }) });
    g.add(box(18, 62, 16, stone, -30, 31, 8));
    g.add(box(18, 62, 16, stone, 30, 31, 8));
    g.add(box(78, 20, 16, stone, 0, 52, 8));
    g.add(box(90, 5, 22, std('#2a170b', 0.5), 0, 64.5, 11));
    g.add(box(42, 42, 1, std('#050302', 1), 0, 21, 1));
    g.add(box(86, 2, 30, stone, 0, 1, 15));
    const logM = std('#2b1a10', 0.9);
    g.add(cyl(2.6, 2.6, 30, logM, 0, 5, 8).rotateZ(Math.PI / 2));
    g.add(cyl(2.2, 2.2, 26, logM, 0, 8.5, 10).rotateZ(Math.PI / 2).rotateX(0.3));
    const ember = new THREE.Mesh(new THREE.BoxGeometry(26, 2, 8), new THREE.MeshBasicMaterial({ color: '#ff5a1a' }));
    ember.position.set(0, 3, 8); g.add(ember);
    const flameTex = canvasTexture(128, 256, function (c, w, h) {
      const gr = c.createRadialGradient(64, 200, 4, 64, 150, 120);
      gr.addColorStop(0, 'rgba(255,245,200,1)'); gr.addColorStop(0.3, 'rgba(255,170,50,0.9)');
      gr.addColorStop(0.7, 'rgba(255,80,20,0.35)'); gr.addColorStop(1, 'rgba(255,60,10,0)');
      c.fillStyle = gr; c.beginPath(); c.ellipse(64, 150, 52, 110, 0, 0, 6.2832); c.fill();
    });
    const flames = [];
    for (let i = 0; i < 5; i++) {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(14, 26),
        new THREE.MeshBasicMaterial({ map: flameTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      f.position.set(-10 + i * 5, 16, 7 + (i % 2) * 3);
      g.add(f); flames.push(f);
    }
    ctx.onUpdate(function (dt, t) {
      flames.forEach(function (f, i) {
        const s = 0.8 + 0.25 * Math.sin(t * (7 + i * 1.7) + i) + 0.12 * Math.sin(t * 23 + i * 4);
        f.scale.set(0.9 + 0.2 * Math.sin(t * 5 + i * 2), s, 1);
        f.position.y = 6 + 13 * s;
      });
    });
    // 壁炉上方的画和烛台
    g.add(box(46, 56, 2, std('#b08a45', 0.4, { metalness: 0.7 }), 0, 108, 1.2));
    const art = new THREE.Mesh(new THREE.PlaneGeometry(40, 50), std('#ffffff', 0.8, { map: artTexture(77, '#1b2430') }));
    art.position.set(0, 108, 2.3); g.add(art);
    [-34, 34].forEach(function (x) {
      g.add(cyl(0.8, 2.2, 9, std('#b08a45', 0.35, { metalness: 0.8 }), x, 71.5, 12));
      g.add(cyl(0.7, 0.7, 7, std('#f1e6cf', 0.6), x, 79.5, 12));
      const fl = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 8), new THREE.MeshBasicMaterial({ color: '#ffd27a' }));
      fl.position.set(x, 84, 12); fl.scale.y = 1.8; g.add(fl);
    });
  },

  frames(ctx, it) {
    const g = wallGroup(ctx, it.wall);
    [[-70, 96, 40, 50, 3, '#e9e2d0'], [0, 100, 56, 70, 12, '#10202c'], [72, 94, 40, 50, 29, '#e9e2d0']].forEach(function (f) {
      g.add(box(f[2] + 6, f[3] + 6, 2, std('#3a2010', 0.5), f[0], f[1], 1.2));
      const art = new THREE.Mesh(new THREE.PlaneGeometry(f[2], f[3]), std('#ffffff', 0.85, { map: artTexture(f[4], f[5]) }));
      art.position.set(f[0], f[1], 2.3); g.add(art);
    });
  },

  pendant(ctx, it) {
    const g = new THREE.Group();
    const top = ctx.floorY + ctx.height;
    const metal = std(it.metal, 0.35, { metalness: 0.85 });
    g.add(cyl(0.25, 0.25, top - it.height - 8, std('#111111', 0.8), 0, (top + it.height + 8) / 2, 0, 8));
    g.add(cyl(1.6, 2.4, 3, metal, 0, it.height + 8, 0));
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(3, 15, 9, 48, 1, true), std(it.shade, 0.35, { side: THREE.FrontSide }));
    shade.position.y = it.height + 3; g.add(shade);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 14.8, 9, 48, 1, true), new THREE.MeshBasicMaterial({ color: '#fff0cf', side: THREE.BackSide }));
    inner.position.y = it.height + 3; g.add(inner);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(15, 0.3, 8, 48), metal);
    rim.rotation.x = Math.PI / 2; rim.position.y = it.height - 1.5; g.add(rim);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 16), new THREE.MeshBasicMaterial({ color: '#fff6dd' }));
    bulb.position.y = it.height + 1; g.add(bulb);
    ctx.group.add(g);
    // 镜头升到灯罩上方时把灯藏起来，免得挡住棋盘
    ctx.onUpdate(function (dt, t, camera) { g.visible = camera.position.y < it.height - 6; });
  },

  chairs(ctx, it) {
    const leather = std('#ffffff', 0.5, { map: noiseTexture(it.color, 0.05) });
    const wood = std(it.wood, 0.6);
    const seatY = ctx.floorY + 21;
    SIDES.forEach(function (s) {
      const g = new THREE.Group();
      g.add(box(24, 6, 22, leather, 0, seatY, 0));
      g.add(box(22, 5, 20, leather, 0, seatY + 3, -0.5));
      g.add(box(26, 23, 5, leather, 0, seatY + 9, 12.5));
      g.add(cyl(2.6, 2.6, 26, leather, 0, seatY + 20.5, 12.5, 16).rotateZ(Math.PI / 2));
      g.add(box(4, 10, 24, leather, -13, seatY + 5, 1));
      g.add(box(4, 10, 24, leather, 13, seatY + 5, 1));
      [[-10, -9], [10, -9], [-10, 11], [10, 11]].forEach(function (p) {
        g.add(box(2.6, 18, 2.6, wood, p[0], ctx.floorY + 9, p[1]));
      });
      const d = ctx.tableReach + 19;
      g.position.set(s.x * d, 0, s.z * d);
      g.rotation.y = Math.atan2(-s.x, -s.z) + Math.PI;
      shadow(g, true, true);
      ctx.group.add(g);
    });
  },

  cushions(ctx, it) {
    const fabric = std('#ffffff', 0.95, { map: noiseTexture(it.color, 0.08, { repeat: [2, 2] }) });
    SIDES.forEach(function (s) {
      const d = ctx.tableReach + 24;
      const m = box(28, 3.4, 28, fabric, s.x * d, ctx.floorY + 1.7, s.z * d);
      m.castShadow = true; m.receiveShadow = true;
      ctx.group.add(m);
    });
  },

  floorLamp(ctx, it) {
    const g = new THREE.Group();
    const metal = std('#b08a45', 0.4, { metalness: 0.8 });
    g.add(cyl(8, 9, 1.5, metal, 0, 0.75, 0));
    g.add(cyl(0.7, 0.7, 78, metal, 0, 39, 0, 10));
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(8, 12, 14, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: it.color, side: THREE.DoubleSide }));
    shade.position.y = 82; g.add(shade);
    g.position.set(it.position[0], ctx.floorY, it.position[1]);
    ctx.group.add(g);
  },

  plant(ctx, it) {
    const g = new THREE.Group();
    g.add(cyl(10, 7.5, 16, std(it.pot, 0.8), 0, 8, 0));
    const leaf = std('#234a2a', 0.7);
    const rnd = mulberry(63);
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), leaf);
      const a = rnd() * 6.28, r = 3 + rnd() * 9, h = 24 + rnd() * 36;
      m.scale.set(4 + rnd() * 3, 9 + rnd() * 8, 1.2);
      m.position.set(Math.cos(a) * r, h, Math.sin(a) * r);
      m.rotation.set((rnd() - 0.5) * 0.9, a, (rnd() - 0.5) * 0.9);
      g.add(m);
    }
    g.position.set(it.position[0], ctx.floorY, it.position[1]);
    ctx.group.add(g);
  },

  moonWindow(ctx, it) {
    const g = wallGroup(ctx, it.wall);
    const y = 74, r = it.radius;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 64), new THREE.MeshBasicMaterial({ map: gardenView() }));
    disc.position.set(it.x, y, 0.6); g.add(disc);
    const wood = std('#4a321e', 0.6);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 2.4, 10, 72), wood);
    ring.position.set(it.x, y, 1.5); g.add(ring);
    [-0.36, 0.36].forEach(function (f) {
      const len = 2 * Math.sqrt(r * r - (f * r) * (f * r));
      g.add(box(1.4, len, 1.4, wood, it.x + f * r, y, 1.5));
      g.add(box(len, 1.4, 1.4, wood, it.x, y + f * r, 1.5));
    });
    g.add(box(r * 2 + 30, 3, 12, wood, it.x, y - r - 6, 6));
  },

  alcove(ctx, it) {
    const g = wallGroup(ctx, it.wall);
    const wood = std('#ffffff', 0.6, { map: woodTexture('#6a4a2c', '#3c2814', { seed: 5 }) });
    g.add(box(84, 6, 34, wood, it.x, 3, 17));
    g.add(box(84, 110, 1, std('#c9bda0', 0.95), it.x, 61, 0.8));
    const scroll = new THREE.Mesh(new THREE.PlaneGeometry(26, 78), std('#ffffff', 0.9, { map: scrollTexture() }));
    scroll.position.set(it.x - 12, 68, 1.6); g.add(scroll);
    g.add(cyl(1, 1, 30, std('#3c2814', 0.6), it.x - 12, 28.5, 2, 10).rotateZ(Math.PI / 2));
    // 花器和枝条
    g.add(cyl(3.2, 4.6, 13, std('#2b3440', 0.35), it.x + 20, 12.5, 18));
    const rnd = mulberry(90);
    const branch = std('#3a2a22', 0.8), bloom = std('#ffd0dc', 0.6, { emissive: '#ff9fb8', emissiveIntensity: 0.15 });
    for (let i = 0; i < 4; i++) {
      const len = 22 + rnd() * 16;
      const b = cyl(0.25, 0.45, len, branch, 0, len / 2, 0, 6);
      const piv = new THREE.Group(); piv.add(b);
      piv.position.set(it.x + 20, 18, 18);
      piv.rotation.set((rnd() - 0.5) * 0.7, rnd() * 6.28, (rnd() - 0.5) * 0.9);
      for (let k = 0; k < 9; k++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.9 + rnd() * 0.6, 8, 6), bloom);
        s.position.set((rnd() - 0.5) * 3, len * (0.3 + rnd() * 0.7), (rnd() - 0.5) * 3);
        piv.add(s);
      }
      g.add(piv);
    }
  },

  shoji(ctx, it) {
    const g = wallGroup(ctx, it.wall);
    const W = ctx.half * 2 - 12, H = 112;
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(W, H),
      new THREE.MeshStandardMaterial({ color: '#f6efdc', emissive: '#fff3d6', emissiveIntensity: 0.55, roughness: 1 }));
    paper.position.set(0, H / 2 + 2, 1.2); g.add(paper);
    const bars = [];
    for (let x = -W / 2; x <= W / 2 + 0.1; x += W / 24) bars.push([x, H / 2 + 2, (Math.round((x + W / 2) / (W / 24)) % 4 === 0) ? 2.6 : 0.9, H]);
    for (let y = 2; y <= H + 2.1; y += H / 6) bars.push([0, y, W, (y < 3 || y > H) ? 3 : 0.9]);
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), std('#5a3d24', 0.7), bars.length);
    const m4 = new THREE.Matrix4();
    bars.forEach(function (b, i) {
      m4.compose(new THREE.Vector3(b[0], b[1], 1.8), new THREE.Quaternion(), new THREE.Vector3(b[2], b[3], 1.4));
      inst.setMatrixAt(i, m4);
    });
    g.add(inst);
  },

  lantern(ctx, it) {
    const g = new THREE.Group();
    const wood = std('#2e2018', 0.7);
    const paper = new THREE.MeshBasicMaterial({ color: '#ffe2ae' });
    g.add(box(11, 24, 11, paper, 0, 16, 0));
    [[-6, -6], [6, -6], [-6, 6], [6, 6]].forEach(function (p) { g.add(box(1.4, 32, 1.4, wood, p[0], 16, p[1])); });
    g.add(box(14, 1.4, 14, wood, 0, 3.5, 0));
    g.add(box(14, 1.4, 14, wood, 0, 28.5, 0));
    g.add(box(16, 1.2, 16, wood, 0, 32, 0));
    g.position.set(it.position[0], ctx.floorY, it.position[1]);
    ctx.group.add(g);
  },

  teaTray(ctx, it) {
    const g = new THREE.Group();
    g.add(box(34, 1.6, 22, std('#ffffff', 0.5, { map: woodTexture('#5a321c', '#2c170b', { seed: 2 }) }), 0, 0.8, 0));
    const iron = std('#1c1f24', 0.55, { metalness: 0.4 });
    const pot = new THREE.Mesh(new THREE.SphereGeometry(5.2, 24, 16), iron);
    pot.scale.y = 0.78; pot.position.set(-7, 5.6, 0); g.add(pot);
    g.add(cyl(1.2, 1.2, 1.4, iron, -7, 10, 0));
    const spout = cyl(0.6, 1, 5, iron, -1.2, 6.6, 0, 10); spout.rotation.z = -0.9; g.add(spout);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.4, 8, 24, Math.PI), iron);
    handle.position.set(-7, 8.6, 0); g.add(handle);
    const cup = std('#e9efe6', 0.4);
    [[7, -4], [11, 5]].forEach(function (p) {
      g.add(cyl(2.4, 1.7, 3.2, cup, p[0], 3.2, p[1], 20));
      g.add(cyl(2.1, 2.1, 0.2, std('#8fa04c', 0.3), p[0], 4.5, p[1], 20));
    });
    g.position.set(it.position[0], ctx.floorY, it.position[1]);
    g.rotation.y = 0.5;
    shadow(g, true, true);
    ctx.group.add(g);
  },

  bonsai(ctx, it) {
    const g = new THREE.Group();
    const wood = std('#3c2814', 0.7);
    g.add(box(30, 16, 22, wood, 0, 8, 0));
    g.add(box(22, 5, 14, std('#35506a', 0.5), 0, 18.5, 0));
    const trunk = std('#4a3628', 0.9), leaf = std('#3d6b3a', 0.85);
    const t1 = cyl(1.2, 2, 12, trunk, -2, 26, 0, 8); t1.rotation.z = 0.35; g.add(t1);
    const t2 = cyl(0.8, 1.2, 12, trunk, -1, 35, 0, 8); t2.rotation.z = -0.6; g.add(t2);
    [[4, 41, 0, 8], [-7, 34, 2, 6], [9, 33, -2, 5], [0, 45, 1, 5]].forEach(function (b) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(b[3], 12, 8), leaf);
      m.scale.y = 0.5; m.position.set(b[0], b[1], b[2]); g.add(m);
    });
    g.position.set(it.position[0], ctx.floorY, it.position[1]);
    ctx.group.add(g);
  }
};

/* ================= 粒子 ================= */

function buildParticles(ctx, cfg) {
  const n = cfg.count, petals = cfg.type === 'petals';
  const pos = new Float32Array(n * 3), seed = new Float32Array(n);
  const rnd = mulberry(123);
  const R = petals ? 120 : 46, top = petals ? 90 : 62, bottom = petals ? ctx.floorY : 0;
  for (let i = 0; i < n; i++) {
    const a = rnd() * 6.28, r = Math.sqrt(rnd()) * R;
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = bottom + rnd() * (top - bottom); pos[i * 3 + 2] = Math.sin(a) * r;
    seed[i] = rnd() * 100;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: cfg.color, size: petals ? 1.7 : 0.4, map: glowSprite(), transparent: true, opacity: petals ? 0.9 : 0.4,
    depthWrite: false, blending: petals ? THREE.NormalBlending : THREE.AdditiveBlending, sizeAttenuation: true
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  ctx.group.add(pts);
  ctx.onUpdate(function (dt, t) {
    const fall = petals ? 3.2 : 0.35;
    for (let i = 0; i < n; i++) {
      const s = seed[i];
      pos[i * 3] += Math.sin(t * 0.5 + s) * dt * (petals ? 2.2 : 0.5);
      pos[i * 3 + 2] += Math.cos(t * 0.4 + s * 1.3) * dt * (petals ? 2.2 : 0.5);
      pos[i * 3 + 1] -= dt * fall * (0.6 + (s % 1) * 0.8);
      if (pos[i * 3 + 1] < bottom) pos[i * 3 + 1] = top;
    }
    geo.attributes.position.needsUpdate = true;
  });
}

/* ================= 入口 ================= */

/**
 * 按配置搭出一个环境。返回：
 *   group      放进场景的全部物体（房间、桌子、灯）
 *   update     每帧调用（火光、粒子等）
 *   dispose    换环境时释放
 *   tableReach 桌面中心到边缘的距离
 */
export function buildEnvironment(cfg) {
  const group = new THREE.Group();
  const updaters = [];
  const ctx = {
    cfg: cfg, group: group,
    floorY: TABLE_Y - cfg.table.height,
    half: 150, height: 160, tableReach: 34,
    onUpdate: function (fn) { updaters.push(fn); }
  };

  const hemi = cfg.hemisphere;
  group.add(new THREE.HemisphereLight(hemi.sky, hemi.ground, hemi.intensity));

  const k = cfg.key;
  let key;
  if (k.type === 'spot') {
    key = new THREE.SpotLight(k.color, k.intensity, 0, k.angle, k.penumbra, 0);
    key.shadow.camera.near = 8; key.shadow.camera.far = 140;
  } else {
    key = new THREE.DirectionalLight(k.color, k.intensity);
    const sc = key.shadow.camera;
    sc.left = -52; sc.right = 52; sc.top = 52; sc.bottom = -52; sc.near = 10; sc.far = 320;
  }
  key.position.set(k.position[0], k.position[1], k.position[2]);
  key.castShadow = true;
  key.userData.key = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  key.shadow.radius = 5;
  group.add(key); group.add(key.target);

  (cfg.fills || []).forEach(function (f, i) {
    const l = new THREE.PointLight(f.color, f.intensity, f.distance || 0, 1);
    l.position.set(f.position[0], f.position[1], f.position[2]);
    group.add(l);
    if (f.flicker) {
      updaters.push(function (dt, t) {
        l.intensity = f.intensity * (0.82 + 0.12 * Math.sin(t * 9 + i) + 0.08 * Math.sin(t * 23.7) + 0.06 * Math.sin(t * 41.3));
      });
    }
  });

  buildTable(ctx, cfg.table);
  (cfg.room || []).forEach(function (item) {
    const fn = PROPS[item.prop];
    if (fn) fn(ctx, item);
    else console.warn('unknown prop', item.prop);
  });
  // 天花板
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ctx.half * 2, ctx.half * 2), std(cfg.ceiling || (hemi.intensity > 0.8 ? '#cdb48c' : '#120d0a'), 0.95));
  ceil.rotation.x = Math.PI / 2; ceil.position.y = ctx.floorY + ctx.height;
  group.add(ceil);
  if (cfg.particles) buildParticles(ctx, cfg.particles);

  return {
    group: group,
    tableReach: ctx.tableReach,
    update: function (dt, t, camera) { for (let i = 0; i < updaters.length; i++) updaters[i](dt, t, camera); },
    dispose: function () {
      group.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        const m = o.material;
        if (m) (Array.isArray(m) ? m : [m]).forEach(function (mm) { if (mm.map) mm.map.dispose(); mm.dispose(); });
      });
    }
  };
}
