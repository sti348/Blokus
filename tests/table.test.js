'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../js/engine.js');
const Geom = require('../js/table/geom.js');

const MODES = [['classic', 4], ['duo', 2], ['trigon', 3], ['trigon', 4], ['gemblo', 3], ['gemblo', 6], ['cube', 2], ['prism', 3]];

function game(mode, n) {
  const seats = Engine.MODES[mode].seats.slice(0, n).map((s, i) => ({ seat: i, name: 'x', type: 'ai', level: 'easy' }));
  return Engine.createGame(Engine.buildConfig(mode, seats));
}

const key = (pts) => pts.map((p) => p.map((v) => { const r = Math.round(v * 100) / 100; return r === 0 ? 0 : r; }).join(',')).sort().join(';');

test('三维牌桌：每种棋盘的格子位置与引擎的落子格子一致', () => {
  for (const [mode, n] of MODES) {
    const st = game(mode, n);
    const board = Geom.boardOf(st);
    assert.ok(board.radius > 2, mode);
    // 随便几步合法落子：各格中心（相对平均点）与棋子形状一致
    const moves = Engine.legalMoves(st, 0).slice(0, 40);
    for (const m of moves) {
      const idx = Engine.placementIndices(st, m.piece, m.orient, m.x, m.y, m.z);
      const cs = idx.map((i) => board.cellCenter(i));
      const mean = [0, 1, 2].map((k) => cs.reduce((s, c) => s + c[k], 0) / cs.length);
      const shape = Geom.orientShape(st.set, m.piece, m.orient);
      assert.equal(key(cs.map((c) => c.map((v, k) => v - mean[k]))), key(shape.map((k) => k.c)), mode + ' piece ' + m.piece);
    }
  }
});

test('三维牌桌：转动、左右镜像、前翻、侧翻都得到规则允许的朝向', () => {
  for (const [mode, n] of MODES) {
    const st = game(mode, n);
    const angles = Geom.seatAngles(st);
    const set = st.set;
    for (let p = 0; p < angles.length; p++) {
      const az = angles[p];
      set.pieces.forEach((piece, pi) => {
        piece.orients.forEach((_, o) => {
          // 顺时针转一圈回到原处，逆时针是它的逆
          const steps = set.dims === 3 ? (set.kind === 'prism' ? 6 : 4) : set.rotations;
          let cur = o;
          for (let k = 0; k < steps; k++) {
            const r = Geom.turn(set, pi, cur, 'rotate', 1, az);
            assert.ok(r.orient >= 0, mode + ' rotate');
            assert.equal(Geom.turn(set, pi, r.orient, 'rotate', -1, az).orient, cur);
            cur = r.orient;
          }
          assert.equal(cur, o);
          if (set.dims !== 3) {
            // 镜像两次回到原处
            const m = Geom.turn(set, pi, o, 'mirror', 1, az);
            assert.ok(m.orient >= 0, mode + ' mirror seat ' + p);
            assert.equal(Geom.turn(set, pi, m.orient, 'mirror', 1, az).orient, o);
          } else {
            const tip = Geom.turn(set, pi, o, 'tip', 1, az);
            assert.ok(tip.orient >= 0, mode + ' tip seat ' + p);
            if (set.kind === 'cube') {
              const roll = Geom.turn(set, pi, o, 'roll', 1, az);
              assert.ok(roll.orient >= 0, mode + ' roll');
            }
            // 立体棋子不能镜像（除非形状本身对称）
          }
        });
      });
    }
  }
});

test('三维牌桌：镜像是左右翻（从座位看过去），不是上下翻', () => {
  const st = game('classic', 4);
  const set = st.set;
  // L 形五格：竖着放时，左右镜像后最上面那格还在上面
  const pi = set.pieces.findIndex((p) => p.size === 5 && p.orients.length === 8 && p.orients[0].w === 2 && p.orients[0].h === 4);
  const az = 0; // 坐在 +z 方向，看向 -z：屏幕上方是 -z
  const before = Geom.orientShape(set, pi, 0).map((k) => k.c);
  const r = Geom.turn(set, pi, 0, 'mirror', 1, az);
  const after = Geom.orientShape(set, pi, r.orient).map((k) => k.c);
  const zs = (pts) => pts.map((p) => Math.round(p[2] * 100)).sort((a, b) => a - b).join(',');
  const xs = (pts) => pts.map((p) => Math.round(p[0] * 100)).sort((a, b) => a - b).join(',');
  assert.equal(zs(after), zs(before), '前后不变');
  assert.equal(xs(after), xs(before.map((p) => [-p[0], p[1], p[2]])), '左右对调');
});

test('三维牌桌：座位方向各不相同，面前的棋子在棋盘外、互不重叠', () => {
  for (const [mode, n] of MODES) {
    const st = game(mode, n);
    const board = Geom.boardOf(st);
    const angles = Geom.seatAngles(st, board);
    assert.equal(new Set(angles.map((a) => a.toFixed(3))).size, n, mode + ' distinct seats');
    for (const narrow of [false, true]) {
      const boxes = [];
      angles.forEach((az, p) => {
        const lay = Geom.trayLayout(st, board, angles, p, narrow);
        assert.ok(lay.reach < board.radius * 3.4 + 16, mode + ' reach ' + lay.reach);
        lay.slots.forEach((slot, i) => {
          const shape = Geom.orientShape(st.set, i, st.set.pieces[i].display);
          const c = Math.cos(slot.rot), s = Math.sin(slot.rot);
          shape.forEach((k) => {
            const m = Geom.centroid(k.poly);
            const x = slot.x + m[0] * c + m[1] * s, z = slot.z - m[0] * s + m[1] * c;
            // 在棋盘外
            assert.ok(Math.hypot(x, z) > Math.min(board.width, board.depth) / 2 - 0.2, mode + ' outside board');
            boxes.push({ x, z, id: p + ':' + i });
          });
        });
      });
      // 不同棋子的格子中心至少相隔约半格
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          if (boxes[a].id === boxes[b].id) continue;
          assert.ok(Math.hypot(boxes[a].x - boxes[b].x, boxes[a].z - boxes[b].z) > 0.55, mode + ' overlap ' + boxes[a].id + ' / ' + boxes[b].id);
        }
      }
    }
  }
});

test('三维牌桌：悔棋退回到真人上一次行动之前', () => {
  const human = (p) => p === 0;
  assert.equal(Geom.undoTarget([], human), -1);
  assert.equal(Geom.undoTarget([{ player: 0 }, { player: 1 }, { player: 2 }], human), 0);
  assert.equal(Geom.undoTarget([{ player: 1 }], human), -1);
});
