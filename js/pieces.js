/*
 * 角斗士棋（Blokus）棋子定义。
 * 每位玩家 21 块棋子：1 格 ×1、2 格 ×1、3 格 ×2、4 格 ×5、5 格 ×12，共 89 格。
 * 坐标为 [x, y]，x 向右，y 向下。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.BlokusPieces = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RAW = [
    { id: 'I1', name: '单格', cells: [[0, 0]] },
    { id: 'I2', name: '二连', cells: [[0, 0], [1, 0]] },
    { id: 'I3', name: '三连', cells: [[0, 0], [1, 0], [2, 0]] },
    { id: 'V3', name: '小角', cells: [[0, 0], [0, 1], [1, 1]] },
    { id: 'I4', name: '四连', cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
    { id: 'L4', name: 'L 四', cells: [[0, 0], [0, 1], [0, 2], [1, 2]] },
    { id: 'T4', name: 'T 四', cells: [[0, 0], [1, 0], [2, 0], [1, 1]] },
    { id: 'S4', name: 'S 四', cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
    { id: 'O4', name: '方块', cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
    { id: 'F5', name: 'F 形', cells: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]] },
    { id: 'I5', name: '五连', cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]] },
    { id: 'L5', name: 'L 五', cells: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]] },
    { id: 'N5', name: 'N 形', cells: [[0, 0], [0, 1], [1, 1], [1, 2], [1, 3]] },
    { id: 'P5', name: 'P 形', cells: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]] },
    { id: 'T5', name: 'T 五', cells: [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]] },
    { id: 'U5', name: 'U 形', cells: [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]] },
    { id: 'V5', name: '大角', cells: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]] },
    { id: 'W5', name: 'W 形', cells: [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]] },
    { id: 'X5', name: '十字', cells: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]] },
    { id: 'Y5', name: 'Y 形', cells: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 1]] },
    { id: 'Z5', name: 'Z 形', cells: [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]] }
  ];

  // 先翻转（x 取反），再顺时针旋转 rot 次：(x, y) -> (-y, x)
  function transform(cells, rot, flip) {
    return cells.map(function (c) {
      var x = flip ? -c[0] : c[0];
      var y = c[1];
      for (var r = 0; r < rot; r++) {
        var t = x;
        x = -y;
        y = t;
      }
      return [x, y];
    });
  }

  function normalize(cells) {
    var minX = Infinity, minY = Infinity;
    cells.forEach(function (c) {
      if (c[0] < minX) minX = c[0];
      if (c[1] < minY) minY = c[1];
    });
    return cells
      .map(function (c) { return [c[0] - minX, c[1] - minY]; })
      .sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
  }

  function keyOf(cells) {
    return cells.map(function (c) { return c[0] + ',' + c[1]; }).join(';');
  }

  // 让光标落在棋子“视觉中心”附近的格子上
  function pivotOf(cells, w, h) {
    var cx = (w - 1) / 2, cy = (h - 1) / 2;
    var best = 0, bestD = Infinity;
    cells.forEach(function (c, i) {
      var d = (c[0] - cx) * (c[0] - cx) + (c[1] - cy) * (c[1] - cy);
      if (d < bestD - 1e-9) { bestD = d; best = i; }
    });
    return cells[best];
  }

  var PIECES = RAW.map(function (raw, index) {
    var orients = [];
    var byKey = {};
    var transformToOrient = new Array(8);
    for (var flip = 0; flip < 2; flip++) {
      for (var rot = 0; rot < 4; rot++) {
        var cells = normalize(transform(raw.cells, rot, flip));
        var key = keyOf(cells);
        if (!(key in byKey)) {
          var w = 0, h = 0;
          cells.forEach(function (c) {
            if (c[0] + 1 > w) w = c[0] + 1;
            if (c[1] + 1 > h) h = c[1] + 1;
          });
          byKey[key] = orients.length;
          var flat = [];
          cells.forEach(function (c) { flat.push(c[0], c[1]); });
          orients.push({
            cells: cells,
            flat: flat,
            w: w,
            h: h,
            pivot: pivotOf(cells, w, h),
            rot: rot,
            flip: flip
          });
        }
        transformToOrient[flip * 4 + rot] = byKey[key];
      }
    }
    return {
      index: index,
      id: raw.id,
      name: raw.name,
      size: raw.cells.length,
      orients: orients,
      transformToOrient: transformToOrient
    };
  });

  var TOTAL_SQUARES = PIECES.reduce(function (s, p) { return s + p.size; }, 0);

  function orientFor(pieceIndex, rot, flip) {
    return PIECES[pieceIndex].transformToOrient[(flip ? 4 : 0) + (((rot % 4) + 4) % 4)];
  }

  return {
    PIECES: PIECES,
    PIECE_COUNT: PIECES.length,
    TOTAL_SQUARES: TOTAL_SQUARES,
    MONOMINO: 0,
    orientFor: orientFor
  };
});
