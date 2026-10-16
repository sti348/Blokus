/*
 * 角斗士棋立体模式的绘制（Canvas 2D，正交投影，无第三方依赖）。
 * 世界坐标 [x, y, z]，y 朝上；相机绕竖轴旋转 yaw、俯视角 pitch。
 * 方块按到相机的深度从远到近绘制，被相邻方块挡住的面不画。
 */
(function (root) {
  'use strict';

  var Engine = root.BlokusEngine;
  var EMPTY = Engine.EMPTY;

  var DEFAULT_CAM = { yaw: 0.62, pitch: 0.6 };
  var PITCH_MIN = 0.22, PITCH_MAX = 1.35;

  /* ---------- 颜色 ---------- */

  function parseColor(s) {
    s = String(s || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h.replace(/./g, function (c) { return c + c; });
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /rgba?\(([^)]+)\)/.exec(s);
    if (m) return m[1].split(',').slice(0, 3).map(function (v) { return parseFloat(v); });
    return [128, 128, 128];
  }

  function mix(c, target, t) {
    var a = parseColor(c), b = target === 'white' ? [255, 255, 255] : target === 'black' ? [0, 0, 0] : parseColor(target);
    return 'rgb(' + [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * t); }).join(',') + ')';
  }

  var shadeCache = {};
  function shades(color) {
    if (!shadeCache[color]) {
      shadeCache[color] = {
        top: mix(color, 'white', 0.2),
        nub: mix(color, 'white', 0.3),
        left: color,
        right: mix(color, 'black', 0.22),
        edge: mix(color, 'black', 0.38)
      };
    }
    return shadeCache[color];
  }

  /* ---------- 投影 ---------- */

  function clampPitch(p) { return Math.max(PITCH_MIN, Math.min(PITCH_MAX, p)); }

  // 视角无关的缩放：旋转时棋盘大小不变
  function layout(view, topo) {
    var cam = view.cam || (view.cam = { yaw: DEFAULT_CAM.yaw, pitch: DEFAULT_CAM.pitch });
    var W = topo.cols, D = topo.depth, H = topo.height, css = view.css;
    var pad = Math.max(8, css * 0.03);
    var r = Math.sqrt(W * W + D * D) / 2 + 0.35;
    var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    var k = Math.min((css - 2 * pad) / (2 * r), (css - 2 * pad) / (2 * r * sp + (H + 0.4) * cp));
    return {
      topo: topo,
      W: W, D: D, H: H,
      cx: W / 2, cz: D / 2,
      cyaw: Math.cos(cam.yaw), syaw: Math.sin(cam.yaw),
      cp: cp, sp: sp,
      k: k,
      ox: css / 2,
      oy: css / 2 + ((H * cp) / 2 - 0.15 * sp) * k
    };
  }

  function proj(L, x, y, z) {
    var dx = x - L.cx, dz = z - L.cz;
    var rx = dx * L.cyaw - dz * L.syaw;
    var rz = dx * L.syaw + dz * L.cyaw;
    return [L.ox + rx * L.k, L.oy + (-y * L.cp + rz * L.sp) * L.k];
  }

  function depthOf(L, x, y, z) {
    var dx = x - L.cx, dz = z - L.cz;
    return (dx * L.syaw + dz * L.cyaw) * L.cp + y * L.sp;
  }

  // 可见的侧面：x 方向取 sign(sin yaw)，z 方向取 sign(cos yaw)
  function sideFaces(L) {
    return { sx: L.syaw >= 0 ? 1 : -1, sz: L.cyaw >= 0 ? 1 : -1 };
  }

  function faceQuad(x, y, z, face) {
    switch (face) {
      case 'top': return [[x, y + 1, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]];
      case 'x+': return [[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]];
      case 'x-': return [[x, y, z], [x, y + 1, z], [x, y + 1, z + 1], [x, y, z + 1]];
      case 'z+': return [[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]];
      default: return [[x, y, z], [x + 1, y, z], [x + 1, y + 1, z], [x, y + 1, z]];
    }
  }

  // 侧面朝屏幕右边的那个画暗一些
  function faceTone(L, face) {
    if (face === 'top') return 'top';
    var rx = face === 'x+' ? L.cyaw : face === 'x-' ? -L.cyaw : face === 'z+' ? -L.syaw : L.syaw;
    return rx > 0 ? 'right' : 'left';
  }

  function pathPts(g, pts) {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
  }

  function coordOf(topo, i) {
    var W = topo.cols, D = topo.depth, layer = W * D;
    var y = Math.floor(i / layer), rem = i - y * layer;
    var z = Math.floor(rem / W);
    return [rem - z * W, y, z];
  }

  /* ---------- 方块 ---------- */

  function drawCube(g, L, c, color, opts) {
    opts = opts || {};
    var sh = shades(color);
    var vis = sideFaces(L);
    var faces = ['top', 'x' + (vis.sx > 0 ? '+' : '-'), 'z' + (vis.sz > 0 ? '+' : '-')];
    var x = c[0], y = c[1], z = c[2];
    var hide = opts.hide || {};
    g.globalAlpha = opts.alpha == null ? 1 : opts.alpha;
    g.lineJoin = 'round';
    for (var f = 0; f < faces.length; f++) {
      var face = faces[f];
      if (hide[face]) continue;
      var pts = faceQuad(x, y, z, face).map(function (p) { return proj(L, p[0], p[1], p[2]); });
      pathPts(g, pts);
      g.fillStyle = opts.tint || sh[faceTone(L, face)];
      g.fill();
      g.strokeStyle = opts.stroke || sh.edge;
      g.lineWidth = opts.strokeWidth || Math.max(0.6, L.k * 0.03);
      g.stroke();
      if (face === 'top' && !opts.tint && !opts.noNub) {
        // 顶面的小凸台：棋子的塑料质感
        var cx = x + 0.5, cz = z + 0.5, s = 0.2;
        pathPts(g, [[cx - s, cz - s], [cx + s, cz - s], [cx + s, cz + s], [cx - s, cz + s]].map(function (p) { return proj(L, p[0], y + 1, p[1]); }));
        g.fillStyle = sh.nub;
        g.fill();
      }
    }
    g.globalAlpha = 1;
  }

  /* ---------- 整体绘制 ---------- */

  function drawScene(view, state, ov, palette, now) {
    var g = view.ctx, topo = state.topo;
    var L = layout(view, topo);
    var W = L.W, D = L.D, H = L.H, layer = W * D;
    var board = state.board;
    g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    g.clearRect(0, 0, view.css, view.css);

    function colorOf(p) { return palette.colors[state.players[p].color] || palette.ink; }

    // 底座
    var slab = 0.32;
    var base = [[-0.25, -0.25], [W + 0.25, -0.25], [W + 0.25, D + 0.25], [-0.25, D + 0.25]];
    var vis = sideFaces(L);
    g.lineJoin = 'round';
    pathPts(g, base.map(function (p) { return proj(L, p[0], 0, p[1]); }));
    g.fillStyle = palette.frame;
    g.fill();
    [['x', vis.sx], ['z', vis.sz]].forEach(function (s) {
      var q;
      if (s[0] === 'x') {
        var xx = s[1] > 0 ? W + 0.25 : -0.25;
        q = [[xx, 0, -0.25], [xx, 0, D + 0.25], [xx, -slab, D + 0.25], [xx, -slab, -0.25]];
      } else {
        var zz = s[1] > 0 ? D + 0.25 : -0.25;
        q = [[-0.25, 0, zz], [W + 0.25, 0, zz], [W + 0.25, -slab, zz], [-0.25, -slab, zz]];
      }
      pathPts(g, q.map(function (p) { return proj(L, p[0], p[1], p[2]); }));
      g.fillStyle = mix(palette.frame, 'black', 0.18);
      g.fill();
    });
    // 地面格子
    pathPts(g, [[0, 0], [W, 0], [W, D], [0, D]].map(function (p) { return proj(L, p[0], 0, p[1]); }));
    g.fillStyle = palette.groove;
    g.fill();
    g.fillStyle = palette.cell;
    var inset = 0.07;
    for (var tz = 0; tz < D; tz++) {
      for (var tx = 0; tx < W; tx++) {
        pathPts(g, [[tx + inset, tz + inset], [tx + 1 - inset, tz + inset], [tx + 1 - inset, tz + 1 - inset], [tx + inset, tz + 1 - inset]]
          .map(function (p) { return proj(L, p[0], 0, p[1]); }));
        g.fill();
      }
    }
    // 起始角
    state.players.forEach(function (pl, p) {
      if (pl.placed > 0) return;
      pl.startIdx.forEach(function (i) {
        var c = coordOf(topo, i);
        if (board[i] !== EMPTY) return;
        var pts = [];
        for (var a = 0; a < 24; a++) {
          var t = a / 24 * Math.PI * 2;
          pts.push(proj(L, c[0] + 0.5 + Math.cos(t) * 0.3, 0.01, c[2] + 0.5 + Math.sin(t) * 0.3));
        }
        pathPts(g, pts);
        if (p === state.current && !state.over) {
          g.globalAlpha = 0.3;
          g.fillStyle = colorOf(p);
          g.fill();
          g.globalAlpha = 1;
        }
        g.strokeStyle = colorOf(p);
        g.lineWidth = Math.max(1.5, L.k * 0.07);
        g.stroke();
      });
    });
    // 限高框
    g.save();
    g.strokeStyle = palette.ink;
    g.globalAlpha = 0.16;
    g.lineWidth = 1;
    g.setLineDash([4, 4]);
    var top = [[0, 0], [W, 0], [W, D], [0, D]];
    pathPts(g, top.map(function (p) { return proj(L, p[0], H, p[1]); }));
    g.stroke();
    top.forEach(function (p) {
      var a = proj(L, p[0], 0, p[1]), b = proj(L, p[0], H, p[1]);
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
    });
    g.restore();

    // 方块与标记按深度排序
    var anim = ov.anim, animSet = {}, animT = 1;
    if (anim) {
      animT = ov.dropMs ? Math.max(0, Math.min(1, (now - anim.t0) / ov.dropMs)) : 1;
      anim.cells.forEach(function (i) { animSet[i] = 1; });
    }
    var lastSet = {};
    (ov.lastMove || []).forEach(function (i) { lastSet[i] = 1; });

    // 透视：只显示到第 slice 层；X 光让所有方块半透明；挡住待放棋子的方块自动变淡
    var slice = ov.slice != null ? Math.max(1, Math.min(H, ov.slice)) : H;
    var xray = !!ov.xray;
    var fade = fadeSet(L, topo, board, [ov.ghost, ov.remote]);
    function occ(i) {
      return board[i] !== EMPTY && !animSet[i] && !fade[i] && Math.floor(i / layer) < slice && !xray;
    }

    var items = [];
    for (var i = 0; i < board.length; i++) {
      if (board[i] < 0 || animSet[i]) continue;
      var c = coordOf(topo, i);
      items.push({ d: depthOf(L, c[0] + 0.5, c[1] + 0.5, c[2] + 0.5), kind: 'cube', i: i, c: c });
    }
    if (anim) {
      var ease = 1 - Math.pow(1 - animT, 3);
      anim.cells.forEach(function (i) {
        var c = coordOf(topo, i);
        var cc = [c[0], c[1] + (1 - ease) * 2.2, c[2]];
        items.push({ d: depthOf(L, cc[0] + 0.5, cc[1] + 0.5, cc[2] + 0.5), kind: 'anim', c: cc, player: anim.player, alpha: 0.4 + 0.6 * ease });
      });
    }
    if (ov.anchors) {
      ov.anchors.list.forEach(function (i) {
        var c = coordOf(topo, i);
        if (c[1] > slice) return;
        items.push({ d: depthOf(L, c[0] + 0.5, c[1], c[2] + 0.5) + 0.001, kind: 'dot', c: c });
      });
    }
    items.sort(function (a, b) { return a.d - b.d; });
    var faceX = 'x' + (vis.sx > 0 ? '+' : '-'), faceZ = 'z' + (vis.sz > 0 ? '+' : '-');
    items.forEach(function (it) {
      if (it.kind === 'dot') {
        var p = proj(L, it.c[0] + 0.5, it.c[1] + 0.02, it.c[2] + 0.5);
        g.beginPath();
        g.ellipse(p[0], p[1], L.k * 0.13, L.k * 0.13 * L.sp, 0, 0, Math.PI * 2);
        g.fillStyle = ov.anchors.color;
        g.globalAlpha = 0.7;
        g.fill();
        g.globalAlpha = 1;
        return;
      }
      if (it.kind === 'anim') {
        drawCube(g, L, it.c, colorOf(it.player), { alpha: it.alpha });
        return;
      }
      var x = it.c[0], y = it.c[1], z = it.c[2];
      var color = colorOf(board[it.i]);
      if (y >= slice) {
        // 被切掉的楼层只留一点影子，提醒上面还有东西
        drawCube(g, L, it.c, color, { alpha: 0.07, noNub: true });
        return;
      }
      var hide = {};
      if (y + 1 < H && occ(it.i + layer)) hide.top = true;
      var nx = x + vis.sx, nz = z + vis.sz;
      if (nx >= 0 && nx < W && occ(it.i + vis.sx)) hide[faceX] = true;
      if (nz >= 0 && nz < D && occ(it.i + vis.sz * W)) hide[faceZ] = true;
      var opts = { hide: hide };
      if (fade[it.i]) {
        opts.alpha = 0.2;
        opts.noNub = true;
      } else if (xray) {
        opts.alpha = 0.34;
        opts.stroke = shades(color).edge;
        opts.strokeWidth = Math.max(1, L.k * 0.045);
      }
      if (lastSet[it.i]) {
        opts.stroke = palette.ink;
        opts.strokeWidth = Math.max(1.4, L.k * 0.06);
      }
      drawCube(g, L, it.c, color, opts);
    });

    // 提示：虚线框
    if (ov.hint) {
      g.save();
      g.globalAlpha = ov.pulse == null ? 1 : ov.pulse;
      g.setLineDash([L.k * 0.18, L.k * 0.12]);
      g.strokeStyle = ov.hint.color;
      g.lineWidth = Math.max(1.6, L.k * 0.07);
      ov.hint.cells.forEach(function (c) {
        ['top', faceX, faceZ].forEach(function (face) {
          pathPts(g, faceQuad(c[0], c[1], c[2], face).map(function (p) { return proj(L, p[0], p[1], p[2]); }));
          g.stroke();
        });
      });
      g.restore();
    }

    // 其他玩家正在尝试的位置（联机）
    if (ov.remote) drawGhost(g, L, ov.remote, palette, true);
    // 自己待放置的棋子：半透明，始终画在最上层
    if (ov.ghost) drawGhost(g, L, ov.ghost, palette, false);
  }

  function sortByDepth(L, cells) {
    return cells.slice().sort(function (a, b) {
      return depthOf(L, a[0] + 0.5, a[1] + 0.5, a[2] + 0.5) - depthOf(L, b[0] + 0.5, b[1] + 0.5, b[2] + 0.5);
    });
  }

  function drawGhost(g, L, gh, palette, remote) {
    // 落点下方的投影
    if (gh.shadow) {
      g.globalAlpha = remote ? 0.14 : 0.22;
      g.fillStyle = gh.valid ? gh.color : palette.danger;
      gh.shadow.forEach(function (s) {
        pathPts(g, [[s[0], s[2]], [s[0] + 1, s[2]], [s[0] + 1, s[2] + 1], [s[0], s[2] + 1]].map(function (p) { return proj(L, p[0], s[1] + 0.01, p[1]); }));
        g.fill();
      });
      g.globalAlpha = 1;
    }
    g.save();
    if (remote) g.setLineDash([L.k * 0.16, L.k * 0.1]);
    sortByDepth(L, gh.cells).forEach(function (c) {
      drawCube(g, L, c, gh.color, {
        alpha: remote ? 0.5 : gh.valid ? 0.78 : 0.5,
        tint: gh.valid ? null : mix(palette.danger, 'white', 0.25),
        stroke: remote ? gh.color : gh.valid ? palette.ink : palette.danger,
        strokeWidth: Math.max(1.2, L.k * (remote ? 0.06 : 0.05)),
        noNub: remote
      });
    });
    g.restore();
  }

  // 屏幕上挡在待放棋子前面的方块
  function fadeSet(L, topo, board, ghosts) {
    var out = {};
    var boxes = [];
    ghosts.forEach(function (gh) {
      if (!gh || !gh.cells.length) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minD = Infinity;
      gh.cells.forEach(function (c) {
        cubeCorners(c).forEach(function (q) {
          var p = proj(L, q[0], q[1], q[2]);
          if (p[0] < minX) minX = p[0];
          if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1];
          if (p[1] > maxY) maxY = p[1];
        });
        minD = Math.min(minD, depthOf(L, c[0] + 0.5, c[1] + 0.5, c[2] + 0.5));
      });
      boxes.push({ minX: minX, minY: minY, maxX: maxX, maxY: maxY, d: minD });
    });
    if (!boxes.length) return out;
    for (var i = 0; i < board.length; i++) {
      if (board[i] < 0) continue;
      var c = coordOf(topo, i);
      var d = depthOf(L, c[0] + 0.5, c[1] + 0.5, c[2] + 0.5);
      var center = proj(L, c[0] + 0.5, c[1] + 0.5, c[2] + 0.5);
      var r = L.k * 0.9;
      for (var b = 0; b < boxes.length; b++) {
        var bx = boxes[b];
        if (d > bx.d + 0.01 && center[0] + r > bx.minX && center[0] - r < bx.maxX && center[1] + r > bx.minY && center[1] - r < bx.maxY) {
          out[i] = 1;
          break;
        }
      }
    }
    return out;
  }

  function cubeCorners(c) {
    var out = [];
    for (var k = 0; k < 8; k++) out.push([c[0] + (k & 1), c[1] + ((k >> 1) & 1), c[2] + ((k >> 2) & 1)]);
    return out;
  }

  /* ---------- 拾取：鼠标所指的那一列 ---------- */

  function pointIn(px, py, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function pick(view, state, clientX, clientY) {
    var r = view.canvas.getBoundingClientRect();
    var px = clientX - r.left, py = clientY - r.top;
    if (px < 0 || py < 0 || px > r.width || py > r.height) return null;
    var topo = state.topo, L = layout(view, topo);
    var hm = Engine.heightMap(state.board, topo);
    var vis = sideFaces(L);
    var best = null, bestD = -Infinity;
    for (var z = 0; z < L.D; z++) {
      for (var x = 0; x < L.W; x++) {
        var h = hm[z * L.W + x];
        var quads = [faceQuad(x, h - 1, z, 'top')];
        if (h > 0) {
          // 整列的两个可见侧面：指着塔身也算选中这一列
          var xx = vis.sx > 0 ? x + 1 : x, zz = vis.sz > 0 ? z + 1 : z;
          quads.push([[xx, 0, z], [xx, h, z], [xx, h, z + 1], [xx, 0, z + 1]]);
          quads.push([[x, 0, zz], [x + 1, 0, zz], [x + 1, h, zz], [x, h, zz]]);
        }
        for (var q = 0; q < quads.length; q++) {
          var pts = quads[q].map(function (p) { return proj(L, p[0], p[1], p[2]); });
          if (pointIn(px, py, pts)) {
            var d = depthOf(L, x + 0.5, h, z + 0.5);
            if (d > bestD) { bestD = d; best = { x: x, z: z }; }
            break;
          }
        }
      }
    }
    return best;
  }

  // 屏幕方向 → 世界坐标的格子步进（方向键随视角变化）
  function screenStep(view, dir) {
    var cam = view.cam || DEFAULT_CAM;
    var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    var right = Math.abs(cy) >= Math.abs(sy) ? [cy > 0 ? 1 : -1, 0] : [0, sy > 0 ? -1 : 1];
    var down = Math.abs(cy) >= Math.abs(sy) ? [0, cy > 0 ? 1 : -1] : [sy > 0 ? 1 : -1, 0];
    if (dir === 'right') return right;
    if (dir === 'left') return [-right[0], -right[1]];
    if (dir === 'down') return down;
    return [-down[0], -down[1]];
  }

  // 与屏幕水平方向最接近的世界轴（向前翻用）和另一条水平轴（侧翻用）
  function screenAxes(view) {
    var cam = view.cam || DEFAULT_CAM;
    var horizX = Math.abs(Math.cos(cam.yaw)) >= Math.abs(Math.sin(cam.yaw));
    return { tip: horizX ? 0 : 2, roll: horizX ? 2 : 0 };
  }

  /* ---------- 托盘图标（SVG） ---------- */

  function fmt(pts) { return pts.map(function (p) { return p[0].toFixed(3) + ',' + p[1].toFixed(3); }).join(' '); }

  function pieceSVG(orient, cam, box) {
    cam = cam || DEFAULT_CAM;
    var L = {
      cx: orient.w / 2, cz: orient.d / 2,
      cyaw: Math.cos(cam.yaw), syaw: Math.sin(cam.yaw),
      cp: Math.cos(cam.pitch), sp: Math.sin(cam.pitch),
      k: 1, ox: 0, oy: 0
    };
    var vis = sideFaces(L);
    var has = {};
    orient.cells.forEach(function (c) { has[c.join(',')] = 1; });
    var cells = orient.cells.slice().sort(function (a, b) {
      return depthOf(L, a[0] + 0.5, a[1] + 0.5, a[2] + 0.5) - depthOf(L, b[0] + 0.5, b[1] + 0.5, b[2] + 0.5);
    });
    var polys = [];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    cells.forEach(function (c) {
      var faces = [['top', [0, 1, 0]], ['x' + (vis.sx > 0 ? '+' : '-'), [vis.sx, 0, 0]], ['z' + (vis.sz > 0 ? '+' : '-'), [0, 0, vis.sz]]];
      faces.forEach(function (f) {
        var n = f[1];
        if (has[[c[0] + n[0], c[1] + n[1], c[2] + n[2]].join(',')]) return;
        var pts = faceQuad(c[0], c[1], c[2], f[0]).map(function (p) { return proj(L, p[0], p[1], p[2]); });
        pts.forEach(function (p) {
          minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
          minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
        });
        polys.push({ pts: pts, tone: faceTone(L, f[0]) });
      });
    });
    var B = Math.max(box || 4.2, maxX - minX + 0.2, maxY - minY + 0.2);
    var ox = (minX + maxX) / 2 - B / 2, oy = (minY + maxY) / 2 - B / 2;
    var out = '<svg viewBox="' + [ox, oy, B, B].map(function (v) { return v.toFixed(3); }).join(' ') + '" aria-hidden="true">';
    polys.forEach(function (p) {
      out += '<polygon points="' + fmt(p.pts) + '" style="fill:var(--c)" stroke="#000" stroke-opacity=".28" stroke-width=".05" stroke-linejoin="round"/>';
      if (p.tone === 'top') out += '<polygon points="' + fmt(p.pts) + '" fill="#fff" fill-opacity=".3"/>';
      else if (p.tone === 'right') out += '<polygon points="' + fmt(p.pts) + '" fill="#000" fill-opacity=".24"/>';
    });
    return out + '</svg>';
  }

  root.BlokusView3D = {
    DEFAULT_CAM: DEFAULT_CAM,
    clampPitch: clampPitch,
    layout: layout,
    draw: drawScene,
    pick: pick,
    screenStep: screenStep,
    screenAxes: screenAxes,
    pieceSVG: pieceSVG,
    coordOf: coordOf
  };
})(typeof self !== 'undefined' ? self : this);
