/*
 * 角斗士棋界面：开局设置、联机房间、棋盘绘制（方格 / 三角格）、人机交互、电脑回合调度、存档。
 */
(function () {
  'use strict';

  var Pieces = BlokusPieces;
  var Engine = BlokusEngine;
  var AI = BlokusAI;
  var LLM = BlokusLLM;
  var Online = BlokusOnline;
  var Net = BlokusNet;
  var Record = BlokusRecord;
  var EMPTY = Engine.EMPTY;

  var MODE_LIST = ['classic', 'duo', 'trigon', 'gemblo', 'cube', 'prism'];
  var MODE_LABEL = { classic: '标准 20×20', duo: '双人 14×14', trigon: '三角块', gemblo: '宝石阵', cube: '立体', prism: '三棱柱' };
  var MODE_NOTE = {
    classic: '21 块方块棋子，四人各从棋盘一角出发。',
    duo: '两人对战，从棋盘内侧的两个起点出发。',
    trigon: '22 块三角棋子，6 个公共起点；4 人用边长 9 的六边形棋盘，人少时棋盘相应缩小。',
    gemblo: '原版 Gemblo：六边形格棋盘，每人 18 块（1–5 格）。同色棋子不能接触，新棋子要和自己的棋子尖对尖、隔开一条边。3、4、6 方参战，人少时只用棋盘中间的区域。',
    cube: '三维新玩法：棋子从上方落下，叠在地面或任何人的棋子上，限高 5 层。自己的棋子不能面贴面，必须棱或角相接。每人 12 块立方体棋子。',
    prism: '三角格版的立体玩法：六边形地面由三角形组成，每格是一个三棱柱，棋子落下堆叠。自己的棋子不能面贴面，必须棱或角相接。每人 19 块三棱柱棋子（1–4 格）。'
  };
  var LEVEL_LABEL = { easy: '简单', normal: '普通', hard: '困难', expert: '大师', llm: '大模型' };
  var SPEED_MS = { fast: 200, normal: 550, slow: 1100 };
  var REASON_TEXT = {
    used: '这块棋子已经用过了',
    bounds: '超出棋盘范围',
    occupied: '这里已经有棋子了',
    edge: '不能和自己的棋子边贴边',
    start: '第一块必须盖住起点',
    corner: '必须和自己的棋子角对角相接',
    apex: '必须和自己的棋子尖对尖、隔开一条边（中间那条边不能被别人的同一块棋子挡住）',
    over: '对局已经结束',
    ceiling: '叠得太高了：最多 5 层',
    float: '棋子会一直落到底，不能悬空'
  };
  var View3D = BlokusView3D;
  var STORE_PREFS = 'blokus.prefs.v1';
  var STORE_SAVE = 'blokus.save.v1';
  var STORE_ONLINE = 'blokus.online.v1';
  var STORE_TOKENS = 'blokus.tokens.v1';
  var STORE_LLM = 'blokus.llm.v1';
  var STORE_RECORDS = 'blokus.records.v1';
  var RECORD_LIMIT = 60;
  var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DROP_MS = REDUCED_MOTION ? 0 : 240;

  function $(id) { return document.getElementById(id); }

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function save(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* 存储不可用时忽略 */ }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function sameCell(a, b) { return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z; }
  function copyCell(c) { return c.z === undefined ? { x: c.x, y: c.y } : { x: c.x, z: c.z }; }

  /* ================= 主题颜色 ================= */

  var palette = { colors: {} };
  var themeVersion = 0;

  function readPalette() {
    var cs = getComputedStyle(document.documentElement);
    function get(n) { return cs.getPropertyValue(n).trim(); }
    palette = {
      frame: get('--board-frame'),
      cell: get('--board-cell'),
      groove: get('--board-groove'),
      ink: get('--ink'),
      bg: get('--bg'),
      danger: get('--danger'),
      colors: {
        blue: get('--p-blue'),
        yellow: get('--p-yellow'),
        red: get('--p-red'),
        green: get('--p-green'),
        violet: get('--p-violet'),
        orange: get('--p-orange')
      }
    };
    themeVersion++;
  }

  function onThemeChange() {
    readPalette();
    if (game.view) game.view.draw();
    if (demo.view) demo.view.draw();
  }

  // 主题只看自己的设置（默认浅色），不跟随系统或外层页面
  function applyTheme() {
    var dark = prefs.theme === 'dark';
    document.documentElement.setAttribute('data-scheme', dark ? 'dark' : 'light');
    $('theme-btn').setAttribute('aria-pressed', dark ? 'true' : 'false');
    $('opt-dark').checked = dark;
  }

  function setTheme(dark) {
    prefs.theme = dark ? 'dark' : 'light';
    savePrefs();
    applyTheme();
    onThemeChange();
  }

  /* ================= 多边形工具 ================= */

  function polyCentroid(poly) {
    var x = 0, y = 0;
    poly.forEach(function (v) { x += v[0]; y += v[1]; });
    return [x / poly.length, y / poly.length];
  }

  // 正多边形的内切圆半径（中心到各边的最短距离）
  function inradius(poly, c) {
    var r = Infinity;
    for (var k = 0; k < poly.length; k++) {
      var a = poly[k], b = poly[(k + 1) % poly.length];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var d = Math.abs(dx * (a[1] - c[1]) - dy * (a[0] - c[0])) / (Math.sqrt(dx * dx + dy * dy) || 1);
      if (d < r) r = d;
    }
    return r;
  }

  function shrink(poly, c, f) {
    return poly.map(function (v) { return [c[0] + (v[0] - c[0]) * f, c[1] + (v[1] - c[1]) * f]; });
  }

  function pathPoly(g, poly) {
    g.beginPath();
    g.moveTo(poly[0][0], poly[0][1]);
    for (var k = 1; k < poly.length; k++) g.lineTo(poly[k][0], poly[k][1]);
    g.closePath();
  }

  function pointInPoly(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /* ================= 棋盘绘制 ================= */

  // 一格塑料棋子：斜面高光 + 内凸台（方格、三角格通用）
  function makeTile(color, poly, w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var g = c.getContext('2d');
    var cen = polyCentroid(poly);
    var r = inradius(poly, cen);
    var gap = Math.max(0.6, r * 0.1);
    var outer = shrink(poly, cen, (r - gap) / r);
    var inner = shrink(outer, cen, 0.72);
    pathPoly(g, outer);
    g.fillStyle = color;
    g.fill();
    for (var k = 0; k < outer.length; k++) {
      var a = outer[k], b = outer[(k + 1) % outer.length];
      var a2 = inner[k], b2 = inner[(k + 1) % inner.length];
      var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.sqrt(dx * dx + dy * dy) || 1;
      var light = (dy / len) * -0.55 + (-dx / len) * -0.83;
      g.beginPath();
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(b2[0], b2[1]); g.lineTo(a2[0], a2[1]);
      g.closePath();
      g.fillStyle = light > 0 ? 'rgba(255,255,255,' + (0.36 * light).toFixed(3) + ')' : 'rgba(0,0,0,' + (0.26 * -light).toFixed(3) + ')';
      g.fill();
    }
    var top = Infinity, bottom = -Infinity;
    inner.forEach(function (v) { top = Math.min(top, v[1]); bottom = Math.max(bottom, v[1]); });
    var grad = g.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, 'rgba(255,255,255,0.16)');
    grad.addColorStop(1, 'rgba(0,0,0,0.05)');
    pathPoly(g, inner);
    g.fillStyle = grad;
    g.fill();
    var nub = shrink(outer, cen, 0.42);
    g.lineWidth = Math.max(1, r * 0.07);
    pathPoly(g, nub);
    g.strokeStyle = 'rgba(0,0,0,0.13)';
    g.stroke();
    pathPoly(g, nub.map(function (v) { return [v[0] - g.lineWidth, v[1] - g.lineWidth]; }));
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.stroke();
    return c;
  }

  function BoardView(canvas, getState, getOverlay) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getState = getState;
    this.getOverlay = getOverlay;
    this.css = 0;
    this.dpr = 1;
    this.L = null;
    this.tiles = {};
    this.tilesKey = '';
    this.bgKey = '';
    this.bgCanvas = null;
  }

  BoardView.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var css = Math.max(40, Math.floor(rect.width));
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    if (css === this.css && dpr === this.dpr) return false;
    this.css = css;
    this.dpr = dpr;
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
    this.L = null;
    return true;
  };

  // 顶点坐标 -> 画布像素
  BoardView.prototype.layout = function (topo) {
    if (this.L && this.L.topo === topo && this.L.css === this.css) return this.L;
    var b = topo.bounds, css = this.css;
    var pad = Math.max(6, css * 0.026);
    var wS = (b.maxVX - b.minVX) * topo.unitX, hS = (b.maxVY - b.minVY) * topo.unitY;
    var k = Math.min((css - 2 * pad) / wS, (css - 2 * pad) / hS);
    var sx = topo.unitX * k, sy = topo.unitY * k;
    var L = {
      topo: topo,
      css: css,
      pad: pad,
      k: k,
      sx: sx,
      sy: sy,
      ox: (css - wS * k) / 2 - b.minVX * sx,
      oy: (css - hS * k) / 2 - b.minVY * sy,
      inr: topo.kind === 'tri' ? k * 0.2887 : k * 0.5,
      box: new Float64Array(topo.n * 4)
    };
    topo.cells.forEach(function (i) {
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      topo.polys[i].forEach(function (v) {
        var x = L.ox + v[0] * sx, y = L.oy + v[1] * sy;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      });
      L.box[i * 4] = x0;
      L.box[i * 4 + 1] = y0;
      L.box[i * 4 + 2] = x1 - x0;
      L.box[i * 4 + 3] = y1 - y0;
    });
    this.L = L;
    return L;
  };

  function vpx(L, v) { return [L.ox + v[0] * L.sx, L.oy + v[1] * L.sy]; }
  function cellPolyPx(L, i) { return L.topo.polys[i].map(function (v) { return vpx(L, v); }); }
  function cellCenterPx(L, i) { return [L.ox + L.topo.centroids[i * 2] * L.k, L.oy + L.topo.centroids[i * 2 + 1] * L.k]; }

  BoardView.prototype.cellAt = function (clientX, clientY, state) {
    var topo = state.topo;
    if (topo.dims === 3) return View3D.pick(this, state, clientX, clientY);
    var r = this.canvas.getBoundingClientRect();
    if (clientX < r.left || clientY < r.top || clientX > r.right || clientY > r.bottom) return null;
    var L = this.layout(topo);
    var vx = (clientX - r.left - L.ox) / L.sx, vy = (clientY - r.top - L.oy) / L.sy;
    if (topo.kind === 'square') {
      return { x: clamp(Math.floor(vx), 0, topo.cols - 1), y: clamp(Math.floor(vy), 0, topo.rows - 1) };
    }
    if (topo.kind === 'hex') {
      // 六边形格：找中心最近的格子
      var wx = vx * topo.unitX, wy = vy * topo.unitY, best = -1, bd = Infinity;
      for (var c = 0; c < topo.cells.length; c++) {
        var ci = topo.cells[c];
        var dx = topo.centroids[ci * 2] - wx, dy = topo.centroids[ci * 2 + 1] - wy;
        var dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; best = ci; }
      }
      return best >= 0 && bd < 0.36 ? { x: best % topo.cols, y: Math.floor(best / topo.cols) } : null;
    }
    var y = Math.floor(vy);
    if (y < 0 || y >= topo.rows) return null;
    var fx = Math.floor(vx);
    for (var x = fx - 2; x <= fx + 1; x++) {
      if (x < 0 || x >= topo.cols) continue;
      var i = y * topo.cols + x;
      if (topo.valid[i] && pointInPoly(vx, vy, topo.polys[i])) return { x: x, y: y };
    }
    return null;
  };

  BoardView.prototype.tile = function (color, L, i) {
    var topo = L.topo;
    var key = this.css + '|' + this.dpr + '|' + themeVersion + '|' + topo.kind + topo.size;
    if (this.tilesKey !== key) {
      this.tiles = {};
      this.tilesKey = key;
    }
    var shape = topo.kind !== 'tri' ? topo.kind.charAt(0) : (((i % topo.cols) + Math.floor(i / topo.cols)) & 1) ? 'd' : 'u';
    var tk = color + shape;
    if (!this.tiles[tk]) {
      var bx = L.box[i * 4], by = L.box[i * 4 + 1], bw = L.box[i * 4 + 2], bh = L.box[i * 4 + 3];
      var dpr = this.dpr;
      var poly = cellPolyPx(L, i).map(function (v) { return [(v[0] - bx) * dpr, (v[1] - by) * dpr]; });
      this.tiles[tk] = makeTile(color, poly, Math.max(2, Math.ceil(bw * dpr)), Math.max(2, Math.ceil(bh * dpr)));
    }
    return this.tiles[tk];
  };

  BoardView.prototype.background = function (topo) {
    var key = topo.kind + topo.size + '|' + this.css + '|' + this.dpr + '|' + themeVersion;
    if (this.bgKey === key) return this.bgCanvas;
    var c = document.createElement('canvas');
    c.width = c.height = Math.round(this.css * this.dpr);
    var g = c.getContext('2d');
    g.scale(this.dpr, this.dpr);
    var L = this.layout(topo);
    var outline = topo.outline.map(function (v) { return vpx(L, v); });
    g.lineJoin = 'round';
    pathPoly(g, outline);
    g.fillStyle = palette.frame;
    g.strokeStyle = palette.frame;
    g.lineWidth = L.pad * 1.7;
    g.fill();
    g.stroke();
    pathPoly(g, outline);
    g.fillStyle = palette.groove;
    g.fill();
    g.fillStyle = palette.cell;
    var f = topo.kind === 'tri' ? 0.8 : 0.88;
    topo.cells.forEach(function (i) {
      var poly = cellPolyPx(L, i);
      pathPoly(g, shrink(poly, polyCentroid(poly), f));
      g.fill();
    });
    this.bgKey = key;
    this.bgCanvas = c;
    return c;
  };

  BoardView.prototype.drawCell = function (L, i, color, alpha, scale) {
    var g = this.ctx;
    var bx = L.box[i * 4], by = L.box[i * 4 + 1], bw = L.box[i * 4 + 2], bh = L.box[i * 4 + 3];
    if (scale && scale !== 1) {
      var c = cellCenterPx(L, i);
      bx = c[0] + (bx - c[0]) * scale;
      by = c[1] + (by - c[1]) * scale;
      bw *= scale;
      bh *= scale;
    }
    g.globalAlpha = alpha == null ? 1 : alpha;
    g.drawImage(this.tile(color, L, i), bx, by, bw, bh);
    g.globalAlpha = 1;
  };

  BoardView.prototype.outline = function (L, cells, style, width, dash) {
    var g = this.ctx, topo = L.topo;
    var set = {};
    cells.forEach(function (i) { set[i] = 1; });
    g.save();
    g.strokeStyle = style;
    g.lineWidth = width;
    g.lineCap = 'round';
    if (dash) g.setLineDash(dash);
    g.beginPath();
    cells.forEach(function (i) {
      var poly = topo.polys[i];
      if (!poly) return;
      var across = topo.across[i];
      for (var k = 0; k < poly.length; k++) {
        if (set[across[k]]) continue;
        var a = vpx(L, poly[k]), b = vpx(L, poly[(k + 1) % poly.length]);
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
      }
    });
    g.stroke();
    g.restore();
  };

  BoardView.prototype.draw = function (now) {
    var state = this.getState();
    if (!state || !this.css) return;
    var ov = this.getOverlay ? this.getOverlay() : {};
    now = now || performance.now();
    if (state.topo.dims === 3) {
      ov.dropMs = DROP_MS;
      ov.pulse = REDUCED_MOTION ? 1 : 0.55 + 0.45 * Math.sin(now / 220);
      View3D.draw(this, state, ov, palette, now);
      return;
    }
    var g = this.ctx, self = this, topo = state.topo;
    var L = this.layout(topo);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.css, this.css);
    g.drawImage(this.background(topo), 0, 0, this.css, this.css);

    function colorOf(p) { return palette.colors[state.players[p].color] || palette.ink; }
    function ring(i, color, filled, alpha) {
      var c = cellCenterPx(L, i);
      g.beginPath();
      g.arc(c[0], c[1], L.inr * 0.6, 0, Math.PI * 2);
      if (filled) {
        g.globalAlpha = 0.3;
        g.fillStyle = color;
        g.fill();
      }
      g.globalAlpha = alpha;
      g.lineWidth = Math.max(1.5, L.inr * 0.2);
      g.strokeStyle = color;
      g.stroke();
      g.globalAlpha = 1;
    }

    // 起点
    var shared = state.players.some(function (pl) { return pl.startIdx.length > 1; });
    if (shared) {
      var cp = state.players[state.current];
      var firstMove = !state.over && cp && cp.placed === 0;
      state.players[0].startIdx.forEach(function (i) {
        if (state.board[i] !== EMPTY) return;
        ring(i, firstMove ? colorOf(state.current) : palette.ink, firstMove, firstMove ? 1 : 0.4);
      });
    } else {
      state.players.forEach(function (pl, p) {
        if (pl.placed > 0) return;
        pl.startIdx.forEach(function (i) { ring(i, colorOf(p), p === state.current && !state.over, 1); });
      });
    }

    // 已落棋子
    var anim = ov.anim, animSet = null, animT = 1;
    if (anim) {
      animT = DROP_MS ? clamp((now - anim.t0) / DROP_MS, 0, 1) : 1;
      animSet = {};
      anim.cells.forEach(function (i) { animSet[i] = 1; });
    }
    var board = state.board;
    topo.cells.forEach(function (i) {
      var v = board[i];
      if (v < 0 || (animSet && animSet[i])) return;
      self.drawCell(L, i, colorOf(v));
    });
    if (anim) {
      var ease = 1 - Math.pow(1 - animT, 3);
      anim.cells.forEach(function (i) { self.drawCell(L, i, colorOf(anim.player), 0.35 + 0.65 * ease, 1.28 - 0.28 * ease); });
    }

    // 上一步高亮
    if (ov.lastMove && (!anim || animT >= 1)) {
      this.outline(L, ov.lastMove, palette.ink, Math.max(1.5, L.inr * 0.18));
    }

    // 角点提示
    if (ov.anchors && ov.anchors.list.length) {
      g.fillStyle = ov.anchors.color;
      g.globalAlpha = 0.55;
      ov.anchors.list.forEach(function (i) {
        var c = cellCenterPx(L, i);
        g.beginPath();
        g.arc(c[0], c[1], L.inr * 0.28, 0, Math.PI * 2);
        g.fill();
      });
      g.globalAlpha = 1;
    }

    // 提示走法
    if (ov.hint) {
      g.globalAlpha = REDUCED_MOTION ? 1 : 0.55 + 0.45 * Math.sin(now / 220);
      this.outline(L, ov.hint.cells, ov.hint.color, Math.max(2, L.inr * 0.24), [L.k * 0.25, L.k * 0.18]);
      g.globalAlpha = 1;
    }

    // 其他玩家正在尝试的位置（联机）
    if (ov.remote) {
      var rm = ov.remote;
      rm.cells.forEach(function (i) { self.drawCell(L, i, rm.color, 0.42); });
      this.outline(L, rm.cells, rm.color, Math.max(1.5, L.inr * 0.22), [L.k * 0.22, L.k * 0.14]);
    }

    // 待放置棋子
    if (ov.ghost) {
      var gh = ov.ghost;
      gh.cells.forEach(function (i) { self.drawCell(L, i, gh.color, gh.valid ? 0.72 : 0.38); });
      if (!gh.valid) {
        g.fillStyle = palette.danger;
        g.globalAlpha = 0.28;
        gh.cells.forEach(function (i) {
          pathPoly(g, cellPolyPx(L, i));
          g.fill();
        });
        g.globalAlpha = 1;
      }
      this.outline(L, gh.cells, gh.valid ? palette.ink : palette.danger, Math.max(1.5, L.inr * 0.18), gh.valid ? null : [L.k * 0.2, L.k * 0.14]);
    }
  };

  /* ================= 棋子图形（托盘 / 预览） ================= */

  function fmtPts(poly) {
    return poly.map(function (v) { return v[0].toFixed(3) + ',' + v[1].toFixed(3); }).join(' ');
  }

  function pieceSVG(orient, box) {
    var B = box;
    var ox = (B - orient.boxW) / 2, oy = (B - orient.boxH) / 2;
    var out = '<svg viewBox="-0.1 -0.1 ' + (B + 0.2).toFixed(2) + ' ' + (B + 0.2).toFixed(2) + '" aria-hidden="true">';
    orient.polys.forEach(function (poly) {
      var pts = poly.map(function (v) { return [v[0] + ox, v[1] + oy]; });
      var c = polyCentroid(pts), r = inradius(pts, c);
      out += '<polygon points="' + fmtPts(shrink(pts, c, (r - 0.05) / r)) + '" style="fill:var(--c)"/>' +
        '<polygon points="' + fmtPts(shrink(pts, c, 0.46)) + '" fill="#fff" fill-opacity="0.2"/>';
    });
    return out + '</svg>';
  }

  /* ================= 音效 ================= */

  var audio = null;
  function unlockAudio() {
    try {
      if (!audio) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audio = new Ctx();
      }
      if (audio && audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }

  function sound(kind, quiet) {
    if (!prefs.sound || !audio || audio.state !== 'running') return;
    var t = audio.currentTime;
    var k = quiet ? 0.5 : 1;
    function tone(freq, start, dur, type, gain) {
      var o = audio.createOscillator();
      var gn = audio.createGain();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(freq, t + start);
      gn.gain.setValueAtTime(0.0001, t + start);
      gn.gain.exponentialRampToValueAtTime(gain * k, t + start + 0.008);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      o.connect(gn);
      gn.connect(audio.destination);
      o.start(t + start);
      o.stop(t + start + dur + 0.03);
    }
    if (kind === 'place') { tone(300, 0, 0.09, 'square', 0.035); tone(180, 0.005, 0.12, 'triangle', 0.09); }
    else if (kind === 'bad') { tone(150, 0, 0.16, 'sawtooth', 0.035); }
    else if (kind === 'turn') { tone(660, 0, 0.1, 'sine', 0.06); tone(990, 0.09, 0.16, 'sine', 0.05); }
    else if (kind === 'win') { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.11, 0.3, 'triangle', 0.07); }); }
  }

  /* ================= 设置 ================= */

  function defaultSeats(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push({ type: i === 0 ? 'human' : 'ai', level: 'normal', name: '', model: '' });
    return out;
  }

  var DEFAULT_PREFS = {
    mode: 'classic',
    tab: 'local',
    nick: '',
    seats: { classic: defaultSeats(4), duo: defaultSeats(2), trigon: defaultSeats(4), gemblo: defaultSeats(6), cube: defaultSeats(4), prism: defaultSeats(4) },
    hints: true,
    sound: true,
    speed: 'normal',
    theme: 'light'
  };

  function loadPrefs() {
    var p = JSON.parse(JSON.stringify(DEFAULT_PREFS));
    var saved = load(STORE_PREFS);
    if (!saved || typeof saved !== 'object') return p;
    if (Engine.isMode(saved.mode)) p.mode = saved.mode;
    if (saved.tab === 'online') p.tab = 'online';
    if (typeof saved.nick === 'string') p.nick = Online.cleanName(saved.nick);
    MODE_LIST.forEach(function (m) {
      var list = saved.seats && saved.seats[m];
      if (!Array.isArray(list)) return;
      p.seats[m].forEach(function (seat, i) {
        var s = list[i];
        if (!s) return;
        if (['human', 'ai', 'off'].indexOf(s.type) >= 0 && !(m === 'duo' && s.type === 'off')) seat.type = s.type;
        if (Object.prototype.hasOwnProperty.call(LEVEL_LABEL, s.level)) seat.level = s.level;
        if (typeof s.name === 'string') seat.name = s.name.slice(0, 12);
        if (typeof s.model === 'string') seat.model = LLM.profileName(s.model);
      });
    });
    if (typeof saved.hints === 'boolean') p.hints = saved.hints;
    if (typeof saved.sound === 'boolean') p.sound = saved.sound;
    if (Object.prototype.hasOwnProperty.call(SPEED_MS, saved.speed)) p.speed = saved.speed;
    if (saved.theme === 'dark') p.theme = 'dark';
    return p;
  }

  var prefs = loadPrefs();
  function savePrefs() { save(STORE_PREFS, prefs); }

  var FOUR_PRESETS = [
    { label: '1 人 + 3 电脑', types: ['human', 'ai', 'ai', 'ai'] },
    { label: '2 人 + 2 电脑', types: ['human', 'ai', 'human', 'ai'] },
    { label: '3 人 + 1 电脑', types: ['human', 'human', 'human', 'ai'] },
    { label: '4 人同屏', types: ['human', 'human', 'human', 'human'] },
    { label: '电脑观战', types: ['ai', 'ai', 'ai', 'ai'] }
  ];
  var PRESETS = {
    classic: FOUR_PRESETS,
    trigon: FOUR_PRESETS,
    cube: FOUR_PRESETS,
    prism: FOUR_PRESETS,
    gemblo: [
      { label: '1 人 + 5 电脑', types: ['human', 'ai', 'ai', 'ai', 'ai', 'ai'] },
      { label: '1 人 + 3 电脑', types: ['human', 'ai', 'ai', 'ai', 'off', 'off'] },
      { label: '1 人 + 2 电脑', types: ['human', 'ai', 'ai', 'off', 'off', 'off'] },
      { label: '3 人 + 3 电脑', types: ['human', 'ai', 'human', 'ai', 'human', 'ai'] },
      { label: '6 人同屏', types: ['human', 'human', 'human', 'human', 'human', 'human'] },
      { label: '电脑观战', types: ['ai', 'ai', 'ai', 'ai', 'ai', 'ai'] }
    ],
    duo: [
      { label: '人机对战', types: ['human', 'ai'] },
      { label: '双人同屏', types: ['human', 'human'] },
      { label: '电脑观战', types: ['ai', 'ai'] }
    ]
  };

  function seatTypeOptions(mode) {
    var opts = [['human', '玩家'], ['ai', '电脑']];
    if (mode !== 'duo') opts.push(['off', '空位']);
    return opts;
  }

  function renderSetup() {
    var mode = prefs.mode;
    $('mode-' + mode).checked = true;
    $('mode-note').textContent = MODE_NOTE[mode];
    $('opt-hints').checked = prefs.hints;
    $('opt-sound').checked = prefs.sound;
    $('opt-speed').value = prefs.speed;
    $('opt-dark').checked = prefs.theme === 'dark';
    var onlineTab = prefs.tab === 'online';
    $('tab-local').setAttribute('aria-selected', onlineTab ? 'false' : 'true');
    $('tab-online').setAttribute('aria-selected', onlineTab ? 'true' : 'false');
    $('local-panel').hidden = onlineTab;
    $('online-panel').hidden = !onlineTab;

    var presets = $('presets');
    presets.innerHTML = '';
    PRESETS[mode].forEach(function (pr, k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.id = 'preset-' + mode + '-' + k;
      b.textContent = pr.label;
      var seats = prefs.seats[mode];
      if (pr.types.every(function (t, i) { return seats[i].type === t; })) b.classList.add('active');
      b.addEventListener('click', function () {
        pr.types.forEach(function (t, i) { seats[i].type = t; });
        savePrefs();
        renderSetup();
      });
      presets.appendChild(b);
    });

    var list = $('seats');
    list.innerHTML = '';
    var humanNo = 0;
    var humans = prefs.seats[mode].filter(function (s) { return s.type === 'human'; }).length;
    Engine.MODES[mode].seats.forEach(function (seat, i) {
      var s = prefs.seats[mode][i];
      var li = document.createElement('li');
      li.className = 'seat' + (s.type === 'off' ? ' off' : '');
      li.style.setProperty('--c', 'var(--p-' + seat.color + ')');
      if (s.type === 'human') humanNo++;
      var placeholder = s.type === 'human' ? (humans === 1 ? '你' : '玩家' + humanNo) : s.type === 'ai' ? seat.label + '方电脑' : '空位';
      var typeRadios = seatTypeOptions(mode).map(function (o) {
        return '<label><input type="radio" name="seat-type-' + i + '" id="seat-type-' + i + '-' + o[0] + '" value="' + o[0] + '"' +
          (s.type === o[0] ? ' checked' : '') + '><span>' + o[1] + '</span></label>';
      }).join('');
      var levelRadios = Object.keys(LEVEL_LABEL).map(function (lv) {
        return '<label><input type="radio" name="seat-level-' + i + '" id="seat-level-' + i + '-' + lv + '" value="' + lv + '"' +
          (s.level === lv ? ' checked' : '') + '><span>' + LEVEL_LABEL[lv] + '</span></label>';
      }).join('');
      li.innerHTML =
        '<span class="seat-swatch" aria-hidden="true">' + seat.label + '</span>' +
        '<input type="text" class="seat-name" id="seat-name-' + i + '" maxlength="12" aria-label="' + seat.label + '方名字"' +
        ' placeholder="' + placeholder + '" value="' + (s.type === 'human' ? escapeHtml(s.name) : '') + '"' + (s.type === 'human' ? '' : ' disabled') + '>' +
        '<div class="seg small seat-type" role="radiogroup" aria-label="' + seat.label + '方">' + typeRadios + '</div>' +
        '<div class="seat-level"' + (s.type === 'ai' ? '' : ' hidden') + '>难度 <div class="seg small" role="radiogroup" aria-label="电脑难度">' + levelRadios + '</div>' +
        (s.level === 'llm' ? '<label class="seat-model">模型 <select id="seat-model-' + i + '" aria-label="' + seat.label + '方用的模型">' + profileOptions(s.model) + '</select></label>' : '') +
        '</div>';
      li.querySelector('.seat-name').addEventListener('input', function (e) {
        s.name = e.target.value;
        savePrefs();
      });
      li.querySelectorAll('input[name="seat-type-' + i + '"]').forEach(function (r) {
        r.addEventListener('change', function () {
          s.type = r.value;
          savePrefs();
          renderSetup();
          var again = $('seat-type-' + i + '-' + r.value);
          if (again) again.focus();
        });
      });
      li.querySelectorAll('input[name="seat-level-' + i + '"]').forEach(function (r) {
        r.addEventListener('change', function () {
          s.level = r.value;
          savePrefs();
          renderSetup();
          var again = $('seat-level-' + i + '-' + r.value);
          if (again) again.focus();
          if (r.value === 'llm') ensureLLMSetup(s.model);
        });
      });
      var modelSel = li.querySelector('#seat-model-' + i);
      if (modelSel) {
        modelSel.addEventListener('change', function () {
          s.model = modelSel.value;
          savePrefs();
          ensureLLMSetup(s.model);
        });
      }
      list.appendChild(li);
    });

    $('setup-error').hidden = true;
    $('resume-btn').hidden = !loadSaved();
    renderOnlinePanel();
  }

  function buildLocalConfig() {
    var mode = prefs.mode;
    var seats = prefs.seats[mode];
    var humans = seats.filter(function (s) { return s.type === 'human'; }).length;
    var entries = [];
    var humanNo = 0;
    Engine.MODES[mode].seats.forEach(function (seat, i) {
      var s = seats[i];
      if (s.type === 'off') return;
      var name = s.name.trim();
      if (s.type === 'human') {
        humanNo++;
        if (!name) name = humans === 1 ? '你' : '玩家' + humanNo;
      } else {
        name = seat.label + '方电脑';
      }
      var entry = { seat: i, name: name, type: s.type, level: s.level };
      if (s.type === 'ai' && s.level === 'llm') entry.model = llmProfile(s.model).name;
      entries.push(entry);
    });
    if (entries.length < 2 || !Engine.validCount(mode, entries.length)) return null;
    return Engine.buildConfig(mode, entries);
  }

  /* ================= 大师搜索与大模型电脑 ================= */

  var llm = {
    cfg: LLM.normalizeConfig(load(STORE_LLM)),
    saved: !!load(STORE_LLM),
    sample: null,
    sampleP: null,
    lastError: '',
    // 设置框里正在编辑的副本
    dcfg: null,
    didx: 0,
    dialogProvider: 'openai'
  };

  function inClaudePage() {
    return !!window.claude && typeof window.claude.use === 'function';
  }

  // Claude 发布的页面自带的 Claude（页面没有声明或不在查看器里时为 null）
  function claudeSample() {
    if (!llm.sampleP) {
      llm.sampleP = !inClaudePage() ? Promise.resolve(null) : Promise.resolve(window.claude.use('sample')).then(function (fn) {
        llm.sample = typeof fn === 'function' ? fn : null;
        return llm.sample;
      }, function () { return null; });
    }
    return llm.sampleP;
  }

  // 在 Claude 发布的页面里、还没保存过设置时，默认用页面自带的 Claude（页面不能访问外部网络）
  function withClaudeDefault(cfg) {
    if (llm.saved || !llm.sample) return cfg;
    var out = LLM.normalizeConfig(cfg);
    out.profiles.forEach(function (p) { p.provider = 'claude'; });
    return out;
  }

  // 座位用的模型配置：按名字找，找不到用第一个
  function llmProfile(name) {
    return LLM.findProfile(withClaudeDefault(llm.cfg), name);
  }

  function profileReady(p) {
    return LLM.isReady(p) && (p.provider !== 'claude' || !!llm.sample);
  }

  function llmReady(name) { return profileReady(llmProfile(name)); }

  function profileNames() {
    return llm.cfg.profiles.map(function (p) { return p.name; });
  }

  function profileOptions(selected) {
    var names = profileNames();
    if (names.indexOf(selected) < 0) selected = names[0];
    return names.map(function (n) {
      return '<option value="' + escapeHtml(n) + '"' + (n === selected ? ' selected' : '') + '>' + escapeHtml(n) + '</option>';
    }).join('');
  }

  function llmEnv(signal) {
    return { signal: signal, sample: llm.sample, proxy: netInfo.net && netInfo.net.llmProxy ? 'api/llm' : null };
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * 大师搜索：在局面副本上分段推演（每段约 12 毫秒），不卡界面。
   * isLive() 为假时停止（Promise 失败）；完成后得到推演结果，按好坏排序。
   */
  function searchExpert(isLive) {
    var copy = Engine.replay(game.config, game.state.actions);
    var search = new AI.ExpertSearch(copy);
    return new Promise(function (resolve, reject) {
      (function tick() {
        if (!isLive()) { reject({ code: 'cancelled' }); return; }
        var t0 = Date.now();
        while (!search.done() && Date.now() - t0 < 12) search.step();
        if (search.done()) resolve(search.results());
        else setTimeout(tick, 0);
      })();
    });
  }

  /**
   * 大师 / 大模型电脑替当前玩家选一步：{ move, note }，大模型出错时还有 error（move 是大师的选择）。
   * 没有合法落子时 move 为 null；被取消时 Promise 失败。
   */
  function thinkMove(pl, isLive, signal) {
    return wait(20).then(function () {
      if (!isLive()) throw { code: 'cancelled' };
      return searchExpert(isLive);
    }).then(function (results) {
      var best = results.length ? results[0].move : null;
      if (pl.level !== 'llm' || !best) return { move: best, note: '' };
      return claudeSample().then(function () {
        if (!isLive()) throw { code: 'cancelled' };
        var profile = llmProfile(pl.model);
        if (!profileReady(profile)) return { move: best, error: 'setup', setup: true };
        return LLM.decide(game.state, profile, llmEnv(signal), results).then(function (r) {
          if (r.asked) llm.lastError = '';
          return { move: r.move || best, note: r.reason || '' };
        }, function (err) {
          if (err && err.code === 'cancelled') throw err;
          return { move: best, error: (profile.name ? profile.name + '：' : '') + ((err && err.message) || '调用失败') };
        });
      });
    });
  }

  // 同样的错误只提示一次
  function reportLLMError(r) {
    var msg = r.setup
      ? '还没设置好大模型，这一步由大师电脑代下（开局页面的「大模型设置」）'
      : '大模型出错（' + r.error + '），这一步由大师电脑代下';
    if (msg === llm.lastError) return;
    llm.lastError = msg;
    toast(msg, 'warn');
  }

  function ensureLLMSetup(name) {
    claudeSample().then(function () { if (!llmReady(name)) openLlmDialog(name); });
  }

  function lastNote(st, p) {
    for (var i = st.actions.length - 1; i >= 0; i--) {
      if (st.actions[i].player === p && st.actions[i].note) return st.actions[i].note;
    }
    return '';
  }

  // 重放时带上大模型落子附带的那句话
  function replayWithNotes(config, actions) {
    var st = Engine.replay(config, actions);
    for (var i = 0; i < st.actions.length; i++) {
      var a = actions[i];
      if (a && typeof a.note === 'string' && a.note) st.actions[i].note = a.note.slice(0, 60);
    }
    return st;
  }

  /* ---------- 设置框：多个模型配置 ---------- */

  function llmProviderValue() {
    var r = document.querySelector('input[name="llm-provider"]:checked');
    return r ? r.value : 'openai';
  }

  function currentDraft() { return llm.dcfg.profiles[llm.didx]; }

  // OpenAI 兼容接口和 Jev 的填写分开保存在配置里，切换来源时互不覆盖
  function showEndpoint(provider) {
    var ep = currentDraft()[provider];
    $('llm-url').value = ep.baseUrl;
    $('llm-key').value = ep.apiKey;
    $('llm-model').value = ep.model;
    $('llm-url').placeholder = provider === 'jev' ? LLM.JEV_URL : 'https://api.deepseek.com/v1';
    $('llm-model').placeholder = provider === 'jev' ? LLM.JEV_MODEL : '例如 deepseek-chat、gpt-4o-mini、qwen-plus';
    $('llm-key').placeholder = provider === 'jev' ? 'TypeSafe 或 OpenRouter 的密钥' : 'sk-…（本地模型可留空）';
  }

  function keepEndpoint(provider) {
    if (provider === 'claude' || !llm.dcfg) return;
    currentDraft()[provider] = { baseUrl: $('llm-url').value, apiKey: $('llm-key').value, model: $('llm-model').value };
  }

  function syncLlmProvider() {
    var p = llmProviderValue();
    $('llm-endpoint').hidden = p === 'claude';
    $('llm-claude').hidden = p !== 'claude';
    $('llm-openai-note').hidden = p !== 'openai';
    $('llm-jev-note').hidden = p !== 'jev';
    $('llm-jev-presets').hidden = p !== 'jev';
    $('llm-nothink-row').hidden = p !== 'openai';
    $('llm-artifact-note').hidden = p === 'claude' || !inClaudePage();
    if (p !== 'claude') showEndpoint(p);
  }

  function setLlmStatus(text, kind) {
    var el = $('llm-status');
    el.textContent = text;
    el.className = 'llm-status' + (kind ? ' ' + kind : '');
  }

  // 把表单写回正在编辑的配置
  function storeDraft() {
    var d = currentDraft();
    var p = llmProviderValue();
    keepEndpoint(p);
    d.provider = p;
    d.tier = $('llm-tier').value;
    d.timeout = $('llm-timeout').value;
    d.noThink = $('llm-nothink').checked;
    d.name = $('llm-profile-name').value;
  }

  function renderProfileSelect() {
    $('llm-profile').innerHTML = llm.dcfg.profiles.map(function (p, i) {
      return '<option value="' + i + '"' + (i === llm.didx ? ' selected' : '') + '>' + escapeHtml(LLM.profileName(p.name) || '（未命名）') + '</option>';
    }).join('');
    $('llm-profile-del').disabled = llm.dcfg.profiles.length < 2;
  }

  function loadDraft() {
    var d = LLM.normalizeSettings(currentDraft());
    var keepName = currentDraft().name;
    d.name = keepName;
    d.orig = currentDraft().orig;
    llm.dcfg.profiles[llm.didx] = d;
    var p = d.provider === 'claude' && !llm.sample ? 'openai' : d.provider;
    $('llm-provider-' + p).checked = true;
    llm.dialogProvider = p;
    $('llm-tier').value = d.tier;
    $('llm-timeout').value = d.timeout;
    $('llm-nothink').checked = d.noThink;
    $('llm-profile-name').value = d.name;
    setLlmStatus('', '');
    syncLlmProvider();
  }

  function openLlmDialog(focusName) {
    llm.dcfg = withClaudeDefault(LLM.normalizeConfig(llm.cfg));
    // 记下原来的名字，改名后座位跟着改
    llm.dcfg.profiles.forEach(function (p) { p.orig = p.name; });
    var names = llm.dcfg.profiles.map(function (p) { return p.name; });
    llm.didx = Math.max(0, names.indexOf(focusName));
    $('llm-provider-claude-label').hidden = !inClaudePage();
    $('llm-provider-claude').disabled = !llm.sample;
    renderProfileSelect();
    loadDraft();
    openDialog('llm-dialog');
  }

  function llmFormProblem(s) {
    if (s.provider === 'claude') return llm.sample ? '' : '这个页面现在用不了 Claude';
    var ep = s[s.provider];
    if (!/^https?:\/\/[^\s]+$/i.test(ep.baseUrl)) return '接口地址要以 http:// 或 https:// 开头';
    if (!ep.model) return '请填写模型名';
    return '';
  }

  // 改名或删除配置后，座位里记的名字跟着更新
  function renameSeatModels(map) {
    MODE_LIST.forEach(function (m) {
      prefs.seats[m].forEach(function (seat) {
        if (seat.model && Object.prototype.hasOwnProperty.call(map, seat.model)) seat.model = map[seat.model];
      });
    });
    savePrefs();
  }

  function bindLlmDialog() {
    document.querySelectorAll('.llm-open').forEach(function (b) {
      b.addEventListener('click', function () { claudeSample().then(function () { openLlmDialog(); }); });
    });
    document.querySelectorAll('input[name="llm-provider"]').forEach(function (r) {
      r.addEventListener('change', function () {
        keepEndpoint(llm.dialogProvider);
        llm.dialogProvider = llmProviderValue();
        syncLlmProvider();
        setLlmStatus('', '');
      });
    });
    $('llm-form').addEventListener('submit', function (e) { e.preventDefault(); });
    function jevPreset(url, model) {
      $('llm-url').value = url;
      $('llm-model').value = model;
      keepEndpoint('jev');
      setLlmStatus('', '');
    }
    $('llm-jev-typesafe').addEventListener('click', function () { jevPreset(LLM.JEV_URL, LLM.JEV_MODEL); });
    $('llm-jev-openrouter').addEventListener('click', function () { jevPreset(LLM.JEV_OPENROUTER_URL, LLM.JEV_OPENROUTER_MODEL); });
    $('llm-profile').addEventListener('change', function () {
      storeDraft();
      llm.didx = +$('llm-profile').value;
      renderProfileSelect();
      loadDraft();
    });
    $('llm-profile-name').addEventListener('input', function () {
      currentDraft().name = $('llm-profile-name').value;
      var opt = $('llm-profile').options[llm.didx];
      if (opt) opt.textContent = LLM.profileName($('llm-profile-name').value) || '（未命名）';
    });
    $('llm-profile-add').addEventListener('click', function () {
      if (llm.dcfg.profiles.length >= 12) { setLlmStatus('最多 12 个配置', 'err'); return; }
      storeDraft();
      var used = llm.dcfg.profiles.map(function (p) { return LLM.profileName(p.name); });
      var n = llm.dcfg.profiles.length + 1;
      while (used.indexOf('模型 ' + n) >= 0) n++;
      var d = LLM.normalizeSettings(null);
      d.name = '模型 ' + n;
      llm.dcfg.profiles.push(d);
      llm.didx = llm.dcfg.profiles.length - 1;
      renderProfileSelect();
      loadDraft();
      $('llm-profile-name').focus();
      $('llm-profile-name').select();
    });
    $('llm-profile-del').addEventListener('click', function () {
      if (llm.dcfg.profiles.length < 2) return;
      llm.dcfg.profiles.splice(llm.didx, 1);
      llm.didx = 0;
      renderProfileSelect();
      loadDraft();
    });
    $('llm-cancel').addEventListener('click', function () { closeDialog('llm-dialog'); });
    $('llm-save').addEventListener('click', function () {
      storeDraft();
      var names = {};
      for (var i = 0; i < llm.dcfg.profiles.length; i++) {
        var raw = llm.dcfg.profiles[i];
        var name = LLM.profileName(raw.name);
        var s = LLM.normalizeSettings(raw);
        var empty = s.provider === 'openai' && !s.openai.baseUrl && !s.openai.model;
        var problem = !name ? '请给配置起个名字' : names[name] ? '配置名「' + name + '」重复了' : empty && llm.dcfg.profiles.length === 1 ? '' : llmFormProblem(s);
        if (problem) {
          if (i !== llm.didx) {
            llm.didx = i;
            renderProfileSelect();
            loadDraft();
          }
          setLlmStatus(problem, 'err');
          return;
        }
        names[name] = 1;
      }
      var map = {};
      var removed = profileNames();
      llm.dcfg.profiles.forEach(function (p) {
        if (p.orig) map[p.orig] = LLM.profileName(p.name);
      });
      removed.forEach(function (n) { if (!Object.prototype.hasOwnProperty.call(map, n)) map[n] = ''; });
      llm.cfg = LLM.normalizeConfig(llm.dcfg);
      llm.saved = true;
      llm.lastError = '';
      save(STORE_LLM, llm.cfg);
      renameSeatModels(map);
      closeDialog('llm-dialog');
      toast('已保存大模型设置');
      if (!$('setup').hidden) renderSetup();
      if (!$('lobby').hidden) renderLobby();
    });
    $('llm-test').addEventListener('click', function () {
      storeDraft();
      var s = LLM.normalizeSettings(currentDraft());
      var problem = llmFormProblem(s);
      if (problem) { setLlmStatus(problem, 'err'); return; }
      var btn = $('llm-test');
      btn.disabled = true;
      setLlmStatus('正在连接…', '');
      LLM.ping(s, llmEnv(null)).then(function (r) {
        setLlmStatus('连接成功，用时 ' + (r.ms / 1000).toFixed(1) + ' 秒' + (r.text ? '。模型回复：' + r.text : '') +
          (r.thinking ? '。注意：这个模型开着深度思考，每步会比较慢' : ''), r.thinking ? '' : 'ok');
      }, function (err) {
        setLlmStatus((err && err.message) || '连接失败', 'err');
      }).then(function () { btn.disabled = false; });
    });
  }

  /* ================= 演示局 ================= */

  var demo = { view: null, state: null, timer: 0, anim: null, round: 0 };

  function demoNew() {
    var mode = ['classic', 'trigon', 'gemblo', 'cube', 'prism'][demo.round++ % 5];
    demo.state = Engine.createGame(Engine.buildConfig(mode, Engine.MODES[mode].seats.map(function (s, i) { return { seat: i }; })));
    demo.anim = null;
    $('demo-label').textContent = '电脑演示局 · ' + MODE_LABEL[mode];
  }

  function demoStep() {
    clearTimeout(demo.timer);
    if ($('setup').hidden || document.hidden) return;
    if (!demo.state || demo.state.over) {
      if (demo.state && demo.state.over && !demo.resetPending) {
        demo.resetPending = true;
        demo.timer = setTimeout(demoStep, 2600);
        return;
      }
      demo.resetPending = false;
      demoNew();
    }
    var st = demo.state;
    var move = AI.chooseMove(st, st.current % 2 ? 'normal' : 'hard');
    if (move) {
      var p = st.current;
      Engine.applyAction(st, { type: 'place', piece: move.piece, orient: move.orient, x: move.x, y: move.y, z: move.z });
      demo.anim = { cells: Engine.placementIndices(st, move.piece, move.orient, move.x, move.y, move.z), player: p, t0: performance.now() };
      animate();
    }
    demo.timer = setTimeout(demoStep, 520);
  }

  function startDemo() {
    if (!demo.view) {
      demo.view = new BoardView($('demo-board'), function () { return demo.state; }, function () {
        return { anim: demo.anim };
      });
    }
    demo.view.resize();
    if (REDUCED_MOTION) {
      if (!demo.state) {
        demoNew();
        for (var k = 0; k < 44 && !demo.state.over; k++) {
          var m = AI.chooseMove(demo.state, 'normal');
          Engine.applyAction(demo.state, { type: 'place', piece: m.piece, orient: m.orient, x: m.x, y: m.y, z: m.z });
        }
      }
      demo.view.draw();
      return;
    }
    demoStep();
  }

  /* ================= 对局 ================= */

  var game = {
    mode: 'local',
    config: null,
    state: null,
    gameId: null,
    view: null,
    eventCursor: 0,
    sel: { piece: -1, rot: 0, flip: 0 },
    ghost: null,
    hover: null,
    hint: null,
    hintLockCell: null,
    ghostByTap: false,
    touch: null,
    perPiece: null,
    anchors: null,
    aiTimer: 0,
    aiToken: 0,
    paused: false,
    anim: null,
    endTimer: 0,
    lastWheel: 0,
    turnKey: '',
    trayKind: ''
  };

  // 联机会话；本地对局时为 null
  var online = null;

  function isOnlineGame() { return game.mode === 'online' && !!online; }
  function myId() { return online ? online.pid : null; }
  function cur() { return game.state.players[game.state.current]; }
  function humanCount() { return game.state.players.filter(function (p) { return p.type === 'human'; }).length; }
  function isMine(pl) { return pl.type === 'human' && !isReplay() && (!isOnlineGame() || pl.owner === myId()); }
  function isReplay() { return game.mode === 'replay'; }
  function canAct() { return !!game.state && !game.state.over && isMine(cur()); }
  function isLocalAITurn() { return game.mode === 'local' && !!game.state && !game.state.over && cur().type === 'ai'; }
  function colorVar(pl) { return 'var(--p-' + pl.color + ')'; }
  function cellsToIdx(state, cells) {
    return cells.map(function (c) { return Engine.cellIndex(state.topo, c); });
  }
  function is3D() { return !!game.state && game.state.topo.dims === 3; }
  function isCube() { return !!game.state && game.state.topo.kind === 'cube'; }

  function myPlayers() {
    return game.state.players.filter(isMine);
  }

  function trayOwner() {
    if (canAct()) return cur();
    var mine = myPlayers();
    if (mine.indexOf(cur()) >= 0) return cur();
    if (mine.length && (isOnlineGame() || mine.length === 1)) return mine[0];
    return cur();
  }

  function loadSaved() {
    var s = load(STORE_SAVE);
    if (!s || s.v !== 1 || !s.config || !Array.isArray(s.actions) || !Array.isArray(s.config.players)) return null;
    return s;
  }

  function saveGame() {
    if (game.mode !== 'local') return;
    if (!game.state || game.state.over) save(STORE_SAVE, null);
    else save(STORE_SAVE, { v: 1, config: game.config, actions: game.state.actions });
  }

  function showScreen(name) {
    $('setup').hidden = name !== 'setup';
    $('lobby').hidden = name !== 'lobby';
    $('game').hidden = name !== 'game';
    if (name !== 'game') {
      cancelAI();
      pauseReplay();
    }
    if (name === 'setup') {
      renderSetup();
      startDemo();
    } else {
      clearTimeout(demo.timer);
    }
  }

  // 进入对局画面（本地或联机）
  function enterGame(mode, config, actions, gameId) {
    clearTimeout(game.endTimer);
    closeDialog('end-dialog');
    stopReplay();
    game.mode = mode;
    game.config = config;
    game.gameId = gameId || null;
    game.state = actions && actions.length ? replayWithNotes(config, actions) : Engine.createGame(config);
    game.eventCursor = game.state.events.length;
    game.paused = false;
    game.anim = null;
    game.turnKey = '';
    game.viewPlayer = null;
    resetSelection();
    showScreen('game');
    // 透视默认关闭；同一局联机重新同步时保持原样（对局记录的编号也不变）
    var sameGame = !!gameId && gameId === game.seenGameId;
    if (!sameGame) {
      game.recordId = null;
      game.recordDate = null;
      game.recordSaved = false;
    }
    prepareView(!sameGame);
    game.seenGameId = gameId || null;
    saveGame();
    onTurnStart(true);
    renderGame();
  }

  function prepareView(resetXray) {
    if (game.trayKind !== game.state.set.kind) buildTray();
    if (!game.view) {
      game.view = new BoardView($('board'), function () { return game.state; }, gameOverlay);
      new ResizeObserver(function () { if (game.view.resize()) game.view.draw(); }).observe($('board'));
    }
    if (resetXray) game.view.xray = false;
    applyModeControls();
    game.view.resize();
  }

  function setXray(on) {
    if (!game.view) return;
    game.view.xray = !!on;
    $('xray-btn').setAttribute('aria-pressed', on ? 'true' : 'false');
    drawBoard();
  }

  function setSlice(n) {
    if (!game.view || !is3D()) return;
    var H = game.state.topo.height;
    n = clamp(Math.round(n), 1, H);
    game.view.slice = n >= H ? null : n;
    $('layer-range').value = n;
    $('layer-val').textContent = n >= H ? '全部' : '1–' + n + ' 层';
    drawBoard();
  }

  function applyModeControls() {
    var cube = is3D();
    if (cube && game.view) {
      $('layer-range').max = game.state.topo.height;
      setSlice(game.state.topo.height);
      $('xray-btn').setAttribute('aria-pressed', game.view.xray ? 'true' : 'false');
    }
    $('cam-ctl').hidden = !cube;
    $('board-wrap').classList.toggle('cube', cube);
    $('roll-btn').hidden = !isCube();
    $('rot-ccw').title = cube ? '水平向左转（Shift+R）' : '逆时针旋转（E）';
    $('rot-cw').title = cube ? '水平向右转（R / 滚轮）' : '顺时针旋转（R / 右键 / 滚轮）';
    $('flip-btn').title = isCube() ? '向前翻（F）' : cube ? '上下翻转（F）' : '翻转（F）';
    $('keys-help').textContent = cube
      ? (isCube()
        ? '点选棋子，指向一列后点击让它落下 · R 水平转 · F 前翻 · G 侧翻 · Q / E 转视角 · X 透视 · [ ] 切层 · 拖动空白处旋转视角'
        : '点选棋子，指向一列后点击让它落下 · R 水平转 60° · F 上下翻转 · Q / E 转视角 · X 透视 · [ ] 切层 · 拖动空白处旋转视角')
      : '点选棋子后移到棋盘上点击放置 · R 旋转 · F 翻转 · 方向键移动 · 回车放置 · Esc 取消';
  }

  function resetSelection() {
    game.sel = { piece: -1, rot: 0, flip: 0 };
    game.ghost = null;
    game.hint = null;
    game.hintLockCell = null;
    game.ghostByTap = false;
    game.touch = null;
  }

  function cancelAI() {
    clearTimeout(game.aiTimer);
    game.aiToken++;
    if (game.aiAbort) game.aiAbort.abort();
    game.aiAbort = null;
  }

  function turnKeyOf() {
    var st = game.state;
    return st.actions.length + ':' + st.current + ':' + st.over + ':' + cur().type + ':' + (cur().owner || '');
  }

  function onTurnStart(first) {
    game.turnKey = turnKeyOf();
    game.turnStart = Date.now();
    resetSelection();
    game.perPiece = null;
    game.anchors = null;
    var st = game.state;
    if (st.over) {
      saveGame();
      clearTimeout(game.endTimer);
      game.endTimer = setTimeout(function () { showEnd(); }, first ? 0 : 700);
      return;
    }
    var pl = cur();
    if (canAct()) {
      game.viewPlayer = null;
      game.perPiece = Engine.movesPerPiece(st, st.current);
      var forb = Engine.forbiddenMask(st.board, st.topo, st.current);
      game.anchors = Engine.anchorMask(st.board, st.topo, st.current, pl, forb);
      game.anchorDots = game.anchors.list;
      if (st.topo.dims === 3) {
        // 立体：只标出棋子落下后能停住的角点
        var hm = Engine.heightMap(st.board, st.topo);
        game.anchorDots = game.anchors.list.filter(function (i) {
          var c = View3D.coordOf(st.topo, i);
          return hm[c[2] * st.topo.cols + c[0]] === c[1];
        });
      }
      if (!first) {
        if (isOnlineGame()) {
          toast('轮到你了（' + pl.label + '方）');
          sound('turn');
        } else if (humanCount() > 1) {
          toast('轮到 ' + pl.name + '（' + pl.label + '方）');
          sound('turn');
        }
      }
    } else if (isLocalAITurn()) {
      scheduleAI();
    }
  }

  function scheduleAI() {
    cancelAI();
    if (game.paused || !isLocalAITurn()) return;
    var token = game.aiToken;
    var delay = SPEED_MS[prefs.speed] || SPEED_MS.normal;
    // 大师 / 大模型马上开始算，用时算进电脑速度里
    if (cur().level === 'expert' || cur().level === 'llm') {
      runLocalThink(token, delay);
      return;
    }
    game.aiTimer = setTimeout(function () {
      if (token !== game.aiToken || !isLocalAITurn()) return;
      var st = game.state;
      var move = AI.chooseMove(st, cur().level);
      if (!move) {
        Engine.applyAction(st, { type: 'resign' });
        afterAction();
        return;
      }
      commitMove(move, true);
    }, delay);
  }

  // 大师 / 大模型替本地电脑选一步
  function runLocalThink(token, minMs) {
    var ctl = new AbortController();
    var t0 = Date.now();
    var pl = cur();
    function live() { return token === game.aiToken && isLocalAITurn(); }
    game.aiAbort = ctl;
    renderTurn();
    thinkMove(pl, live, ctl.signal).then(function (r) {
      return new Promise(function (resolve) { game.aiTimer = setTimeout(resolve, Math.max(0, minMs - (Date.now() - t0))); }).then(function () { return r; });
    }).then(function (r) {
      if (!live()) return;
      game.aiAbort = null;
      if (r.error) reportLLMError(r);
      if (!r.move) {
        Engine.applyAction(game.state, { type: 'resign' });
        afterAction();
        return;
      }
      commitMove(r.move, true, r.note);
    }, function () { /* 已取消 */ });
  }

  function commitMove(move, byAI, note) {
    var st = game.state;
    var p = st.current;
    var reason = Engine.applyAction(st, { type: 'place', piece: move.piece, orient: move.orient, x: move.x, y: move.y, z: move.z });
    if (reason) return reason;
    if (note) {
      st.actions[st.actions.length - 1].note = note;
      toast(st.players[p].name + '：' + note);
    }
    game.anim = { cells: cellsToIdx(st, st.lastMove.cells), player: p, t0: performance.now() };
    sound('place', byAI && humanCount() > 0);
    afterAction();
    return null;
  }

  function processEvents() {
    var st = game.state;
    var notes = [];
    for (; game.eventCursor < st.events.length; game.eventCursor++) {
      var ev = st.events[game.eventCursor];
      if (ev.type === 'blocked') notes.push(st.players[ev.player].name + ' 已无处可放');
      else if (ev.type === 'resign') notes.push(st.players[ev.player].name + ' 停手了');
    }
    return notes;
  }

  function afterAction() {
    var notes = processEvents();
    saveGame();
    onTurnStart(false);
    if (notes.length) toast(notes.join('；'));
    renderGame();
    animate();
  }

  /* ---------- 联机对局同步 ---------- */

  function sameAction(a, b) {
    return !!a && !!b && a.type === b.type && a.player === b.player &&
      (a.type === 'resign' || (a.piece === b.piece && a.orient === b.orient && a.x === b.x && a.y === b.y && a.z === b.z));
  }

  function refreshMeta(config) {
    config.players.forEach(function (cp, i) {
      var pl = game.state.players[i];
      if (!pl) return;
      pl.type = cp.type;
      pl.level = cp.level;
      pl.name = cp.name;
      pl.owner = cp.owner;
      pl.model = cp.model;
    });
  }

  function syncOnlineGame(room) {
    var g = room.game;
    if (!isOnlineGame() || !game.state || game.gameId !== g.id || $('game').hidden) {
      enterGame('online', g.config, g.actions, g.id);
      maybeRunAI();
      return;
    }
    var local = game.state.actions, remote = g.actions;
    // 自己刚落的子还没写进房间：先不回退
    if (online.pending && remote.length <= online.pending.at) {
      refreshMeta(g.config);
      renderGame();
      return;
    }
    var prefix = local.length <= remote.length;
    for (var i = 0; prefix && i < local.length; i++) if (!sameAction(local[i], remote[i])) prefix = false;
    if (prefix && remote.length > local.length) {
      var placed = false;
      var said = null;
      for (var j = local.length; j < remote.length; j++) {
        if (Engine.applyAction(game.state, remote[j])) { prefix = false; break; }
        if (remote[j].type === 'place') placed = true;
        if (remote[j].note) {
          game.state.actions[j].note = remote[j].note;
          said = remote[j];
        }
      }
      if (prefix && said && game.state.players[said.player]) toast(game.state.players[said.player].name + '：' + said.note);
      if (prefix && placed && game.state.lastMove) {
        game.anim = { cells: cellsToIdx(game.state, game.state.lastMove.cells), player: game.state.lastMove.player, t0: performance.now() };
        sound('place', true);
      }
    }
    if (!prefix) {
      game.state = replayWithNotes(g.config, remote);
      game.eventCursor = game.state.events.length;
      game.anim = null;
    }
    refreshMeta(g.config);
    var notes = processEvents();
    if (turnKeyOf() !== game.turnKey) onTurnStart(false);
    if (notes.length) toast(notes.join('；'));
    renderGame();
    animate();
    maybeRunAI();
  }

  function onlineSubmit(action) {
    var st = game.state;
    var at = st.actions.length;
    var reason = Engine.applyAction(st, action);
    if (reason) return reason;
    if (action.type === 'place') {
      game.anim = { cells: cellsToIdx(st, st.lastMove.cells), player: st.lastMove.player, t0: performance.now() };
      sound('place');
    }
    online.pending = { at: at };
    var notes = processEvents();
    onTurnStart(false);
    if (notes.length) toast(notes.join('；'));
    renderGame();
    animate();
    var session = online;
    sendOp({ type: 'act', at: at, action: action }, true).then(function () {
      if (online !== session) return;
      online.pending = null;
      if (online.room && online.room.game) syncOnlineGame(online.room);
    }, function (err) {
      if (online !== session) return;
      online.pending = null;
      toast(err.code === 'stale' ? '局面已更新，这步没有生效' : err.message, 'warn');
      game.gameId = null;
      if (online.room && online.room.game) syncOnlineGame(online.room);
    });
    return null;
  }

  // 共享存储模式下，电脑回合由房主（或在线玩家中的一位）代为落子；
  // 「大模型」电脑在两种联机方式下都由房主的浏览器调用模型（自建服务器只在等太久时代下）
  function maybeRunAI() {
    if (!online) return;
    clearTimeout(online.aiTimer);
    var room = online.room;
    if (!room || room.status !== 'playing' || !isOnlineGame() || !game.state || game.state.over || online.pending) return;
    var pl = cur();
    if (pl.type !== 'ai') return;
    var llmSeat = pl.level === 'llm';
    var heavy = llmSeat || pl.level === 'expert';
    if (online.net.serverRunsAI && !llmSeat) return;
    var at = game.state.actions.length;
    if (online.aiBusy === at) return;
    var runner = Online.aiRunner(room, online.peers);
    var mine = runner === online.pid;
    if (online.net.serverRunsAI && !mine) return;
    var speed = SPEED_MS[room.speed] || SPEED_MS.normal;
    var delay = mine ? (heavy ? 0 : speed) : (llmSeat ? 160000 : 12000) + Math.random() * 4000;
    var session = online;
    function stale() {
      return online !== session || !game.state || game.state.over || game.state.actions.length !== at || cur().type !== 'ai';
    }
    online.aiTimer = setTimeout(function () {
      if (stale()) return;
      var ask;
      if (heavy && mine) {
        online.aiBusy = at;
        online.aiAbort = new AbortController();
        renderTurn();
        var t0 = Date.now();
        ask = thinkMove(pl, function () { return !stale(); }, online.aiAbort.signal).then(function (r) {
          return wait(Math.max(0, speed - (Date.now() - t0))).then(function () { return r; });
        });
      } else {
        // 替掉线的人兜底时用快的算法
        ask = Promise.resolve({ move: AI.chooseMove(game.state, heavy ? 'hard' : pl.level), note: '' });
      }
      ask.then(function (r) {
        if (online !== session) return;
        if (online.aiBusy === at) {
          online.aiBusy = -1;
          online.aiAbort = null;
        }
        if (stale()) return;
        if (r.error) reportLLMError(r);
        var move = r.move;
        var action = move ? { type: 'place', piece: move.piece, orient: move.orient, x: move.x, y: move.y, z: move.z } : { type: 'resign' };
        var op = { type: 'act', at: at, action: action };
        if (move && r.note) op.note = r.note;
        sendOp(op, true).catch(function () {});
      }, function () {
        if (online === session && online.aiBusy === at) {
          online.aiBusy = -1;
          online.aiAbort = null;
        }
      });
    }, delay);
  }

  /* ---------- 选择 / 放置 ---------- */

  function currentOrient() {
    var set = game.state.set;
    return set.dims === 3 ? game.sel.orient : set.orientFor(game.sel.piece, game.sel.rot, game.sel.flip);
  }

  function clampGhost() {
    if (!game.ghost || game.sel.piece < 0) return;
    var topo = game.state.topo;
    if (topo.kind === 'tri') return;
    var o = game.state.set.pieces[game.sel.piece].orients[currentOrient()];
    game.ghost.x = clamp(game.ghost.x, o.pivot[0], topo.cols - o.w + o.pivot[0]);
    if (topo.dims === 3) game.ghost.z = clamp(game.ghost.z, o.pivot[2], topo.depth - o.d + o.pivot[2]);
    else game.ghost.y = clamp(game.ghost.y, o.pivot[1], topo.rows - o.h + o.pivot[1]);
  }

  function ghostMove() {
    if (game.sel.piece < 0 || !game.ghost) return null;
    var oi = currentOrient();
    var o = game.state.set.pieces[game.sel.piece].orients[oi];
    if (is3D()) {
      // 立体：对准的是一列，高度由重力决定
      var pv3 = o.pivot, gx3 = game.ghost.x, gz3 = game.ghost.z;
      // 三棱柱：光标所在列与对准格的三角形朝向必须一致，否则换一个朝向相同的格子对准
      if (game.state.topo.parity && ((gx3 + gz3 + pv3[0] + pv3[2]) & 1)) {
        var best3 = null, bd3 = Infinity;
        o.cells.forEach(function (c) {
          if ((gx3 + gz3 + c[0] + c[2]) & 1) return;
          var d = (c[0] - pv3[0]) * (c[0] - pv3[0]) + (c[2] - pv3[2]) * (c[2] - pv3[2]) + c[1] * c[1] * 4;
          if (d < bd3) { bd3 = d; best3 = c; }
        });
        if (!best3) { gx3 += 1; best3 = pv3; }
        pv3 = best3;
      }
      var px = gx3 - pv3[0], pz = gz3 - pv3[2];
      var y = Engine.dropY(game.state, game.sel.piece, oi, px, pz, true);
      if (y < 0) return null;
      return { piece: game.sel.piece, orient: oi, x: px, y: y, z: pz };
    }
    var gx = game.ghost.x, gy = game.ghost.y;
    var pv = o.pivot;
    // 三角格：光标格与对准格的尖朝向必须一致，否则换一个朝向相同的格子对准
    if (game.state.topo.parity && ((gx + gy + pv[0] + pv[1]) & 1)) {
      var best = null, bd = Infinity;
      o.cells.forEach(function (c) {
        if ((gx + gy + c[0] + c[1]) & 1) return;
        var d = (c[0] - pv[0]) * (c[0] - pv[0]) + (c[1] - pv[1]) * (c[1] - pv[1]);
        if (d < bd) { bd = d; best = c; }
      });
      if (!best) { gx += 1; best = pv; }
      pv = best;
    }
    return { piece: game.sel.piece, orient: oi, x: gx - pv[0], y: gy - pv[1] };
  }

  function defaultGhost() {
    var topo = game.state.topo;
    var list = game.anchorDots && game.anchorDots.length ? game.anchorDots
      : game.anchors && game.anchors.list.length ? game.anchors.list : topo.cells;
    var best = list[0], bd = Infinity;
    list.forEach(function (i) {
      if (topo.centerDist[i] < bd) { bd = topo.centerDist[i]; best = i; }
    });
    if (topo.dims === 3) {
      var c = View3D.coordOf(topo, best);
      return { x: c[0], z: c[2] };
    }
    return { x: best % topo.cols, y: Math.floor(best / topo.cols) };
  }

  // 联机时当前玩家（不是自己）正在尝试的位置；内容来自别人，先校验再用
  function remotePreview() {
    if (!isOnlineGame() || !online.previews || canAct()) return null;
    var st = game.state;
    if (st.over) return null;
    var pl = cur();
    if (pl.type !== 'human' || !pl.owner) return null;
    var pv = online.previews[pl.owner];
    if (!pv || pv.at !== st.actions.length) return null;
    var piece = Number.isInteger(pv.piece) ? st.set.pieces[pv.piece] : null;
    if (!piece || !Number.isInteger(pv.orient) || !piece.orients[pv.orient]) return null;
    var coords = st.topo.dims === 3 ? [pv.x, pv.y, pv.z] : [pv.x, pv.y];
    if (!coords.every(function (v) { return Number.isInteger(v) && Math.abs(v) <= 64; })) return null;
    return pv;
  }

  // 透视时保持不透明的玩家：联机是自己的座位；本地是正在落子的玩家，电脑回合时是所有真人
  function ownPlayers() {
    var st = game.state, out = [];
    if (isOnlineGame()) {
      st.players.forEach(function (p, i) { if (p.owner && p.owner === myId()) out.push(i); });
    } else if (!st.over && cur().type === 'human') {
      out.push(st.current);
    } else {
      st.players.forEach(function (p, i) { if (p.type === 'human') out.push(i); });
    }
    return out;
  }

  function remotePreviewSafe() { return game.state && isOnlineGame() ? remotePreview() : null; }

  function gameOverlay() {
    var st = game.state;
    var ov = { lastMove: st.lastMove ? cellsToIdx(st, st.lastMove.cells) : null, anim: game.anim };
    var topo = st.topo;
    var cube = topo.dims === 3;
    if (cube && game.view) {
      ov.slice = game.view.slice;
      ov.xray = game.view.xray;
      ov.own = ownPlayers();
    }
    var rp = remotePreview();
    if (rp) {
      var rcolor = palette.colors[cur().color];
      var rcells = Engine.placementCells(st, rp.piece, rp.orient, rp.x, rp.y, rp.z);
      ov.remote = {
        cells: cube ? rcells : cellsToIdx(st, rcells.filter(function (c) { return Engine.inBounds(topo, c); })),
        color: rcolor,
        valid: Engine.checkPlacement(st, st.current, rp.piece, rp.orient, rp.x, rp.y, rp.z) === null
      };
    }
    if (!canAct()) return ov;
    var pl = cur();
    var color = palette.colors[pl.color];
    if (prefs.hints && game.anchors) ov.anchors = { list: game.anchorDots || game.anchors.list, color: color };
    if (game.hint) {
      var h = game.hint;
      ov.hint = {
        cells: cube ? Engine.placementCells(st, h.piece, h.orient, h.x, h.y, h.z) : Engine.placementIndices(st, h.piece, h.orient, h.x, h.y),
        color: palette.ink
      };
    }
    var m = ghostMove();
    if (!m) return ov;
    var valid = Engine.checkPlacement(st, st.current, m.piece, m.orient, m.x, m.y, m.z) === null;
    if (cube) {
      var hm = Engine.heightMap(st.board, topo);
      var foot = st.set.pieces[m.piece].orients[m.orient].foot;
      var shadow = [];
      for (var k = 0; k < foot.length; k += 3) {
        var fx = m.x + foot[k], fz = m.z + foot[k + 1];
        shadow.push([fx, hm[fz * topo.cols + fx], fz]);
      }
      ov.ghost = { cells: Engine.placementCells(st, m.piece, m.orient, m.x, m.y, m.z), shadow: shadow, color: color, valid: valid };
      return ov;
    }
    var cells = Engine.placementCells(st, m.piece, m.orient, m.x, m.y).filter(function (c) { return Engine.inBounds(topo, c); });
    ov.ghost = { cells: cellsToIdx(st, cells), color: color, valid: valid };
    return ov;
  }

  function selectPiece(pi) {
    if (!canAct() || !cur().remaining[pi]) return;
    if (game.sel.piece === pi) {
      game.sel.piece = -1;
      game.hint = null;
    } else {
      game.sel = { piece: pi, rot: 0, flip: 0, orient: game.state.set.pieces[pi].display };
      game.hint = null;
      game.hintLockCell = null;
      game.ghostByTap = false;
      if (!game.ghost) {
        game.ghost = defaultGhost();
        if (prefs.hints) snapGhostToLegal();
      }
      clampGhost();
      // 让方向键 / 回车直接作用于棋盘
      try { $('board').focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
    }
    renderDock();
    drawBoard();
  }

  // 自动摆出的预览：挪到当前朝向下离它最近的合法位置（手机上选好棋子就能直接放）
  function snapGhostToLegal() {
    var st = game.state, pi = game.sel.piece, oi = currentOrient();
    var filter = st.set.pieces.map(function (p, i) { return i === pi; });
    var all = Engine.legalMoves(st, st.current, filter);
    if (!all.length || !game.ghost) return;
    // 当前朝向放得下就保持朝向，否则换成放得下的朝向
    var same = all.filter(function (m) { return m.orient === oi; });
    var moves = same.length ? same : all;
    var d3 = st.topo.dims === 3, orients = st.set.pieces[pi].orients;
    var tx = game.ghost.x, ty = d3 ? game.ghost.z : game.ghost.y;
    var best = null, bd = Infinity;
    moves.forEach(function (m) {
      var pv = orients[m.orient].pivot;
      var gx = m.x + pv[0], gy = d3 ? m.z + pv[2] : m.y + pv[1];
      var d = (gx - tx) * (gx - tx) + (gy - ty) * (gy - ty);
      if (d < bd) { bd = d; best = m; }
    });
    var o = orients[best.orient];
    if (d3) game.sel.orient = best.orient;
    else { game.sel.rot = o.rot; game.sel.flip = o.flip; }
    game.ghost = d3 ? { x: best.x + o.pivot[0], z: best.z + o.pivot[2] } : { x: best.x + o.pivot[0], y: best.y + o.pivot[1] };
  }

  function afterTurnPiece() {
    clampGhost();
    renderSelection();
    drawBoard();
  }

  // 方块 / 三角：平面内旋转；立体：绕竖轴转 90°
  function rotate(d) {
    if (game.sel.piece < 0 || !canAct()) return;
    var set = game.state.set;
    if (set.dims === 3) {
      game.sel.orient = set.turn(game.sel.piece, game.sel.orient, 1, d);
    } else {
      var R = set.rotations;
      game.sel.rot = (game.sel.rot + d + R) % R;
    }
    afterTurnPiece();
  }

  // 方块 / 三角：始终沿屏幕竖轴镜像（F·R^k = R^-k·F）；立体：向前翻
  function flip() {
    if (game.sel.piece < 0 || !canAct()) return;
    var set = game.state.set;
    if (set.dims === 3) {
      game.sel.orient = set.turn(game.sel.piece, game.sel.orient, View3D.screenAxes(game.view).tip, 1);
    } else {
      var R = set.rotations;
      game.sel.flip ^= 1;
      game.sel.rot = (R - game.sel.rot) % R;
    }
    afterTurnPiece();
  }

  // 立体：向侧面翻
  function roll() {
    if (game.sel.piece < 0 || !canAct() || !isCube()) return;
    game.sel.orient = game.state.set.turn(game.sel.piece, game.sel.orient, View3D.screenAxes(game.view).roll, 1);
    afterTurnPiece();
  }

  function reasonText(reason) {
    if (is3D()) {
      if (reason === 'edge') return '不能和自己的棋子面贴面（包括叠在自己的棋子正上方）';
      if (reason === 'corner') return '必须和自己的棋子棱或角相接';
      if (reason === 'start') return '第一块必须盖住地面上你的起始角';
    }
    return REASON_TEXT[reason] || '这里放不下';
  }

  function tryPlace() {
    if (!canAct()) return false;
    var m = ghostMove();
    if (!m) {
      toast(game.sel.piece < 0 ? '先选一块棋子' : '先在棋盘上选位置');
      return false;
    }
    var reason = Engine.checkPlacement(game.state, game.state.current, m.piece, m.orient, m.x, m.y, m.z);
    if (reason) {
      toast(reasonText(reason), 'warn');
      sound('bad');
      return false;
    }
    resetSelection();
    if (isOnlineGame()) {
      var action = { type: 'place', piece: m.piece, orient: m.orient, x: m.x, y: m.y };
      if (m.z !== undefined) action.z = m.z;
      onlineSubmit(action);
    } else commitMove(m, false);
    return true;
  }

  function giveHint() {
    if (!canAct()) return;
    var move = AI.chooseMove(game.state, 'hard');
    if (!move) return;
    var piece = game.state.set.pieces[move.piece];
    var o = piece.orients[move.orient];
    if (game.state.set.dims === 3) {
      game.sel = { piece: move.piece, rot: 0, flip: 0, orient: move.orient };
      game.ghost = { x: move.x + o.pivot[0], z: move.z + o.pivot[2] };
    } else {
      game.sel = { piece: move.piece, rot: o.rot, flip: o.flip };
      game.ghost = { x: move.x + o.pivot[0], y: move.y + o.pivot[1] };
    }
    game.hint = move;
    game.ghostByTap = false;
    game.hintLockCell = game.hover ? copyCell(game.hover) : null;
    toast('试试「' + piece.name + '」放在虚线框的位置');
    renderDock();
    animate();
  }

  // 立体视角：yaw 每步 45°，pitch 每步约 11°
  function turnCamera(dYaw, dPitch) {
    if (!game.view) return;
    var cam = game.view.cam || (game.view.cam = { yaw: View3D.DEFAULT_CAM.yaw, pitch: View3D.DEFAULT_CAM.pitch });
    var t = game.view.camTarget || { yaw: cam.yaw, pitch: cam.pitch };
    t = { yaw: t.yaw + dYaw * Math.PI / 4, pitch: View3D.clampPitch(t.pitch + dPitch * 0.2) };
    if (REDUCED_MOTION) {
      cam.yaw = t.yaw;
      cam.pitch = t.pitch;
      renderSelection();
      drawBoard();
      return;
    }
    game.view.camTarget = t;
    animate();
  }

  function undo() {
    if (game.mode !== 'local') return;
    var st = game.state;
    var i = st.actions.length - 1;
    while (i >= 0 && st.players[st.actions[i].player].type !== 'human') i--;
    if (i < 0) return;
    cancelAI();
    clearTimeout(game.endTimer);
    closeDialog('end-dialog');
    game.state = replayWithNotes(game.config, st.actions.slice(0, i));
    game.eventCursor = game.state.events.length;
    game.anim = null;
    saveGame();
    onTurnStart(true);
    renderGame();
    toast('已悔棋，轮到 ' + cur().name);
  }

  function resign() {
    if (!canAct()) return;
    var pl = cur();
    confirmBox('确定停手？', pl.name + ' 将不再落子，手里的 ' + pl.remaining.filter(Boolean).length + ' 块留在手里。其他玩家继续对局。', '停手').then(function (ok) {
      if (!ok || !canAct() || cur() !== pl) return;
      resetSelection();
      if (isOnlineGame()) {
        onlineSubmit({ type: 'resign' });
        return;
      }
      Engine.applyAction(game.state, { type: 'resign' });
      afterAction();
    });
  }

  /* ---------- 渲染 ---------- */

  var rafId = 0;
  function animate() {
    if (rafId) return;
    rafId = requestAnimationFrame(function (now) {
      rafId = 0;
      var more = false;
      if (game.view && !$('game').hidden && game.state) {
        if (game.anim && now - game.anim.t0 >= DROP_MS) game.anim = null;
        var ct = game.view.camTarget;
        if (ct) {
          var cam = game.view.cam;
          cam.yaw += (ct.yaw - cam.yaw) * 0.25;
          cam.pitch += (ct.pitch - cam.pitch) * 0.25;
          if (Math.abs(ct.yaw - cam.yaw) < 0.003 && Math.abs(ct.pitch - cam.pitch) < 0.003) {
            cam.yaw = ct.yaw;
            cam.pitch = ct.pitch;
            game.view.camTarget = null;
            renderSelection();
          } else more = true;
        }
        game.view.draw(now);
        syncPreview();
        if (game.anim || (game.hint && !REDUCED_MOTION && canAct())) more = true;
      }
      if (demo.view && !$('setup').hidden) {
        if (demo.anim && now - demo.anim.t0 >= DROP_MS) demo.anim = null;
        // 立体演示局缓慢环绕
        if (demo.state && demo.state.topo.dims === 3 && !REDUCED_MOTION && !document.hidden) {
          demo.view.cam = demo.view.cam || { yaw: View3D.DEFAULT_CAM.yaw, pitch: View3D.DEFAULT_CAM.pitch };
          demo.view.cam.yaw += 0.004;
          more = true;
        }
        demo.view.draw(now);
        if (demo.anim) more = true;
      }
      if (more) animate();
    });
  }

  function drawBoard() {
    if (game.hint && !REDUCED_MOTION) animate();
    else if (game.view) game.view.draw();
    updatePlaceButton();
    syncPreview();
  }

  // 联机：把自己正在尝试的位置实时告诉其他人（最多约每 90ms 一次，内容不变不发）
  function syncPreview() {
    if (!isOnlineGame() || !online.net.preview) return;
    var pv = null;
    if (canAct()) {
      var m = ghostMove();
      if (m) {
        pv = { at: game.state.actions.length, piece: m.piece, orient: m.orient, x: m.x, y: m.y };
        if (m.z !== undefined) pv.z = m.z;
      }
    }
    var key = JSON.stringify(pv);
    online.pvWant = pv;
    online.pvKey = key;
    if (key === online.pvSent || online.pvTimer) return;
    online.pvTimer = setTimeout(flushPreview, Math.max(0, 90 - (Date.now() - (online.pvAt || 0))));
  }

  function flushPreview() {
    if (!online) return;
    online.pvTimer = 0;
    if (online.pvKey === online.pvSent) return;
    online.pvSent = online.pvKey;
    online.pvAt = Date.now();
    online.net.preview(online.pvWant);
  }

  function renderGame() {
    if (!game.state || $('game').hidden) return;
    renderTurn();
    renderPlayers();
    renderDock();
    drawBoard();
  }

  function peersKnown() { return !!(online && online.peers); }
  function isPeerOnline(id) { return !peersKnown() || online.peers.indexOf(id) >= 0; }

  function renderTurn() {
    var st = game.state;
    var root = $('game');
    var text, color;
    var onlineMode = isOnlineGame();
    var replaying = isReplay();
    if (replaying) {
      var last = replay.step ? replay.rec.actions[replay.step - 1] : null;
      if (st.over) {
        text = '对局结束 · ' + winnersText(st);
        color = 'var(--ink)';
      } else if (!last) {
        text = '回放 · 开局';
        color = 'var(--ink)';
      } else {
        var lp = st.players[last.player];
        color = colorVar(lp);
        text = lp.name + (last.type === 'place' ? ' 放下「' + st.set.pieces[last.piece].name + '」' : ' 停手');
      }
    } else if (st.over) {
      text = '对局结束';
      color = 'var(--ink)';
    } else {
      var pl = cur();
      color = colorVar(pl);
      if (canAct()) text = !onlineMode && humanCount() > 1 ? '轮到 ' + pl.name + '（' + pl.label + '方）' : '轮到你了（' + pl.label + '方）';
      else if (pl.type === 'human') {
        text = '等待 ' + pl.name + '（' + pl.label + '方）落子' +
          (onlineMode && !isPeerOnline(pl.owner) ? ' · 已离线' : remotePreview() ? ' · 正在尝试摆放' : '');
      }
      else if (game.paused) text = pl.name + ' · 已暂停';
      else if (pl.level === 'llm') {
        var secs = Math.floor((Date.now() - (game.turnStart || Date.now())) / 1000);
        text = pl.name + ' 正在问大模型…' + (secs >= 2 ? ' ' + secs + ' 秒' : '');
      } else text = pl.name + ' 思考中…';
    }
    root.style.setProperty('--turn', color);
    $('turn-text').textContent = text;
    var placed = st.actions.filter(function (a) { return a.type === 'place'; }).length;
    $('turn-move').textContent = replaying ? '第 ' + replay.step + ' / ' + replay.n + ' 步'
      : st.over ? '共 ' + placed + ' 手' : '第 ' + (placed + 1) + ' 手';

    var hasHuman = myPlayers().length > 0;
    var canUndo = !onlineMode && st.actions.some(function (a) { return st.players[a.player].type === 'human'; });
    $('undo-btn').disabled = !canUndo;
    $('undo-btn').hidden = onlineMode || !hasHuman;
    $('hint-btn').hidden = !hasHuman;
    $('hint-btn').disabled = !canAct();
    $('pause-btn').hidden = onlineMode || humanCount() > 0 || st.over || replaying;
    $('pause-btn').textContent = game.paused ? '继续' : '暂停';
    $('result-btn').hidden = !st.over || replaying;
    $('sound-btn').setAttribute('aria-pressed', prefs.sound ? 'true' : 'false');
    $('menu-btn').textContent = replaying ? '‹ 退出回放' : onlineMode ? '‹ 离开' : '‹ 菜单';
    $('menu-btn').title = replaying ? '回到对局记录' : onlineMode ? '离开房间' : '返回菜单（对局自动保存）';
    var chip = $('room-chip');
    chip.hidden = !onlineMode;
    if (onlineMode) {
      var n = online.peers ? online.peers.length : null;
      chip.textContent = '房间 ' + online.code + (online.connected ? (n ? ' · ' + n + ' 人在线' : '') : ' · 重新连接中');
      chip.classList.toggle('off', !online.connected);
    }
  }

  function trayOrder(set) {
    return set.pieces.map(function (p) { return p.index; })
      .sort(function (a, b) { return set.pieces[b].size - set.pieces[a].size || a - b; });
  }

  // 棋子小图标（颜色来自外层的 --c，所以与玩家无关，可以缓存）
  var miniCache = {};
  function pieceIcon(set, pi) {
    var key = set.kind + ':' + pi;
    if (!miniCache[key]) {
      var piece = set.pieces[pi];
      miniCache[key] = set.dims === 3 ? View3D.pieceSVG(piece.orients[piece.display], null, null, set.kind) : pieceSVG(piece.orients[piece.display], set.maxBox);
    }
    return miniCache[key];
  }

  function renderPlayers() {
    var st = game.state;
    var onlineMode = isOnlineGame();
    var amHost = onlineMode && online.room && online.room.host === myId();
    var total = st.set.total;
    var order = trayOrder(st.set);
    var viewing = dockOwner() !== trayOwner() ? dockOwner() : null;
    var replaying = isReplay();
    var lastMover = replaying && replay.rec && replay.step ? replay.rec.actions[replay.step - 1].player : -1;
    $('players').innerHTML = st.players.map(function (pl, p) {
      var current = replaying ? p === lastMover : !st.over && p === st.current;
      var stateText = '';
      if (pl.resigned) stateText = '已停手';
      else if (pl.done) stateText = st.over ? '' : '无处可放';
      else if (current && !replaying) stateText = pl.type === 'human' ? (isMine(pl) ? '正在落子' : '等待落子') : (game.paused ? '已暂停' : '<span class="thinking">思考中</span>');
      var dot = '';
      if (onlineMode && pl.type === 'human' && peersKnown()) {
        var on = isPeerOnline(pl.owner);
        dot = '<span class="pcard-online' + (on ? '' : ' off') + '" title="' + (on ? '在线' : '离线') + '"></span>';
        if (!on && amHost && !pl.done && !st.over) {
          stateText += '<button type="button" class="btn" data-takeover="' + p + '">交给电脑</button>';
        }
      }
      var placed = total - pl.remainingSquares;
      var kind = pl.type === 'human' ? (onlineMode && pl.owner === myId() ? '你' : '玩家') : '电脑 · ' + LEVEL_LABEL[pl.level] + (pl.level === 'llm' && pl.model ? ' · ' + pl.model : '');
      var pieces = order.map(function (pi) {
        return '<i' + (pl.remaining[pi] ? '' : ' class="used"') + '>' + pieceIcon(st.set, pi) + '</i>';
      }).join('');
      var left = pl.remaining.filter(Boolean).length;
      var note = lastNote(st, p);
      return '<div class="pcard' + (current ? ' current' : '') + (pl.done ? ' done' : '') + (viewing === pl ? ' viewing' : '') +
        '" style="--c:' + colorVar(pl) + '" data-player="' + p + '" role="button" tabindex="0"' +
        ' title="点击在托盘里查看剩余棋子" aria-label="' + escapeHtml(pl.name) + '，剩 ' + left + ' 块，点击查看">' +
        '<span class="pcard-swatch" aria-hidden="true"></span>' +
        '<div class="pcard-name">' + dot + escapeHtml(pl.name) + '<small>' + pl.label + '方 · ' + kind + '</small></div>' +
        '<div class="pcard-left" title="手里还剩 ' + left + ' 块">剩<b>' + left + '</b>块</div>' +
        '<div class="pcard-bar" aria-hidden="true"><i style="--w:' + (placed / total * 100).toFixed(1) + '%"></i></div>' +
        '<div class="pcard-pieces" aria-hidden="true">' + pieces + '</div>' +
        '<div class="pcard-state">' + stateText + '</div>' +
        (note ? '<div class="pcard-note" title="' + escapeHtml(note) + '">' + escapeHtml(note) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function buildTray() {
    var set = game.state.set;
    game.trayKind = set.kind;
    var order = trayOrder(set);
    var tray = $('tray');
    tray.innerHTML = '';
    order.forEach(function (pi) {
      var piece = set.pieces[pi];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'piece-btn';
      b.id = 'piece-' + piece.id;
      b.dataset.piece = pi;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-label', piece.name + '，' + piece.size + ' 格');
      b.innerHTML = set.dims === 3 ? View3D.pieceSVG(piece.orients[piece.display], null, null, set.kind) : pieceSVG(piece.orients[piece.display], set.maxBox);
      b.addEventListener('click', function () { selectPiece(pi); });
      tray.appendChild(b);
    });
  }

  // 托盘里显示谁的棋子：点了玩家卡片就看那位玩家，否则看自己
  function dockOwner() {
    var pl = game.viewPlayer != null ? game.state.players[game.viewPlayer] : null;
    return pl || trayOwner();
  }

  function viewPlayerPieces(p) {
    game.viewPlayer = game.viewPlayer === p || game.state.players[p] === trayOwner() ? null : p;
    renderPlayers();
    renderDock();
  }

  function renderDock() {
    var st = game.state;
    var replaying = isReplay();
    $('replay-panel').hidden = !replaying;
    $('dock').classList.toggle('replaying', replaying);
    if (replaying) {
      $('dock').classList.remove('inactive');
      $('dock').style.setProperty('--c', 'var(--ink)');
      $('dock-title').textContent = '对局回放 · ' + MODE_LABEL[st.mode];
      $('dock-back').hidden = true;
      $('dock-count').textContent = '共 ' + replay.n + ' 步';
      $('resign-btn').hidden = true;
      renderReplayControls();
      return;
    }
    var owner = dockOwner();
    var browsing = owner !== trayOwner();
    var active = canAct() && owner === cur();
    var dock = $('dock');
    dock.classList.toggle('inactive', !active);
    dock.style.setProperty('--c', colorVar(owner));
    $('dock-title').textContent = owner.label + '方 · ' + owner.name + (browsing ? ' 的棋子' : active || st.over ? '' : owner.type === 'ai' ? '（电脑）' : '（等待中）');
    $('dock-back').hidden = !browsing;
    var left = owner.remaining.filter(Boolean).length;
    $('dock-count').textContent = '剩 ' + left + ' 块 · ' + owner.remainingSquares + ' 格';
    var set = st.set;
    $('tray').querySelectorAll('.piece-btn').forEach(function (b) {
      var pi = +b.dataset.piece;
      var used = !owner.remaining[pi];
      var stuck = active && !used && prefs.hints && game.perPiece && game.perPiece[pi] === 0;
      b.classList.toggle('used', used);
      b.classList.toggle('stuck', !!stuck);
      b.disabled = used || !active;
      b.setAttribute('aria-selected', active && game.sel.piece === pi ? 'true' : 'false');
      var piece = set.pieces[pi];
      b.title = used ? '已放置' : stuck ? piece.name + '：当前没有可放的位置' : piece.name + '（' + piece.size + ' 格）';
    });
    $('resign-btn').hidden = !active;
    renderSelection();
  }

  function renderSelection() {
    var prev = $('sel-preview');
    var active = canAct();
    var has = active && game.sel.piece >= 0;
    if (has) {
      var set = game.state.set;
      var o = set.pieces[game.sel.piece].orients[currentOrient()];
      prev.innerHTML = set.dims === 3 ? View3D.pieceSVG(o, game.view && game.view.cam, null, set.kind) : pieceSVG(o, set.maxBox);
      prev.setAttribute('aria-label', '已选：' + set.pieces[game.sel.piece].name);
    } else {
      prev.textContent = active ? '从下方选择棋子' : game.state.over ? '对局结束' : '等待其他玩家';
      prev.removeAttribute('aria-label');
    }
    ['rot-ccw', 'rot-cw', 'flip-btn', 'roll-btn'].forEach(function (id) { $(id).disabled = !has; });
    updatePlaceButton();
  }

  function updatePlaceButton() {
    $('place-btn').disabled = !(canAct() && ghostMove());
  }

  /* ---------- 提示条 ---------- */

  var toastTimer = 0;
  function toast(msg, kind) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    void el.offsetWidth;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, Math.max(1600, msg.length * 110));
  }

  /* ---------- 弹窗 ---------- */

  function openDialog(id) {
    var d = $(id);
    if (d.open) return;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }
  function closeDialog(id) {
    var d = $(id);
    if (!d.open) return;
    if (typeof d.close === 'function') d.close();
    else d.removeAttribute('open');
  }
  function anyDialogOpen() {
    return ['end-dialog', 'confirm-dialog', 'rules-dialog', 'llm-dialog', 'records-dialog'].some(function (id) { return $(id).open; });
  }

  var confirmResolve = null;
  function confirmBox(title, text, yesLabel) {
    if (confirmResolve) finishConfirm(false);
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = yesLabel || '确定';
    openDialog('confirm-dialog');
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }
  function finishConfirm(ok) {
    closeDialog('confirm-dialog');
    if (confirmResolve) { var r = confirmResolve; confirmResolve = null; r(ok); }
  }

  function showEnd(reopen) {
    var st = game.state;
    if (!st || !st.over) return;
    var rows = Engine.standings(st);
    var winners = rows.filter(function (r) { return r.rank === 1; });
    var mine = rows.filter(function (r) { return isMine(r.player); });
    var title;
    if (mine.length === 1 && (isOnlineGame() || humanCount() === 1)) {
      var me = mine[0];
      title = me.rank === 1 ? (winners.length > 1 ? '并列第一！' : '你赢了！') : '你获得第 ' + me.rank + ' 名';
    } else {
      title = winners.length > 1
        ? winners.map(function (r) { return r.player.name; }).join('、') + ' 并列第一'
        : winners[0].player.name + ' 获胜';
    }
    $('end-title').textContent = title;
    $('end-note').textContent = st.players[0].noBonus
      ? '名次按手里剩下的格子数排，剩得越少越靠前。'
      : '名次按手里剩下的格子数排，剩得越少越靠前；全部放完的排最前，最后一块是单格的更靠前。';
    $('end-rows').innerHTML = rows.map(function (r) {
      var tag = r.monoLast ? '全部放完，单格收尾' : r.allPlaced ? '全部放完' : r.player.resigned ? '中途停手' : '';
      return '<tr>' +
        '<td><span class="rank' + (r.rank === 1 ? ' first' : '') + '">' + r.rank + '</span></td>' +
        '<td><span class="who" style="--c:' + colorVar(r.player) + '"><i></i><span>' + escapeHtml(r.player.name) +
        (tag ? '<span class="bonus">' + tag + '</span>' : '') + '</span></span></td>' +
        '<td class="num left">' + r.piecesLeft + ' 块<small>' + r.remainingSquares + ' 格</small></td>' +
        '</tr>';
    }).join('');
    var onlineMode = isOnlineGame();
    var amHost = onlineMode && online.room && online.room.host === myId();
    $('end-again').disabled = onlineMode && !amHost;
    $('end-again').textContent = onlineMode && !amHost ? '等待房主再开' : '再来一局';
    $('end-menu').textContent = onlineMode ? '离开房间' : '返回菜单';
    $('end-record-note').textContent = '';
    renderRecordButtons();
    renderGame();
    openDialog('end-dialog');
    if (!reopen) sound('win');
  }

  /* ================= 对局记录与回放 ================= */

  var replay = { rec: null, n: 0, step: 0, playing: false, timer: 0, speed: 1 };
  var REPLAY_MS = 900;

  function winnersText(st) {
    var w = Engine.standings(st).filter(function (r) { return r.rank === 1; }).map(function (r) { return r.player.name; });
    return w.length > 1 ? w.join('、') + ' 并列第一' : w[0] + ' 获胜';
  }

  function loadRecords() {
    var list = load(STORE_RECORDS);
    if (!Array.isArray(list)) return [];
    return list.map(function (r) { return Record.parse(r); }).filter(Boolean);
  }

  function storeRecords(list) {
    try {
      localStorage.setItem(STORE_RECORDS, JSON.stringify(list));
      return true;
    } catch (e) {
      return false;
    }
  }

  // 存进本机的记录列表（同一局再存一次就覆盖），最多保留 RECORD_LIMIT 局
  function addRecord(rec) {
    var list = loadRecords().filter(function (r) { return r.id !== rec.id; });
    list.unshift(rec);
    if (list.length > RECORD_LIMIT) list.length = RECORD_LIMIT;
    return storeRecords(list);
  }

  function findRecord(id) {
    return loadRecords().filter(function (r) { return r.id === id; })[0] || null;
  }

  // 当前这一局的记录（同一局多次保存、导出用同一个编号）
  function currentRecord() {
    if (!game.state || !game.config) return null;
    if (!game.recordDate) game.recordDate = new Date().toISOString();
    var rec = Record.fromGame(game.config, game.state.actions, { id: game.recordId, date: game.recordDate, online: isOnlineGame() });
    if (rec) game.recordId = rec.id;
    return rec;
  }

  function renderRecordButtons() {
    $('end-save').disabled = !!game.recordSaved;
    $('end-save').textContent = game.recordSaved ? '已保存到本机' : '保存到本机';
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  function fmtDate(iso) {
    var d = new Date(iso);
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  // 文件名只用 ASCII：有的浏览器会把中文文件名换成 download
  function recordFileName(rec) {
    var d = new Date(rec.date);
    return 'blokus-' + rec.mode + '-' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) +
      '-' + two(d.getHours()) + two(d.getMinutes()) + '.json';
  }

  // 发布在 Claude 上的页面要经 downloads 能力把文件交给查看者；普通网页直接下载
  var downloadsP = null;
  function downloadsCap() {
    if (!downloadsP) {
      downloadsP = !inClaudePage() ? Promise.resolve(null) : Promise.resolve(window.claude.use('downloads')).then(function (d) {
        return d && typeof d.save === 'function' ? d : null;
      }, function () { return null; });
    }
    return downloadsP;
  }

  function browserDownload(name, text) {
    try {
      var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 结果：'saved' | 'declined' | 'failed'
  function exportRecord(rec) {
    if (!rec) return Promise.resolve('failed');
    var name = recordFileName(rec);
    var text = Record.stringify(rec);
    return downloadsCap().then(function (dl) {
      if (!dl) return browserDownload(name, text) ? 'saved' : 'failed';
      return dl.save({ filename: name, data: text }).then(function () { return 'saved'; }, function (err) {
        return err && err.code === 'declined' ? 'declined' : 'failed';
      });
    });
  }

  function exportText(result) {
    return result === 'saved' ? '已导出对局记录文件' : result === 'declined' ? '' : '导出失败：这里不能下载文件';
  }

  /* ---------- 记录列表 ---------- */

  function openRecords(msg) {
    renderRecords(msg);
    openDialog('records-dialog');
  }

  function renderRecords(msg) {
    var list = loadRecords();
    $('records-list').innerHTML = list.length ? list.map(recordItem).join('')
      : '<li class="records-empty">还没有保存的对局。对局结束时可以在结果窗口里「保存到本机」，也可以导入以前导出的文件。</li>';
    var note = $('records-note');
    note.textContent = msg || '';
    note.hidden = !msg;
  }

  function recordItem(rec) {
    var s = Record.summary(rec);
    var who = s.players.map(function (pl) {
      return '<span class="who" style="--c:var(--p-' + pl.color + ')"><i></i><span>' + escapeHtml(pl.name) + '</span></span>';
    }).join('');
    var status = !s.over ? '未下完' : s.winners.length > 1 ? s.winners.join('、') + ' 并列第一' : s.winners[0] + ' 获胜';
    return '<li class="record-item">' +
      '<div class="record-main">' +
      '<div class="record-head"><b>' + escapeHtml(MODE_LABEL[rec.mode]) + '</b><span>' + fmtDate(rec.date) + (rec.online ? ' · 联机' : '') + '</span></div>' +
      '<div class="record-who">' + who + '</div>' +
      '<small>' + s.moves + ' 手 · ' + escapeHtml(status) + '</small>' +
      '</div>' +
      '<div class="record-btns">' +
      '<button type="button" class="btn small primary" data-replay="' + rec.id + '">回放</button>' +
      '<button type="button" class="btn small" data-export="' + rec.id + '">导出</button>' +
      '<button type="button" class="btn small ghost" data-delete="' + rec.id + '">删除</button>' +
      '</div></li>';
  }

  function importRecordFile(file) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { renderRecords('文件太大，不是对局记录'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var rec = null;
      try { rec = Record.parse(JSON.parse(String(reader.result))); } catch (e) { rec = null; }
      if (!rec) { renderRecords('无法读取：这不是角斗士棋导出的对局记录文件'); return; }
      if (addRecord(rec)) {
        renderRecords('已导入：' + MODE_LABEL[rec.mode] + '，' + fmtDate(rec.date));
        return;
      }
      closeDialog('records-dialog');
      enterReplay(rec);
      toast('浏览器存储不可用，记录没有保存，直接回放', 'warn');
    };
    reader.onerror = function () { renderRecords('读取文件失败'); };
    reader.readAsText(file);
  }

  /* ---------- 回放 ---------- */

  function enterReplay(rec) {
    clearTimeout(game.endTimer);
    closeDialog('end-dialog');
    cancelAI();
    stopReplay();
    replay.rec = rec;
    replay.n = rec.actions.length;
    game.mode = 'replay';
    $('toast').hidden = true;
    game.config = Record.configOf(rec);
    game.gameId = null;
    game.seenGameId = null;
    game.state = Engine.createGame(game.config);
    game.eventCursor = game.state.events.length;
    game.paused = false;
    game.anim = null;
    game.turnKey = '';
    game.viewPlayer = null;
    game.perPiece = null;
    game.anchors = null;
    resetSelection();
    showScreen('game');
    prepareView(true);
    buildReplayMoves();
    renderGame();
    setReplayPlaying(true);
  }

  function exitReplay() {
    stopReplay();
    showScreen('setup');
    openRecords();
  }

  function stopReplay() {
    pauseReplay();
    replay.rec = null;
    replay.n = 0;
    replay.step = 0;
  }

  // 走到第 k 步之后的局面；向前一步时直接接着下，并播放落子动画
  function goReplay(k) {
    k = clamp(k, 0, replay.n);
    var st = game.state;
    var forward = k === replay.step + 1;
    if (forward) {
      var a = replay.rec.actions[k - 1];
      Engine.applyAction(st, a);
      if (a.note) st.actions[st.actions.length - 1].note = a.note;
    } else if (k !== replay.step) {
      game.state = st = replayWithNotes(game.config, replay.rec.actions.slice(0, k));
    }
    replay.step = k;
    game.eventCursor = st.events.length;
    var last = k ? replay.rec.actions[k - 1] : null;
    game.anim = forward && last.type === 'place' && st.lastMove
      ? { cells: cellsToIdx(st, st.lastMove.cells), player: last.player, t0: performance.now() } : null;
    if (game.anim) sound('place', true);
    renderGame();
    animate();
  }

  function replayJump(k) {
    pauseReplay();
    goReplay(k);
  }

  function replayStep(d) { replayJump(replay.step + d); }

  function replayDelay() { return Math.round(REPLAY_MS / replay.speed); }

  function setReplayPlaying(on) {
    clearTimeout(replay.timer);
    replay.timer = 0;
    replay.playing = !!on && replay.n > 0;
    if (replay.playing && replay.step >= replay.n) goReplay(0);
    if (replay.playing) replay.timer = setTimeout(replayTick, replayDelay());
    renderReplayControls();
  }

  function pauseReplay() {
    if (replay.playing || replay.timer) setReplayPlaying(false);
  }

  function toggleReplayPlay() { setReplayPlaying(!replay.playing); }

  function replayTick() {
    replay.timer = 0;
    if (!isReplay() || !replay.playing || $('game').hidden) return;
    goReplay(replay.step + 1);
    if (replay.step >= replay.n) {
      replay.playing = false;
      renderReplayControls();
      return;
    }
    replay.timer = setTimeout(replayTick, replayDelay());
  }

  // 下棋流程列表：每一步一行，点一下跳到那一步
  function buildReplayMoves() {
    var st = game.state;
    var set = st.set;
    var items = ['<li><button type="button" data-step="0" style="--c:var(--line)"><span class="rp-n">0</span><i aria-hidden="true"></i><span class="rp-who">开局</span></button></li>'];
    replay.rec.actions.forEach(function (a, i) {
      var pl = st.players[a.player];
      var what = a.type === 'place' ? set.pieces[a.piece].name : '停手';
      items.push('<li><button type="button" data-step="' + (i + 1) + '" style="--c:' + colorVar(pl) + '">' +
        '<span class="rp-n">' + (i + 1) + '</span><i aria-hidden="true"></i>' +
        '<span class="rp-who">' + escapeHtml(pl.name) + '</span><span class="rp-what">' + escapeHtml(what) + '</span>' +
        (a.note ? '<span class="rp-note">' + escapeHtml(a.note) + '</span>' : '') +
        '</button></li>');
    });
    $('rp-moves').innerHTML = items.join('');
    $('rp-moves').scrollTop = 0;
    $('rp-range').max = replay.n;
  }

  function renderReplayControls() {
    if (!replay.rec) return;
    var k = replay.step;
    $('rp-range').value = k;
    $('rp-first').disabled = k === 0;
    $('rp-prev').disabled = k === 0;
    $('rp-next').disabled = k >= replay.n;
    $('rp-last').disabled = k >= replay.n;
    $('rp-play').textContent = replay.playing ? '暂停' : k >= replay.n ? '从头播放' : '播放';
    var list = $('rp-moves');
    var old = list.querySelector('[aria-current]');
    if (old) old.removeAttribute('aria-current');
    var btn = list.querySelector('[data-step="' + k + '"]');
    if (!btn) return;
    btn.setAttribute('aria-current', 'step');
    // 只滚动列表本身，不带动整个页面
    var li = btn.parentNode;
    var top = li.offsetTop, bottom = top + li.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }

  /* ================= 联机 ================= */

  var netInfo = { ready: false, net: null, reason: null, promise: null };

  function ensureNet() {
    if (!netInfo.promise) {
      netInfo.promise = Net.detect().then(function (r) {
        netInfo.ready = true;
        netInfo.net = r.net;
        netInfo.reason = r.reason;
        renderOnlinePanel();
        return r;
      }, function () {
        netInfo.ready = true;
        netInfo.reason = 'error';
        renderOnlinePanel();
      });
    }
    return netInfo.promise;
  }

  function canWrite() { return !(netInfo.net && netInfo.net.canWrite === false); }

  function renderOnlinePanel() {
    var note = $('online-note');
    var net = netInfo.net;
    var usable = !!net;
    $('create-room').disabled = !usable || !canWrite();
    $('join-room').disabled = !usable;
    $('join-code').disabled = !usable;
    $('nick').value = prefs.nick;
    if (!netInfo.ready) note.textContent = '正在检查联机功能…';
    else if (net && net.kind === 'artifact') {
      note.textContent = canWrite()
        ? '这个页面自带联机：建房后把房间号发给朋友。朋友需要能打开本页面，并且有“可编辑”或“参与者”权限。'
        : '你对这个页面只有查看权限：可以输入房间号观战，但不能建房或入座。请页面主人把你设为可编辑。';
    } else if (net) note.textContent = '已连上联机服务器。能打开这个网址的朋友都可以用房间号加入。';
    else if (netInfo.reason === 'file' || netInfo.reason === 'static') {
      note.innerHTML = '联机需要服务器：在项目目录运行 <code>node server.js</code>，再用浏览器打开 <code>http://localhost:8080</code>；同一网络里的朋友访问你电脑的局域网地址即可。';
    } else note.textContent = '这个页面没有开启联机功能。';
    var last = load(STORE_ONLINE);
    var rejoin = $('rejoin-room');
    rejoin.hidden = !(usable && last && last.code && !online);
    if (!rejoin.hidden) rejoin.textContent = '回到房间 ' + last.code;
  }

  function showOnlineError(msg) {
    var el = $('online-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function tokenFor(code) {
    var map = load(STORE_TOKENS) || {};
    if (!map[code] || typeof map[code] !== 'string') {
      map[code] = Net.randomToken();
      var keys = Object.keys(map);
      if (keys.length > 12) delete map[keys[0]];
      save(STORE_TOKENS, map);
    }
    return map[code];
  }

  function setTokenFor(code, token) {
    var map = load(STORE_TOKENS) || {};
    map[code] = token;
    save(STORE_TOKENS, map);
  }

  function nickName() { return Online.cleanName(prefs.nick) || '玩家'; }

  function setOnlineBusy(busy) {
    ['create-room', 'join-room', 'rejoin-room'].forEach(function (id) { $(id).disabled = busy || !netInfo.net; });
    if (!busy) renderOnlinePanel();
  }

  function createOnlineRoom() {
    var net = netInfo.net;
    if (!net) return;
    unlockAudio();
    showOnlineError(null);
    setOnlineBusy(true);
    var token = Net.randomToken();
    net.create(token, nickName(), prefs.mode).then(function (code) {
      setTokenFor(code, token);
      return joinRoom(code, { autoClaim: false });
    }).catch(function (e) {
      showOnlineError(e.message || '建房失败，请重试');
    }).then(function () { setOnlineBusy(false); });
  }

  function joinRoom(code, opts) {
    var net = netInfo.net;
    if (!net) return Promise.resolve();
    unlockAudio();
    showOnlineError(null);
    return net.exists(code).then(function (ok) {
      if (!ok) throw new Error('找不到房间 ' + code + '，请检查房间号');
      if (online) closeSession(false);
      var token = tokenFor(code);
      online = {
        net: net,
        code: code,
        token: token,
        pid: null,
        room: null,
        peers: null,
        connected: true,
        pending: null,
        aiTimer: 0,
        aiBusy: -1,
        aiAbort: null,
        hostMissingSince: 0,
        hostTried: -1,
        autoClaim: !(opts && opts.autoClaim === false),
        tick: setInterval(onlineTick, 3000),
        previews: {},
        pvSent: 'null'
      };
      save(STORE_ONLINE, { code: code });
      var session = online;
      function live(fn) {
        return function () { if (online === session) fn.apply(null, arguments); };
      }
      net.connect(code, token, {
        onIdentity: live(function (id) { online.pid = id; renderOnlineViews(); }),
        onRoom: live(onRoom),
        onPeers: live(function (ids) { online.peers = ids; renderOnlineViews(); maybeRunAI(); }),
        onPreview: live(function (id, pv) {
          var had = !!remotePreviewSafe();
          online.previews[id] = pv;
          if ($('game').hidden || !game.state) return;
          if (had !== !!remotePreviewSafe()) renderTurn();
          drawBoard();
        }),
        onConnection: live(function (c) { online.connected = c; renderOnlineViews(); }),
        onGone: live(function () {
          closeSession(true);
          save(STORE_ONLINE, null);
          prefs.tab = 'online';
          showScreen('setup');
          showOnlineError('房间 ' + code + ' 已解散');
        }),
        onError: live(function (msg) { lobbyError(msg); })
      });
      game.mode = 'online';
      showScreen('lobby');
      renderLobby();
    }).catch(function (e) {
      showOnlineError(e.message || '加入失败，请重试');
    });
  }

  function onRoom(room) {
    online.room = room;
    if (online.autoClaim && room.status === 'lobby' && online.pid && canWrite()) {
      online.autoClaim = false;
      var hasSeat = room.seats.some(function (s) { return s.owner === online.pid; });
      var free = room.seats.findIndex(function (s) { return s.kind === 'open' && !s.owner; });
      if (!hasSeat && free >= 0) sendOp({ type: 'claim', seat: free, name: nickName() }, true).catch(function () {});
    }
    if (room.status === 'lobby') {
      if ($('lobby').hidden) {
        closeDialog('end-dialog');
        clearTimeout(game.endTimer);
        game.state = null;
        game.gameId = null;
        showScreen('lobby');
      }
      renderLobby();
    } else {
      syncOnlineGame(room);
    }
  }

  function renderOnlineViews() {
    if (!online) return;
    if (!$('lobby').hidden) renderLobby();
    if (!$('game').hidden && game.state) renderGame();
  }

  function onlineTick() {
    if (!online || !online.room || !online.peers || !online.pid) return;
    var room = online.room;
    if (online.peers.indexOf(room.host) >= 0) {
      online.hostMissingSince = 0;
      return;
    }
    if (!online.hostMissingSince) {
      online.hostMissingSince = Date.now();
      return;
    }
    if (Date.now() - online.hostMissingSince < 8000 || online.hostTried === room.rev) return;
    var owners = Online.seatOwners(room).filter(function (id) { return online.peers.indexOf(id) >= 0; }).sort();
    if (owners[0] !== online.pid) return;
    online.hostTried = room.rev;
    sendOp({ type: 'host' }, true).then(function () { toast('原房主已离线，你成为了房主'); }, function () {});
  }

  function sendOp(op, quiet) {
    if (!online) return Promise.reject(new Error('不在房间里'));
    return online.net.op(op).catch(function (err) {
      if (!quiet && err.code !== 'stale') lobbyError(err.message);
      throw err;
    });
  }

  function lobbyError(msg) {
    if (!$('lobby').hidden) {
      var el = $('lobby-error');
      el.textContent = msg;
      el.hidden = !msg;
    } else if (!$('game').hidden) {
      toast(msg, 'warn');
    }
  }

  function closeSession(notify) {
    if (!online) return;
    var o = online;
    online = null;
    clearInterval(o.tick);
    clearTimeout(o.aiTimer);
    if (o.aiAbort) o.aiAbort.abort();
    clearTimeout(o.pvTimer);
    o.net.disconnect();
    if (!notify) o.net.opAt(o.code, o.token, { type: 'leave' }).catch(function () {});
    game.mode = 'local';
    game.state = null;
    game.gameId = null;
  }

  function leaveRoom() {
    var playing = online && online.room && online.room.status === 'playing' && myPlayers().length && !game.state.over;
    var go = function () {
      closeSession(false);
      save(STORE_ONLINE, null);
      closeDialog('end-dialog');
      prefs.tab = 'online';
      showScreen('setup');
    };
    if (!playing) return go();
    confirmBox('离开房间？', '对局还在进行。离开后你的棋子会停在原地，房主可以把你的座位交给电脑。', '离开').then(function (ok) {
      if (ok) go();
    });
  }

  function renderLobby() {
    if (!online) return;
    $('lobby-code').textContent = online.code;
    var conn = $('lobby-conn');
    conn.textContent = online.connected ? '已连接' : '重新连接中…';
    conn.classList.toggle('off', !online.connected);
    var room = online.room;
    var seatsEl = $('lobby-seats');
    if (!room || !online.pid) {
      seatsEl.innerHTML = '<li class="seat"><span class="seat-swatch"></span><div class="ls-main"><b>正在进入房间…</b></div></li>';
      $('lobby-start').hidden = true;
      return;
    }
    var me = online.pid;
    var isHost = room.host === me;
    var M = Engine.MODES[room.mode];
    var known = peersKnown();

    $('lobby-mode').innerHTML = MODE_LIST.map(function (m) {
      return '<label><input type="radio" name="lobby-mode" id="lobby-mode-' + m + '" value="' + m + '"' + (room.mode === m ? ' checked' : '') +
        (isHost ? '' : ' disabled') + '><span>' + MODE_LABEL[m] + '</span></label>';
    }).join('');

    seatsEl.innerHTML = M.seats.map(function (seat, i) {
      var s = room.seats[i];
      var mine = s.owner === me;
      var title, sub;
      if (s.kind === 'off') { title = '空位'; sub = '本局不参战'; }
      else if (s.kind === 'ai') { title = seat.label + '方电脑'; sub = '电脑 · ' + LEVEL_LABEL[s.level] + (s.level === 'llm' && s.model ? ' · ' + s.model : ''); }
      else if (s.owner) {
        title = s.name || '玩家';
        sub = (mine ? '你' : '玩家') + (s.owner === room.host ? ' · 房主' : '') + (known ? (isPeerOnline(s.owner) ? ' · 在线' : ' · 离线') : '');
      } else { title = '等待玩家入座'; sub = '空着的玩家座位'; }
      var actions = '';
      if (s.kind === 'open' && !s.owner && canWrite()) actions += '<button type="button" class="btn primary" data-claim="' + i + '">入座</button>';
      if (mine) actions += '<button type="button" class="btn" data-release="' + i + '">离座</button>';
      var hostCtl = '';
      if (isHost) {
        var kinds = [['open', '玩家'], ['ai', '电脑']];
        if (room.mode !== 'duo') kinds.push(['off', '空位']);
        actions += '<div class="seg small" role="radiogroup" aria-label="' + seat.label + '方">' + kinds.map(function (k) {
          return '<label><input type="radio" name="lobby-kind-' + i + '" value="' + k[0] + '" data-kind="' + i + '"' + (s.kind === k[0] ? ' checked' : '') + '><span>' + k[1] + '</span></label>';
        }).join('') + '</div>';
        if (s.kind === 'ai') {
          hostCtl = '<div class="seat-level">难度 <div class="seg small" role="radiogroup" aria-label="电脑难度">' + Object.keys(LEVEL_LABEL).map(function (lv) {
            return '<label><input type="radio" name="lobby-level-' + i + '" value="' + lv + '" data-level="' + i + '"' + (s.level === lv ? ' checked' : '') + '><span>' + LEVEL_LABEL[lv] + '</span></label>';
          }).join('') + '</div>' +
            (s.level === 'llm' ? '<label class="seat-model">模型 <select data-model="' + i + '" aria-label="' + seat.label + '方用的模型">' + profileOptions(s.model) + '</select></label>' : '') +
            '</div>';
        }
      }
      return '<li class="seat lobby-seat' + (s.kind === 'off' ? ' off' : '') + (mine ? ' mine' : '') + '" style="--c: var(--p-' + seat.color + ')">' +
        '<span class="seat-swatch" aria-hidden="true">' + seat.label + '</span>' +
        '<div class="ls-main"><b>' + escapeHtml(title) + '</b><small>' + escapeHtml(sub) + '</small></div>' +
        '<div class="ls-actions">' + actions + '</div>' + hostCtl +
        '</li>';
    }).join('');

    $('lobby-speed').value = room.speed;
    $('lobby-speed').disabled = !isHost;
    if (document.activeElement !== $('lobby-nick')) $('lobby-nick').value = prefs.nick;

    var start = $('lobby-start');
    var wait = $('lobby-wait');
    start.hidden = !isHost;
    if (isHost) {
      var check = Online.applyOp(room, { type: 'start' }, me, { now: Date.now() });
      start.disabled = !!check.error;
      wait.textContent = check.error || '';
    } else {
      wait.textContent = '等待房主开始对局…';
    }

    var people = $('lobby-people');
    var ids = known ? online.peers.slice() : Online.seatOwners(room);
    if (ids.indexOf(me) < 0) ids.unshift(me);
    people.innerHTML = ids.map(function (id) {
      var seatIdx = room.seats.findIndex(function (s) { return s.owner === id; });
      var name = seatIdx >= 0 ? room.seats[seatIdx].name : '观众';
      var color = seatIdx >= 0 ? 'var(--p-' + M.seats[seatIdx].color + ')' : 'var(--ink-soft)';
      var tag = (id === me ? '你' : '') + (id === room.host ? (id === me ? ' · ' : '') + '房主' : '');
      return '<li style="--c:' + color + '"><i></i><span>' + escapeHtml(name) + '</span><small>' + tag + '</small></li>';
    }).join('');
  }

  /* ================= 事件绑定 ================= */

  function bindBoard() {
    var canvas = $('board');
    var orbit = null;

    canvas.addEventListener('pointermove', function (e) {
      if (!game.state) return;
      if (orbit) {
        var dx = e.clientX - orbit.x, dy = e.clientY - orbit.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) orbit.moved = true;
        var cam = game.view.cam;
        cam.yaw = orbit.yaw - dx * 0.009;
        cam.pitch = View3D.clampPitch(orbit.pitch + dy * 0.006);
        game.view.camTarget = null;
        drawBoard();
        return;
      }
      var cell = game.view.cellAt(e.clientX, e.clientY, game.state);
      if (e.pointerType === 'mouse') {
        game.hover = cell;
        if (!canAct() || game.sel.piece < 0 || !cell) return;
        if (game.hintLockCell) {
          if (sameCell(cell, game.hintLockCell)) return;
          game.hintLockCell = null;
        }
        if (sameCell(cell, game.ghost)) return;
        game.ghost = copyCell(cell);
        clampGhost();
        drawBoard();
      } else if (game.touch && cell) {
        if (!sameCell(cell, game.touch.start)) game.touch.moved = true;
        game.ghost = copyCell(cell);
        clampGhost();
        drawBoard();
      }
    });

    canvas.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'mouse') game.hover = null;
    });

    canvas.addEventListener('pointerdown', function (e) {
      if (!game.state) return;
      // 立体：右键拖动、Shift+拖动，或没选棋子时拖动 = 旋转视角
      if (is3D() && (e.button === 2 || (e.button === 0 && (e.shiftKey || game.sel.piece < 0 || !canAct())))) {
        e.preventDefault();
        var cam = game.view.cam || (game.view.cam = { yaw: View3D.DEFAULT_CAM.yaw, pitch: View3D.DEFAULT_CAM.pitch });
        orbit = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch, button: e.button, shift: e.shiftKey, moved: false };
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        return;
      }
      if (e.button === 2) { e.preventDefault(); rotate(1); return; }
      if (e.button === 1) { e.preventDefault(); flip(); return; }
      if (e.button !== 0) return;
      if (!canAct()) return;
      var cell = game.view.cellAt(e.clientX, e.clientY, game.state);
      if (game.sel.piece < 0) {
        toast('先在托盘里选一块棋子');
        return;
      }
      if (!cell) return;
      if (e.pointerType === 'mouse') {
        game.ghost = copyCell(cell);
        game.hintLockCell = null;
        clampGhost();
        tryPlace();
        return;
      }
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      var prev = game.ghost && game.ghostByTap ? copyCell(game.ghost) : null;
      game.ghost = copyCell(cell);
      clampGhost();
      game.touch = { start: cell, prev: prev, moved: false };
      drawBoard();
    });

    canvas.addEventListener('pointerup', function (e) {
      if (orbit) {
        var o = orbit;
        orbit = null;
        if (!o.moved) {
          if (o.button === 2) rotate(1);
          else if (!o.shift && canAct() && game.sel.piece < 0) toast('先在托盘里选一块棋子；拖动可以旋转视角');
        }
        renderSelection();
        return;
      }
      if (e.pointerType === 'mouse' || !game.touch) return;
      var t = game.touch;
      game.touch = null;
      // 在同一位置再点一次即放置
      if (!t.moved && sameCell(t.prev, game.ghost)) {
        tryPlace();
        return;
      }
      game.ghostByTap = true;
      drawBoard();
    });

    canvas.addEventListener('pointercancel', function () { game.touch = null; orbit = null; });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('wheel', function (e) {
      if (!canAct() || game.sel.piece < 0) return;
      e.preventDefault();
      var now = performance.now();
      if (now - game.lastWheel < 140) return;
      game.lastWheel = now;
      rotate(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
  }

  function moveGhostBy(dir) {
    var topo = game.state.topo;
    if (!game.ghost) {
      game.ghost = defaultGhost();
    } else if (topo.dims === 3) {
      var s = View3D.screenStep(game.view, dir, topo.kind);
      game.ghost = { x: game.ghost.x + s[0], z: game.ghost.z + s[1] };
    } else {
      var tri = topo.kind === 'tri';
      var d = { left: [tri ? -2 : -1, 0], right: [tri ? 2 : 1, 0], up: [0, -1], down: [0, 1] }[dir];
      // 平顶六边形：左右换列时上下交替半格，保持水平移动
      if (topo.kind === 'hex' && d[0]) d = [d[0], d[0] < 0 ? (game.ghost.x & 1 ? 1 : 0) : (game.ghost.x & 1 ? 0 : -1)];
      var nx = game.ghost.x + d[0], ny = game.ghost.y + d[1];
      if (tri && (nx < 0 || ny < 0 || nx >= topo.cols || ny >= topo.rows || !topo.valid[ny * topo.cols + nx])) return;
      game.ghost = { x: nx, y: ny };
    }
    game.hintLockCell = null;
    clampGhost();
    drawBoard();
  }

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      if ($('game').hidden || anyDialogOpen() || !game.state) return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      var key = e.key;
      if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'Z')) {
        e.preventDefault();
        undo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var cube = is3D();
      var k = key.length === 1 ? key.toLowerCase() : key;
      if (isReplay()) {
        var steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 };
        if (steps[key]) { e.preventDefault(); replayStep(steps[key]); return; }
        if (key === 'Home') { e.preventDefault(); replayJump(0); return; }
        if (key === 'End') { e.preventDefault(); replayJump(replay.n); return; }
        if (key === ' ' && (document.activeElement === document.body || document.activeElement === $('board'))) {
          e.preventDefault();
          toggleReplayPlay();
          return;
        }
        if (!cube) return;
      }
      if (k === 'r') { rotate(e.shiftKey ? -1 : 1); return; }
      if (k === 'f') { flip(); return; }
      if (k === 'h') { giveHint(); return; }
      if (cube) {
        if (k === 'x') { setXray(!(game.view && game.view.xray)); return; }
        if (k === '[') { setSlice(+$('layer-range').value - 1); return; }
        if (k === ']') { setSlice(+$('layer-range').value + 1); return; }
        if (k === 'g') { roll(); return; }
        if (k === 'q') { turnCamera(-1, 0); return; }
        if (k === 'e') { turnCamera(1, 0); return; }
      } else if (k === 'e') { rotate(-1); return; }
      if (key === 'Escape') {
        if (game.sel.piece >= 0) { game.sel.piece = -1; game.hint = null; renderDock(); drawBoard(); }
        return;
      }
      var dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      if (dirs[key] && canAct() && game.sel.piece >= 0) {
        e.preventDefault();
        moveGhostBy(dirs[key]);
        return;
      }
      var focusOk = document.activeElement === document.body || document.activeElement === $('board');
      if ((key === 'Enter' || key === ' ') && focusOk && canAct() && game.sel.piece >= 0) {
        e.preventDefault();
        if (!game.ghost) { game.ghost = defaultGhost(); clampGhost(); drawBoard(); }
        else tryPlace();
      }
    });
  }

  function bindUI() {
    $('local-panel').addEventListener('submit', function (e) {
      e.preventDefault();
      unlockAudio();
      var cfg = buildLocalConfig();
      if (!cfg) {
        var err = $('setup-error');
        err.textContent = prefs.mode === 'gemblo'
          ? '宝石阵需要 3、4 或 6 方参战（两人对战时每人各执两色）。'
          : '至少需要两方参战，请把一个空位改成玩家或电脑。';
        err.hidden = false;
        return;
      }
      enterGame('local', cfg);
    });

    [['tab-local', 'local'], ['tab-online', 'online']].forEach(function (t) {
      $(t[0]).addEventListener('click', function () {
        prefs.tab = t[1];
        savePrefs();
        renderSetup();
        if (t[1] === 'online') ensureNet();
      });
    });

    document.querySelectorAll('input[name="mode"]').forEach(function (r) {
      r.addEventListener('change', function () {
        prefs.mode = r.value;
        savePrefs();
        renderSetup();
      });
    });
    $('opt-hints').addEventListener('change', function (e) { prefs.hints = e.target.checked; savePrefs(); });
    $('opt-sound').addEventListener('change', function (e) { prefs.sound = e.target.checked; savePrefs(); });
    $('opt-speed').addEventListener('change', function (e) { prefs.speed = e.target.value; savePrefs(); });
    $('opt-dark').addEventListener('change', function (e) { setTheme(e.target.checked); });

    $('resume-btn').addEventListener('click', function () {
      unlockAudio();
      var s = loadSaved();
      if (!s) { renderSetup(); return; }
      enterGame('local', s.config, s.actions);
    });

    // 联机入口
    $('nick').addEventListener('input', function (e) { prefs.nick = Online.cleanName(e.target.value); savePrefs(); });
    $('create-room').addEventListener('click', createOnlineRoom);
    function doJoin() {
      var code = Online.normalizeCode($('join-code').value);
      if (!code) { showOnlineError('房间号是 5 位字母或数字'); return; }
      setOnlineBusy(true);
      joinRoom(code).then(function () { setOnlineBusy(false); });
    }
    $('join-room').addEventListener('click', doJoin);
    $('join-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
    $('rejoin-room').addEventListener('click', function () {
      var last = load(STORE_ONLINE);
      if (!last || !last.code) return;
      setOnlineBusy(true);
      joinRoom(last.code, { autoClaim: false }).then(function () { setOnlineBusy(false); });
    });

    // 房间
    $('lobby-leave').addEventListener('click', leaveRoom);
    $('copy-code').addEventListener('click', function () {
      if (!online) return;
      var btn = $('copy-code');
      function done(ok) {
        btn.textContent = ok ? '已复制' : '请手动复制';
        setTimeout(function () { btn.textContent = '复制'; }, 1600);
        if (!ok) {
          var range = document.createRange();
          range.selectNodeContents($('lobby-code'));
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      try {
        navigator.clipboard.writeText(online.code).then(function () { done(true); }, function () { done(false); });
      } catch (e) { done(false); }
    });
    $('lobby-mode').addEventListener('change', function (e) {
      if (e.target.name === 'lobby-mode') sendOp({ type: 'mode', mode: e.target.value }).catch(renderLobby);
    });
    $('lobby-seats').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      $('lobby-error').hidden = true;
      if (b.dataset.claim) sendOp({ type: 'claim', seat: +b.dataset.claim, name: nickName() }).catch(function () {});
      if (b.dataset.release) sendOp({ type: 'release', seat: +b.dataset.release }).catch(function () {});
    });
    $('lobby-seats').addEventListener('change', function (e) {
      var t = e.target;
      $('lobby-error').hidden = true;
      if (t.dataset.kind) sendOp({ type: 'seat', seat: +t.dataset.kind, kind: t.value }).catch(renderLobby);
      if (t.dataset.level) {
        var op = { type: 'seat', seat: +t.dataset.level, level: t.value };
        if (t.value === 'llm') {
          op.model = llmProfile(online && online.room && online.room.seats[op.seat] ? online.room.seats[op.seat].model : '').name;
          ensureLLMSetup(op.model);
        }
        sendOp(op).catch(renderLobby);
      }
      if (t.dataset.model) {
        sendOp({ type: 'seat', seat: +t.dataset.model, model: t.value }).catch(renderLobby);
        ensureLLMSetup(t.value);
      }
    });
    $('lobby-speed').addEventListener('change', function (e) { sendOp({ type: 'speed', speed: e.target.value }).catch(renderLobby); });
    $('lobby-nick').addEventListener('change', function (e) {
      prefs.nick = Online.cleanName(e.target.value);
      savePrefs();
      if (online && online.room && online.room.seats.some(function (s) { return s.owner === online.pid; }) && prefs.nick) {
        sendOp({ type: 'rename', name: prefs.nick }).catch(function () {});
      }
    });
    $('lobby-start').addEventListener('click', function () {
      unlockAudio();
      $('lobby-error').hidden = true;
      sendOp({ type: 'start' }).catch(function () {});
    });

    // 对局
    document.querySelectorAll('.rules-open').forEach(function (b) {
      b.addEventListener('click', function () { openDialog('rules-dialog'); });
    });
    $('rules-close').addEventListener('click', function () { closeDialog('rules-dialog'); });
    bindLlmDialog();

    $('menu-btn').addEventListener('click', function () {
      if (isReplay()) { exitReplay(); return; }
      if (isOnlineGame()) { leaveRoom(); return; }
      saveGame();
      showScreen('setup');
    });
    $('players').addEventListener('click', function (e) {
      var b = e.target.closest('[data-takeover]');
      if (b) {
        sendOp({ type: 'takeover', player: +b.dataset.takeover }).catch(function () {});
        return;
      }
      var card = e.target.closest('.pcard');
      if (card && game.state) viewPlayerPieces(+card.dataset.player);
    });
    $('players').addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('pcard')) {
        e.preventDefault();
        viewPlayerPieces(+e.target.dataset.player);
      }
    });
    $('dock-back').addEventListener('click', function () {
      game.viewPlayer = null;
      renderPlayers();
      renderDock();
    });
    $('xray-btn').addEventListener('click', function () { setXray(!(game.view && game.view.xray)); });
    $('layer-range').addEventListener('input', function (e) { setSlice(+e.target.value); });
    $('hint-btn').addEventListener('click', giveHint);
    $('undo-btn').addEventListener('click', undo);
    $('pause-btn').addEventListener('click', function () {
      game.paused = !game.paused;
      if (game.paused) cancelAI();
      else scheduleAI();
      renderGame();
    });
    $('sound-btn').addEventListener('click', function () {
      prefs.sound = !prefs.sound;
      savePrefs();
      if (prefs.sound) unlockAudio();
      renderTurn();
    });

    $('rot-ccw').addEventListener('click', function () { rotate(-1); });
    $('rot-cw').addEventListener('click', function () { rotate(1); });
    $('flip-btn').addEventListener('click', flip);
    $('roll-btn').addEventListener('click', roll);
    $('cam-left').addEventListener('click', function () { turnCamera(-1, 0); });
    $('cam-right').addEventListener('click', function () { turnCamera(1, 0); });
    $('cam-up').addEventListener('click', function () { turnCamera(0, 1); });
    $('cam-down').addEventListener('click', function () { turnCamera(0, -1); });
    $('place-btn').addEventListener('click', tryPlace);
    $('resign-btn').addEventListener('click', resign);

    $('end-again').addEventListener('click', function () {
      if (isOnlineGame()) {
        sendOp({ type: 'rematch' }).catch(function () {});
        return;
      }
      closeDialog('end-dialog');
      enterGame('local', game.config);
    });
    $('end-menu').addEventListener('click', function () {
      closeDialog('end-dialog');
      if (isOnlineGame()) { leaveRoom(); return; }
      showScreen('setup');
    });
    $('end-view').addEventListener('click', function () { closeDialog('end-dialog'); });
    $('end-save').addEventListener('click', function () {
      var rec = currentRecord();
      if (!rec) return;
      if (addRecord(rec)) {
        game.recordSaved = true;
        renderRecordButtons();
        $('end-record-note').textContent = '已保存，可以在开局页面的「对局记录」里回放';
      } else {
        $('end-record-note').textContent = '保存失败：浏览器存储不可用或已满，可以改用导出文件';
      }
    });
    $('end-export').addEventListener('click', function () {
      exportRecord(currentRecord()).then(function (r) { $('end-record-note').textContent = exportText(r); });
    });
    $('result-btn').addEventListener('click', function () { showEnd(true); });
    $('theme-btn').addEventListener('click', function () { setTheme(prefs.theme !== 'dark'); });

    // 对局记录与回放
    $('records-open').addEventListener('click', function () { openRecords(); });
    $('records-close').addEventListener('click', function () { closeDialog('records-dialog'); });
    $('records-import').addEventListener('click', function () {
      var f = $('records-file');
      f.value = '';
      f.click();
    });
    $('records-file').addEventListener('change', function (e) { importRecordFile(e.target.files && e.target.files[0]); });
    $('records-list').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var rec = findRecord(b.dataset.replay || b.dataset.export || b.dataset.delete || '');
      if (!rec) { renderRecords(); return; }
      if (b.dataset.replay) {
        closeDialog('records-dialog');
        unlockAudio();
        enterReplay(rec);
      } else if (b.dataset.export) {
        exportRecord(rec).then(function (r) { if (exportText(r)) renderRecords(exportText(r)); });
      } else {
        confirmBox('删除这局记录？', MODE_LABEL[rec.mode] + '，' + fmtDate(rec.date) + '。删除后不能恢复。', '删除').then(function (ok) {
          if (!ok) return;
          storeRecords(loadRecords().filter(function (r) { return r.id !== rec.id; }));
          renderRecords('已删除');
        });
      }
    });
    $('rp-first').addEventListener('click', function () { replayJump(0); });
    $('rp-prev').addEventListener('click', function () { replayStep(-1); });
    $('rp-next').addEventListener('click', function () { replayStep(1); });
    $('rp-last').addEventListener('click', function () { replayJump(replay.n); });
    $('rp-play').addEventListener('click', toggleReplayPlay);
    $('rp-range').addEventListener('input', function (e) { replayJump(+e.target.value); });
    $('rp-speed').addEventListener('change', function (e) {
      replay.speed = +e.target.value || 1;
      if (replay.playing) setReplayPlaying(true);
    });
    $('rp-moves').addEventListener('click', function (e) {
      var b = e.target.closest('[data-step]');
      if (b) replayJump(+b.dataset.step);
    });
    $('rp-export').addEventListener('click', function () {
      exportRecord(replay.rec).then(function (r) { if (exportText(r)) toast(exportText(r), r === 'saved' ? '' : 'warn'); });
    });

    $('confirm-yes').addEventListener('click', function () { finishConfirm(true); });
    $('confirm-no').addEventListener('click', function () { finishConfirm(false); });
    $('confirm-dialog').addEventListener('cancel', function () { finishConfirm(false); });

    window.addEventListener('resize', function () {
      if (game.view && game.view.resize()) game.view.draw();
      if (demo.view && demo.view.resize()) demo.view.draw();
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !$('setup').hidden) demoStep();
    });
  }

  /* ================= 启动 ================= */

  applyTheme();
  readPalette();
  bindUI();
  // 等大模型时每秒刷新一次用时
  setInterval(function () {
    if ($('game').hidden || !game.state || game.state.over || game.paused) return;
    var pl = cur();
    if (pl.type === 'ai' && pl.level === 'llm') renderTurn();
  }, 1000);
  bindBoard();
  bindKeys();
  showScreen('setup');
  ensureNet();
  claudeSample();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { if (demo.view && demo.view.resize()) demo.view.draw(); });
  }
})();
