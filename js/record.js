/*
 * 对局记录：把一局（座位 + 落子序列）整理成可以保存、导出、导入回放的记录。
 *
 * 记录只保存模式、座位和动作；配置由规则引擎按座位重新生成，动作逐条重放校验，
 * 所以导入的文件即使被改过，也只会在第一步不合法处截断，不会得到非法局面。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./online.js'));
  else root.BlokusRecord = factory(root.BlokusEngine, root.BlokusOnline);
})(typeof self !== 'undefined' ? self : this, function (Engine, Online) {
  'use strict';

  var FORMAT = 'blockturf-record';
  var LEGACY_FORMAT = 'blokus-record';
  var VERSION = 1;
  var MAX_ACTIONS = 600;
  var ID_RE = /^[a-z0-9]{4,24}$/;

  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }

  function newId() {
    return (Date.now().toString(36) + Math.floor(Math.random() * 1e8).toString(36)).slice(0, 24);
  }

  function seatEntry(p) {
    var e = {
      seat: p.seat,
      name: Online.cleanName(p.name) || '玩家',
      type: p.type === 'ai' ? 'ai' : 'human',
      level: Online.LEVELS.indexOf(p.level) >= 0 ? p.level : 'normal'
    };
    var model = Online.cleanModel(p.model);
    if (e.type === 'ai' && e.level === 'llm' && model) e.model = model;
    return e;
  }

  // 一条动作；格式不对时返回 null
  function cleanAction(a) {
    if (!a || typeof a !== 'object' || !isInt(a.player)) return null;
    if (a.type === 'resign') return { type: 'resign', player: a.player };
    if (a.type !== 'place' || !isInt(a.piece) || !isInt(a.orient) || !isInt(a.x) || !isInt(a.y)) return null;
    var rec = { type: 'place', player: a.player, piece: a.piece, orient: a.orient, x: a.x, y: a.y };
    if (a.z !== undefined) {
      if (!isInt(a.z)) return null;
      rec.z = a.z;
    }
    var note = Online.cleanNote(a.note);
    if (note) rec.note = note;
    return rec;
  }

  function configOf(rec) {
    return Engine.buildConfig(rec.mode, rec.players.map(function (p) {
      var e = { seat: p.seat, name: p.name, type: p.type, level: p.level };
      if (p.model) e.model = p.model;
      return e;
    }));
  }

  /**
   * 校验并整理一份记录（来自本机存储或导入的文件）；不是有效记录时返回 null。
   * 动作在第一条格式不对或不合法处截断。
   */
  function parse(raw) {
    if (!raw || typeof raw !== 'object' || (raw.format !== FORMAT && raw.format !== LEGACY_FORMAT)) return null;
    if (!isInt(raw.v) || raw.v < 1 || raw.v > VERSION) return null;
    if (!Engine.isMode(raw.mode)) return null;
    var seats = Engine.MODES[raw.mode].seats;
    if (!Array.isArray(raw.players) || !Engine.validCount(raw.mode, raw.players.length)) return null;
    var players = [];
    for (var i = 0; i < raw.players.length; i++) {
      var p = raw.players[i];
      if (!p || typeof p !== 'object' || !isInt(p.seat) || p.seat < 0 || p.seat >= seats.length) return null;
      if (i > 0 && p.seat <= players[i - 1].seat) return null;
      players.push(seatEntry(p));
    }
    if (!Array.isArray(raw.actions)) return null;
    var actions = [];
    for (var j = 0; j < raw.actions.length && j < MAX_ACTIONS; j++) {
      var a = cleanAction(raw.actions[j]);
      if (!a) break;
      actions.push(a);
    }
    var t = typeof raw.date === 'string' ? Date.parse(raw.date) : NaN;
    var rec = {
      format: FORMAT,
      v: VERSION,
      id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId(),
      date: new Date(isFinite(t) ? t : Date.now()).toISOString(),
      mode: raw.mode,
      online: raw.online === true,
      players: players,
      actions: actions
    };
    var st = Engine.replay(configOf(rec), actions);
    rec.actions = actions.slice(0, st.actions.length);
    return rec;
  }

  // 由正在进行或已结束的一局生成记录
  function fromGame(config, actions, opts) {
    opts = opts || {};
    return parse({
      format: FORMAT,
      v: VERSION,
      id: opts.id,
      date: opts.date || new Date().toISOString(),
      mode: config.mode,
      online: !!opts.online,
      players: config.players,
      actions: actions
    });
  }

  // 重放到第 n 步（默认全部）的局面
  function stateAt(rec, n) {
    return Engine.replay(configOf(rec), n == null ? rec.actions : rec.actions.slice(0, n));
  }

  // 列表里显示的摘要
  function summary(rec) {
    var st = stateAt(rec);
    var rows = st.over ? Engine.standings(st) : null;
    return {
      over: st.over,
      moves: st.actions.filter(function (a) { return a.type === 'place'; }).length,
      players: st.players.map(function (pl) { return { name: pl.name, label: pl.label, color: pl.color }; }),
      winners: rows ? rows.filter(function (r) { return r.rank === 1; }).map(function (r) { return r.player.name; }) : []
    };
  }

  // 可读流程用的文字；界面按当前语言传入，不传时用中文
  var ZH_LABELS = {
    app: '角斗士棋',
    seat: function (pl) { return pl.label + '方 · ' + pl.name; },
    piece: function (piece) { return piece.name; },
    blocked: '无处可放',
    stopped: '停手',
    over: '对局结束'
  };

  function labelsOf(labels) {
    var out = {};
    for (var k in ZH_LABELS) if (Object.prototype.hasOwnProperty.call(ZH_LABELS, k)) out[k] = labels && labels[k] ? labels[k] : ZH_LABELS[k];
    return out;
  }

  /**
   * 导出用的完整文件：除了回放要用的座位和动作，还附上可读的下棋流程和结果。
   * 导入时只读 format / v / id / date / mode / online / players / actions。
   */
  function toExport(rec, labels) {
    var L = labelsOf(labels);
    var config = configOf(rec);
    var st = Engine.createGame(config);
    var moves = [];
    var placed = 0;
    var cursor = 0;
    function flushEvents() {
      for (; cursor < st.events.length; cursor++) {
        var ev = st.events[cursor];
        if (ev.type === 'blocked') moves.push({ player: L.seat(st.players[ev.player]), event: L.blocked });
        else if (ev.type === 'resign') moves.push({ player: L.seat(st.players[ev.player]), event: L.stopped });
        else if (ev.type === 'over') moves.push({ event: L.over });
      }
    }
    flushEvents();
    rec.actions.forEach(function (a) {
      if (Engine.applyAction(st, a)) return;
      if (a.type === 'place') {
        placed++;
        var piece = st.set.pieces[a.piece];
        var m = { n: placed, player: L.seat(st.players[a.player]), piece: L.piece(piece), size: piece.size, cells: st.lastMove.cells };
        if (a.note) m.note = a.note;
        moves.push(m);
      }
      flushEvents();
    });
    var out = {
      format: FORMAT,
      v: VERSION,
      app: L.app,
      id: rec.id,
      date: rec.date,
      mode: rec.mode,
      modeName: Engine.MODES[rec.mode].name,
      online: rec.online,
      finished: st.over,
      players: rec.players.map(function (p, i) {
        var o = {};
        for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) o[k] = p[k];
        o.color = config.players[i].label;
        return o;
      }),
      actions: rec.actions,
      moves: moves
    };
    if (st.over) {
      out.result = Engine.standings(st).map(function (r) {
        return { rank: r.rank, player: L.seat(r.player), piecesLeft: r.piecesLeft, cellsLeft: r.remainingSquares };
      });
    }
    return out;
  }

  // 导出文件的文本：顶层字段一行一个，列表（座位、动作、流程、结果）每项一行，方便直接阅读
  function stringify(rec, labels) {
    var obj = toExport(rec, labels);
    var keys = Object.keys(obj);
    var lines = ['{'];
    keys.forEach(function (k, i) {
      var v = obj[k];
      var end = i < keys.length - 1 ? ',' : '';
      if (Array.isArray(v) && v.length) {
        lines.push('  ' + JSON.stringify(k) + ': [');
        v.forEach(function (item, j) { lines.push('    ' + JSON.stringify(item) + (j < v.length - 1 ? ',' : '')); });
        lines.push('  ]' + end);
      } else {
        lines.push('  ' + JSON.stringify(k) + ': ' + JSON.stringify(v) + end);
      }
    });
    lines.push('}');
    return lines.join('\n') + '\n';
  }

  return {
    FORMAT: FORMAT,
    VERSION: VERSION,
    parse: parse,
    fromGame: fromGame,
    configOf: configOf,
    stateAt: stateAt,
    summary: summary,
    toExport: toExport,
    stringify: stringify
  };
});
