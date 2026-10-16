'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Pieces = require('../js/pieces.js');
const Engine = require('../js/engine.js');
const AI = require('../js/ai.js');

function seeded(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function config(mode, count) {
  const seats = Engine.MODES[mode].seats;
  const n = count || seats.length;
  return Engine.buildConfig(mode, seats.slice(0, n).map((s, i) => ({ seat: i })));
}

function bruteForceMoves(state, p) {
  const out = [];
  const { cols, rows } = state.topo;
  state.set.pieces.forEach((piece, pi) => {
    piece.orients.forEach((o, oi) => {
      for (let y = -6; y < rows; y++) {
        for (let x = -12; x < cols; x++) {
          if (Engine.checkPlacement(state, p, pi, oi, x, y) === null) out.push(`${pi}/${oi}/${x}/${y}`);
        }
      }
    });
  });
  return out.sort();
}

function playRandomly(state, rng, steps) {
  for (let i = 0; i < steps && !state.over; i++) {
    const moves = Engine.legalMoves(state, state.current);
    const m = moves[Math.floor(rng() * moves.length)];
    assert.equal(Engine.applyAction(state, { type: 'place', ...m }), null);
  }
}

test('方块：21 块棋子共 89 格，91 种朝向', () => {
  const set = Pieces.SETS.square;
  assert.equal(set.count, 21);
  assert.equal(set.total, 89);
  const sizes = [0, 0, 0, 0, 0, 0];
  set.pieces.forEach((p) => sizes[p.size]++);
  assert.deepEqual(sizes.slice(1), [1, 1, 2, 5, 12]);
  assert.equal(set.pieces.reduce((s, p) => s + p.orients.length, 0), 91);
});

test('三角块：22 块棋子共 110 格，155 种朝向', () => {
  const set = Pieces.SETS.tri;
  assert.equal(set.count, 22);
  assert.equal(set.total, 110);
  const sizes = [0, 0, 0, 0, 0, 0, 0];
  set.pieces.forEach((p) => sizes[p.size]++);
  assert.deepEqual(sizes.slice(1), [1, 1, 1, 3, 4, 12]);
  // 固定朝向的多三角形数量：2, 3, 6, 14, 36, 94
  assert.equal(set.pieces.reduce((s, p) => s + p.orients.length, 0), 155);
  assert.equal(set.pieces[Pieces.MONOMINO].size, 1);
  // 平移后尖的朝向不变：每个朝向的格子都必须是连通的三角格
  set.pieces.forEach((p) => p.orients.forEach((o) => {
    const has = new Set(o.cells.map((c) => c.join()));
    const seen = new Set([o.cells[0].join()]);
    const stack = [o.cells[0]];
    while (stack.length) {
      const [x, y] = stack.pop();
      const up = ((x + y) & 1) === 0;
      for (const nb of [[x - 1, y], [x + 1, y], [x, up ? y + 1 : y - 1]]) {
        const k = nb.join();
        if (has.has(k) && !seen.has(k)) { seen.add(k); stack.push(nb); }
      }
    }
    assert.equal(seen.size, o.cells.length, `${p.id} disconnected`);
  }));
});

test('旋转 / 翻转映射覆盖每个朝向', () => {
  for (const set of Object.values(Pieces.SETS)) {
    set.pieces.forEach((p, pi) => {
      const seen = new Set();
      for (let flip = 0; flip < 2; flip++) {
        for (let rot = 0; rot < set.rotations; rot++) seen.add(set.orientFor(pi, rot, flip));
      }
      assert.equal(seen.size, p.orients.length, p.id);
    });
  }
});

test('六边形棋盘：格数与邻接关系', () => {
  for (const side of [7, 8, 9]) {
    const topo = Engine.topologyFor('trigon', side);
    assert.equal(topo.cells.length, 6 * side * side);
    const interior = topo.cells.filter((c) => topo.edges[c].length === 3);
    assert.ok(interior.length > 0);
    interior.forEach((c) => assert.ok(topo.corners[c].length <= 9));
    assert.ok(topo.cells.some((c) => topo.corners[c].length === 9));
    assert.equal(new Set(topo.starts.map((s) => s.join())).size, 6);
    topo.starts.forEach(([x, y]) => assert.equal(topo.valid[y * topo.cols + x], 1));
  }
  const sq = Engine.topologyFor('classic', 20);
  assert.equal(sq.cells.length, 400);
  assert.equal(sq.edges[21].length, 4);
  assert.equal(sq.corners[21].length, 4);
});

test('首块棋子必须覆盖起始角', () => {
  const state = Engine.createGame(config('classic'));
  const I5 = state.set.pieces.findIndex((p) => p.id === 'I5');
  assert.equal(Engine.checkPlacement(state, 0, I5, 0, 1, 0), 'start');
  assert.equal(Engine.checkPlacement(state, 0, I5, 0, 0, 0), null);
  assert.equal(Engine.checkPlacement(state, 0, I5, 0, -1, 0), 'bounds');
});

test('三角块：首块须盖住任一起点，平移须保持尖的朝向', () => {
  const state = Engine.createGame(config('trigon'));
  const [sx, sy] = state.topo.starts[0];
  const mono = Pieces.MONOMINO;
  const set = state.set;
  const oi = set.pieces[mono].orients.findIndex((o) => ((o.cells[0][0] + o.cells[0][1]) & 1) === ((sx + sy) & 1));
  const o = set.pieces[mono].orients[oi].cells[0];
  assert.equal(Engine.checkPlacement(state, 0, mono, oi, sx - o[0], sy - o[1]), null);
  assert.equal(Engine.checkPlacement(state, 0, mono, oi, sx - o[0] + 1, sy - o[1]), 'bounds');
  assert.equal(Engine.checkPlacement(state, 0, mono, oi, sx - o[0] + 2, sy - o[1]), 'start');
});

test('同色只能角接、不能边接；异色可以边接', () => {
  const state = Engine.createGame(config('classic'));
  const I1 = 0, I2 = 1;
  assert.equal(Engine.applyAction(state, { type: 'place', piece: I2, orient: 0, x: 0, y: 0 }), null);
  assert.equal(Engine.applyAction(state, { type: 'place', piece: I1, orient: 0, x: 19, y: 0 }), null);
  assert.equal(Engine.applyAction(state, { type: 'place', piece: I1, orient: 0, x: 19, y: 19 }), null);
  assert.equal(Engine.applyAction(state, { type: 'place', piece: I1, orient: 0, x: 0, y: 19 }), null);
  assert.equal(state.current, 0);
  assert.equal(Engine.checkPlacement(state, 0, I1, 0, 2, 0), 'edge');
  assert.equal(Engine.checkPlacement(state, 0, I1, 0, 3, 3), 'corner');
  assert.equal(Engine.checkPlacement(state, 0, I1, 0, 1, 0), 'occupied');
  assert.equal(Engine.checkPlacement(state, 0, I1, 0, 2, 1), null);
  assert.equal(Engine.checkPlacement(state, 0, I2, 0, 0, 0), 'used');
});

test('走法生成与暴力枚举完全一致（无重复、无遗漏）', () => {
  for (const [mode, count, seed, rounds] of [['classic', 4, 1, 6], ['classic', 3, 2, 5], ['duo', 2, 3, 5], ['trigon', 4, 4, 6], ['trigon', 2, 5, 4]]) {
    const rng = seeded(seed);
    const state = Engine.createGame(config(mode, count));
    for (let round = 0; round < rounds && !state.over; round++) {
      const p = state.current;
      const fast = Engine.legalMoves(state, p).map((m) => `${m.piece}/${m.orient}/${m.x}/${m.y}`).sort();
      assert.equal(new Set(fast).size, fast.length, 'duplicate moves');
      assert.deepEqual(fast, bruteForceMoves(state, p), `${mode} round ${round}`);
      playRandomly(state, rng, 1 + Math.floor(rng() * 5));
    }
  }
});

test('随机对局能正常结束，重放结果一致', () => {
  for (const [mode, count, seed] of [['classic', 4, 11], ['classic', 2, 12], ['duo', 2, 13], ['trigon', 4, 14], ['trigon', 3, 15]]) {
    const cfg = config(mode, count);
    const state = Engine.createGame(cfg);
    playRandomly(state, seeded(seed), 2000);
    assert.ok(state.over);
    assert.ok(state.players.every((pl) => pl.done));
    state.players.forEach((pl, p) => assert.equal(Engine.hasAnyMove(state, p), false));
    const again = Engine.replay(cfg, state.actions);
    assert.deepEqual(Array.from(again.board), Array.from(state.board));
    assert.equal(again.over, true);
    const filled = Array.from(state.board).filter((v) => v >= 0).length;
    const placed = state.players.reduce((s, pl) => s + (state.set.total - pl.remainingSquares), 0);
    assert.equal(filled, placed);
  }
});

test('旧存档（start 字段、无 mode）仍可读取', () => {
  const legacy = { size: 20, players: Engine.MODES.classic.seats.map((s) => ({ color: s.color, start: s.start })) };
  const state = Engine.createGame(legacy);
  assert.equal(state.mode, 'classic');
  assert.equal(Engine.checkPlacement(state, 0, 0, 0, 0, 0), null);
});

test('认输后跳过该玩家，其余玩家继续', () => {
  const state = Engine.createGame(config('classic'));
  assert.equal(Engine.applyAction(state, { type: 'resign' }), null);
  assert.equal(state.current, 1);
  assert.ok(state.players[0].done);
  playRandomly(state, seeded(5), 3);
  assert.notEqual(state.current, 0);
});

test('计分：剩余格子扣分，全部放完 +15，最后放单格再 +5', () => {
  assert.equal(Engine.scoreOf({ remainingSquares: 12, lastPiece: 4 }), -12);
  assert.equal(Engine.scoreOf({ remainingSquares: 0, lastPiece: 4 }), 15);
  assert.equal(Engine.scoreOf({ remainingSquares: 0, lastPiece: Pieces.MONOMINO }), 20);
});

test('排名并列时名次相同', () => {
  const state = Engine.createGame(config('classic'));
  assert.deepEqual(Engine.standings(state).map((r) => r.rank), [1, 1, 1, 1]);
});

test('三档电脑在两种棋盘上都只走合法棋步', () => {
  for (const mode of ['classic', 'trigon']) {
    for (const level of ['easy', 'normal', 'hard']) {
      const state = Engine.createGame(config(mode));
      const rng = seeded(level.length + mode.length);
      let guard = 0;
      while (!state.over && guard++ < 24) {
        const move = AI.chooseMove(state, level, { rng });
        assert.ok(move, 'AI should find a move');
        assert.equal(Engine.applyAction(state, { type: 'place', ...move }), null);
      }
    }
  }
});
