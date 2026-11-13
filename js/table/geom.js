/*
 * 三维牌桌的几何（不依赖 DOM / Three.js，Node 里可测试），适用于全部棋盘：
 *   - 棋盘上每个格子在牌桌上的位置和形状（方格、三角格、六边形、立方体、三棱柱）
 *   - 各座位坐在哪个方向、面前的棋子怎么摆
 *   - 手里的棋子转一下、左右镜像、向前翻、侧翻之后对应引擎里的哪个朝向（按真实的几何变换匹配）
 *
 * 牌桌局部坐标：棋盘中心在原点，x 向右、z 向下（与平面棋盘的 x、y 相同），y 向上；一格约 1 个单位。
 * 座位方位角 az：座位在 (sin az, cos az) 方向，镜头从那里看向棋盘中心。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../pieces.js'));
  else root.BlokusTableGeom = factory(root.BlokusPieces);
})(typeof self !== 'undefined' ? self : this, function (Pieces) {
  'use strict';

  var H3 = Math.sqrt(3) / 2;
  var LAYER = { cube: 1, prism: 0.8 };
  var FLAT_H = 0.42;

  function centroid(poly) {
    var x = 0, z = 0;
    poly.forEach(function (p) { x += p[0]; z += p[1]; });
    return [x / poly.length, z / poly.length];
  }

  // 立体棋盘一列的地面多边形（未居中）
  function columnPoly(kind, x, z) {
    if (kind === 'prism') return Pieces.triVerts(x, z).map(function (v) { return [v[0] * 0.5, v[1] * H3]; });
    return [[x, z], [x + 1, z], [x + 1, z + 1], [x, z + 1]];
  }

  function coordOf(topo, i) {
    var W = topo.cols, D = topo.depth, layer = W * D;
    var y = Math.floor(i / layer), rem = i - y * layer;
    var z = Math.floor(rem / W);
    return [rem - z * W, y, z];
  }

  /**
   * 棋盘的几何。返回：
   *   dims, kind, layerH（立体的层高）, pieceH（平面棋子的厚度）
   *   cellPoly(i)   平面：格子的多边形 [[x, z], ...]；立体：所在列的地面多边形
   *   cellCenter(i) [x, y, z]：平面 y 为棋子中心高度；立体为方块中心
   *   cells         有效格子的编号
   *   columns       立体：有效列 [{ x, z, poly }]
   *   outline       棋盘外轮廓（平面：引擎给的轮廓；立体：各列合起来的外框）
   *   radius        中心到最远格子顶点的距离
   */
  function boardOf(state) {
    var topo = state.topo;
    if (topo.dims === 3) return board3D(state);
    var ux = topo.unitX || 1, uy = topo.unitY || 1;
    var minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    topo.cells.forEach(function (i) {
      topo.polys[i].forEach(function (p) {
        var x = p[0] * ux, z = p[1] * uy;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      });
    });
    var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    var polys = {};
    function cellPoly(i) {
      return polys[i] || (polys[i] = topo.polys[i].map(function (p) { return [p[0] * ux - cx, p[1] * uy - cz]; }));
    }
    var radius = 0;
    topo.cells.forEach(function (i) {
      cellPoly(i).forEach(function (p) { radius = Math.max(radius, Math.hypot(p[0], p[1])); });
    });
    return {
      dims: 2, kind: topo.kind, layerH: 0, pieceH: FLAT_H,
      cells: topo.cells,
      cellPoly: cellPoly,
      cellCenter: function (i) { var c = centroid(cellPoly(i)); return [c[0], FLAT_H / 2, c[1]]; },
      outline: topo.outline.map(function (p) { return [p[0] * ux - cx, p[1] * uy - cz]; }),
      width: maxX - minX, depth: maxZ - minZ,
      radius: radius,
      offset: [cx, cz]
    };
  }

  function board3D(state) {
    var topo = state.topo, kind = topo.kind, LH = LAYER[kind] || 1;
    var cols = [];
    var minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (var z = 0; z < topo.depth; z++) {
      for (var x = 0; x < topo.cols; x++) {
        if (topo.colValid && !topo.colValid[x + topo.cols * z]) continue;
        var poly = columnPoly(kind, x, z);
        poly.forEach(function (p) {
          if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
          if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
        });
        cols.push({ x: x, z: z, poly: poly });
      }
    }
    var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    cols.forEach(function (c) { c.poly = c.poly.map(function (p) { return [p[0] - cx, p[1] - cz]; }); c.center = centroid(c.poly); });
    var byKey = {};
    cols.forEach(function (c) { byKey[c.x + ',' + c.z] = c; });
    var radius = 0;
    cols.forEach(function (c) { c.poly.forEach(function (p) { radius = Math.max(radius, Math.hypot(p[0], p[1])); }); });
    function col(x, z) {
      return byKey[x + ',' + z] || { poly: columnPoly(kind, x, z).map(function (p) { return [p[0] - cx, p[1] - cz]; }) };
    }
    return {
      dims: 3, kind: kind, layerH: LH, pieceH: LH, height: topo.height,
      cells: topo.cells,
      columns: cols,
      column: col,
      cellPoly: function (i) { var c = coordOf(topo, i); return col(c[0], c[2]).poly; },
      cellCenter: function (i) {
        var c = coordOf(topo, i), p = centroid(col(c[0], c[2]).poly);
        return [p[0], (c[1] + 0.5) * LH, p[1]];
      },
      coordOf: function (i) { return coordOf(topo, i); },
      outline: [[minX - cx, minZ - cz], [maxX - cx, minZ - cz], [maxX - cx, maxZ - cz], [minX - cx, maxZ - cz]],
      width: maxX - minX, depth: maxZ - minZ,
      radius: radius,
      offset: [cx, cz]
    };
  }

  /* ================= 棋子的形状 ================= */

  /**
   * 一个朝向下各格的形状，以各格中心的平均点为原点：
   *   [{ poly: [[x, z], ...], y: 底面高度（立体为层号 × 层高；平面为 0）, c: [x, y, z] 中心 }]
   */
  function orientShape(set, pieceIndex, orient) {
    var piece = set.pieces[pieceIndex];
    var cache = piece._tableShapes || (piece._tableShapes = {});
    if (cache[orient]) return cache[orient];
    var o = piece.orients[orient];
    var cells;
    if (set.dims === 3) {
      var kind = set.kind, LH = LAYER[kind] || 1;
      cells = o.cells.map(function (c) {
        var poly = columnPoly(kind, c[0], c[2]);
        var m = centroid(poly);
        return { poly: poly, y: c[1] * LH, c: [m[0], (c[1] + 0.5) * LH, m[1]] };
      });
    } else {
      cells = o.polys.map(function (poly) {
        var m = centroid(poly);
        return { poly: poly.map(function (p) { return [p[0], p[1]]; }), y: 0, c: [m[0], FLAT_H / 2, m[1]] };
      });
    }
    var mx = 0, my = 0, mz = 0;
    cells.forEach(function (k) { mx += k.c[0]; my += k.c[1]; mz += k.c[2]; });
    mx /= cells.length; my /= cells.length; mz /= cells.length;
    var out = cells.map(function (k) {
      return {
        poly: k.poly.map(function (p) { return [p[0] - mx, p[1] - mz]; }),
        y: k.y - my,
        c: [k.c[0] - mx, k.c[1] - my, k.c[2] - mz]
      };
    });
    out.center = [mx, my, mz];
    return (cache[orient] = out);
  }

  // 形状的特征点：各格中心和各格的顶点（在格子中心的高度上）。三角形尖朝上 / 朝下中心相同，要靠顶点区分
  // 立方体只看中心（各格都是正方体，向前翻 90° 后顶点不再在水平面上）
  function shapePoints(shape, centersOnly) {
    if (shape._pts) return shape._pts;
    var pts = [];
    shape.forEach(function (k) {
      pts.push(k.c);
      if (!centersOnly) k.poly.forEach(function (q) { pts.push([q[0], k.c[1], q[1]]); });
    });
    return (shape._pts = pts);
  }

  // 两组点是否相同（顺序不论，容差 0.001）
  function samePoints(a, b) {
    if (a.length !== b.length) return false;
    var used = [];
    for (var i = 0; i < a.length; i++) {
      var hit = -1;
      for (var j = 0; j < b.length; j++) {
        if (used[j]) continue;
        if (Math.abs(a[i][0] - b[j][0]) < 1e-3 && Math.abs(a[i][1] - b[j][1]) < 1e-3 && Math.abs(a[i][2] - b[j][2]) < 1e-3) { hit = j; break; }
      }
      if (hit < 0) return false;
      used[hit] = true;
    }
    return true;
  }

  /* ---------- 变换（作用在以棋子中心为原点的点 [x, y, z] 上） ---------- */

  // 绕竖轴转 a 弧度（从上往下看，a > 0 为逆时针）
  function rotY(a) {
    var c = Math.cos(a), s = Math.sin(a);
    return function (p) { return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
  }

  // 沿竖直平面镜像：平面包含竖轴和水平方向 d=(dx, dz)
  function mirror(dx, dz) {
    var l = Math.hypot(dx, dz); dx /= l; dz /= l;
    var nx = dz, nz = -dx;
    return function (p) {
      var k = 2 * (p[0] * nx + p[2] * nz);
      return [p[0] - k * nx, p[1], p[2] - k * nz];
    };
  }

  // 绕水平轴 (ax, 0, az) 转 a 弧度（右手定则）
  function rotAxis(ax, az, a) {
    var l = Math.hypot(ax, az); ax /= l; az /= l;
    var c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    return function (p) {
      var x = p[0], y = p[1], z = p[2];
      return [
        (t * ax * ax + c) * x + (-s * az) * y + (t * ax * az) * z,
        (s * az) * x + c * y + (-s * ax) * z,
        (t * ax * az) * x + (s * ax) * y + (t * az * az + c) * z
      ];
    };
  }

  /**
   * 手里的棋子做一次实体变换后对应的朝向；没有对应的朝向（规则不允许，如立体棋子不能镜像）时返回 -1。
   * op：'rotate'（dir = 1 顺时针、-1 逆时针，从上往下看）| 'mirror'（左右镜像）| 'tip'（向前翻）| 'roll'（侧翻）
   * az：拿着棋子的人的座位方位角（决定「左右」「前后」）
   * 返回 { orient, axis, angle }：axis / angle 描述这次变换对应的三维转动（用于动画；镜像为 null）
   */
  function turn(set, pieceIndex, orient, op, dir, az) {
    var piece = set.pieces[pieceIndex];
    var fwd = [-Math.sin(az), -Math.cos(az)];          // 从座位看向棋盘的方向
    var right = [Math.cos(az), -Math.sin(az)];
    var step = 2 * Math.PI / (set.dims === 3 ? (set.kind === 'prism' ? 6 : 4) : set.rotations);
    var f, axis = null, angle = 0;
    if (op === 'rotate') { angle = -dir * step; f = rotY(angle); axis = [0, 1, 0]; }
    else if (op === 'mirror') f = mirror(fwd[0], fwd[1]);
    else if (op === 'tip') {
      angle = (set.kind === 'prism' ? Math.PI : Math.PI / 2) * (dir || 1);
      f = rotAxis(right[0], right[1], angle); axis = [right[0], 0, right[1]];
    } else if (op === 'roll') {
      angle = Math.PI / 2 * (dir || 1);
      f = rotAxis(fwd[0], fwd[1], angle); axis = [fwd[0], 0, fwd[1]];
    } else return { orient: -1 };
    var cubeOnly = set.kind === 'cube';
    var target = shapePoints(orientShape(set, pieceIndex, orient), cubeOnly).map(f);
    for (var i = 0; i < piece.orients.length; i++) {
      if (samePoints(shapePoints(orientShape(set, pieceIndex, i), cubeOnly), target)) {
        return { orient: i, axis: axis, angle: angle };
      }
    }
    return { orient: -1 };
  }

  /* ================= 座位 ================= */

  function normAngle(a) {
    a %= Math.PI * 2;
    if (a < 0) a += Math.PI * 2;
    return a;
  }

  /**
   * 各玩家的座位方位角。坐在自己起点的方向；方格棋盘坐到起点角旁边的那条边上（像真实的桌游那样）。
   * 起点在中间或大家共用起点时，按人数平均分布。角度取整到棋盘格子的对称方向，左右镜像才对得上格子。
   */
  function seatAngles(state, board) {
    board = board || boardOf(state);
    var topo = state.topo, n = state.players.length;
    var snap = topo.kind === 'square' || topo.kind === 'cube' ? Math.PI / 2 : Math.PI / 6;
    var ok = true;
    var raw = state.players.map(function (pl) {
      var sx = 0, sz = 0;
      pl.startIdx.forEach(function (i) { var c = board.cellCenter(i); sx += c[0]; sz += c[2]; });
      sx /= pl.startIdx.length || 1; sz /= pl.startIdx.length || 1;
      if (Math.hypot(sx, sz) < board.radius * 0.25) ok = false;
      var a = Math.atan2(sx, sz);
      if (topo.kind === 'square') a += Math.PI / 4;
      return a;
    });
    var out = raw.map(function (a, i) {
      if (!ok) a = Math.PI * 2 * i / n;
      return normAngle(Math.round(a / snap) * snap);
    });
    // 两个人取整到同一个方向时，往旁边挪
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < i; j++) {
        if (Math.abs(normAngle(out[i] - out[j] + Math.PI) - Math.PI) < 1e-6) out[i] = normAngle(out[i] + snap);
      }
    }
    return out;
  }

  /* ================= 面前的棋子 ================= */

  /**
   * 一个座位面前的棋子：从棋盘边往外排成几行，越往外越宽，但不占到相邻座位的区域。
   * narrow：每行不宽于棋盘（竖屏时用，棋盘能占满画面宽度）。
   * scale：托盘里的棋子按这个比例缩小摆放（立体棋子在托盘里小一些，拿起来再变回原大）。
   * 返回 slots[piece] = { x, z, rot }（棋子中心的位置；rot 为绕竖轴的转角，让棋子朝向座位）和 reach（最远距离）。
   */
  function trayLayout(state, board, angles, p, narrow, scale) {
    var sc = scale || 1;
    var set = state.set;
    var az = angles[p];
    var out = [Math.sin(az), Math.cos(az)];
    var right = [Math.cos(az), -Math.sin(az)];
    // 与相邻座位的最小夹角，决定每行能有多宽
    var gap = Math.PI;
    angles.forEach(function (a, q) {
      if (q === p) return;
      gap = Math.min(gap, Math.abs(normAngle(a - az + Math.PI) - Math.PI));
    });
    var half = gap / 2;
    var rot = az; // 棋子的局部 x 对齐座位的右方
    var c = Math.cos(rot), s = Math.sin(rot);
    var items = set.pieces.map(function (piece, i) {
      var shape = orientShape(set, i, piece.display);
      var us = [], vs = [];
      shape.forEach(function (k) {
        k.poly.forEach(function (q) {
          // 局部 (x, z) 转到世界，再投影到座位的 (右, 外)
          var wx = (q[0] * c + q[1] * s) * sc, wz = (-q[0] * s + q[1] * c) * sc;
          us.push(wx * right[0] + wz * right[1]);
          vs.push(wx * out[0] + wz * out[1]);
        });
      });
      var u0 = Math.min.apply(null, us), u1 = Math.max.apply(null, us);
      var v0 = Math.min.apply(null, vs), v1 = Math.max.apply(null, vs);
      return { index: i, w: u1 - u0, h: v1 - v0, du: (u0 + u1) / 2, dv: (v0 + v1) / 2, size: piece.size };
    });
    items.sort(function (a, b) { return b.size - a.size || b.w - a.w || a.index - b.index; });
    var GAP = 0.8 * Math.max(0.7, sc);
    // 棋盘在座位方向上伸出多远：外框按座位方向投影
    var edge = 0;
    board.outline.forEach(function (q) { edge = Math.max(edge, q[0] * out[0] + q[1] * out[1]); });
    var halfW = 0;
    board.outline.forEach(function (q) { halfW = Math.max(halfW, Math.abs(q[0] * right[0] + q[1] * right[1])); });
    var v = edge + 2.2;
    var slots = new Array(set.pieces.length);
    var reach = 0;
    var i = 0;
    var widest = Math.max.apply(null, items.map(function (it) { return it.w; }));
    // 在距离 v 处，本座位扇形里还放得下多宽（两边各留一点空）
    function sectorW(dist) { return 2 * (dist * Math.tan(Math.min(half, 1.3)) - 1.1); }
    while (i < items.length) {
      var maxW = Math.min(sectorW(v), narrow ? halfW * 2 + 1 : halfW * 2 + 20);
      if (maxW < Math.min(items[i].w, widest)) { v += 0.5; continue; }
      var row = [], w = 0, h = 0;
      while (i < items.length && (row.length === 0 || w + GAP + items[i].w <= maxW)) {
        w += (row.length ? GAP : 0) + items[i].w;
        h = Math.max(h, items[i].h);
        row.push(items[i++]);
      }
      var u = -w / 2;
      row.forEach(function (it) {
        var uc = u + it.w / 2, vc = v + h / 2;
        var cu = uc - it.du, cv = vc - it.dv;
        slots[it.index] = { x: right[0] * cu + out[0] * cv, z: right[1] * cu + out[1] * cv, rot: rot };
        reach = Math.max(reach, Math.hypot(Math.abs(uc) + it.w / 2, v + h));
        u += it.w + GAP;
      });
      v += h + GAP;
    }
    return { slots: slots, reach: reach };
  }

  /**
   * 悔棋：退回到最近一次「由真人落子（或停手）」之前，返回保留的动作数；没有可悔的返回 -1。
   */
  function undoTarget(actions, isHuman) {
    for (var i = actions.length - 1; i >= 0; i--) if (isHuman(actions[i].player)) return i;
    return -1;
  }

  return {
    LAYER: LAYER,
    FLAT_H: FLAT_H,
    boardOf: boardOf,
    orientShape: orientShape,
    turn: turn,
    seatAngles: seatAngles,
    trayLayout: trayLayout,
    undoTarget: undoTarget,
    centroid: centroid,
    _rotY: rotY,
    _mirror: mirror
  };
});
