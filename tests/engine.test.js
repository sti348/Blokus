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
  const m = Engine.MODES[mode];
  return {
    size: m.size,
    players: m.seats.slice(0, count || m.seats.length).map((s) => ({ color: s.color, start: s.start }))
  };
}

function bruteForceMoves(state, p) {
  const out = [];
  const n = state.size;
  Pieces.PIECES.forEach((piece, pi) => {
    piece.orients.forEach((o, oi) => {
      for (let y = -4; y < n; y++) {
        for (let x = -4; x < n; x++) {
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

test('21 块棋子共 89 格，91 种朝向', () => {
  assert.equal(Pieces.PIECE_COUNT, 21);
  assert.equal(Pieces.TOTAL_SQUARES, 89);
  const sizes = [0, 0, 0, 0, 0, 0];
  Pieces.PIECES.forEach((p) => sizes[p.size]++);
  assert.deepEqual(sizes.slice(1), [1, 1, 2, 5, 12]);
  const orientCount = Pieces.PIECES.reduce((s, p) => s + p.orients.length, 0);
  assert.equal(orientCount, 91);
});

test('旋转 / 翻转映射覆盖每个朝向', () => {
  Pieces.PIECES.forEach((p, pi) => {
    const seen = new Set();
    for (let flip = 0; flip < 2; flip++) {
      for (let rot = 0; rot < 4; rot++) seen.add(Pieces.orientFor(pi, rot, flip));
    }
    assert.equal(seen.size, p.orients.length, p.id);
  });
});

test('首块棋子必须覆盖起始角', () => {
  const state = Engine.createGame(config('classic'));
  const I5 = Pieces.PIECES.findIndex((p) => p.id === 'I5');
  assert.equal(Engine.checkPlacement(state, 0, I5, 0, 1, 0), 'start');
  assert.equal(Engine.checkPlacement(state, 0, I5, 0, 0, 0), null);
  assert.equal(Engine.checkPlacement(state, 0, I5, 0, -1, 0), 'bounds');
});

test('同色只能角接、不能边接；异色可以边接', () => {
  const state = Engine.createGame(config('classic'));
  const I1 = 0, I2 = 1;
  assert.equal(Engine.applyAction(state, { type: 'place', piece: I2, orient: 0, x: 0, y: 0 }), null); // 蓝 (0,0)-(1,0)
  // 黄、红、绿各自在角上落单格
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
  for (const [mode, count, seed] of [['classic', 4, 1], ['classic', 3, 2], ['duo', 2, 3]]) {
    const rng = seeded(seed);
    const state = Engine.createGame(config(mode, count));
    for (let round = 0; round < 6 && !state.over; round++) {
      const p = state.current;
      const fast = Engine.legalMoves(state, p).map((m) => `${m.piece}/${m.orient}/${m.x}/${m.y}`).sort();
      assert.equal(new Set(fast).size, fast.length, 'duplicate moves');
      assert.deepEqual(fast, bruteForceMoves(state, p), `${mode} round ${round}`);
      playRandomly(state, rng, 1 + Math.floor(rng() * 5));
    }
  }
});

test('随机对局能正常结束，重放结果一致', () => {
  for (const [mode, count, seed] of [['classic', 4, 11], ['classic', 2, 12], ['duo', 2, 13]]) {
    const cfg = config(mode, count);
    const state = Engine.createGame(cfg);
    playRandomly(state, seeded(seed), 1000);
    assert.ok(state.over);
    assert.ok(state.players.every((pl) => pl.done));
    state.players.forEach((pl, p) => assert.equal(Engine.hasAnyMove(state, p), false));
    const again = Engine.replay(cfg, state.actions);
    assert.deepEqual(Array.from(again.board), Array.from(state.board));
    assert.equal(again.over, true);
    const filled = Array.from(state.board).filter((v) => v !== Engine.EMPTY).length;
    const placed = state.players.reduce((s, pl) => s + (89 - pl.remainingSquares), 0);
    assert.equal(filled, placed);
  }
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
  const pl = { remainingSquares: 12, lastPiece: 4 };
  assert.equal(Engine.scoreOf(pl), -12);
  assert.equal(Engine.scoreOf({ remainingSquares: 0, lastPiece: 4 }), 15);
  assert.equal(Engine.scoreOf({ remainingSquares: 0, lastPiece: Pieces.MONOMINO }), 20);
});

test('排名并列时名次相同', () => {
  const state = Engine.createGame(config('classic'));
  const rows = Engine.standings(state);
  assert.deepEqual(rows.map((r) => r.rank), [1, 1, 1, 1]);
});

test('三档电脑都只走合法棋步', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    const state = Engine.createGame(config('classic'));
    const rng = seeded(level.length);
    let guard = 0;
    while (!state.over && guard++ < 30) {
      const move = AI.chooseMove(state, level, { rng });
      assert.ok(move, 'AI should find a move');
      assert.equal(Engine.applyAction(state, { type: 'place', ...move }), null);
    }
  }
});
