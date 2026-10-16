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

function moveKey(m) {
  return m.z === undefined ? `${m.piece}/${m.orient}/${m.x}/${m.y}` : `${m.piece}/${m.orient}/${m.x}/${m.y}/${m.z}`;
}

function bruteForceMoves(state, p) {
  const out = [];
  const { cols, rows, dims, depth } = state.topo;
  state.set.pieces.forEach((piece, pi) => {
    piece.orients.forEach((o, oi) => {
      for (let y = -6; y < rows; y++) {
        for (let x = -12; x < cols; x++) {
          if (dims === 3) {
            for (let z = -2; z < depth; z++) {
              if (Engine.checkPlacement(state, p, pi, oi, x, y, z) === null) out.push(moveKey({ piece: pi, orient: oi, x, y, z }));
            }
          } else if (Engine.checkPlacement(state, p, pi, oi, x, y) === null) out.push(moveKey({ piece: pi, orient: oi, x, y }));
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
  for (const set of [Pieces.SETS.square, Pieces.SETS.tri]) {
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
  for (const [mode, count, seed, rounds] of [['classic', 4, 1, 6], ['classic', 3, 2, 5], ['duo', 2, 3, 5], ['trigon', 4, 4, 6], ['trigon', 2, 5, 4], ['cube', 4, 6, 9], ['cube', 2, 7, 6], ['prism', 4, 8, 9], ['prism', 3, 9, 6], ['gemblo', 3, 10, 5], ['gemblo', 6, 20, 4]]) {
    const rng = seeded(seed);
    const state = Engine.createGame(config(mode, count));
    for (let round = 0; round < rounds && !state.over; round++) {
      const p = state.current;
      const fast = Engine.legalMoves(state, p).map(moveKey).sort();
      assert.equal(new Set(fast).size, fast.length, 'duplicate moves');
      assert.deepEqual(fast, bruteForceMoves(state, p), `${mode} round ${round}`);
      playRandomly(state, rng, 1 + Math.floor(rng() * 5));
    }
  }
});

test('随机对局能正常结束，重放结果一致', () => {
  for (const [mode, count, seed] of [['classic', 4, 11], ['classic', 2, 12], ['duo', 2, 13], ['trigon', 4, 14], ['trigon', 3, 15], ['cube', 4, 16], ['cube', 2, 17], ['prism', 4, 18], ['prism', 2, 19], ['gemblo', 6, 21], ['gemblo', 4, 22], ['gemblo', 3, 23]]) {
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

test('立体：12 块立方体棋子共 41 格，105 种朝向，转动可达全部朝向', () => {
  const set = Pieces.SETS.cube;
  assert.equal(set.count, 12);
  assert.equal(set.total, 41);
  assert.equal(set.pieces.reduce((s, p) => s + p.orients.length, 0), 105);
  // 一对互为镜像的扭转块是两块不同的棋子
  assert.ok(set.pieces.some((p) => p.name === '左旋') && set.pieces.some((p) => p.name === '右旋'));
  set.pieces.forEach((p, pi) => {
    const seen = new Set([p.display]);
    const queue = [p.display];
    while (queue.length) {
      const o = queue.pop();
      for (let a = 0; a < 3; a++) for (const d of [1, -1]) {
        const n = set.turn(pi, o, a, d);
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    assert.equal(seen.size, p.orients.length, p.name);
  });
});

test('立体：棋子竖直落下，不能悬空、不能超过限高、不能和自己面贴面', () => {
  const state = Engine.createGame(config('cube'));
  const topo = state.topo;
  assert.equal(topo.n, 7 * 7 * 5);
  const ii = state.set.pieces.findIndex((p) => p.name === '二连');
  const flat = state.set.pieces[ii].orients.findIndex((o) => o.w === 2);
  const tall = state.set.pieces[ii].orients.findIndex((o) => o.h === 2);
  assert.equal(Engine.checkPlacement(state, 0, ii, flat, 0, 1, 0), 'float');
  assert.equal(Engine.checkPlacement(state, 0, ii, flat, 1, 0, 0), 'start');
  assert.equal(Engine.applyAction(state, { type: 'place', piece: ii, orient: flat, x: 0, y: 0, z: 0 }), null);
  assert.equal(state.actions[0].z, 0);
  // 其余三方各在自己的角落一块单块
  const mono = 0;
  for (const [x, z] of [[6, 0], [6, 6], [0, 6]]) {
    assert.equal(Engine.applyAction(state, { type: 'place', piece: mono, orient: 0, x, y: 0, z }), null);
  }
  // 叠在自己的棋子正上方 = 面贴面
  assert.equal(Engine.dropY(state, mono, 0, 0, 0), 1);
  assert.equal(Engine.checkPlacement(state, 0, mono, 0, 0, 1, 0), 'edge');
  // 棱相接（斜上方）合法
  assert.equal(Engine.checkPlacement(state, 0, mono, 0, 2, 0, 1), null);
  assert.equal(Engine.checkPlacement(state, 0, mono, 0, 2, 0, 0), 'edge');
  assert.equal(Engine.checkPlacement(state, 0, mono, 0, 4, 0, 4), 'corner');
  // 竖着的二连叠到 4 层后再放就超高
  const tower = Engine.createGame(config('cube'));
  for (let y = 0; y < 4; y++) tower.board[Engine.cellIndex(tower.topo, [3, y, 3])] = 2;
  assert.equal(Engine.dropY(tower, ii, tall, 3, 3), -1);
  assert.equal(Engine.dropY(tower, ii, tall, 3, 3, true), 4);
  assert.equal(Engine.checkPlacement(tower, 0, ii, tall, 3, 4, 3), 'ceiling');
});

test('三棱柱：19 块棋子共 66 格，118 种朝向；面相邻 5 个，转动可达全部朝向', () => {
  const set = Pieces.SETS.prism;
  assert.equal(set.count, 19);
  assert.equal(set.total, 66);
  assert.deepEqual([1, 2, 3, 4].map((n) => set.pieces.filter((p) => p.size === n).length), [1, 2, 3, 13]);
  assert.equal(set.pieces.reduce((s, p) => s + p.orients.length, 0), 118);
  set.pieces.forEach((p, pi) => {
    const seen = new Set([p.display]);
    const queue = [p.display];
    while (queue.length) {
      const o = queue.pop();
      for (const [a, d] of [[1, 1], [1, -1], [0, 1]]) {
        const n = set.turn(pi, o, a, d);
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    assert.equal(seen.size, p.orients.length, p.name);
  });
  const topo = Engine.topologyFor('prism', 4, 4);
  assert.equal(topo.cells.length, 96 * 4);
  assert.equal(config('prism', 3).height, 6);
  assert.equal(config('prism', 3).size, 3);
  topo.cells.forEach((c) => assert.ok(topo.edges[c].length <= 5 && topo.corners[c].length <= 33));
  assert.ok(topo.cells.some((c) => topo.edges[c].length === 5 && topo.corners[c].length === 33));
  // 四个起点在六边形的四个角，各不相同
  assert.equal(new Set(topo.seatStarts.map((s) => s.join())).size, 4);
});

test('三棱柱：落子须保持三角形朝向，不能叠在自己正上方', () => {
  const state = Engine.createGame(config('prism'));
  const [sx, , sz] = state.players[0].starts[0];
  const mono = 0;
  const oi = state.set.pieces[mono].orients.findIndex((o) => ((o.cells[0][0] + o.cells[0][2]) & 1) === ((sx + sz) & 1));
  const o = state.set.pieces[mono].orients[oi].cells[0];
  const x = sx - o[0], z = sz - o[2];
  assert.equal(Engine.checkPlacement(state, 0, mono, oi, x + 1, 0, z), 'bounds');
  assert.equal(Engine.applyAction(state, { type: 'place', piece: mono, orient: oi, x, y: 0, z }), null);
  for (let k = 0; k < 3; k++) Engine.applyAction(state, { type: 'resign' });
  assert.equal(state.current, 0);
  // 双层柱叠在自己的单柱正上方：三角面相贴
  const col = state.set.pieces.findIndex((p) => p.name === '双层柱');
  const coi = state.set.pieces[col].orients.findIndex((o) => ((o.cells[0][0] + o.cells[0][2]) & 1) === ((sx + sz) & 1));
  const c0 = state.set.pieces[col].orients[coi].cells[0];
  assert.equal(Engine.dropY(state, col, coi, sx - c0[0], sz - c0[2]), 1);
  assert.equal(Engine.checkPlacement(state, 0, col, coi, sx - c0[0], 1, sz - c0[2]), 'edge');
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
  for (const mode of ['classic', 'trigon', 'cube', 'prism', 'gemblo']) {
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

/* ---------------- 宝石阵 ---------------- */

function hexCanon(cells) {
  const tf = (c, rot, flip) => Pieces.GEOMETRY.hex.transformCell(c, rot, flip);
  let best = null;
  for (let f = 0; f < 2; f++) for (let r = 0; r < 6; r++) {
    const k = Pieces.GEOMETRY.hex.normalize(cells.map((c) => tf(c, r, f))).map((c) => c.join(',')).join(';');
    if (best === null || k < best) best = k;
  }
  return best;
}

test('宝石阵：每人 18 块共 72 格（单格 1、双格 1、三格 3、四格 5、五格 8），形状互不相同', () => {
  const set = Pieces.SETS.hex;
  assert.equal(set.count, 18);
  assert.equal(set.total, 72);
  const bySize = {};
  set.pieces.forEach((p) => { bySize[p.size] = (bySize[p.size] || 0) + 1; });
  assert.deepEqual(bySize, { 1: 1, 2: 1, 3: 3, 4: 5, 5: 8 });
  const keys = set.pieces.map((p) => hexCanon(p.orients[0].cells));
  assert.equal(new Set(keys).size, 18);
  // 按原版实物照片核对的四格和五格（与摆放方向无关）
  const has = (cells) => keys.includes(hexCanon(cells));
  const expected = {
    直四: [[0, 0], [0, 1], [0, 2], [0, 3]],
    拱形: [[0, 0], [1, 0], [1, 1], [0, 2]],
    波浪: [[0, 0], [1, 0], [1, 1], [2, 1]],
    菱形: [[0, 0], [1, 0], [0, 1], [1, 1]],
    三叉: [[1, 0], [1, 1], [2, 1], [0, 2]],
    直五: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
    台阶: [[0, 0], [1, 0], [2, 0], [2, 1], [3, 1]],
    大拐: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]],
    尖角: [[0, 0], [0, 1], [0, 2], [1, 0], [2, 0]],
    长浪: [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]],
    S形: [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]],
    风车: [[0, 0], [0, 1], [1, 1], [1, 2], [-1, 2]],
    长叉: [[0, 0], [0, 1], [0, 2], [1, 2], [-1, 3]]
  };
  for (const [name, cells] of Object.entries(expected)) assert.ok(has(cells), name);
  // 照片里没有的：手枪四格
  assert.ok(!has([[0, 0], [0, 1], [1, 1], [0, 2]]), '手枪');
  // 旋转 6 次、翻转 2 次都回到原样
  set.pieces.forEach((p, i) => {
    for (let f = 0; f < 2; f++) {
      assert.equal(set.orientFor(i, 6, f), set.orientFor(i, 0, f));
    }
  });
});

test('宝石阵：原版棋盘（6 方 505 格、4 方方形 295 格、3 方 241 格），起点在角上', () => {
  const t6 = Engine.topologyFor('gemblo', 6), t4 = Engine.topologyFor('gemblo', 4), t3 = Engine.topologyFor('gemblo', 3);
  assert.equal(t6.cells.length, 505);
  assert.equal(t4.cells.length, 295);
  assert.equal(t3.cells.length, 241);
  // 整块棋盘绕中心旋转 60° 不变
  const Q0 = 14, R0 = 18;
  const valid = (t, q, r) => Engine.inBounds(t, [q + Q0, r + R0]);
  t6.cells.forEach((i) => {
    const q = (i % t6.cols) - Q0, r = Math.floor(i / t6.cols) - R0;
    assert.ok(valid(t6, -r, q + r), 'rotational symmetry');
  });
  // 小区域都在整块棋盘里
  t4.cells.concat(t3.cells).forEach((i) => assert.ok(t6.valid[i]));
  // 每格 6 个贴边邻格、6 个尖对尖邻格（内部）
  const mid = 18 * t6.cols + 14;
  assert.equal(t6.edges[mid].length, 6);
  assert.equal(t6.corners[mid].length, 6);
  // 起点按顺序分配到角上
  const starts = (n) => config('gemblo', n).players.map((p) => p.starts[0].map((v, k) => v - (k ? R0 : Q0)));
  assert.deepEqual(starts(6), [[-7, -7], [7, -14], [14, -7], [7, 7], [-7, 14], [-14, 7]]);
  assert.deepEqual(starts(4), [[-9, -3], [9, -12], [9, 3], [-9, 12]]);
  assert.deepEqual(starts(3), [[-5, -5], [10, -5], [-5, 10]]);
  assert.equal(Engine.validCount('gemblo', 2), false);
  assert.equal(Engine.validCount('gemblo', 5), false);
  assert.ok([3, 4, 6].every((n) => Engine.validCount('gemblo', n)));
});

test('宝石阵：尖对尖相接，中间那条边被别人的同一块棋子挡住时不能接（规则书图 6、9、10）', () => {
  const state = Engine.createGame(config('gemblo', 3));
  const t = state.topo, Q0 = 14, R0 = 18;
  const at = (q, r) => (r + R0) * t.cols + q + Q0;
  const RED = 0, YELLOW = 1, GREEN = 2;
  // 红色直四竖放（A），顶格 (0,0)
  for (let r = 0; r < 4; r++) state.board[at(0, r)] = RED;
  state.players[RED].placed = 1;
  const mono = state.set.pieces.findIndex((p) => p.size === 1);
  const anchorsOf = () => {
    const forb = Engine.forbiddenMask(state.board, t, RED);
    return Engine.anchorMask(state.board, t, RED, state.players[RED], forb).mark;
  };
  // 图 6：位置 1–7 都可以
  const spots = { 1: [-2, 1], 2: [-1, -1], 3: [1, -2], 4: [2, -1], 5: [2, 0], 6: [2, 1], 7: [2, 2] };
  let mark = anchorsOf();
  Object.entries(spots).forEach(([n, [q, r]]) => assert.equal(mark[at(q, r)], 1, '位置 ' + n));
  assert.equal(Array.from(mark).filter(Boolean).length, 12);
  assert.equal(Engine.checkPlacement(state, RED, mono, 0, 2 + Q0, -1 + R0), null);
  // 和自己贴边不行
  assert.equal(Engine.checkPlacement(state, RED, mono, 0, 1 + Q0, 0 + R0), 'edge');
  // 图 9：黄色同一块棋子占住夹着那条边的两格 -> 位置 4 被挡住
  state.board[at(1, -1)] = YELLOW;
  state.board[at(1, 0)] = YELLOW;
  state.board[at(2, -2)] = YELLOW;
  mark = anchorsOf();
  assert.equal(mark[at(2, -1)], 0);
  assert.equal(Engine.checkPlacement(state, RED, mono, 0, 2 + Q0, -1 + R0), 'apex');
  // 图 10：那条边落在黄、绿两块棋子的交界上 -> 可以
  state.board[at(1, 0)] = GREEN;
  mark = anchorsOf();
  assert.equal(mark[at(2, -1)], 1);
  assert.equal(Engine.checkPlacement(state, RED, mono, 0, 2 + Q0, -1 + R0), null);
});

test('宝石阵：只数剩下的格子，没有奖励分', () => {
  const state = Engine.createGame(config('gemblo', 3));
  const pl = state.players[0];
  pl.remainingSquares = 0;
  pl.lastPiece = 0;
  assert.equal(Engine.scoreOf(pl), 0);
  pl.remainingSquares = 7;
  assert.equal(Engine.scoreOf(pl), -7);
  const classic = Engine.createGame(config('classic', 4)).players[0];
  classic.remainingSquares = 0;
  classic.lastPiece = 0;
  assert.equal(Engine.scoreOf(classic), 20);
});
