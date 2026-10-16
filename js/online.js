/*
 * 角斗士棋联机房间逻辑（服务器与浏览器共用）。
 *
 * 房间是一个 JSON 文档；所有改动都通过 applyOp(room, op, actor, ctx) 产生新文档，
 * 由它统一校验权限与棋步。对局只保存配置和动作序列，各端用规则引擎重放得到局面。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.BlokusOnline = factory(root.BlokusEngine);
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
  var KINDS = ['open', 'ai', 'off'];
  var LEVELS = ['easy', 'normal', 'hard', 'expert', 'llm'];
  var SPEEDS = ['fast', 'normal', 'slow'];
  var SYSTEM = '~system';

  function makeCode(rng) {
    rng = rng || Math.random;
    var s = '';
    for (var i = 0; i < 5; i++) s += CODE_CHARS.charAt(Math.floor(rng() * CODE_CHARS.length));
    return s;
  }

  function normalizeCode(s) {
    var c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return CODE_RE.test(c) ? c : null;
  }

  // 去掉控制字符和不可见字符，限制长度
  function cleanName(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
      .trim()
      .slice(0, 12);
  }

  // 电脑（大模型）落子时附带的一句话
  function cleanNote(s) {
    return typeof s !== 'string' ? '' : s
      .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
  }

  // 大模型座位用的模型配置名（只是名字，配置本身留在房主的设备上）
  function cleanModel(s) {
    return cleanNote(s).slice(0, 16);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function defaultSeats(mode) {
    return Engine.MODES[mode].seats.map(function (s, i) {
      return { kind: i < 2 ? 'open' : 'ai', level: 'normal', owner: null, name: '' };
    });
  }

  function createRoom(opts) {
    var mode = Engine.isMode(opts.mode) ? opts.mode : 'classic';
    var now = opts.now || Date.now();
    var room = {
      v: 1,
      code: opts.code,
      host: opts.host,
      status: 'lobby',
      mode: mode,
      speed: 'normal',
      seats: defaultSeats(mode),
      game: null,
      rev: 1,
      createdAt: now,
      updatedAt: now
    };
    room.seats[0].owner = opts.host;
    room.seats[0].name = cleanName(opts.name) || '房主';
    return room;
  }

  function idOrNull(v) { return typeof v === 'string' && v.length > 0 && v.length <= 80 ? v : null; }

  // 校验来自存储的文档（内容不可信）：只保留认识的字段，对局配置按座位重新生成；不合格返回 null
  function normalizeRoom(raw) {
    if (!raw || typeof raw !== 'object' || raw.v !== 1) return null;
    if (!Engine.isMode(raw.mode) || !Array.isArray(raw.seats)) return null;
    var M = Engine.MODES[raw.mode];
    if (raw.seats.length !== M.seats.length) return null;
    if (['lobby', 'playing', 'over'].indexOf(raw.status) < 0) return null;
    var host = idOrNull(raw.host);
    if (!host) return null;
    var seats = [];
    for (var i = 0; i < raw.seats.length; i++) {
      var s = raw.seats[i];
      if (!s || KINDS.indexOf(s.kind) < 0 || LEVELS.indexOf(s.level) < 0) return null;
      var seatRec = { kind: s.kind, level: s.level, owner: idOrNull(s.owner), name: cleanName(s.name) };
      if (cleanModel(s.model)) seatRec.model = cleanModel(s.model);
      seats.push(seatRec);
    }
    var game = null;
    if (raw.status !== 'lobby') {
      var g = raw.game;
      if (!g || !g.config || !Array.isArray(g.config.players) || !Array.isArray(g.actions)) return null;
      var ps = g.config.players;
      if (ps.length < 2 || ps.length > M.seats.length || g.actions.length > 400) return null;
      var entries = [];
      for (var j = 0; j < ps.length; j++) {
        var p = ps[j] || {};
        if (!Number.isInteger(p.seat) || p.seat < 0 || p.seat >= M.seats.length) return null;
        if (j > 0 && p.seat <= entries[j - 1].seat) return null;
        entries.push({
          seat: p.seat,
          name: cleanName(p.name) || '玩家',
          type: p.type === 'ai' ? 'ai' : 'human',
          level: LEVELS.indexOf(p.level) >= 0 ? p.level : 'normal',
          owner: idOrNull(p.owner),
          model: cleanModel(p.model)
        });
      }
      game = {
        id: String(g.id || '').slice(0, 40),
        config: Engine.buildConfig(raw.mode, entries),
        actions: g.actions.map(function (a) {
          a = a || {};
          if (a.type === 'resign') return { type: 'resign', player: a.player };
          var rec = { type: 'place', player: a.player, piece: a.piece, orient: a.orient, x: a.x, y: a.y };
          if (a.z !== undefined) rec.z = a.z;
          var note = cleanNote(a.note);
          if (note) rec.note = note;
          return rec;
        })
      };
    }
    return {
      v: 1,
      code: String(raw.code || '').slice(0, 8),
      host: host,
      status: raw.status,
      mode: raw.mode,
      speed: SPEEDS.indexOf(raw.speed) >= 0 ? raw.speed : 'normal',
      seats: seats,
      game: game,
      rev: Number.isInteger(raw.rev) ? raw.rev : 0,
      createdAt: Number(raw.createdAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0
    };
  }

  function gameState(room) {
    return Engine.replay(room.game.config, room.game.actions);
  }

  function seatOwners(room) {
    var out = [];
    room.seats.forEach(function (s) { if (s.owner && out.indexOf(s.owner) < 0) out.push(s.owner); });
    if (room.game) {
      room.game.config.players.forEach(function (p) { if (p.owner && out.indexOf(p.owner) < 0) out.push(p.owner); });
    }
    return out;
  }

  function isOnline(ctx, id) {
    return !ctx.online || ctx.online.indexOf(id) >= 0;
  }

  // 谁来替电脑落子：房主在线时是房主，否则是在线玩家中 id 最小的
  function aiRunner(room, online) {
    if (!online || online.indexOf(room.host) >= 0) return room.host;
    var cands = seatOwners(room).filter(function (id) { return online.indexOf(id) >= 0; }).sort();
    return cands[0] || null;
  }

  function fail(code, message) { return { error: message, code: code }; }

  function intOr(v, d) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v ? v : d; }

  /**
   * actor：发起者 id；ctx：{ now, online: 在线 id 数组或 null, system: 服务器自己落子, allowClientAI }
   * 成功返回 { room }，失败返回 { error, code }。
   */
  function applyOp(room, op, actor, ctx) {
    ctx = ctx || {};
    if (!op || typeof op.type !== 'string') return fail('bad_op', '无法识别的操作');
    var r = clone(room);
    var isHost = actor === r.host;
    var seat = typeof op.seat === 'number' ? r.seats[op.seat] : null;
    var M = Engine.MODES[r.mode];

    switch (op.type) {
      case 'claim': {
        if (r.status !== 'lobby') return fail('not_lobby', '对局已经开始');
        if (!seat) return fail('bad_seat', '没有这个座位');
        if (seat.kind !== 'open') return fail('seat_closed', '这个座位不是玩家座位');
        if (seat.owner && seat.owner !== actor) return fail('seat_taken', '这个座位已经有人了');
        seat.owner = actor;
        seat.name = cleanName(op.name) || '玩家';
        break;
      }
      case 'release': {
        if (r.status !== 'lobby') return fail('not_lobby', '对局已经开始');
        if (!seat || seat.owner !== actor) return fail('not_owner', '这不是你的座位');
        seat.owner = null;
        seat.name = '';
        break;
      }
      case 'rename': {
        var nm = cleanName(op.name);
        if (!nm) return fail('bad_name', '名字不能为空');
        var changed = false;
        r.seats.forEach(function (s) { if (s.owner === actor) { s.name = nm; changed = true; } });
        if (!changed) return fail('not_seated', '你还没有入座');
        break;
      }
      case 'leave': {
        if (r.status === 'lobby') {
          r.seats.forEach(function (s) { if (s.owner === actor) { s.owner = null; s.name = ''; } });
        }
        if (isHost) {
          var others = seatOwners(r).filter(function (id) { return id !== actor && isOnline(ctx, id); });
          if (others.length) r.host = others.sort()[0];
        }
        break;
      }
      case 'host': {
        if (isHost) return fail('noop', '你已经是房主');
        if (!ctx.online || ctx.online.indexOf(r.host) >= 0) return fail('host_online', '房主仍在线');
        if (seatOwners(r).indexOf(actor) < 0) return fail('not_seated', '只有玩家可以接任房主');
        r.host = actor;
        break;
      }
      case 'seat': {
        if (!isHost) return fail('not_host', '只有房主可以修改座位');
        if (r.status !== 'lobby') return fail('not_lobby', '对局已经开始');
        if (!seat) return fail('bad_seat', '没有这个座位');
        if (op.kind !== undefined) {
          if (KINDS.indexOf(op.kind) < 0) return fail('bad_kind', '无效的座位类型');
          if (op.kind === 'off' && r.mode === 'duo') return fail('bad_kind', '双人棋盘不能空位');
          if (op.kind !== 'open') { seat.owner = null; seat.name = ''; }
          seat.kind = op.kind;
        }
        if (op.level !== undefined) {
          if (LEVELS.indexOf(op.level) < 0) return fail('bad_level', '无效的难度');
          seat.level = op.level;
        }
        if (op.model !== undefined) {
          var model = cleanModel(op.model);
          if (model) seat.model = model;
          else delete seat.model;
        }
        break;
      }
      case 'mode': {
        if (!isHost) return fail('not_host', '只有房主可以换棋盘');
        if (r.status !== 'lobby') return fail('not_lobby', '对局已经开始');
        if (!Engine.isMode(op.mode)) return fail('bad_mode', '没有这种棋盘');
        if (op.mode === r.mode) break;
        var seated = r.seats.filter(function (s) { return s.owner; });
        r.mode = op.mode;
        M = Engine.MODES[op.mode];
        r.seats = defaultSeats(op.mode);
        // 已入座的人按顺序坐进新棋盘的座位，坐不下的变成观众
        seated.forEach(function (s, i) {
          if (i < r.seats.length) {
            r.seats[i].kind = 'open';
            r.seats[i].owner = s.owner;
            r.seats[i].name = s.name;
          }
        });
        break;
      }
      case 'speed': {
        if (!isHost) return fail('not_host', '只有房主可以调整');
        if (SPEEDS.indexOf(op.speed) < 0) return fail('bad_speed', '无效的速度');
        r.speed = op.speed;
        break;
      }
      case 'start': {
        if (!isHost) return fail('not_host', '只有房主可以开始');
        if (r.status !== 'lobby') return fail('not_lobby', '对局已经开始');
        var active = [];
        for (var i = 0; i < r.seats.length; i++) {
          var s = r.seats[i];
          if (s.kind === 'off') continue;
          if (s.kind === 'open' && !s.owner) return fail('seat_empty', '还有空着的玩家座位：等人入座，或改成电脑 / 空位');
          active.push({
            seat: i,
            name: s.kind === 'ai' ? M.seats[i].label + '方电脑' : (s.name || '玩家'),
            type: s.kind === 'ai' ? 'ai' : 'human',
            level: s.level,
            owner: s.kind === 'ai' ? null : s.owner,
            model: s.kind === 'ai' && s.level === 'llm' ? s.model || '' : ''
          });
        }
        if (active.length < 2) return fail('too_few', '至少需要两方参战');
        if (!Engine.validCount(r.mode, active.length)) return fail('bad_count', '宝石阵需要 3、4 或 6 方参战（两人对战时每人各执两色）');
        r.game = {
          id: (ctx.now || Date.now()).toString(36) + Math.floor(Math.random() * 1e6).toString(36),
          config: Engine.buildConfig(r.mode, active),
          actions: []
        };
        r.status = 'playing';
        if (gameState(r).over) r.status = 'over';
        break;
      }
      case 'act': {
        if (r.status !== 'playing' || !r.game) return fail('not_playing', '对局不在进行中');
        if (op.at !== r.game.actions.length) return fail('stale', '局面已更新，请重试');
        var st = gameState(r);
        if (st.actions.length !== r.game.actions.length) return fail('corrupt', '对局记录损坏');
        if (st.over) return fail('over', '对局已经结束');
        var who = r.game.config.players[st.current];
        if (who.type === 'ai') {
          // 大模型电脑由房主（或接替的在线玩家）的浏览器调用模型后代为落子
          var runner = who.level === 'llm' && actor === aiRunner(r, ctx.online || null);
          if (!ctx.system && !ctx.allowClientAI && !runner) return fail('not_your_turn', '还没轮到你');
        } else if (who.owner !== actor) {
          return fail('not_your_turn', '还没轮到你');
        }
        var a = op.action || {};
        var action;
        if (a.type === 'resign') action = { type: 'resign' };
        else if (a.type === 'place') {
          action = { type: 'place', piece: intOr(a.piece, -1), orient: intOr(a.orient, -1), x: intOr(a.x, -999), y: intOr(a.y, -999) };
          if (st.topo.dims === 3) action.z = intOr(a.z, -999);
        } else return fail('bad_action', '无效的棋步');
        var reason = Engine.applyAction(st, action);
        if (reason) return fail('illegal', '这步棋不合规则（' + reason + '）');
        var record = st.actions[st.actions.length - 1];
        var note = who.type === 'ai' && record.type === 'place' ? cleanNote(op.note) : '';
        if (note) record.note = note;
        r.game.actions.push(record);
        if (st.over) r.status = 'over';
        break;
      }
      case 'takeover': {
        // 把掉线玩家（或自己）的座位交给电脑
        if (r.status !== 'playing' || !r.game) return fail('not_playing', '对局不在进行中');
        var pl = r.game.config.players[op.player];
        if (!pl || pl.type !== 'human') return fail('bad_player', '没有这位玩家');
        var self = pl.owner === actor;
        if (!self) {
          if (!isHost) return fail('not_host', '只有房主可以托管其他玩家');
          if (!ctx.online || ctx.online.indexOf(pl.owner) >= 0) return fail('player_online', '这位玩家仍在线');
        }
        pl.type = 'ai';
        pl.level = LEVELS.indexOf(op.level) >= 0 ? op.level : 'normal';
        pl.name = cleanName(pl.name + '（托管）');
        break;
      }
      case 'rematch': {
        if (!isHost) return fail('not_host', '只有房主可以再开一局');
        if (r.status === 'lobby') return fail('not_playing', '已经在等待开局');
        r.status = 'lobby';
        r.game = null;
        // 离线的人让出座位
        r.seats.forEach(function (s) {
          if (s.owner && !isOnline(ctx, s.owner) && s.owner !== actor) { s.owner = null; s.name = ''; }
        });
        break;
      }
      default:
        return fail('bad_op', '无法识别的操作');
    }
    r.rev = (room.rev || 0) + 1;
    r.updatedAt = ctx.now || Date.now();
    return { room: r };
  }

  return {
    SYSTEM: SYSTEM,
    SPEEDS: SPEEDS,
    LEVELS: LEVELS,
    makeCode: makeCode,
    normalizeCode: normalizeCode,
    cleanName: cleanName,
    cleanNote: cleanNote,
    cleanModel: cleanModel,
    defaultSeats: defaultSeats,
    createRoom: createRoom,
    normalizeRoom: normalizeRoom,
    gameState: gameState,
    seatOwners: seatOwners,
    aiRunner: aiRunner,
    applyOp: applyOp
  };
});
