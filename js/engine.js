/*
 * 角斗士棋（Blokus）规则引擎：棋盘拓扑、落子合法性、走法生成、轮转与计分。
 * 同时支持方格棋盘与三角格（六边形）棋盘。不依赖 DOM，可在浏览器和 Node 中运行。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pieces.js'));
  else root.BlokusEngine = factory(root.BlokusPieces);
})(typeof self !== 'undefined' ? self : this, function (Pieces) {
  'use strict';

  var SETS = Pieces.SETS;
  var EMPTY = -1;
  var BLOCKED = -2;

  var FOUR = [
    { color: 'blue', label: '蓝' },
    { color: 'yellow', label: '黄' },
    { color: 'red', label: '红' },
    { color: 'green', label: '绿' }
  ];

  var MODES = {
    // 标准盘：四个角按顺时针分配，固定按 蓝 → 黄 → 红 → 绿 行棋
    classic: {
      name: '标准',
      shape: 'square',
      size: 20,
      seats: [
        { color: 'blue', label: '蓝', start: [0, 0] },
        { color: 'yellow', label: '黄', start: [19, 0] },
        { color: 'red', label: '红', start: [19, 19] },
        { color: 'green', label: '绿', start: [0, 19] }
      ]
    },
    // 双人盘：14×14，起点在棋盘内侧
    duo: {
      name: '双人',
      shape: 'square',
      size: 14,
      seats: [
        { color: 'violet', label: '紫', start: [4, 4] },
        { color: 'orange', label: '橙', start: [9, 9] }
      ]
    },
    // 三角块：六边形棋盘，6 个公共起点；人数越少棋盘越小
    trigon: {
      name: '三角块',
      shape: 'tri',
      sizeFor: { 2: 7, 3: 8, 4: 9 },
      seats: FOUR
    },
    // 立体：N×N 地面、限高的空间，棋子受重力竖直落下；各自从地面的一个角出发
    cube: {
      name: '立体',
      shape: 'cube',
      sizeFor: { 2: 5, 3: 6, 4: 7 },
      height: 5,
      seats: FOUR
    }
  };

  function isMode(m) { return typeof m === 'string' && Object.prototype.hasOwnProperty.call(MODES, m); }

  /* ================= 棋盘拓扑 ================= */

  /**
   * cellPoly(x, y) 返回格子的顶点（整数顶点坐标），不在棋盘内返回 null。
   * 共享两个顶点 = 边相邻，只共享一个顶点 = 角相邻。
   */
  function buildTopology(kind, cols, rows, unitX, unitY, cellPoly) {
    var n = cols * rows;
    var valid = new Uint8Array(n);
    var polys = new Array(n);
    var vmap = {};
    var i, x, y;
    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++) {
        i = y * cols + x;
        var poly = cellPoly(x, y);
        if (!poly) continue;
        valid[i] = 1;
        polys[i] = poly;
        poly.forEach(function (v) {
          var k = v[0] + ',' + v[1];
          (vmap[k] || (vmap[k] = [])).push(i);
        });
      }
    }
    var edges = new Array(n), corners = new Array(n), across = new Array(n);
    var cells = [];
    var minVX = Infinity, minVY = Infinity, maxVX = -Infinity, maxVY = -Infinity;
    for (i = 0; i < n; i++) {
      if (!valid[i]) continue;
      cells.push(i);
      var shared = {};
      polys[i].forEach(function (v) {
        if (v[0] < minVX) minVX = v[0];
        if (v[0] > maxVX) maxVX = v[0];
        if (v[1] < minVY) minVY = v[1];
        if (v[1] > maxVY) maxVY = v[1];
        vmap[v[0] + ',' + v[1]].forEach(function (j) { if (j !== i) shared[j] = (shared[j] || 0) + 1; });
      });
      edges[i] = [];
      corners[i] = [];
      Object.keys(shared).forEach(function (j) {
        (shared[j] >= 2 ? edges[i] : corners[i]).push(+j);
      });
      edges[i].sort(function (a, b) { return a - b; });
      corners[i].sort(function (a, b) { return a - b; });
      // 每条边对面的格子（画轮廓用）
      var p = polys[i];
      across[i] = p.map(function (v, k) {
        var w = p[(k + 1) % p.length];
        var a = vmap[v[0] + ',' + v[1]], b = vmap[w[0] + ',' + w[1]];
        for (var t = 0; t < a.length; t++) if (a[t] !== i && b.indexOf(a[t]) >= 0) return a[t];
        return -1;
      });
    }
    var cx = 0, cy = 0;
    var centroids = new Float64Array(n * 2);
    cells.forEach(function (c) {
      var sx = 0, sy = 0;
      polys[c].forEach(function (v) { sx += v[0]; sy += v[1]; });
      centroids[c * 2] = sx / polys[c].length * unitX;
      centroids[c * 2 + 1] = sy / polys[c].length * unitY;
      cx += centroids[c * 2];
      cy += centroids[c * 2 + 1];
    });
    cx /= cells.length;
    cy /= cells.length;
    var centerDist = new Float64Array(n);
    cells.forEach(function (c) {
      var dx = centroids[c * 2] - cx, dy = centroids[c * 2 + 1] - cy;
      // 方格用曼哈顿距离，三角格用放大的欧氏距离，两者量级相近
      centerDist[c] = kind === 'square' ? Math.abs(dx) + Math.abs(dy) : Math.sqrt(dx * dx + dy * dy) * 1.6;
    });
    return {
      kind: kind,
      dims: 2,
      parity: kind === 'tri',
      cols: cols,
      rows: rows,
      n: n,
      valid: valid,
      cells: cells,
      polys: polys,
      edges: edges,
      corners: corners,
      across: across,
      centroids: centroids,
      centerDist: centerDist,
      center: [cx, cy],
      unitX: unitX,
      unitY: unitY,
      bounds: { minVX: minVX, minVY: minVY, maxVX: maxVX, maxVY: maxVY }
    };
  }

  function squareTopology(size) {
    var t = buildTopology('square', size, size, 1, 1, function (x, y) {
      return [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
    });
    t.size = size;
    t.outline = [[0, 0], [size, 0], [size, size], [0, size]];
    return t;
  }

  // 平顶六边形，边长 side 个三角
  function triTopology(side) {
    var cx = 2 * side + (side % 2 === 0 ? 1 : 0); // 中心顶点 (cx, side)，cx + side 须为奇数
    var cols = cx + 2 * side + 1, rows = 2 * side;
    function inside(v) {
      var dy = Math.abs(v[1] - side);
      return dy <= side && Math.abs(v[0] - cx) + dy <= 2 * side;
    }
    var t = buildTopology('tri', cols, rows, 0.5, Pieces.H, function (x, y) {
      var vs = Pieces.triVerts(x, y);
      return vs.every(inside) ? vs : null;
    });
    t.size = side;
    t.outline = [[cx - side, 0], [cx + side, 0], [cx + 2 * side, side], [cx + side, 2 * side], [cx - side, 2 * side], [cx - 2 * side, side]];
    // 6 个起点：中心到 6 个角的中点附近
    var starts = [];
    for (var k = 0; k < 6; k++) {
      var ang = k * Math.PI / 3;
      var px = t.center[0] + Math.cos(ang) * side * 0.5;
      var py = t.center[1] + Math.sin(ang) * side * 0.5;
      var best = -1, bd = Infinity;
      t.cells.forEach(function (c) {
        var dx = t.centroids[c * 2] - px, dy = t.centroids[c * 2 + 1] - py;
        var d = dx * dx + dy * dy;
        if (d < bd - 1e-9) { bd = d; best = c; }
      });
      starts.push([best % cols, (best - best % cols) / cols]);
    }
    t.starts = starts;
    return t;
  }

  // 立体棋盘：下标 = x + W·(z + D·y)，y 朝上；共面 = 面相邻，共棱或共顶点 = 角相邻
  function cubeTopology(n, height) {
    var W = n, D = n, H = height, total = W * D * H;
    var valid = new Uint8Array(total), cells = [], edges = new Array(total), corners = new Array(total);
    var centerDist = new Float64Array(total);
    for (var y = 0; y < H; y++) {
      for (var z = 0; z < D; z++) {
        for (var x = 0; x < W; x++) {
          var i = x + W * (z + D * y);
          valid[i] = 1;
          cells.push(i);
          var e = [], c = [];
          for (var dy = -1; dy <= 1; dy++) {
            for (var dz = -1; dz <= 1; dz++) {
              for (var dx = -1; dx <= 1; dx++) {
                if (!dx && !dy && !dz) continue;
                var nx = x + dx, ny = y + dy, nz = z + dz;
                if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= D) continue;
                var j = nx + W * (nz + D * ny);
                (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1 ? e : c).push(j);
              }
            }
          }
          edges[i] = e;
          corners[i] = c;
          var hx = x + 0.5 - W / 2, hz = z + 0.5 - D / 2;
          centerDist[i] = Math.sqrt(hx * hx + hz * hz) * 1.4;
        }
      }
    }
    return {
      kind: 'cube',
      dims: 3,
      gravity: true,
      parity: false,
      cols: W,
      depth: D,
      height: H,
      rows: H,
      n: total,
      size: n,
      valid: valid,
      cells: cells,
      edges: edges,
      corners: corners,
      centerDist: centerDist,
      seatStarts: [[0, 0, 0], [W - 1, 0, 0], [W - 1, 0, D - 1], [0, 0, D - 1]]
    };
  }

  var topoCache = {};
  function topologyFor(mode, size) {
    var m = isMode(mode) ? MODES[mode] : MODES.classic;
    var key = m.shape + ':' + size;
    if (!topoCache[key]) {
      topoCache[key] = m.shape === 'tri' ? triTopology(size) : m.shape === 'cube' ? cubeTopology(size, m.height) : squareTopology(size);
    }
    return topoCache[key];
  }

  function cellIndex(topo, c) {
    return topo.dims === 3 ? c[0] + topo.cols * (c[2] + topo.depth * c[1]) : c[1] * topo.cols + c[0];
  }

  function inBounds(topo, c) {
    if (topo.dims === 3) {
      return c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < topo.cols && c[1] < topo.height && c[2] < topo.depth;
    }
    return c[0] >= 0 && c[1] >= 0 && c[0] < topo.cols && c[1] < topo.rows && topo.valid[c[1] * topo.cols + c[0]] === 1;
  }

  function setFor(mode) { return SETS[(isMode(mode) ? MODES[mode] : MODES.classic).shape]; }

  function sizeFor(mode, playerCount) {
    var m = MODES[mode];
    if (m.sizeFor) return m.sizeFor[Math.max(2, Math.min(4, playerCount))];
    return m.size;
  }

  /**
   * 按座位生成对局配置。
   * entries: [{ seat, ...附加信息（name / type / level / owner 等）}]，按座位顺序。
   */
  function buildConfig(mode, entries) {
    var m = MODES[mode];
    var size = sizeFor(mode, entries.length);
    var topo = topologyFor(mode, size);
    return {
      mode: mode,
      size: size,
      players: entries.map(function (e) {
        var seat = m.seats[e.seat];
        var p = {};
        for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) p[k] = e[k];
        p.color = seat.color;
        p.label = seat.label;
        p.starts = seat.start ? [seat.start.slice()]
          : topo.seatStarts ? [topo.seatStarts[e.seat].slice()]
          : topo.starts.map(function (s) { return s.slice(); });
        return p;
      })
    };
  }

  /* ================= 对局状态 ================= */

  /**
   * config: { mode, size, players: [{ starts: [[x, y], ...] | start: [x, y], ...附加信息 }] }
   * 玩家数组顺序即行棋顺序。
   */
  function createGame(config) {
    var mode = isMode(config.mode) ? config.mode : 'classic';
    var topo = topologyFor(mode, config.size);
    var set = setFor(mode);
    var board = new Int8Array(topo.n);
    for (var i = 0; i < topo.n; i++) board[i] = topo.valid[i] ? EMPTY : BLOCKED;
    var state = {
      mode: mode,
      size: config.size,
      topo: topo,
      set: set,
      board: board,
      players: config.players.map(function (p, idx) {
        var pl = {};
        for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) pl[k] = p[k];
        var starts = p.starts || [p.start];
        pl.index = idx;
        pl.starts = starts.map(function (s) { return s.slice(); });
        pl.startIdx = starts.filter(function (s) { return Array.isArray(s) && s.length === topo.dims && inBounds(topo, s); })
          .map(function (s) { return cellIndex(topo, s); });
        pl.remaining = [];
        for (var j = 0; j < set.count; j++) pl.remaining.push(true);
        pl.remainingSquares = set.total;
        pl.placed = 0;
        pl.lastPiece = -1;
        pl.done = false;
        pl.resigned = false;
        return pl;
      }),
      current: 0,
      actions: [],
      events: [],
      lastMove: null,
      over: false
    };
    settle(state);
    return state;
  }

  function placementCells(state, pieceIndex, orient, x, y, z) {
    var flat = state.set.pieces[pieceIndex].orients[orient].flat;
    var out = [];
    var k;
    if (state.topo.dims === 3) {
      for (k = 0; k < flat.length; k += 3) out.push([x + flat[k], y + flat[k + 1], z + flat[k + 2]]);
    } else {
      for (k = 0; k < flat.length; k += 2) out.push([x + flat[k], y + flat[k + 1]]);
    }
    return out;
  }

  function placementIndices(state, pieceIndex, orient, x, y, z) {
    var topo = state.topo;
    return placementCells(state, pieceIndex, orient, x, y, z).map(function (c) { return cellIndex(topo, c); });
  }

  /* ---------- 立体：重力 ---------- */

  // 每一列最高的方块之上一格（空列为 0）
  function heightMap(board, topo) {
    var W = topo.cols, D = topo.depth, H = topo.height, layer = W * D;
    var hm = new Int8Array(layer);
    for (var y = 0; y < H; y++) {
      for (var c = 0; c < layer; c++) if (board[c + layer * y] !== EMPTY) hm[c] = y + 1;
    }
    return hm;
  }

  // 棋子在 (x, z) 处竖直落下后的高度；出界返回 -1；ignoreCeiling 时允许超过限高
  function dropY(state, pieceIndex, orient, x, z, ignoreCeiling, hm) {
    var topo = state.topo;
    var o = state.set.pieces[pieceIndex].orients[orient];
    if (x < 0 || z < 0 || x + o.w > topo.cols || z + o.d > topo.depth) return -1;
    hm = hm || heightMap(state.board, topo);
    var y = 0, foot = o.foot;
    for (var k = 0; k < foot.length; k += 3) {
      var need = hm[(z + foot[k + 1]) * topo.cols + x + foot[k]] - foot[k + 2];
      if (need > y) y = need;
    }
    if (!ignoreCeiling && y + o.h > topo.height) return -1;
    return y;
  }

  // 按列枚举：每个 (棋子, 朝向, x, z) 至多一个落点
  function forEachDrop(state, p, visit, remaining, forb, mark) {
    var topo = state.topo, board = state.board;
    var W = topo.cols, D = topo.depth, H = topo.height, layer = W * D;
    var hm = heightMap(board, topo);
    var pieces = state.set.pieces;
    for (var pi = 0; pi < pieces.length; pi++) {
      if (!remaining[pi] || !state.players[p].remaining[pi]) continue;
      var orients = pieces[pi].orients;
      for (var oi = 0; oi < orients.length; oi++) {
        var o = orients[oi], flat = o.flat, foot = o.foot, len = flat.length;
        for (var z = 0; z + o.d <= D; z++) {
          for (var x = 0; x + o.w <= W; x++) {
            var y = 0, k;
            for (k = 0; k < foot.length; k += 3) {
              var need = hm[(z + foot[k + 1]) * W + x + foot[k]] - foot[k + 2];
              if (need > y) y = need;
            }
            if (y + o.h > H) continue;
            var ok = true, touch = false;
            for (k = 0; k < len; k += 3) {
              var idx = x + flat[k] + W * (z + flat[k + 2]) + layer * (y + flat[k + 1]);
              if (forb[idx]) { ok = false; break; }
              if (mark[idx]) touch = true;
            }
            if (ok && touch && visit(pi, oi, x, y, z)) return true;
          }
        }
      }
    }
    return false;
  }

  // 1 表示玩家 p 不能占用：已有棋子 / 棋盘外，或与 p 的棋子边相邻
  function forbiddenMask(board, topo, p) {
    var n = topo.n;
    var forb = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var v = board[i];
      if (v !== EMPTY) {
        forb[i] = 1;
        if (v === p) {
          var e = topo.edges[i];
          for (var k = 0; k < e.length; k++) forb[e[k]] = 1;
        }
      }
    }
    return forb;
  }

  // 角点：玩家 p 下一块棋子必须覆盖其中之一
  function anchorMask(board, topo, p, player, forb) {
    var n = topo.n;
    var mark = new Uint8Array(n);
    var list = [];
    var i;
    if (player.placed === 0) {
      for (i = 0; i < player.startIdx.length; i++) {
        var s = player.startIdx[i];
        if (board[s] === EMPTY && !mark[s]) {
          mark[s] = 1;
          list.push(s);
        }
      }
      return { mark: mark, list: list };
    }
    for (i = 0; i < n; i++) {
      if (forb[i]) continue;
      var c = topo.corners[i];
      for (var k = 0; k < c.length; k++) {
        if (board[c[k]] === p) {
          mark[i] = 1;
          list.push(i);
          break;
        }
      }
    }
    return { mark: mark, list: list };
  }

  /**
   * 遍历玩家 p 的全部合法落子（每个落子恰好访问一次）。
   * visit(pieceIndex, orient, x, y) 返回 true 时提前结束。
   * pieceFilter 可限定只考虑某些棋子（布尔数组）。
   */
  function forEachMove(state, p, visit, pieceFilter) {
    var board = state.board, topo = state.topo;
    var cols = topo.cols, rows = topo.rows, parity = topo.parity;
    var player = state.players[p];
    var forb = forbiddenMask(board, topo, p);
    var anchors = anchorMask(board, topo, p, player, forb);
    var mark = anchors.mark, list = anchors.list;
    if (!list.length) return;
    var remaining = pieceFilter || player.remaining;
    if (topo.gravity) {
      forEachDrop(state, p, visit, remaining, forb, mark);
      return;
    }
    var pieces = state.set.pieces;
    for (var pi = 0; pi < pieces.length; pi++) {
      if (!remaining[pi] || !player.remaining[pi]) continue;
      var orients = pieces[pi].orients;
      for (var oi = 0; oi < orients.length; oi++) {
        var flat = orients[oi].flat;
        var len = flat.length;
        for (var a = 0; a < list.length; a++) {
          var ai = list[a];
          var ax = ai % cols, ay = (ai - ax) / cols;
          for (var c = 0; c < len; c += 2) {
            var ox = ax - flat[c], oy = ay - flat[c + 1];
            // 三角格：平移必须保持尖的朝向
            if (parity && ((ox + oy) & 1)) continue;
            var ok = true;
            for (var k = 0; k < len; k += 2) {
              var x = ox + flat[k], y = oy + flat[k + 1];
              if (x < 0 || y < 0 || x >= cols || y >= rows) { ok = false; break; }
              var idx = y * cols + x;
              if (forb[idx]) { ok = false; break; }
              // 去重：若更靠前的格子也在角点上，这个落子会在那里被枚举
              if (k < c && mark[idx]) { ok = false; break; }
            }
            if (ok && visit(pi, oi, ox, oy)) return;
          }
        }
      }
    }
  }

  function legalMoves(state, p, pieceFilter) {
    var moves = [];
    forEachMove(state, p, function (piece, orient, x, y, z) {
      var m = { piece: piece, orient: orient, x: x, y: y };
      if (z !== undefined) m.z = z;
      moves.push(m);
    }, pieceFilter);
    return moves;
  }

  function hasAnyMove(state, p) {
    var found = false;
    forEachMove(state, p, function () { found = true; return true; });
    return found;
  }

  // 每块剩余棋子当前可落子的数量
  function movesPerPiece(state, p) {
    var counts = new Array(state.set.count).fill(0);
    forEachMove(state, p, function (piece) { counts[piece]++; });
    return counts;
  }

  /**
   * 检查落子，合法返回 null，否则返回原因代码：
   * used / bounds / ceiling / occupied / float / edge / start / corner
   */
  function checkPlacement(state, p, pieceIndex, orient, x, y, z) {
    var player = state.players[p];
    if (!Number.isInteger(pieceIndex) || !Number.isInteger(orient)) return 'used';
    var piece = state.set.pieces[pieceIndex];
    if (!player || player.done || !piece || !player.remaining[pieceIndex] || !piece.orients[orient]) return 'used';
    var topo = state.topo, board = state.board;
    if (!Number.isInteger(x) || !Number.isInteger(y) || (topo.dims === 3 && !Number.isInteger(z))) return 'bounds';
    if (topo.parity && ((x + y) & 1)) return 'bounds';
    var cells = placementCells(state, pieceIndex, orient, x, y, z);
    var idx = [];
    var i, k;
    for (i = 0; i < cells.length; i++) {
      if (!inBounds(topo, cells[i])) {
        var c3 = cells[i];
        if (topo.dims === 3 && c3[1] >= topo.height && c3[0] >= 0 && c3[2] >= 0 && c3[0] < topo.cols && c3[2] < topo.depth) return 'ceiling';
        return 'bounds';
      }
      idx.push(cellIndex(topo, cells[i]));
    }
    for (i = 0; i < idx.length; i++) if (board[idx[i]] !== EMPTY) return 'occupied';
    if (topo.gravity && dropY(state, pieceIndex, orient, x, z, true) !== y) return 'float';
    for (i = 0; i < idx.length; i++) {
      var e = topo.edges[idx[i]];
      for (k = 0; k < e.length; k++) if (board[e[k]] === p) return 'edge';
    }
    if (player.placed === 0) {
      for (i = 0; i < idx.length; i++) if (player.startIdx.indexOf(idx[i]) >= 0) return null;
      return 'start';
    }
    for (i = 0; i < idx.length; i++) {
      var c = topo.corners[idx[i]];
      for (k = 0; k < c.length; k++) if (board[c[k]] === p) return null;
    }
    return 'corner';
  }

  // 轮到下一位仍可行棋的玩家；无路可走者自动出局
  function settle(state) {
    var n = state.players.length;
    for (var tries = 0; tries <= n; tries++) {
      var pl = state.players[state.current];
      if (!pl.done) {
        if (hasAnyMove(state, state.current)) return;
        pl.done = true;
        state.events.push({ type: 'blocked', player: state.current, at: state.actions.length });
      }
      state.current = (state.current + 1) % n;
    }
    state.over = true;
    state.events.push({ type: 'over', at: state.actions.length });
  }

  function advance(state) {
    if (state.players.every(function (pl) { return pl.done; })) {
      state.over = true;
      state.events.push({ type: 'over', at: state.actions.length });
      return;
    }
    state.current = (state.current + 1) % state.players.length;
    settle(state);
  }

  /**
   * 执行一个动作并轮到下一位玩家。
   * action: { type: 'place', piece, orient, x, y } 或 { type: 'resign' }
   * 返回 null 表示成功，否则返回原因代码。
   */
  function applyAction(state, action) {
    if (state.over) return 'over';
    if (!action || (action.type !== 'place' && action.type !== 'resign')) return 'invalid';
    var p = state.current;
    var player = state.players[p];
    if (action.type === 'resign') {
      player.done = true;
      player.resigned = true;
      state.actions.push({ type: 'resign', player: p });
      state.events.push({ type: 'resign', player: p, at: state.actions.length });
      advance(state);
      return null;
    }
    var reason = checkPlacement(state, p, action.piece, action.orient, action.x, action.y, action.z);
    if (reason) return reason;
    var cells = placementCells(state, action.piece, action.orient, action.x, action.y, action.z);
    for (var i = 0; i < cells.length; i++) state.board[cellIndex(state.topo, cells[i])] = p;
    player.remaining[action.piece] = false;
    player.remainingSquares -= state.set.pieces[action.piece].size;
    player.placed++;
    player.lastPiece = action.piece;
    var record = { type: 'place', player: p, piece: action.piece, orient: action.orient, x: action.x, y: action.y };
    if (state.topo.dims === 3) record.z = action.z;
    state.actions.push(record);
    state.lastMove = { player: p, piece: action.piece, cells: cells };
    advance(state);
    return null;
  }

  // 从头重放动作序列（用于悔棋、读档、联机同步）；遇到非法动作即停止
  function replay(config, actions) {
    var state = createGame(config);
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (state.over || !a || a.player !== state.current) break;
      if (applyAction(state, a)) break;
    }
    return state;
  }

  // 官方计分：每个未放置的格子 -1；全部放完 +15，最后一块是单格再 +5
  function scoreOf(player) {
    var s = -player.remainingSquares;
    if (player.remainingSquares === 0) {
      s += 15;
      if (player.lastPiece === Pieces.MONOMINO) s += 5;
    }
    return s;
  }

  function standings(state) {
    var total = state.set.total;
    var rows = state.players.map(function (pl) {
      return {
        index: pl.index,
        player: pl,
        score: scoreOf(pl),
        placedSquares: total - pl.remainingSquares,
        remainingSquares: pl.remainingSquares,
        piecesLeft: pl.remaining.filter(Boolean).length,
        allPlaced: pl.remainingSquares === 0,
        monoLast: pl.remainingSquares === 0 && pl.lastPiece === Pieces.MONOMINO
      };
    });
    rows.sort(function (a, b) { return b.score - a.score || b.placedSquares - a.placedSquares || a.index - b.index; });
    var rank = 0;
    rows.forEach(function (r, i) {
      if (i === 0 || r.score !== rows[i - 1].score) rank = i + 1;
      r.rank = rank;
    });
    return rows;
  }

  return {
    EMPTY: EMPTY,
    BLOCKED: BLOCKED,
    MODES: MODES,
    SETS: SETS,
    isMode: isMode,
    PIECES: SETS.square.pieces,
    TOTAL_SQUARES: SETS.square.total,
    topologyFor: topologyFor,
    cellIndex: cellIndex,
    inBounds: inBounds,
    heightMap: heightMap,
    dropY: dropY,
    setFor: setFor,
    sizeFor: sizeFor,
    buildConfig: buildConfig,
    createGame: createGame,
    placementCells: placementCells,
    placementIndices: placementIndices,
    forbiddenMask: forbiddenMask,
    anchorMask: anchorMask,
    forEachMove: forEachMove,
    legalMoves: legalMoves,
    hasAnyMove: hasAnyMove,
    movesPerPiece: movesPerPiece,
    checkPlacement: checkPlacement,
    applyAction: applyAction,
    replay: replay,
    scoreOf: scoreOf,
    standings: standings
  };
});
