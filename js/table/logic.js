/*
 * 三维牌桌的纯逻辑（不依赖 DOM / Three.js，Node 里可测试）：
 *   - 棋子在桌面上的实体姿态（绕竖轴转 k 个 90°、是否翻面）与规则引擎朝向编号之间的换算
 *   - 每个座位面前棋子的摆放位置
 *   - 悔棋要退回到哪一步
 *
 * 坐标：棋盘格 (x, y) 对应牌桌局部坐标 (x, z)。棋子模型以基础朝向的包围盒中心为原点。
 * 姿态 = 先翻面（绕 X 轴转 180°：z → -z），再绕 Y 轴转 k×90°（(x, z) → (z, -x)），与 Three.js 的旋转方向一致。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BlokusTableLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function keyOf(cells) {
    return cells.map(function (c) { return c[0] + ',' + c[1]; }).sort().join(';');
  }

  // 基础朝向里各格相对包围盒中心的位置
  function baseOffsets(piece) {
    var o = piece.orients[0];
    var cx = (o.w - 1) / 2, cz = (o.h - 1) / 2;
    return o.cells.map(function (c) { return [c[0] - cx, c[1] - cz]; });
  }

  function transform(p, k, flip) {
    var x = p[0], z = flip ? -p[1] : p[1];
    for (var i = 0; i < (((k % 4) + 4) % 4); i++) { var nx = z; z = -x; x = nx; }
    return [x, z];
  }

  /**
   * 棋子在姿态 (k, flip) 下的信息：
   *   offsets  各格中心相对模型原点的位置
   *   minX/minZ 最靠左上的格相对原点的位置（模型原点 = 落点格 - min）
   *   orient   对应的引擎朝向编号
   */
  function pose(piece, k, flip) {
    var cache = piece._tablePoses || (piece._tablePoses = {});
    var id = ((((k % 4) + 4) % 4)) + (flip ? 4 : 0);
    if (cache[id]) return cache[id];
    var offs = baseOffsets(piece).map(function (p) { return transform(p, k, flip); });
    var minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    offs.forEach(function (p) {
      minX = Math.min(minX, p[0]); minZ = Math.min(minZ, p[1]);
      maxX = Math.max(maxX, p[0]); maxZ = Math.max(maxZ, p[1]);
    });
    var key = keyOf(offs.map(function (p) { return [Math.round(p[0] - minX), Math.round(p[1] - minZ)]; }));
    var orient = -1;
    for (var i = 0; i < piece.orients.length; i++) {
      if (keyOf(piece.orients[i].cells) === key) { orient = i; break; }
    }
    return (cache[id] = { offsets: offs, minX: minX, minZ: minZ, maxX: maxX, maxZ: maxZ, orient: orient });
  }

  // 引擎朝向 → 姿态；有多种姿态等价时选离当前姿态最近的（少转、不翻）
  function poseForOrient(piece, orient, curK, curFlip) {
    var best = null, bestCost = Infinity;
    for (var f = 0; f < 2; f++) {
      for (var k = 0; k < 4; k++) {
        if (pose(piece, k, !!f).orient !== orient) continue;
        var dk = Math.abs(((k - (curK || 0)) % 4 + 4) % 4);
        if (dk === 3) dk = 1;
        var cost = dk + (!!f !== !!curFlip ? 2.5 : 0);
        if (cost < bestCost) { bestCost = cost; best = { k: k, flip: !!f }; }
      }
    }
    return best;
  }

  // 座位朝外的方向（引擎坐标）。座位 0 坐在镜头默认的一侧，其余顺时针排开
  var OUTS = [[-1, 0], [0, -1], [1, 0], [0, 1]];
  function seatOut(index, count) {
    return count === 2 ? OUTS[index * 2] : OUTS[index % 4];
  }
  function seatRight(out) { return [out[1], -out[0]]; }

  /**
   * 一个座位面前的棋子摆放：从棋盘边往外排成几行，越往外越宽（不占到相邻座位的区域）。
   * 返回每块棋子的 { x, z, k }（模型原点的棋盘坐标和摆放姿态）和用到的最远距离 reach。
   */
  function trayLayout(pieces, size, out) {
    var right = seatRight(out);
    var c = (size - 1) / 2;
    var GAP = 0.9;
    var items = pieces.map(function (piece, index) {
      var best = null;
      for (var k = 0; k < 4; k++) {
        var offs = pose(piece, k, false).offsets;
        var us = offs.map(function (p) { return p[0] * right[0] + p[1] * right[1]; });
        var vs = offs.map(function (p) { return p[0] * out[0] + p[1] * out[1]; });
        var wU = Math.max.apply(null, us) - Math.min.apply(null, us) + 1;
        var wV = Math.max.apply(null, vs) - Math.min.apply(null, vs) + 1;
        if (!best || wV < best.wV) best = { index: index, k: k, wU: wU, wV: wV, size: piece.size };
      }
      return best;
    });
    items.sort(function (a, b) { return b.size - a.size || b.wU - a.wU || a.index - b.index; });
    var res = new Array(pieces.length);
    var v = size / 2 + 2.4;
    var reach = 0;
    var i = 0;
    while (i < items.length) {
      var maxW = Math.min(2 * v - 2.5, size + 18);
      var row = [], w = 0, h = 0;
      while (i < items.length && (row.length === 0 || w + GAP + items[i].wU <= maxW)) {
        w += (row.length ? GAP : 0) + items[i].wU;
        h = Math.max(h, items[i].wV);
        row.push(items[i++]);
      }
      var u = -w / 2;
      row.forEach(function (it) {
        var uc = u + it.wU / 2, vc = v + it.wV / 2;
        res[it.index] = { x: c + right[0] * uc + out[0] * vc, z: c + right[1] * uc + out[1] * vc, k: it.k };
        reach = Math.max(reach, Math.sqrt(Math.pow(Math.abs(uc) + it.wU / 2, 2) + Math.pow(vc + it.wV / 2, 2)));
        u += it.wU + GAP;
      });
      v += h + GAP;
    }
    return { slots: res, reach: reach };
  }

  /**
   * 悔棋：退回到最近一次「由真人落子（或停手）」之前，返回保留的动作数；没有可悔的返回 -1。
   * isHuman(playerIndex) 判断是不是真人。
   */
  function undoTarget(actions, isHuman) {
    for (var i = actions.length - 1; i >= 0; i--) {
      if (isHuman(actions[i].player)) return i;
    }
    return -1;
  }

  return {
    pose: pose,
    poseForOrient: poseForOrient,
    seatOut: seatOut,
    seatRight: seatRight,
    trayLayout: trayLayout,
    undoTarget: undoTarget
  };
});
