/*
 * 角斗士棋电脑玩家（方格、三角格通用）。
 *   easy   —— 随机落子，偏好大块棋子
 *   normal —— 贪心：棋子大小、新增角点、封堵对手角点、向中心扩张
 *   hard   —— 先用贪心筛选候选，再比较落子后双方的可行步数（机动性）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.BlokusAI = factory(root.BlokusEngine);
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  var EMPTY = Engine.EMPTY;

  var LEVELS = {
    easy: { label: '简单' },
    normal: { label: '普通' },
    hard: { label: '困难' }
  };

  function isAnchorAfter(board, topo, p, i) {
    if (board[i] !== EMPTY) return false;
    var e = topo.edges[i], k;
    for (k = 0; k < e.length; k++) if (board[e[k]] === p) return false;
    var c = topo.corners[i];
    for (k = 0; k < c.length; k++) if (board[c[k]] === p) return true;
    return false;
  }

  // 对局进度：0 = 开局，1 = 终局
  function phaseOf(state, p) {
    return Math.min(1, state.players[p].placed / (state.set.count * 0.57));
  }

  function makeContext(state, p) {
    var topo = state.topo;
    var forb = Engine.forbiddenMask(state.board, topo, p);
    var own = Engine.anchorMask(state.board, topo, p, state.players[p], forb);
    var opp = new Uint8Array(topo.n);
    state.players.forEach(function (pl, o) {
      if (o === p || pl.done) return;
      var f = Engine.forbiddenMask(state.board, topo, o);
      var a = Engine.anchorMask(state.board, topo, o, pl, f);
      for (var i = 0; i < a.list.length; i++) opp[a.list[i]]++;
    });
    return {
      own: own.mark,
      opp: opp,
      phase: phaseOf(state, p),
      seen: new Uint32Array(topo.n),
      stamp: 0
    };
  }

  function moveIndices(state, move) {
    return Engine.placementIndices(state, move.piece, move.orient, move.x, move.y, move.z);
  }

  // 快速估值：只看棋子附近（边相邻 + 角相邻）的局部变化
  function quickScore(state, p, move, ctx, w) {
    var q = quickParts(state, p, move, ctx);
    var early = 1 - ctx.phase;
    return w.size * q.size * (1 + early) +
      w.anchors * q.anchors +
      w.block * q.blocked -
      w.center * early * q.centerDist;
  }

  // size：格数；anchors：己方角点净增；blocked：占掉的对手角点；centerDist：离中心最近的距离
  function quickParts(state, p, move, ctx) {
    var board = state.board, topo = state.topo;
    var cells = moveIndices(state, move);
    var n = cells.length;
    var blocked = 0, centerDist = Infinity;
    var region = [];
    var stamp = ++ctx.stamp;
    function add(j) {
      if (ctx.seen[j] !== stamp) {
        ctx.seen[j] = stamp;
        region.push(j);
      }
    }
    var i, k;
    for (i = 0; i < n; i++) {
      var c = cells[i];
      blocked += ctx.opp[c];
      if (topo.centerDist[c] < centerDist) centerDist = topo.centerDist[c];
      add(c);
      var e = topo.edges[c], co = topo.corners[c];
      for (k = 0; k < e.length; k++) add(e[k]);
      for (k = 0; k < co.length; k++) add(co[k]);
    }
    var before = 0;
    for (i = 0; i < region.length; i++) before += ctx.own[region[i]];
    for (i = 0; i < n; i++) board[cells[i]] = p;
    var after = 0;
    for (i = 0; i < region.length; i++) if (isAnchorAfter(board, topo, p, region[i])) after++;
    for (i = 0; i < n; i++) board[cells[i]] = EMPTY;
    return { size: n, anchors: after - before, blocked: blocked, centerDist: centerDist };
  }

  // 对某玩家统计：可行步数，以及“仍有位置可放”的棋子格数
  function mobility(state, o) {
    var pieces = state.set.pieces;
    var count = 0;
    var placeable = new Uint8Array(pieces.length);
    Engine.forEachMove(state, o, function (piece) {
      count++;
      placeable[piece] = 1;
    });
    var squares = 0;
    for (var i = 0; i < placeable.length; i++) if (placeable[i]) squares += pieces[i].size;
    return { count: count, squares: squares };
  }

  function withMove(state, p, move, fn) {
    var board = state.board, pl = state.players[p];
    var cells = moveIndices(state, move);
    var k;
    for (k = 0; k < cells.length; k++) board[cells[k]] = p;
    pl.remaining[move.piece] = false;
    pl.placed++;
    try {
      return fn();
    } finally {
      pl.placed--;
      pl.remaining[move.piece] = true;
      for (k = 0; k < cells.length; k++) board[cells[k]] = EMPTY;
    }
  }

  // 落子后双方的机动性
  function deepParts(state, p, move) {
    return withMove(state, p, move, function () {
      var mine = mobility(state, p);
      var oppLog = 0, oppMoves = 0, oppSquares = 0, opponents = 0;
      state.players.forEach(function (pl, o) {
        if (o === p || pl.done) return;
        var m = mobility(state, o);
        oppLog += Math.log(1 + m.count);
        oppMoves += m.count;
        oppSquares += m.squares;
        opponents++;
      });
      return { mine: mine, oppLog: oppLog, oppMoves: oppMoves, oppSquares: oppSquares, opponents: opponents };
    });
  }

  function deepScore(state, p, move, w, d) {
    var size = state.set.pieces[move.piece].size;
    d = d || deepParts(state, p, move);
    // 对手越少，压制单个对手的收益越大（双人对局是零和的）
    var press = d.opponents ? 3 / d.opponents : 0;
    return w.size * size +
      w.mob * Math.log(1 + d.mine.count) +
      w.reach * d.mine.squares -
      press * (w.oppMob * d.oppLog + w.oppReach * d.oppSquares);
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
    var pieces = state.set.pieces;
    var weights = moves.map(function (m) { return Math.pow(pieces[m.piece].size, 2); });
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
    var limit = (opts && opts.candidates) || (state.topo.kind === 'tri' ? 20 : 28);
    var top = scored.slice(0, limit);
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < top.length; i++) {
      var s = deepScore(state, p, top[i].move, HARD_DEEP_W) + top[i].quick * 0.05 + rng() * 0.05;
      if (s > bestScore) { bestScore = s; best = top[i].move; }
    }
    return best;
  }

  /**
   * 当前玩家最好的若干步（按困难电脑的估值从高到低），附带给人看的特征，供大模型挑选。
   * 每项：{ move, score, size, anchors, blocked, myMoves, mySquares, oppMoves }
   */
  function rankMoves(state, limit) {
    var p = state.current;
    var moves = Engine.legalMoves(state, p);
    if (!moves.length) return [];
    var ctx = makeContext(state, p);
    var early = 1 - ctx.phase;
    var w = HARD_QUICK_W;
    var scored = moves.map(function (m) {
      var q = quickParts(state, p, m, ctx);
      var quick = w.size * q.size * (1 + early) + w.anchors * q.anchors + w.block * q.blocked - w.center * early * q.centerDist;
      return { move: m, quick: quick, q: q };
    });
    scored.sort(function (a, b) { return b.quick - a.quick; });
    var top = scored.slice(0, Math.max(limit || 12, state.topo.kind === 'tri' ? 20 : 28));
    var out = top.map(function (t) {
      var d = deepParts(state, p, t.move);
      return {
        move: t.move,
        score: deepScore(state, p, t.move, HARD_DEEP_W, d) + t.quick * 0.05,
        size: t.q.size,
        anchors: t.q.anchors,
        blocked: t.q.blocked,
        myMoves: d.mine.count,
        mySquares: d.mine.squares,
        oppMoves: d.oppMoves
      };
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, limit || 12);
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
    rankMoves: rankMoves,
    // 暴露给调参脚本
    _weights: { NORMAL_W: NORMAL_W, HARD_QUICK_W: HARD_QUICK_W, HARD_DEEP_W: HARD_DEEP_W }
  };
});
