/*
 * 角斗士棋界面：开局设置、联机房间、棋盘绘制（方格 / 三角格）、人机交互、电脑回合调度、存档。
 */
// 先等游戏平台（CrazyGames SDK）初始化好再启动；不在平台上时立即启动
(function (start) {
  var P = window.BlokusPlatform;
  if (P) P.init().then(start, start);
  else start();
})(function () {
  'use strict';

  var Pieces = BlokusPieces;
  var Engine = BlokusEngine;
  var AI = BlokusAI;
  var LLM = BlokusLLM;
  var Online = BlokusOnline;
  var Net = BlokusNet;
  var Record = BlokusRecord;
  var I18n = BlokusI18n;
  var t = I18n.t;
  var EMPTY = Engine.EMPTY;

  var MODE_LIST = ['classic', 'duo', 'trigon', 'gemblo', 'cube', 'prism'];
  var LEVELS = ['easy', 'normal', 'hard', 'expert', 'llm'];
  var SPEED_MS = { fast: 200, normal: 550, slow: 1100 };
  var View3D = BlokusView3D;
  var STORE_PREFS = 'blokus.prefs.v1';
  var STORE_SAVE = 'blokus.save.v1';
  var STORE_ONLINE = 'blokus.online.v1';
  var STORE_TOKENS = 'blokus.tokens.v1';
  var STORE_LLM = 'blokus.llm.v1';
  var STORE_RECORDS = 'blokus.records.v1';
  var STORE_TOURS = 'blokus.tours.v1';
  var Platform = window.BlokusPlatform || {
    gameplay: function () {}, muted: function () { return false; }, locale: function () { return null; },
    endOfGameAd: function () { return Promise.resolve('none'); }, happytime: function () {}, loaded: function () {},
    store: function () { try { return window.localStorage; } catch (e) { return null; } },
    crazyGames: false, active: false
  };
  // 只存在这台设备上的键：大模型密钥、联机身份和房间；其余（偏好、引导、记录、未下完的局）在游戏平台上随账号同步
  var DEVICE_ONLY = {};
  DEVICE_ONLY[STORE_LLM] = DEVICE_ONLY[STORE_TOKENS] = DEVICE_ONLY[STORE_ONLINE] = true;
  function storeFor(key) {
    if (DEVICE_ONLY[key]) { try { return window.localStorage; } catch (e) { return null; } }
    return Platform.store();
  }
  var RECORD_LIMIT = 60;
  var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DROP_MS = REDUCED_MOTION ? 0 : 240;
  // 平面棋盘的落子动画：整块棋子放下去
  var PLACE_MS = REDUCED_MOTION ? 0 : 300;
  // 落子动画里棋子落到棋盘上的时刻（占整段的比例），之后只剩轻轻一压
  var LAND_T = 0.6;
  var ANCHOR_MS = REDUCED_MOTION ? 0 : 360;

  // 重新触发一次性的 CSS 动画
  function replayClass(el, cls) {
    if (!el || REDUCED_MOTION) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function animMs(state) { return state && state.topo.dims === 3 ? DROP_MS : PLACE_MS; }
  function easeOutBack(x) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }

  function $(id) { return document.getElementById(id); }

  function load(key) {
    try { return JSON.parse(storeFor(key).getItem(key)); } catch (e) { return null; }
  }
  function save(key, value) {
    try {
      var st = storeFor(key);
      if (value === null) st.removeItem(key);
      else st.setItem(key, JSON.stringify(value));
    } catch (e) { /* 存储不可用时忽略 */ }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ================= 多语言 ================= */

  // 拼进 innerHTML 的译文：参数先转义（数字保留，用来选复数形式）
  function th(key, params) {
    var safe = {};
    for (var k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k)) safe[k] = typeof params[k] === 'number' ? params[k] : escapeHtml(params[k]);
    }
    return t(key, safe);
  }

  function colorName(color) { return t('color.' + color); }
  function modeLabel(mode) { return t('mode.' + mode); }
  function levelLabel(level) { return t('level.' + level); }
  function joinNames(list) { return list.join(t('list.sep')); }
  function pieceName(piece) { return piece.label ? t(piece.label.key, { letter: piece.label.letter }) : piece.name; }

  // 联机与房间操作出错时给人看的说明（服务器只给错误码时按码翻译）
  function errText(err) {
    var code = err && err.code;
    if (code && I18n.has('err.' + code)) return t('err.' + code);
    if (code && /^http_\d+$/.test(code)) return t('err.http', { status: code.slice(5) });
    if (code === 'quota_exceeded' || code === 'resource_exhausted') return t('err.quota');
    if (code === 'unavailable') return t('err.sync');
    return (err && err.message) || t('err.sync');
  }

  // 座位上保存的默认名字（电脑、托管、“你”“玩家2”等，存的是中文）按当前语言显示；玩家自己起的名字原样显示
  function nameOf(pl) {
    var name = pl.name || '';
    if (pl.type === 'ai') {
      if (!name || /方电脑$/.test(name)) return t('seat.aiName', { color: colorName(pl.color) });
      var hosted = /^(.*)（托管）$/.exec(name);
      if (hosted) return t('seat.hosted', { name: hosted[1] });
    }
    if (!name || name === '玩家') return t('player.default');
    if (name === '房主') return t('lobby.host');
    if (name === '你') return t('seat.you');
    var numbered = /^玩家(\d+)$/.exec(name);
    if (numbered) return t('seat.player', { n: +numbered[1] });
    return name;
  }

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
      animT = PLACE_MS ? clamp((now - anim.t0) / PLACE_MS, 0, 1) : 1;
      animSet = {};
      anim.cells.forEach(function (i) { animSet[i] = 1; });
    }
    var board = state.board;
    topo.cells.forEach(function (i) {
      var v = board[i];
      if (v < 0 || (animSet && animSet[i])) return;
      self.drawCell(L, i, colorOf(v));
    });
    // 上一步高亮
    // 上一步：用落子方自己的颜色发一圈柔光，再描一道细亮边（不再用黑框）。
    // 新棋子还在空中时，柔光留在上一块已经落定的棋子上；新棋子一落到棋盘上，柔光才移过去
    var landed = !anim || animT >= LAND_T;
    var glow = ov.lastMove;
    if (landed) {
      this.landedMove = ov.lastMove ? ov.lastMove.slice() : null;
    } else {
      glow = this.landedMove;
      // 换了一局（那些格子已经不是同一种颜色的棋子）就不画
      if (glow && !(glow.length && glow.every(function (i) { return state.board[i] >= 0 && state.board[i] === state.board[glow[0]] && !animSet[i]; }))) glow = null;
    }
    if (glow && glow.length) {
      var owner = state.board[glow[0]];
      var lc = owner >= 0 ? colorOf(owner) : palette.ink;
      var gf = anim && landed && glow === ov.lastMove ? clamp((animT - LAND_T) / 0.15, 0, 1) : 1;
      g.save();
      g.shadowColor = lc;
      g.shadowBlur = Math.max(6, L.inr * 1.1);
      g.globalAlpha = 0.9 * gf;
      this.outline(L, glow, lc, Math.max(2, L.inr * 0.2));
      g.restore();
      g.save();
      g.globalAlpha = 0.75 * gf;
      this.outline(L, glow, 'rgba(255, 255, 255, 0.9)', Math.max(1, L.inr * 0.07));
      g.restore();
    }

    // 角点提示：轮到自己时淡入并弹一下
    if (ov.anchors && ov.anchors.list.length) {
      var af = ANCHOR_MS && ov.anchors.t0 ? clamp((now - ov.anchors.t0) / ANCHOR_MS, 0, 1) : 1;
      g.fillStyle = ov.anchors.color;
      g.globalAlpha = 0.55 * af;
      var ar = L.inr * 0.28 * (0.3 + 0.7 * easeOutBack(af));
      ov.anchors.list.forEach(function (i) {
        var c = cellCenterPx(L, i);
        g.beginPath();
        g.arc(c[0], c[1], ar, 0, Math.PI * 2);
        g.fill();
      });
      g.globalAlpha = 1;
    }

    // 正在落下的棋子画在棋盘上所有标记（上一步的柔光、角点）之上，悬空时盖住下面的棋子而不是被它们的光边压住
    if (anim && animT < 1) {
      // 整块棋子“放下去”：先略微抬起（稍大、带投影），再整体落到棋盘上，轻轻一压
      var acol = colorOf(anim.player);
      var mx = 0, my = 0;
      anim.cells.forEach(function (i) { var c = cellCenterPx(L, i); mx += c[0] / anim.cells.length; my += c[1] / anim.cells.length; });
      // 下落是加速的（像真的掉下去），正好在 LAND_T 时碰到棋盘；之后轻轻一压再回弹
      var land = Math.min(1, animT / LAND_T);
      var lift = 1 - land * land;
      var press = animT > LAND_T ? 0.045 * Math.sin(Math.PI * (animT - LAND_T) / (1 - LAND_T)) : 0;
      var sc = 1 + 0.12 * lift - press;
      var dy = -L.inr * 0.9 * lift;
      g.save();
      g.translate(mx, my + dy);
      g.scale(sc, sc);
      g.translate(-mx, -my);
      if (lift > 0) {
        g.save();
        g.shadowColor = 'rgba(10, 14, 24, ' + (0.38 * lift).toFixed(3) + ')';
        g.shadowBlur = L.inr * 2.4 * lift;
        g.shadowOffsetY = L.inr * 1.6 * lift;
        anim.cells.forEach(function (i) { self.drawCell(L, i, acol); });
        g.restore();
      }
      anim.cells.forEach(function (i) { self.drawCell(L, i, acol); });
      g.restore();
    } else if (anim) {
      anim.cells.forEach(function (i) { self.drawCell(L, i, colorOf(anim.player)); });
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
    if (!prefs.sound || Platform.muted() || !audio || audio.state !== 'running') return;
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
    // 每种棋盘的参战人数：用前 n 个座位
    counts: { classic: 4, duo: 2, trigon: 4, gemblo: 6, cube: 4, prism: 4 },
    hints: true,
    sound: true,
    speed: 'normal',
    theme: 'light',
    lang: ''
  };

  function loadPrefs() {
    var p = JSON.parse(JSON.stringify(DEFAULT_PREFS));
    var saved = load(STORE_PREFS);
    if (!saved || typeof saved !== 'object') return p;
    // 棋盘不记忆：每次打开网站都从标准棋盘开始（本次访问内切换会保留）
    if (saved.tab === 'online') p.tab = 'online';
    if (typeof saved.nick === 'string') p.nick = Online.cleanName(saved.nick);
    MODE_LIST.forEach(function (m) {
      var list = saved.seats && saved.seats[m];
      if (!Array.isArray(list)) return;
      // 旧版的“空位”：去掉空位，其余座位往前排，人数等于剩下的座位数
      var used = list.filter(function (s) { return s && s.type !== 'off'; });
      var rest = list.filter(function (s) { return s && s.type === 'off'; });
      used.concat(rest).forEach(function (s, i) {
        var seat = p.seats[m][i];
        if (!seat) return;
        if (s.type === 'human' || s.type === 'ai') seat.type = s.type;
        if (LEVELS.indexOf(s.level) >= 0) seat.level = s.level;
        if (typeof s.name === 'string') seat.name = s.name.slice(0, 12);
        if (typeof s.model === 'string') seat.model = LLM.profileName(s.model);
      });
      var n = saved.counts && saved.counts[m];
      if (!Engine.validCount(m, n) && rest.length) n = used.length;
      if (Engine.validCount(m, n)) p.counts[m] = n;
    });
    if (typeof saved.hints === 'boolean') p.hints = saved.hints;
    if (typeof saved.sound === 'boolean') p.sound = saved.sound;
    if (Object.prototype.hasOwnProperty.call(SPEED_MS, saved.speed)) p.speed = saved.speed;
    if (saved.theme === 'dark') p.theme = 'dark';
    if (I18n.LANGS.some(function (l) { return l.code === saved.lang; })) p.lang = saved.lang;
    return p;
  }

  var prefs = loadPrefs();
  function savePrefs() { save(STORE_PREFS, prefs); }

  // 只有宝石阵可以选 3、4、6 方；其他棋盘人数固定（座位全用）
  function countOptions(mode) {
    return mode === 'gemblo' ? [3, 4, 6] : [Engine.MODES[mode].seats.length];
  }

  function seatCount(mode) {
    var opts = countOptions(mode);
    return opts.indexOf(prefs.counts[mode]) >= 0 ? prefs.counts[mode] : opts[opts.length - 1];
  }

  /* ---------- 棋盘选择卡片 ---------- */

  var MODE_ICONS = {
    classic: '<rect x="3" y="3" width="18" height="18" rx="2.5" class="ico-base"/><rect x="5" y="5" width="4.5" height="4.5" rx="1" fill="var(--p-blue)"/><rect x="14.5" y="5" width="4.5" height="4.5" rx="1" fill="var(--p-yellow)"/><rect x="14.5" y="14.5" width="4.5" height="4.5" rx="1" fill="var(--p-red)"/><rect x="5" y="14.5" width="4.5" height="4.5" rx="1" fill="var(--p-green)"/>',
    duo: '<rect x="3" y="3" width="18" height="18" rx="2.5" class="ico-base"/><rect x="7" y="7" width="4.5" height="4.5" rx="1" fill="var(--p-violet)"/><rect x="12.5" y="12.5" width="4.5" height="4.5" rx="1" fill="var(--p-orange)"/>',
    trigon: '<path d="M7.5 4.2h9L21 12l-4.5 7.8h-9L3 12z" class="ico-base"/><path d="M7.5 4.2L12 12 3 12z" fill="var(--p-blue)"/><path d="M16.5 4.2L21 12h-9z" fill="var(--p-yellow)"/><path d="M12 12h9l-4.5 7.8z" fill="var(--p-red)"/><path d="M3 12h9l-4.5 7.8z" fill="var(--p-green)"/>',
    gemblo: '<path d="M8.5 3.5h4l2 3.4-2 3.5h-4l-2-3.5z" fill="var(--p-violet)"/><path d="M14.5 7h4l2 3.4-2 3.5h-4l-2-3.5z" fill="var(--p-yellow)"/><path d="M8.5 10.5h4l2 3.4-2 3.5h-4l-2-3.5z" class="ico-base"/><path d="M2.5 7h4l2 3.4-2 3.5h-4L.5 10.4z" fill="var(--p-orange)"/><path d="M14.5 14h4l2 3.4-2 3.5h-4l-2-3.5z" fill="var(--p-blue)"/>',
    cube: '<path d="M12 3.5l8 4.2-8 4.3-8-4.3z" fill="var(--p-blue)"/><path d="M4 7.7l8 4.3v8.5l-8-4.3z" fill="var(--p-blue)" opacity=".72"/><path d="M20 7.7L12 12v8.5l8-4.3z" fill="var(--p-blue)" opacity=".5"/>',
    prism: '<path d="M6 7l12-2 3 5.5-12 2z" fill="var(--p-red)"/><path d="M6 7l3 5.5v8L6 15z" fill="var(--p-red)" opacity=".72"/><path d="M9 12.5l12-2v8l-12 2z" fill="var(--p-red)" opacity=".5"/>'
  };

  function modeIcon(mode) {
    return '<svg class="mode-ico" viewBox="0 0 24 24" aria-hidden="true">' + MODE_ICONS[mode] + '</svg>';
  }

  // 3×2 的棋盘卡片，选中的那张下面垫一块会滑动的高亮
  function modeCards(name, checked, disabled) {
    return '<i class="mode-thumb" aria-hidden="true"></i>' + MODE_LIST.map(function (m) {
      return '<label class="mode-card"><input type="radio" name="' + name + '" id="' + name + '-' + m + '" value="' + m + '"' +
        (m === checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '>' +
        '<span>' + modeIcon(m) + '<b>' + escapeHtml(modeLabel(m)) + '</b></span></label>';
    }).join('');
  }

  function moveThumb(box, instant) {
    var thumb = box && box.querySelector('.mode-thumb');
    var input = box && box.querySelector('input:checked');
    if (!thumb || !input || !box.offsetParent) return;
    var card = input.parentNode;
    if (instant) thumb.classList.add('no-anim');
    thumb.style.width = card.offsetWidth + 'px';
    thumb.style.height = card.offsetHeight + 'px';
    thumb.style.transform = 'translate(' + card.offsetLeft + 'px,' + card.offsetTop + 'px)';
    thumb.style.opacity = '1';
    if (instant) { void thumb.offsetWidth; thumb.classList.remove('no-anim'); }
  }

  function buildModeSeg() {
    $('mode-seg').innerHTML = modeCards('mode', prefs.mode, false);
    moveThumb($('mode-seg'), true);
  }

  // n 个座位的快速开局：1、2、3 个人类玩家（人类尽量隔开坐）、全是人类、全是电脑
  function presetsFor(n) {
    var hs = [1, 2, 3, n, 0].filter(function (h, i, a) { return h <= n && a.indexOf(h) === i; });
    return hs.map(function (h) {
      var types = [];
      for (var i = 0; i < n; i++) types.push(Math.ceil((i + 1) * h / n) > Math.ceil(i * h / n) ? 'human' : 'ai');
      return types;
    });
  }

  function presetLabel(types) {
    var h = types.filter(function (x) { return x === 'human'; }).length;
    var a = types.filter(function (x) { return x === 'ai'; }).length;
    if (!h) return t('preset.watch');
    if (!a) return t('preset.hotseat', { n: h });
    if (h === 1 && a === 1) return t('preset.vsAI');
    return t('preset.mix', { n: h, a: a });
  }

  function seatTypeOptions() {
    return [['human', t('seat.human')], ['ai', t('seat.ai')]];
  }

  function renderSetup() {
    var mode = prefs.mode;
    $('mode-' + mode).checked = true;
    moveThumb($('mode-seg'));
    $('mode-note').textContent = t('modeNote.' + mode);
    $('opt-hints').checked = prefs.hints;
    $('opt-sound').checked = prefs.sound;
    $('opt-speed').value = prefs.speed;
    $('opt-dark').checked = prefs.theme === 'dark';
    // 本地 / 联机两个面板叠在同一格里，切换只换内容，不改变高度
    var onlineTab = prefs.tab === 'online';
    $('tab-local').setAttribute('aria-selected', onlineTab ? 'false' : 'true');
    $('tab-online').setAttribute('aria-selected', onlineTab ? 'true' : 'false');
    [['local-panel', !onlineTab], ['online-panel', onlineTab]].forEach(function (x) {
      var el = $(x[0]);
      el.classList.toggle('inactive', !x[1]);
      el.inert = !x[1];
      el.setAttribute('aria-hidden', x[1] ? 'false' : 'true');
    });

    var n = seatCount(mode);
    var opts = countOptions(mode);
    var countSeg = $('count-seg');
    countSeg.hidden = opts.length < 2;
    countSeg.innerHTML = opts.map(function (c) {
      return '<label><input type="radio" name="seat-count" id="seat-count-' + c + '" value="' + c + '"' + (c === n ? ' checked' : '') + '><span>' + c + '</span></label>';
    }).join('');

    var seats = prefs.seats[mode];
    var presetList = presetsFor(n);
    $('presets').style.setProperty('--cols', presetList.length === 4 ? 2 : Math.min(3, presetList.length));
    $('presets').innerHTML = presetList.map(function (types, k) {
      var active = types.every(function (type, i) { return seats[i].type === type; });
      return '<button type="button" class="btn' + (active ? ' active' : '') + '" data-preset="' + k + '">' + escapeHtml(presetLabel(types)) + '</button>';
    }).join('');

    var list = $('seats');
    list.classList.toggle('cols2', n > 4);
    list.style.setProperty('--rows', 4);
    var humanNo = 0;
    var humans = seats.slice(0, n).filter(function (s) { return s.type === 'human'; }).length;
    list.innerHTML = Engine.MODES[mode].seats.slice(0, n).map(function (seat, i) {
      var s = seats[i];
      var human = s.type === 'human';
      if (human) humanNo++;
      var color = colorName(seat.color);
      var typeRadios = seatTypeOptions().map(function (o) {
        return '<label><input type="radio" name="seat-type-' + i + '" id="seat-type-' + i + '-' + o[0] + '" value="' + o[0] + '" data-seat="' + i + '"' +
          (s.type === o[0] ? ' checked' : '') + '><span>' + escapeHtml(o[1]) + '</span></label>';
      }).join('');
      // 一行：玩家填名字，电脑选难度（大模型再选配置），行高不变
      var main = human
        ? '<input type="text" class="seat-name" id="seat-name-' + i + '" data-seat="' + i + '" maxlength="12" aria-label="' + th('seat.nameAria', { color: color }) + '"' +
          ' placeholder="' + escapeHtml(humans === 1 ? t('seat.you') : t('seat.player', { n: humanNo })) + '" value="' + escapeHtml(s.name) + '">'
        : '<span class="seat-ai"><select class="seat-level-sel" id="seat-level-' + i + '" data-seat="' + i + '" aria-label="' + th('seat.levelAria') + ' · ' + escapeHtml(t('seat.aiName', { color: color })) + '">' +
          LEVELS.map(function (lv) { return '<option value="' + lv + '"' + (s.level === lv ? ' selected' : '') + '>' + escapeHtml(levelLabel(lv)) + '</option>'; }).join('') +
          '</select>' +
          (s.level === 'llm' ? '<select class="seat-model-sel" id="seat-model-' + i + '" data-seat="' + i + '" aria-label="' + th('seat.modelAria', { color: color }) + '">' + profileOptions(s.model) + '</select>' +
            '<button type="button" class="btn icon seat-llm" data-llm="' + i + '" title="' + th('llm.open') + '" aria-label="' + th('llm.open') + '"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg></button>' : '') +
          '</span>';
      return '<li class="seat" style="--c: var(--p-' + seat.color + ')">' +
        '<span class="seat-swatch" aria-hidden="true">' + escapeHtml(t('colorShort.' + seat.color)) + '</span>' +
        '<div class="seat-main">' + main + '</div>' +
        '<div class="seg small seat-type" role="radiogroup" aria-label="' + th('seat.typeAria', { color: color }) + '">' + typeRadios + '</div>' +
        '</li>';
    }).join('');

    $('setup-error').hidden = true;
    $('resume-btn').hidden = !loadSaved();
    renderOnlinePanel();
  }

  function buildLocalConfig() {
    var mode = prefs.mode;
    var n = seatCount(mode);
    var seats = prefs.seats[mode].slice(0, n);
    var humans = seats.filter(function (s) { return s.type === 'human'; }).length;
    var entries = [];
    var humanNo = 0;
    Engine.MODES[mode].seats.slice(0, n).forEach(function (seat, i) {
      var s = seats[i];
      // 默认名字存成中文（“你”“玩家2”“蓝方电脑”），显示时由 nameOf 按当前语言翻译
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
      return '<option value="' + escapeHtml(n) + '"' + (n === selected ? ' selected' : '') + '>' + escapeHtml(profileLabel(n)) + '</option>';
    }).join('');
  }

  function llmEnv(signal) {
    return { signal: signal, sample: llm.sample, proxy: netInfo.net && netInfo.net.llmProxy ? 'api/llm' : null, lang: I18n.info().english };
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
          return { move: r.move || best, note: llmNote(profile, r) };
        }, function (err) {
          if (err && err.code === 'cancelled') throw err;
          return { move: best, error: (profile.name ? profileLabel(profile.name) + ': ' : '') + llmErrText(err) };
        });
      });
    });
  }

  // 模型落子附带的那句话：Jev 不写文字，按它的选择和把握生成
  function llmNote(profile, r) {
    if (!r.asked) return '';
    if (profile.provider !== 'jev') return r.reason || '';
    var note = t('llm.jevReason', { k: r.index + 1, n: r.options });
    if (typeof r.confidence === 'number' && isFinite(r.confidence)) {
      note += t('list.sep') + t('llm.confidence', { p: Math.round(clamp(r.confidence, 0, 1) * 100) });
    }
    return note;
  }

  // 大模型调用出错时给人看的说明
  function llmErrText(err) {
    var code = err && err.code;
    if (code === 'http') {
      var hint = err.status === 401 || err.status === 403 ? t('llmErr.auth') : err.status === 404 ? t('llmErr.notFound') : err.status === 429 ? t('llmErr.rate') : '';
      return t('llmErr.http', { status: err.status }) + (hint ? ' (' + hint + ')' : '') + (err.detail ? ': ' + err.detail : '');
    }
    if (code === 'timeout') return t('llmErr.timeout', { s: err.seconds });
    if (code && I18n.has('llmErr.' + code)) return t('llmErr.' + code);
    return code ? t('llmErr.failed') + ' (' + code + ')' : t('llmErr.failed');
  }

  // 自动生成的配置名（“默认”“模型 2”）按当前语言显示
  function profileLabel(name) {
    if (name === '默认') return t('llm.defaultName');
    var m = /^模型 (\d+)$/.exec(name || '');
    return m ? t('llm.newName', { n: +m[1] }) : name;
  }

  // 同样的错误只提示一次
  function reportLLMError(r) {
    var msg = r.setup ? t('llm.toastSetup') : t('llm.toastError', { error: r.error });
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
    $('llm-model').placeholder = provider === 'jev' ? LLM.JEV_MODEL : t('llm.modelPlaceholder');
    $('llm-key').placeholder = provider === 'jev' ? t('llm.keyPlaceholderJev') : t('llm.keyPlaceholder');
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
      return '<option value="' + i + '"' + (i === llm.didx ? ' selected' : '') + '>' + escapeHtml(profileLabel(LLM.profileName(p.name)) || t('llm.unnamed')) + '</option>';
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
    llm.dcfg.profiles.forEach(function (p) {
      p.orig = p.name;
      if (profileLabel(p.name) !== p.name) p.name = profileLabel(p.name);
    });
    var names = llm.dcfg.profiles.map(function (p) { return p.name; });
    llm.didx = Math.max(0, names.indexOf(focusName));
    $('llm-provider-claude-label').hidden = !inClaudePage();
    $('llm-provider-claude').disabled = !llm.sample;
    renderProfileSelect();
    loadDraft();
    openDialog('llm-dialog');
  }

  function llmFormProblem(s) {
    if (s.provider === 'claude') return llm.sample ? '' : t('llm.errNoClaude');
    var ep = s[s.provider];
    if (!/^https?:\/\/[^\s]+$/i.test(ep.baseUrl)) return t('llm.errUrl');
    if (!ep.model) return t('llm.errModel');
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
      if (opt) opt.textContent = LLM.profileName($('llm-profile-name').value) || t('llm.unnamed');
    });
    $('llm-profile-add').addEventListener('click', function () {
      if (llm.dcfg.profiles.length >= 12) { setLlmStatus(t('llm.errMax'), 'err'); return; }
      storeDraft();
      var used = llm.dcfg.profiles.map(function (p) { return LLM.profileName(p.name); });
      var n = llm.dcfg.profiles.length + 1;
      while (used.indexOf(t('llm.newName', { n: n })) >= 0) n++;
      var d = LLM.normalizeSettings(null);
      d.name = t('llm.newName', { n: n });
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
        var problem = !name ? t('llm.errNoName') : names[name] ? t('llm.errDupName', { name: name }) : empty && llm.dcfg.profiles.length === 1 ? '' : llmFormProblem(s);
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
      toast(t('toast.llmSaved'));
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
      setLlmStatus(t('llm.connecting'), '');
      LLM.ping(s, llmEnv(null)).then(function (r) {
        setLlmStatus(t('llm.ok', { s: (r.ms / 1000).toFixed(1) }) + (r.text ? t('llm.okReply', { text: r.text }) : '') +
          (r.thinking ? t('llm.okThinking') : ''), r.thinking ? '' : 'ok');
      }, function (err) {
        setLlmStatus(err ? llmErrText(err) : t('llm.fail'), 'err');
      }).then(function () { btn.disabled = false; });
    });
  }

  /* ================= 演示局 ================= */

  var demo = { view: null, state: null, timer: 0, anim: null, round: 0 };

  function demoNew() {
    // 演示局下的是开局页面选中的棋盘和人数
    var mode = prefs.mode;
    var n = seatCount(mode);
    demo.state = Engine.createGame(Engine.buildConfig(mode, Engine.MODES[mode].seats.slice(0, n).map(function (s, i) { return { seat: i }; })));
    demo.anim = null;
    demo.mode = mode;
    $('demo-label').innerHTML = modeIcon(mode) + '<b>' + escapeHtml(modeLabel(mode)) + '</b>';
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

  // 换了棋盘或人数：演示局马上按新的设置重开
  function restartDemo() {
    clearTimeout(demo.timer);
    demo.state = null;
    demo.anim = null;
    demo.resetPending = false;
    if (!$('setup').hidden) {
      replayClass(document.querySelector('.demo-frame'), 'swap');
      replayClass(document.querySelector('.hero-caption'), 'swap');
      startDemo();
    }
  }

  function startDemo() {
    if (!demo.view) {
      // 演示局和真实对局画法一样：落子动画 + 上一步的同色柔光
      demo.view = new BoardView($('demo-board'), function () { return demo.state; }, function () {
        var st = demo.state;
        return { anim: demo.anim, lastMove: st && st.lastMove ? cellsToIdx(st, st.lastMove.cells) : null };
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
      if (tour.steps) {
        tour.steps = null;
        game.touring = false;
        closeDialog('tour');
      }
    }
    syncGameplay();
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
    if (!sameGame) playEntrance();
    // 新开的一局记一次游玩（联机由房主记，接着上局、回放不记）
    if (!sameGame && !(actions && actions.length) && (mode === 'local' || (online && online.room && online.room.host === myId()))) countPlay();
    game.seenGameId = gameId || null;
    saveGame();
    onTurnStart(true);
    renderGame();
    maybeStartTour();
  }

  function playEntrance() {
    game.leftShown = [];
    var el = $('game');
    replayClass(el, 'entering');
    clearTimeout(game.enterTimer);
    game.enterTimer = setTimeout(function () { el.classList.remove('entering'); }, 900);
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
    $('layer-val').textContent = n >= H ? t('cam.layerAll') : t('cam.layerRange', { n: n });
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
    $('rot-ccw').title = t(cube ? 'ctl.turnLeft' : 'ctl.rotLeft');
    $('rot-cw').title = t(cube ? 'ctl.turnRight' : 'ctl.rotRight');
    $('flip-btn').title = t(isCube() ? 'ctl.tipForward' : cube ? 'ctl.flipOver' : 'ctl.flip');
    $('keys-help').textContent = t(cube ? (isCube() ? 'keys.cube' : 'keys.prism') : 'keys.flat');
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
    if (!first) replayClass($('turn'), 'flash');
    game.turnKey = turnKeyOf();
    game.turnStart = Date.now();
    resetSelection();
    game.perPiece = null;
    game.anchors = null;
    var st = game.state;
    if (st.over) {
      saveGame();
      clearTimeout(game.endTimer);
      syncGameplay();
      if (first) game.endTimer = setTimeout(function () { showEnd(); }, 0);
      // 刚下完的一局：先让最后一步落定、看一眼终局，再放平台的插页广告（只在这里放），之后弹结算
      else game.endTimer = setTimeout(function () { endOfGameAd().then(function () { showEnd(); }, function () {}); }, Platform.active ? 900 : 700);
      return;
    }
    var pl = cur();
    if (canAct()) {
      game.viewPlayer = null;
      game.perPiece = Engine.movesPerPiece(st, st.current);
      var forb = Engine.forbiddenMask(st.board, st.topo, st.current);
      game.anchors = Engine.anchorMask(st.board, st.topo, st.current, pl, forb);
      game.anchorDots = game.anchors.list;
      game.anchorsT0 = performance.now();
      if (ANCHOR_MS) animate();
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
          toast(t('turn.yours', { color: colorName(pl.color) }));
          sound('turn');
        } else if (humanCount() > 1) {
          toast(t('turn.named', { name: nameOf(pl), color: colorName(pl.color) }));
          sound('turn');
        }
      }
    } else if (isLocalAITurn()) {
      scheduleAI();
    }
  }

  function scheduleAI() {
    cancelAI();
    if (game.paused || game.touring || !isLocalAITurn()) return;
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
      toast(nameOf(st.players[p]) + ': ' + note);
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
      if (ev.type === 'blocked') notes.push(t('toast.blocked', { name: nameOf(st.players[ev.player]) }));
      else if (ev.type === 'resign') notes.push(t('toast.stopped', { name: nameOf(st.players[ev.player]) }));
    }
    return notes;
  }

  function afterAction() {
    var notes = processEvents();
    saveGame();
    onTurnStart(false);
    if (notes.length) toast(notes.join(t('list.sep')));
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
      if (prefix && said && game.state.players[said.player]) toast(nameOf(game.state.players[said.player]) + ': ' + said.note);
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
    if (notes.length) toast(notes.join(t('list.sep')));
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
    if (notes.length) toast(notes.join(t('list.sep')));
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
      toast(err.code === 'stale' ? t('online.stale') : errText(err), 'warn');
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
    if (prefs.hints && game.anchors) ov.anchors = { list: game.anchorDots || game.anchors.list, color: color, t0: game.anchorsT0 };
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
      if (reason === 'edge' || reason === 'corner' || reason === 'start') return t('reason.' + reason + '3d');
    }
    return I18n.has('reason.' + reason) ? t('reason.' + reason) : t('reason.default');
  }

  function tryPlace() {
    if (!canAct()) return false;
    var m = ghostMove();
    if (!m) {
      toast(t(game.sel.piece < 0 ? 'toast.pickPiece' : 'toast.pickSpot'));
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
    toast(t('toast.hint', { piece: pieceName(piece) }));
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
    toast(t('toast.undone', { name: nameOf(cur()) }));
  }

  function resign() {
    if (!canAct()) return;
    var pl = cur();
    confirmBox(t('resign.title'), t('resign.text', { name: nameOf(pl), n: pl.remaining.filter(Boolean).length }), t('resign.yes')).then(function (ok) {
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
        if (game.anim && now - game.anim.t0 >= animMs(game.state)) game.anim = null;
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
        if (game.anchorsT0 && now - game.anchorsT0 < ANCHOR_MS) more = true;
      }
      if (demo.view && !$('setup').hidden) {
        if (demo.anim && now - demo.anim.t0 >= animMs(demo.state)) demo.anim = null;
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

  // 告诉游戏平台对局是否正在进行（开局、继续时开始；结束、回到菜单、暂停、看引导、回放时停止）
  function syncGameplay() {
    Platform.gameplay(!$('game').hidden && game.mode !== 'replay' && !!game.state && !game.state.over && !game.paused && !game.touring);
  }

  function renderGame() {
    syncGameplay();
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
        text = t('turn.overWinner', { winner: winnersText(st) });
        color = 'var(--ink)';
      } else if (!last) {
        text = t('turn.replayStart');
        color = 'var(--ink)';
      } else {
        var lp = st.players[last.player];
        color = colorVar(lp);
        text = last.type === 'place' ? t('turn.placed', { name: nameOf(lp), piece: pieceName(st.set.pieces[last.piece]) }) : t('turn.stopped', { name: nameOf(lp) });
      }
    } else if (st.over) {
      text = t('turn.over');
      color = 'var(--ink)';
    } else {
      var pl = cur();
      color = colorVar(pl);
      var who = { name: nameOf(pl), color: colorName(pl.color) };
      if (canAct()) text = t(!onlineMode && humanCount() > 1 ? 'turn.named' : 'turn.yours', who);
      else if (pl.type === 'human') {
        text = t('turn.waiting', who) +
          (onlineMode && !isPeerOnline(pl.owner) ? t('turn.offline') : remotePreview() ? t('turn.trying') : '');
      }
      else if (game.paused) text = t('turn.paused', who);
      else if (pl.level === 'llm') {
        var secs = Math.floor((Date.now() - (game.turnStart || Date.now())) / 1000);
        text = t('turn.asking', who) + (secs >= 2 ? t('turn.seconds', { n: secs }) : '');
      } else text = t('turn.thinking', who);
    }
    root.style.setProperty('--turn', color);
    $('turn-text').textContent = text;
    var placed = st.actions.filter(function (a) { return a.type === 'place'; }).length;
    $('turn-move').textContent = replaying ? t('move.step', { k: replay.step, n: replay.n })
      : st.over ? t('move.total', { n: placed }) : t('move.nth', { n: placed + 1 });

    var hasHuman = myPlayers().length > 0;
    var canUndo = !onlineMode && st.actions.some(function (a) { return st.players[a.player].type === 'human'; });
    $('undo-btn').disabled = !canUndo;
    $('undo-btn').hidden = onlineMode || !hasHuman;
    $('hint-btn').hidden = !hasHuman;
    $('hint-btn').disabled = !canAct();
    $('pause-btn').hidden = onlineMode || humanCount() > 0 || st.over || replaying;
    $('pause-btn').textContent = t(game.paused ? 'game.resume' : 'game.pause');
    $('result-btn').hidden = !st.over || replaying;
    $('sound-btn').setAttribute('aria-pressed', prefs.sound ? 'true' : 'false');
    $('menu-btn').textContent = t(replaying ? 'game.exitReplay' : onlineMode ? 'game.leave' : 'game.menu');
    $('menu-btn').title = t(replaying ? 'game.exitReplayTitle' : onlineMode ? 'game.leaveTitle' : 'game.menuTitle');
    var chip = $('room-chip');
    chip.hidden = !onlineMode;
    if (onlineMode) {
      var n = online.peers ? online.peers.length : null;
      chip.textContent = t('room.chip', { code: online.code }) + (online.connected ? (n ? t('room.online', { n: n }) : '') : t('room.reconnecting'));
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
    var prevLeft = game.leftShown || [];
    game.leftShown = [];
    var lastMover = replaying && replay.rec && replay.step ? replay.rec.actions[replay.step - 1].player : -1;
    $('players').innerHTML = st.players.map(function (pl, p) {
      var current = replaying ? p === lastMover : !st.over && p === st.current;
      var stateText = '';
      if (pl.resigned) stateText = th('card.stopped');
      else if (pl.done) stateText = st.over ? '' : th('card.blocked');
      else if (current && !replaying) stateText = pl.type === 'human' ? th(isMine(pl) ? 'card.placing' : 'card.waiting') : (game.paused ? th('card.paused') : '<span class="thinking">' + th('card.thinking') + '</span>');
      var dot = '';
      if (onlineMode && pl.type === 'human' && peersKnown()) {
        var on = isPeerOnline(pl.owner);
        dot = '<span class="pcard-online' + (on ? '' : ' off') + '" title="' + th(on ? 'card.online' : 'card.offline') + '"></span>';
        if (!on && amHost && !pl.done && !st.over) {
          stateText += '<button type="button" class="btn" data-takeover="' + p + '">' + th('card.takeover') + '</button>';
        }
      }
      var placed = total - pl.remainingSquares;
      var kind = pl.type === 'human' ? t(onlineMode && pl.owner === myId() ? 'card.you' : 'card.player') : t('card.ai', { level: levelLabel(pl.level) }) + (pl.level === 'llm' && pl.model ? ' · ' + profileLabel(pl.model) : '');
      var pieces = order.map(function (pi) {
        return '<i' + (pl.remaining[pi] ? '' : ' class="used"') + '>' + pieceIcon(st.set, pi) + '</i>';
      }).join('');
      var left = pl.remaining.filter(Boolean).length;
      var bump = prevLeft[p] !== undefined && left < prevLeft[p] && !REDUCED_MOTION;
      game.leftShown[p] = left;
      var note = lastNote(st, p);
      return '<div class="pcard' + (current ? ' current' : '') + (pl.done ? ' done' : '') + (viewing === pl ? ' viewing' : '') +
        '" style="--c:' + colorVar(pl) + '" data-player="' + p + '" role="button" tabindex="0"' +
        ' title="' + th('card.title') + '" aria-label="' + th('card.aria', { name: nameOf(pl), n: left }) + '">' +
        '<span class="pcard-swatch" aria-hidden="true"></span>' +
        '<div class="pcard-name">' + dot + escapeHtml(nameOf(pl)) + '<small>' + th('card.sub', { color: colorName(pl.color), kind: kind }) + '</small></div>' +
        '<div class="pcard-left' + (bump ? ' bump' : '') + '" title="' + th('card.leftTitle', { n: left }) + '">' + th('card.leftHtml', { n: left }) + '</div>' +
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
      b.setAttribute('aria-label', t('piece.aria', { piece: pieceName(piece), n: piece.size }));
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
      $('dock-title').textContent = t('dock.replay', { mode: modeLabel(st.mode) });
      $('dock-back').hidden = true;
      $('dock-count').textContent = t('dock.steps', { n: replay.n });
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
    var ownerText = { color: colorName(owner.color), name: nameOf(owner) };
    $('dock-title').textContent = t(browsing ? 'dock.browsing' : active || st.over ? 'dock.owner' : owner.type === 'ai' ? 'dock.ai' : 'dock.waiting', ownerText);
    $('dock-back').hidden = !browsing;
    var left = owner.remaining.filter(Boolean).length;
    $('dock-count').textContent = t('dock.count', { n: left, cells: owner.remainingSquares });
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
      b.title = used ? t('piece.used') : stuck ? t('piece.stuck', { piece: pieceName(piece) }) : t('piece.title', { piece: pieceName(piece), n: piece.size });
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
      prev.setAttribute('aria-label', t('sel.aria', { piece: pieceName(set.pieces[game.sel.piece]) }));
    } else {
      prev.textContent = t(active ? 'sel.pick' : game.state.over ? 'sel.over' : 'sel.wait');
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
    return ['end-dialog', 'confirm-dialog', 'rules-dialog', 'llm-dialog', 'records-dialog', 'tour'].some(function (id) { return $(id).open; });
  }

  var confirmResolve = null;
  function confirmBox(title, text, yesLabel) {
    if (confirmResolve) finishConfirm(false);
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = yesLabel || t('confirm.ok');
    openDialog('confirm-dialog');
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }
  function finishConfirm(ok) {
    closeDialog('confirm-dialog');
    if (confirmResolve) { var r = confirmResolve; confirmResolve = null; r(ok); }
  }

  // 每局结束时的广告：请求期间挡住界面（不可操作），广告真正开始后再静音；没有广告、出错、被拦截时直接继续
  function endOfGameAd() {
    if (!Platform.active) return Promise.resolve();
    var shield = $('ad-shield');
    var st = game.state;
    shield.hidden = false;
    return Platform.endOfGameAd({
      started: function () { shield.classList.add('playing'); }
    }).then(function () {
      shield.hidden = true;
      shield.classList.remove('playing');
      if (game.state !== st || $('game').hidden) throw new Error('left');
    });
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
      title = me.rank === 1 ? t(winners.length > 1 ? 'end.tieFirst' : 'end.youWin') : t('end.yourRank', { n: me.rank });
    } else {
      title = winnersText(st);
    }
    $('end-title').textContent = title;
    $('end-note').textContent = t(st.players[0].noBonus ? 'end.noteNoBonus' : 'end.noteBonus');
    $('end-rows').innerHTML = rows.map(function (r, k) {
      var tag = r.monoLast ? 'end.tagMono' : r.allPlaced ? 'end.tagAll' : r.player.resigned ? 'end.tagStopped' : '';
      return '<tr style="--i:' + k + '">' +
        '<td><span class="rank' + (r.rank === 1 ? ' first' : '') + '">' + r.rank + '</span></td>' +
        '<td><span class="who" style="--c:' + colorVar(r.player) + '"><i></i><span>' + escapeHtml(nameOf(r.player)) +
        (tag ? '<span class="bonus">' + th(tag) + '</span>' : '') + '</span></span></td>' +
        '<td class="num left">' + th('end.pieces', { n: r.piecesLeft }) + '<small>' + th('end.cells', { n: r.remainingSquares }) + '</small></td>' +
        '</tr>';
    }).join('');
    var onlineMode = isOnlineGame();
    var amHost = onlineMode && online.room && online.room.host === myId();
    $('end-again').disabled = onlineMode && !amHost;
    $('end-again').textContent = t(onlineMode && !amHost ? 'end.waitHost' : 'end.again');
    $('end-menu').textContent = t(onlineMode ? 'end.leaveRoom' : 'end.menu');
    $('end-record-note').textContent = '';
    renderRecordButtons();
    renderGame();
    openDialog('end-dialog');
    if (!reopen) {
      sound('win');
      var myWin = mine.length === 1 && mine[0].rank === 1 && (isOnlineGame() || humanCount() === 1);
      if (myWin) setTimeout(function () { confetti(colorVar(mine[0].player)); }, 280);
      if (myWin) Platform.happytime();
    }
  }

  // 彩纸：从结算框上方撒下，主色是赢家的颜色，约 2.5 秒后自动收掉
  function confetti(mainColor) {
    if (REDUCED_MOTION) return;
    var host = $('end-dialog');
    var cv = document.createElement('canvas');
    cv.className = 'confetti';
    host.appendChild(cv);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = window.innerWidth, H = window.innerHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    var g = cv.getContext('2d');
    g.scale(dpr, dpr);
    var cs = getComputedStyle(document.documentElement);
    var main = mainColor.replace(/^var\((--[\w-]+)\)$/, function (m, v) { return cs.getPropertyValue(v).trim(); });
    var colors = [main, main, main].concat(['--p-blue', '--p-yellow', '--p-red', '--p-green'].map(function (v) { return cs.getPropertyValue(v).trim(); }));
    var parts = [];
    for (var i = 0; i < 140; i++) {
      parts.push({
        x: W / 2 + (Math.random() - 0.5) * W * 0.5, y: H * 0.18 + (Math.random() - 0.5) * 60,
        vx: (Math.random() - 0.5) * 11, vy: -Math.random() * 9 - 3,
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
        w: 5 + Math.random() * 6, h: 8 + Math.random() * 8, c: colors[i % colors.length]
      });
    }
    var t0 = performance.now();
    (function frame(now) {
      var t = (now - t0) / 2600;
      g.clearRect(0, 0, W, H);
      parts.forEach(function (q) {
        q.vy += 0.28;
        q.vx *= 0.985;
        q.x += q.vx;
        q.y += q.vy;
        q.r += q.vr;
        g.save();
        g.globalAlpha = Math.max(0, 1 - Math.max(0, t - 0.6) / 0.4);
        g.translate(q.x, q.y);
        g.rotate(q.r);
        g.scale(1, Math.abs(Math.cos(q.r * 1.7)) * 0.8 + 0.2);
        g.fillStyle = q.c;
        g.fillRect(-q.w / 2, -q.h / 2, q.w, q.h);
        g.restore();
      });
      if (t < 1 && host.open) requestAnimationFrame(frame);
      else cv.remove();
    })(t0);
  }

  /* ================= 对局记录与回放 ================= */

  var replay = { rec: null, n: 0, step: 0, playing: false, timer: 0, speed: 1 };
  var REPLAY_MS = 900;

  function winnersText(st) {
    var w = Engine.standings(st).filter(function (r) { return r.rank === 1; }).map(function (r) { return nameOf(r.player); });
    return w.length > 1 ? t('end.tied', { names: joinNames(w) }) : t('end.winner', { name: w[0] });
  }

  function loadRecords() {
    var list = load(STORE_RECORDS);
    if (!Array.isArray(list)) return [];
    return list.map(function (r) { return Record.parse(r); }).filter(Boolean);
  }

  function storeRecords(list) {
    try {
      storeFor(STORE_RECORDS).setItem(STORE_RECORDS, JSON.stringify(list));
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
    $('end-save').textContent = t(game.recordSaved ? 'record.saved' : 'record.save');
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  function fmtDate(iso) {
    var d = new Date(iso);
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  // 文件名只用 ASCII：有的浏览器会把中文文件名换成 download
  function recordFileName(rec) {
    var d = new Date(rec.date);
    return 'blockturf-' + rec.mode + '-' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) +
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
    // 导出文件里可读的流程用当前语言
    var text = Record.stringify(rec, {
      app: t('app.title'),
      seat: function (pl) { return t('record.seat', { color: colorName(pl.color), name: nameOf(pl) }); },
      piece: pieceName,
      blocked: t('record.blocked'),
      stopped: t('record.stopped'),
      over: t('record.over')
    });
    return downloadsCap().then(function (dl) {
      if (!dl) return browserDownload(name, text) ? 'saved' : 'failed';
      return dl.save({ filename: name, data: text }).then(function () { return 'saved'; }, function (err) {
        return err && err.code === 'declined' ? 'declined' : 'failed';
      });
    });
  }

  function exportText(result) {
    return result === 'saved' ? t('record.exported') : result === 'declined' ? '' : t('record.exportFail');
  }

  /* ---------- 记录列表 ---------- */

  function openRecords(msg) {
    renderRecords(msg);
    openDialog('records-dialog');
  }

  function renderRecords(msg) {
    var list = loadRecords();
    $('records-list').innerHTML = list.length ? list.map(recordItem).join('')
      : '<li class="records-empty">' + th('records.empty') + '</li>';
    var note = $('records-note');
    note.textContent = msg || '';
    note.hidden = !msg;
  }

  function recordItem(rec) {
    var st = Record.stateAt(rec);
    var moves = st.actions.filter(function (a) { return a.type === 'place'; }).length;
    var who = st.players.map(function (pl) {
      return '<span class="who" style="--c:' + colorVar(pl) + '"><i></i><span>' + escapeHtml(nameOf(pl)) + '</span></span>';
    }).join('');
    var status = st.over ? winnersText(st) : t('records.unfinished');
    return '<li class="record-item">' +
      '<div class="record-main">' +
      '<div class="record-head"><b>' + escapeHtml(modeLabel(rec.mode)) + '</b><span>' + fmtDate(rec.date) + (rec.online ? th('records.online') : '') + '</span></div>' +
      '<div class="record-who">' + who + '</div>' +
      '<small>' + th('move.total', { n: moves }) + ' · ' + escapeHtml(status) + '</small>' +
      '</div>' +
      '<div class="record-btns">' +
      '<button type="button" class="btn small primary" data-replay="' + rec.id + '">' + th('records.replay') + '</button>' +
      '<button type="button" class="btn small" data-export="' + rec.id + '">' + th('records.export') + '</button>' +
      '<button type="button" class="btn small ghost" data-delete="' + rec.id + '">' + th('records.delete') + '</button>' +
      '</div></li>';
  }

  function importRecordFile(file) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { renderRecords(t('records.tooBig')); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var rec = null;
      try { rec = Record.parse(JSON.parse(String(reader.result))); } catch (e) { rec = null; }
      if (!rec) { renderRecords(t('records.bad')); return; }
      if (addRecord(rec)) {
        renderRecords(t('records.imported', { mode: modeLabel(rec.mode), date: fmtDate(rec.date) }));
        return;
      }
      closeDialog('records-dialog');
      enterReplay(rec);
      toast(t('records.noStore'), 'warn');
    };
    reader.onerror = function () { renderRecords(t('records.readFail')); };
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
    var items = ['<li><button type="button" data-step="0" style="--c:var(--line)"><span class="rp-n">0</span><i aria-hidden="true"></i><span class="rp-who">' + th('rp.start') + '</span></button></li>'];
    replay.rec.actions.forEach(function (a, i) {
      var pl = st.players[a.player];
      var what = a.type === 'place' ? pieceName(set.pieces[a.piece]) : t('rp.stopped');
      items.push('<li><button type="button" data-step="' + (i + 1) + '" style="--c:' + colorVar(pl) + '">' +
        '<span class="rp-n">' + (i + 1) + '</span><i aria-hidden="true"></i>' +
        '<span class="rp-who">' + escapeHtml(nameOf(pl)) + '</span><span class="rp-what">' + escapeHtml(what) + '</span>' +
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
    $('rp-play').textContent = t(replay.playing ? 'rp.pause' : k >= replay.n ? 'rp.restart' : 'rp.play');
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

  /* ================= 全站游玩次数 ================= */

  // 自建服务器：服务器累计；Claude 发布的页面：每位访客在 plays/<自己的 id> 记自己的次数，首页显示所有人之和
  var plays = { total: null, kind: null, mine: 0, db: null, uid: null };

  function initPlays() {
    ensureNet().then(function (r) {
      var net = r && r.net;
      if (net && net.kind === 'server') {
        plays.kind = 'server';
        fetch('api/stats', { cache: 'no-store' }).then(function (res) { return res.ok ? res.json() : null; }).then(function (d) {
          if (d && typeof d.plays === 'number') { plays.total = d.plays; renderPlays(); }
        }, function () {});
      } else if (net && net.kind === 'artifact' && inClaudePage()) {
        Promise.all([window.claude.use('db'), window.claude.use('user')]).then(function (caps) {
          var db = caps[0], user = caps[1];
          if (!db) return;
          plays.db = db;
          plays.kind = 'artifact';
          db.collection('plays').onSnapshot(function (snap) {
            var sum = 0;
            snap.docs.forEach(function (d) {
              var n = d.exists && d.data() ? d.data().n : 0;
              if (typeof n === 'number' && isFinite(n) && n > 0) sum += Math.floor(n);
              if (d.id === plays.uid) plays.mine = typeof n === 'number' ? n : 0;
            });
            plays.total = sum;
            renderPlays();
          }, function () {});
          if (user && user.id) Promise.resolve(user.id()).then(function (id) { plays.uid = id || null; }, function () {});
        }, function () {});
      }
    });
  }

  function countPlay() {
    if (plays.kind === 'server') {
      fetch('api/stats/play', { method: 'POST' }).then(function (res) { return res.ok ? res.json() : null; }).then(function (d) {
        if (d && typeof d.plays === 'number') { plays.total = d.plays; renderPlays(); }
      }, function () {});
    } else if (plays.kind === 'artifact' && plays.db && plays.uid) {
      plays.mine += 1;
      plays.db.doc('plays/' + plays.uid).set({ n: plays.mine }).catch(function () { plays.mine -= 1; });
    }
  }

  function renderPlays() {
    var el = $('play-count');
    if (plays.total === null) { el.hidden = true; return; }
    var num = plays.total.toLocaleString(I18n.lang());
    el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2" opacity=".45"/></svg>' +
      th('stats.plays', { n: plays.total, count: num });
    el.hidden = false;
  }

  /* ================= 界面语言 ================= */

  // 没选过语言时按浏览器语言自动选择（都不支持就用英文）
  function initLang() {
    // 在游戏平台上用平台给的语言（平台要求），否则用浏览器语言
    var platformLang = Platform.locale();
    var langs = platformLang ? [platformLang] : navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
    I18n.setLang(prefs.lang || I18n.detect(langs));
  }

  function applyI18n() {
    document.documentElement.lang = I18n.lang();
    document.title = t('app.title');
    var meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', t('app.description'));
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    document.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
        var i = pair.indexOf(':');
        el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
      });
    });
    renderLogo();
    $('lang-select').innerHTML = I18n.LANGS.map(function (l) {
      return '<option value="' + l.code + '" lang="' + l.code + '"' + (l.code === I18n.lang() ? ' selected' : '') + '>' + escapeHtml(l.name) + '</option>';
    }).join('');
  }

  // 标题字：中日韩逐字上色，其他语言逐词上色（BlockTurf 拆成 Block / Turf）
  function renderLogo() {
    var title = t('app.title');
    var cjk = /^[぀-ヿ㐀-鿿가-힯]+$/.test(title);
    var parts = cjk ? Array.from(title) : title.split(/\s+|(?=[A-Z])/).filter(Boolean);
    var colors = ['blue', 'yellow', 'red', 'green'];
    var el = $('logo');
    el.setAttribute('aria-label', title);
    el.classList.toggle('words', !cjk);
    el.innerHTML = parts.map(function (part, i) {
      return '<span class="logo-ch" style="--c: var(--p-' + colors[i % colors.length] + '); --i: ' + i + '">' + escapeHtml(part) + '</span>';
    }).join('');
  }

  function setLanguage(code) {
    prefs.lang = I18n.setLang(code);
    savePrefs();
    applyI18n();
    if (!$('setup').hidden) {
      renderSetup();
      buildModeSeg();
      renderPlays();
      if (demo.mode) $('demo-label').innerHTML = modeIcon(demo.mode) + '<b>' + escapeHtml(modeLabel(demo.mode)) + '</b>';
    }
    if (!$('lobby').hidden) renderLobby();
    if (game.state && !$('game').hidden) {
      buildTray();
      applyModeControls();
      if (isReplay()) buildReplayMoves();
      renderGame();
    }
  }

  /* ================= 新手引导 ================= */

  // 每种棋盘第一次进入对局时弹出；看完或跳过后记在本机，顶栏的 ? 可以再看
  var TOUR_FAMILY = { classic: 'square', duo: 'square', trigon: 'trigon', gemblo: 'gemblo', cube: 'cube', prism: 'prism' };
  var tour = { steps: null, i: 0, mode: null };

  function toursSeen() {
    var s = load(STORE_TOURS);
    return s && typeof s === 'object' ? s : {};
  }

  function tourSteps(mode) {
    var fam = TOUR_FAMILY[mode];
    var flat = fam !== 'cube' && fam !== 'prism';
    var touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    return [
      { target: 'board-wrap', title: 'tour.goalTitle', body: 'tour.goal.' + fam },
      { target: 'board-wrap', title: 'tour.startTitle', body: 'tour.start.' + mode },
      { title: 'tour.ruleTitle', body: 'tour.rule.' + fam, diagram: fam },
      { target: 'dock', title: 'tour.controlsTitle', body: flat ? 'tour.controls.flat' : 'tour.controls.3d', extra: touch ? 'tour.controls.touch' : null },
      { target: 'players', title: 'tour.playersTitle', body: 'tour.players' },
      { target: 'help-btn', title: 'tour.helpTitle', body: 'tour.help' }
    ];
  }

  function maybeStartTour() {
    if (!game.state || isReplay() || toursSeen()[game.state.mode]) return;
    startTour(game.state.mode);
  }

  function startTour(mode) {
    if (tour.steps) return;
    tour.mode = mode;
    tour.steps = tourSteps(mode);
    tour.i = 0;
    // 本地电脑等引导结束再走
    game.touring = true;
    cancelAI();
    syncGameplay();
    var me = myPlayers()[0] || cur();
    $('tour').style.setProperty('--tc', colorVar(me));
    openDialog('tour');
    showTourStep();
  }

  function endTour() {
    if (!tour.steps) return;
    var seen = toursSeen();
    seen[tour.mode] = 1;
    save(STORE_TOURS, seen);
    tour.steps = null;
    game.touring = false;
    closeDialog('tour');
    if (isLocalAITurn()) scheduleAI();
    renderGame();
  }

  function tourGo(d) {
    if (!tour.steps) return;
    var i = tour.i + d;
    if (i >= tour.steps.length) { endTour(); return; }
    tour.i = clamp(i, 0, tour.steps.length - 1);
    showTourStep();
  }

  function showTourStep() {
    var step = tour.steps[tour.i];
    var n = tour.steps.length;
    $('tour-step').textContent = t('tour.step', { k: tour.i + 1, n: n });
    $('tour-title').textContent = t(step.title);
    $('tour-body').innerHTML = '<p>' + t(step.body) + '</p>' +
      (step.extra ? '<p class="tour-extra">' + t(step.extra) + '</p>' : '') +
      (step.diagram ? tourDiagram(step.diagram) : '');
    $('tour-back').disabled = tour.i === 0;
    $('tour-next').textContent = t(tour.i === n - 1 ? 'tour.done' : 'tour.next');
    placeTour();
    replayClass($('tour-card'), 'step-in');
    try { $('tour-next').focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
  }

  // 聚光框圈住要讲的界面，卡片放在旁边放得下的一侧；放不下时贴在底部
  function placeTour() {
    if (!tour.steps) return;
    var step = tour.steps[tour.i];
    var spot = $('tour-spot'), card = $('tour-card');
    var target = step.target ? $(step.target) : null;
    if (target && target.offsetParent) {
      var r0 = target.getBoundingClientRect();
      if (r0.top < 0 || r0.bottom > window.innerHeight) target.scrollIntoView({ block: r0.height > window.innerHeight * 0.6 ? 'start' : 'center' });
    }
    var r = target && target.offsetParent ? target.getBoundingClientRect() : null;
    $('tour').classList.toggle('dim', !r);
    spot.hidden = !r;
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var w = card.offsetWidth, h = card.offsetHeight, gap = 14, m = 12;
    var x = (vw - w) / 2, y = (vh - h) / 2;
    if (r) {
      var pad = 6;
      spot.style.left = (r.left - pad) + 'px';
      spot.style.top = (r.top - pad) + 'px';
      spot.style.width = (r.width + pad * 2) + 'px';
      spot.style.height = (r.height + pad * 2) + 'px';
      var midY = clamp(r.top + r.height / 2 - h / 2, m, vh - h - m);
      var midX = clamp(r.left + r.width / 2 - w / 2, m, vw - w - m);
      if (r.right + gap + w <= vw - m) { x = r.right + gap; y = midY; }
      else if (r.left - gap - w >= m) { x = r.left - gap - w; y = midY; }
      else if (r.bottom + gap + h <= vh - m) { x = midX; y = r.bottom + gap; }
      else if (r.top - gap - h >= m) { x = midX; y = r.top - gap - h; }
      else { x = midX; y = vh - h - m; }
    }
    card.style.left = Math.max(m, x) + 'px';
    card.style.top = Math.max(m, y) + 'px';
  }

  /* ---------- 规则示意图 ---------- */

  function fmtPoints(pts) {
    return pts.map(function (p) { return p[0].toFixed(3) + ',' + p[1].toFixed(3); }).join(' ');
  }

  function dgFigure(svg, ok, captionKey) {
    return '<figure class="tour-dg ' + (ok ? 'ok' : 'bad') + '">' + svg +
      '<figcaption><b aria-hidden="true">' + (ok ? '✓' : '✗') + '</b> ' + th(captionKey) + '</figcaption></figure>';
  }

  // 平面示意：cells 为 [x, y, 类别]，类别 own / new / other；mark 是接触点
  function dgFlat(geom, cells, mark, ok) {
    var has = {};
    cells.forEach(function (c) { has[c[0] + ',' + c[1]] = c[2]; });
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var cx0 = Infinity, cx1 = -Infinity, cy0 = Infinity, cy1 = -Infinity;
    cells.forEach(function (c) {
      geom.cellPoly(c[0], c[1]).forEach(function (p) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      });
      cx0 = Math.min(cx0, c[0]); cx1 = Math.max(cx1, c[0]); cy0 = Math.min(cy0, c[1]); cy1 = Math.max(cy1, c[1]);
    });
    var padV = 0.45;
    var out = '';
    // 周围的空格子当作棋盘底纹
    for (var x = cx0 - 2; x <= cx1 + 2; x++) {
      for (var y = cy0 - 2; y <= cy1 + 2; y++) {
        var poly = geom.cellPoly(x, y);
        var cen = geom.centroid(x, y);
        if (cen[0] < minX - padV || cen[0] > maxX + padV || cen[1] < minY - padV || cen[1] > maxY + padV) continue;
        var kind = has[x + ',' + y] || 'empty';
        out += '<polygon points="' + fmtPoints(poly) + '" class="dg-' + kind + '"/>';
      }
    }
    out += '<circle cx="' + mark[0].toFixed(3) + '" cy="' + mark[1].toFixed(3) + '" r="0.2" class="dg-mark"/>';
    var vb = [minX - padV, minY - padV, maxX - minX + padV * 2, maxY - minY + padV * 2];
    return '<svg viewBox="' + vb.map(function (v) { return v.toFixed(3); }).join(' ') + '" aria-hidden="true">' + out + '</svg>';
  }

  // 立体示意：cells 为 [x, 层, z, 类别]；floor(x, z) 给出这一格在地面上的多边形
  function dgSolid(floor, layerH, cells, mark, ok) {
    var C = Math.cos(Math.PI / 6), S = Math.sin(Math.PI / 6);
    function proj(px, py, pz) { return [(px - pz) * C, (px + pz) * S - py * layerH]; }
    var faces = [];
    // 地面格子当底纹，看得出棋子是并排放在地上
    var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    cells.forEach(function (c) { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); z0 = Math.min(z0, c[2]); z1 = Math.max(z1, c[2]); });
    for (var fx = x0; fx <= x1; fx++) {
      for (var fz = z0; fz <= z1; fz++) {
        faces.push({ pts: floor(fx, fz).map(function (p) { return proj(p[0], 0, p[1]); }), kind: 'empty', shade: 'floor' });
      }
    }
    cells.slice().sort(function (a, b) {
      var ca = floor(a[0], a[2]), cb = floor(b[0], b[2]);
      function depth(poly) { return poly.reduce(function (s, p) { return s + p[0] + p[1]; }, 0) / poly.length; }
      return a[1] - b[1] || depth(ca) - depth(cb);
    }).forEach(function (c) {
      var poly = floor(c[0], c[2]);
      var mx = 0, mz = 0;
      poly.forEach(function (p) { mx += p[0] / poly.length; mz += p[1] / poly.length; });
      var y0 = c[1], y1 = c[1] + 1;
      for (var k = 0; k < poly.length; k++) {
        var a = poly[k], b = poly[(k + 1) % poly.length];
        var nx = b[1] - a[1], nz = -(b[0] - a[0]);
        if (nx * ((a[0] + b[0]) / 2 - mx) + nz * ((a[1] + b[1]) / 2 - mz) < 0) { nx = -nx; nz = -nz; }
        if (nx + nz <= 1e-9) continue;
        var shade = nx > nz ? 'r' : 'l';
        faces.push({ pts: [proj(a[0], y0, a[1]), proj(b[0], y0, b[1]), proj(b[0], y1, b[1]), proj(a[0], y1, a[1])], kind: c[3], shade: shade });
      }
      faces.push({ pts: poly.map(function (p) { return proj(p[0], y1, p[1]); }), kind: c[3], shade: 't' });
    });
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var out = '';
    faces.forEach(function (f) {
      f.pts.forEach(function (p) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      });
      out += '<polygon points="' + fmtPoints(f.pts) + '" class="dg-' + f.kind + (f.shade === 'floor' ? '' : ' dg-face-' + f.shade) + '"/>';
    });
    var mp = proj(mark[0], mark[1], mark[2]);
    out += '<circle cx="' + mp[0].toFixed(3) + '" cy="' + mp[1].toFixed(3) + '" r="0.2" class="dg-mark"/>';
    var pad = 0.4;
    var vb = [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2];
    return '<svg viewBox="' + vb.map(function (v) { return v.toFixed(3); }).join(' ') + '" aria-hidden="true">' + out + '</svg>';
  }

  function tourDiagram(fam) {
    var G = Pieces.GEOMETRY;
    var H = Pieces.H;
    var figs = [];
    if (fam === 'square') {
      var own = [[0, 0, 'own'], [0, 1, 'own'], [1, 1, 'own']];
      figs.push(dgFigure(dgFlat(G.square, own.concat([[2, 2, 'new'], [2, 3, 'new'], [3, 2, 'new']]), [2, 2], true), true, 'tour.dg.corner'));
      figs.push(dgFigure(dgFlat(G.square, own.concat([[2, 1, 'new'], [3, 1, 'new'], [3, 0, 'new']]), [2, 1.5], false), false, 'tour.dg.side'));
    } else if (fam === 'trigon') {
      var tOwn = [[0, 0, 'own'], [1, 0, 'own']];
      figs.push(dgFigure(dgFlat(G.tri, tOwn.concat([[3, 0, 'new'], [4, 0, 'new']]), [1.5, 0], true), true, 'tour.dg.corner'));
      figs.push(dgFigure(dgFlat(G.tri, tOwn.concat([[2, 0, 'new'], [3, 0, 'new']]), [1.25, 0.5 * H], false), false, 'tour.dg.side'));
    } else if (fam === 'gemblo') {
      var hOwn = [[0, 0, 'own'], [0, 1, 'own']];
      var gap = [H / 2, 1.75];
      figs.push(dgFigure(dgFlat(G.hex, hOwn.concat([[1, 2, 'new'], [1, 3, 'new']]), gap, true), true, 'tour.dg.apex'));
      figs.push(dgFigure(dgFlat(G.hex, hOwn.concat([[1, 1, 'new'], [1, 2, 'new']]), [H / 2, 1.25], false), false, 'tour.dg.touch'));
      figs.push(dgFigure(dgFlat(G.hex, hOwn.concat([[1, 2, 'new'], [1, 3, 'new'], [1, 1, 'other'], [0, 2, 'other']]), gap, false), false, 'tour.dg.blocked'));
    } else if (fam === 'cube') {
      var square = function (x, z) { return [[x, z], [x + 1, z], [x + 1, z + 1], [x, z + 1]]; };
      var cOwn = [[0, 0, 0, 'own'], [1, 0, 0, 'own']];
      figs.push(dgFigure(dgSolid(square, 1, cOwn.concat([[2, 0, 1, 'new'], [2, 0, 2, 'new']]), [2, 0.5, 1], true), true, 'tour.dg.edge'));
      figs.push(dgFigure(dgSolid(square, 1, cOwn.concat([[2, 0, 0, 'new'], [2, 0, 1, 'new']]), [2, 0.5, 0.5], false), false, 'tour.dg.face'));
    } else {
      var tri = function (x, z) { return G.tri.cellPoly(x, z); };
      var pOwn = [[0, 0, 0, 'own'], [1, 0, 0, 'own']];
      figs.push(dgFigure(dgSolid(tri, 0.7, pOwn.concat([[3, 0, 0, 'new'], [4, 0, 0, 'new']]), [1.5, 0.5, 0], true), true, 'tour.dg.edge'));
      figs.push(dgFigure(dgSolid(tri, 0.7, pOwn.concat([[2, 0, 0, 'new'], [3, 0, 0, 'new']]), [1.25, 0.5, 0.5 * H], false), false, 'tour.dg.face'));
    }
    var legend = '<p class="tour-legend"><span class="lg own"></span>' + th('tour.dg.yours') + '<span class="lg new"></span>' + th('tour.dg.new') +
      (fam === 'gemblo' ? '<span class="lg other"></span>' + th('tour.dg.other') : '') + '</p>';
    return '<div class="tour-dgs">' + figs.join('') + '</div>' + legend;
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
    if (!netInfo.ready) note.textContent = t('online.checking');
    else if (net && net.kind === 'artifact') note.textContent = t(canWrite() ? 'online.noteShared' : 'online.noteReadOnly');
    else if (net) note.textContent = t('online.noteServer');
    else note.textContent = netInfo.reason === 'file' || netInfo.reason === 'static' ? '' : t('online.noteNone');
    note.hidden = !note.textContent;
    var last = load(STORE_ONLINE);
    var rejoin = $('rejoin-room');
    rejoin.hidden = !(usable && last && last.code && !online);
    if (!rejoin.hidden) rejoin.textContent = t('online.rejoin', { code: last.code });
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
      showOnlineError(e && e.code ? errText(e) : t('online.errCreate'));
    }).then(function () { setOnlineBusy(false); });
  }

  function joinRoom(code, opts) {
    var net = netInfo.net;
    if (!net) return Promise.resolve();
    unlockAudio();
    showOnlineError(null);
    return net.exists(code).then(function (ok) {
      if (!ok) throw new Error(t('online.errNotFound', { code: code }));
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
          showOnlineError(t('online.errClosed', { code: code }));
        }),
        onError: live(function () { lobbyError(t('err.corrupt')); })
      });
      game.mode = 'online';
      showScreen('lobby');
      renderLobby();
    }).catch(function (e) {
      showOnlineError(e && e.code ? errText(e) : (e && e.message) || t('online.errJoin'));
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
    sendOp({ type: 'host' }, true).then(function () { toast(t('online.becameHost')); }, function () {});
  }

  function sendOp(op, quiet) {
    if (!online) return Promise.reject(new Error(t('online.errNotInRoom')));
    return online.net.op(op).catch(function (err) {
      if (!quiet && err.code !== 'stale') lobbyError(errText(err));
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
    confirmBox(t('leave.title'), t('leave.text'), t('leave.yes')).then(function (ok) {
      if (ok) go();
    });
  }

  function renderLobby() {
    if (!online) return;
    $('lobby-code').textContent = online.code;
    var conn = $('lobby-conn');
    conn.textContent = t(online.connected ? 'lobby.connected' : 'lobby.reconnecting');
    conn.classList.toggle('off', !online.connected);
    var room = online.room;
    var seatsEl = $('lobby-seats');
    if (!room || !online.pid) {
      seatsEl.innerHTML = '<li class="seat"><span class="seat-swatch"></span><div class="ls-main"><b>' + th('lobby.entering') + '</b></div></li>';
      $('lobby-start').hidden = true;
      return;
    }
    var me = online.pid;
    var isHost = room.host === me;
    var M = Engine.MODES[room.mode];
    var known = peersKnown();

    var modeBox = $('lobby-mode');
    var modeKey = I18n.lang() + '|' + isHost;
    if (modeBox.dataset.key !== modeKey) {
      modeBox.dataset.key = modeKey;
      modeBox.innerHTML = modeCards('lobby-mode', room.mode, !isHost);
      moveThumb(modeBox, true);
    } else {
      $('lobby-mode-' + room.mode).checked = true;
      moveThumb(modeBox);
    }
    // 人数固定的棋盘：房主把之前设成空位的座位改回电脑
    if (isHost && countOptions(room.mode).length === 1 && online.fixedRev !== room.rev &&
        room.seats.some(function (s) { return s.kind === 'off'; })) {
      online.fixedRev = room.rev;
      room.seats.reduce(function (pr, s, i) {
        return s.kind === 'off' ? pr.then(function () { return sendOp({ type: 'seat', seat: i, kind: 'ai' }, true); }) : pr;
      }, Promise.resolve()).catch(function () {});
    }

    // 人数：没设成空位的座位数；房主改人数就把后面的座位设为空位或恢复
    var active = room.seats.filter(function (s) { return s.kind !== 'off'; }).length;
    var lobbyCount = $('lobby-count');
    var counts = countOptions(room.mode);
    lobbyCount.hidden = counts.length < 2;
    lobbyCount.innerHTML = counts.map(function (c) {
      return '<label><input type="radio" name="lobby-count" value="' + c + '"' + (c === active ? ' checked' : '') + (isHost ? '' : ' disabled') + '><span>' + c + '</span></label>';
    }).join('');

    seatsEl.innerHTML = M.seats.map(function (seat, i) {
      var s = room.seats[i];
      if (s.kind === 'off') return '';
      var mine = s.owner === me;
      var title, sub;
      var color = colorName(seat.color);
      if (s.kind === 'off') { title = t('lobby.offTitle'); sub = t('lobby.offSub'); }
      else if (s.kind === 'ai') { title = t('seat.aiName', { color: color }); sub = t('lobby.aiSub', { level: levelLabel(s.level) }) + (s.level === 'llm' && s.model ? ' · ' + profileLabel(s.model) : ''); }
      else if (s.owner) {
        title = nameOf({ type: 'human', name: s.name });
        sub = t(mine ? 'lobby.you' : 'lobby.player') + (s.owner === room.host ? ' · ' + t('lobby.host') : '') +
          (known ? ' · ' + t(isPeerOnline(s.owner) ? 'lobby.online' : 'lobby.offline') : '');
      } else { title = t('lobby.openTitle'); sub = t('lobby.openSub'); }
      var actions = '';
      if (s.kind === 'open' && !s.owner && canWrite()) actions += '<button type="button" class="btn primary" data-claim="' + i + '">' + th('lobby.claim') + '</button>';
      if (mine) actions += '<button type="button" class="btn" data-release="' + i + '">' + th('lobby.release') + '</button>';
      var hostCtl = '';
      if (isHost) {
        var kinds = [['open', t('seat.human')], ['ai', t('seat.ai')]];
        actions += '<div class="seg small" role="radiogroup" aria-label="' + th('seat.typeAria', { color: color }) + '">' + kinds.map(function (k) {
          return '<label><input type="radio" name="lobby-kind-' + i + '" value="' + k[0] + '" data-kind="' + i + '"' + (s.kind === k[0] ? ' checked' : '') + '><span>' + escapeHtml(k[1]) + '</span></label>';
        }).join('') + '</div>';
        if (s.kind === 'ai') {
          hostCtl = '<div class="seat-level">' + th('seat.level') + ' <div class="seg small" role="radiogroup" aria-label="' + th('seat.levelAria') + '">' + LEVELS.map(function (lv) {
            return '<label><input type="radio" name="lobby-level-' + i + '" value="' + lv + '" data-level="' + i + '"' + (s.level === lv ? ' checked' : '') + '><span>' + escapeHtml(levelLabel(lv)) + '</span></label>';
          }).join('') + '</div>' +
            (s.level === 'llm' ? '<label class="seat-model">' + th('seat.model') + ' <select data-model="' + i + '" aria-label="' + th('seat.modelAria', { color: color }) + '">' + profileOptions(s.model) + '</select></label>' : '') +
            '</div>';
        }
      }
      return '<li class="seat lobby-seat' + (s.kind === 'off' ? ' off' : '') + (mine ? ' mine' : '') + '" style="--c: var(--p-' + seat.color + ')">' +
        '<span class="seat-swatch" aria-hidden="true">' + escapeHtml(t('colorShort.' + seat.color)) + '</span>' +
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
      wait.textContent = check.error ? errText(check) : '';
    } else {
      wait.textContent = t('lobby.waitHost');
    }

    var people = $('lobby-people');
    var ids = known ? online.peers.slice() : Online.seatOwners(room);
    if (ids.indexOf(me) < 0) ids.unshift(me);
    people.innerHTML = ids.map(function (id) {
      var seatIdx = room.seats.findIndex(function (s) { return s.owner === id; });
      var name = seatIdx >= 0 ? nameOf({ type: 'human', name: room.seats[seatIdx].name }) : t('lobby.spectator');
      var color = seatIdx >= 0 ? 'var(--p-' + M.seats[seatIdx].color + ')' : 'var(--ink-soft)';
      var tag = escapeHtml((id === me ? t('lobby.you') : '') + (id === room.host ? (id === me ? ' · ' : '') + t('lobby.host') : ''));
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
        toast(t('toast.pickTray'));
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
          else if (!o.shift && canAct() && game.sel.piece < 0) toast(t('toast.pickTray3d'));
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
      if ($('game').hidden || anyDialogOpen() || !game.state || !$('ad-shield').hidden) return;
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
        err.textContent = t(prefs.mode === 'gemblo' ? 'setup.errGemblo' : 'setup.errFew');
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

    $('mode-seg').addEventListener('change', function (e) {
      if (e.target.name !== 'mode') return;
      prefs.mode = e.target.value;
      savePrefs();
      renderSetup();
      restartDemo();
    });
    $('presets').addEventListener('click', function (e) {
      var b = e.target.closest('[data-preset]');
      if (!b) return;
      var mode = prefs.mode;
      presetsFor(seatCount(mode))[+b.dataset.preset].forEach(function (type, i) { prefs.seats[mode][i].type = type; });
      savePrefs();
      renderSetup();
    });
    $('count-seg').addEventListener('change', function (e) {
      if (e.target.name !== 'seat-count') return;
      prefs.counts[prefs.mode] = +e.target.value;
      savePrefs();
      renderSetup();
      restartDemo();
      var again = $('seat-count-' + e.target.value);
      if (again) again.focus();
    });
    $('seats').addEventListener('click', function (e) {
      var b = e.target.closest('[data-llm]');
      if (b) claudeSample().then(function () { openLlmDialog(prefs.seats[prefs.mode][+b.dataset.llm].model); });
    });
    $('seats').addEventListener('input', function (e) {
      if (!e.target.classList.contains('seat-name')) return;
      prefs.seats[prefs.mode][+e.target.dataset.seat].name = e.target.value;
      savePrefs();
    });
    $('seats').addEventListener('change', function (e) {
      var el = e.target;
      if (el.dataset.seat === undefined) return;
      var i = +el.dataset.seat;
      var s = prefs.seats[prefs.mode][i];
      var focusId = el.id;
      if (el.name === 'seat-type-' + i) s.type = el.value;
      else if (el.classList.contains('seat-level-sel')) s.level = el.value;
      else if (el.classList.contains('seat-model-sel')) s.model = el.value;
      else return;
      savePrefs();
      renderSetup();
      var again = $(focusId);
      if (again) again.focus();
      if (s.type === 'ai' && s.level === 'llm' && el.name !== 'seat-type-' + i) ensureLLMSetup(s.model);
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
      if (!code) { showOnlineError(t('online.errCode')); return; }
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
        btn.textContent = t(ok ? 'lobby.copied' : 'lobby.copyManual');
        setTimeout(function () { btn.textContent = t('lobby.copy'); }, 1600);
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
    $('lobby-count').addEventListener('change', function (e) {
      if (e.target.name !== 'lobby-count' || !online || !online.room) return;
      var n = +e.target.value;
      var room = online.room;
      // 前 n 个座位参战（原来是空位的改成电脑），其余设为空位；逐个发送
      var ops = [];
      room.seats.forEach(function (s, i) {
        var want = i < n ? (s.kind === 'off' ? 'ai' : s.kind) : 'off';
        if (want !== s.kind) ops.push({ type: 'seat', seat: i, kind: want });
      });
      ops.reduce(function (pr, op) { return pr.then(function () { return sendOp(op); }); }, Promise.resolve()).catch(renderLobby);
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
        $('end-record-note').textContent = t('record.savedNote');
      } else {
        $('end-record-note').textContent = t('record.saveFail');
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
        confirmBox(t('records.deleteTitle'), t('records.deleteText', { mode: modeLabel(rec.mode), date: fmtDate(rec.date) }), t('records.delete')).then(function (ok) {
          if (!ok) return;
          storeRecords(loadRecords().filter(function (r) { return r.id !== rec.id; }));
          renderRecords(t('records.deleted'));
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
      placeTour();
      moveThumb($('mode-seg'), true);
      moveThumb($('lobby-mode'), true);
    });

    // 语言与新手引导
    $('lang-select').addEventListener('change', function (e) { setLanguage(e.target.value); });
    $('help-btn').addEventListener('click', function () { if (game.state) startTour(game.state.mode); });
    $('tour-next').addEventListener('click', function () { tourGo(1); });
    $('tour-back').addEventListener('click', function () { tourGo(-1); });
    $('tour-skip').addEventListener('click', endTour);
    $('tour').addEventListener('cancel', function (e) { e.preventDefault(); endTour(); });
    $('tour').addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); tourGo(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); tourGo(-1); }
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !$('setup').hidden) demoStep();
    });
  }

  /* ================= 启动 ================= */

  initLang();
  applyI18n();
  buildModeSeg();
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
  initPlays();
  claudeSample();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      if (demo.view && demo.view.resize()) demo.view.draw();
      moveThumb($('mode-seg'), true);
    });
  }
  Platform.loaded();
});
