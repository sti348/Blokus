/*
 * 角斗士棋（Blokus）规则引擎：棋盘状态、落子合法性、走法生成、轮转与计分。
 * 不依赖 DOM，可在浏览器和 Node 中运行。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pieces.js'));
  else root.BlokusEngine = factory(root.BlokusPieces);
})(typeof self !== 'undefined' ? self : this, function (Pieces) {
  'use strict';

  var PIECES = Pieces.PIECES;
  var PIECE_COUNT = Pieces.PIECE_COUNT;
  var TOTAL_SQUARES = Pieces.TOTAL_SQUARES;
  var EMPTY = -1;

  var MODES = {
    // 标准盘：四个角按顺时针分配，固定按 蓝 → 黄 → 红 → 绿 行棋
    classic: {
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
      size: 14,
      seats: [
        { color: 'violet', label: '紫', start: [4, 4] },
        { color: 'orange', label: '橙', start: [9, 9] }
      ]
    }
  };

  /**
   * config: { size, players: [{ start: [x, y], ...任意附加信息 }] }
   * 玩家数组顺序即行棋顺序。
   */
  function createGame(config) {
    var size = config.size;
    var board = new Int8Array(size * size);
    board.fill(EMPTY);
    var state = {
      size: size,
      board: board,
      players: config.players.map(function (p, i) {
        var pl = {};
        for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) pl[k] = p[k];
        pl.index = i;
        pl.start = [p.start[0], p.start[1]];
        pl.remaining = [];
        for (var j = 0; j < PIECE_COUNT; j++) pl.remaining.push(true);
        pl.remainingSquares = TOTAL_SQUARES;
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

  function placementCells(pieceIndex, orient, x, y) {
    var flat = PIECES[pieceIndex].orients[orient].flat;
    var out = [];
    for (var k = 0; k < flat.length; k += 2) out.push([x + flat[k], y + flat[k + 1]]);
    return out;
  }

  // 1 表示玩家 p 不能占用：已有棋子，或与 p 的棋子边相邻
  function forbiddenMask(board, size, p) {
    var n = size * size;
    var forb = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var v = board[i];
      if (v !== EMPTY) {
        forb[i] = 1;
        if (v === p) {
          var x = i % size;
          if (x > 0) forb[i - 1] = 1;
          if (x < size - 1) forb[i + 1] = 1;
          if (i >= size) forb[i - size] = 1;
          if (i < n - size) forb[i + size] = 1;
        }
      }
    }
    return forb;
  }

  // 角点：玩家 p 下一块棋子必须覆盖其中之一
  function anchorMask(board, size, p, player, forb) {
    var n = size * size;
    var mark = new Uint8Array(n);
    var list = [];
    if (player.placed === 0) {
      var s = player.start[1] * size + player.start[0];
      if (board[s] === EMPTY) {
        mark[s] = 1;
        list.push(s);
      }
      return { mark: mark, list: list };
    }
    for (var i = 0; i < n; i++) {
      if (forb[i]) continue;
      var x = i % size, y = (i - x) / size;
      var ok = false;
      if (x > 0 && y > 0 && board[i - size - 1] === p) ok = true;
      else if (x < size - 1 && y > 0 && board[i - size + 1] === p) ok = true;
      else if (x > 0 && y < size - 1 && board[i + size - 1] === p) ok = true;
      else if (x < size - 1 && y < size - 1 && board[i + size + 1] === p) ok = true;
      if (ok) {
        mark[i] = 1;
        list.push(i);
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
    var board = state.board, size = state.size;
    var player = state.players[p];
    var forb = forbiddenMask(board, size, p);
    var anchors = anchorMask(board, size, p, player, forb);
    var mark = anchors.mark, list = anchors.list;
    if (!list.length) return;
    var remaining = pieceFilter || player.remaining;
    for (var pi = 0; pi < PIECE_COUNT; pi++) {
      if (!remaining[pi] || !player.remaining[pi]) continue;
      var orients = PIECES[pi].orients;
      for (var oi = 0; oi < orients.length; oi++) {
        var flat = orients[oi].flat;
        var len = flat.length;
        for (var a = 0; a < list.length; a++) {
          var ai = list[a];
          var ax = ai % size, ay = (ai - ax) / size;
          for (var c = 0; c < len; c += 2) {
            var ox = ax - flat[c], oy = ay - flat[c + 1];
            var ok = true;
            for (var k = 0; k < len; k += 2) {
              var x = ox + flat[k], y = oy + flat[k + 1];
              if (x < 0 || y < 0 || x >= size || y >= size) { ok = false; break; }
              var idx = y * size + x;
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
    forEachMove(state, p, function (piece, orient, x, y) {
      moves.push({ piece: piece, orient: orient, x: x, y: y });
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
    var counts = new Array(PIECE_COUNT).fill(0);
    forEachMove(state, p, function (piece) { counts[piece]++; });
    return counts;
  }

  /**
   * 检查落子，合法返回 null，否则返回原因代码：
   * used / bounds / occupied / edge / start / corner
   */
  function checkPlacement(state, p, pieceIndex, orient, x, y) {
    var player = state.players[p];
    if (!player || player.done || !player.remaining[pieceIndex]) return 'used';
    var board = state.board, size = state.size;
    var cells = placementCells(pieceIndex, orient, x, y);
    var i, cx, cy;
    for (i = 0; i < cells.length; i++) {
      cx = cells[i][0]; cy = cells[i][1];
      if (cx < 0 || cy < 0 || cx >= size || cy >= size) return 'bounds';
    }
    for (i = 0; i < cells.length; i++) {
      if (board[cells[i][1] * size + cells[i][0]] !== EMPTY) return 'occupied';
    }
    var at = function (xx, yy) {
      return xx >= 0 && yy >= 0 && xx < size && yy < size ? board[yy * size + xx] : EMPTY;
    };
    for (i = 0; i < cells.length; i++) {
      cx = cells[i][0]; cy = cells[i][1];
      if (at(cx - 1, cy) === p || at(cx + 1, cy) === p || at(cx, cy - 1) === p || at(cx, cy + 1) === p) return 'edge';
    }
    if (player.placed === 0) {
      for (i = 0; i < cells.length; i++) {
        if (cells[i][0] === player.start[0] && cells[i][1] === player.start[1]) return null;
      }
      return 'start';
    }
    for (i = 0; i < cells.length; i++) {
      cx = cells[i][0]; cy = cells[i][1];
      if (at(cx - 1, cy - 1) === p || at(cx + 1, cy - 1) === p || at(cx - 1, cy + 1) === p || at(cx + 1, cy + 1) === p) return null;
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
    var reason = checkPlacement(state, p, action.piece, action.orient, action.x, action.y);
    if (reason) return reason;
    var cells = placementCells(action.piece, action.orient, action.x, action.y);
    for (var i = 0; i < cells.length; i++) state.board[cells[i][1] * state.size + cells[i][0]] = p;
    player.remaining[action.piece] = false;
    player.remainingSquares -= PIECES[action.piece].size;
    player.placed++;
    player.lastPiece = action.piece;
    var record = { type: 'place', player: p, piece: action.piece, orient: action.orient, x: action.x, y: action.y };
    state.actions.push(record);
    state.lastMove = { player: p, piece: action.piece, cells: cells };
    advance(state);
    return null;
  }

  // 从头重放动作序列（用于悔棋、读档）
  function replay(config, actions) {
    var state = createGame(config);
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (state.over || a.player !== state.current) break;
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
    var rows = state.players.map(function (pl) {
      return {
        index: pl.index,
        player: pl,
        score: scoreOf(pl),
        placedSquares: TOTAL_SQUARES - pl.remainingSquares,
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
    MODES: MODES,
    PIECES: PIECES,
    TOTAL_SQUARES: TOTAL_SQUARES,
    createGame: createGame,
    placementCells: placementCells,
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
