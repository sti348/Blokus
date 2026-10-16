/*
 * 角斗士棋电脑玩家。
 *   easy   —— 随机落子，偏好大块棋子
 *   normal —— 贪心：棋子大小、新增角点、封堵对手角点、向中心扩张
 *   hard   —— 先用贪心筛选候选，再比较落子后双方的可行步数（机动性）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.BlokusAI = factory(root.BlokusEngine);
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  var PIECES = Engine.PIECES;
  var EMPTY = Engine.EMPTY;

  var LEVELS = {
    easy: { label: '简单' },
    normal: { label: '普通' },
    hard: { label: '困难' }
  };

  function isAnchorAfter(board, size, p, x, y) {
    var i = y * size + x;
    if (board[i] !== EMPTY) return false;
    if (x > 0 && board[i - 1] === p) return false;
    if (x < size - 1 && board[i + 1] === p) return false;
    if (y > 0 && board[i - size] === p) return false;
    if (y < size - 1 && board[i + size] === p) return false;
    return (x > 0 && y > 0 && board[i - size - 1] === p) ||
      (x < size - 1 && y > 0 && board[i - size + 1] === p) ||
      (x > 0 && y < size - 1 && board[i + size - 1] === p) ||
      (x < size - 1 && y < size - 1 && board[i + size + 1] === p);
  }

  // 对局进度：0 = 开局，1 = 终局
  function phaseOf(state, p) {
    return Math.min(1, state.players[p].placed / 12);
  }

  function makeContext(state, p) {
    var size = state.size;
    var forb = Engine.forbiddenMask(state.board, size, p);
    var own = Engine.anchorMask(state.board, size, p, state.players[p], forb);
    var opp = new Uint8Array(size * size);
    state.players.forEach(function (pl, o) {
      if (o === p || pl.done) return;
      var f = Engine.forbiddenMask(state.board, size, o);
      var a = Engine.anchorMask(state.board, size, o, pl, f);
      for (var i = 0; i < a.list.length; i++) opp[a.list[i]]++;
    });
    return { own: own.mark, opp: opp, phase: phaseOf(state, p), center: (size - 1) / 2 };
  }

  // 快速估值：只看棋子附近的局部变化
  function quickScore(state, p, move, ctx, w) {
    var board = state.board, size = state.size;
    var flat = PIECES[move.piece].orients[move.orient].flat;
    var n = flat.length / 2;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var k, x, y;
    var blocked = 0, centerDist = Infinity;
    for (k = 0; k < flat.length; k += 2) {
      x = move.x + flat[k]; y = move.y + flat[k + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      blocked += ctx.opp[y * size + x];
      var d = Math.abs(x - ctx.center) + Math.abs(y - ctx.center);
      if (d < centerDist) centerDist = d;
    }
    minX = Math.max(0, minX - 1); minY = Math.max(0, minY - 1);
    maxX = Math.min(size - 1, maxX + 1); maxY = Math.min(size - 1, maxY + 1);
    var before = 0;
    for (y = minY; y <= maxY; y++) for (x = minX; x <= maxX; x++) before += ctx.own[y * size + x];
    for (k = 0; k < flat.length; k += 2) board[(move.y + flat[k + 1]) * size + move.x + flat[k]] = p;
    var after = 0;
    for (y = minY; y <= maxY; y++) for (x = minX; x <= maxX; x++) if (isAnchorAfter(board, size, p, x, y)) after++;
    for (k = 0; k < flat.length; k += 2) board[(move.y + flat[k + 1]) * size + move.x + flat[k]] = EMPTY;

    var early = 1 - ctx.phase;
    return w.size * n * (1 + early) +
      w.anchors * (after - before) +
      w.block * blocked -
      w.center * early * centerDist;
  }

  // 对某玩家统计：可行步数，以及“仍有位置可放”的棋子格数
  function mobility(state, o) {
    var count = 0;
    var placeable = new Uint8Array(PIECES.length);
    Engine.forEachMove(state, o, function (piece) {
      count++;
      placeable[piece] = 1;
    });
    var squares = 0;
    for (var i = 0; i < placeable.length; i++) if (placeable[i]) squares += PIECES[i].size;
    return { count: count, squares: squares };
  }

  function withMove(state, p, move, fn) {
    var board = state.board, size = state.size, pl = state.players[p];
    var flat = PIECES[move.piece].orients[move.orient].flat;
    var k;
    for (k = 0; k < flat.length; k += 2) board[(move.y + flat[k + 1]) * size + move.x + flat[k]] = p;
    pl.remaining[move.piece] = false;
    pl.placed++;
    try {
      return fn();
    } finally {
      pl.placed--;
      pl.remaining[move.piece] = true;
      for (k = 0; k < flat.length; k += 2) board[(move.y + flat[k + 1]) * size + move.x + flat[k]] = EMPTY;
    }
  }

  function deepScore(state, p, move, w) {
    var size = PIECES[move.piece].size;
    return withMove(state, p, move, function () {
      var mine = mobility(state, p);
      var oppCount = 0, oppSquares = 0, opponents = 0;
      state.players.forEach(function (pl, o) {
        if (o === p || pl.done) return;
        var m = mobility(state, o);
        oppCount += Math.log(1 + m.count);
        oppSquares += m.squares;
        opponents++;
      });
      // 对手越少，压制单个对手的收益越大（双人对局是零和的）
      var press = opponents ? 3 / opponents : 0;
      return w.size * size +
        w.mob * Math.log(1 + mine.count) +
        w.reach * mine.squares -
        press * (w.oppMob * oppCount + w.oppReach * oppSquares);
    });
  }

  var NORMAL_W = { size: 3, anchors: 1.2, block: 1.0, center: 0.35 };
  var HARD_QUICK_W = { size: 3, anchors: 1.4, block: 1.2, center: 0.4 };
  var HARD_DEEP_W = { size: 3.4, mob: 3.5, reach: 0.9, oppMob: 1.2, oppReach: 0.25 };

  function pickWeighted(items, weights, rng) {
    var total = 0;
    for (var i = 0; i < weights.length; i++) total += weights[i];
    var r = rng() * total;
    for (i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  function chooseEasy(state, p, moves, rng) {
    var weights = moves.map(function (m) { return Math.pow(PIECES[m.piece].size, 2); });
    return pickWeighted(moves, weights, rng);
  }

  function chooseNormal(state, p, moves, rng) {
    var ctx = makeContext(state, p);
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var s = quickScore(state, p, moves[i], ctx, NORMAL_W) + rng() * 1.5;
      if (s > bestScore) { bestScore = s; best = moves[i]; }
    }
    return best;
  }

  function chooseHard(state, p, moves, rng, opts) {
    var ctx = makeContext(state, p);
    var scored = moves.map(function (m) {
      return { move: m, quick: quickScore(state, p, m, ctx, HARD_QUICK_W) };
    });
    scored.sort(function (a, b) { return b.quick - a.quick; });
    var limit = (opts && opts.candidates) || 28;
    var top = scored.slice(0, limit);
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < top.length; i++) {
      var s = deepScore(state, p, top[i].move, HARD_DEEP_W) + top[i].quick * 0.05 + rng() * 0.05;
      if (s > bestScore) { bestScore = s; best = top[i].move; }
    }
    return best;
  }

  /**
   * 为当前玩家选择一步棋。无合法落子时返回 null。
   * opts.rng 可替换随机数源（用于测试）。
   */
  function chooseMove(state, level, opts) {
    opts = opts || {};
    var rng = opts.rng || Math.random;
    var p = state.current;
    var moves = Engine.legalMoves(state, p);
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];
    if (level === 'easy') return chooseEasy(state, p, moves, rng);
    if (level === 'normal') return chooseNormal(state, p, moves, rng);
    return chooseHard(state, p, moves, rng, opts);
  }

  return {
    LEVELS: LEVELS,
    chooseMove: chooseMove,
    // 暴露给调参脚本
    _weights: { NORMAL_W: NORMAL_W, HARD_QUICK_W: HARD_QUICK_W, HARD_DEEP_W: HARD_DEEP_W }
  };
});
