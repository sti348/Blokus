/*
 * 角斗士棋立体类模式（立体方块、三棱柱）的绘制。Canvas 2D 正交投影，无第三方依赖。
 *
 * 每个格子都是“地面多边形 × 一层高”的柱体：方块的地面是正方形，三棱柱的地面是三角形。
 * 世界坐标 [X, Y, Z]，Y 朝上；相机绕竖轴旋转 yaw、俯视角 pitch。
 * 格子按到相机的深度从远到近绘制，被相邻格子挡住的面不画。
 */
(function (root) {
  'use strict';

  var Engine = root.BlokusEngine;
  var Pieces = root.BlokusPieces;
  var EMPTY = Engine.EMPTY;
  var H3 = Math.sqrt(3) / 2;

  var DEFAULT_CAM = { yaw: 0.62, pitch: 0.6 };
  var PITCH_MIN = 0.22, PITCH_MAX = 1.35;

  /* ---------- 两种格子的几何 ---------- */

  var GEOM = {
    cube: {
      kind: 'cube',
      layerH: 1,
      floor: function (x, z) { return [[x, z], [x + 1, z], [x + 1, z + 1], [x, z + 1]]; },
      // 第 k 条边（顶点 k → k+1）对面的那一列
      edgeNbr: function (x, z) { return [[x, z - 1], [x + 1, z], [x, z + 1], [x - 1, z]]; },
      steps: [[1, 0], [-1, 0], [0, 1], [0, -1]],
      stepVec: function (s) { return s; },
      tile: 0.86,
      nub: 0.4,
      ring: 0.3,
      box: 4.2
    },
    prism: {
      kind: 'prism',
      layerH: 0.8,
      floor: function (x, z) {
        return Pieces.triVerts(x, z).map(function (v) { return [v[0] * 0.5, v[1] * H3]; });
      },
      edgeNbr: function (x, z) {
        return ((x + z) & 1) ? [[x, z - 1], [x + 1, z], [x - 1, z]] : [[x + 1, z], [x, z + 1], [x - 1, z]];
      },
      // 保持三角形朝向的移动
      steps: [[2, 0], [-2, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]],
      stepVec: function (s) { return [s[0] * 0.5, s[1] * H3]; },
      tile: 0.78,
      nub: 0.42,
      ring: 0.17,
      box: 3.4
    }
  };

  function geomOf(kind) { return GEOM[kind] || GEOM.cube; }

  var colCache = {};
  // 一列的地面多边形、中心和各个侧面（含朝外的法线与对面那一列）
  function column(G, x, z) {
    var key = G.kind + ':' + x + ',' + z;
    var hit = colCache[key];
    if (hit) return hit;
    var poly = G.floor(x, z);
    var cx = 0, cz = 0;
    poly.forEach(function (p) { cx += p[0]; cz += p[1]; });
    cx /= poly.length;
    cz /= poly.length;
    var nb = G.edgeNbr(x, z);
    var sides = poly.map(function (a, k) {
      var b = poly[(k + 1) % poly.length];
      var ex = b[0] - a[0], ez = b[1] - a[1], len = Math.sqrt(ex * ex + ez * ez);
      var nx = ez / len, nz = -ex / len;
      if (nx * ((a[0] + b[0]) / 2 - cx) + nz * ((a[1] + b[1]) / 2 - cz) < 0) { nx = -nx; nz = -nz; }
      return { a: a, b: b, n: [nx, 0, nz], nb: nb[k] };
    });
    hit = { poly: poly, cx: cx, cz: cz, sides: sides };
    colCache[key] = hit;
    return hit;
  }

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
  function shade(color, which) {
    var key = color + '|' + which;
    if (!shadeCache[key]) {
      shadeCache[key] = which === 'top' ? mix(color, 'white', 0.2)
        : which === 'nub' ? mix(color, 'white', 0.3)
        : which === 'edge' ? mix(color, 'black', 0.38)
        : mix(color, 'black', which);
    }
    return shadeCache[key];
  }

  // 侧面越朝向屏幕右边越暗
  function sideTone(L, n) {
    var rx = n[0] * L.cyaw - n[2] * L.syaw;
    return Math.round((0.11 + 0.11 * rx) * 50) / 50;
  }

  /* ---------- 投影 ---------- */

  function clampPitch(p) { return Math.max(PITCH_MIN, Math.min(PITCH_MAX, p)); }

  var sceneCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function sceneOf(topo) {
    var hit = sceneCache && sceneCache.get(topo);
    if (hit) return hit;
    var G = geomOf(topo.kind);
    var outline = topo.kind === 'prism'
      ? topo.tri.outline.map(function (v) { return [v[0] * 0.5, v[1] * H3]; })
      : [[0, 0], [topo.cols, 0], [topo.cols, topo.depth], [0, topo.depth]];
    var cx = 0, cz = 0;
    outline.forEach(function (p) { cx += p[0]; cz += p[1]; });
    cx /= outline.length;
    cz /= outline.length;
    var r = 0;
    outline.forEach(function (p) { r = Math.max(r, Math.sqrt((p[0] - cx) * (p[0] - cx) + (p[1] - cz) * (p[1] - cz))); });
    var columns = [];
    for (var z = 0; z < topo.depth; z++) {
      for (var x = 0; x < topo.cols; x++) if (topo.colValid[x + topo.cols * z]) columns.push([x, z]);
    }
    hit = { G: G, outline: outline, cx: cx, cz: cz, r: r + 0.35, columns: columns };
    if (sceneCache) sceneCache.set(topo, hit);
    return hit;
  }

  // 视角无关的缩放：旋转时棋盘大小不变
  function layout(view, topo) {
    var cam = view.cam || (view.cam = { yaw: DEFAULT_CAM.yaw, pitch: DEFAULT_CAM.pitch });
    var S = sceneOf(topo), G = S.G, css = view.css;
    var pad = Math.max(8, css * 0.03);
    var Hw = topo.height * G.layerH;
    var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    var k = Math.min((css - 2 * pad) / (2 * S.r), (css - 2 * pad) / (2 * S.r * sp + (Hw + 0.4) * cp));
    return {
      topo: topo,
      S: S,
      G: G,
      LH: G.layerH,
      Hw: Hw,
      cx: S.cx, cz: S.cz,
      cyaw: Math.cos(cam.yaw), syaw: Math.sin(cam.yaw),
      cp: cp, sp: sp,
      k: k,
      ox: css / 2,
      oy: css / 2 + ((Hw * cp) / 2 - 0.15 * sp) * k
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

  function visible(L, n) {
    return (n[0] * L.syaw + n[2] * L.cyaw) * L.cp + n[1] * L.sp > 1e-6;
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

  function cellCenter(L, c) {
    var col = column(L.G, c[0], c[2]);
    return [col.cx, (c[1] + 0.5) * L.LH, col.cz];
  }

  function cellDepth(L, c) {
    var p = cellCenter(L, c);
    return depthOf(L, p[0], p[1], p[2]);
  }

  // 一格的所有可见面（世界坐标）
  function cellFaces(L, c) {
    var col = column(L.G, c[0], c[2]);
    var y0 = c[1] * L.LH, y1 = y0 + L.LH;
    var out = [];
    col.sides.forEach(function (s, k) {
      if (!visible(L, s.n)) return;
      out.push({ kind: 'side', k: k, n: s.n, pts: [[s.a[0], y0, s.a[1]], [s.b[0], y0, s.b[1]], [s.b[0], y1, s.b[1]], [s.a[0], y1, s.a[1]]] });
    });
    out.push({ kind: 'top', n: [0, 1, 0], pts: col.poly.map(function (p) { return [p[0], y1, p[1]]; }), col: col, y: y1 });
    return out;
  }

  /* ---------- 一格 ---------- */

  // opts: alpha / tint / stroke / strokeWidth / noNub / hideTop / hideSide[k]
  function drawCell(g, L, c, color, opts) {
    opts = opts || {};
    g.globalAlpha = opts.alpha == null ? 1 : opts.alpha;
    g.lineJoin = 'round';
    cellFaces(L, c).forEach(function (f) {
      if (f.kind === 'top' ? opts.hideTop : opts.hideSide && opts.hideSide[f.k]) return;
      pathPts(g, f.pts.map(function (p) { return proj(L, p[0], p[1], p[2]); }));
      g.fillStyle = opts.tint || (f.kind === 'top' ? shade(color, 'top') : shade(color, sideTone(L, f.n)));
      g.fill();
      g.strokeStyle = opts.stroke || shade(color, 'edge');
      g.lineWidth = opts.strokeWidth || Math.max(0.6, L.k * 0.03);
      g.stroke();
      if (f.kind === 'top' && !opts.tint && !opts.noNub) {
        // 顶面的小凸台：棋子的塑料质感
        var col = f.col, s = L.G.nub;
        pathPts(g, col.poly.map(function (p) {
          return proj(L, col.cx + (p[0] - col.cx) * s, f.y, col.cz + (p[1] - col.cz) * s);
        }));
        g.fillStyle = shade(color, 'nub');
        g.fill();
      }
    });
    g.globalAlpha = 1;
  }

  /* ---------- 整体绘制 ---------- */

  function drawScene(view, state, ov, palette, now) {
    var g = view.ctx, topo = state.topo;
    var L = layout(view, topo), S = L.S, G = L.G;
    var W = topo.cols, D = topo.depth, H = topo.height, layer = W * D;
    var board = state.board;
    g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    g.clearRect(0, 0, view.css, view.css);

    function colorOf(p) { return palette.colors[state.players[p].color] || palette.ink; }
    function indexOf(x, y, z) {
      if (x < 0 || z < 0 || y < 0 || x >= W || z >= D || y >= H) return -1;
      var i = x + W * (z + D * y);
      return topo.valid[i] ? i : -1;
    }

    // 底座：地面轮廓向外扩一圈，再画朝向相机的厚度
    var slab = 0.32;
    var base = S.outline.map(function (p) {
      var dx = p[0] - S.cx, dz = p[1] - S.cz, d = Math.sqrt(dx * dx + dz * dz) || 1;
      return [p[0] + dx / d * 0.32, p[1] + dz / d * 0.32];
    });
    g.lineJoin = 'round';
    pathPts(g, base.map(function (p) { return proj(L, p[0], 0, p[1]); }));
    g.fillStyle = palette.frame;
    g.fill();
    base.forEach(function (a, k) {
      var b = base[(k + 1) % base.length];
      var nx = b[1] - a[1], nz = -(b[0] - a[0]);
      if (nx * ((a[0] + b[0]) / 2 - S.cx) + nz * ((a[1] + b[1]) / 2 - S.cz) < 0) { nx = -nx; nz = -nz; }
      if (!visible(L, [nx, 0, nz])) return;
      pathPts(g, [[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], -slab, b[1]], [a[0], -slab, a[1]]].map(function (p) { return proj(L, p[0], p[1], p[2]); }));
      g.fillStyle = mix(palette.frame, 'black', 0.18);
      g.fill();
    });
    // 地面格子
    pathPts(g, S.outline.map(function (p) { return proj(L, p[0], 0, p[1]); }));
    g.fillStyle = palette.groove;
    g.fill();
    g.fillStyle = palette.cell;
    S.columns.forEach(function (xz) {
      var col = column(G, xz[0], xz[1]), f = G.tile;
      pathPts(g, col.poly.map(function (p) { return proj(L, col.cx + (p[0] - col.cx) * f, 0, col.cz + (p[1] - col.cz) * f); }));
      g.fill();
    });
    // 起始角
    state.players.forEach(function (pl, p) {
      if (pl.placed > 0) return;
      pl.startIdx.forEach(function (i) {
        if (board[i] !== EMPTY) return;
        var c = coordOf(topo, i), col = column(G, c[0], c[2]);
        var pts = [];
        for (var a = 0; a < 24; a++) {
          var t = a / 24 * Math.PI * 2;
          pts.push(proj(L, col.cx + Math.cos(t) * G.ring, 0.01, col.cz + Math.sin(t) * G.ring));
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
    pathPts(g, S.outline.map(function (p) { return proj(L, p[0], L.Hw, p[1]); }));
    g.stroke();
    S.outline.forEach(function (p) {
      var a = proj(L, p[0], 0, p[1]), b = proj(L, p[0], L.Hw, p[1]);
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
    });
    g.restore();

    // 格子与标记按深度排序
    var anim = ov.anim, animSet = {}, animT = 1;
    if (anim) {
      animT = ov.dropMs ? Math.max(0, Math.min(1, (now - anim.t0) / ov.dropMs)) : 1;
      anim.cells.forEach(function (i) { animSet[i] = 1; });
    }
    var lastSet = {};
    (ov.lastMove || []).forEach(function (i) { lastSet[i] = 1; });

    // 透视：只显示到第 slice 层；X 光让所有格子半透明；挡住待放棋子的格子自动变淡
    var slice = ov.slice != null ? Math.max(1, Math.min(H, ov.slice)) : H;
    var xray = !!ov.xray;
    var fade = fadeSet(L, topo, board, [ov.ghost, ov.remote]);
    function occ(i) {
      return i >= 0 && board[i] >= 0 && !animSet[i] && !fade[i] && Math.floor(i / layer) < slice && !xray;
    }

    var items = [];
    for (var i = 0; i < board.length; i++) {
      if (board[i] < 0 || animSet[i]) continue;
      var c = coordOf(topo, i);
      items.push({ d: cellDepth(L, c), kind: 'cell', i: i, c: c });
    }
    if (anim) {
      var ease = 1 - Math.pow(1 - animT, 3);
      anim.cells.forEach(function (i) {
        var c = coordOf(topo, i);
        var cc = [c[0], c[1] + (1 - ease) * 2.2, c[2]];
        items.push({ d: cellDepth(L, cc), kind: 'anim', c: cc, player: anim.player, alpha: 0.4 + 0.6 * ease });
      });
    }
    if (ov.anchors) {
      ov.anchors.list.forEach(function (i) {
        var c = coordOf(topo, i);
        if (c[1] > slice) return;
        var col = column(G, c[0], c[2]);
        items.push({ d: depthOf(L, col.cx, c[1] * L.LH, col.cz) + 0.001, kind: 'dot', c: c, col: col });
      });
    }
    items.sort(function (a, b) { return a.d - b.d; });
    items.forEach(function (it) {
      if (it.kind === 'dot') {
        var p = proj(L, it.col.cx, it.c[1] * L.LH + 0.02, it.col.cz);
        var rr = L.k * G.ring * 0.45;
        g.beginPath();
        g.ellipse(p[0], p[1], rr, rr * L.sp, 0, 0, Math.PI * 2);
        g.fillStyle = ov.anchors.color;
        g.globalAlpha = 0.7;
        g.fill();
        g.globalAlpha = 1;
        return;
      }
      if (it.kind === 'anim') {
        drawCell(g, L, it.c, colorOf(it.player), { alpha: it.alpha });
        return;
      }
      var x = it.c[0], y = it.c[1], z = it.c[2];
      var color = colorOf(board[it.i]);
      if (y >= slice) {
        // 被切掉的楼层只留一点影子，提醒上面还有东西
        drawCell(g, L, it.c, color, { alpha: 0.07, noNub: true });
        return;
      }
      var col = column(G, x, z);
      var opts = {
        hideTop: occ(indexOf(x, y + 1, z)),
        hideSide: col.sides.map(function (s) { return occ(indexOf(s.nb[0], y, s.nb[1])); })
      };
      if (fade[it.i]) {
        opts.alpha = 0.2;
        opts.noNub = true;
      } else if (xray) {
        opts.alpha = 0.34;
        opts.stroke = shade(color, 'edge');
        opts.strokeWidth = Math.max(1, L.k * 0.045);
      }
      if (lastSet[it.i]) {
        opts.stroke = palette.ink;
        opts.strokeWidth = Math.max(1.4, L.k * 0.06);
      }
      drawCell(g, L, it.c, color, opts);
    });

    // 提示：虚线框
    if (ov.hint) {
      g.save();
      g.globalAlpha = ov.pulse == null ? 1 : ov.pulse;
      g.setLineDash([L.k * 0.18, L.k * 0.12]);
      g.strokeStyle = ov.hint.color;
      g.lineWidth = Math.max(1.6, L.k * 0.07);
      ov.hint.cells.forEach(function (c) {
        cellFaces(L, c).forEach(function (f) {
          pathPts(g, f.pts.map(function (p) { return proj(L, p[0], p[1], p[2]); }));
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

  function drawGhost(g, L, gh, palette, remote) {
    // 落点下方的投影
    if (gh.shadow) {
      g.globalAlpha = remote ? 0.14 : 0.22;
      g.fillStyle = gh.valid ? gh.color : palette.danger;
      gh.shadow.forEach(function (s) {
        var col = column(L.G, s[0], s[2]);
        pathPts(g, col.poly.map(function (p) { return proj(L, p[0], s[1] * L.LH + 0.01, p[1]); }));
        g.fill();
      });
      g.globalAlpha = 1;
    }
    g.save();
    if (remote) g.setLineDash([L.k * 0.16, L.k * 0.1]);
    gh.cells.slice().sort(function (a, b) { return cellDepth(L, a) - cellDepth(L, b); }).forEach(function (c) {
      drawCell(g, L, c, gh.color, {
        alpha: remote ? 0.5 : gh.valid ? 0.78 : 0.5,
        tint: gh.valid ? null : mix(palette.danger, 'white', 0.25),
        stroke: remote ? gh.color : gh.valid ? palette.ink : palette.danger,
        strokeWidth: Math.max(1.2, L.k * (remote ? 0.06 : 0.05)),
        noNub: remote
      });
    });
    g.restore();
  }

  // 屏幕上挡在待放棋子前面的格子
  function fadeSet(L, topo, board, ghosts) {
    var out = {};
    var boxes = [];
    ghosts.forEach(function (gh) {
      if (!gh || !gh.cells.length) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minD = Infinity;
      gh.cells.forEach(function (c) {
        var col = column(L.G, c[0], c[2]);
        [c[1] * L.LH, (c[1] + 1) * L.LH].forEach(function (y) {
          col.poly.forEach(function (q) {
            var p = proj(L, q[0], y, q[1]);
            if (p[0] < minX) minX = p[0];
            if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1];
            if (p[1] > maxY) maxY = p[1];
          });
        });
        minD = Math.min(minD, cellDepth(L, c));
      });
      boxes.push({ minX: minX, minY: minY, maxX: maxX, maxY: maxY, d: minD });
    });
    if (!boxes.length) return out;
    var r = L.k * 0.9;
    for (var i = 0; i < board.length; i++) {
      if (board[i] < 0) continue;
      var c = coordOf(topo, i);
      var d = cellDepth(L, c);
      var cc = cellCenter(L, c);
      var center = proj(L, cc[0], cc[1], cc[2]);
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
    var best = null, bestD = -Infinity;
    L.S.columns.forEach(function (xz) {
      var x = xz[0], z = xz[1];
      var h = hm[z * topo.cols + x], hw = h * L.LH;
      var col = column(L.G, x, z);
      // 顶面，以及整列可见的侧面：指着塔身也算选中这一列
      var polys = [col.poly.map(function (p) { return [p[0], hw, p[1]]; })];
      if (h > 0) {
        col.sides.forEach(function (s) {
          if (visible(L, s.n)) polys.push([[s.a[0], 0, s.a[1]], [s.b[0], 0, s.b[1]], [s.b[0], hw, s.b[1]], [s.a[0], hw, s.a[1]]]);
        });
      }
      for (var q = 0; q < polys.length; q++) {
        if (pointIn(px, py, polys[q].map(function (p) { return proj(L, p[0], p[1], p[2]); }))) {
          var d = depthOf(L, col.cx, hw, col.cz);
          if (d > bestD) { bestD = d; best = { x: x, z: z }; }
          break;
        }
      }
    });
    return best;
  }

  // 屏幕方向 → 与之最接近的一步（方向键随视角变化；三棱柱只走保持朝向的步子）
  function screenStep(view, dir, kind) {
    var cam = view.cam || DEFAULT_CAM;
    var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    var v = dir === 'right' ? [cy, -sy] : dir === 'left' ? [-cy, sy] : dir === 'down' ? [sy, cy] : [-sy, -cy];
    var G = geomOf(kind);
    var best = G.steps[0], bd = -Infinity;
    G.steps.forEach(function (s) {
      var w = G.stepVec(s), len = Math.sqrt(w[0] * w[0] + w[1] * w[1]);
      var d = (w[0] * v[0] + w[1] * v[1]) / len;
      if (d > bd) { bd = d; best = s; }
    });
    return best;
  }

  // 与屏幕水平方向最接近的世界轴（向前翻用）和另一条水平轴（侧翻用）
  function screenAxes(view) {
    var cam = view.cam || DEFAULT_CAM;
    var horizX = Math.abs(Math.cos(cam.yaw)) >= Math.abs(Math.sin(cam.yaw));
    return { tip: horizX ? 0 : 2, roll: horizX ? 2 : 0 };
  }

  /* ---------- 托盘图标（SVG） ---------- */

  function fmt(pts) { return pts.map(function (p) { return p[0].toFixed(3) + ',' + p[1].toFixed(3); }).join(' '); }

  function pieceSVG(orient, cam, box, kind) {
    cam = cam || DEFAULT_CAM;
    var G = geomOf(kind);
    var L = {
      G: G, LH: G.layerH,
      cx: 0, cz: 0,
      cyaw: Math.cos(cam.yaw), syaw: Math.sin(cam.yaw),
      cp: Math.cos(cam.pitch), sp: Math.sin(cam.pitch),
      k: 1, ox: 0, oy: 0
    };
    orient.cells.forEach(function (c) {
      var col = column(G, c[0], c[2]);
      L.cx += col.cx / orient.cells.length;
      L.cz += col.cz / orient.cells.length;
    });
    var has = {};
    orient.cells.forEach(function (c) { has[c.join(',')] = 1; });
    var polys = [];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    orient.cells.slice().sort(function (a, b) { return cellDepth(L, a) - cellDepth(L, b); }).forEach(function (c) {
      var col = column(G, c[0], c[2]);
      cellFaces(L, c).forEach(function (f) {
        var nb = f.kind === 'top' ? [c[0], c[1] + 1, c[2]] : [col.sides[f.k].nb[0], c[1], col.sides[f.k].nb[1]];
        if (has[nb.join(',')]) return;
        var pts = f.pts.map(function (p) { return proj(L, p[0], p[1], p[2]); });
        pts.forEach(function (p) {
          minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
          minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
        });
        var tone = f.kind === 'top' ? -1 : sideTone(L, f.n);
        polys.push({ pts: pts, tone: tone });
      });
    });
    var B = Math.max(box || G.box, maxX - minX + 0.2, maxY - minY + 0.2);
    var ox = (minX + maxX) / 2 - B / 2, oy = (minY + maxY) / 2 - B / 2;
    var out = '<svg viewBox="' + [ox, oy, B, B].map(function (v) { return v.toFixed(3); }).join(' ') + '" aria-hidden="true">';
    polys.forEach(function (p) {
      out += '<polygon points="' + fmt(p.pts) + '" style="fill:var(--c)" stroke="#000" stroke-opacity=".28" stroke-width=".05" stroke-linejoin="round"/>';
      if (p.tone < 0) out += '<polygon points="' + fmt(p.pts) + '" fill="#fff" fill-opacity=".3"/>';
      else if (p.tone > 0.02) out += '<polygon points="' + fmt(p.pts) + '" fill="#000" fill-opacity="' + (p.tone * 1.1).toFixed(2) + '"/>';
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
