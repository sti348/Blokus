'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../js/engine.js');
const Logic = require('../js/table/logic.js');

const PIECES = Engine.SETS.square.pieces;

test('三维牌桌：每种姿态都对应一个引擎朝向，每个朝向都能摆出来', () => {
  for (const piece of PIECES) {
    const seen = new Set();
    for (let f = 0; f < 2; f++) {
      for (let k = 0; k < 4; k++) {
        const p = Logic.pose(piece, k, !!f);
        assert.ok(p.orient >= 0, piece.name + ' k=' + k + ' f=' + f);
        seen.add(p.orient);
        // 模型原点 = 落点格 - min：各格落在整数格上，且与引擎朝向的格子一致
        const cells = p.offsets.map((o) => [o[0] - p.minX, o[1] - p.minZ]);
        cells.forEach((c) => { assert.ok(Number.isInteger(c[0]) && Number.isInteger(c[1])); });
        const key = (cs) => cs.map((c) => c[0] + ',' + c[1]).sort().join(';');
        assert.equal(key(cells), key(piece.orients[p.orient].cells));
      }
    }
    assert.equal(seen.size, piece.orients.length, piece.name);
    piece.orients.forEach((_, o) => {
      const kf = Logic.poseForOrient(piece, o, 0, false);
      assert.equal(Logic.pose(piece, kf.k, kf.flip).orient, o);
    });
  }
});

test('三维牌桌：换朝向时优先少转、不翻面', () => {
  const sq = PIECES.find((p) => p.orients.length === 1);
  assert.deepEqual(Logic.poseForOrient(sq, 0, 3, true), { k: 3, flip: true });
  const five = PIECES.find((p) => p.orients.length === 8);
  for (let k = 0; k < 4; k++) {
    const o = Logic.pose(five, k, false).orient;
    assert.deepEqual(Logic.poseForOrient(five, o, k, false), { k, flip: false });
  }
});

test('三维牌桌：各座位的棋子摆在棋盘外、互不重叠，也不占到别的座位', () => {
  for (const [size, count, narrow] of [[20, 4, false], [14, 2, false], [20, 4, true], [14, 2, true]]) {
    const occupied = new Map();
    let reach = 0;
    for (let s = 0; s < count; s++) {
      const out = Logic.seatOut(s, count);
      const lay = Logic.trayLayout(PIECES, size, out, narrow);
      if (narrow) {
        // 竖屏：每块都不超出棋盘的宽度
        const right = Logic.seatRight(out);
        lay.slots.forEach((slot, i) => Logic.pose(PIECES[i], slot.k, false).offsets.forEach((o) => {
          const u = (slot.x + o[0] - (size - 1) / 2) * right[0] + (slot.z + o[1] - (size - 1) / 2) * right[1];
          assert.ok(Math.abs(u) <= size / 2 + 0.6, 'narrow row too wide: ' + u);
        }));
      }
      reach = Math.max(reach, lay.reach);
      lay.slots.forEach((slot, i) => {
        Logic.pose(PIECES[i], slot.k, false).offsets.forEach((o) => {
          const x = slot.x + o[0], z = slot.z + o[1];
          // 在棋盘和边框之外
          assert.ok(x < -1.4 || z < -1.4 || x > size + 0.4 || z > size + 0.4, 'outside board');
          // 半格精度的占位检查
          const key = s + ':' + Math.round(x * 2) + ',' + Math.round(z * 2);
          for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
              const k2 = (Math.round(x * 2) + dx) + ',' + (Math.round(z * 2) + dz);
              const who = occupied.get(k2);
              assert.ok(who === undefined || who === s + ':' + i, 'overlap at ' + key);
            }
          }
          occupied.set(Math.round(x * 2) + ',' + Math.round(z * 2), s + ':' + i);
        });
      });
    }
    assert.ok(reach < 31, 'fits on the table: ' + reach);
  }
});

test('三维牌桌：悔棋退回到真人上一次行动之前', () => {
  const human = (p) => p === 0;
  assert.equal(Logic.undoTarget([], human), -1);
  assert.equal(Logic.undoTarget([{ player: 0 }, { player: 1 }, { player: 2 }], human), 0);
  assert.equal(Logic.undoTarget([{ player: 0 }, { player: 1 }, { player: 0 }, { player: 1 }], human), 2);
  assert.equal(Logic.undoTarget([{ player: 1 }], human), -1);
});
