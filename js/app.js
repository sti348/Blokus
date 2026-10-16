/*
 * 角斗士棋界面：开局设置、棋盘绘制、人机交互、电脑回合调度、存档。
 */
(function () {
  'use strict';

  var PIECES = BlokusPieces.PIECES;
  var orientFor = BlokusPieces.orientFor;
  var Engine = BlokusEngine;
  var AI = BlokusAI;

  var LEVEL_LABEL = { easy: '简单', normal: '普通', hard: '困难' };
  var SPEED_MS = { fast: 200, normal: 550, slow: 1100 };
  var REASON_TEXT = {
    used: '这块棋子已经用过了',
    bounds: '超出棋盘范围',
    occupied: '这里已经有棋子了',
    edge: '不能和自己的棋子边贴边',
    start: '第一块必须盖住你的起始角',
    corner: '必须和自己的棋子角对角相接',
    over: '对局已经结束'
  };
  var STORE_PREFS = 'blokus.prefs.v1';
  var STORE_SAVE = 'blokus.save.v1';
  var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DROP_MS = REDUCED_MOTION ? 0 : 240;
  // 托盘里大块在前
  var TRAY_ORDER = PIECES.map(function (p) { return p.index; })
    .sort(function (a, b) { return PIECES[b].size - PIECES[a].size || a - b; });

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

  /* ================= 棋盘绘制 ================= */

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // 一格塑料方块：斜面高光 + 内凸方台
  function makeTile(color, s) {
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    var gap = Math.max(1, s * 0.05);
    var x0 = gap / 2, w = s - gap, r = s * 0.12, b = s * 0.13;
    roundRect(g, x0, x0, w, w, r);
    g.fillStyle = color;
    g.fill();
    g.save();
    g.clip();
    g.fillStyle = 'rgba(255,255,255,0.32)';
    g.beginPath();
    g.moveTo(x0, x0); g.lineTo(x0 + w, x0); g.lineTo(x0 + w - b, x0 + b);
    g.lineTo(x0 + b, x0 + b); g.lineTo(x0 + b, x0 + w - b); g.lineTo(x0, x0 + w);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath();
    g.moveTo(x0 + w, x0); g.lineTo(x0 + w, x0 + w); g.lineTo(x0, x0 + w);
    g.lineTo(x0 + b, x0 + w - b); g.lineTo(x0 + w - b, x0 + w - b); g.lineTo(x0 + w - b, x0 + b);
    g.closePath();
    g.fill();
    var grad = g.createLinearGradient(0, x0 + b, 0, x0 + w - b);
    grad.addColorStop(0, 'rgba(255,255,255,0.16)');
    grad.addColorStop(1, 'rgba(0,0,0,0.05)');
    g.fillStyle = grad;
    g.fillRect(x0 + b, x0 + b, w - 2 * b, w - 2 * b);
    var m = s * 0.31;
    g.strokeStyle = 'rgba(0,0,0,0.13)';
    g.lineWidth = Math.max(1, s * 0.03);
    g.strokeRect(m, m, s - 2 * m, s - 2 * m);
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.strokeRect(m - g.lineWidth, m - g.lineWidth, s - 2 * m, s - 2 * m);
    g.restore();
    return c;
  }

  function BoardView(canvas, getState, getOverlay) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getState = getState;
    this.getOverlay = getOverlay;
    this.css = 0;
    this.dpr = 1;
    this.tiles = {};
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
    this.tiles = {};
    return true;
  };

  BoardView.prototype.geom = function (n) {
    var pad = Math.max(6, this.css * 0.024);
    return { pad: pad, cell: (this.css - pad * 2) / n };
  };

  BoardView.prototype.cellAt = function (clientX, clientY, n) {
    var r = this.canvas.getBoundingClientRect();
    if (clientX < r.left || clientY < r.top || clientX > r.right || clientY > r.bottom) return null;
    var g = this.geom(n);
    var x = Math.floor((clientX - r.left - g.pad) / g.cell);
    var y = Math.floor((clientY - r.top - g.pad) / g.cell);
    return { x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) };
  };

  BoardView.prototype.tile = function (color, cell) {
    var s = Math.max(4, Math.ceil(cell * this.dpr));
    if (this.tilesTheme !== themeVersion) {
      this.tiles = {};
      this.tilesTheme = themeVersion;
    }
    var key = color + '|' + s;
    if (!this.tiles[key]) this.tiles[key] = makeTile(color, s);
    return this.tiles[key];
  };

  BoardView.prototype.background = function (n) {
    var key = n + '|' + this.css + '|' + this.dpr + '|' + themeVersion;
    if (this.bgKey === key) return this.bgCanvas;
    var c = document.createElement('canvas');
    c.width = c.height = Math.round(this.css * this.dpr);
    var g = c.getContext('2d');
    g.scale(this.dpr, this.dpr);
    var geo = this.geom(n);
    roundRect(g, 0, 0, this.css, this.css, Math.min(16, this.css * 0.04));
    g.fillStyle = palette.frame;
    g.fill();
    g.fillStyle = palette.groove;
    g.fillRect(geo.pad, geo.pad, geo.cell * n, geo.cell * n);
    g.fillStyle = palette.cell;
    var inset = Math.max(0.5, geo.cell * 0.06);
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        g.fillRect(geo.pad + x * geo.cell + inset, geo.pad + y * geo.cell + inset, geo.cell - inset * 2, geo.cell - inset * 2);
      }
    }
    this.bgKey = key;
    this.bgCanvas = c;
    return c;
  };

  BoardView.prototype.outline = function (cells, geo, style, width, dash) {
    var g = this.ctx;
    var set = {};
    cells.forEach(function (c) { set[c[0] + ',' + c[1]] = 1; });
    g.save();
    g.strokeStyle = style;
    g.lineWidth = width;
    g.lineCap = 'round';
    if (dash) g.setLineDash(dash);
    g.beginPath();
    cells.forEach(function (c) {
      var x = geo.pad + c[0] * geo.cell, y = geo.pad + c[1] * geo.cell, s = geo.cell;
      if (!set[c[0] + ',' + (c[1] - 1)]) { g.moveTo(x, y); g.lineTo(x + s, y); }
      if (!set[c[0] + ',' + (c[1] + 1)]) { g.moveTo(x, y + s); g.lineTo(x + s, y + s); }
      if (!set[(c[0] - 1) + ',' + c[1]]) { g.moveTo(x, y); g.lineTo(x, y + s); }
      if (!set[(c[0] + 1) + ',' + c[1]]) { g.moveTo(x + s, y); g.lineTo(x + s, y + s); }
    });
    g.stroke();
    g.restore();
  };

  BoardView.prototype.draw = function (now) {
    var state = this.getState();
    if (!state || !this.css) return;
    var ov = this.getOverlay ? this.getOverlay() : {};
    now = now || performance.now();
    var g = this.ctx, n = state.size, self = this;
    var geo = this.geom(n);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.css, this.css);
    g.drawImage(this.background(n), 0, 0, this.css, this.css);

    function colorOf(p) { return palette.colors[state.players[p].color] || palette.ink; }
    function tileAt(x, y, color, alpha, scale) {
      var px = geo.pad + x * geo.cell, py = geo.pad + y * geo.cell, s = geo.cell;
      if (scale && scale !== 1) {
        var d = s * (scale - 1) / 2;
        px -= d; py -= d; s *= scale;
      }
      g.globalAlpha = alpha == null ? 1 : alpha;
      g.drawImage(self.tile(color, geo.cell), px, py, s, s);
      g.globalAlpha = 1;
    }

    // 起始角
    state.players.forEach(function (pl, p) {
      if (pl.placed > 0) return;
      var cx = geo.pad + (pl.start[0] + 0.5) * geo.cell;
      var cy = geo.pad + (pl.start[1] + 0.5) * geo.cell;
      g.beginPath();
      g.arc(cx, cy, geo.cell * 0.3, 0, Math.PI * 2);
      if (p === state.current && !state.over) {
        g.globalAlpha = 0.3;
        g.fillStyle = colorOf(p);
        g.fill();
        g.globalAlpha = 1;
      }
      g.lineWidth = Math.max(1.5, geo.cell * 0.1);
      g.strokeStyle = colorOf(p);
      g.stroke();
    });

    // 已落棋子
    var anim = ov.anim, animSet = null, animT = 1;
    if (anim) {
      animT = DROP_MS ? clamp((now - anim.t0) / DROP_MS, 0, 1) : 1;
      animSet = {};
      anim.cells.forEach(function (c) { animSet[c[1] * n + c[0]] = 1; });
    }
    var board = state.board;
    for (var i = 0; i < board.length; i++) {
      var v = board[i];
      if (v < 0 || (animSet && animSet[i])) continue;
      tileAt(i % n, (i - i % n) / n, colorOf(v));
    }
    if (anim) {
      var ease = 1 - Math.pow(1 - animT, 3);
      anim.cells.forEach(function (c) { tileAt(c[0], c[1], colorOf(anim.player), 0.35 + 0.65 * ease, 1.28 - 0.28 * ease); });
    }

    // 上一步高亮
    if (ov.lastMove && (!anim || animT >= 1)) {
      this.outline(ov.lastMove.cells, geo, palette.ink, Math.max(1.5, geo.cell * 0.09));
    }

    // 角点提示
    if (ov.anchors && ov.anchors.list.length) {
      g.fillStyle = ov.anchors.color;
      g.globalAlpha = 0.55;
      ov.anchors.list.forEach(function (idx) {
        var x = idx % n, y = (idx - x) / n;
        g.beginPath();
        g.arc(geo.pad + (x + 0.5) * geo.cell, geo.pad + (y + 0.5) * geo.cell, geo.cell * 0.14, 0, Math.PI * 2);
        g.fill();
      });
      g.globalAlpha = 1;
    }

    // 提示走法
    if (ov.hint) {
      var pulse = REDUCED_MOTION ? 1 : 0.55 + 0.45 * Math.sin(now / 220);
      g.globalAlpha = pulse;
      this.outline(ov.hint.cells, geo, ov.hint.color, Math.max(2, geo.cell * 0.12), [geo.cell * 0.25, geo.cell * 0.18]);
      g.globalAlpha = 1;
    }

    // 待放置棋子
    if (ov.ghost) {
      var gh = ov.ghost;
      gh.cells.forEach(function (c) { tileAt(c[0], c[1], gh.color, gh.valid ? 0.72 : 0.38); });
      if (!gh.valid) {
        g.fillStyle = palette.danger;
        g.globalAlpha = 0.28;
        gh.cells.forEach(function (c) {
          g.fillRect(geo.pad + c[0] * geo.cell, geo.pad + c[1] * geo.cell, geo.cell, geo.cell);
        });
        g.globalAlpha = 1;
      }
      this.outline(gh.cells, geo, gh.valid ? palette.ink : palette.danger, Math.max(1.5, geo.cell * 0.09), gh.valid ? null : [geo.cell * 0.2, geo.cell * 0.14]);
    }
  };

  /* ================= 棋子图形（托盘 / 预览） ================= */

  function pieceSVG(cells, box) {
    var w = 0, h = 0;
    cells.forEach(function (c) { w = Math.max(w, c[0] + 1); h = Math.max(h, c[1] + 1); });
    var B = box || Math.max(w, h);
    var ox = (B - w) / 2, oy = (B - h) / 2;
    var out = '<svg viewBox="-0.1 -0.1 ' + (B + 0.2) + ' ' + (B + 0.2) + '" aria-hidden="true">';
    cells.forEach(function (c) {
      var x = ox + c[0], y = oy + c[1];
      out += '<rect x="' + (x + 0.05) + '" y="' + (y + 0.05) + '" width="0.9" height="0.9" rx="0.14" style="fill:var(--c)"/>' +
        '<rect x="' + (x + 0.27) + '" y="' + (y + 0.27) + '" width="0.46" height="0.46" rx="0.06" fill="#fff" fill-opacity="0.2"/>';
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

  var DEFAULT_PREFS = {
    mode: 'classic',
    seats: {
      classic: [
        { type: 'human', level: 'normal', name: '' },
        { type: 'ai', level: 'normal', name: '' },
        { type: 'ai', level: 'normal', name: '' },
        { type: 'ai', level: 'normal', name: '' }
      ],
      duo: [
        { type: 'human', level: 'normal', name: '' },
        { type: 'ai', level: 'normal', name: '' }
      ]
    },
    hints: true,
    sound: true,
    speed: 'normal'
  };

  function loadPrefs() {
    var p = JSON.parse(JSON.stringify(DEFAULT_PREFS));
    var saved = load(STORE_PREFS);
    if (!saved || typeof saved !== 'object') return p;
    if (saved.mode in Engine.MODES) p.mode = saved.mode;
    ['classic', 'duo'].forEach(function (m) {
      var list = saved.seats && saved.seats[m];
      if (!Array.isArray(list)) return;
      p.seats[m].forEach(function (seat, i) {
        var s = list[i];
        if (!s) return;
        if (['human', 'ai', 'off'].indexOf(s.type) >= 0 && !(m === 'duo' && s.type === 'off')) seat.type = s.type;
        if (s.level in LEVEL_LABEL) seat.level = s.level;
        if (typeof s.name === 'string') seat.name = s.name.slice(0, 12);
      });
    });
    if (typeof saved.hints === 'boolean') p.hints = saved.hints;
    if (typeof saved.sound === 'boolean') p.sound = saved.sound;
    if (saved.speed in SPEED_MS) p.speed = saved.speed;
    return p;
  }

  var prefs = loadPrefs();
  function savePrefs() { save(STORE_PREFS, prefs); }

  var PRESETS = {
    classic: [
      { label: '1 人 + 3 电脑', types: ['human', 'ai', 'ai', 'ai'] },
      { label: '2 人 + 2 电脑', types: ['human', 'ai', 'human', 'ai'] },
      { label: '3 人 + 1 电脑', types: ['human', 'human', 'human', 'ai'] },
      { label: '4 人同屏', types: ['human', 'human', 'human', 'human'] },
      { label: '电脑观战', types: ['ai', 'ai', 'ai', 'ai'] }
    ],
    duo: [
      { label: '人机对战', types: ['human', 'ai'] },
      { label: '双人同屏', types: ['human', 'human'] },
      { label: '电脑观战', types: ['ai', 'ai'] }
    ]
  };

  function seatTypeOptions(mode) {
    var opts = [['human', '玩家'], ['ai', '电脑']];
    if (mode === 'classic') opts.push(['off', '空位']);
    return opts;
  }

  function renderSetup() {
    var mode = prefs.mode;
    $('mode-' + mode).checked = true;
    $('opt-hints').checked = prefs.hints;
    $('opt-sound').checked = prefs.sound;
    $('opt-speed').value = prefs.speed;

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
        '<div class="seat-level"' + (s.type === 'ai' ? '' : ' hidden') + '>难度 <div class="seg small" role="radiogroup" aria-label="电脑难度">' + levelRadios + '</div></div>';
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
        r.addEventListener('change', function () { s.level = r.value; savePrefs(); });
      });
      list.appendChild(li);
    });

    $('setup-error').hidden = true;
    var saved = loadSaved();
    $('resume-btn').hidden = !saved;
  }

  function buildConfig() {
    var mode = prefs.mode;
    var M = Engine.MODES[mode];
    var seats = prefs.seats[mode];
    var humans = seats.filter(function (s) { return s.type === 'human'; }).length;
    var players = [];
    var humanNo = 0;
    M.seats.forEach(function (seat, i) {
      var s = seats[i];
      if (s.type === 'off') return;
      var name = s.name.trim();
      if (s.type === 'human') {
        humanNo++;
        if (!name) name = humans === 1 ? '你' : '玩家' + humanNo;
      } else {
        name = seat.label + '方电脑';
      }
      players.push({
        name: name,
        color: seat.color,
        label: seat.label,
        start: seat.start,
        type: s.type,
        level: s.level
      });
    });
    if (players.length < 2) return null;
    return { mode: mode, size: M.size, players: players };
  }

  /* ================= 演示局 ================= */

  var demo = { view: null, state: null, timer: 0, anim: null };

  function demoConfig() {
    var M = Engine.MODES.classic;
    return { size: M.size, players: M.seats.map(function (s) { return { color: s.color, start: s.start }; }) };
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
      demo.state = Engine.createGame(demoConfig());
      demo.anim = null;
    }
    var st = demo.state;
    var move = AI.chooseMove(st, st.current % 2 ? 'normal' : 'hard');
    if (move) {
      var p = st.current;
      Engine.applyAction(st, { type: 'place', piece: move.piece, orient: move.orient, x: move.x, y: move.y });
      demo.anim = { cells: st.lastMove.cells, player: p, t0: performance.now() };
      animate();
    }
    demo.timer = setTimeout(demoStep, 520);
  }

  function startDemo() {
    if (!demo.view) {
      demo.view = new BoardView($('demo-board'), function () { return demo.state; }, function () {
        return { anim: demo.anim, lastMove: null };
      });
    }
    demo.view.resize();
    if (REDUCED_MOTION) {
      if (!demo.state) {
        demo.state = Engine.createGame(demoConfig());
        for (var k = 0; k < 44 && !demo.state.over; k++) {
          var m = AI.chooseMove(demo.state, 'normal');
          Engine.applyAction(demo.state, { type: 'place', piece: m.piece, orient: m.orient, x: m.x, y: m.y });
        }
      }
      demo.view.draw();
      return;
    }
    demoStep();
  }

  /* ================= 对局 ================= */

  var game = {
    config: null,
    state: null,
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
    lastWheel: 0
  };

  function engineConfig(cfg) { return { size: cfg.size, players: cfg.players }; }
  function cur() { return game.state.players[game.state.current]; }
  function humanCount() { return game.state.players.filter(function (p) { return p.type === 'human'; }).length; }
  function isHumanTurn() { return game.state && !game.state.over && cur().type === 'human'; }
  function isAITurn() { return game.state && !game.state.over && cur().type === 'ai'; }
  function colorVar(pl) { return 'var(--p-' + pl.color + ')'; }

  function trayOwner() {
    var st = game.state;
    if (!st.over && cur().type === 'human') return cur();
    var humans = st.players.filter(function (p) { return p.type === 'human'; });
    if (humans.length === 1) return humans[0];
    return cur();
  }

  function loadSaved() {
    var s = load(STORE_SAVE);
    if (!s || s.v !== 1 || !s.config || !Array.isArray(s.actions) || !Array.isArray(s.config.players)) return null;
    return s;
  }

  function saveGame() {
    if (!game.state || game.state.over) save(STORE_SAVE, null);
    else save(STORE_SAVE, { v: 1, config: game.config, actions: game.state.actions });
  }

  function showScreen(name) {
    $('setup').hidden = name !== 'setup';
    $('game').hidden = name !== 'game';
    if (name === 'setup') {
      cancelAI();
      renderSetup();
      startDemo();
    } else {
      clearTimeout(demo.timer);
    }
  }

  function startGame(cfg, actions) {
    clearTimeout(game.endTimer);
    closeDialog('end-dialog');
    game.config = cfg;
    game.state = actions && actions.length ? Engine.replay(engineConfig(cfg), actions) : Engine.createGame(engineConfig(cfg));
    game.eventCursor = game.state.events.length;
    game.paused = false;
    game.anim = null;
    resetSelection();
    showScreen('game');
    buildTray();
    if (!game.view) {
      game.view = new BoardView($('board'), function () { return game.state; }, gameOverlay);
      new ResizeObserver(function () { if (game.view.resize()) game.view.draw(); }).observe($('board'));
    }
    game.view.resize();
    saveGame();
    onTurnStart(true);
    renderGame();
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
  }

  function onTurnStart(first) {
    resetSelection();
    game.perPiece = null;
    game.anchors = null;
    var st = game.state;
    if (st.over) {
      saveGame();
      clearTimeout(game.endTimer);
      game.endTimer = setTimeout(showEnd, first ? 0 : 700);
      return;
    }
    var pl = cur();
    if (pl.type === 'human') {
      game.perPiece = Engine.movesPerPiece(st, st.current);
      var forb = Engine.forbiddenMask(st.board, st.size, st.current);
      game.anchors = Engine.anchorMask(st.board, st.size, st.current, pl, forb);
      if (!first && humanCount() > 1) {
        toast('轮到 ' + pl.name + '（' + pl.label + '方）');
        sound('turn');
      }
    } else {
      scheduleAI();
    }
  }

  function scheduleAI() {
    cancelAI();
    if (game.paused || !isAITurn()) return;
    var token = game.aiToken;
    game.aiTimer = setTimeout(function () {
      if (token !== game.aiToken || !isAITurn()) return;
      var st = game.state;
      var move = AI.chooseMove(st, cur().level);
      if (!move) {
        Engine.applyAction(st, { type: 'resign' });
        afterAction();
        return;
      }
      commitMove(move, true);
    }, SPEED_MS[prefs.speed] || SPEED_MS.normal);
  }

  function commitMove(move, byAI) {
    var st = game.state;
    var p = st.current;
    var reason = Engine.applyAction(st, { type: 'place', piece: move.piece, orient: move.orient, x: move.x, y: move.y });
    if (reason) return reason;
    game.anim = { cells: st.lastMove.cells, player: p, t0: performance.now() };
    sound('place', byAI && humanCount() > 0);
    afterAction();
    return null;
  }

  function afterAction() {
    var st = game.state;
    var notes = [];
    for (; game.eventCursor < st.events.length; game.eventCursor++) {
      var ev = st.events[game.eventCursor];
      if (ev.type === 'blocked') notes.push(st.players[ev.player].name + ' 已无处可放');
      else if (ev.type === 'resign') notes.push(st.players[ev.player].name + ' 停手了');
    }
    saveGame();
    onTurnStart(false);
    if (notes.length) toast(notes.join('；'));
    renderGame();
    animate();
  }

  /* ---------- 选择 / 放置 ---------- */

  function currentOrient() {
    return orientFor(game.sel.piece, game.sel.rot, game.sel.flip);
  }

  function clampGhost() {
    if (!game.ghost || game.sel.piece < 0) return;
    var o = PIECES[game.sel.piece].orients[currentOrient()];
    var n = game.state.size;
    game.ghost.x = clamp(game.ghost.x, o.pivot[0], n - o.w + o.pivot[0]);
    game.ghost.y = clamp(game.ghost.y, o.pivot[1], n - o.h + o.pivot[1]);
  }

  function ghostMove() {
    if (game.sel.piece < 0 || !game.ghost) return null;
    var oi = currentOrient();
    var o = PIECES[game.sel.piece].orients[oi];
    var x = game.ghost.x - o.pivot[0], y = game.ghost.y - o.pivot[1];
    return { piece: game.sel.piece, orient: oi, x: x, y: y };
  }

  function defaultGhost() {
    var n = game.state.size, c = (n - 1) / 2;
    var best = { x: Math.round(c), y: Math.round(c) };
    if (game.anchors && game.anchors.list.length) {
      var bd = Infinity;
      game.anchors.list.forEach(function (idx) {
        var x = idx % n, y = (idx - x) / n;
        var d = (x - c) * (x - c) + (y - c) * (y - c);
        if (d < bd) { bd = d; best = { x: x, y: y }; }
      });
    }
    return best;
  }

  function gameOverlay() {
    var st = game.state;
    var ov = { lastMove: st.lastMove, anim: game.anim };
    if (isHumanTurn()) {
      var pl = cur();
      var color = palette.colors[pl.color];
      if (prefs.hints && game.anchors) ov.anchors = { list: game.anchors.list, color: color };
      if (game.hint) ov.hint = { cells: Engine.placementCells(game.hint.piece, game.hint.orient, game.hint.x, game.hint.y), color: palette.ink };
      var m = ghostMove();
      if (m) {
        ov.ghost = {
          cells: Engine.placementCells(m.piece, m.orient, m.x, m.y),
          color: color,
          valid: Engine.checkPlacement(st, st.current, m.piece, m.orient, m.x, m.y) === null
        };
      }
    }
    return ov;
  }

  function selectPiece(pi) {
    if (!isHumanTurn() || !cur().remaining[pi]) return;
    if (game.sel.piece === pi) {
      game.sel.piece = -1;
      game.hint = null;
    } else {
      game.sel = { piece: pi, rot: 0, flip: 0 };
      game.hint = null;
      game.hintLockCell = null;
      game.ghostByTap = false;
      if (!game.ghost) game.ghost = defaultGhost();
      clampGhost();
      // 让方向键 / 回车直接作用于棋盘
      try { $('board').focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
    }
    renderDock();
    drawBoard();
  }

  function rotate(d) {
    if (game.sel.piece < 0 || !isHumanTurn()) return;
    game.sel.rot = (game.sel.rot + d + 4) % 4;
    clampGhost();
    renderSelection();
    drawBoard();
  }

  // 始终沿屏幕竖轴镜像：F·R^k = R^-k·F
  function flip() {
    if (game.sel.piece < 0 || !isHumanTurn()) return;
    game.sel.flip ^= 1;
    game.sel.rot = (4 - game.sel.rot) % 4;
    clampGhost();
    renderSelection();
    drawBoard();
  }

  function tryPlace() {
    if (!isHumanTurn()) return false;
    var m = ghostMove();
    if (!m) {
      toast(game.sel.piece < 0 ? '先选一块棋子' : '先在棋盘上选位置');
      return false;
    }
    var reason = Engine.checkPlacement(game.state, game.state.current, m.piece, m.orient, m.x, m.y);
    if (reason) {
      toast(REASON_TEXT[reason] || '这里放不下', 'warn');
      sound('bad');
      return false;
    }
    resetSelection();
    commitMove(m, false);
    return true;
  }

  function giveHint() {
    if (!isHumanTurn()) return;
    var move = AI.chooseMove(game.state, 'hard');
    if (!move) return;
    var o = PIECES[move.piece].orients[move.orient];
    game.sel = { piece: move.piece, rot: o.rot, flip: o.flip };
    game.ghost = { x: move.x + o.pivot[0], y: move.y + o.pivot[1] };
    game.hint = move;
    game.ghostByTap = false;
    game.hintLockCell = game.hover ? { x: game.hover.x, y: game.hover.y } : null;
    toast('试试「' + PIECES[move.piece].name + '」放在虚线框的位置');
    renderDock();
    animate();
  }

  function undo() {
    var st = game.state;
    var i = st.actions.length - 1;
    while (i >= 0 && st.players[st.actions[i].player].type !== 'human') i--;
    if (i < 0) return;
    cancelAI();
    clearTimeout(game.endTimer);
    closeDialog('end-dialog');
    game.state = Engine.replay(engineConfig(game.config), st.actions.slice(0, i));
    game.eventCursor = game.state.events.length;
    game.anim = null;
    saveGame();
    onTurnStart(true);
    renderGame();
    toast('已悔棋，轮到 ' + cur().name);
  }

  function resign() {
    if (!isHumanTurn()) return;
    var pl = cur();
    confirmBox('确定停手？', pl.name + ' 将不再落子，剩下的 ' + pl.remainingSquares + ' 格会计入扣分。其他玩家继续对局。', '停手').then(function (ok) {
      if (!ok || !isHumanTurn() || cur() !== pl) return;
      Engine.applyAction(game.state, { type: 'resign' });
      resetSelection();
      afterAction();
    });
  }

  /* ---------- 渲染 ---------- */

  var rafId = 0;
  function animate() {
    if (rafId) return;
    rafId = requestAnimationFrame(function tick(now) {
      rafId = 0;
      var more = false;
      if (game.view && !$('game').hidden) {
        if (game.anim && now - game.anim.t0 >= DROP_MS) game.anim = null;
        game.view.draw(now);
        if (game.anim || (game.hint && !REDUCED_MOTION && isHumanTurn())) more = true;
      }
      if (demo.view && !$('setup').hidden) {
        if (demo.anim && now - demo.anim.t0 >= DROP_MS) demo.anim = null;
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
  }

  function renderGame() {
    if (!game.state) return;
    renderTurn();
    renderPlayers();
    renderDock();
    drawBoard();
  }

  function renderTurn() {
    var st = game.state;
    var root = $('game');
    var text, color;
    if (st.over) {
      text = '对局结束';
      color = 'var(--ink)';
    } else {
      var pl = cur();
      color = colorVar(pl);
      if (pl.type === 'human') text = humanCount() > 1 ? '轮到 ' + pl.name + '（' + pl.label + '方）' : '轮到你了（' + pl.label + '方）';
      else text = pl.name + (game.paused ? ' · 已暂停' : ' 思考中…');
    }
    root.style.setProperty('--turn', color);
    $('turn-text').textContent = text;
    var placed = st.actions.filter(function (a) { return a.type === 'place'; }).length;
    $('turn-move').textContent = st.over ? '共 ' + placed + ' 手' : '第 ' + (placed + 1) + ' 手';

    var hasHuman = humanCount() > 0;
    var canUndo = st.actions.some(function (a) { return st.players[a.player].type === 'human'; });
    $('undo-btn').disabled = !canUndo;
    $('undo-btn').hidden = !hasHuman;
    $('hint-btn').hidden = !hasHuman;
    $('hint-btn').disabled = !isHumanTurn();
    $('pause-btn').hidden = hasHuman || st.over;
    $('pause-btn').textContent = game.paused ? '继续' : '暂停';
    $('sound-btn').setAttribute('aria-pressed', prefs.sound ? 'true' : 'false');
  }

  function renderPlayers() {
    var st = game.state;
    var box = $('players');
    box.innerHTML = st.players.map(function (pl, p) {
      var current = !st.over && p === st.current;
      var stateText;
      if (pl.resigned) stateText = '已停手';
      else if (pl.done) stateText = st.over ? '' : '无处可放';
      else if (current) stateText = pl.type === 'human' ? '正在落子' : (game.paused ? '已暂停' : '<span class="thinking">思考中</span>');
      else stateText = '剩 ' + pl.remaining.filter(Boolean).length + ' 块';
      var score = Engine.scoreOf(pl);
      var placed = Engine.TOTAL_SQUARES - pl.remainingSquares;
      var kind = pl.type === 'human' ? '玩家' : '电脑 · ' + LEVEL_LABEL[pl.level];
      return '<div class="pcard' + (current ? ' current' : '') + (pl.done ? ' done' : '') + '" style="--c:' + colorVar(pl) + '">' +
        '<span class="pcard-swatch" aria-hidden="true"></span>' +
        '<div class="pcard-name">' + escapeHtml(pl.name) + '<small>' + pl.label + '方 · ' + kind + '</small></div>' +
        '<div class="pcard-score" title="当前得分">' + (score > 0 ? '+' : '') + score + '<small>已放 ' + placed + ' 格</small></div>' +
        '<div class="pcard-bar" aria-hidden="true"><i style="--w:' + (placed / Engine.TOTAL_SQUARES * 100).toFixed(1) + '%"></i></div>' +
        '<div class="pcard-state">' + stateText + '</div>' +
        '</div>';
    }).join('');
  }

  function buildTray() {
    var tray = $('tray');
    tray.innerHTML = '';
    TRAY_ORDER.forEach(function (pi) {
      var piece = PIECES[pi];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'piece-btn';
      b.id = 'piece-' + piece.id;
      b.dataset.piece = pi;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-label', piece.name + '，' + piece.size + ' 格');
      b.innerHTML = pieceSVG(piece.orients[0].cells, 5);
      b.addEventListener('click', function () { selectPiece(pi); });
      tray.appendChild(b);
    });
  }

  function renderDock() {
    var st = game.state;
    var owner = trayOwner();
    var active = isHumanTurn() && owner === cur();
    var dock = $('dock');
    dock.classList.toggle('inactive', !active);
    dock.style.setProperty('--c', colorVar(owner));
    $('dock-title').textContent = owner.label + '方 · ' + owner.name + (active ? '' : st.over ? '' : owner.type === 'ai' ? '（电脑）' : '（等待中）');
    var left = owner.remaining.filter(Boolean).length;
    $('dock-count').textContent = '剩 ' + left + ' 块 · ' + owner.remainingSquares + ' 格';
    $('tray').querySelectorAll('.piece-btn').forEach(function (b) {
      var pi = +b.dataset.piece;
      var used = !owner.remaining[pi];
      var stuck = active && !used && prefs.hints && game.perPiece && game.perPiece[pi] === 0;
      b.classList.toggle('used', used);
      b.classList.toggle('stuck', !!stuck);
      b.disabled = used || !active;
      b.setAttribute('aria-selected', active && game.sel.piece === pi ? 'true' : 'false');
      b.title = used ? '已放置' : stuck ? PIECES[pi].name + '：当前没有可放的位置' : PIECES[pi].name + '（' + PIECES[pi].size + ' 格）';
    });
    $('resign-btn').hidden = !active;
    renderSelection();
  }

  function renderSelection() {
    var prev = $('sel-preview');
    var active = isHumanTurn();
    var has = active && game.sel.piece >= 0;
    if (has) {
      var o = PIECES[game.sel.piece].orients[currentOrient()];
      prev.innerHTML = pieceSVG(o.cells, 5);
      prev.setAttribute('aria-label', '已选：' + PIECES[game.sel.piece].name);
    } else {
      prev.textContent = active ? '从下方选择棋子' : game.state.over ? '对局结束' : '等待其他玩家';
      prev.removeAttribute('aria-label');
    }
    ['rot-ccw', 'rot-cw', 'flip-btn'].forEach(function (id) { $(id).disabled = !has; });
    updatePlaceButton();
  }

  function updatePlaceButton() {
    var m = isHumanTurn() ? ghostMove() : null;
    var btn = $('place-btn');
    btn.disabled = !m;
  }

  /* ---------- 提示条 ---------- */

  var toastTimer = 0;
  function toast(msg, kind) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    // 重新触发入场动画
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
    return ['end-dialog', 'confirm-dialog', 'rules-dialog'].some(function (id) { return $(id).open; });
  }

  var confirmResolve = null;
  function confirmBox(title, text, yesLabel) {
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

  function showEnd() {
    var st = game.state;
    if (!st.over) return;
    var rows = Engine.standings(st);
    var winners = rows.filter(function (r) { return r.rank === 1; });
    var humans = st.players.filter(function (p) { return p.type === 'human'; });
    var title;
    if (humans.length === 1) {
      var me = rows.filter(function (r) { return r.player.type === 'human'; })[0];
      title = me.rank === 1 ? (winners.length > 1 ? '并列第一！' : '你赢了！') : '你获得第 ' + me.rank + ' 名';
    } else {
      title = winners.length > 1
        ? winners.map(function (r) { return r.player.name; }).join('、') + ' 并列第一'
        : winners[0].player.name + ' 获胜';
    }
    $('end-title').textContent = title;
    $('end-rows').innerHTML = rows.map(function (r) {
      var bonus = r.monoLast ? '全部放完 +15，单格收尾 +5' : r.allPlaced ? '全部放完 +15' : r.player.resigned ? '中途停手' : '';
      return '<tr>' +
        '<td><span class="rank' + (r.rank === 1 ? ' first' : '') + '">' + r.rank + '</span></td>' +
        '<td><span class="who" style="--c:' + colorVar(r.player) + '"><i></i><span>' + escapeHtml(r.player.name) +
        (bonus ? '<span class="bonus">' + bonus + '</span>' : '') + '</span></span></td>' +
        '<td class="num">' + r.placedSquares + '</td>' +
        '<td class="num">' + r.remainingSquares + '</td>' +
        '<td class="num score">' + (r.score > 0 ? '+' : '') + r.score + '</td>' +
        '</tr>';
    }).join('');
    renderGame();
    openDialog('end-dialog');
    sound('win');
  }

  /* ================= 事件绑定 ================= */

  function sameCell(a, b) { return !!a && !!b && a.x === b.x && a.y === b.y; }

  function bindBoard() {
    var canvas = $('board');

    canvas.addEventListener('pointermove', function (e) {
      if (!game.state) return;
      var cell = game.view.cellAt(e.clientX, e.clientY, game.state.size);
      if (e.pointerType === 'mouse') {
        game.hover = cell;
        if (!isHumanTurn() || game.sel.piece < 0 || !cell) return;
        if (game.hintLockCell) {
          if (sameCell(cell, game.hintLockCell)) return;
          game.hintLockCell = null;
        }
        if (sameCell(cell, game.ghost)) return;
        game.ghost = { x: cell.x, y: cell.y };
        clampGhost();
        drawBoard();
      } else if (game.touch && cell) {
        if (!sameCell(cell, game.touch.start)) game.touch.moved = true;
        game.ghost = { x: cell.x, y: cell.y };
        clampGhost();
        drawBoard();
      }
    });

    canvas.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'mouse') game.hover = null;
    });

    canvas.addEventListener('pointerdown', function (e) {
      if (!game.state) return;
      if (e.button === 2) { e.preventDefault(); rotate(1); return; }
      if (e.button === 1) { e.preventDefault(); flip(); return; }
      if (e.button !== 0) return;
      if (!isHumanTurn()) return;
      var cell = game.view.cellAt(e.clientX, e.clientY, game.state.size);
      if (game.sel.piece < 0) {
        toast('先在托盘里选一块棋子');
        return;
      }
      if (!cell) return;
      if (e.pointerType === 'mouse') {
        game.ghost = { x: cell.x, y: cell.y };
        game.hintLockCell = null;
        clampGhost();
        tryPlace();
        return;
      }
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      var prev = game.ghost && game.ghostByTap ? { x: game.ghost.x, y: game.ghost.y } : null;
      game.ghost = { x: cell.x, y: cell.y };
      clampGhost();
      game.touch = { start: cell, prev: prev, moved: false };
      drawBoard();
    });

    canvas.addEventListener('pointerup', function (e) {
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

    canvas.addEventListener('pointercancel', function () { game.touch = null; });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('wheel', function (e) {
      if (!isHumanTurn() || game.sel.piece < 0) return;
      e.preventDefault();
      var now = performance.now();
      if (now - game.lastWheel < 140) return;
      game.lastWheel = now;
      rotate(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
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
      if (key === 'r' || key === 'R') { rotate(e.shiftKey ? -1 : 1); return; }
      if (key === 'e' || key === 'E') { rotate(-1); return; }
      if (key === 'f' || key === 'F') { flip(); return; }
      if (key === 'h' || key === 'H') { giveHint(); return; }
      if (key === 'Escape') {
        if (game.sel.piece >= 0) { game.sel.piece = -1; game.hint = null; renderDock(); drawBoard(); }
        return;
      }
      var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[key] && isHumanTurn() && game.sel.piece >= 0) {
        e.preventDefault();
        if (!game.ghost) game.ghost = defaultGhost();
        else { game.ghost.x += arrows[key][0]; game.ghost.y += arrows[key][1]; }
        game.hintLockCell = null;
        clampGhost();
        drawBoard();
        return;
      }
      var focusOk = document.activeElement === document.body || document.activeElement === $('board');
      if ((key === 'Enter' || key === ' ') && focusOk && isHumanTurn() && game.sel.piece >= 0) {
        e.preventDefault();
        if (!game.ghost) { game.ghost = defaultGhost(); clampGhost(); drawBoard(); }
        else tryPlace();
      }
    });
  }

  function bindUI() {
    $('setup-form').addEventListener('submit', function (e) {
      e.preventDefault();
      unlockAudio();
      var cfg = buildConfig();
      if (!cfg) {
        var err = $('setup-error');
        err.textContent = '至少需要两方参战，请把一个空位改成玩家或电脑。';
        err.hidden = false;
        return;
      }
      startGame(cfg);
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

    $('resume-btn').addEventListener('click', function () {
      unlockAudio();
      var s = loadSaved();
      if (!s) { renderSetup(); return; }
      startGame(s.config, s.actions);
    });

    $('rules-btn').addEventListener('click', function () { openDialog('rules-dialog'); });
    $('rules-close').addEventListener('click', function () { closeDialog('rules-dialog'); });

    $('menu-btn').addEventListener('click', function () {
      saveGame();
      showScreen('setup');
    });
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
    $('place-btn').addEventListener('click', tryPlace);
    $('resign-btn').addEventListener('click', resign);

    $('end-again').addEventListener('click', function () {
      closeDialog('end-dialog');
      startGame(game.config);
    });
    $('end-menu').addEventListener('click', function () {
      closeDialog('end-dialog');
      showScreen('setup');
    });
    $('end-view').addEventListener('click', function () { closeDialog('end-dialog'); });

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

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', onThemeChange);
      else if (mq.addListener) mq.addListener(onThemeChange);
    }
    new MutationObserver(onThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  /* ================= 启动 ================= */

  readPalette();
  bindUI();
  bindBoard();
  bindKeys();
  showScreen('setup');
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { if (demo.view && demo.view.resize()) demo.view.draw(); });
  }
})();
